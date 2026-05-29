// agente_bloqueios.js — Monitoramento de bloqueios
require("dotenv").config();
const { google } = require("googleapis");
const { chamarIA } = require("./ai");
const { criarOAuth2, getAccessToken } = require("./gmail");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const SHEETS_ID = "1Ng1HyjYWf3iwxKcCQkkVQKy9IhOwpBRnHk-sEFltwCI";
const WHATSAPP_LINK = "https://wa.me/5511976320341";
const NOTIFICACOES_PATH = path.resolve(__dirname, "bloqueios_notificados.json");
const PENDENTES_PATH = path.resolve(__dirname, "bloqueios_pendentes.json");
const MIN_NOITES = 3;

const carregarNotificados = () => {
  try { return fs.existsSync(NOTIFICACOES_PATH) ? JSON.parse(fs.readFileSync(NOTIFICACOES_PATH,"utf8")) : {}; } catch { return {}; }
};
const salvarNotificados = (d) => fs.writeFileSync(NOTIFICACOES_PATH, JSON.stringify(d,null,2),"utf8");
const gerarHash = (r) => `${r.nickname}_${r.inicio}_${r.fim}_${r.motivo}`.replace(/\s+/g,"_").toLowerCase();

const lerBloqueios = async () => {
  const auth = criarOAuth2();
  const sheets = google.sheets({ version: "v4", auth });

  const [bloqueiosRes, propsRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range: "Bloqueios!A:J" }),
    sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range: "DB_Proprietarios!A:K" }),
  ]);

  const bloqueiosRows = bloqueiosRes.data.values || [];
  const propsRows = propsRes.data.values || [];
  if (bloqueiosRows.length < 2) return [];

  const h = bloqueiosRows[0].map(x => x.toLowerCase().trim());
  const idx = { subaccount: h.findIndex(x => x.includes("subaccount")), nickname: h.findIndex(x => x.includes("nickname")), motivo: h.findIndex(x => x.includes("motivo")), notas: h.findIndex(x => x.includes("notas")), inicio: h.findIndex(x => x.includes("inicio")), fim: h.findIndex(x => x.includes("fim")), noites: h.findIndex(x => x.includes("noites")) };

  const ph = propsRows[0]?.map(x => x.toLowerCase().trim()) || [];
  const pidxNome = ph.findIndex(x => x.includes("nome do proprietário") || x.includes("nome do proprietario"));
  const pidxEmail = ph.findIndex(x => x.includes("email proprietário") || x.includes("email proprietario"));

  const propMap = {};
  for (let i = 1; i < propsRows.length; i++) {
    const r = propsRows[i];
    if (r[0]?.trim() && r[pidxEmail]?.trim()) propMap[r[0].trim().toLowerCase()] = { nome: r[pidxNome]?.trim(), email: r[pidxEmail]?.trim() };
  }

  const bloqueios = [];
  for (let i = 1; i < bloqueiosRows.length; i++) {
    const r = bloqueiosRows[i];
    const subaccount = r[idx.subaccount]?.trim()||"";
    const nickname = r[idx.nickname]?.trim()||"";
    const motivo = r[idx.motivo]?.trim()||"";
    const noites = parseInt(r[idx.noites])||0;
    const motivoOk = motivo.toLowerCase().includes("maintenance") || motivo.toLowerCase().includes("bloqueio manual") || motivo.toLowerCase().includes("emergency");
    if (subaccount !== "360 FULL" || !motivoOk || noites <= MIN_NOITES) continue;
    const prop = propMap[nickname.toLowerCase()];
    if (!prop?.email) continue;
    bloqueios.push({ nickname, motivo, notas: r[idx.notas]?.trim()||"", inicio: r[idx.inicio]?.trim()||"", fim: r[idx.fim]?.trim()||"", noites, nome: prop.nome, email: prop.email, hash: gerarHash({ nickname, inicio: r[idx.inicio]?.trim()||"", fim: r[idx.fim]?.trim()||"", motivo }) });
  }
  return bloqueios;
};

const gerarMensagem = async (b, tipo) => {
  const prompt = `Você é um assistente da 360 Suítes. Gere uma mensagem ${tipo === "email" ? "de e-mail formal" : "de WhatsApp informal"} informando o proprietário sobre um bloqueio.

Proprietário: ${b.nome}
Unidade: ${b.nickname}
Motivo: ${b.motivo}${b.notas ? `\nDetalhes: ${b.notas}` : ""}
Período: ${b.inicio} a ${b.fim} (${b.noites} noites)

REGRAS: Tom amistoso. Já estamos cientes e trabalhando. Sem prazo. Minimizar impacto. Breve e objetivo.
Assine como "${tipo === "email" ? "Equipe 360 Suítes" : "360 Suítes"}".
Retorne APENAS o texto, sem comentários.`;
  return chamarIA(prompt);
};

const verificarBloqueios = async () => {
  console.log(`\n🔒 Verificando bloqueios...`);
  const bloqueios = await lerBloqueios();
  console.log(`📋 ${bloqueios.length} bloqueio(s) relevante(s)`);

  const notificados = carregarNotificados();
  const novos = bloqueios.filter(b => !notificados[b.hash]);
  console.log(`🆕 ${novos.length} novo(s)`);
  if (!novos.length) return { total: bloqueios.length, novos: 0 };

  const pendentes = [];
  for (const b of novos) {
    console.log(`✉️ Gerando mensagens para ${b.nickname}...`);
    const [msgEmail, msgWhatsapp] = await Promise.all([gerarMensagem(b,"email"), gerarMensagem(b,"whatsapp")]);
    pendentes.push({ ...b, msgEmail, msgWhatsapp, whatsappLink: `${WHATSAPP_LINK}?text=${encodeURIComponent(msgWhatsapp)}` });
  }

  fs.writeFileSync(PENDENTES_PATH, JSON.stringify(pendentes,null,2),"utf8");
  console.log(`✅ ${pendentes.length} aguardando aprovação`);
  return { total: bloqueios.length, novos: novos.length, pendentes: pendentes.length };
};

const marcarNotificado = (hash, tipo) => {
  const n = carregarNotificados();
  n[hash] = { dataEnvio: new Date().toISOString(), tipo };
  salvarNotificados(n);
};

const carregarPendentes = () => {
  try { return fs.existsSync(PENDENTES_PATH) ? JSON.parse(fs.readFileSync(PENDENTES_PATH,"utf8")) : []; } catch { return []; }
};

const removerPendente = (hash) => {
  const pendentes = carregarPendentes().filter(p => p.hash !== hash);
  fs.writeFileSync(PENDENTES_PATH, JSON.stringify(pendentes,null,2),"utf8");
};

module.exports = { verificarBloqueios, marcarNotificado, carregarPendentes, removerPendente };
