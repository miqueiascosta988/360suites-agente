// agente.js — Agente de análise de performance

const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const { chamarIA } = require("./ai");
const { buscarMensagens, lerMensagem, enviarResposta } = require("./gmail");

const FECHAMENTOS_DIR = path.resolve(__dirname, "fechamentos");
const AJUSTES_DIR = path.resolve(__dirname, "ajustes");

const mesParaNumero = (mes) => {
  const meses = { janeiro:1, fevereiro:2, março:3, marco:3, abril:4, maio:5, junho:6, julho:7, agosto:8, setembro:9, outubro:10, novembro:11, dezembro:12 };
  return meses[mes.toString().toLowerCase()] || null;
};

const getFechamentoPath = (mes, ano) => {
  const num = mesParaNumero(mes);
  if (!num) return null;
  const nome = `${ano}-${String(num).padStart(2, "0")}.xlsx`;
  const caminho = path.resolve(FECHAMENTOS_DIR, nome);
  return fs.existsSync(caminho) ? caminho : null;
};

const encontrarAba = (workbook, nomes) => {
  for (const nome of nomes) {
    const found = workbook.SheetNames.find(s => s.toLowerCase().includes(nome.toLowerCase()));
    if (found) return found;
  }
  return null;
};

const carregarPredios = () => {
  try {
    const wb = XLSX.readFile(path.resolve(__dirname, "predios.xlsx"));
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const map = {};
    for (const row of rows) {
      if (row.unit && row.property_name) {
        const sigla = row.unit.toString().replace(/[0-9\s]/g, "").trim().toUpperCase();
        if (sigla && !map[sigla]) map[sigla] = row.property_name.toString().trim();
      }
    }
    return map;
  } catch { return {}; }
};

const PREDIOS = carregarPredios();
console.log(`🏢 ${Object.keys(PREDIOS).length} prédios carregados`);

const getSigla = (u) => u.replace(/[0-9]/g, "").trim();
const getNomePredio = (u) => PREDIOS[getSigla(u)] || `Prédio ${getSigla(u)}`;

const carregarProprietarios = () => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
  } catch { return []; }
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
      ocupacao: linha["nights_occupied_month"]||null,
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

const buscarEmails = async () => {
  const proprietarios = carregarProprietarios();
  const anoBusca = process.env.ANO_REFERENCIA || "2026";

  console.log(`🔍 Buscando e-mails de Performance ${anoBusca}...`);
  const mensagens = await buscarMensagens(`is:unread subject:Performance subject:${anoBusca}`);
  const limite = process.env.TEST_MSG_LIMIT ? Number(process.env.TEST_MSG_LIMIT) : mensagens.length;
  console.log(`📬 ${mensagens.length} mensagem(ns) encontrada(s), processando ${Math.min(limite, mensagens.length)}`);

  const emailsPorProprietario = new Map();

  for (const msg of mensagens.slice(0, limite)) {
    const { id, threadId, assunto, de: emailRemetente, corpo } = await lerMensagem(msg.id);
    console.log(`👤 ${emailRemetente} | ${assunto}`);

    if (process.env.TEST_EMAIL_REMETENTE && emailRemetente.toLowerCase() !== process.env.TEST_EMAIL_REMETENTE.toLowerCase()) continue;

    const proprietario = proprietarios.find(p => p.email.toLowerCase() === emailRemetente.toLowerCase());
    if (!proprietario) { console.log(`⚠️ Proprietário não encontrado`); continue; }

    const anoMatch = assunto.match(/(\d{4})/);
    const ano = anoMatch ? anoMatch[1] : anoBusca;
    const mesesNomes = ["janeiro","fevereiro","março","marco","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
    const mesesEncontrados = mesesNomes.filter(m => assunto.toLowerCase().includes(m));
    const meses = mesesEncontrados.length > 0 ? mesesEncontrados.map(m => m.charAt(0).toUpperCase()+m.slice(1)) : [process.env.MES_REFERENCIA||"Abril"];

    const chave = `${emailRemetente}__${ano}`;
    if (!emailsPorProprietario.has(chave)) {
      emailsPorProprietario.set(chave, { id, threadId, de: emailRemetente, nome: proprietario.nome, unidades: proprietario.unidades, assunto, corpo, meses, ano });
    }
  }

  const resultados = [];

  for (const [, emailData] of emailsPorProprietario) {
    const { id, threadId, de, nome, unidades, assunto, corpo, meses, ano } = emailData;
    if (process.env.TEST_UNIT && !unidades.includes(process.env.TEST_UNIT)) continue;

    const dadosUnidades = [];
    for (const mes of meses) {
      for (const unidade of unidades) {
        if (process.env.TEST_UNIT && unidade !== process.env.TEST_UNIT) continue;
        const fechamentoPath = getFechamentoPath(mes, ano);
        if (!fechamentoPath) { console.warn(`⚠️ Planilha não encontrada: ${mes}/${ano}`); continue; }

        const manutencoes = buscarManutencoes(unidade, fechamentoPath);
        const sigla = getSigla(unidade);
        const nomePredio = getNomePredio(unidade);
        const mediaPredio = calcularMediaPredio(sigla, fechamentoPath);
        const valorUnidade = getValorUnidade(unidade, fechamentoPath);
        const ajuste = buscarAjuste(unidade, mes, ano);

        console.log(`🏢 ${unidade} | ${nomePredio} | Bruto: R$ ${valorUnidade?.bruto?.toFixed(2)||"N/A"}`);
        dadosUnidades.push({ unidade, mes, nomePredio, manutencoes, mediaPredio, valorUnidade, ajuste });
      }
    }

    if (!dadosUnidades.length) continue;

    console.log(`🤖 Gerando resposta para ${nome}...`);
    const resposta = await gerarResposta({ nomeProprietario: nome, emailProprietario: corpo, dadosUnidades, ano });
    console.log(`✅ Resposta gerada para ${nome}`);

    resultados.push({ id, de, nome, unidades: dadosUnidades.map(d => d.unidade), assunto, emailRecebido: corpo, respostaSugerida: resposta, threadId });
  }

  return resultados;
};

const gerarResposta = async ({ nomeProprietario, emailProprietario, dadosUnidades, ano }) => {
  const blocos = dadosUnidades.map(d => {
    const totalManut = d.manutencoes.reduce((a,m) => a+m.valor, 0);
    const listaManut = d.manutencoes.length > 0
      ? d.manutencoes.map((m,i) => `  ${i+1}. ${m.descricao} — R$ ${m.valor.toFixed(2)}`).join("\n")
      : "  Nenhuma manutenção registrada.";
    const ajusteInfo = d.ajuste
      ? `  Ajuste mês anterior: R$ ${d.ajuste.diferenca.toFixed(2)} ${d.ajuste.diferenca > 0 ? "(crédito)" : "(desconto)"}`
      : "  Sem ajuste de mês anterior.";
    return `UNIDADE ${d.unidade} — ${d.nomePredio} | ${d.mes}/${ano}:
  Faturamento bruto: R$ ${d.valorUnidade?.bruto?.toFixed(2)||"N/A"}
  Faturamento líquido: R$ ${d.valorUnidade?.liquido?.toFixed(2)||"N/A"}
  Noites ocupadas: ${d.valorUnidade?.ocupacao||"N/A"}
  Média bruta do prédio: R$ ${d.mediaPredio?.mediaBruta?.toFixed(2)||"N/A"} (${d.mediaPredio?.totalUnidades||"N/A"} unidades)
  Média líquida do prédio: R$ ${d.mediaPredio?.mediaLiquida?.toFixed(2)||"N/A"}
  Manutenções:\n${listaManut}
  Total manutenções: R$ ${totalManut.toFixed(2)}
${ajusteInfo}`;
  }).join("\n\n");

  const mesesTexto = [...new Set(dadosUnidades.map(d => `${d.mes}/${ano}`))].join(" e ");

  const prompt = `Você é um especialista em relacionamento com proprietários da 360 Suítes, empresa de gestão de apartamentos de curta temporada em São Paulo.

Proprietário: ${nomeProprietario}
Período: ${mesesTexto}

E-MAIL RECEBIDO DO PROPRIETÁRIO:
---
${emailProprietario}
---

DADOS DAS UNIDADES:
${blocos}

REGRAS:
1. Responda em UM ÚNICO e-mail cobrindo todas as unidades
2. Identifique o tema da dúvida e responda priorizando esse tema
3. Compare faturamento com média do prédio — destaque se acima, contextualize se abaixo
4. Explique cada manutenção detalhadamente se perguntado
5. Mencione ajustes de mês anterior com clareza
6. Tom cordial, profissional e consultivo. Nunca invente dados
7. Responda em português brasileiro
8. Assine como "Equipe 360 Suítes"
9. Retorne APENAS o texto do e-mail, sem comentários extras`;

  return chamarIA(prompt);
};

module.exports = { buscarEmails, enviarResposta };
