// server.js — 360 Suítes v2 (Railway-ready)
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

// Status (Railway healthcheck)
app.get("/status", (req, res) => res.json({ ok: true, versao: "2.0.0" }));
app.get("/", (req, res) => res.sendFile(path.resolve(__dirname, "painel.html")));

const uploadDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Buffer.from(file.originalname, "latin1").toString("utf8")),
});
const upload = multer({ storage });

// Lazy load dos módulos (evita crash por variáveis não carregadas)
let _agente, _triagem, _bloqueios, _gmail;

const getAgente = () => {
  if (!_agente) _agente = require("./agente");
  return _agente;
};
const getTriagem = () => {
  if (!_triagem) _triagem = require("./agente_triagem");
  return _triagem;
};
const getBloqueios = () => {
  if (!_bloqueios) _bloqueios = require("./agente_bloqueios");
  return _bloqueios;
};
const getGmail = () => {
  if (!_gmail) _gmail = require("./gmail");
  return _gmail;
};

const criarTransporter = async () => {
  const { getAccessToken } = getGmail();
  const token = await getAccessToken();
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: process.env.GMAIL_USER,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      accessToken: token,
    },
  });
};

// Agente
app.get("/agente/verificar", async (req, res) => {
  try {
    console.log("🤖 Verificando e-mails...");
    const emails = await getAgente().buscarEmails();
    console.log(`📬 ${emails.length} e-mail(s)`);
    res.json({ total: emails.length, emails });
  } catch (err) {
    console.error("ERRO agente:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post("/agente/enviar", async (req, res) => {
  try {
    const { threadId, para, assunto, corpo } = req.body;
    await getAgente().enviarResposta(threadId, para, assunto, corpo);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/agente/triagem", async (req, res) => {
  try {
    const resultado = await getTriagem().executarTriagem();
    res.json({ sucesso: true, ...resultado });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Envio de PDFs
app.post("/enviar-lote", upload.array("pdfs"), async (req, res) => {
  try {
    const { mes = "Maio", ano = "2026", assunto: assuntoTpl = "360 Suítes | Performance - {mes}/{ano}", template: corpoTpl = "Olá, {nome}.\n\nSegue o relatório de {mes}/{ano}.\n\nAtenciosamente,\n360 Suítes" } = req.body;
    const todos = JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
    const proprietarios = process.env.TEST_LIMIT ? todos.slice(0, Number(process.env.TEST_LIMIT)) : todos;
    const arquivos = req.files;
    const transporter = await criarTransporter();
    const relatorio = [];

    for (const prop of proprietarios) {
      const anexos = arquivos.filter(f => prop.unidades.some(u =>
        f.filename.toLowerCase().startsWith(u.toLowerCase() + " -") ||
        f.filename.toLowerCase().startsWith(u.toLowerCase() + "-")
      ));
      if (!anexos.length) { relatorio.push({ status: "sem-anexos", nome: prop.nome, email: prop.email }); continue; }

      const assunto = assuntoTpl.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const corpo = corpoTpl.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><img src="https://lp.360suites.com.br/wp-content/uploads/2024/02/Ativo-2.png" width="150" style="margin-bottom:24px"/><div style="font-size:15px;line-height:1.7;color:#333;white-space:pre-wrap">${corpo}</div></div>`;

      try {
        await transporter.sendMail({ from: process.env.GMAIL_USER, to: process.env.TEST_EMAIL || prop.email, subject: assunto, html, attachments: anexos.map(f => ({ filename: f.filename, path: f.path })) });
        relatorio.push({ status: "enviado", nome: prop.nome, email: prop.email, anexos: anexos.map(f => f.filename) });
        console.log(`✅ ${prop.email}`);
      } catch (err) {
        relatorio.push({ status: "falhou", nome: prop.nome, email: prop.email, erro: err.message });
      }
    }

    arquivos.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    res.json({ total: proprietarios.length, enviados: relatorio.filter(r => r.status === "enviado").length, sem_anexos: relatorio.filter(r => r.status === "sem-anexos").length, falhas: relatorio.filter(r => r.status === "falhou").length, relatorio });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Bloqueios
app.get("/bloqueios/verificar", async (req, res) => {
  try {
    res.json({ sucesso: true, ...await getBloqueios().verificarBloqueios() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/bloqueios/pendentes", (req, res) => {
  try {
    res.json({ pendentes: getBloqueios().carregarPendentes() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/bloqueios/aprovar", async (req, res) => {
  try {
    const { hash, tipo, email, assunto, mensagem } = req.body;
    if (tipo === "email") {
      const transporter = await criarTransporter();
      await transporter.sendMail({ from: process.env.GMAIL_USER, to: email, subject: assunto, text: mensagem });
    }
    getBloqueios().marcarNotificado(hash, tipo);
    getBloqueios().removerPendente(hash);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/bloqueios/ignorar", (req, res) => {
  const { hash } = req.body;
  getBloqueios().marcarNotificado(hash, "ignorado");
  getBloqueios().removerPendente(hash);
  res.json({ sucesso: true });
});

// Auth Google
app.get("/auth/google", (req, res) => {
  const { criarOAuth2 } = getGmail();
  const auth = criarOAuth2();
  res.redirect(auth.generateAuthUrl({ access_type: "offline", scope: ["https://mail.google.com/"], prompt: "consent" }));
});

app.get("/auth/google/callback", async (req, res) => {
  const { criarOAuth2 } = getGmail();
  const auth = criarOAuth2();
  const { tokens } = await auth.getToken(req.query.code);
  console.log("🔑 REFRESH TOKEN:", tokens.refresh_token);
  res.send(`<h2>Token gerado!</h2><pre>${tokens.refresh_token}</pre>`);
});

// Agendamento
cron.schedule("0 9 * * *", async () => {
  console.log(`🤖 [${new Date().toLocaleString("pt-BR")}] Agente automático...`);
  try {
    const emails = await getAgente().buscarEmails();
    console.log(`📬 ${emails.length} e-mail(s) processado(s)`);
  } catch (err) {
    console.error("❌ Erro agente automático:", err.message);
  }
}, { timezone: "America/Sao_Paulo" });

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 360 Suítes rodando na porta ${PORT}`);
  console.log(`📧 Gmail: ${process.env.GMAIL_USER || "não configurado"}`);
  console.log(`🤖 Groq: ${process.env.GROQ_API_KEY ? "✓" : "✗"} | Gemini: ${process.env.GEMINI_API_KEY ? "✓" : "✗"}`);
});
