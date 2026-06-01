// ai.js — Motor de IA com fallback Groq → Gemini
let groq, gemini;

const inicializarClientes = () => {
  if (!groq) {
    const OpenAI = require("openai");
    groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
  }
  if (!gemini) {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: "gemini-1.5-flash" });
  }
};

const chamarIA = async (prompt, tentativa = 0) => {
  inicializarClientes();
  if (tentativa < 2) {
    try {
      console.log(`🤖 Groq (tentativa ${tentativa + 1})...`);
      const res = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 2048 });
      return res.choices[0].message.content;
    } catch (err) {
      const esgotado = err?.status === 429 || (err?.message||"").includes("quota") || (err?.message||"").includes("rate");
      if (esgotado) { console.warn("⚠️ Groq esgotado — Gemini..."); return chamarIA(prompt, 2); }
      if (tentativa === 0) { await new Promise(r => setTimeout(r, 5000)); return chamarIA(prompt, 1); }
      return chamarIA(prompt, 2);
    }
  }
  try {
    console.log(`🤖 Gemini...`);
    const result = await gemini.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    if (tentativa === 2) { await new Promise(r => setTimeout(r, 10000)); return chamarIA(prompt, 3); }
    throw new Error(`Todas as IAs falharam: ${err.message}`);
  }
};

module.exports = { chamarIA };
