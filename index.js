const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Helper to extract YouTube URL from text
function extractYoutubeUrl(text) {
    if (!text) return null;
    const match = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?youtu(?:be\.com|\.be)\/[^\s]+/);
    return match ? match[0] : null;
}

// Helper to fetch title using yt-dlp
async function fetchVideoTitle(url) {
    try {
        const { stdout } = await execPromise(`yt-dlp --js-runtimes node --get-title "${url}"`);
        return stdout.trim().replace(/[/\\?%*:|"<>]/g, '-'); // Sanitize filename characters
    } catch (err) {
        console.log("Error fetching title with yt-dlp:", err);
        return "downloaded_media";
    }
}

// Helper to extract Facebook, TikTok, and Instagram URLs from text
function extractSocialUrl(text) {
    if (!text) return null;
    
    const fbMatch = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?facebook\.com\/(?:[^\s\/]+\/videos\/|video\.php\?v=)[^\s]+|https?:\/\/(?:[a-zA-Z0-9-]+\.)?fb\.watch\/[^\s]+/i);
    if (fbMatch) return { type: 'facebook', url: fbMatch[0] };
    
    const tiktokMatch = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?tiktok\.com\/@[^\s\/]+\/video\/\d+|https?:\/\/(?:[a-zA-Z0-9-]+\.)?vm\.tiktok\.com\/[^\s\/]+|https?:\/\/(?:[a-zA-Z0-9-]+\.)?vt\.tiktok\.com\/[^\s\/]+/i);
    if (tiktokMatch) return { type: 'tiktok', url: tiktokMatch[0] };
    
    const igMatch = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?instagram\.com\/(?:p|reel|tv)\/[^\s\/]+/i);
    if (igMatch) return { type: 'instagram', url: igMatch[0] };
    
    return null;
}

// Helper to resolve redirect URLs (e.g. short links like vm.tiktok.com, fb.watch, etc.)
async function resolveRedirectUrl(url) {
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            redirect: 'follow'
        });
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
        const response = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
        const result = await response.json();
        if (result.code === 0 && result.data && result.data.play) {
            const videoUrl = result.data.play;
            const videoResponse = await fetch(videoUrl);
            const arrayBuffer = await videoResponse.arrayBuffer();
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
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
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

function getModelInstance() {
    const key = apiKeys[currentKeyIndex] || "YOUR_GEMINI_API_KEY_HERE";
    const genAI = new GoogleGenerativeAI(key);
    return genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: `You are MV BOT, a friendly, smart, and helpful WhatsApp AI bot created by Vishmitha. 
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

let sock = null;
let isReconnecting = false;

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
    try {
        const authResult = await useMultiFileAuthState('./baileys_auth');
        state = authResult.state;
        saveCreds = authResult.saveCreds;
    } catch (err) {
        console.log('⚠️ Error loading auth session (files might be corrupted):', err.message);
        console.log('Deleting baileys_auth folder and starting fresh...');
        try {
            fs.rmSync('./baileys_auth', { recursive: true, force: true });
        } catch (e) {}
        setTimeout(startBot, 5000);
        return;
    }

    // Automatically fetch the latest WhatsApp Web version to prevent 405 Connection Failure
    let version = [2, 3000, 1017578278]; // Default fallback version
    try {
        const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
        console.log(`🤖 Using WA version v${latestVersion.join('.')}, isLatest: ${isLatest}`);
        version = latestVersion;
    } catch (err) {
        console.log("⚠️ Error fetching latest WhatsApp version, using fallback:", err.message);
    }

    sock = makeWASocket({
        auth: state,
        version: version,
        logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000,          // Send a ping every 30 seconds
        defaultQueryTimeoutMs: 60000,        // Timeout queries in 60 seconds
        connectTimeoutMs: 60000             // Connection timeout in 60 seconds
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            qrcode.generate(qr, { small: true });
            console.log('📷 Scan the QR code above to link your bot.');
        }

        if (connection === 'open') {
            console.log('✅ Bot Connected Successfully!');
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

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                if (!isReconnecting) {
                    isReconnecting = true;
                    console.log('🔄 Reconnecting in 5 seconds...');
                    setTimeout(async () => {
                        isReconnecting = false;
                        await startBot();
                    }, 5000);
                } else {
                    console.log('ℹ️ Reconnection already scheduled, ignoring duplicate close event.');
                }
            } else {
                console.log('❌ Bot logged out. Clearing session and restarting to generate new QR...');
                try {
                    fs.rmSync('./baileys_auth', { recursive: true, force: true });
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

            console.log(`[Message Upsert] Event triggered! ID: ${msg?.key?.id} | remoteJid: ${msg?.key?.remoteJid} | fromMe: ${msg?.key?.fromMe}`);

            if (msg.key.fromMe) return;

            // Ignore protocol messages (like message revokes/deletions, edits, etc.) and sender keys
            if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return;
           
            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                '';

            // Log incoming messages for debugging
            console.log(`✉️ Message received from: ${from.split('@')[0]} | Text: "${text}"`);

            // CHECK FOR AUTO-DOWNLOAD OF FACEBOOK, TIKTOK, AND INSTAGRAM LINKS
            const socialMediaMatch = extractSocialUrl(text);
            if (socialMediaMatch) {
                const { type, url } = socialMediaMatch;
                const platformName = type.charAt(0).toUpperCase() + type.slice(1);
                
                await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });
                
                // Save to pending downloads
                pendingVideoDownloads[from] = {
                    url: url,
                    title: `${platformName} Video`,
                    isSocial: true,
                    platform: platformName,
                    timestamp: Date.now()
                };

                await sock.sendMessage(from, {
                    text: `🎬 *Choose Video Quality*\n\n🎥 *Source:* ${platformName}\n\n1️⃣ *360p* (Low Quality / Very Fast)\n2️⃣ *480p* (Medium Quality / Fast)\n3️⃣ *720p* (High Quality / Normal)\n\nමෙම message එකට *1*, *2* හෝ *3* ලෙස reply (Quote) කරන්න.`
                }, { quoted: msg });
                return;
            }

            const cmd = text.trim().toLowerCase();
            // CHECK FOR VIDEO QUALITY CHOICE MENU REPLY
            const isReply = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const quotedText = isReply ? (msg.message.extendedTextMessage.contextInfo.quotedMessage.conversation || 
                                          msg.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text || 
                                          msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage?.caption || 
                                          '') : '';

            if (isReply && quotedText.includes('Choose Video Quality') && pendingVideoDownloads[from]) {
                const match = cmd.match(/[123]/);
                if (match) {
                    const choice = match[0];
                    const pending = pendingVideoDownloads[from];
                    delete pendingVideoDownloads[from]; // Clear pending item
                    
                    let height = 360;
                    let label = '360p (Low Quality)';
                    if (choice === '2') {
                        height = 480;
                        label = '480p (Medium Quality)';
                    } else if (choice === '3') {
                        height = 720;
                        label = '720p (High Quality)';
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

                            const command = `yt-dlp --js-runtimes node -f "best[height<=${height}][ext=mp4]/best[ext=mp4]/best" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" ${refererFlag} -o "${outputPattern}" "${url}"`;
                            await execPromise(command);

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
            const commands = ['hi', 'hello', 'hey', 'kohomada', 'කොහොමද', 'mama hodin', 'මම හොඳින්', 'මමත් හොඳින්', 'මමත් හොදින්', 'love you', 'i love you', 'ආදරෙයි', 'good morning', 'සුභ උදෑසනක්', 'gm', 'thanks', 'thank you', 'ස්තුතියි', 'bye', 'good bye', 'ගිහින් එන්නම්', 'good night', 'සුභ රාත්රියක්', 'gn', 'gn bs', 'ping', 'owner', 'alive', 'joke', 'menu', 'song ', 'autoai', '.mp3', '.mp4', 'mp3', 'mp4', 'ig ', 'ig'];
            const isCommand = commands.some(c => cmd.startsWith(c));

            // HI
            if (cmd.includes('hi') || cmd.includes('hello') || cmd.includes('hey')) {
                await sock.sendMessage(from, { react: { text: '🤗', key: msg.key } });
                await sock.sendMessage(from, { text: 'හලෝ! 👋' }, { quoted: msg });
            }
            // KOHOMADA
            else if (cmd.includes('kohomada') || cmd.includes('කොහොමද')) {
                await sock.sendMessage(from, { react: { text: '🫣', key: msg.key } });
                await sock.sendMessage(from, { text: 'මම හොදින් ඔයාට කොහොමද!🤭' }, { quoted: msg });
            }
            // MAMA HODIN
            else if (cmd.includes('mama hodin') || cmd.includes('මම හොඳින්') || cmd.includes('මමත් හොඳින්') || cmd.includes('මමත් හොදින්')) {
                await sock.sendMessage(from, { react: { text: '😊', key: msg.key } });
                await sock.sendMessage(from, { text: 'සුපිරි...💪' }, { quoted: msg });
            }
            // LOVE YOU
            else if (cmd.includes('love you') || cmd.includes('i love you') || cmd.includes('ආදරෙයි')) {
                await sock.sendMessage(from, { react: { text: '💖', key: msg.key } });
                await sock.sendMessage(from, { text: 'Love YOU to🥹💖!' }, { quoted: msg });
            }         
            // GOOD MORNING
            else if (cmd.includes('good morning') || cmd.includes('සුභ උදෑසනක්') || cmd.includes('gm')) {
                await sock.sendMessage(from, { react: { text: '🥱', key: msg.key } });
                await sock.sendMessage(from, { text: '☀️🥰*සුභ උදෑසනක්*!' }, { quoted: msg });
            }
            // THANKS
            else if (cmd.includes('thanks') || cmd.includes('thank you') || cmd.includes('ස්තුතියි')) {
                await sock.sendMessage(from, { react: { text: '🫀', key: msg.key } });
                await sock.sendMessage(from, { text: '😊 Welcome!' }, { quoted: msg });
            }
            // BYE
            else if (cmd.includes('bye') || cmd.includes('good bye') || cmd.includes('ගිහින් එන්නම්')) {
                await sock.sendMessage(from, { react: { text: '👋', key: msg.key } });
                await sock.sendMessage(from, { text: '👋💖*පරිස්සමෙන් යන්න*!\n\n☸️*තෙරුවන් සරණයි*!\n\n✝️*ජේසු පිහිටයි*' }, { quoted: msg });
            }
            // GOOD NIGHT
            else if (cmd.includes('good night') || cmd.includes('සුභ රාත්‍රියක්') || cmd.includes('gn') || cmd.includes('gn bs')) {
                await sock.sendMessage(from, { react: { text: '🌙', key: msg.key } });
                await sock.sendMessage(from, { text: '😴💖*සුභ රාත්‍රියක්*!\n\n☸️*තෙරුවන් සරණයි*!\n\n✝️*ජේසු පිහිටයි*!' }, { quoted: msg });
            }
            // PING
            else if (cmd.includes('ping')) { 
                await sock.sendMessage(from, { react: { text: '🏓', key: msg.key } });
                await sock.sendMessage(from, { text: 'pong 🏓' }, { quoted: msg });
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
                    text: `🟢 *MV BOT IS ONLINE*\n\n⚡ Status : Active\n🚀 Version : 1.2\n👑 Owner : Vishmitha`
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
                await sock.sendMessage(from, {
                    text:
`╔════════════════════╗
            🤖 MV BOT 0.V4M2
╚════════════════════╝

👋 General Commands
➤ Hi / Hello / Hey
➤ Kohomada (කොහොමද)
➤ Mama Hodin (මම හොඳින්)
➤ Love you / ආදරෙයි
➤ Good morning / GM
➤ Good night / GN
➤ Thank you / ස්තුතියි
➤ Bye / ගිහින් එන්නම්

😂 Fun Commands
➤ Joke

⚡ Utility Commands
➤ Ping
➤ Menu
➤ Owner
➤ Alive

🤖 AI Chatbot Features
➤ ai <ප්‍රශ්නය> (Ask Gemini AI)
➤ autoai on (Enable Auto-AI in DMs)
➤ autoai off (Disable Auto-AI in DMs)

🎵 YouTube Search
➤ Song <song name>
➤ Video <video name>

📥 Social Downloaders (Auto-Download)
➤ Facebook Video Link
➤ TikTok Video Link
➤ Instagram Reel Link

🔍 Instagram Search
➤ ig <username/name>

👥 Group Features
➤ Auto Welcome 👋

━━━━━━━━━━━━━━━━━━
👑 Owner : MV PRODUCTION
📱 WhatsApp : +94 784291630
🚀 Version : 1.3
🟢 Status : Online
━━━━━━━━━━━━━━━━━━

🔥 Fast Replies
❤️ Status React
🎵 Media Downloaders
🔍 Profile Search
🧠 Smart Gemini AI Chatbot

▄︻デ══━一💥`
                }, { quoted: msg });
            }
            // INSTAGRAM PROFILE SEARCH
            else if (cmd.startsWith('ig ') || cmd === 'ig') {
                await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });
                const query = text.slice(3).trim();

                if (!query) {
                    return await sock.sendMessage(from, { text: '❌ කරුණාකර සෙවිය යුතු නම හෝ username එක ලබා දෙන්න. (උදා: ig vishmitha)' }, { quoted: msg });
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
                    const title = await fetchVideoTitle(url);
                    
                    // Save to pending downloads
                    pendingVideoDownloads[from] = {
                        url: url,
                        title: title,
                        timestamp: Date.now()
                    };

                    await sock.sendMessage(from, {
                        text: `🎬 *Choose Video Quality*\n\n🎥 *Title:* ${title.replace(/-/g, ' ')}\n\n1️⃣ *360p* (Low Quality / Very Fast)\n2️⃣ *480p* (Medium Quality / Fast)\n3️⃣ *720p* (High Quality / Normal)\n\nමෙම message එකට *1*, *2* හෝ *3* ලෙස reply (Quote) කරන්න.`
                    }, { quoted: msg });

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
            // Runs either if it starts with "ai " OR if it's a DM (not group), autoAI is active, and it is NOT one of the static command words
            else if (cmd.startsWith('ai ') || (!isGroup && autoAIActive && !isCommand)) {
                
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
                            const model = getModelInstance();
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
