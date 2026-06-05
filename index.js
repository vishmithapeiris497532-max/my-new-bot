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

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const ytSearch = require('youtube-search-api');

// AI Conversation History store (tracks messages in memory per user)
const chatHistories = {};

// Store pending video downloads for quality selection (maps from JID -> { url, title, timestamp })
const pendingVideoDownloads = {};

// Setting to toggle Auto AI replies in private messages (on by default)
let autoAIActive = true;

// Store the bot start time to ignore offline messages
const botStartTime = Math.floor(Date.now() / 1000);

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

async function startBot() {

    const { state, saveCreds } =
        await useMultiFileAuthState('./baileys_auth');

    // Automatically fetch the latest WhatsApp Web version to prevent 405 Connection Failure
    let version = [2, 3000, 1017578278]; // Default fallback version
    try {
        const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
        console.log(`🤖 Using WA version v${latestVersion.join('.')}, isLatest: ${isLatest}`);
        version = latestVersion;
    } catch (err) {
        console.log("⚠️ Error fetching latest WhatsApp version, using fallback:", err.message);
    }

    const sock = makeWASocket({
        auth: state,
        version: version,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ Bot Connected Successfully!');
        }

        if (connection === 'close') {
            console.log('Connection closed:', lastDisconnect?.error);

            if (
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut
            ) {
                console.log('🔄 Reconnecting...');
                setTimeout(startBot, 5000);
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

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];

            if (!msg.message || (msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast')) return;

            // Ignore messages sent when the bot was offline (before bot start time)
            const messageTimestamp = msg.messageTimestamp?.low || msg.messageTimestamp || 0;
            if (messageTimestamp && messageTimestamp < botStartTime) {
                return;
            }
           
            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                '';

            const cmd = text.trim().toLowerCase();

            // AUTO STATUS VIEW & REACT
            if (msg.key.remoteJid === 'status@broadcast') {
                try {
                    // Mark the status as read/viewed for ourselves
                    await sock.readMessages([msg.key]);

                    // Force send a 'read' receipt to the sender (so they see we viewed it - reach/views)
                    if (!msg.key.fromMe && msg.key.participant) {
                        await sock.sendReceipt('status@broadcast', msg.key.participant, [msg.key.id], 'read');
                    }
                    
                    const sender = msg.key.participant || msg.key.remoteJid;
                    console.log(`👀 Status viewed automatically from: ${sender.split('@')[0]}`);

                    // Only react if the status was posted by someone else (not fromMe)
                    if (!msg.key.fromMe) {
                        const myJid = jidNormalizedUser(sock.user?.id || sock.user?.jid || '');
                        await sock.sendMessage(
                            'status@broadcast',
                            {
                                react: {
                                    text: '🔥',
                                    key: msg.key
                                }
                            },
                            {
                                statusJidList: [msg.key.participant, myJid]
                            }
                        );
                        console.log(`🔥 Reacted to status from: ${sender.split('@')[0]}`);
                    }
                } catch (err) {
                    console.log('Error handling status:', err);
                }
                return;
            }

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
                        const url = pending.url;
                        const outputPattern = path.join(tempDir, `video_${uniqueId}.%(ext)s`);
                        
                        const command = `yt-dlp --js-runtimes node -f "best[height<=${height}][ext=mp4]/best[ext=mp4]/best" --max-filesize 50M -o "${outputPattern}" "${url}"`;
                        await execPromise(command);

                        const files = fs.readdirSync(tempDir);
                        const downloadedFile = files.find(f => f.startsWith(`video_${uniqueId}.`));
                        if (!downloadedFile) {
                            throw new Error("Downloaded video file not found");
                        }
                        
                        tempFilePath = path.join(tempDir, downloadedFile);

                        await sock.sendMessage(from, {
                            video: { url: tempFilePath },
                            caption: `🎥 *${title.replace(/-/g, ' ')}* (${height}p)`,
                            mimetype: 'video/mp4'
                        }, { quoted: msg });

                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                    } catch (err) {
                        console.log('MP4 Downloader Error:', err);
                        let errMsg = err.message;
                        if (errMsg.includes('not found') || errMsg.includes('127') || errMsg.includes('ENOENT')) {
                            errMsg = "yt-dlp command එක Termux එකේ ස්ථාපනය කර නැත.\n\nකරුණාකර Termux එකට ගොස් පහත command එක run කරන්න:\n`pkg install python ffmpeg -y && pip install yt-dlp`";
                        } else {
                            errMsg = `MP4 download කිරීම අසාර්ථක විය. (Error: ${err.message})`;
                        }
                        await sock.sendMessage(from, { text: `❌ ${errMsg}` }, { quoted: msg });
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
            const commands = ['hi', 'hello', 'hey', 'kohomada', 'කොහොමද', 'mama hodin', 'මම හොඳින්', 'මමත් හොඳින්', 'මමත් හොදින්', 'love you', 'i love you', 'ආදරෙයි', 'good morning', 'සුභ උදෑසනක්', 'gm', 'thanks', 'thank you', 'ස්තුතියි', 'bye', 'good bye', 'ගිහින් එන්නම්', 'good night', 'සුභ රාත්රියක්', 'gn', 'gn bs', 'ping', 'owner', 'alive', 'joke', 'menu', 'song ', 'autoai', '.mp3', '.mp4', 'mp3', 'mp4'];
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
                await sock.sendMessage(from, { text: '👋💖*පරිස්සමෙන් යන්න*!\n\n☸️*තෙරුවන් සරණයි*!\n\n✝️*ජේසු පිහිටයි*' }, { quoted: msg });
            }
            // GOOD NIGHT
            else if (cmd.includes('good night') || cmd.includes('සුභ රාත්රියක්') || cmd.includes('gn') || cmd.includes('gn bs')) {
                await sock.sendMessage(from, { react: { text: '🌙', key: msg.key } });
                await sock.sendMessage(from, { text: '😴💖*සුභ රාත්රියක්*!\n\n☸️*තෙරුවන් සරණයි*!\n\n✝️*ජේසු පිහිටයි*!' }, { quoted: msg });
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

👥 Group Features
➤ Auto Welcome 👋

━━━━━━━━━━━━━━━━━━
👑 Owner : MV PRODUCTION
📱 WhatsApp : +94 784291630
🚀 Version : 1.2
🟢 Status : Online
━━━━━━━━━━━━━━━━━━

🔥 Fast Replies
❤️ Status React
🎵 YouTube Search
👋 Group Welcome
🧠 Smart Gemini AI Chatbot

▄︻デ══━一💥`
                }, { quoted: msg });
            }
            // SONG
            else if (cmd.startsWith('song ')) {
                const query = text.slice(5).trim();

                if (!query) {
                    return await sock.sendMessage(from, { text: 'සින්දුවේ නමක් දෙන්න!' }, { quoted: msg });
                }

                await sock.sendMessage(from, { react: { text: '🎧', key: msg.key } });
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
                    const title = await fetchVideoTitle(url);
                    const outputPattern = path.join(tempDir, `audio_${uniqueId}.%(ext)s`);
                    
                    // Download best audio format (prefers m4a to avoid needing ffmpeg to convert webm to mp3/m4a if not installed)
                    const command = `yt-dlp --js-runtimes node -f "ba[ext=m4a]/ba" --max-filesize 15M -o "${outputPattern}" "${url}"`;
                    await execPromise(command);

                    // Find the downloaded file
                    const files = fs.readdirSync(tempDir);
                    const downloadedFile = files.find(f => f.startsWith(`audio_${uniqueId}.`));
                    if (!downloadedFile) {
                        throw new Error("Downloaded audio file not found");
                    }
                    
                    tempFilePath = path.join(tempDir, downloadedFile);

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
