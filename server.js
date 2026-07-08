require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { buscarEmails, enviarResposta } = require("./agente");
const { executarTriagem } = require("./agente_triagem");
const { verificarBloqueios, marcarNotificado, carregarPendentes, removerPendente } = require("./agente_bloqueios");
const cron = require("node-cron");

// Função que o agente executa automaticamente
const executarAgente = async () => {
  console.log(`🤖 [${new Date().toLocaleString("pt-BR")}] Agente iniciado automaticamente...`);
  try {
    const emails = await buscarEmails();
    console.log(`📬 ${emails.length} e-mail(s) processado(s) pelo agente`);
    if (emails.length > 0) {
      console.log(`⚠️ ${emails.length} resposta(s) aguardando aprovação no painel: http://localhost:3001`);
    }
  } catch (err) {
    console.error("❌ Erro no agente automático:", err.message);
  }
};

// Roda todo dia às 09:00
cron.schedule("0 9 * * *", executarAgente, { timezone: "America/Sao_Paulo" });
console.log("⏰ Agente agendado para rodar todo dia às 09:00 (horário de Brasília)");

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
    const relatorio = [];
    for (const prop of proprietarios) {
      const anexos = arquivos.filter((f) => prop.unidades.some((u) => f.filename.toLowerCase().startsWith(u.toLowerCase() + " -") || f.filename.toLowerCase().startsWith(u.toLowerCase() + "-")));
      if (anexos.length === 0) { console.log(`sem anexos: ${prop.email}`); relatorio.push({ status: "sem-anexos", nome: prop.nome, email: prop.email }); continue; }

      // Substitui variáveis no template
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
    res.json({ total: proprietarios.length, enviados: relatorio.filter((r) => r.status === "enviado").length, sem_anexos: relatorio.filter((r) => r.status === "sem-anexos").length, falhas: relatorio.filter((r) => r.status === "falhou").length, relatorio });
  } catch (err) {
    console.error("ERRO:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

// AGENTE
app.get("/agente/verificar", async (req, res) => {
  try {
    const { mes, ano, unidades } = req.query;
    const filtros = {
      mes: mes || null,
      ano: ano || null,
      unidades: unidades ? unidades.split(',').map(u => u.trim().toUpperCase()) : [],
    };
    console.log("🤖 Verificando e-mails...", filtros);
    const emails = await buscarEmails(filtros);
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

app.get("/agente/triagem", async (req, res) => {
  try {
    console.log("🔀 Executando agente de triagem...");
    const resultado = await executarTriagem();
    res.json({ sucesso: true, ...resultado });
  } catch (err) {
    console.error("ERRO triagem:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

// BLOQUEIOS
app.get("/bloqueios/verificar", async (req, res) => {
  try {
    console.log("🔒 Verificando bloqueios...");
    const resultado = await verificarBloqueios();
    res.json({ sucesso: true, ...resultado });
  } catch (err) {
    console.error("ERRO bloqueios:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get("/bloqueios/pendentes", (req, res) => {
  try {
    const pendentes = carregarPendentes();
    res.json({ total: pendentes.length, pendentes });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/bloqueios/aprovar", async (req, res) => {
  try {
    const { hash, tipo, email, assunto, mensagem } = req.body;

    if (tipo === "email") {
      const { token } = await oauth2Client.getAccessToken();
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { type: "OAuth2", user: process.env.GMAIL_USER, clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, refreshToken: process.env.GOOGLE_REFRESH_TOKEN, accessToken: token },
      });
      await transporter.sendMail({ from: process.env.GMAIL_USER, to: email, subject: assunto, text: mensagem });
    }

    marcarNotificado(hash, tipo);
    removerPendente(hash);
    console.log(`✅ Bloqueio notificado: ${hash} via ${tipo}`);
    res.json({ sucesso: true });
  } catch (err) {
    console.error("ERRO ao aprovar bloqueio:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post("/bloqueios/ignorar", (req, res) => {
  try {
    const { hash } = req.body;
    marcarNotificado(hash, "ignorado");
    removerPendente(hash);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.listen(3001, () => { console.log("Servidor rodando em http://localhost:3001"); });
