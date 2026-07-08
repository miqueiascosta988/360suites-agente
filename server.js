<<<<<<< HEAD
require("dotenv").config();
=======
// server.js — 360 Suítes v2 (Railway-ready)
>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
<<<<<<< HEAD
const { buscarEmails, enviarResposta } = require("./agente");
const { atualizarEventos, carregarEventos } = require("./eventos");
const { executarTriagem } = require("./agente_triagem");
const { verificarBloqueios, marcarNotificado, carregarPendentes, removerPendente } = require("./agente_bloqueios");
=======
>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
const cron = require("node-cron");
const { google } = require("googleapis");

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

<<<<<<< HEAD
=======
// Status
app.get("/status", (req, res) => res.json({ ok: true, versao: "2.0.0" }));

app.get("/debug", (req, res) => {
  try {
    const props = JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
    res.json({ total: props.length, primeiro: props[0]?.email });
  } catch(e) {
    res.json({ erro: e.message });
  }
});

app.get("/", (req, res) => res.sendFile(path.resolve(__dirname, "painel.html")));

>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
const uploadDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Buffer.from(file.originalname, "latin1").toString("utf8")),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

<<<<<<< HEAD
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
=======
// Lazy load dos módulos
let _agente, _triagem, _bloqueios, _gmail;
const getAgente = () => { if (!_agente) _agente = require("./agente"); return _agente; };
const getTriagem = () => { if (!_triagem) _triagem = require("./agente_triagem"); return _triagem; };
const getBloqueios = () => { if (!_bloqueios) _bloqueios = require("./agente_bloqueios"); return _bloqueios; };
const getGmail = () => { if (!_gmail) _gmail = require("./gmail"); return _gmail; };

// Cria cliente OAuth2
const criarOAuth2 = () => {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
};

// Envia e-mail via Gmail API (sem Nodemailer)
const enviarEmailGmailAPI = async (gmail, { para, assunto, html, anexos }) => {
  const boundary = "boundary_" + Date.now();
  
  const headers = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${para}`,
    `Subject: =?UTF-8?B?${Buffer.from(assunto).toString("base64")}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join("\r\n");

  let body = `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString("base64")}\r\n`;

  for (const anexo of anexos) {
    const conteudo = fs.readFileSync(anexo.path);
    const nomeEncoded = `=?UTF-8?B?${Buffer.from(anexo.filename).toString("base64")}?=`;
    body += `--${boundary}\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${nomeEncoded}"\r\n\r\n${conteudo.toString("base64")}\r\n`;
  }

  body += `--${boundary}--`;

  const raw = Buffer.from(`${headers}\r\n\r\n${body}`)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
  });
  res.redirect(url);
});

<<<<<<< HEAD
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
=======
// ── Estado do envio em lote ───────────────────────────────────────────────────
let loteStatus = null;

const iniciarEnvioBackground = async (params) => {
  const { mes, ano, assuntoTemplate, corpoTemplate, arquivos } = params;

  const todos = JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
  const proprietarios = process.env.TEST_LIMIT ? todos.slice(0, Number(process.env.TEST_LIMIT)) : todos;

  loteStatus = {
    iniciado: new Date().toISOString(),
    total: proprietarios.length,
    enviados: 0,
    sem_anexos: 0,
    falhas: 0,
    processados: 0,
    concluido: false,
    relatorio: [],
  };

  console.log(`📤 Iniciando envio: ${proprietarios.length} proprietários, ${arquivos.length} PDFs`);

  try {
    const auth = criarOAuth2();
    const gmail = google.gmail({ version: "v1", auth });

    for (const prop of proprietarios) {
      const anexos = arquivos.filter(f =>
        prop.unidades.some(u =>
          f.filename.toLowerCase().startsWith(u.toLowerCase() + " -") ||
          f.filename.toLowerCase().startsWith(u.toLowerCase() + "-")
        )
      );

      if (!anexos.length) {
        loteStatus.sem_anexos++;
        loteStatus.processados++;
        loteStatus.relatorio.push({ status: "sem-anexos", nome: prop.nome, email: prop.email });
        continue;
      }

>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
      const assunto = assuntoTemplate.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const corpo = corpoTemplate.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
        <img src="https://lp.360suites.com.br/wp-content/uploads/2024/02/Ativo-2.png" width="150" style="margin-bottom:24px"/>
        <div style="font-size:15px;line-height:1.7;color:#333;white-space:pre-wrap">${corpo}</div>
      </div>`;

<<<<<<< HEAD
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
=======
      const destino = process.env.TEST_EMAIL || prop.email;

      try {
        await enviarEmailGmailAPI(gmail, { para: destino, assunto, html, anexos });
        loteStatus.enviados++;
        loteStatus.relatorio.push({ status: "enviado", nome: prop.nome, email: prop.email, anexos: anexos.map(f => f.filename) });
        console.log(`✅ ${prop.email} (${loteStatus.processados + 1}/${proprietarios.length})`);
      } catch (err) {
        loteStatus.falhas++;
        loteStatus.relatorio.push({ status: "falhou", nome: prop.nome, email: prop.email, erro: err.message });
        console.error(`❌ ${prop.email}: ${err.message}`);
      }

      loteStatus.processados++;

      // Pausa entre envios para respeitar limites do Gmail
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    console.error("ERRO no envio:", err.message);
    loteStatus.erro = err.message;
  } finally {
    arquivos.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    loteStatus.concluido = true;
    loteStatus.finalizado = new Date().toISOString();
    console.log(`✅ Envio concluído: ${loteStatus.enviados} enviados, ${loteStatus.falhas} falhas`);
  }
};

app.post("/enviar-lote", upload.array("pdfs"), async (req, res) => {
  try {
    if (loteStatus && !loteStatus.concluido) {
      return res.status(409).json({ erro: "Já existe um envio em andamento." });
    }

    const mes = req.body.mes || "Maio";
    const ano = req.body.ano || "2026";
    const assuntoTemplate = req.body.assunto || "360 Suítes | Performance - {mes}/{ano}";
    const corpoTemplate = req.body.template || `Olá, {nome}.\n\nSegue o relatório de {mes}/{ano}.\n\nAtenciosamente,\n360 Suítes`;
    const arquivos = req.files;

    if (!arquivos?.length) return res.status(400).json({ erro: "Nenhum PDF enviado." });

    res.json({ sucesso: true, mensagem: `Envio iniciado para ${arquivos.length} PDF(s).` });

    setImmediate(() => iniciarEnvioBackground({ mes, ano, assuntoTemplate, corpoTemplate, arquivos }));

  } catch (err) {
>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
    res.status(500).json({ erro: err.message });
  }
});

<<<<<<< HEAD
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
=======
app.get("/enviar-lote/status", (req, res) => {
  if (!loteStatus) return res.json({ status: "idle" });
  res.json({ status: loteStatus.concluido ? "concluido" : "em_andamento", ...loteStatus });
});

app.post("/enviar-lote/reset", (req, res) => {
  loteStatus = null;
  res.json({ sucesso: true });
});

// Agente
app.get("/agente/verificar", async (req, res) => {
  try {
    console.log("🤖 Verificando e-mails...");
    const emails = await getAgente().buscarEmails();
>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
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

<<<<<<< HEAD
// BLOQUEIOS
=======
// Bloqueios
>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
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
<<<<<<< HEAD
  try {
    const pendentes = carregarPendentes();
    res.json({ total: pendentes.length, pendentes });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
=======
  try { res.json({ pendentes: getBloqueios().carregarPendentes() }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
});

app.post("/bloqueios/aprovar", async (req, res) => {
  try {
    const { hash, tipo, email, assunto, mensagem } = req.body;

    if (tipo === "email") {
<<<<<<< HEAD
      const { token } = await oauth2Client.getAccessToken();
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { type: "OAuth2", user: process.env.GMAIL_USER, clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, refreshToken: process.env.GOOGLE_REFRESH_TOKEN, accessToken: token },
      });
      await transporter.sendMail({ from: process.env.GMAIL_USER, to: email, subject: assunto, text: mensagem });
=======
      const auth = criarOAuth2();
      const gmail = google.gmail({ version: "v1", auth });
      const html = `<div style="font-family:Arial,sans-serif">${mensagem.replace(/\n/g, "<br>")}</div>`;
      await enviarEmailGmailAPI(gmail, { para: email, assunto, html, anexos: [] });
>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
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

<<<<<<< HEAD
app.get("/eventos/atualizar", async (req, res) => {
  try {
    const mes = req.query.mes || "Abril";
    const ano = req.query.ano || "2026";
    console.log(`📅 Atualizando eventos de ${mes}/${ano}...`);
    const eventos = await atualizarEventos(mes, ano);
    res.json({ sucesso: true, total: eventos.length, mes, ano });
  } catch (err) {
    console.error("ERRO ao atualizar eventos:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get("/eventos", (req, res) => {
  try {
    const eventos = carregarEventos();
    res.json({ total: eventos.length, eventos });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.listen(3001, () => { console.log("Servidor rodando em http://localhost:3001"); });
=======
app.post("/bloqueios/ignorar", (req, res) => {
  const { hash } = req.body;
  getBloqueios().marcarNotificado(hash, "ignorado");
  getBloqueios().removerPendente(hash);
  res.json({ sucesso: true });
});

// Auth Google
app.get("/auth/google", (req, res) => {
  const { gerarUrlAuth } = getGmail();
  res.redirect(gerarUrlAuth());
});

app.get("/auth/google/callback", async (req, res) => {
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
>>>>>>> 182b932c5836ca3f43d3f30bcf3c28e26ec45632
