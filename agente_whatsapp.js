// agente_whatsapp.js — Triagem automática via WhatsApp + painel de aprovação
const fs = require("fs");
const path = require("path");
const { chamarIA } = require("./ai");

const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "360suites";

const CONVERSAS_PATH = path.resolve(__dirname, "wpp_conversas.json");
const PENDENTES_PATH = path.resolve(__dirname, "wpp_pendentes.json");

// ── Persistência ──────────────────────────────────────────────────────────────
const carregarConversas = () => {
  try { return fs.existsSync(CONVERSAS_PATH) ? JSON.parse(fs.readFileSync(CONVERSAS_PATH, "utf8")) : {}; }
  catch { return {}; }
};

const salvarConversas = (d) => fs.writeFileSync(CONVERSAS_PATH, JSON.stringify(d, null, 2), "utf8");

const carregarPendentes = () => {
  try { return fs.existsSync(PENDENTES_PATH) ? JSON.parse(fs.readFileSync(PENDENTES_PATH, "utf8")) : []; }
  catch { return []; }
};

const salvarPendentes = (d) => fs.writeFileSync(PENDENTES_PATH, JSON.stringify(d, null, 2), "utf8");

const removerPendente = (id) => {
  const pendentes = carregarPendentes().filter(p => p.id !== id);
  salvarPendentes(pendentes);
};

// ── Envio de mensagem ─────────────────────────────────────────────────────────
const enviarMensagem = async (remoteJid, texto) => {
  try {
    const fetch = require("node-fetch");
    const res = await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": EVOLUTION_KEY },
      body: JSON.stringify({ number: remoteJid, text: texto }),
    });
    return res.json();
  } catch (err) {
    console.error("❌ Erro ao enviar WhatsApp:", err.message);
  }
};

// ── Fluxo de triagem ──────────────────────────────────────────────────────────
/*
  Estados:
  aguardando_nome     → pede nome e e-mail
  aguardando_direcao  → pede 1 (Júlia) ou 2 (Miquéias)
  aguardando_assunto  → pede descrição do assunto
  concluido           → triagem finalizada, aguarda no painel
*/

const processarWebhook = async (remoteJid, textoRecebido) => {
  if (!remoteJid || !textoRecebido) return;

  // Ignora grupos
  if (remoteJid.includes("@g.us")) return;

  const conversas = carregarConversas();
  const conversa = conversas[remoteJid] || { estado: "aguardando_nome", historico: [] };
  const texto = textoRecebido.trim();

  // Adiciona ao histórico
  conversa.historico = conversa.historico || [];
  conversa.historico.push({ de: "proprietario", texto, hora: new Date().toISOString() });

  console.log(`📱 ${remoteJid} | Estado: ${conversa.estado} | "${texto.substring(0, 50)}"`);

  // ── Estado: aguardando nome/email ────────────────────────────────────────
  if (conversa.estado === "aguardando_nome") {
    conversas[remoteJid] = conversa;
    salvarConversas(conversas);

    const resposta = `Olá! 👋 Sou a assistente virtual da *360 Suítes*.\n\nPara te atender melhor, por favor me informe:\n\n📝 *Seu nome completo e e-mail cadastrado*`;
    await enviarMensagem(remoteJid, resposta);

    conversa.estado = "aguardando_direcao_apos_identificacao";
    conversa.historico.push({ de: "bot", texto: resposta, hora: new Date().toISOString() });
    conversas[remoteJid] = conversa;
    salvarConversas(conversas);
    return;
  }

  // ── Estado: aguardando identificação ────────────────────────────────────
  if (conversa.estado === "aguardando_direcao_apos_identificacao") {
    // Salva identificação informada pelo proprietário
    conversa.identificacao = texto;
    conversa.estado = "aguardando_direcao";
    conversas[remoteJid] = conversa;
    salvarConversas(conversas);

    const resposta = `Obrigado! 😊\n\nCom quem você gostaria de falar?\n\n*1️⃣* Júlia — _Distratos_\n*2️⃣* Miquéias — _Outros assuntos_\n\nDigite *1* ou *2*:`;
    await enviarMensagem(remoteJid, resposta);

    conversa.historico.push({ de: "bot", texto: resposta, hora: new Date().toISOString() });
    conversas[remoteJid] = conversa;
    salvarConversas(conversas);
    return;
  }

  // ── Estado: aguardando direção ───────────────────────────────────────────
  if (conversa.estado === "aguardando_direcao") {
    const opcao = texto.replace(/[^12]/g, "");

    if (opcao !== "1" && opcao !== "2") {
      await enviarMensagem(remoteJid, `Por favor, digite apenas *1* para Júlia ou *2* para Miquéias:`);
      return;
    }

    conversa.responsavel = opcao === "1" ? "Júlia" : "Miquéias";
    conversa.assuntoTipo = opcao === "1" ? "Distratos" : "Outros assuntos";
    conversa.estado = "aguardando_assunto";
    conversas[remoteJid] = conversa;
    salvarConversas(conversas);

    const resposta = `Certo! Você será atendido(a) por *${conversa.responsavel}* _(${conversa.assuntoTipo})_.\n\n📋 Por favor, descreva o que você precisa com o máximo de detalhes:`;
    await enviarMensagem(remoteJid, resposta);

    conversa.historico.push({ de: "bot", texto: resposta, hora: new Date().toISOString() });
    conversas[remoteJid] = conversa;
    salvarConversas(conversas);
    return;
  }

  // ── Estado: aguardando assunto ───────────────────────────────────────────
  if (conversa.estado === "aguardando_assunto") {
    conversa.descricaoOriginal = texto;
    conversa.estado = "processando";
    conversas[remoteJid] = conversa;
    salvarConversas(conversas);

    // Confirma recebimento imediatamente
    const confirmacao = `✅ Mensagem recebida!\n\nEm breve *${conversa.responsavel}* entrará em contato com você.\n\nObrigado por falar com a *360 Suítes*! 🏢`;
    await enviarMensagem(remoteJid, confirmacao);
    conversa.historico.push({ de: "bot", texto: confirmacao, hora: new Date().toISOString() });

    // Processa em background com IA
    setImmediate(async () => {
      try {
        const historicoTexto = conversa.historico
          .map(h => `${h.de === "proprietario" ? "Proprietário" : "Bot"}: ${h.texto}`)
          .join("\n");

        const prompt = `Você é assistente da 360 Suítes. Com base na conversa abaixo, gere:

1. Um RESUMO objetivo do que o proprietário solicitou (máximo 3 frases)
2. Uma SUGESTÃO DE RESPOSTA para ${conversa.responsavel} enviar ao proprietário (tom profissional e cordial, máximo 150 palavras)

Identificação do proprietário: ${conversa.identificacao || "Não informada"}
Direcionado para: ${conversa.responsavel} (${conversa.assuntoTipo})

CONVERSA:
${historicoTexto}

Responda EXATAMENTE neste formato:
RESUMO:
[resumo aqui]

SUGESTAO:
[sugestão de resposta aqui]`;

        const resultado = await chamarIA(prompt);

        const resumoMatch = resultado.match(/RESUMO:\s*([\s\S]*?)(?=SUGESTAO:|$)/i);
        const sugestaoMatch = resultado.match(/SUGESTAO:\s*([\s\S]*?)$/i);

        const resumo = resumoMatch?.[1]?.trim() || texto;
        const sugestao = sugestaoMatch?.[1]?.trim() || `Olá! Recebemos sua solicitação e entraremos em contato em breve.\n\nAtenciosamente,\n${conversa.responsavel}\n360 Suítes`;

        // Adiciona ao painel
        const pendentes = carregarPendentes();
        pendentes.push({
          id: `${remoteJid}_${Date.now()}`,
          remoteJid,
          telefone: remoteJid.replace("@s.whatsapp.net", ""),
          identificacao: conversa.identificacao || "Não informada",
          responsavel: conversa.responsavel,
          assuntoTipo: conversa.assuntoTipo,
          descricaoOriginal: conversa.descricaoOriginal,
          resumo,
          sugestao,
          historico: conversa.historico,
          whatsappLink: `https://wa.me/${remoteJid.replace("@s.whatsapp.net", "").replace(/\D/g, "")}`,
          dataTriagem: new Date().toISOString(),
        });
        salvarPendentes(pendentes);

        // Marca como concluído
        conversa.estado = "concluido";
        conversas[remoteJid] = conversa;
        salvarConversas(conversas);

        console.log(`✅ Triagem concluída: ${conversa.identificacao} → ${conversa.responsavel}`);
      } catch (err) {
        console.error("❌ Erro ao processar triagem com IA:", err.message);
        conversa.estado = "concluido";
        conversas[remoteJid] = conversa;
        salvarConversas(conversas);
      }
    });
    return;
  }

  // ── Estado: concluído — reinicia se mandar nova mensagem ────────────────
  if (conversa.estado === "concluido" || conversa.estado === "processando") {
    // Aguarda 2h antes de reiniciar (evita loop)
    const ultimaMensagem = conversa.historico?.[conversa.historico.length - 1];
    const diff = ultimaMensagem ? (Date.now() - new Date(ultimaMensagem.hora).getTime()) / 1000 / 60 : 999;

    if (diff > 120) {
      // Reinicia conversa
      delete conversas[remoteJid];
      salvarConversas(conversas);
      await processarWebhook(remoteJid, textoRecebido);
    } else {
      await enviarMensagem(remoteJid, `Sua solicitação já foi registrada! Em breve *${conversa.responsavel}* entrará em contato. 😊`);
    }
  }
};

// ── Configura webhook na Evolution API ───────────────────────────────────────
const configurarWebhook = async (serverUrl) => {
  try {
    const fetch = require("node-fetch");
    const webhookUrl = `${serverUrl}/webhook/whatsapp`;

    const res = await fetch(`${EVOLUTION_URL}/webhook/set/${EVOLUTION_INSTANCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": EVOLUTION_KEY },
      body: JSON.stringify({
        url: webhookUrl,
        webhook_by_events: false,
        webhook_base64: false,
        events: ["MESSAGES_UPSERT"],
      }),
    });

    const data = await res.json();
    console.log(`🔗 Webhook configurado: ${webhookUrl}`, data);
    return data;
  } catch (err) {
    console.error("❌ Erro ao configurar webhook:", err.message);
  }
};

const enviarRespostaWhatsApp = async (remoteJid, texto) => enviarMensagem(remoteJid, texto);

module.exports = {
  processarWebhook,
  configurarWebhook,
  enviarRespostaWhatsApp,
  carregarPendentes,
  removerPendente,
};
