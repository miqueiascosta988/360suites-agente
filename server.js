// server.js — 360 Suítes v2 (Railway-ready)
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Status
app.get("/status", (req, res) => res.json({ ok: true, versao: "2.0.0" }));
app.get("/debug", (req, res) => {
  try {
    const props = JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
    res.json({ total: props.length, primeiro: props[0]?.email });
  } catch(e) { res.json({ erro: e.message }); }
});
app.get("/", (req, res) => res.sendFile(path.resolve(__dirname, "painel.html")));

const uploadDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Buffer.from(file.originalname, "latin1").toString("utf8")),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Lazy load módulos
let _agente, _triagem, _bloqueios, _gmail, _wpp;
const getAgente = () => { if (!_agente) _agente = require("./agente"); return _agente; };
const getTriagem = () => { if (!_triagem) _triagem = require("./agente_triagem"); return _triagem; };
const getGmail = () => { if (!_gmail) _gmail = require("./gmail"); return _gmail; };
const getWpp = () => { if (!_wpp) _wpp = require("./agente_whatsapp"); return _wpp; };

// OAuth2
const criarOAuth2 = () => {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
};

// Envia email via Gmail API
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
  const raw = Buffer.from(`${headers}\r\n\r\n${body}`).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
};

// Estado do envio em lote
let loteStatus = null;

const iniciarEnvioBackground = async ({ mes, ano, assuntoTemplate, corpoTemplate, arquivos }) => {
  const todos = JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
  const proprietarios = process.env.TEST_LIMIT ? todos.slice(0, Number(process.env.TEST_LIMIT)) : todos;
  loteStatus = { iniciado: new Date().toISOString(), total: proprietarios.length, enviados: 0, sem_anexos: 0, falhas: 0, processados: 0, concluido: false, relatorio: [] };
  console.log(`📤 Iniciando envio: ${proprietarios.length} proprietários`);
  try {
    const auth = criarOAuth2();
    const gmail = google.gmail({ version: "v1", auth });
    for (const prop of proprietarios) {
      const anexos = arquivos.filter(f => prop.unidades.some(u => f.filename.toLowerCase().startsWith(u.toLowerCase() + " -") || f.filename.toLowerCase().startsWith(u.toLowerCase() + "-")));
      if (!anexos.length) {
        loteStatus.sem_anexos++;
        loteStatus.processados++;
        loteStatus.relatorio.push({ status: "sem-anexos", nome: prop.nome, email: prop.email });
        continue;
      }
      const assunto = assuntoTemplate.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const corpo = corpoTemplate.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><img src="https://lp.360suites.com.br/wp-content/uploads/2024/02/Ativo-2.png" width="150" style="margin-bottom:24px"/><div style="font-size:15px;line-height:1.7;color:#333;white-space:pre-wrap">${corpo}</div></div>`;
      try {
        await enviarEmailGmailAPI(gmail, { para: process.env.TEST_EMAIL || prop.email, assunto, html, anexos });
        loteStatus.enviados++;
        loteStatus.relatorio.push({ status: "enviado", nome: prop.nome, email: prop.email });
        console.log(`✅ ${prop.email} (${loteStatus.processados + 1}/${proprietarios.length})`);
      } catch (err) {
        loteStatus.falhas++;
        loteStatus.relatorio.push({ status: "falhou", nome: prop.nome, email: prop.email, erro: err.message });
        console.error(`❌ ${prop.email}: ${err.message}`);
      }
      loteStatus.processados++;
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
    if (loteStatus && !loteStatus.concluido) return res.status(409).json({ erro: "Envio em andamento." });
    const mes = req.body.mes || "Maio";
    const ano = req.body.ano || "2026";
    const assuntoTemplate = req.body.assunto || "360 Suítes | Performance - {mes}/{ano}";
    const corpoTemplate = req.body.template || `Olá, {nome}.\n\nSegue o relatório de {mes}/{ano}.\n\nAtenciosamente,\n360 Suítes`;
    const arquivos = req.files;
    if (!arquivos?.length) return res.status(400).json({ erro: "Nenhum PDF enviado." });
    res.json({ sucesso: true, mensagem: `Envio iniciado para ${arquivos.length} PDF(s).` });
    setImmediate(() => iniciarEnvioBackground({ mes, ano, assuntoTemplate, corpoTemplate, arquivos }));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get("/enviar-lote/status", (req, res) => {
  if (!loteStatus) return res.json({ status: "idle" });
  res.json({ status: loteStatus.concluido ? "concluido" : "em_andamento", ...loteStatus });
});

app.post("/enviar-lote/reset", (req, res) => { loteStatus = null; res.json({ sucesso: true }); });

// Envio personalizado
app.post("/enviar-personalizado", async (req, res) => {
  try {
    const { para, nome, assunto, corpo } = req.body;
    const auth = criarOAuth2();
    const gmail = google.gmail({ version: "v1", auth });
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><div style="font-size:15px;line-height:1.7;color:#333;white-space:pre-wrap">${corpo.replace(/{nome}/g, nome)}</div></div>`;
    await enviarEmailGmailAPI(gmail, { para, assunto: assunto.replace(/{nome}/g, nome), html, anexos: [] });
    res.json({ sucesso: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Gerar e-mail com IA
app.post("/gerar-email-ia", async (req, res) => {
  try {
    const { instrucao } = req.body;
    const { chamarIA } = require("./ai");
    const resultado = await chamarIA(`Você é assistente da 360 Suítes. Gere um e-mail profissional com base na instrução abaixo.\n\nInstrução: ${instrucao}\n\nResponda EXATAMENTE neste formato:\nASSUNTO:\n[assunto aqui]\n\nCORPO:\n[corpo aqui, use {nome} para personalizar]`);
    const assuntoMatch = resultado.match(/ASSUNTO:\s*([\s\S]*?)(?=CORPO:|$)/i);
    const corpoMatch = resultado.match(/CORPO:\s*([\s\S]*?)$/i);
    res.json({ assunto: assuntoMatch?.[1]?.trim() || "", corpo: corpoMatch?.[1]?.trim() || resultado });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Proprietários
app.get("/proprietarios", (req, res) => {
  try {
    const props = JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
    res.json(props);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Agente e-mail
app.get("/agente/verificar", async (req, res) => {
  try {
    console.log("🤖 Verificando e-mails...");
    const emails = await getAgente().buscarEmails();
    res.json({ total: emails.length, emails });
  } catch (err) { console.error("ERRO agente:", err.message); res.status(500).json({ erro: err.message }); }
});

app.post("/agente/enviar", async (req, res) => {
  try {
    const { threadId, para, assunto, corpo } = req.body;
    await getAgente().enviarResposta(threadId, para, assunto, corpo);
    res.json({ sucesso: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get("/agente/triagem", async (req, res) => {
  try {
    const resultado = await getTriagem().executarTriagem();
    res.json({ sucesso: true, ...resultado });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// WhatsApp
app.post("/webhook/whatsapp", async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const body = req.body;
    if (body?.event !== "messages.upsert") return;
    const msgs = body?.data?.messages || [];
    for (const msg of msgs) {
      if (msg?.key?.fromMe) continue;
      const remoteJid = msg?.key?.remoteJid;
      const texto = msg?.message?.conversation || msg?.message?.extendedTextMessage?.text || "";
      if (texto && remoteJid) {
        console.log(`📱 Webhook: ${remoteJid} — "${texto.substring(0, 50)}"`);
        setImmediate(() => getWpp().processarWebhook(remoteJid, texto));
      }
    }
  } catch (err) { console.error("❌ Erro no webhook:", err.message); }
});

app.get("/whatsapp/pendentes", (req, res) => {
  try { res.json({ pendentes: getWpp().carregarPendentes() }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post("/whatsapp/aprovar", async (req, res) => {
  try {
    const { id, remoteJid, texto } = req.body;
    await getWpp().enviarRespostaWhatsApp(remoteJid, texto);
    getWpp().removerPendente(id);
    res.json({ sucesso: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post("/whatsapp/arquivar", (req, res) => {
  try {
    const { id } = req.body;
    getWpp().removerPendente(id);
    res.json({ sucesso: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
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
  } catch (err) { console.error("❌ Erro agente automático:", err.message); }
}, { timezone: "America/Sao_Paulo" });

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 360 Suítes rodando na porta ${PORT}`);
  console.log(`📧 Gmail: ${process.env.GMAIL_USER || "não configurado"}`);
  console.log(`🤖 Groq: ${process.env.GROQ_API_KEY ? "✅" : "✗"} | Gemini: ${process.env.GEMINI_API_KEY ? "✅" : "✗"}`);

  // Configura webhook da Evolution API
  const serverUrl = process.env.SERVER_URL || "https://360suites-agente-production.up.railway.app";
  setTimeout(async () => {
    try {
      const { configurarWebhook } = require("./agente_whatsapp");
      await configurarWebhook(serverUrl);
    } catch (err) {
      console.error("❌ Erro ao configurar webhook:", err.message);
    }
  }, 5000);
});
