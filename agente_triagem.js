// agente_triagem.js — Triagem automática para WhatsApp

const { buscarMensagens, lerMensagem, enviarResposta: enviarGmail, marcarComoLido } = require("./gmail");
const fs = require("fs");
const path = require("path");

const ENVIADOS_PATH = path.resolve(__dirname, "triagem_enviados.json");
const WHATSAPP_LINK = `https://wa.me/5511976320341`;

const carregarEnviados = () => {
  try {
    if (!fs.existsSync(ENVIADOS_PATH)) return {};
    return JSON.parse(fs.readFileSync(ENVIADOS_PATH, "utf8"));
  } catch { return {}; }
};

const salvarEnviados = (dados) => {
  fs.writeFileSync(ENVIADOS_PATH, JSON.stringify(dados, null, 2), "utf8");
};

const carregarProprietarios = () => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
  } catch { return []; }
};

const getMensagem = (nome) => `Olá, ${nome}!

Obrigado por entrar em contato com a 360 Suítes.

Recebemos sua mensagem e gostaríamos de informar que o retorno por e-mail pode levar um tempo maior do que gostaríamos.

Para uma resposta mais rápida e personalizada, pedimos que entre em contato pelo nosso WhatsApp:

📱 ${WHATSAPP_LINK}

Nossa equipe está pronta para esclarecer todas as suas dúvidas!

Atenciosamente,
Equipe 360 Suítes`;

const getMensagemGenerica = () => `Olá!

Obrigado por entrar em contato com a 360 Suítes.

Recebemos sua mensagem e gostaríamos de informar que o retorno por e-mail pode levar um tempo maior do que gostaríamos.

Para uma resposta mais rápida e personalizada, pedimos que entre em contato pelo nosso WhatsApp:

📱 ${WHATSAPP_LINK}

Nossa equipe está pronta para esclarecer todas as suas dúvidas!

Atenciosamente,
Equipe 360 Suítes`;

// Remetentes automáticos que nunca devem receber resposta (bounce, mailer-daemon, etc.)
const ehRemetenteAutomatico = (email) => {
  const padroesIgnorados = ["postmaster@", "mailer-daemon@", "no-reply@", "noreply@", "@360suites.com.br"];
  return padroesIgnorados.some(p => email.toLowerCase().includes(p));
};

const executarTriagem = async () => {
  const proprietarios = carregarProprietarios();
  const ano = process.env.ANO_REFERENCIA || "2026";

  console.log(`\n🔀 Agente de triagem iniciado...`);
  const mensagens = await buscarMensagens(`is:unread subject:Performance subject:${ano}`);
  console.log(`📬 ${mensagens.length} e-mail(s) encontrado(s)`);

  const enviados = carregarEnviados();
  let respondidos = 0, ignorados = 0, duplicatas = 0;

  for (const msg of mensagens) {
    const { id, threadId, assunto, de: emailRemetente } = await lerMensagem(msg.id);

    if (enviados[id]) { duplicatas++; continue; }

    if (ehRemetenteAutomatico(emailRemetente)) { ignorados++; continue; }

    const proprietario =
