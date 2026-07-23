// agente_whatsapp.js — Triagem inteligente via WhatsApp (Evolution API)
const fs = require("fs");
const path = require("path");
const { chamarIA } = require("./ai");

const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "360suites";

const TRIAGEM_PATH = path.resolve(__dirname, "whatsapp_triagem.json");
const PENDENTES_PATH = path.resolve(__dirname, "whatsapp_pendentes.json");
const RESPONDIDOS_PATH = path.resolve(__dirname, "whatsapp_respondidos.json");

const headers = () => ({
  "Content-Type": "application/json",
  "apikey": EVOLUTION_KEY,
});

// ── Persistência ──────────────────────────────────────────────────────────────
const carregarTriagem = () => {
  try { return fs.existsSync(TRIAGEM_PATH) ? JSON.parse(fs.readFileSync(TRIAGEM_PATH, "utf8")) : {}; } catch { return {}; }
};
const salvarTriagem = (d) => fs.writeFileSync(TRIAGEM_PATH, JSON.stringify(d, null, 2), "utf8");

const carregarPendentes = () => {
  try { return fs.existsSync(PENDENTES_PATH) ? JSON.parse(fs.readFileSync(PENDENTES_PATH, "utf8")) : []; } catch { return []; }
};
const salvarPendentes = (d) => fs.writeFileSync(PENDENTES_PATH, JSON.stringify(d, null, 2), "utf8");

const carregarRespondidos = () => {
  try { return fs.existsSync(RESPONDIDOS_PATH) ? JSON.parse(fs.readFileSync(RESPONDIDOS_PATH, "utf8")) : {}; } catch { return {}; }
};
const salvarRespondido = (msgId, dados) => {
  const r = carregarRespondidos();
  r[msgId] = { ...dados, dataResposta: new Date().toISOString() };
  fs.writeFileSync(RESPONDIDOS_PATH, JSON.stringify(r, null, 2), "utf8");
};

const carregarProprietarios = () => {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8")); } catch { return []; }
};

// ── Busca proprietário ────────────────────────────────────────────────────────
const normalizarTelefone = (jid) => (jid || "").replace("@s.whatsapp.net", "").replace("@c.us", "").replace(/\D/g, "");

const encontrarProprietario = (telefone, email, proprietarios) => {
  const tel = normalizarTelefone(telefone);

  // Busca por telefone
  if (tel) {
    const porTel = proprietarios.find(p => {
      const telProp = (p.telefone || "").replace(/\D/g, "");
      return telProp && (tel.endsWith(telProp) || telProp.endsWith(tel) || tel.slice(-8) === telProp.slice(-8));
    });
    if (porTel) return porTel;
  }

  // Busca por e-mail
  if (email) {
    return proprietarios.find(p => p.email?.toLowerCase().trim() === email.toLowerCase().trim());
  }

  return null;
};

// ── Envio de mensagem ─────────────────────────────────────────────────────────
const enviarMensagem = async (remoteJid, texto) => {
  const fetch = require("node-fetch");
  const res = await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ number: remoteJid, text: texto }),
  });
  return res.json();
};

// ── Lógica de triagem por etapas ──────────────────────────────────────────────
/*
  Estados da conversa:
  - "inicio"       → primeira mensagem, pede e-mail
  - "aguardando_email" → aguarda e-mail para identificar
  - "aguardando_opcao" → identificado, aguarda 1 (Júlia) ou 2 (Miquéias)
  - "aguardando_descricao" → aguarda descrição do assunto
  - "concluido"    → triagem finalizada, aguarda no painel
*/

const processarMensagem = async (remoteJid, texto, msgId) => {
  const proprietarios = carregarProprietarios();
  const triagens = carregarTriagem();
  const conversa = triagens[remoteJid] || { estado: "inicio" };
  const textoLimpo = texto.trim();

  console.log(`📱 ${remoteJid} | Estado: ${conversa.estado} | Msg: ${textoLimpo.substring(0, 60)}`);

  // ── Etapa 1: Primeira mensagem ────────────────────────────────────────────
  if (conversa.estado === "inicio") {
    // Tenta identificar pelo telefone primeiro
    const proprietario = encontrarProprietario(remoteJid, null, proprietarios);

    if (proprietario) {
      // Já identificou pelo telefone
      triagens[remoteJid] = {
        estado: "aguardando_opcao",
        nome: proprietario.nome,
        email: proprietario.email,
        telefone: remoteJid,
        unidades: proprietario.unidades,
      };
      salvarTriagem(triagens);

      await enviarMensagem(remoteJid,
        `Olá, *${proprietario.nome}*! 👋\n\nSou a assistente virtual da *360 Suítes*.\n\nCom quem você gostaria de falar?\n\n*1️⃣* - Júlia _(Distratos)_\n*2️⃣* - Miquéias _(Outros assuntos)_\n\nDigite 1 ou 2:`
      );
    } else {
      // Pede e-mail
      triagens[remoteJid] = { estado: "aguardando_email" };
      salvarTriagem(triagens);

      await enviarMensagem(remoteJid,
        `Olá! 👋 Sou a assistente virtual da *360 Suítes*.\n\nPara te identificar, por favor informe seu *e-mail cadastrado*:`
      );
    }
    return;
  }

  // ── Etapa 2: Aguardando e-mail ────────────────────────────────────────────
  if (conversa.estado === "aguardando_email") {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const emailEncontrado = textoLimpo.match(emailRegex)?.[0];

    if (!emailEncontrado) {
      await enviarMensagem(remoteJid,
        `Não consegui identificar um e-mail válido. Por favor, informe seu *e-mail cadastrado* na 360 Suítes:`
      );
      return;
    }

    const proprietario = encontrarProprietario(remoteJid, emailEncontrado, proprietarios);

    if (!proprietario) {
      await enviarMensagem(remoteJid,
        `Não encontrei nenhum cadastro com o e-mail *${emailEncontrado}*.\n\nVerifique o e-mail e tente novamente, ou entre em contato diretamente pelo nosso WhatsApp: *+55 11 97632-0341*`
      );
      return;
    }

    triagens[remoteJid] = {
      estado: "aguardando_opcao",
      nome: proprietario.nome,
      email: proprietario.email,
      telefone: remoteJid,
      unidades: proprietario.unidades,
    };
    salvarTriagem(triagens);

    await enviarMensagem(remoteJid,
      `Olá, *${proprietario.nome}*! ✅\n\nCom quem você gostaria de falar?\n\n*1️⃣* - Júlia _(Distratos)_\n*2️⃣* - Miquéias _(Outros assuntos)_\n\nDigite 1 ou 2:`
    );
    return;
  }

  // ── Etapa 3: Aguardando opção ─────────────────────────────────────────────
  if (conversa.estado === "aguardando_opcao") {
    const opcao = textoLimpo.replace(/[^12]/g, "");

    if (opcao !== "1" && opcao !== "2") {
      await enviarMensagem(remoteJid,
        `Por favor, digite apenas *1* para Júlia ou *2* para Miquéias:`
      );
      return;
    }

    const responsavel = opcao === "1" ? "Júlia" : "Miquéias";
    const assunto = opcao === "1" ? "Distratos" : "Outros assuntos";

    triagens[remoteJid] = {
      ...conversa,
      estado: "aguardando_descricao",
      responsavel,
      assunto,
    };
    salvarTriagem(triagens);

    await enviarMensagem(remoteJid,
      `Ótimo! Você será atendido(a) por *${responsavel}* _(${assunto})_.\n\nPor favor, descreva brevemente o que você precisa:`
    );
    return;
  }

  // ── Etapa 4: Aguardando descrição ─────────────────────────────────────────
  if (conversa.estado === "aguardando_descricao") {
    // Resume o assunto com IA
    let resumo = textoLimpo;
    try {
      resumo = await chamarIA(
        `Resuma em no máximo 2 frases objetivas o seguinte assunto de um proprietário de apartamento:\n"${textoLimpo}"`
      );
    } catch (e) {
      console.warn("⚠️ Erro ao resumir com IA:", e.message);
    }

    // Adiciona ao painel
    const pendentes = carregarPendentes();
    const novaPendente = {
      msgId,
      remoteJid,
      nome: conversa.nome,
      email: conversa.email,
      telefone: normalizarTelefone(remoteJid),
      unidades: conversa.unidades,
      responsavel: conversa.responsavel,
      assunto: conversa.assunto,
      descricaoOriginal: textoLimpo,
      resumo,
      whatsappLink: `https://wa.me/${normalizarTelefone(remoteJid)}`,
      dataTriagem: new Date().toISOString(),
    };
    pendentes.push(novaPendente);
    salvarPendentes(pendentes);

    // Marca conversa como concluída
    triagens[remoteJid] = { ...conversa, estado: "concluido" };
    salvarTriagem(triagens);

    await enviarMensagem(remoteJid,
      `✅ Mensagem recebida!\n\nEm breve *${conversa.responsavel}* entrará em contato com você.\n\nObrigado por entrar em contato com a *360 Suítes*! 🏢`
    );

    console.log(`✅ Triagem concluída: ${conversa.nome} → ${conversa.responsavel} | ${resumo}`);
    return;
  }

  // ── Estado concluído: reinicia se mandar nova mensagem ───────────────────
  if (conversa.estado === "concluido") {
    triagens[remoteJid] = { estado: "inicio" };
    salvarTriagem(triagens);
    await processarMensagem(remoteJid, textoLimpo, msgId);
  }
};

// ── Busca mensagens novas e processa ─────────────────────────────────────────
const verificarMensagensWhatsApp = async () => {
  const fetch = require("node-fetch");
  console.log(`\n📱 [${new Date().toLocaleString("pt-BR")}] Verificando mensagens WhatsApp...`);

  const res = await fetch(`${EVOLUTION_URL}/chat/findMessages/${EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      where: {
        key: { fromMe: false },
        messageTimestamp: { gte: Math.floor(Date.now() / 1000) - 3600 }, // última hora
      },
      limit: 50,
    }),
  });

  const data = await res.json();
  const mensagens = data?.messages?.records || [];
  console.log(`📬 ${mensagens.length} mensagem(ns) encontrada(s)`);

  const respondidos = carregarRespondidos();
  let processadas = 0;

  for (const msg of mensagens) {
    const msgId = msg.key?.id;
    if (!msgId || respondidos[msgId]) continue;

    const remoteJid = msg.key?.remoteJid;
    const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

    if (!texto || texto.length < 2 || remoteJid?.includes("@g.us")) continue; // ignora grupos

    try {
      await processarMensagem(remoteJid, texto, msgId);
      salvarRespondido(msgId, { remoteJid, texto });
      processadas++;
    } catch (err) {
      console.error(`❌ Erro ao processar ${remoteJid}: ${err.message}`);
    }
  }

  const pendentes = carregarPendentes();
  console.log(`✅ ${processadas} mensagem(ns) processada(s) | ${pendentes.length} pendente(s) no painel`);
  return { total: mensagens.length, processadas, pendentes: pendentes.length };
};

const enviarRespostaWhatsApp = async (remoteJid, texto) => {
  return enviarMensagem(remoteJid, texto);
};

const removerPendente = (msgId) => {
  const pendentes = carregarPendentes().filter(p => p.msgId !== msgId);
  salvarPendentes(pendentes);
};

module.exports = {
  verificarMensagensWhatsApp,
  enviarRespostaWhatsApp,
  carregarPendentes,
  removerPendente,
  salvarRespondido,
};
