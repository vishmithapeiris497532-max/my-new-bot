const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

async function run() {
  try {
    const apiKeys = (process.env.GEMINI_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
    const key = apiKeys[0] || "YOUR_API_KEY_HERE";
    const genAI = new GoogleGenerativeAI(key);
    console.log("Testing generation for listed model names:");
    const testModels = [
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-2.5-flash",
      "gemini-3.5-flash",
      "gemini-pro-latest"
    ];
    for (const modelName of testModels) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const res = await model.generateContent("Hi");
        console.log(`✅ Model ${modelName} is working! Response: ${res.response.text().trim()}`);
      } catch (e) {
        console.log(`❌ Model ${modelName} failed: ${e.message}`);
      }
    }
  } catch (err) {
    console.error("General error:", err);
  }
}

run();
