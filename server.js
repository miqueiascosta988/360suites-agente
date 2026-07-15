require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { buscarEmails, enviarResposta } = require("./agente");

const app = express();
app.use(cors());
app.use(express.json());

const uploadDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Buffer.from(file.originalname, "latin1").toString("utf8")),
});
const upload = multer({ storage });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

app.get("/", (req, res) => {
  res.sendFile(path.resolve(__dirname, "painel.html"));
});

app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://mail.google.com/"],
    prompt: "consent",
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  console.log("🔑 REFRESH TOKEN:", tokens.refresh_token);
  res.send(`<h2>Token gerado!</h2><p>${tokens.refresh_token}</p>`);
});

app.post("/enviar-email", async (req, res) => {
  try {
    const { para, assunto, mensagem } = req.body;
    const { token } = await oauth2Client.getAccessToken();
    const transporter = nodemailer.createTransport({
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
    await transporter.sendMail({ from: process.env.GMAIL_USER, to: para, subject: assunto, text: mensagem });
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/enviar-lote", upload.array("pdfs"), async (req, res) => {
  try {
    const mes = req.body.mes || "Março";
    const ano = req.body.ano || "2026";
    const assuntoTemplate = req.body.assunto || "360 Suítes | Performance - {mes}/{ano}";
    const corpoTemplate = req.body.template || `Olá, {nome}.\n\nSegue o detalhamento de performance do apartamento referente a {mes}/{ano}.\n\nQualquer dúvida, estamos à disposição.\n\n360 Suítes`;

    const todosProprietarios = JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
    const proprietarios = process.env.TEST_LIMIT ? todosProprietarios.slice(0, Number(process.env.TEST_LIMIT)) : todosProprietarios;
    const arquivos = req.files;
    const { token } = await oauth2Client.getAccessToken();
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { type: "OAuth2", user: process.env.GMAIL_USER, clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, refreshToken: process.env.GOOGLE_REFRESH_TOKEN, accessToken: token },
    });

    // ─── Carrega lista de já enviados (para retomar disparo interrompido) ──────
    const enviadosPath = path.resolve(__dirname, "enviados.json");
    const jaEnviados = fs.existsSync(enviadosPath)
      ? new Set(JSON.parse(fs.readFileSync(enviadosPath, "utf8")))
      : new Set();
    if (jaEnviados.size > 0) {
      console.log(`⏭️  ${jaEnviados.size} proprietários já enviados — serão pulados.`);
    }
    // ──────────────────────────────────────────────────────────────────────────

    const relatorio = [];
    for (const prop of proprietarios) {

      // Pula quem já recebeu
      if (jaEnviados.has(prop.email)) {
        console.log(`⏭️  já enviado: ${prop.email}`);
        relatorio.push({ status: "ja-enviado", nome: prop.nome, email: prop.email });
        continue;
      }

      const anexos = arquivos.filter((f) => prop.unidades.some((u) => f.filename.toLowerCase().startsWith(u.toLowerCase() + " -") || f.filename.toLowerCase().startsWith(u.toLowerCase() + "-")));
      if (anexos.length === 0) { console.log(`sem anexos: ${prop.email}`); relatorio.push({ status: "sem-anexos", nome: prop.nome, email: prop.email }); continue; }

      const assunto = assuntoTemplate.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const corpo = corpoTemplate.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
        <img src="https://lp.360suites.com.br/wp-content/uploads/2024/02/Ativo-2.png" width="150" style="margin-bottom:24px"/>
        <div style="font-size:15px;line-height:1.7;color:#333;white-space:pre-wrap">${corpo}</div>
      </div>`;

      try {
        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: process.env.TEST_EMAIL || prop.email,
          subject: assunto,
          html,
          attachments: anexos.map((f) => ({ filename: f.filename, path: f.path })),
        });
        console.log(`✅ enviado: ${prop.email} (${anexos.length} anexos)`);
        relatorio.push({ status: "enviado", nome: prop.nome, email: prop.email, anexos: anexos.map((f) => f.filename) });
      } catch (err) {
        console.error(`❌ falhou: ${prop.email} - ${err.message}`);
        relatorio.push({ status: "falhou", nome: prop.nome, email: prop.email, erro: err.message });
      }
    }
    arquivos.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
    res.json({
      total: proprietarios.length,
      enviados: relatorio.filter((r) => r.status === "enviado").length,
      ja_enviados: relatorio.filter((r) => r.status === "ja-enviado").length,
      sem_anexos: relatorio.filter((r) => r.status === "sem-anexos").length,
      falhas: relatorio.filter((r) => r.status === "falhou").length,
      relatorio
    });
  } catch (err) {
    console.error("ERRO:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

// AGENTE
app.get("/agente/verificar", async (req, res) => {
  try {
    console.log("🤖 Verificando e-mails...");
    const emails = await buscarEmails();
    console.log(`📬 ${emails.length} e-mail(s) encontrado(s)`);
    res.json({ total: emails.length, emails });
  } catch (err) {
    console.error("ERRO agente:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post("/agente/enviar", async (req, res) => {
  try {
    const { threadId, para, assunto, corpo } = req.body;
    await enviarResposta(threadId, para, assunto, corpo);
    console.log(`✅ Resposta enviada para ${para}`);
    res.json({ sucesso: true });
  } catch (err) {
    console.error("ERRO ao enviar resposta:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

  try {
    const mes = req.query.mes || "Abril";
    const ano = req.query.ano || "2026";
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

  try {
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.listen(3001, () => { console.log("Servidor rodando em http://localhost:3001"); });
