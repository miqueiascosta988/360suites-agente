// agente_whatsapp.js — Triagem automática via WhatsApp (Evolution API)
const fs = require("fs");
const path = require("path");
const { chamarIA } = require("./ai");

const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "360suites";
const GRUPO_TRIAGEM = process.env.WHATSAPP_GRUPO_TRIAGEM;

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

// ── Notificação no grupo de triagem ──────────────────────────────────────────
const notificarGrupo = async (dados) => {
  if (!GRUPO_TRIAGEM) {
    console.warn("⚠️ WHATSAPP_GRUPO_TRIAGEM não configurado");
    return;
  }

  const emoji = dados.responsavel === "Júlia" ? "🟡" : "🟢";
  const telefone = dados.remoteJid?.replace("@s.whatsapp.net", "").replace(/\D/g, "");
  const linkWpp = `https://wa.me/${telefone}`;

  const mensagem = `${emoji} *Nova Triagem 360 Suítes*

👤 *Proprietário:* ${dados.identificacao || "Não informado"}
📋 *Assunto:* ${dados.assuntoTipo}
➡️ *Encaminhar para:* ${dados.responsavel}

📝 *Resumo:*
${dados.resumo}

💬 *Descrição original:*
_${dados.descricaoOriginal}_

✨ *Sugestão de resposta:*
${dados.sugestao}

📱 ${linkWpp}`;

  await enviarMensagem(GRUPO_TRIAGEM, mensagem);
  console.log(`✅ Notificação enviada para o grupo de triagem`);
};

// ── Fluxo de triagem ──────────────────────────────────────────────────────────
const processarWebhook = async (remoteJid, textoRecebido) => {
  if (!remoteJid || !textoRecebido) return;
  if (remoteJid.includes("@g.us")) return; // ignora grupos

  const conversas = carregarConversas();
  const conversa = conversas[remoteJid] || { estado: "inicio", historico: [] };
  const texto = textoRecebido.trim();

  conversa.historico = conversa.historico || [];
  conversa.historico.push({ de: "proprietario", texto, hora: new Date().toISOString() });

  console.log(`📱 ${remoteJid} | Estado: ${conversa.estado} | "${texto.substring(0, 50)}"`);

  // ── Início ────────────────────────────────────────────────────────────────
  if (conversa.estado === "inicio") {
    conversas[remoteJid] = { ...conversa, estado: "aguardando_identificacao" };
    salvarConversas(conversas);

    const resposta = `Olá! 👋 Sou a assistente virtual da *360 Suítes*.\n\nPara te atender melhor, por favor me informe:\n\n📝 *Seu nome completo e e-mail cadastrado*`;
    await enviarMensagem(remoteJid, resposta);

    conversa.historico.push({ de: "bot", texto: resposta, hora: new Date().toISOString() });
    conversas[remoteJid] = { ...conversa, estado: "aguardando_identificacao" };
    salvarConversas(conversas);
    return;
  }

  // ── Aguardando identificação ─────────────────────────────────────────────
  if (conversa.estado === "aguardando_identificacao") {
    conversa.identificacao = texto;
    conversas[remoteJid] = { ...conversa, estado: "aguardando_direcao" };
    salvarConversas(conversas);

    const resposta = `Obrigado! 😊\n\nCom quem você gostaria de falar?\n\n*1️⃣* Júlia — _Distratos_\n*2️⃣* Miquéias — _Outros assuntos_\n\nDigite *1* ou *2*:`;
    await enviarMensagem(remoteJid, resposta);

    conversa.historico.push({ de: "bot", texto: resposta, hora: new Date().toISOString() });
    conversas[remoteJid] = { ...conversa, estado: "aguardando_direcao" };
    salvarConversas(conversas);
    return;
  }

  // ── Aguardando direção ────────────────────────────────────────────────────
  if (conversa.estado === "aguardando_direcao") {
    const opcao = texto.replace(/[^12]/g, "");

    if (opcao !== "1" && opcao !== "2") {
      await enviarMensagem(remoteJid, `Por favor, digite apenas *1* para Júlia ou *2* para Miquéias:`);
      return;
    }

    const responsavel = opcao === "1" ? "Júlia" : "Miquéias";
    const assuntoTipo = opcao === "1" ? "Distratos" : "Outros assuntos";

    conversa.responsavel = responsavel;
    conversa.assuntoTipo = assuntoTipo;
    conversas[remoteJid] = { ...conversa, estado: "aguardando_descricao" };
    salvarConversas(conversas);

    const resposta = `Certo! Você será atendido(a) por *${responsavel}* _(${assuntoTipo})_.\n\n📋 Por favor, descreva o que você precisa com o máximo de detalhes:`;
    await enviarMensagem(remoteJid, resposta);

    conversa.historico.push({ de: "bot", texto: resposta, hora: new Date().toISOString() });
    conversas[remoteJid] = { ...conversa, estado: "aguardando_descricao" };
    salvarConversas(conversas);
    return;
  }

  // ── Aguardando descrição ──────────────────────────────────────────────────
  if (conversa.estado === "aguardando_descricao") {
    conversa.descricaoOriginal = texto;
    conversas[remoteJid] = { ...conversa, estado: "processando" };
    salvarConversas(conversas);

    // Confirma recebimento imediatamente
    const confirmacao = `✅ Mensagem recebida!\n\nEm breve *${conversa.responsavel}* entrará em contato com você.\n\nObrigado por falar com a *360 Suítes*! 🏢`;
    await enviarMensagem(remoteJid, confirmacao);
    conversa.historico.push({ de: "bot", texto: confirmacao, hora: new Date().toISOString() });

    // Processa com IA em background
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

        const dadosTriagem = {
          id: `${remoteJid}_${Date.now()}`,
          remoteJid,
          telefone: remoteJid.replace("@s.whatsapp.net", "").replace(/\D/g, ""),
          identificacao: conversa.identificacao || "Não informada",
          responsavel: conversa.responsavel,
          assuntoTipo: conversa.assuntoTipo,
          descricaoOriginal: conversa.descricaoOriginal,
          resumo,
          sugestao,
          historico: conversa.historico,
          whatsappLink: `https://wa.me/${remoteJid.replace("@s.whatsapp.net", "").replace(/\D/g, "")}`,
          dataTriagem: new Date().toISOString(),
        };

        // Salva no arquivo de pendentes (painel)
        const pendentes = carregarPendentes();
        pendentes.push(dadosTriagem);
        salvarPendentes(pendentes);

        // Envia notificação no grupo de triagem
        await notificarGrupo(dadosTriagem);

        // Marca como concluído
        conversas[remoteJid] = { ...conversa, estado: "concluido" };
        salvarConversas(conversas);

        console.log(`✅ Triagem concluída: ${conversa.identificacao} → ${conversa.responsavel}`);
      } catch (err) {
        console.error("❌ Erro ao processar triagem:", err.message);
        conversas[remoteJid] = { ...conversa, estado: "concluido" };
        salvarConversas(conversas);
      }
    });
    return;
  }

  // ── Concluído — reinicia após 2h ─────────────────────────────────────────
  if (conversa.estado === "concluido" || conversa.estado === "processando") {
    const ultimaMensagem = conversa.historico?.[conversa.historico.length - 1];
    const diffMin = ultimaMensagem ? (Date.now() - new Date(ultimaMensagem.hora).getTime()) / 60000 : 999;

    if (diffMin > 120) {
      delete conversas[remoteJid];
      salvarConversas(conversas);
      await processarWebhook(remoteJid, textoRecebido);
    } else {
      await enviarMensagem(remoteJid, `Sua solicitação já foi registrada! Em breve *${conversa.responsavel}* entrará em contato. 😊`);
    }
  }
};

// ── Configura webhook ─────────────────────────────────────────────────────────
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
    console.log(`🔗 Webhook configurado: ${webhookUrl}`);
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
