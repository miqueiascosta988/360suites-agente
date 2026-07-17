// agente_whatsapp.js — Agente de leitura e resposta via WhatsApp (Evolution API)
const fs = require("fs");
const path = require("path");
const { chamarIA } = require("./ai");
const XLSX = require("xlsx");

const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "360suites";
const PENDENTES_WPP_PATH = path.resolve(__dirname, "whatsapp_pendentes.json");
const RESPONDIDOS_WPP_PATH = path.resolve(__dirname, "whatsapp_respondidos.json");
const FECHAMENTOS_DIR = path.resolve(__dirname, "fechamentos");
const AJUSTES_DIR = path.resolve(__dirname, "ajustes");

const headers = () => ({
  "Content-Type": "application/json",
  "apikey": EVOLUTION_KEY,
});

const carregarPendentes = () => {
  try { return fs.existsSync(PENDENTES_WPP_PATH) ? JSON.parse(fs.readFileSync(PENDENTES_WPP_PATH, "utf8")) : []; } catch { return []; }
};

const salvarPendentes = (p) => fs.writeFileSync(PENDENTES_WPP_PATH, JSON.stringify(p, null, 2), "utf8");

const carregarRespondidos = () => {
  try { return fs.existsSync(RESPONDIDOS_WPP_PATH) ? JSON.parse(fs.readFileSync(RESPONDIDOS_WPP_PATH, "utf8")) : {}; } catch { return {}; }
};

const salvarRespondido = (msgId, dados) => {
  const r = carregarRespondidos();
  r[msgId] = { ...dados, dataResposta: new Date().toISOString() };
  fs.writeFileSync(RESPONDIDOS_WPP_PATH, JSON.stringify(r, null, 2), "utf8");
};

const carregarProprietarios = () => {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8")); } catch { return []; }
};

const mesParaNumero = (mes) => {
  const meses = { janeiro:1, fevereiro:2, março:3, marco:3, abril:4, maio:5, junho:6, julho:7, agosto:8, setembro:9, outubro:10, novembro:11, dezembro:12 };
  return meses[mes?.toString().toLowerCase()] || null;
};

const encontrarAba = (wb, nomes) => {
  for (const nome of nomes) {
    const found = wb.SheetNames.find(s => s.toLowerCase().includes(nome.toLowerCase()));
    if (found) return found;
  }
  return null;
};

const buscarManutencoes = (unidade, fechamentoPath) => {
  try {
    const wb = XLSX.readFile(fechamentoPath);
    const sheetName = encontrarAba(wb, ["lancamentos_omie", "lancamentos", "lançamentos", "omie"]);
    if (!sheetName) return [];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
    if (!rows.length) return [];
    const isOmie = Object.keys(rows[0]).includes("Departamento");
    if (isOmie) {
      return rows
        .filter(r => (r["Departamento"]||"").toString().trim().toLowerCase() === unidade.toLowerCase() && (r["Categoria"]||"").toString().toLowerCase().includes("manut"))
        .map(m => ({ descricao: (m["Observação da Conta"]||"").toString().trim() || "Manutenção", valor: Math.abs(Number(m["Valor da Conta"])||0) }));
    }
    return rows
      .filter(r => r.unit_name?.toString().trim().toLowerCase() === unidade.toLowerCase() && r.category?.toString().toLowerCase().includes("manutencao"))
      .map(m => { const obs = (m.observations||"").toString(); return { descricao: obs.includes("|") ? obs.split("|").slice(1).join(" ").trim() : obs.trim(), valor: Number(m.value)||0 }; });
  } catch { return []; }
};

const getValorUnidade = (unidade, fechamentoPath) => {
  try {
    const wb = XLSX.readFile(fechamentoPath);
    const sheetName = encontrarAba(wb, ["unidades", "Unidades"]);
    if (!sheetName) return null;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
    const linha = rows.find(r => r.unit_name?.toString().trim().toLowerCase() === unidade.toLowerCase());
    if (!linha) return null;
    return {
      bruto: Number(linha["plc_less_cleaning"])||null,
      liquido: Number(linha["repasse_cliente_ajustado"])||null,
      ocupacao: Number(linha["nights_occupied_month"])||null,
    };
  } catch { return null; }
};

const calcularMediaPredio = (sigla, fechamentoPath) => {
  try {
    const wb = XLSX.readFile(fechamentoPath);
    const sheetName = encontrarAba(wb, ["unidades", "Unidades"]);
    if (!sheetName) return null;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
    const unidades = rows.filter(r => r.unit_name?.toString().trim().toUpperCase().startsWith(sigla.toUpperCase()));
    if (!unidades.length) return null;
    const brutos = unidades.map(r => Number(r["plc_less_cleaning"]||0)).filter(v => v > 0);
    const liquidos = unidades.map(r => Number(r["repasse_cliente_ajustado"]||0)).filter(v => v > 0);
    return {
      mediaBruta: brutos.length ? brutos.reduce((a,b) => a+b,0)/brutos.length : null,
      mediaLiquida: liquidos.length ? liquidos.reduce((a,b) => a+b,0)/liquidos.length : null,
      totalUnidades: unidades.length,
    };
  } catch { return null; }
};

const buscarAjuste = (unidade, mes, ano) => {
  try {
    const num = mesParaNumero(mes);
    if (!num) return null;
    const caminho = path.resolve(AJUSTES_DIR, `${ano}-${String(num).padStart(2,"0")}.json`);
    if (!fs.existsSync(caminho)) return null;
    return JSON.parse(fs.readFileSync(caminho,"utf8"))[unidade] || null;
  } catch { return null; }
};

// Busca mensagens recentes do WhatsApp via Evolution API
const buscarMensagensWhatsApp = async () => {
  const fetch = require("node-fetch");
  const res = await fetch(`${EVOLUTION_URL}/chat/findMessages/${EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      where: {
        key: { fromMe: false },
        messageTimestamp: { gte: Math.floor(Date.now() / 1000) - 86400 * 7 }, // últimos 7 dias
      },
      limit: 100,
    }),
  });
  const data = await res.json();
  return data?.messages?.records || [];
};

// Normaliza número de telefone para buscar proprietário
const normalizarTelefone = (jid) => {
  return jid?.replace("@s.whatsapp.net", "").replace("@c.us", "") || "";
};

const encontrarProprietarioPorTelefone = (telefone, proprietarios) => {
  const tel = telefone.replace(/\D/g, "");
  return proprietarios.find(p => {
    const telProp = (p.telefone || p.whatsapp || "").replace(/\D/g, "");
    return telProp && (tel.endsWith(telProp) || telProp.endsWith(tel));
  });
};

const gerarRespostaWhatsApp = async ({ nomeProprietario, mensagem, unidades, mes, ano }) => {
  const num = mesParaNumero(mes);
  const fechamentoPath = num
    ? (() => { const c = path.resolve(FECHAMENTOS_DIR, `${ano}-${String(num).padStart(2,"0")}.xlsx`); return fs.existsSync(c) ? c : null; })()
    : null;

  let blocos = "";
  if (fechamentoPath) {
    for (const unidade of unidades) {
      const sigla = unidade.replace(/[0-9]/g, "").trim();
      const manutencoes = buscarManutencoes(unidade, fechamentoPath);
      const valor = getValorUnidade(unidade, fechamentoPath);
      const media = calcularMediaPredio(sigla, fechamentoPath);
      const ajuste = buscarAjuste(unidade, mes, ano);
      const totalManut = manutencoes.reduce((a,m) => a+m.valor, 0);

      blocos += `\nUnidade ${unidade}:
  Bruto: R$ ${valor?.bruto?.toFixed(2)||"N/A"} | Líquido: R$ ${valor?.liquido?.toFixed(2)||"N/A"} | Ocupação: ${valor?.ocupacao||"N/A"} noites
  Média bruta do prédio: R$ ${media?.mediaBruta?.toFixed(2)||"N/A"} (${media?.totalUnidades||"N/A"} unidades)
  Manutenções: ${manutencoes.length > 0 ? manutencoes.map(m => `${m.descricao} (R$ ${m.valor.toFixed(2)})`).join("; ") : "Nenhuma"}
  Total manutenções: R$ ${totalManut.toFixed(2)}
  Ajuste: ${ajuste ? `R$ ${ajuste.diferenca?.toFixed(2)} ${ajuste.diferenca > 0 ? "(crédito)" : "(desconto)"}` : "Sem ajuste"}`;
    }
  }

  const prompt = `Você é assistente da 360 Suítes respondendo via WhatsApp de forma BREVE e DIRETA.

Proprietário: ${nomeProprietario}
Mensagem recebida: "${mensagem}"
Período de referência: ${mes}/${ano}

DADOS:${blocos || "\nPlanilha não disponível para o período informado."}

REGRAS:
- Resposta curta e objetiva (máximo 200 palavras)
- Formato WhatsApp (sem markdown, use *negrito* se necessário)
- Responda diretamente a dúvida
- Tom cordial e profissional
- Assine como "Equipe 360 Suítes"
- Retorne APENAS o texto da mensagem`;

  return chamarIA(prompt);
};

const verificarMensagensWhatsApp = async () => {
  console.log(`\n📱 [${new Date().toLocaleString("pt-BR")}] Verificando mensagens WhatsApp...`);

  const proprietarios = carregarProprietarios();
  const respondidos = carregarRespondidos();
  const mensagens = await buscarMensagensWhatsApp();

  console.log(`📬 ${mensagens.length} mensagem(ns) encontrada(s)`);

  const ano = process.env.ANO_REFERENCIA || "2026";
  const mes = process.env.MES_REFERENCIA || "Maio";

  const novas = [];
  const vistas = new Set();

  for (const msg of mensagens) {
    const msgId = msg.key?.id;
    if (!msgId || respondidos[msgId] || vistas.has(msgId)) continue;

    const telefone = normalizarTelefone(msg.key?.remoteJid);
    const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

    if (!texto || texto.length < 5) continue;

    const proprietario = encontrarProprietarioPorTelefone(telefone, proprietarios);
    if (!proprietario) {
      console.log(`⚠️ Proprietário não encontrado para ${telefone}`);
      continue;
    }

    vistas.add(msgId);
    console.log(`👤 ${proprietario.nome} | ${texto.substring(0, 60)}...`);

    const respostaSugerida = await gerarRespostaWhatsApp({
      nomeProprietario: proprietario.nome,
      mensagem: texto,
      unidades: proprietario.unidades,
      mes,
      ano,
    });

    novas.push({
      msgId,
      telefone,
      remoteJid: msg.key?.remoteJid,
      nome: proprietario.nome,
      mensagemRecebida: texto,
      respostaSugerida,
      timestamp: msg.messageTimestamp,
      dataVerificacao: new Date().toISOString(),
    });
  }

  if (novas.length > 0) {
    const pendentes = [...carregarPendentes(), ...novas];
    salvarPendentes(pendentes);
    console.log(`✅ ${novas.length} nova(s) mensagem(ns) aguardando aprovação`);
  }

  return { total: mensagens.length, novas: novas.length };
};

const enviarRespostaWhatsApp = async (remoteJid, texto) => {
  const fetch = require("node-fetch");
  const res = await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      number: remoteJid,
      text: texto,
    }),
  });
  return res.json();
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
