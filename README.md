---
title: MV WhatsApp Bot
emoji: 🤖
colorFrom: pink
colorTo: purple
sdk: docker
app_port: 7860
---

# 🤖 MV BOT with Gemini AI Integration

මේ WhatsApp Bot එකට Gemini AI එක සම්බන්ධ කරලා, Direct Messages (DMs) වලදී auto-reply කරන්න සහ AI chat history එක මතක තබාගෙන පිළිතුරු දෙන්න සකස් කර තිබෙනවා.

---

## 🚀 Features (නව විශේෂාංග)

1. **Smart Conversational AI**:
   - දැන් Bot හට පෙර කතාබහ මතක තබාගෙන පිළිතුරු දිය හැක (Chat History retention).
   - Gemini 2.0 Flash මාදිලිය භාවිතා කරයි.
2. **Auto AI Chatbot in DMs**:
   - Private chat (Direct Messages) වලදී, වෙනත් command එකක් නොවන ඕනෑම මැසේජ් එකකට Gemini AI මගින් ස්වයංක්‍රීයව පිළිතුරු ලබා දේ.
   - Group වලදී, `ai <ප්‍රශ්නය>` ලෙස විමසූ විට පමණක් පිළිතුරු දේ.
3. **Control Commands**:
   - `autoai on` - DMs වලදී Auto-AI සක්‍රීය කිරීමට.
   - `autoai off` - DMs වලදී Auto-AI අක්‍රීය කිරීමට (එවිට AI වැඩ කරන්නේ `ai ` command එකෙන් පමණි).

---

## 🛠️ How to Setup (සකසා ගන්නා ආකාරය)

### 1. Active Workspace එක මාරු කරන්න
මෙම folder එක active workspace එක ලෙස සකසා ගැනීමට, VS Code හෝ Editor එකෙහි **Open Folder** වෙත ගොස් පහත ලිපිනය තෝරන්න:
`C:\Users\User\.gemini\antigravity\scratch\whatsapp-bot`

### 2. Environment Variables සකසන්න
[`.env`](file:///C:/Users/User/.gemini/antigravity/scratch/whatsapp-bot/.env) file එක open කර, එහි `YOUR_GEMINI_API_KEY_HERE` වෙනුවට ඔබේ සැබෑ Gemini API Key එක ඇතුලත් කරන්න:
```env
GEMINI_API_KEY=AIzaSy... ඔබේ API Key එක මෙතැනට දෙන්න
```

### 3. Dependencies Install කරන්න
Terminal එකෙහි පහත විධානය ක්‍රියාත්මක කරන්න:
```bash
npm install
```

### 4. Bot එක Start කරන්න
```bash
npm start
```
Terminal එකෙහි දිස්වන QR code එක ඔබේ WhatsApp App එකෙන් Link Devices හරහා scan කරන්න.
