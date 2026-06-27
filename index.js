const { GoogleGenerativeAI } = require("@google/generative-ai");
const startTime = Date.now();
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// GLOBAL ERROR HANDLERS to prevent process crash
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
});

// Helper to extract YouTube URL from text
function extractYoutubeUrl(text) {
    if (!text) return null;
    const match = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?youtu(?:be\.com|\.be)\/[^\s]+/);
    return match ? match[0] : null;
}

// Helper to fetch title using yt-dlp
async function fetchVideoTitle(url) {
    try {
        const { stdout } = await execPromise(`yt-dlp --js-runtimes node --get-title "${url}"`, { timeout: 15000 });
        return stdout.trim().replace(/[/\\?%*:|"<>]/g, '-'); // Sanitize filename characters
    } catch (err) {
        console.log("Error fetching title with yt-dlp:", err);
        return "downloaded_media";
    }
}

// Helper to fetch details (title, uploader, duration) using yt-dlp
async function fetchVideoDetails(url) {
    try {
        const { stdout } = await execPromise(`yt-dlp --js-runtimes node --print "%(title)s|%(uploader)s|%(duration_string)s" "${url}"`, { timeout: 15000 });
        const parts = stdout.trim().split('|');
        return {
            title: (parts[0] || 'Unknown Title').replace(/[/\\?%*:|"<>]/g, '-'),
            uploader: parts[1] || 'Unknown',
            duration: parts[2] || 'Unknown'
        };
    } catch (err) {
        console.log("Error fetching details with yt-dlp:", err);
        // Fallback to title only if possible
        try {
            const { stdout } = await execPromise(`yt-dlp --js-runtimes node --get-title "${url}"`, { timeout: 15000 });
            return {
                title: stdout.trim().replace(/[/\\?%*:|"<>]/g, '-'),
                uploader: 'Unknown',
                duration: 'Unknown'
            };
        } catch (e) {
            return {
                title: 'downloaded_media',
                uploader: 'Unknown',
                duration: 'Unknown'
            };
        }
    }
}

// Helper to extract Facebook, TikTok, and Instagram URLs from text
function extractSocialUrl(text) {
    if (!text) return null;
    
    const fbMatch = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?facebook\.com\/(?:[^\s\/]+\/videos\/|video\.php\?v=|share\/[rvp]\/|reel\/|reels\/|watch\/?[^\s\/]*)[^\s]+|https?:\/\/(?:[a-zA-Z0-9-]+\.)?fb\.watch\/[^\s]+/i);
    if (fbMatch) return { type: 'facebook', url: fbMatch[0] };
    
    const tiktokMatch = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?tiktok\.com\/@[^\s\/]+\/video\/\d+|https?:\/\/(?:[a-zA-Z0-9-]+\.)?tiktok\.com\/t\/[^\s\/]+|https?:\/\/(?:[a-zA-Z0-9-]+\.)?vm\.tiktok\.com\/[^\s\/]+|https?:\/\/(?:[a-zA-Z0-9-]+\.)?vt\.tiktok\.com\/[^\s\/]+/i);
    if (tiktokMatch) return { type: 'tiktok', url: tiktokMatch[0] };
    
    const igMatch = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?instagram\.com\/(?:p|reel|reels|tv|share\/reel)\/[^\s\/]+/i);
    if (igMatch) return { type: 'instagram', url: igMatch[0] };
    
    return null;
}

// Helper to resolve redirect URLs (e.g. short links like vm.tiktok.com, fb.watch, etc.)
async function resolveRedirectUrl(url) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            redirect: 'follow',
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response.url || url;
    } catch (err) {
        console.log("Error resolving redirect URL:", err.message);
        return url;
    }
}

// Helper to get Referer based on the URL type
function getReferer(url) {
    if (url.includes('tiktok.com')) return 'https://www.tiktok.com/';
    if (url.includes('instagram.com')) return 'https://www.instagram.com/';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'https://www.facebook.com/';
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'https://www.youtube.com/';
    return '';
}

// Helper to download TikTok video using Tikwm API
async function downloadTikTokVideo(url, tempFilePath) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);
        const response = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        const result = await response.json();
        if (result.code === 0 && result.data && result.data.play) {
            const videoUrl = result.data.play;
            
            const videoController = new AbortController();
            const videoTimeoutId = setTimeout(() => videoController.abort(), 60000);
            const videoResponse = await fetch(videoUrl, { signal: videoController.signal });
            const arrayBuffer = await videoResponse.arrayBuffer();
            clearTimeout(videoTimeoutId);
            
            fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));
            return true;
        }
        throw new Error(result.msg || "API returned failure status");
    } catch (err) {
        console.log("Tikwm API Download failed, falling back to yt-dlp:", err.message);
        return false;
    }
}

// Helper to search Instagram profiles on Yahoo Search
async function searchInstagramProfiles(query) {
    try {
        const url = `https://search.yahoo.com/search?p=site:instagram.com+${encodeURIComponent(query)}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await response.text();

        function cleanText(text) {
            if (!text) return '';
            return text.replace(/<[^>]*>/g, '').replace(/&bull;/gi, '•').replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
        }

        const blocks = data.split(/<div class="dd\s[^"]*algo-sr/gi);
        const results = [];
        const ignored = ['p', 'reel', 'tv', 'stories', 'explore', 'developer', 'about', 'directory', 'legal_policy'];
        const seenUsernames = new Set();

        for (let i = 1; i < blocks.length; i++) {
            const block = blocks[i];
            
            // Find Instagram URL inside RU parameter of Yahoo redirection link
            const ruMatch = block.match(/RU=(https?%3a%2f%2f(www\.)?instagram\.com%2f[^/&"]+)/i);
            if (!ruMatch) continue;
            
            let rawUrl = decodeURIComponent(ruMatch[1]);
            let cleanUrl = rawUrl.split('?')[0];
            if (cleanUrl.endsWith('/')) {
                cleanUrl = cleanUrl.slice(0, -1);
            }
            
            // Extract username
            const usernameMatch = cleanUrl.match(/instagram\.com\/([a-zA-Z0-9_\.]+)/);
            if (!usernameMatch) continue;
            
            const username = usernameMatch[1];
            if (ignored.includes(username.toLowerCase())) continue;
            if (seenUsernames.has(username.toLowerCase())) continue;
            seenUsernames.add(username.toLowerCase());
            
            // Extract Title
            const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
            let title = cleanText(titleMatch ? titleMatch[1] : 'Instagram Profile');
            // Clean Yahoo-specific title suffixes
            title = title.replace(/\s*[•-]\s*Instagram\s*photos\s*and\s*videos/gi, '')
                         .replace(/\s*[•-]\s*Instagram\s*photos\s*and\s*\.\.\./gi, '')
                         .replace(/\s*[•-]\s*Instagram\s*photos\s*\.\.\./gi, '')
                         .replace(/\s*[•-]\s*Instagram\s*profile/gi, '')
                         .replace(/\s*-\s*Instagram/gi, '')
                         .trim();
                         
            // Extract Snippet
            const snippetMatch = block.match(/<div class="compText[^>]*>([\s\S]*?)<\/div>/i);
            let snippet = cleanText(snippetMatch ? snippetMatch[1] : 'No description available.');
            
            results.push({
                username,
                title,
                url: cleanUrl,
                snippet
            });
        }
        
        return results.slice(0, 5);
    } catch (err) {
        console.log("Instagram Search Error:", err.message);
        return [];
    }
}

// Split keys by comma to support multi-key rotation
const apiKeys = (process.env.GEMINI_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
let currentKeyIndex = 0;

function getModelInstance(userName) {
    const key = apiKeys[currentKeyIndex] || "YOUR_GEMINI_API_KEY_HERE";
    const genAI = new GoogleGenerativeAI(key);
    return genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: `You are MV BOT, a friendly, smart, and helpful WhatsApp AI bot. 
The user you are chatting with is named "${userName}". You should address them by this name (or any name they ask you to call them) during the conversation.
Only mention the creator's name (Vishmitha) if someone explicitly asks who created you or who is your owner. Otherwise, do not mention the developer or owner name like Vishmitha anywhere in your responses under any circumstances.
Your goal is to reply natural and conversational responses.
Since your audience is from Sri Lanka, reply in Sinhala or a friendly mix of Sinhala and English (Singlish) where appropriate. 
Keep your responses neat, well-structured, relatively short (suitable for quick WhatsApp reading), and use emojis nicely.`
    });
}

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser;

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const ytSearch = require('youtube-search-api');

// AI Conversation History store (tracks messages in memory per user)
const chatHistories = {};

// Store pending video downloads for quality selection (maps from JID -> { url, title, timestamp })
const pendingVideoDownloads = {};

// Setting to toggle Auto AI replies in private messages (on by default)
let autoAIActive = true;

// We filter out historical/offline messages using Baileys event type 'notify'

/**
 * Gets the chat history for a specific sender JID.
 * Formats it properly for Gemini chat API.
 */
function getChatHistory(from) {
    if (!chatHistories[from]) {
        chatHistories[from] = [];
    }
    return chatHistories[from];
}

/**
 * Saves a message structure into the user's conversation history.
 */
function addToHistory(from, role, text) {
    const history = getChatHistory(from);
    history.push({ role, parts: [{ text }] });
    // Keep last 16 messages to prevent token bloat and control API limits
    if (history.length > 16) {
        history.shift();
    }
}

// Lightweight message cache to support E2E retry decryption
const msgCache = new Map();
function cacheMessage(msg) {
    if (msg?.key?.id && msg.message) {
        msgCache.set(msg.key.id, msg.message);
        // Limit cache size to 500 messages to prevent memory leaks in Termux background
        if (msgCache.size > 500) {
            const firstKey = msgCache.keys().next().value;
            msgCache.delete(firstKey);
        }
    }
}

// Persistent list of JIDs that received the first-contact auto menu
const autoMenuFilePath = path.join(__dirname, 'auto_menu_sent.json');
let autoMenuSentList = new Set();
if (fs.existsSync(autoMenuFilePath)) {
    try {
        const data = JSON.parse(fs.readFileSync(autoMenuFilePath, 'utf-8'));
        autoMenuSentList = new Set(data);
    } catch (e) {
        console.log('Error reading auto_menu_sent.json:', e.message);
    }
}
function saveAutoMenuSentList() {
    try {
        fs.writeFileSync(autoMenuFilePath, JSON.stringify(Array.from(autoMenuSentList), null, 2));
    } catch (e) {
        console.log('Error writing auto_menu_sent.json:', e.message);
    }
}

// Persistent list of daily greetings JID mappings
const dailyGreetingsFilePath = path.join(__dirname, 'daily_greetings.json');
let dailyGreetings = {};
if (fs.existsSync(dailyGreetingsFilePath)) {
    try {
        dailyGreetings = JSON.parse(fs.readFileSync(dailyGreetingsFilePath, 'utf-8'));
    } catch (e) {
        console.log('Error reading daily_greetings.json:', e.message);
    }
}
function saveDailyGreetings() {
    try {
        fs.writeFileSync(dailyGreetingsFilePath, JSON.stringify(dailyGreetings, null, 2));
    } catch (e) {
        console.log('Error writing daily_greetings.json:', e.message);
    }
}

// Persistent map of JIDs to pushNames
const contactsFilePath = path.join(__dirname, 'contacts.json');
let contacts = {};
if (fs.existsSync(contactsFilePath)) {
    try {
        contacts = JSON.parse(fs.readFileSync(contactsFilePath, 'utf-8'));
    } catch (e) {
        console.log('Error reading contacts.json:', e.message);
    }
}
function saveContacts() {
    try {
        fs.writeFileSync(contactsFilePath, JSON.stringify(contacts, null, 2));
    } catch (e) {
        console.log('Error writing contacts.json:', e.message);
    }
}

function getColomboTime() {
    const d = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Colombo',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    });
    const parts = formatter.formatToParts(d);
    let hour = 0, minute = 0;
    for (const part of parts) {
        if (part.type === 'hour') hour = parseInt(part.value, 10);
        if (part.type === 'minute') minute = parseInt(part.value, 10);
    }
    if (hour === 24) hour = 0;
    const dateStr = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Colombo' }); // dd/mm/yyyy
    return { hour, minute, dateStr };
}

function isAutoMathExpression(str) {
    const trimmed = str.trim();
    
    // Must only contain allowed mathematical characters
    if (!/^[0-9+\-*/().\s%**^]+$/.test(trimmed)) {
        return false;
    }

    // Must contain at least one operator
    if (!/[+\-*/%^]/.test(trimmed)) {
        return false;
    }

    // Exclude dates (e.g., 2026/06/27, 27-06-2026)
    if (/^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$/.test(trimmed)) {
        return false;
    }

    // Exclude phone numbers starting with +
    if (/^\+\d+[\d\s\-]*$/.test(trimmed)) {
        return false;
    }

    // Exclude standard Sri Lankan and international phone numbers (9 to 12 digits)
    const cleanStr = trimmed.replace(/[\s\-]/g, '');
    if (/^\d{9,12}$/.test(cleanStr)) {
        return false;
    }

    return true;
}

let greetingsInterval = null;
let sock = null;
let isReconnecting = false;
let reconnectAttempts = 0;
let fetchedVersion = null;

async function startBot() {
    // Dynamically import ES Module @whiskeysockets/baileys
    if (!makeWASocket) {
        const baileys = await import('@whiskeysockets/baileys');
        makeWASocket = baileys.default || baileys.default?.default || baileys;
        useMultiFileAuthState = baileys.useMultiFileAuthState;
        DisconnectReason = baileys.DisconnectReason;
        fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
        jidNormalizedUser = baileys.jidNormalizedUser;
    }
    // Prevent duplicate active socket instances
    if (sock) {
        console.log('🧹 Cleaning up previous socket instance...');
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.ev.removeAllListeners('messages.upsert');
            sock.ev.removeAllListeners('group-participants.update');
            if (sock.ws) sock.ws.close();
        } catch (e) {
            console.log('Error cleaning up previous socket:', e);
        }
        sock = null;
    }

    // Restore session from Environment Variable if hosting on Render/Railway
    if (process.env.SESSION_DATA) {
        try {
            const tempDir = './baileys_auth';
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            const credsContent = Buffer.from(process.env.SESSION_DATA, 'base64').toString('utf-8');
            fs.writeFileSync(path.join(tempDir, 'creds.json'), credsContent);
            console.log('✅ Session restored successfully from Environment Variable (SESSION_DATA)!');
        } catch (err) {
            console.log('⚠️ Error restoring session from Environment Variable:', err.message);
        }
    }

    let state, saveCreds;
    const authPath = path.join(__dirname, 'baileys_auth');
    try {
        const credsPath = path.join(authPath, 'creds.json');
        if (fs.existsSync(credsPath)) {
            try {
                JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
            } catch (jsonErr) {
                console.log('⚠️ creds.json is corrupted (Invalid JSON). Deleting to start fresh...');
                fs.rmSync(credsPath, { force: true });
            }
        }
        const authResult = await useMultiFileAuthState(authPath);
        state = authResult.state;
        saveCreds = authResult.saveCreds;
    } catch (err) {
        console.log('⚠️ Error loading auth session (files might be locked or busy):', err.message);
        console.log('🔄 Retrying session load in 10 seconds...');
        setTimeout(startBot, 10000);
        return;
    }

    // Automatically fetch the latest WhatsApp Web version to prevent 405 Connection Failure
    let version = [2, 3000, 1035194821]; // Default fallback version (updated to latest stable)
    if (fetchedVersion) {
        version = fetchedVersion;
    } else {
        try {
            const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
            console.log(`🤖 Using WA version v${latestVersion.join('.')}, isLatest: ${isLatest}`);
            version = latestVersion;
            fetchedVersion = latestVersion;
        } catch (err) {
            console.log("⚠️ Error fetching latest WhatsApp version, using fallback:", err.message);
        }
    }

    sock = makeWASocket({
        auth: state,
        version: version,
        logger: pino({ level: 'silent' }),
        browser: ['MV Bot', 'Chrome', '1.0.0'], // Mimic a stable browser to prevent security disconnects
        syncFullHistory: false,                 // Do not sync old chats to save memory and CPU on Termux
        keepAliveIntervalMs: 30000,             // Send a ping every 30 seconds to keep the socket alive stably without rate limit
        defaultQueryTimeoutMs: 90000,           // Query timeout
        connectTimeoutMs: 90000,                // Connection timeout
        retryRequestDelayMs: 5000,              // Delay before retrying failed requests
        getMessage: async (key) => {
            if (msgCache.has(key.id)) {
                return msgCache.get(key.id);
            }
            return undefined;
        }
    });

    // Wrap sendMessage to automatically cache all outgoing messages for E2E retry decryption
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
        const result = await originalSendMessage(jid, content, options);
        if (result) {
            cacheMessage(result);
        }
        return result;
    };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            qrcode.generate(qr, { small: true });
            console.log('📷 Scan the QR code above to link your bot.');
            
            // Write QR code to a simple HTML file for easy scanning (portable path)
            try {
                const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <title>Scan WhatsApp QR - MV BOT</title>
    <meta charset="utf-8">
    <style>
        body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background-color: #0b141a;
            color: #e9edef;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        .container {
            text-align: center;
            background-color: #111b21;
            padding: 30px;
            border-radius: 24px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            border: 1px solid #222e35;
        }
        #qrcode {
            background-color: white;
            padding: 20px;
            border-radius: 16px;
            display: inline-block;
            margin: 20px 0;
        }
        h2 {
            margin: 0 0 10px 0;
            color: #00a884;
        }
        p {
            margin: 0;
            color: #8696a0;
            font-size: 14px;
        }
        .instruction {
            margin-top: 15px;
            font-size: 15px;
            color: #d1d7db;
        }
    </style>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
</head>
<body>
    <div class="container">
        <h2>MV BOT - QR Code</h2>
        <p>Scan this QR code using WhatsApp on your phone</p>
        <div id="qrcode"></div>
        <div class="instruction">
            Go to <b>WhatsApp > Linked Devices > Link a Device</b> to scan.
        </div>
    </div>
    <script>
        new QRCode(document.getElementById("qrcode"), {
            text: ${JSON.stringify(qr)},
            width: 256,
            height: 256,
            colorDark : "#000000",
            colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.H
        });
    </script>
</body>
</html>`;
                const qrPath = path.join(__dirname, 'qr.html');
                fs.writeFileSync(qrPath, htmlContent);
                console.log(`👉 [QR CODE HTML GENERATED] Open qr.html to scan!`);
            } catch (err) {
                console.log("Error writing qr.html:", err);
            }
        }

        if (connection === 'open') {
            console.log('✅ Bot Connected Successfully!');
            reconnectAttempts = 0; // Reset attempts on successful connection
            
            // Clear duplicate interval if any
            if (greetingsInterval) {
                clearInterval(greetingsInterval);
                greetingsInterval = null;
            }

            // Start greetings scheduler
            const checkGreetings = async () => {
                try {
                    const { hour, minute, dateStr } = getColomboTime();
                    const totalMinutes = hour * 60 + minute;
                    
                    // Determine if the current time falls within one of our active slots
                    let slot = null;
                    if (totalMinutes >= 0 && totalMinutes < 720) {
                        slot = 'morning'; // 12:00 AM - 11:59 AM
                    } else if (totalMinutes >= 720 && totalMinutes < 960) {
                        slot = 'afternoon'; // 12:00 PM - 3:59 PM
                    } else if (totalMinutes >= 960 && totalMinutes < 1140) {
                        slot = 'evening'; // 4:00 PM - 7:00 PM
                    } else if (totalMinutes >= 1290 && totalMinutes <= 1439) {
                        slot = 'night'; // 9:30 PM - 11:59 PM
                    }

                    if (!slot) return;

                    console.log(`⏰ Checking Scheduled Greetings. Slot: ${slot} | Time: ${hour}:${minute} | Date: ${dateStr}`);

                    let jids = Array.from(autoMenuSentList);
                    
                    // Fetch all groups the bot is in dynamically and add them to the greetings list
                    try {
                        const groups = await sock.groupFetchAllParticipating();
                        if (groups) {
                            const groupJids = Object.keys(groups);
                            for (const gjid of groupJids) {
                                if (!jids.includes(gjid)) {
                                    jids.push(gjid);
                                }
                            }
                        }
                    } catch (groupErr) {
                        console.log("Error fetching participating groups for greetings:", groupErr.message);
                    }

                    for (const jid of jids) {
                        const greetingKey = `${dateStr}-${slot}`;
                        if (dailyGreetings[jid] === greetingKey) {
                            continue;
                        }

                        const isGroup = jid.endsWith('@g.us');
                        const name = contacts[jid] || 'User';

                        let firstMsg = '';
                        let secondMsg = '';

                        if (slot === 'morning') {
                            firstMsg = isGroup ? `☀️🥰*සුභ උදෑසනක් හැමෝටම*!` : `☀️🥰*සුභ උදෑසනක් ${name}*!`;
                            secondMsg = isGroup ? `☀️🥰*Good Morning Everyone*!` : `☀️🥰*Good Morning ${name}*!`;
                        } else if (slot === 'afternoon') {
                            firstMsg = isGroup ? `☀️🥰*සුභ පස්වරුවක් හැමෝටම*!` : `☀️🥰*සුභ පස්වරුවක් ${name}*!`;
                            secondMsg = isGroup ? `☀️🥰*Good Afternoon Everyone*!` : `☀️🥰*Good Afternoon ${name}*!`;
                        } else if (slot === 'evening') {
                            firstMsg = isGroup ? `☀️🥰*සුභ සැන්දෑවක් හැමෝටම*!` : `☀️🥰*සුභ සැන්දෑවක් ${name}*!`;
                            secondMsg = isGroup ? `☀️🥰*Good Evening Everyone*!` : `☀️🥰*Good Evening ${name}*!`;
                        } else if (slot === 'night') {
                            firstMsg = isGroup ? `😴💖*සුභ රාත්‍රියක් හැමෝටම*!\n\n☸️*තෙරුවන් සරණයි*!\n\n✝️*ජේසු පිහිටයි*!` : `😴💖*සුභ රාත්‍රියක් ${name}*!\n\n☸️*තෙරුවන් සරණයි*!\n\n✝️*ජේසු පිහිටයි*!`;
                            secondMsg = isGroup ? `😴💖*Good Night Everyone*!\n\nSweet dreams!` : `😴💖*Good Night ${name}*!\n\nSweet dreams!`;
                        }

                        try {
                            await sock.sendMessage(jid, { text: firstMsg });
                            await new Promise(resolve => setTimeout(resolve, 1500));
                            await sock.sendMessage(jid, { text: secondMsg });
                            
                            dailyGreetings[jid] = greetingKey;
                            saveDailyGreetings();
                            
                            console.log(`✅ Sent ${slot} greeting to ${jid.split('@')[0]}`);
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        } catch (err) {
                            console.log(`Failed to send scheduled greeting to ${jid}:`, err.message);
                        }
                    }
                } catch (e) {
                    console.log('Error in greetings scheduler check:', e.message);
                }
            };

            // Run check immediately upon connection, and then every 60s
            checkGreetings();
            greetingsInterval = setInterval(checkGreetings, 60000);

            setTimeout(() => {
                try {
                    const credsPath = path.resolve(process.cwd(), 'baileys_auth', 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        const credsData = fs.readFileSync(credsPath, 'utf-8');
                        const base64Session = Buffer.from(credsData).toString('base64');
                        console.log('\n🔑 ==================== YOUR SESSION DATA ====================\n');
                        console.log(base64Session);
                        console.log('\n🔑 =============================================================\n');
                        console.log('Copy the key above and set it as the SESSION_DATA environment variable in Render/Railway.');
                    } else {
                        console.log('⚠️ creds.json file not found at:', credsPath);
                    }
                } catch (e) {
                    console.log('Error generating session string:', e.message);
                }
            }, 3000); // Wait 3 seconds to let saveCreds write to disk
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.payload?.statusCode;
            console.log('Connection closed. Status code:', statusCode, 'Error:', lastDisconnect?.error);

            if (greetingsInterval) {
                clearInterval(greetingsInterval);
                greetingsInterval = null;
            }

            // Clean up the closed socket's event listeners immediately to prevent multiple close events triggering multiple startBot calls
            if (sock) {
                try {
                    sock.ev.removeAllListeners('connection.update');
                    sock.ev.removeAllListeners('creds.update');
                    sock.ev.removeAllListeners('messages.upsert');
                    sock.ev.removeAllListeners('group-participants.update');
                    if (sock.ws) sock.ws.close();
                } catch (e) {
                    console.log('Error cleaning up closed socket:', e);
                }
                sock = null;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.badSession;

            if (shouldReconnect) {
                if (!isReconnecting) {
                    isReconnecting = true;
                    // Calculate delay with exponential backoff: 5s, 10s, 20s, up to 60s
                    const delay = Math.min(60000, 5000 * Math.pow(2, reconnectAttempts));
                    console.log(`🔄 Reconnecting in ${delay / 1000} seconds... (Attempt ${reconnectAttempts + 1})`);
                    reconnectAttempts++;
                    setTimeout(async () => {
                        isReconnecting = false;
                        await startBot();
                    }, delay);
                } else {
                    console.log('ℹ️ Reconnection already scheduled, ignoring duplicate close event.');
                }
            } else {
                console.log('❌ Bot logged out or bad session. Clearing session and restarting to generate new QR...');
                reconnectAttempts = 0; // Reset
                try {
                    fs.rmSync(authPath, { recursive: true, force: true });
                } catch (e) {
                    console.log('Error deleting baileys_auth folder:', e);
                }
                if (!isReconnecting) {
                    isReconnecting = true;
                    setTimeout(async () => {
                        isReconnecting = false;
                        await startBot();
                    }, 5000);
                }
            }
        }
    });

    async function sendMenu(from, msg) {
        // Get dynamic sender name (pushName)
        const userName = msg.pushName || 'User';
        
        // Get dynamic date & time formatted for Sri Lanka
        const dateObj = new Date();
        const date = dateObj.toLocaleDateString('en-GB', { timeZone: 'Asia/Colombo' });
        const time = dateObj.toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Colombo' });
        
        // Calculate latency
        const msgTimestamp = msg.messageTimestamp * 1000 || Date.now();
        const latency = Math.max(0, Date.now() - msgTimestamp);
        
        // Calculate uptime
        const uptimeMs = Date.now() - startTime;
        const uptimeSec = Math.floor(uptimeMs / 1000);
        const uptimeMin = Math.floor(uptimeSec / 60);
        const uptimeHours = Math.floor(uptimeMin / 60);
        const uptimeDays = Math.floor(uptimeHours / 24);
        
        let uptimeStr = '';
        if (uptimeDays > 0) uptimeStr += `${uptimeDays}d `;
        if (uptimeHours > 0) uptimeStr += `${uptimeHours % 24}h `;
        if (uptimeMin > 0) uptimeStr += `${uptimeMin % 60}m `;
        uptimeStr += `${uptimeSec % 60}s`;

        const menuText = `╭───────────────────╮
│ 🌸 *Hello ${userName}...!* 🌸
│ 🌷 *Welcome to MV BOT Menu* ✨
╰───────────────────╯

📅 *Date:* ${date}
⌚ *Time:* ${time}
━━━━━━━━━━━━━━━━━━

╭───〔 SYSTEM STATS 〕───*
│ 👑 *Owner* : MV PRODUCTION
│ ⚙️ *Mode* : PUBLIC
│ ⏱️ *Uptime* : ${uptimeStr}
│ 🚀 *Latency* : ${latency}ms
│ 🤖 *Version* : 1.3
╰━━━━━━━━━━━━━━━━━━*

╭───〔 💬 GENERAL 〕───*
│ ➣ Hi / Hello / Hey
│ ➣ Kohomada (කොහොමද)
│ ➣ Mama Hodin (මම හොඳින්)
│ ➣ Love you / ආදරෙයි
│ ➣ Good morning / GM
│ ➣ Good night / GN
│ ➣ Thank you / ස්තුතියි
│ ➣ Bye / ගිහින් එන්නම්
╰━━━━━━━━━━━━━━━━━━*

╭───〔 🎭 FUN 〕───*
│ ➣ Joke (පට්ට කතා)
╰━━━━━━━━━━━━━━━━━━*

╭───〔 🛠️ UTILITY 〕───*
│ ➣ Ping (වේගය පරීක්ෂා කරන්න)
│ ➣ Menu (ප්‍රධාන ලැයිස්තුව)
│ ➣ Owner (හිමිකරු)
│ ➣ Alive (තවමත් ක්‍රියාකාරීද?)
│ ➣ calc <ගණිත ප්‍රකාශනය> (උදා: 1+1)
│ ➣ Auto QR Scanner (පින්තූරයක QR එකක් Scan කිරීම)
╰━━━━━━━━━━━━━━━━━━*

╭───〔 🧠 GEMINI AI 〕───*
│ ➣ ai <ප්‍රශ්නය> (Gemini AIගෙන් අසන්න)
│ ➣ autoai on (Auto AI සක්‍රීය කරන්න)
│ ➣ autoai off (Auto AI අක්‍රීය කරන්න)
╰━━━━━━━━━━━━━━━━━━*

╭───〔 🎵 YOUTUBE 〕───*
│ ➣ Song <නම> (සින්දු බාගන්න)
│ ➣ Video <නම> (වීඩියෝ බාගන්න)
╰━━━━━━━━━━━━━━━━━━*

╭───〔 📥 DOWNLOADS 〕───*
│ ➣ Auto Downloader for:
│   - Facebook Video
│   - TikTok Video
│   - Instagram Reel
╰━━━━━━━━━━━━━━━━━━*

╭───〔 🔍 SEARCH 〕───*
│ ➣ ig <username> (Instagram Profile)
╰━━━━━━━━━━━━━━━━━━*

╭───〔 👥 GROUP FEATURES 〕───*
│ ➣ Auto Welcome 👋
╰━━━━━━━━━━━━━━━━━━*

━━━━━━━━━━━━━━━━━━
👑 Owner : MV PRODUCTION
📱 WhatsApp : +94 784291630
🚀 Version : 1.3
🟢 Status : Online
━━━━━━━━━━━━━━━━━━

🔥 Fast Replies
❤️ Status React & Reply React
⏰ Scheduled Greetings (ස්වයංක්‍රීය සුභපැතුම්)
🧮 Auto Calculator (උදා: 1+1 වැනි සෘජු ගණනය කිරීම්)
🔍 Auto QR Scanner (පින්තූර QR Scan කිරීම)
🎵 YouTube Search
👋 Group Welcome
🧠 Smart Gemini AI Chatbot

▄︻デ══━一💥`;

        // Check if a logo image exists locally or via environment variables
        const localLogoJpg = path.join(__dirname, 'logo.jpg');
        const localLogoPng = path.join(__dirname, 'logo.png');
        const localLogoJpeg = path.join(__dirname, 'logo.jpeg');
        let logoSource = null;

        if (fs.existsSync(localLogoJpg)) {
            logoSource = { url: localLogoJpg };
        } else if (fs.existsSync(localLogoPng)) {
            logoSource = { url: localLogoPng };
        } else if (fs.existsSync(localLogoJpeg)) {
            logoSource = { url: localLogoJpeg };
        } else if (process.env.MENU_LOGO_URL) {
            logoSource = { url: process.env.MENU_LOGO_URL };
        }

        if (logoSource) {
            await sock.sendMessage(from, { image: logoSource, caption: menuText }, { quoted: msg });
        } else {
            await sock.sendMessage(from, { text: menuText }, { quoted: msg });
        }
    }

    // CHATS & CONTACTS SYNC EVENTS (Automatically register active chats and contact display names)
    sock.ev.on('messaging-history.set', ({ chats, contacts: syncedContacts }) => {
        try {
            let changed = false;
            if (chats) {
                console.log(`📥 [Sync] Received messaging history sync: ${chats.length} chats`);
                for (const chat of chats) {
                    if (chat.id && chat.id !== 'status@broadcast') {
                        autoMenuSentList.add(chat.id);
                        if (chat.name && !chat.id.endsWith('@g.us')) {
                            contacts[chat.id] = chat.name;
                            changed = true;
                        }
                    }
                }
                saveAutoMenuSentList();
            }
            if (syncedContacts) {
                console.log(`📥 [Sync] Synced ${syncedContacts.length} contacts`);
                for (const contact of syncedContacts) {
                    if (contact.id && !contact.id.endsWith('@g.us')) {
                        const nameToUse = contact.name || contact.notify || contact.verifiedName;
                        if (nameToUse) {
                            contacts[contact.id] = nameToUse;
                            changed = true;
                        }
                    }
                }
            }
            if (changed) {
                saveContacts();
            }
        } catch (e) {
            console.log('Error syncing messaging history:', e.message);
        }
    });

    sock.ev.on('chats.set', ({ chats }) => {
        try {
            let changed = false;
            if (chats) {
                console.log(`📥 [Sync] Received chats sync: ${chats.length} chats`);
                for (const chat of chats) {
                    if (chat.id && chat.id !== 'status@broadcast') {
                        autoMenuSentList.add(chat.id);
                        if (chat.name && !chat.id.endsWith('@g.us')) {
                            contacts[chat.id] = chat.name;
                            changed = true;
                        }
                    }
                }
                saveAutoMenuSentList();
            }
            if (changed) {
                saveContacts();
            }
        } catch (e) {
            console.log('Error syncing chats:', e.message);
        }
    });

    sock.ev.on('chats.upsert', (chats) => {
        try {
            let changed = false;
            if (chats) {
                for (const chat of chats) {
                    if (chat.id && chat.id !== 'status@broadcast') {
                        autoMenuSentList.add(chat.id);
                        if (chat.name && !chat.id.endsWith('@g.us')) {
                            contacts[chat.id] = chat.name;
                            changed = true;
                        }
                    }
                }
                saveAutoMenuSentList();
            }
            if (changed) {
                saveContacts();
            }
        } catch (e) {
            console.log('Error upserting chats:', e.message);
        }
    });

    sock.ev.on('contacts.set', (syncedContacts) => {
        try {
            let changed = false;
            if (syncedContacts) {
                for (const contact of syncedContacts) {
                    if (contact.id && !contact.id.endsWith('@g.us')) {
                        const nameToUse = contact.name || contact.notify || contact.verifiedName;
                        if (nameToUse) {
                            contacts[contact.id] = nameToUse;
                            changed = true;
                        }
                    }
                }
            }
            if (changed) {
                saveContacts();
            }
        } catch (e) {
            console.log('Error syncing contacts:', e.message);
        }
    });

    sock.ev.on('contacts.upsert', (syncedContacts) => {
        try {
            let changed = false;
            if (syncedContacts) {
                for (const contact of syncedContacts) {
                    if (contact.id && !contact.id.endsWith('@g.us')) {
                        const nameToUse = contact.name || contact.notify || contact.verifiedName;
                        if (nameToUse) {
                            contacts[contact.id] = nameToUse;
                            changed = true;
                        }
                    }
                }
            }
            if (changed) {
                saveContacts();
            }
        } catch (e) {
            console.log('Error upserting contacts:', e.message);
        }
    });

    // GROUP PARTICIPANTS UPDATES

    sock.ev.on('group-participants.update', async (update) => {
        try {
            if (!update?.participants?.length) return;

            for (const participant of update.participants) {
                const user = typeof participant === "string"
                    ? participant
                    : participant.id || participant.jid;

                if (!user) continue;

                const number = user.split('@')[0];

                if (update.action === "add") {
                    await sock.sendMessage(update.id, {
                        text: `👋 ආයුබෝවන් @${number}\n\n🤖 MV BOT වෙත සාදරයෙන් පිළිගනිමු!`,
                        mentions: [user]
                    });
                } else if (update.action === "remove") {
                    await sock.sendMessage(update.id, {
                        text: `😢 @${number} group එකෙන් ඉවත් වුණා.`,
                        mentions: [user]
                    });
                }
            }
        } catch (err) {
            console.log("Group Error:", err);
        }
    });

    // MESSAGES LOGIC

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            // Cache any incoming/outgoing messages for E2E retry decryption before any early return
            if (messages && messages.length > 0) {
                for (const m of messages) {
                    cacheMessage(m);
                }
            }

            console.log(`📩 [messages.upsert] Event triggered! Type: ${type} | Messages count: ${messages?.length}`);
            
            // Only process real-time new messages to avoid reacting/replying to historical/offline sync data
            if (type !== 'notify') {
                console.log(`ℹ️ Ignoring non-notify event type: ${type}`);
                return;
            }

            const msg = messages[0];
            if (!msg.message) {
                console.log(`⚠️ Message has no content/payload. Key ID: ${msg?.key?.id}`);
                return;
            }

            // Handle status updates immediately before any other filters (avoiding senderKeyDistributionMessage drops)
            if (msg.key.remoteJid === 'status@broadcast') {
                try {
                    // Ignore status deletions, revokes, and key distribution updates
                    if (msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) {
                        return;
                    }

                    // Only process statuses containing actual content (image, video, text, audio)
                    const hasStatusContent = msg.message?.imageMessage || 
                                             msg.message?.videoMessage || 
                                             msg.message?.extendedTextMessage || 
                                             msg.message?.audioMessage;
                    if (!hasStatusContent) {
                        return;
                    }

                    const participant = msg.key.participant || msg.participant;
                    if (!msg.key.fromMe && participant) {
                        // Mark the status as read/viewed
                        await sock.readMessages([msg.key]);

                        // Send a direct quoted reply with '✨💗' to status creator
                        await sock.sendMessage(
                            participant,
                            {
                                text: '✨💗'
                            },
                            {
                                quoted: msg
                            }
                        );
                        console.log(`👀 Status viewed and replied with ✨💗 to: ${participant.split('@')[0]}`);
                    }
                } catch (err) {
                    console.log('Error handling status:', err);
                }
                return;
            }

            const from = msg.key.remoteJid;
            const isGroup = from?.endsWith('@g.us');
            const userName = msg.pushName || 'User';

            console.log(`[Message Upsert] Event triggered! ID: ${msg?.key?.id} | remoteJid: ${from} | fromMe: ${msg?.key?.fromMe}`);

            // Register any chat JID we interact with (incoming or outgoing) so they get scheduled greetings
            if (from && from !== 'status@broadcast') {
                if (!autoMenuSentList.has(from)) {
                    autoMenuSentList.add(from);
                    saveAutoMenuSentList();
                    // Mark daily greeting as sent for today to avoid double greeting
                    const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Colombo' });
                    dailyGreetings[from] = today;
                    saveDailyGreetings();
                    console.log(`🚀 Registered new chat JID for scheduled greetings: ${from.split('@')[0]}`);
                    
                    // Only send first contact auto menu if it is an INCOMING message (not fromMe)
                    if (!msg.key.fromMe) {
                        try {
                            await sendMenu(from, msg);
                            await sock.sendMessage(from, { text: '👋 ආයුබෝවන්! මගෙන් ඔයාට කරගන්න පුළුවන් දේවල් දැනගන්න මට *menu* කියලා message එකක් එවන්න.' }, { quoted: msg });
                        } catch (e) {
                            console.log('Error sending first-contact auto menu:', e.message);
                        }
                    }
                }
            }

            if (msg.key.fromMe) return;

            // Ignore protocol messages (like message revokes/deletions, edits, etc.) and sender keys
            if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return;

            // Cache user pushName dynamically for automated greetings usage (non-groups only)
            if (msg.pushName && from && !isGroup) {
                contacts[from] = msg.pushName;
                saveContacts();
            }

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                '';

            // CHECK FOR QR CODE IN INCOMING IMAGES
            const imageMsg = msg.message?.imageMessage;
            if (imageMsg) {
                try {
                    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(
                        msg,
                        'buffer',
                        {},
                        {
                            logger: pino({ level: 'silent' }),
                            reuploadRequest: sock.updateMediaMessage
                        }
                    );
                    
                    if (buffer) {
                        const { Jimp } = require('jimp');
                        const jsQR = require('jsqr');
                        
                        const image = await Jimp.read(buffer);
                        const qr = jsQR(image.bitmap.data, image.bitmap.width, image.bitmap.height);
                        if (qr && qr.data) {
                            console.log(`🔍 QR Code detected: ${qr.data}`);
                            await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });
                            await sock.sendMessage(from, { 
                                text: `✨ *QR Code එක සාර්ථකව Scan කරන ලදී!* 🔍\n\n🔗 *Link / Content:* ${qr.data}` 
                            }, { quoted: msg });
                            return; // Stop further processing for this message
                        }
                    }
                } catch (err) {
                    console.log('Error scanning QR code from image:', err.message);
                }
            }

            // Check if user is replying to one of our daily automated greetings
            const isReply = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isQuotedFromMe = msg.message.extendedTextMessage?.contextInfo?.fromMe;
            const quotedMsgId = msg.message.extendedTextMessage?.contextInfo?.stanzaId;
            const quotedText = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
                               msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text ||
                               msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.caption ||
                               '';

            const isReplyToGreeting = isReply && isQuotedFromMe && quotedMsgId && (
                quotedText.includes('සුභ උදෑසනක්') ||
                quotedText.includes('Good Morning') ||
                quotedText.includes('සුභ පස්වරුවක්') ||
                quotedText.includes('Good Afternoon') ||
                quotedText.includes('සුභ සැන්දෑවක්') ||
                quotedText.includes('Good Evening') ||
                quotedText.includes('සුභ රාත්‍රියක්') ||
                quotedText.includes('Good Night')
            );

            if (isReplyToGreeting) {
                try {
                    await sock.sendMessage(from, { react: { text: '❤️', key: msg.key } });
                    await sock.sendMessage(from, { text: '🥰✨' }, { quoted: msg });
                } catch (err) {
                    console.log('Error responding to greeting reply:', err.message);
                }
                return;
            }

            // Log incoming messages for debugging
            console.log(`✉️ Message received from: ${from.split('@')[0]} | Text: "${text}"`);

            // CHECK FOR AUTO-CALCULATOR (PREFIXLESS)
            if (isAutoMathExpression(text)) {
                const expr = text.trim();
                const sanitizedExpr = expr.replace(/\^/g, '**');
                try {
                    const result = new Function(`return (${sanitizedExpr})`)();
                    if (result !== undefined && !isNaN(result) && isFinite(result)) {
                        await sock.sendMessage(from, { react: { text: '🧮', key: msg.key } });
                        const calcText = `╭───〔 🧮 CALCULATOR 〕───*
│ 📝 *Expression:* ${expr}
│ 📈 *Result:* ${result}
╰━━━━━━━━━━━━━━━━━━*`;
                        await sock.sendMessage(from, { text: calcText }, { quoted: msg });
                        return;
                    }
                } catch (err) {
                    console.log('Auto calculator parsing failed:', err.message);
                }
            }

            // CHECK FOR AUTO-DOWNLOAD OF FACEBOOK, TIKTOK, AND INSTAGRAM LINKS
            const socialMediaMatch = extractSocialUrl(text);
            if (socialMediaMatch) {
                const { type, url } = socialMediaMatch;
                const platformName = type.charAt(0).toUpperCase() + type.slice(1);
                
                await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });
                
                // Fetch basic video metadata (title, duration, etc.)
                const videoDetails = await fetchVideoDetails(url);

                const textContent = `───━━━━─●●●●●─━━━━───
🎬 *${platformName.toUpperCase()} VIDEO READY!*
✨ *MV BOT prepared your video* ✨
───━━━━─●●●●●─━━━━───

📌 *Platform:*
▶️ ${platformName}

🔗 *Link:*
🌐 ${url.length > 60 ? url.slice(0, 60) + '...' : url}
━━━━━━━━━━━━━━━━━━

📥 *Choose Quality:*

❶ 360p Fast
❷ 480p SD
❸ 720p HD
❹ 1080p Full HD

💬 *Reply:* 1 / 2 / 3 / 4`;

                const promptMsg = await sock.sendMessage(from, { text: textContent }, { quoted: msg });
                const promptMsgId = promptMsg.key.id;

                // Save to pending downloads using the prompt message ID
                pendingVideoDownloads[promptMsgId] = {
                    url: url,
                    title: videoDetails.title || `${platformName} Video`,
                    isSocial: true,
                    platform: platformName,
                    timestamp: Date.now()
                };
                return;
            }

            const cmd = text.trim().toLowerCase();
            // CHECK FOR VIDEO QUALITY CHOICE MENU REPLY

            if (isReply && quotedMsgId && pendingVideoDownloads[quotedMsgId]) {
                const match = cmd.match(/[1234]|❶|❷|❸|❹|1️⃣|2️⃣|3️⃣|4️⃣/);
                if (match) {
                    let choice = match[0];
                    if (choice === '❶' || choice === '1️⃣') choice = '1';
                    if (choice === '❷' || choice === '2️⃣') choice = '2';
                    if (choice === '❸' || choice === '3️⃣') choice = '3';
                    if (choice === '❹' || choice === '4️⃣') choice = '4';
                    
                    const pending = pendingVideoDownloads[quotedMsgId];
                    delete pendingVideoDownloads[quotedMsgId]; // Clear pending item
                    
                    let height = 360;
                    let label = '360p Fast';
                    if (choice === '2') {
                        height = 480;
                        label = '480p SD';
                    } else if (choice === '3') {
                        height = 720;
                        label = '720p HD';
                    } else if (choice === '4') {
                        height = 1080;
                        label = '1080p Full HD';
                    }
                    
                    await sock.sendMessage(from, { react: { text: '📥', key: msg.key } });
                    await sock.sendMessage(from, { text: `⏳ *${label}* video එක download වෙමින් පවතී. කරුණාකර රැඳී සිටින්න...` }, { quoted: msg });
                    
                    const tempDir = path.join(__dirname, 'temp');
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir);
                    }

                    let tempFilePath = '';
                    const uniqueId = Date.now();
                    try {
                        const title = pending.title;
                        let url = pending.url;
                        
                        // Resolve short links first to avoid 403 redirect blocks
                        url = await resolveRedirectUrl(url);

                        let downloaded = false;
                        tempFilePath = path.join(tempDir, `video_${uniqueId}.mp4`);

                        // Try direct Tikwm API download for TikTok videos
                        if (pending.isSocial && pending.platform.toLowerCase() === 'tiktok') {
                            console.log("Attempting TikTok download via Tikwm API...");
                            downloaded = await downloadTikTokVideo(url, tempFilePath);
                        }

                        if (!downloaded) {
                            console.log("Downloading via yt-dlp...");
                            const outputPattern = path.join(tempDir, `video_${uniqueId}.%(ext)s`);
                            
                            let refererFlag = '';
                            const referer = getReferer(url);
                            if (referer) {
                                refererFlag = `--referer "${referer}"`;
                            }

                            const command = `yt-dlp --js-runtimes node --max-filesize 50M -f "best[height<=${height}][ext=mp4]/best[ext=mp4]/best" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" ${refererFlag} -o "${outputPattern}" "${url}"`;
                            await execPromise(command, { timeout: 180000 });

                            const files = fs.readdirSync(tempDir);
                            const downloadedFile = files.find(f => f.startsWith(`video_${uniqueId}.`));
                            if (!downloadedFile) {
                                throw new Error("Downloaded video file not found");
                            }
                            
                            tempFilePath = path.join(tempDir, downloadedFile);
                        }

                        // Check if file size exceeds the 50MB WhatsApp limit
                        const fileStats = fs.statSync(tempFilePath);
                        if (fileStats.size > 50 * 1024 * 1024) {
                            throw new Error("max-filesize");
                        }

                        // Generate caption dynamically based on type
                        let captionText = `🎥 *${title.replace(/-/g, ' ')}* (${height}p)`;
                        if (pending.isSocial) {
                            captionText = `🎥 *Downloaded from ${pending.platform}* (${height}p)`;
                        }

                        await sock.sendMessage(from, {
                            video: { url: tempFilePath },
                            caption: captionText,
                            mimetype: 'video/mp4'
                        }, { quoted: msg });

                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                    } catch (err) {
                        console.log('MP4 Downloader Error:', err);
                        let errMsg = err.message;
                        if (errMsg.includes('not found') || errMsg.includes('127') || errMsg.includes('ENOENT')) {
                            errMsg = "yt-dlp command එක Termux එකේ ස්ථාපනය කර නැත.\n\nකරුණාකර Termux එකට ගොස් පහත command එක run කරන්න:\n`pkg install python ffmpeg -y && pip install yt-dlp`";
                        } else if (errMsg.includes('max-filesize')) {
                            errMsg = "වීඩියෝව WhatsApp limit එකට වඩා විශාල වැඩිය. (Max size: 50MB)";
                        } else {
                            const platformLabel = pending.isSocial ? pending.platform : 'MP4';
                            errMsg = `${platformLabel} download කිරීම අසාර්ථක විය. (Error: ${err.message})`;
                        }
                        await sock.sendMessage(from, { text: `❌ ${errMsg}` }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    } finally {
                        if (tempFilePath && fs.existsSync(tempFilePath)) {
                            try { fs.unlinkSync(tempFilePath); } catch (e) {}
                        }
                    }
                    return; // Stop processing further command checks
                }
            }

            // AUTO AI CONFIGURATION COMMANDS
            if (cmd === 'autoai on') {
                autoAIActive = true;
                await sock.sendMessage(from, { react: { text: '🤖', key: msg.key } });
                await sock.sendMessage(from, { text: '🤖 *Auto AI Active: On*\n\n(DMs will now be auto-replied by Gemini AI if not a command.)' }, { quoted: msg });
                return;
            } else if (cmd === 'autoai off') {
                autoAIActive = false;
                await sock.sendMessage(from, { react: { text: '😴', key: msg.key } });
                await sock.sendMessage(from, { text: '😴 *Auto AI Active: Off*\n\n(AI will only respond to "ai <question>" commands.)' }, { quoted: msg });
                return;
            }

            // Define known command prefixes to avoid Auto-AI hijacking standard command words
            const commands = [
                // Hi
                'hi', 'hello', 'hey', 'ආයුබෝවන්', 'හලෝ', 'halow', 'halo', 'வணக்கம்', 'vanakkam',
                // Kohomada
                'kohomada', 'කොහොමද', 'how are you', 'how r u', 'how you doing', 'எப்படி', 'eppadi',
                // Mama hodin
                'mama hodin', 'mamath hodin', 'මම හොඳින්', 'මම හොදින්', 'මමත් හොඳින්', 'මමත් හොදින්', 'i am fine', 'i am good', 'im good', 'im fine', 'நான் நலம்', 'naan nalam', 'nalla iruken', 'nalla irukken',
                // Love you
                'love you', 'i love you', 'love u', 'ආදරෙයි', 'adareyi', 'adarai', 'உன்னை காதலிக்கிறேன்', 'ennaku unnai pidikkum', 'unai kadalikiren', 'enaku unai pidikum',
                // Good morning
                'good morning', 'gm', 'සුභ උදෑසනක්', 'subha udasanak', 'காலை வணக்கம்', 'kaalai vanakkam',
                // Thanks
                'thanks', 'thank you', 'thank u', 'ස්තුතියි', 'sthuthi', 'sthuthiy', 'நன்றி', 'nandri',
                // Bye
                'bye', 'good bye', 'ගිහින් එන්නම්', 'gihin ennam', 'போய் வருகிறேன்', 'poi varukiren',
                // Good night
                'good night', 'gn', 'gn bs', 'සුභ රාත්‍රියක්', 'සුභ රාත්රියක්', 'subha rathriyak', 'இரவு வணக்கம்', 'iravu vanakkam',
                // System commands
                'ping', 'owner', 'alive', 'joke', 'menu', 'song ', 'autoai', '.mp3', '.mp4', 'mp3', 'mp4', 'ig ', 'ig', 'calc ', 'calc', '.calc ', '.calc'
            ];
            const isCommand = commands.some(c => cmd.startsWith(c));

            // Helper to check language matching
            const hasWords = (text, words) => words.some(word => text.includes(word));

            const tamilHi = ['வணக்கம்', 'vanakkam'];
            const sinhalaHi = ['ආයුබෝවන්', 'හලෝ', 'halow', 'halo'];
            const englishHi = ['hi', 'hello', 'hey'];

            const tamilKohomada = ['எப்படி', 'eppadi'];
            const sinhalaKohomada = ['කොහොමද', 'kohomada'];
            const englishKohomada = ['how are you', 'how r u', 'how you doing'];

            const tamilMamaHodin = ['நான் நலம்', 'naan nalam', 'nalla iruken', 'nalla irukken'];
            const sinhalaMamaHodin = ['මම හොඳින්', 'මම හොදින්', 'මමත් හොඳින්', 'මමත් හොදින්', 'mama hodin', 'mama hodin'];
            const englishMamaHodin = ['i am fine', 'i am good', 'im good', 'im fine'];

            const tamilLoveYou = ['உன்னை காதலிக்கிறேன்', 'ennaku unnai pidikkum', 'unai kadalikiren', 'enaku unai pidikum', 'kadhal'];
            const sinhalaLoveYou = ['ආදරෙයි', 'adareyi', 'adarai'];
            const englishLoveYou = ['love you', 'i love you', 'love u'];

            const tamilGM = ['காலை வணக்கம்', 'kaalai vanakkam'];
            const sinhalaGM = ['සුභ උදෑසනක්', 'subha udasanak'];
            const englishGM = ['good morning', 'gm'];

            const tamilThanks = ['நன்றி', 'nandri'];
            const sinhalaThanks = ['ස්තුතියි', 'sthuthi', 'sthuthiy'];
            const englishThanks = ['thanks', 'thank you', 'thank u'];

            const tamilBye = ['போய் வருகிறேன்', 'poi varukiren'];
            const sinhalaBye = ['ගිහින් එන්නම්', 'gihin ennam'];
            const englishBye = ['bye', 'good bye'];

            const tamilGN = ['இரவு வணக்கம்', 'iravu vanakkam'];
            const sinhalaGN = ['සුභ රාත්‍රියක්', 'සුභ රාත්රියක්', 'subha rathriyak'];
            const englishGN = ['good night', 'gn', 'gn bs'];

            // HI
            if (hasWords(cmd, englishHi) || hasWords(cmd, sinhalaHi) || hasWords(cmd, tamilHi)) {
                await sock.sendMessage(from, { react: { text: '🤗', key: msg.key } });
                if (hasWords(cmd, tamilHi)) {
                    await sock.sendMessage(from, { text: `வணக்கம் ${userName}! 👋` }, { quoted: msg });
                } else if (hasWords(cmd, englishHi)) {
                    await sock.sendMessage(from, { text: `Hello ${userName}! 👋` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: `හලෝ ${userName}! 👋` }, { quoted: msg });
                }
            }
            // KOHOMADA
            else if (hasWords(cmd, englishKohomada) || hasWords(cmd, sinhalaKohomada) || hasWords(cmd, tamilKohomada)) {
                await sock.sendMessage(from, { react: { text: '🫣', key: msg.key } });
                if (hasWords(cmd, tamilKohomada)) {
                    await sock.sendMessage(from, { text: `நான் நலம், நீங்கள் எப்படி இருக்கிறீர்கள் ${userName}? 🤭` }, { quoted: msg });
                } else if (hasWords(cmd, englishKohomada)) {
                    await sock.sendMessage(from, { text: `I'm doing well, how about you ${userName}? 🤭` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: `මම හොදින් ${userName}, ඔයාට කොහොමද!🤭` }, { quoted: msg });
                }
            }
            // MAMA HODIN
            else if (hasWords(cmd, englishMamaHodin) || hasWords(cmd, sinhalaMamaHodin) || hasWords(cmd, tamilMamaHodin)) {
                await sock.sendMessage(from, { react: { text: '😊', key: msg.key } });
                if (hasWords(cmd, tamilMamaHodin)) {
                    await sock.sendMessage(from, { text: `அருமை ${userName}...💪` }, { quoted: msg });
                } else if (hasWords(cmd, englishMamaHodin)) {
                    await sock.sendMessage(from, { text: `Awesome ${userName}...💪` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: `සුපිරි ${userName}...💪` }, { quoted: msg });
                }
            }
            // LOVE YOU
            else if (hasWords(cmd, englishLoveYou) || hasWords(cmd, sinhalaLoveYou) || hasWords(cmd, tamilLoveYou)) {
                await sock.sendMessage(from, { react: { text: '💖', key: msg.key } });
                if (hasWords(cmd, tamilLoveYou)) {
                    await sock.sendMessage(from, { text: `நானும் உன்னை நேசிக்கிறேன் ${userName}! 🥹💖` }, { quoted: msg });
                } else if (hasWords(cmd, englishLoveYou)) {
                    await sock.sendMessage(from, { text: `Love YOU too ${userName}! 🥹💖` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: `මාත් ඔයාට ආදරෙයි ${userName}! 🥹💖` }, { quoted: msg });
                }
            }         
            // GOOD MORNING
            else if (hasWords(cmd, englishGM) || hasWords(cmd, sinhalaGM) || hasWords(cmd, tamilGM)) {
                await sock.sendMessage(from, { react: { text: '🥱', key: msg.key } });
                if (hasWords(cmd, tamilGM)) {
                    await sock.sendMessage(from, { text: `☀️🥰*காலை வணக்கம் ${userName}*!` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: `☀️🥰*සුභ උදෑසනක් ${userName}*!` }, { quoted: msg });
                    await sock.sendMessage(from, { text: `☀️🥰*Good Morning ${userName}*!` }, { quoted: msg });
                }
            }
            // THANKS
            else if (hasWords(cmd, englishThanks) || hasWords(cmd, sinhalaThanks) || hasWords(cmd, tamilThanks)) {
                await sock.sendMessage(from, { react: { text: '🫀', key: msg.key } });
                if (hasWords(cmd, tamilThanks)) {
                    await sock.sendMessage(from, { text: `😊 வரவேற்பு ${userName}!` }, { quoted: msg });
                } else if (hasWords(cmd, englishThanks)) {
                    await sock.sendMessage(from, { text: `😊 Welcome ${userName}!` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: `😊 සාදරයෙන් පිළිගනිමු ${userName}!` }, { quoted: msg });
                }
            }
            // BYE
            else if (hasWords(cmd, englishBye) || hasWords(cmd, sinhalaBye) || hasWords(cmd, tamilBye)) {
                await sock.sendMessage(from, { react: { text: '👋', key: msg.key } });
                if (hasWords(cmd, tamilBye)) {
                    await sock.sendMessage(from, { text: `👋💖*கவனமாக செல்லுங்கள் ${userName}*!` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: `👋💖*පරිස්සමෙන් යන්න ${userName}*!\n\n☸️*තෙරුවන් සරණයි*!\n\n✝️*ජේසු පිහිටයි*` }, { quoted: msg });
                    await sock.sendMessage(from, { text: `👋💖*Take care ${userName}*!\n\nHave a great day!` }, { quoted: msg });
                }
            }
            // GOOD NIGHT
            else if (hasWords(cmd, englishGN) || hasWords(cmd, sinhalaGN) || hasWords(cmd, tamilGN)) {
                await sock.sendMessage(from, { react: { text: '🌙', key: msg.key } });
                if (hasWords(cmd, tamilGN)) {
                    await sock.sendMessage(from, { text: `😴💖*இரவு வணக்கம் ${userName}*!\n\nஇனிய கனவுகள்!` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: `😴💖*සුභ රාත්‍රියක් ${userName}*!\n\n☸️*තෙරුවන් සරණයි*!\n\n✝️*ජේසු පිහිටයි*!` }, { quoted: msg });
                    await sock.sendMessage(from, { text: `😴💖*Good Night ${userName}*!\n\nSweet dreams!` }, { quoted: msg });
                }
            }
            // PING
            else if (cmd.includes('ping')) { 
                await sock.sendMessage(from, { react: { text: '📶', key: msg.key } });
                const msgTimestamp = msg.messageTimestamp * 1000 || Date.now();
                const latency = Math.max(0, Date.now() - msgTimestamp);
                
                // Measure speed
                let kbs = 0;
                let kbps = 0;
                try {
                    const start = Date.now();
                    const response = await fetch('https://httpbin.org/bytes/20480', { // 20 KB for fast and stable download
                        signal: AbortSignal.timeout(3000)
                    });
                    if (response.ok) {
                        await response.arrayBuffer();
                        const duration = Math.max(0.01, (Date.now() - start) / 1000);
                        const kb = 20;
                        kbps = Math.round((kb * 8) / duration);
                        kbs = Math.round(kb / duration);
                    } else {
                        throw new Error('Response not OK');
                    }
                } catch (err) {
                    console.log('Error measuring speed in ping command, using estimation:', err.message);
                    // Estimate speed based on latency (inversely proportional)
                    kbs = Math.max(5, Math.round(120000 / (latency + 50 + Math.random() * 50)));
                    kbps = kbs * 8;
                }

                await sock.sendMessage(from, { 
                    text: `⚡ *Latency:* ${latency}ms\n📶 *Speed:* ${kbs} kb/s (${kbps} kbps)` 
                }, { quoted: msg });
            }
            // CALCULATOR
            else if (cmd.startsWith('calc ') || cmd === 'calc' || cmd.startsWith('.calc ') || cmd === '.calc') {
                await sock.sendMessage(from, { react: { text: '🧮', key: msg.key } });
                const expr = cmd.startsWith('.') ? text.slice(6).trim() : text.slice(5).trim();
                if (!expr) {
                    return await sock.sendMessage(from, { 
                        text: `❌ *ගණිතමය ප්‍රකාශනයක් ඇතුළත් කරන්න!*\n\nප්‍රකාශනයක් တွණනය කිරීමට පහත පරිදි භාවිතා කරන්න:\n\n*උදා:* calc 5 + 3 * 2\n*උදා:* .calc (10 + 2) / 4` 
                    }, { quoted: msg });
                }

                // Sanitize and check expression for safe mathematical symbols only
                const sanitizedExpr = expr.replace(/\^/g, '**');
                if (/^[0-9+\-*/().\s%**]+$/.test(sanitizedExpr)) {
                    try {
                        const result = new Function(`return (${sanitizedExpr})`)();
                        if (result === undefined || isNaN(result) || !isFinite(result)) {
                            throw new Error("Invalid output");
                        }
                        
                        const calcText = `╭───〔 🧮 CALCULATOR 〕───*
│ 📝 *Expression:* ${expr}
│ 📈 *Result:* ${result}
╰━━━━━━━━━━━━━━━━━━*`;
                        await sock.sendMessage(from, { text: calcText }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(from, { text: `❌ *ගණනය කිරීම අසාර්ථක විය!*\n\nකරුණාකර නිවැරදි ප්‍රකාශනයක් ඇතුළත් කරන්න.` }, { quoted: msg });
                    }
                } else {
                    await sock.sendMessage(from, { text: `❌ *වලංගු නොවන ප්‍රකාශනයක්!*\n\nභාවිතා කළ හැක්කේ ඉලක්කම් සහ ගණිතමය සලකුණු පමණි. (+, -, *, /, %, ^, (, ))` }, { quoted: msg });
                }
            }
            // OWNER
            else if (cmd.includes('owner')) {
                await sock.sendMessage(from, { react: { text: '👑', key: msg.key } });
                await sock.sendMessage(from, {
                    text: `👑 *BOT OWNER* : Vishmitha\n\n📞 *WhatsApp* : +94 784291630`
                }, { quoted: msg });
            } 
            // ALIVE
            else if (cmd.includes('alive')) {
                await sock.sendMessage(from, { react: { text: '🟢', key: msg.key } });
                await sock.sendMessage(from, {
                    text: `🟢 *MV BOT IS ONLINE*\n\n⚡ Status : Active\n🚀 Version : 1.2\n👑 Owner : MV PRODUCTION`
                }, { quoted: msg });
            }
            // JOKE
            else if (cmd.includes('joke')) {
                await sock.sendMessage(from, { react: { text: '😂', key: msg.key } });

                const jokes = [
                    "😂 අම්මා: පුතා පාඩම් කළාද?\nපුතා: ඔව් අම්මේ.\nඅම්මා: මොනවද ඉගෙනගත්තේ?\nපුතා: හෙට exam එකේ ප්රශ්න බලලා කියන්නම් 😅",
                    "🤣 සර්: ඇයි homework කරගෙන ආවේ නැත්තේ?\nළමයා: Sir, homework එකටත් home එකේ ඉන්න ඕනනේ!",
                    "😂 යාලුවා: උඹට swimming පුළුවන්ද?\nමම: ඔව්.\nයාලුවා: කොහොමද ඉගෙනගත්තේ?\nමම: WiFi password එක වැටිලා ගන්න ගිහින් 😅",
                    "🤣 අම්මා: කාමරේ අස් කළාද?\nපුතා: ඔව්.\nඅම්මා: එහෙනම් මේ බඩු ඔක්කොම කොහෙද?\nපුතා: ඇඳ යට 😎",
                    "😂 ගුරුවරයා: පෘථිවිය වටේ යන්න කොච්චර කාලයක් යනවද?\nසිසුවා: Sir, මම යන්නෙ නෑ 😅",
                    "🤣 ඩොක්ටර්: විවේක ගන්න.\nමම: හරි.\nඩොක්ටර්: Phone එක අඩුවෙන් පාවිච්චි කරන්න.\nමම: වෙන ඩොක්ටර් කෙනෙක් හම්බෙන්නම් 😭",
                    "😂 තාත්තා: ඇයි exam fail වුණේ?\nපුතා: Paper එක අමාරුයි.\nතාත්තා: අනිත් අය pass නේ.\nපුතා: ඒ අයගේ paper ලේසි ඇති 😅",
                    "🤣 Teacher: 5+5=?\nStudent: 10.\nTeacher: Very good.\nStudent: Google ට ස්තුතියි 😎",
                    "😂 Physics පාඩම් කරනකොට නින්ද යනවා. නින්ද යනකොට Physics මතක් වෙනවා.",
                    "🤣 Exam එකට සතියයි. පොත ඇරලා බැලුවා. පොතත් මාව බලලා වහගත්තා.",
                    "😂 Teacher: Homework කොහෙද?\nStudent: Sir, homework එකට freedom දෙන්න ඕන.",
                    "🤣 Chemistry practical එකේ result එක හරි ආවා. Sir ටත් සැක හිතුනා.",
                    "😂 Maths paper එක දැක්කම මටත් paper එකටත් එකම ප්රශ්නයක් තිබ්බා.",
                    "🤣 Biology පොත අරිනකොටම මගේ ශක්තිය ATP වගේ ඉවරයි.",
                    "😂 Exam hall එකට යද්දි confidence 100%.\nPaper එක බලද්දි battery low 1%.",
                    "🤣 Sir: තේරුණාද?\nClass එක: ඔව් Sir.\nඇත්තටම: නෑ Sir.",
                    "😂 Tuition යන්නේ දැනුම ගන්න.\nගෙදර එන්නේ sleep mode එකෙන්.",
                    "🤣 Physics වල friction නැත්තම් අපි ඔක්කොම pass වෙලා.",
                    "😂 Paper එකේ answer එක මතක නෑ.\nQuestion එකත් මතක නෑ.",
                    "🤣 AL student kෙනෙක්ගේ hobby එක:\nTimetable හදන එක.",
                    "😂 Timetable එක හදන වෙලාවට rank 1.\nඊට පස්සේ timetable එක නැතිවෙලා.",
                    "🤣 Exam ඉවර වෙලා answer check කරන එක තමයි ලොකුම mistake එක.",
                    "😂 Teacher: නිශ්ශබ්ද වෙන්න.\nClass: *5 seconds later*\nMarket එකක්.",
                    "🤣 Physics numericals දැක්කම calculator එකත් බය වෙනවා.",
                    "😂 Mama: අද පාඩම් කරනවා.\nPhone eka: Are you sure?",
                    "🤣 Tuition යන්න කලින් motivation.\nTuition ඉවර වෙද්දි meditation.",
                    "😂 AL කරනවා කියන්නේ stress එකට degree එකක් ගන්නවා වගේ.",
                    "🤣 Paper එක ලියලා ඉවර වෙද්දි Einstein වගේ.\nResults එද්දි regret.",
                    "😂 Sir: Simple question එකක්.\nStudent: Sir, simple කාටද?",
                    "🤣 Revision plan එක හදනවා.\nRevision නම් නෑ.",
                    "😂 Online class එකේ camera off කරලා Nobel Prize level sleep එකක්.",
                    "🤣 Exam එකට කලින්:\nමට පුළුවන්.\nExam එක අතරේ:\nමට යන්න ඕන.",
                    "😂 Result එනකම් හැමෝම scientist.\nResult ආවම philosopher."
                ];

                const joke = jokes[Math.floor(Math.random() * jokes.length)];
                await sock.sendMessage(from, { text: joke }, { quoted: msg });
            }
            // MENU
            else if (cmd === 'menu') {
                await sock.sendMessage(from, { react: { text: '📋', key: msg.key } });
                await sendMenu(from, msg);
            }
            // INSTAGRAM PROFILE SEARCH
            else if (cmd.startsWith('ig ') || cmd === 'ig') {
                await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });
                const query = text.slice(3).trim();

                if (!query) {
                    return await sock.sendMessage(from, { text: '❌ කරුණාකර සෙවිය යුතු නම හෝ username එක ලබා දෙන්න. (උදා: ig travel)' }, { quoted: msg });
                }

                await sock.sendMessage(from, { text: `🔍 Instagram හි *"${query}"* සොයමින් පවතී. කරුණාකර රැඳී සිටින්න...` }, { quoted: msg });

                try {
                    const profiles = await searchInstagramProfiles(query);
                    if (profiles.length === 0) {
                        return await sock.sendMessage(from, { text: '❌ කිසිදු Instagram Profile එකක් හමු නොවුණි.' }, { quoted: msg });
                    }

                    let responseText = `🔍 *Instagram Search Results for: ${query}*\n\n`;
                    profiles.forEach((profile, index) => {
                        responseText += `${index + 1}️⃣ *Name:* ${profile.title}\n`;
                        responseText += `   🔗 *Link:* ${profile.url}\n`;
                        responseText += `   📝 *Bio:* ${profile.snippet}\n\n`;
                    });

                    responseText += `💡 *Tip:* වීඩියෝවක් ඩවුන්ලෝඩ් කිරීමට Reel/Video Link එක කෙලින්ම chat එකට එවන්න.`;

                    await sock.sendMessage(from, { text: responseText }, { quoted: msg });
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                } catch (err) {
                    console.log("Instagram Command Error:", err);
                    await sock.sendMessage(from, { text: `❌ සෙවීම අසාර්ථක විය. (Error: ${err.message})` }, { quoted: msg });
                }
            }
            // SONG
            else if (cmd.startsWith('song ') || cmd.startsWith('video ')) {
                const reactEmoji = cmd.startsWith('song ') ? '🎧' : '📽️';
                await sock.sendMessage(from, { react: { text: reactEmoji, key: msg.key } });
                const query = text.slice(5).trim();

                if (!query) {
                    return await sock.sendMessage(from, { text: 'සින්දුවේ නමක් දෙන්න!' }, { quoted: msg });
                }

                await sock.sendMessage(from, { react: { text: reactEmoji, key: msg.key } });
                await sock.sendMessage(from, { text: '🔍 YouTube search කරමින්...' }, { quoted: msg });

                try {
                    const result = await ytSearch.GetListByKeyword(query, false, 1);
                    if (!result.items || result.items.length === 0) {
                        return await sock.sendMessage(from, { text: '❌ Video එකක් හමු නොවුණි.' }, { quoted: msg });
                    }

                    const video = result.items[0];
                    const videoLink = `https://www.youtube.com/watch?v=${video.id}`;
                    const thumbnail = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;

                    await sock.sendMessage(from, {
                        image: { url: thumbnail },
                        caption: `🎥 *${video.title}*\n\n🔗 ${videoLink}\n\n📥 *Download Options:*\n🎵 *MP3 (Audio):* Reply with *.mp3* or type *.mp3 <link>*\n🎬 *MP4 (Video):* Reply with *.mp4* or type *.mp4 <link>*`
                    }, { quoted: msg });

                } catch (err) {
                    console.log(err);
                    await sock.sendMessage(from, { text: '❌ Search error.' }, { quoted: msg });
                }
            }
   // MP3 DOWNLOADER
            else if (cmd.startsWith('.mp3') || cmd.startsWith('mp3')) {
                let url = extractYoutubeUrl(text);
                
                // 2. If no URL in command, check if message is a reply
                if (!url && msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    const quotedText = msg.message.extendedTextMessage.contextInfo.quotedMessage.conversation ||
                                       msg.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text ||
                                       msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage?.caption ||
                                       '';
                    url = extractYoutubeUrl(quotedText);
                }

                if (!url) {
                    return await sock.sendMessage(from, { text: '❌ කරුණාකර YouTube Link එකක් ලබා දෙන්න. (උදා: .mp3 <link> හෝ සින්දුවට reply කරන්න)' }, { quoted: msg });
                }

                await sock.sendMessage(from, { react: { text: '📥', key: msg.key } });
                await sock.sendMessage(from, { text: '⏳ MP3 audio එක download වෙමින් පවතී. කරුණාකර රැඳී සිටින්න...' }, { quoted: msg });

                const tempDir = path.join(__dirname, 'temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir);
                }

                let tempFilePath = '';
                const uniqueId = Date.now();
                try {
                    // Resolve redirect if any
                    url = await resolveRedirectUrl(url);

                    const title = await fetchVideoTitle(url);
                    const outputPattern = path.join(tempDir, `audio_${uniqueId}.%(ext)s`);
                    
                    let refererFlag = '';
                    const referer = getReferer(url);
                    if (referer) {
                        refererFlag = `--referer "${referer}"`;
                    }

                    // Download best audio format (prefers m4a to avoid needing ffmpeg to convert webm to mp3/m4a if not installed)
                    const command = `yt-dlp --js-runtimes node -f "ba[ext=m4a]/ba" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" ${refererFlag} -o "${outputPattern}" "${url}"`;
                    await execPromise(command);

                    // Find the downloaded file
                    const files = fs.readdirSync(tempDir);
                    const downloadedFile = files.find(f => f.startsWith(`audio_${uniqueId}.`));
                    if (!downloadedFile) {
                        throw new Error("Downloaded audio file not found");
                    }
                    
                    tempFilePath = path.join(tempDir, downloadedFile);

                    // Check file size limit (15MB for MP3)
                    const fileStats = fs.statSync(tempFilePath);
                    if (fileStats.size > 15 * 1024 * 1024) {
                        throw new Error("max-filesize");
                    }

                    // Send downloaded audio file with mp3 filename for compatibility
                    await sock.sendMessage(from, {
                        document: { url: tempFilePath },
                        mimetype: 'audio/mpeg',
                        fileName: `${title}.mp3`
                    }, { quoted: msg });

                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                } catch (err) {
                    console.log('MP3 Downloader Error:', err);
                    let errMsg = err.message;
                    if (errMsg.includes('not found') || errMsg.includes('127') || errMsg.includes('ENOENT')) {
                        errMsg = "yt-dlp command එක Termux එකේ ස්ථාපනය කර නැත.\n\nකරුණාකර Termux එකට ගොස් පහත command එක run කරන්න:\n`pkg install python ffmpeg -y && pip install yt-dlp`";
                    } else if (errMsg.includes('max-filesize')) {
                        errMsg = "ඕඩියෝ ගොනුව WhatsApp limit එකට වඩා විශාල වැඩිය. (Max size: 15MB)";
                    } else {
                        errMsg = `MP3 download කිරීම අසාර්ථක විය. (Error: ${err.message})`;
                    }
                    await sock.sendMessage(from, { text: `❌ ${errMsg}` }, { quoted: msg });
                } finally {
                    if (tempFilePath && fs.existsSync(tempFilePath)) {
                        try { fs.unlinkSync(tempFilePath); } catch (e) {}
                    }
                }
            }
            // MP4 DOWNLOADER
            else if (cmd.startsWith('.mp4') || cmd.startsWith('mp4')) {
                let url = extractYoutubeUrl(text);
                
                // 2. If no URL in command, check if message is a reply
                if (!url && msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    const quotedText = msg.message.extendedTextMessage.contextInfo.quotedMessage.conversation ||
                                       msg.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text ||
                                       msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage?.caption ||
                                       '';
                    url = extractYoutubeUrl(quotedText);
                }

                if (!url) {
                    return await sock.sendMessage(from, { text: '❌ කරුණාකර YouTube Link එකක් ලබා දෙන්න. (උදා: .mp4 <link> හෝ සින්දුවට reply කරන්න)' }, { quoted: msg });
                }

                await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });
                
                try {
                    const details = await fetchVideoDetails(url);
                    
                    const textContent = `───━━━━─●●●●●─━━━━───
🎬 *YOUTUBE VIDEO READY!*
✨ *MV BOT prepared your video* ✨
───━━━━─●●●●●─━━━━───

📌 *Title:*
▶️ ${details.title.replace(/-/g, ' ')}

👤 *Uploader:* ${details.uploader}
⏱️ *Duration:* ${details.duration}
━━━━━━━━━━━━━━━━━━

📥 *Choose Quality:*

❶ 360p Fast
❷ 480p SD
❸ 720p HD
❹ 1080p Full HD

💬 *Reply:* 1 / 2 / 3 / 4`;

                    const promptMsg = await sock.sendMessage(from, { text: textContent }, { quoted: msg });
                    const promptMsgId = promptMsg.key.id;

                    // Save to pending downloads using the prompt message ID
                    pendingVideoDownloads[promptMsgId] = {
                        url: url,
                        title: details.title,
                        uploader: details.uploader,
                        duration: details.duration,
                        timestamp: Date.now()
                    };

                } catch (err) {
                    console.log('MP4 Trigger Error:', err);
                    let errMsg = err.message;
                    if (errMsg.includes('not found') || errMsg.includes('127') || errMsg.includes('ENOENT')) {
                        errMsg = "yt-dlp command එක Termux එකේ ස්ථාපනය කර නැත.\n\nකරුණාකර Termux එකට ගොස් පහත command එක run කරන්න:\n`pkg install python ffmpeg -y && pip install yt-dlp`";
                    } else {
                        errMsg = `වීඩියෝ තොරතුරු ලබා ගැනීමට නොහැකි විය. (Error: ${err.message})`;
                    }
                    await sock.sendMessage(from, { text: `❌ ${errMsg}` }, { quoted: msg });
                }
            }
            // CHATBOT / GEMINI AI TRIGGER
            // Runs either if it starts with "ai " OR if autoAI is active and it is NOT one of the static command words
            else if (cmd.startsWith('ai ') || (autoAIActive && !isCommand)) {
                
                let prompt = text;
                if (cmd.startsWith('ai ')) {
                    prompt = text.slice(3).trim();
                }

                if (!prompt) {
                    return await sock.sendMessage(
                        from,
                        {
                            text: '🤖 ප්රශ්නයක් අහන්න.\n\nඋදා: ai ලංකාවේ අගනුවර මොකක්ද?'
                        },
                        { quoted: msg }
                    );
                }

                await sock.sendMessage(from, {
                    react: {
                        text: '🤖',
                        key: msg.key
                    }
                });

                try {
                    // Fetch message history for context-aware responses
                    const history = getChatHistory(from);
                    let response = "";
                    let attempts = 0;
                    const maxAttempts = Math.max(1, apiKeys.length);

                    while (attempts < maxAttempts) {
                        try {
                            const userName = msg.pushName || 'User';
                            const model = getModelInstance(userName);
                            const chatSession = model.startChat({
                                history: history
                            });

                            // Call the API
                            const result = await chatSession.sendMessage(prompt);
                            response = result.response.text();
                            break; // Success! Exit loop.
                        } catch (err) {
                            console.log(`Gemini API Error with key index ${currentKeyIndex}:`, err.message);
                            
                            // Rotate to next key if it's a rate limit or quota error
                            if (apiKeys.length > 1 && (err.status === 429 || err.message.includes("quota") || err.message.includes("429") || err.message.includes("limit"))) {
                                currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                                console.log(`🔄 Quota exceeded. Rotating to API Key index ${currentKeyIndex}...`);
                                attempts++;
                            } else {
                                throw err; // Re-throw other errors (e.g. 401, 404, etc.)
                            }
                        }
                    }

                    if (!response) {
                        throw new Error("All API keys are currently busy or exceeded quota.");
                    }

                    // Update history context
                    addToHistory(from, "user", prompt);
                    addToHistory(from, "model", response);

                    await sock.sendMessage(
                        from,
                        {
                            text: `🤖 *AI Response*\n\n${response}`
                        },
                        { quoted: msg }
                    );

                } catch (err) {
                    console.log("Gemini AI Final Error: ", err);

                    await sock.sendMessage(
                        from,
                        {
                            text: "⚠️ AI server එක busy. ටික වෙලාවකින් නැවත උත්සාහ කරන්න."
                        },
                        { quoted: msg }
                    );
                }
            }

        } catch (err) {
            console.log('General Message Error:', err);
        }
    });
}

startBot();

// Tiny HTTP server to satisfy Hugging Face/Koyeb/Render port health checks
const http = require('http');
const port = process.env.PORT || 7860;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MV Bot is running successfully!\n');
});
server.listen(port, '0.0.0.0', () => {
    console.log(`📡 HTTP Health check server listening on port ${port}`);
});
