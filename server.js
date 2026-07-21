require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { buscarEmails, enviarResposta } = require("./agente");
const { executarTriagem } = require("./agente_triagem");
const { verificarBloqueios, marcarNotificado, carregarPendentes, removerPendente } = require("./agente_bloqueios");

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

// Helper para enviar e-mail via Gmail API (sem SMTP, funciona no Railway)
const enviarEmailGmailAPI = async (para, assunto, html, anexos = []) => {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const boundary = "boundary_360suites";
  let raw = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${para}`,
    `Subject: =?UTF-8?B?${Buffer.from(assunto).toString("base64")}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(html).toString("base64"),
  ].join("\n");

  for (const anexo of anexos) {
    const fileContent = fs.readFileSync(anexo.path);
    raw += [
      "",
      `--${boundary}`,
      `Content-Type: application/pdf; name="${anexo.filename}"`,
      `Content-Disposition: attachment; filename="${anexo.filename}"`,
      `Content-Transfer-Encoding: base64`,
      "",
      fileContent.toString("base64"),
    ].join("\n");
  }

  raw += `\n--${boundary}--`;

  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });
};

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

app.post("/enviar-lote", upload.array("pdfs"), async (req, res) => {
  try {
    const mes = req.body.mes || "Julho";
    const ano = req.body.ano || "2026";
    const assuntoTemplate = req.body.assunto || "360 Suítes | Performance - {mes}/{ano}";
    const corpoTemplate = req.body.template || `Olá, {nome}.\n\nSegue o detalhamento de performance do apartamento referente a {mes}/{ano}.\n\nQualquer dúvida, estamos à disposição.\n\n360 Suítes`;

    const todosProprietarios = JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
    const proprietarios = process.env.TEST_LIMIT ? todosProprietarios.slice(0, Number(process.env.TEST_LIMIT)) : todosProprietarios;
    const arquivos = req.files;
    const relatorio = [];

    for (const prop of proprietarios) {
      const anexos = arquivos.filter((f) =>
        prop.unidades.some((u) =>
          f.filename.toLowerCase().startsWith(u.toLowerCase() + " -") ||
          f.filename.toLowerCase().startsWith(u.toLowerCase() + "-")
        )
      );
      if (anexos.length === 0) {
        console.log(`sem anexos: ${prop.email}`);
        relatorio.push({ status: "sem-anexos", nome: prop.nome, email: prop.email });
        continue;
      }

      const assunto = assuntoTemplate.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const corpo = corpoTemplate.replace(/{mes}/g, mes).replace(/{ano}/g, ano).replace(/{nome}/g, prop.nome);
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
        <img src="https://lp.360suites.com.br/wp-content/uploads/2024/02/Ativo-2.png" width="150" style="margin-bottom:24px"/>
        <div style="font-size:15px;line-height:1.7;color:#333;white-space:pre-wrap">${corpo}</div>
      </div>`;

      try {
        await enviarEmailGmailAPI(process.env.TEST_EMAIL || prop.email, assunto, html, anexos);
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
      sem_anexos: relatorio.filter((r) => r.status === "sem-anexos").length,
      falhas: relatorio.filter((r) => r.status === "falhou").length,
      relatorio,
    });
  } catch (err) {
    console.error("ERRO:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get("/agente/verificar", async (req, res) => {
  try {
    const { mes, ano, unidades, nomes, modo } = req.query;
    const filtros = {
      mes: mes || null,
      ano: ano || null,
      unidades: unidades ? unidades.split(",").map((u) => u.trim().toUpperCase()) : [],
      nomes: nomes ? nomes.split(",").map((n) => n.trim().toLowerCase()) : [],
      modo: modo || "performance",
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
      const html = `<div style="font-family:Arial,sans-serif">${mensagem.replace(/\n/g, "<br>")}</div>`;
      await enviarEmailGmailAPI(email, assunto, html);
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

app.get("/proprietarios", (req, res) => {
  try {
    const props = JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
    res.json(props);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/enviar-personalizado", async (req, res) => {
  try {
    const { para, nome, assunto, corpo } = req.body;
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
      <img src="https://lp.360suites.com.br/wp-content/uploads/2024/02/Ativo-2.png" width="150" style="margin-bottom:24px"/>
      <div style="font-size:15px;line-height:1.7;color:#333;white-space:pre-wrap">${corpo.replace(/{nome}/g, nome)}</div>
      <br/><p style="color:#666;font-size:13px"><strong>360 Suítes</strong></p>
    </div>`;
    await enviarEmailGmailAPI(para, assunto.replace(/{nome}/g, nome), html);
    console.log(`✅ Personalizado enviado: ${para}`);
    res.json({ sucesso: true });
  } catch (err) {
    console.error(`❌ Falhou personalizado: ${err.message}`);
    res.status(500).json({ erro: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 360 Suítes rodando na porta ${PORT}`);
  console.log(`📧 Gmail: ${process.env.GMAIL_USER}`);
  console.log(`🤖 Groq: ${process.env.GROQ_API_KEY ? "✅" : "❌"} | Gemini: ${process.env.GEMINI_API_KEY ? "✅" : "❌"}`);
});
