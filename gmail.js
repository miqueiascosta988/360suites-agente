// gmail.js — Módulo Gmail centralizado
const { google } = require("googleapis");

const criarOAuth2 = () => {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
};

const getGmail = () => google.gmail({ version: "v1", auth: criarOAuth2() });

const buscarMensagens = async (query, maxResults = 50) => {
  const gmail = getGmail();
  const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
  return res.data.messages || [];
};

const lerMensagem = async (id) => {
  const gmail = getGmail();
  const detalhe = await gmail.users.messages.get({ userId: "me", id });
  const headers = detalhe.data.payload.headers;

  const assunto = headers.find(h => h.name === "Subject")?.value || "";
  const de = headers.find(h => h.name === "From")?.value || "";
  const emailRemetente = de.match(/<(.+)>/)?.[1] || de;

  let corpo = "";
  const parts = detalhe.data.payload.parts || [];
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      corpo = Buffer.from(part.body.data, "base64").toString("utf8");
      break;
    }
  }
  if (!corpo && detalhe.data.payload.body?.data) {
    corpo = Buffer.from(detalhe.data.payload.body.data, "base64").toString("utf8");
  }

  return { id, threadId: detalhe.data.threadId, assunto, de: emailRemetente, corpo };
};

const enviarResposta = async (threadId, para, assunto, corpo) => {
  const gmail = getGmail();
  const rawEmail = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${para}`,
    `Subject: Re: ${assunto}`,
    `In-Reply-To: ${threadId}`,
    `References: ${threadId}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    corpo,
  ].join("\n");

  const encoded = Buffer.from(rawEmail)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded, threadId },
  });
};

const marcarComoLido = async (id) => {
  const gmail = getGmail();
  await gmail.users.messages.modify({
    userId: "me",
    id,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
};

const getAccessToken = async () => {
  const client = criarOAuth2();
  const { token } = await client.getAccessToken();
  return token;
};

module.exports = { buscarMensagens, lerMensagem, enviarResposta, marcarComoLido, getAccessToken, criarOAuth2 };
