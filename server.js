// server.js â€” Servidor principal 360 SuÃ­tes v2
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const cron = require("node-cron");

const { buscarEmails, enviarResposta } = require("./agente");
const { executarTriagem } = require("./agente_triagem");
const {
  verificarBloqueios,
  marcarNotificado,
  carregarPendentes,
  removerPendente,
} = require("./agente_bloqueios");
const { getAccessToken, criarOAuth2 } = require("./gmail");
const { google } = require("googleapis");

// â”€â”€ DiagnÃ³stico â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const varObrigatorias = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_REFRESH_TOKEN",
  "GMAIL_USER",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
];
const faltando = varObrigatorias.filter((v) => !process.env[v]);
if (faltando.length) {
  console.warn("âš ï¸ VariÃ¡veis ausentes:", faltando.join(", "));
}
console.log("âœ… VariÃ¡veis de ambiente OK");
console.log(`ðŸ“§ Gmail: ${process.env.GMAIL_USER}`);
console.log(
  `ðŸ¤– Groq: ${process.env.GROQ_API_KEY ? "âœ“" : "âœ—"} | Gemini: ${process.env.GEMINI_API_KEY ? "âœ“" : "âœ—"}`,
);
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

const criarTransporter = async () => {
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

// â”€â”€ Agendamento automÃ¡tico â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
cron.schedule(
  "0 9 * * *",
  async () => {
    console.log(
      `ðŸ¤– [${new Date().toLocaleString("pt-BR")}] Agente automÃ¡tico...`,
    );
    try {
      const emails = await buscarEmails();
      console.log(`ðŸ“¬ ${emails.length} e-mail(s) processado(s)`);
    } catch (err) {
      console.error("âŒ Erro agente automÃ¡tico:", err.message);
    }
  },
  { timezone: "America/Sao_Paulo" },
);
console.log("â° Agente agendado: 09:00 (BrasÃ­lia)");

// â”€â”€ Rotas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/", (req, res) =>
  res.sendFile(path.resolve(__dirname, "painel.html")),
);

// Auth Google
app.get("/auth/google", (req, res) => {
  const auth = criarOAuth2();
  res.redirect(
    auth.generateAuthUrl({
      access_type: "offline",
      scope: ["https://mail.google.com/"],
      prompt: "consent",
    }),
  );
});
app.get("/auth/google/callback", async (req, res) => {
  const auth = criarOAuth2();
  const { tokens } = await auth.getToken(req.query.code);
  console.log("ðŸ”‘ REFRESH TOKEN:", tokens.refresh_token);
  res.send(`<h2>Token gerado!</h2><pre>${tokens.refresh_token}</pre>`);
});

// Agente
app.get("/agente/verificar", async (req, res) => {
  try {
    console.log("ðŸ¤– Verificando e-mails...");
    const emails = await buscarEmails();
    console.log(`ðŸ“¬ ${emails.length} e-mail(s)`);
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
    console.log(`âœ… Resposta enviada para ${para}`);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/agente/triagem", async (req, res) => {
  try {
    const resultado = await executarTriagem();
    res.json({ sucesso: true, ...resultado });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Envio de PDFs em lote
app.post("/enviar-lote", upload.array("pdfs"), async (req, res) => {
  try {
    const {
      mes = "MarÃ§o",
      ano = "2026",
      assunto: assuntoTemplate = "360 SuÃ­tes | Performance - {mes}/{ano}",
      template:
        corpoTemplate = "OlÃ¡, {nome}.\n\nSegue o relatÃ³rio de {mes}/{ano}.\n\nAtenciosamente,\n360 SuÃ­tes",
    } = req.body;
    const todosProprietarios = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"),
    );
    const proprietarios = process.env.TEST_LIMIT
      ? todosProprietarios.slice(0, Number(process.env.TEST_LIMIT))
      : todosProprietarios;
    const arquivos = req.files;
    const transporter = await criarTransporter();
    const relatorio = [];

    for (const prop of proprietarios) {
      const anexos = arquivos.filter((f) =>
        prop.unidades.some(
          (u) =>
            f.filename.toLowerCase().startsWith(u.toLowerCase() + " -") ||
            f.filename.toLowerCase().startsWith(u.toLowerCase() + "-"),
        ),
      );
      if (!anexos.length) {
        relatorio.push({
          status: "sem-anexos",
          nome: prop.nome,
          email: prop.email,
        });
        continue;
      }

      const assunto = assuntoTemplate
        .replace(/{mes}/g, mes)
        .replace(/{ano}/g, ano)
        .replace(/{nome}/g, prop.nome);
      const corpo = corpoTemplate
        .replace(/{mes}/g, mes)
        .replace(/{ano}/g, ano)
        .replace(/{nome}/g, prop.nome);
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><img src="https://lp.360suites.com.br/wp-content/uploads/2024/02/Ativo-2.png" width="150" style="margin-bottom:24px"/><div style="font-size:15px;line-height:1.7;color:#333;white-space:pre-wrap">${corpo}</div></div>`;

      try {
        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: process.env.TEST_EMAIL || prop.email,
          subject: assunto,
          html,
          attachments: anexos.map((f) => ({
            filename: f.filename,
            path: f.path,
          })),
        });
        relatorio.push({
          status: "enviado",
          nome: prop.nome,
          email: prop.email,
          anexos: anexos.map((f) => f.filename),
        });
        console.log(`âœ… ${prop.email}`);
      } catch (err) {
        relatorio.push({
          status: "falhou",
          nome: prop.nome,
          email: prop.email,
          erro: err.message,
        });
      }
    }
    arquivos.forEach((f) => {
      try {
        fs.unlinkSync(f.path);
      } catch {}
    });
    res.json({
      total: proprietarios.length,
      enviados: relatorio.filter((r) => r.status === "enviado").length,
      sem_anexos: relatorio.filter((r) => r.status === "sem-anexos").length,
      falhas: relatorio.filter((r) => r.status === "falhou").length,
      relatorio,
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Bloqueios
app.get("/bloqueios/verificar", async (req, res) => {
  try {
    res.json({ sucesso: true, ...(await verificarBloqueios()) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});
app.get("/bloqueios/pendentes", (req, res) =>
  res.json({ pendentes: carregarPendentes() }),
);
app.post("/bloqueios/aprovar", async (req, res) => {
  try {
    const { hash, tipo, email, assunto, mensagem } = req.body;
    if (tipo === "email") {
      const transporter = await criarTransporter();
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: email,
        subject: assunto,
        text: mensagem,
      });
    }
    marcarNotificado(hash, tipo);
    removerPendente(hash);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});
app.post("/bloqueios/ignorar", (req, res) => {
  const { hash } = req.body;
  marcarNotificado(hash, "ignorado");
  removerPendente(hash);
  res.json({ sucesso: true });
});

// Status
app.get("/status", (req, res) =>
  res.json({
    ok: true,
    versao: "2.0.0",
    hora: new Date().toLocaleString("pt-BR"),
  }),
);

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`ðŸš€ Servidor rodando na porta ${PORT}`),
);

