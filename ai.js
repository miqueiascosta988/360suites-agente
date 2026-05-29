// ai.js — Motor de IA com fallback automático Groq → Gemini
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Cliente Groq via SDK OpenAI-compatível
const OpenAI = require("openai");

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = geminiAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const chamarIA = async (prompt, tentativa = 0) => {
  // Tentativa 0 e 1: Groq
  if (tentativa < 2) {
    try {
      console.log(`🤖 IA: Groq (tentativa ${tentativa + 1})...`);
      const res = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
        temperature: 0.7,
      });
      return res.choices[0].message.content;
    } catch (err) {
      const esgotado =
        err?.status === 429 ||
        (err?.message || "").toLowerCase().includes("quota") ||
        (err?.message || "").toLowerCase().includes("rate");

      if (esgotado && tentativa === 0) {
        console.warn("⚠️ Groq com limite — tentando Gemini...");
        return chamarIA(prompt, 2);
      }
      if (tentativa === 0) {
        console.warn(`⚠️ Groq erro: ${err.message} — tentando novamente...`);
        await new Promise(r => setTimeout(r, 5000));
        return chamarIA(prompt, 1);
      }
      console.warn("⚠️ Groq falhou — usando Gemini...");
      return chamarIA(prompt, 2);
    }
  }

  // Tentativa 2 e 3: Gemini
  if (tentativa < 4) {
    try {
      console.log(`🤖 IA: Gemini (tentativa ${tentativa - 1})...`);
      const result = await gemini.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      if (tentativa === 2) {
        console.warn(`⚠️ Gemini erro: ${err.message} — tentando novamente...`);
        await new Promise(r => setTimeout(r, 10000));
        return chamarIA(prompt, 3);
      }
      throw new Error(`Todas as IAs falharam. Último erro: ${err.message}`);
    }
  }

  throw new Error("Todas as IAs esgotadas.");
};

module.exports = { chamarIA };
