require("dotenv").config();
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const chamarGemini = async (prompt) => {
  const result = await gemini.generateContent(prompt);
  return result.response.text();
};

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const SHEETS_ID = "1Ng1HyjYWf3iwxKcCQkkVQKy9IhOwpBRnHk-sEFltwCI";
const WHATSAPP_NUMBER = "5511976320341";
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_NUMBER}`;
const NOTIFICACOES_PATH = path.resolve(__dirname, "bloqueios_notificados.json");
const MIN_NOITES = 3; // só notifica bloqueios maiores que 3 dias

// Carrega registro de notificações já enviadas
const carregarNotificados = () => {
  try {
    if (!fs.existsSync(NOTIFICACOES_PATH)) return {};
    return JSON.parse(fs.readFileSync(NOTIFICACOES_PATH, "utf8"));
  } catch { return {}; }
};

const salvarNotificados = (dados) => {
  fs.writeFileSync(NOTIFICACOES_PATH, JSON.stringify(dados, null, 2), "utf8");
};

// Gera hash único para cada bloqueio
const gerarHash = (row) => {
  return `${row.nickname}_${row.inicio}_${row.fim}_${row.motivo}`.replace(/\s+/g, "_").toLowerCase();
};

// Lê planilha de bloqueios via Google Sheets API
const lerBloqueios = async () => {
  const sheets = google.sheets({ version: "v4", auth: oauth2Client });

  // Lê aba Bloqueios
  const bloqueiosRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: "Bloqueios!A:J",
  });

  // Lê aba DB_Proprietarios
  const propsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: "DB_Proprietarios!A:K",
  });

  const bloqueiosRows = bloqueiosRes.data.values || [];
  const propsRows = propsRes.data.values || [];

  if (bloqueiosRows.length < 2) return [];

  const headers = bloqueiosRows[0].map(h => h.toLowerCase().trim());
  const idxSubaccount = headers.findIndex(h => h.includes("subaccount"));
  const idxNickname = headers.findIndex(h => h.includes("nickname"));
  const idxMotivo = headers.findIndex(h => h.includes("motivo"));
  const idxNotas = headers.findIndex(h => h.includes("notas"));
  const idxInicio = headers.findIndex(h => h.includes("inicio"));
  const idxFim = headers.findIndex(h => h.includes("fim"));
  const idxNoites = headers.findIndex(h => h.includes("noites"));

  // Monta mapa de proprietários por unidade
  const propsHeaders = propsRows[0]?.map(h => h.toLowerCase().trim()) || [];
  const idxNome = propsHeaders.findIndex(h => h.includes("nome do proprietário") || h.includes("nome do proprietario"));
  const idxEmail = propsHeaders.findIndex(h => h.includes("email proprietário") || h.includes("email proprietario"));
  const idxUnidade = propsHeaders.findIndex(h => h.includes("nome") && !h.includes("proprietário"));

  const propMap = {};
  for (let i = 1; i < propsRows.length; i++) {
    const row = propsRows[i];
    const unidade = row[0]?.trim();
    const nome = row[idxNome]?.trim();
    const email = row[idxEmail]?.trim();
    if (unidade && email) {
      propMap[unidade.toLowerCase()] = { nome, email };
    }
  }

  // Filtra bloqueios relevantes
  const bloqueios = [];
  for (let i = 1; i < bloqueiosRows.length; i++) {
    const row = bloqueiosRows[i];
    const subaccount = row[idxSubaccount]?.trim() || "";
    const nickname = row[idxNickname]?.trim() || "";
    const motivo = row[idxMotivo]?.trim() || "";
    const notas = row[idxNotas]?.trim() || "";
    const inicio = row[idxInicio]?.trim() || "";
    const fim = row[idxFim]?.trim() || "";
    const noites = parseInt(row[idxNoites]) || 0;

    // Filtra: só 360 FULL + motivo Maintenance ou outros relevantes + mais de 3 noites
    const motivoRelevante = motivo.toLowerCase().includes("maintenance") ||
      motivo.toLowerCase().includes("bloqueio manual") ||
      motivo.toLowerCase().includes("emergency");

    if (subaccount !== "360 FULL" || !motivoRelevante || noites <= MIN_NOITES) continue;

    const prop = propMap[nickname.toLowerCase()];
    if (!prop?.email) continue;

    bloqueios.push({
      nickname,
      motivo,
      notas,
      inicio,
      fim,
      noites,
      nome: prop.nome,
      email: prop.email,
      hash: gerarHash({ nickname, inicio, fim, motivo }),
    });
  }

  return bloqueios;
};

// Gera mensagem com Claude
const gerarMensagem = async (bloqueio, tipo) => {
  const prompt = `Você é um assistente da 360 Suítes. Gere uma mensagem ${tipo === "email" ? "de e-mail" : "de WhatsApp"} para o proprietário abaixo informando sobre um bloqueio na unidade dele.

Proprietário: ${bloqueio.nome}
Unidade: ${bloqueio.nickname}
Motivo do bloqueio: ${bloqueio.motivo}
${bloqueio.notas ? `Detalhes: ${bloqueio.notas}` : ""}
Período: ${bloqueio.inicio} a ${bloqueio.fim} (${bloqueio.noites} noites)

REGRAS:
- Tom corporativo mas amistoso
- Informe que já estamos cientes e trabalhando na resolução
- NÃO dê prazo de resolução
- Diga que o objetivo é minimizar o impacto o máximo possível
- Seja breve e objetivo
- ${tipo === "whatsapp" ? "Formato adequado para WhatsApp, mais informal" : "Formato de e-mail formal"}
- ${tipo === "email" ? "Assine como 'Equipe 360 Suítes'" : "Assine como '360 Suítes'"}

Retorne APENAS o texto da mensagem, sem comentários extras.`;

  return chamarGemini(prompt);
};

// Executa verificação de bloqueios
const verificarBloqueios = async () => {
  console.log(`\n🔒 [${new Date().toLocaleString("pt-BR")}] Verificando bloqueios...`);

  try {
    const bloqueios = await lerBloqueios();
    console.log(`📋 ${bloqueios.length} bloqueio(s) relevante(s) encontrado(s)`);

    const notificados = carregarNotificados();
    const novos = bloqueios.filter(b => !notificados[b.hash]);

    console.log(`🆕 ${novos.length} novo(s) bloqueio(s) para notificar`);

    if (novos.length === 0) return { total: bloqueios.length, novos: 0, notificados: 0 };

    // Gera mensagens para aprovação no painel
    const pendentes = [];
    for (const bloqueio of novos) {
      console.log(`✉️ Gerando mensagem para ${bloqueio.nickname} (${bloqueio.nome})...`);
      const msgEmail = await gerarMensagem(bloqueio, "email");
      const msgWhatsapp = await gerarMensagem(bloqueio, "whatsapp");

      pendentes.push({
        ...bloqueio,
        msgEmail,
        msgWhatsapp,
        whatsappLink: `${WHATSAPP_LINK}?text=${encodeURIComponent(msgWhatsapp)}`,
      });
    }

    // Salva pendentes para o painel aprovar
    const pendentesPath = path.resolve(__dirname, "bloqueios_pendentes.json");
    fs.writeFileSync(pendentesPath, JSON.stringify(pendentes, null, 2), "utf8");

    console.log(`✅ ${pendentes.length} notificação(ões) aguardando aprovação no painel`);
    return { total: bloqueios.length, novos: novos.length, pendentes: pendentes.length };

  } catch (err) {
    console.error("❌ Erro ao verificar bloqueios:", err.message);
    throw err;
  }
};

// Marca bloqueio como notificado após aprovação
const marcarNotificado = (hash, tipo) => {
  const notificados = carregarNotificados();
  notificados[hash] = {
    dataEnvio: new Date().toISOString(),
    tipo,
  };
  salvarNotificados(notificados);
};

// Carrega pendentes para o painel
const carregarPendentes = () => {
  const pendentesPath = path.resolve(__dirname, "bloqueios_pendentes.json");
  try {
    if (!fs.existsSync(pendentesPath)) return [];
    return JSON.parse(fs.readFileSync(pendentesPath, "utf8"));
  } catch { return []; }
};

// Remove pendente após aprovação
const removerPendente = (hash) => {
  const pendentesPath = path.resolve(__dirname, "bloqueios_pendentes.json");
  const pendentes = carregarPendentes().filter(p => p.hash !== hash);
  fs.writeFileSync(pendentesPath, JSON.stringify(pendentes, null, 2), "utf8");
};

module.exports = { verificarBloqueios, marcarNotificado, carregarPendentes, removerPendente };
