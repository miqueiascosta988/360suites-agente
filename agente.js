// agente.js â€” Agente de anÃ¡lise de performance

const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const { chamarIA } = require("./ai");
const { buscarMensagens, lerMensagem, enviarResposta } = require("./gmail");

const FECHAMENTOS_DIR = path.resolve(__dirname, "fechamentos");
const AJUSTES_DIR = path.resolve(__dirname, "ajustes");

const mesParaNumero = (mes) => {
  const meses = { janeiro:1, fevereiro:2, marÃ§o:3, marco:3, abril:4, maio:5, junho:6, julho:7, agosto:8, setembro:9, outubro:10, novembro:11, dezembro:12 };
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

let PREDIOS = {}; try { PREDIOS = carregarPredios(); } catch(e) { console.warn("predios.xlsx nao encontrado"); }
console.log(`ðŸ¢ ${Object.keys(PREDIOS).length} prÃ©dios carregados`);

const getSigla = (u) => u.replace(/[0-9]/g, "").trim();
const getNomePredio = (u) => PREDIOS[getSigla(u)] || `PrÃ©dio ${getSigla(u)}`;

const carregarProprietarios = () => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8"));
  } catch { return []; }
};

const buscarManutencoes = (unidade, fechamentoPath) => {
  try {
    const wb = XLSX.readFile(fechamentoPath);
    const sheetName = encontrarAba(wb, ["lancamentos_omie", "lancamentos", "lanÃ§amentos", "omie"]);
    if (!sheetName) return [];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
    if (!rows.length) return [];
    const isOmie = Object.keys(rows[0]).includes("Departamento");
    if (isOmie) {
      return rows
        .filter(r => (r["Departamento"]||"").toString().trim().toLowerCase() === unidade.toLowerCase() && (r["Categoria"]||"").toString().toLowerCase().includes("manut"))
        .map(m => ({ descricao: (m["ObservaÃ§Ã£o da Conta"]||"").toString().trim() || "ManutenÃ§Ã£o", valor: Math.abs(Number(m["Valor da Conta"])||0) }));
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

  console.log(`ðŸ” Buscando e-mails de Performance ${anoBusca}...`);
  const mensagens = await buscarMensagens(`is:unread subject:Performance subject:${anoBusca}`);
  const limite = process.env.TEST_MSG_LIMIT ? Number(process.env.TEST_MSG_LIMIT) : mensagens.length;
  console.log(`ðŸ“¬ ${mensagens.length} mensagem(ns) encontrada(s), processando ${Math.min(limite, mensagens.length)}`);

  const emailsPorProprietario = new Map();

  for (const msg of mensagens.slice(0, limite)) {
    const { id, threadId, assunto, de: emailRemetente, corpo } = await lerMensagem(msg.id);
    console.log(`ðŸ‘¤ ${emailRemetente} | ${assunto}`);

    if (process.env.TEST_EMAIL_REMETENTE && emailRemetente.toLowerCase() !== process.env.TEST_EMAIL_REMETENTE.toLowerCase()) continue;

    const proprietario = proprietarios.find(p => p.email.toLowerCase() === emailRemetente.toLowerCase());
    if (!proprietario) { console.log(`âš ï¸ ProprietÃ¡rio nÃ£o encontrado`); continue; }

    const anoMatch = assunto.match(/(\d{4})/);
    const ano = anoMatch ? anoMatch[1] : anoBusca;
    const mesesNomes = ["janeiro","fevereiro","marÃ§o","marco","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
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
        if (!fechamentoPath) { console.warn(`âš ï¸ Planilha nÃ£o encontrada: ${mes}/${ano}`); continue; }

        const manutencoes = buscarManutencoes(unidade, fechamentoPath);
        const sigla = getSigla(unidade);
        const nomePredio = getNomePredio(unidade);
        const mediaPredio = calcularMediaPredio(sigla, fechamentoPath);
        const valorUnidade = getValorUnidade(unidade, fechamentoPath);
        const ajuste = buscarAjuste(unidade, mes, ano);

        console.log(`ðŸ¢ ${unidade} | ${nomePredio} | Bruto: R$ ${valorUnidade?.bruto?.toFixed(2)||"N/A"}`);
        dadosUnidades.push({ unidade, mes, nomePredio, manutencoes, mediaPredio, valorUnidade, ajuste });
      }
    }

    if (!dadosUnidades.length) continue;

    console.log(`ðŸ¤– Gerando resposta para ${nome}...`);
    const resposta = await gerarResposta({ nomeProprietario: nome, emailProprietario: corpo, dadosUnidades, ano });
    console.log(`âœ… Resposta gerada para ${nome}`);

    resultados.push({ id, de, nome, unidades: dadosUnidades.map(d => d.unidade), assunto, emailRecebido: corpo, respostaSugerida: resposta, threadId });
  }

  return resultados;
};

const gerarResposta = async ({ nomeProprietario, emailProprietario, dadosUnidades, ano }) => {
  const blocos = dadosUnidades.map(d => {
    const totalManut = d.manutencoes.reduce((a,m) => a+m.valor, 0);
    const listaManut = d.manutencoes.length > 0
      ? d.manutencoes.map((m,i) => `  ${i+1}. ${m.descricao} â€” R$ ${m.valor.toFixed(2)}`).join("\n")
      : "  Nenhuma manutenÃ§Ã£o registrada.";
    const ajusteInfo = d.ajuste
      ? `  Ajuste mÃªs anterior: R$ ${d.ajuste.diferenca.toFixed(2)} ${d.ajuste.diferenca > 0 ? "(crÃ©dito)" : "(desconto)"}`
      : "  Sem ajuste de mÃªs anterior.";
    return `UNIDADE ${d.unidade} â€” ${d.nomePredio} | ${d.mes}/${ano}:
  Faturamento bruto: R$ ${d.valorUnidade?.bruto?.toFixed(2)||"N/A"}
  Faturamento lÃ­quido: R$ ${d.valorUnidade?.liquido?.toFixed(2)||"N/A"}
  Noites ocupadas: ${d.valorUnidade?.ocupacao||"N/A"}
  MÃ©dia bruta do prÃ©dio: R$ ${d.mediaPredio?.mediaBruta?.toFixed(2)||"N/A"} (${d.mediaPredio?.totalUnidades||"N/A"} unidades)
  MÃ©dia lÃ­quida do prÃ©dio: R$ ${d.mediaPredio?.mediaLiquida?.toFixed(2)||"N/A"}
  ManutenÃ§Ãµes:\n${listaManut}
  Total manutenÃ§Ãµes: R$ ${totalManut.toFixed(2)}
${ajusteInfo}`;
  }).join("\n\n");

  const mesesTexto = [...new Set(dadosUnidades.map(d => `${d.mes}/${ano}`))].join(" e ");

  const prompt = `VocÃª Ã© um especialista em relacionamento com proprietÃ¡rios da 360 SuÃ­tes, empresa de gestÃ£o de apartamentos de curta temporada em SÃ£o Paulo.

ProprietÃ¡rio: ${nomeProprietario}
PerÃ­odo: ${mesesTexto}

E-MAIL RECEBIDO DO PROPRIETÃRIO:
---
${emailProprietario}
---

DADOS DAS UNIDADES:
${blocos}

REGRAS:
1. Responda em UM ÃšNICO e-mail cobrindo todas as unidades
2. Identifique o tema da dÃºvida e responda priorizando esse tema
3. Compare faturamento com mÃ©dia do prÃ©dio â€” destaque se acima, contextualize se abaixo
4. Explique cada manutenÃ§Ã£o detalhadamente se perguntado
5. Mencione ajustes de mÃªs anterior com clareza
6. Tom cordial, profissional e consultivo. Nunca invente dados
7. Responda em portuguÃªs brasileiro
8. Assine como "Equipe 360 SuÃ­tes"
9. Retorne APENAS o texto do e-mail, sem comentÃ¡rios extras`;

  return chamarIA(prompt);
};

module.exports = { buscarEmails, enviarResposta };

