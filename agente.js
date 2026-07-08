require("dotenv").config();
const { google } = require("googleapis");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Helper para chamar o Gemini com retry
const chamarGemini = async (prompt, tentativa = 1) => {
  try {
    const result = await gemini.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    if (tentativa < 4) {
      const espera = tentativa * 10000;
      console.log(`⏳ Gemini indisponível, tentando em ${espera/1000}s... (${tentativa}/3)`);
      await new Promise(r => setTimeout(r, espera));
      return chamarGemini(prompt, tentativa + 1);
    }
    throw err;
  }
};

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const proprietarios = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "proprietarios.json"), "utf8")
);

const PDF_DIR = path.resolve(__dirname, "pdfs");
const FECHAMENTOS_DIR = path.resolve(__dirname, "fechamentos");
const AJUSTES_DIR = path.resolve(__dirname, "ajustes");

// Converte mês nome para número
const mesParaNumero = (mes) => {
  const meses = {
    janeiro: 1, fevereiro: 2, março: 3, marco: 3,
    abril: 4, maio: 5, junho: 6, julho: 7,
    agosto: 8, setembro: 9, outubro: 10,
    novembro: 11, dezembro: 12,
  };
  return meses[mes.toString().toLowerCase()] || null;
};

// Retorna caminho do fechamento do mês
const getFechamentoPath = (mes, ano) => {
  const num = mesParaNumero(mes);
  if (!num) return null;
  const nome = `${ano}-${String(num).padStart(2, "0")}.xlsx`;
  const caminho = path.resolve(FECHAMENTOS_DIR, nome);
  if (fs.existsSync(caminho)) return caminho;
  // Fallback para fechamento.xlsx raiz
  const fallback = path.resolve(__dirname, "fechamento.xlsx");
  if (fs.existsSync(fallback)) {
    console.warn(`⚠️ fechamentos/${nome} não encontrado, usando fechamento.xlsx`);
    return fallback;
  }
  return null;
};

// Encontra aba correta na planilha (flexível)
const encontrarAba = (workbook, nomes) => {
  for (const nome of nomes) {
    const found = workbook.SheetNames.find(s =>
      s.toLowerCase().includes(nome.toLowerCase())
    );
    if (found) return found;
  }
  return null;
};

// Carrega ajuste do mês (se existir)
const buscarAjuste = (unidade, mes, ano) => {
  try {
    const num = mesParaNumero(mes);
    if (!num) return null;
    const nome = `${ano}-${String(num).padStart(2, "0")}.json`;
    const caminho = path.resolve(AJUSTES_DIR, nome);
    if (!fs.existsSync(caminho)) return null;
    const ajustes = JSON.parse(fs.readFileSync(caminho, "utf8"));
    return ajustes[unidade] || null;
  } catch (err) {
    console.error("Erro ao carregar ajuste:", err.message);
    return null;
  }
};

// Carrega mapeamento de siglas dinamicamente da planilha
const carregarPredios = () => {
  try {
    const PREDIOS_PATH = path.resolve(__dirname, "predios.xlsx");
    const workbook = XLSX.readFile(PREDIOS_PATH);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    const mapping = {};
    for (const row of rows) {
      if (row.unit && row.property_name) {
        const sigla = row.unit.toString().replace(/[0-9\s]/g, "").trim().toUpperCase();
        if (sigla && !mapping[sigla]) {
          mapping[sigla] = row.property_name.toString().trim();
        }
      }
    }
    console.log(`🏢 ${Object.keys(mapping).length} prédios carregados da planilha`);
    return mapping;
  } catch (err) {
    console.error("Erro ao carregar predios.xlsx:", err.message);
    return {};
  }
};

const PREDIOS = carregarPredios();

const getSigla = (unidade) => unidade.replace(/[0-9]/g, "").trim();

const getNomePredio = (unidade) => {
  const sigla = getSigla(unidade);
  return PREDIOS[sigla] || `Prédio ${sigla}`;
};

const encontrarProprietario = (emailRemetente) =>
  proprietarios.find((p) => p.email.toLowerCase() === emailRemetente.toLowerCase());

const encontrarPDF = (unidade) => {
  if (!fs.existsSync(PDF_DIR)) return null;
  const arquivos = fs.readdirSync(PDF_DIR);
  return arquivos.find(
    (f) =>
      f.toLowerCase().startsWith(unidade.toLowerCase() + " -") ||
      f.toLowerCase().startsWith(unidade.toLowerCase() + "-")
  );
};

const extrairTextoPDF = async (filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    console.warn(`⚠️ Não foi possível ler o PDF: ${err.message}`);
    return "";
  }
};

const buscarManutencoes = (unidade, fechamentoPath) => {
  try {
    const workbook = XLSX.readFile(fechamentoPath);
    const sheetName = encontrarAba(workbook, ["lancamentos_omie", "lancamentos", "lançamentos", "omie"]);
    if (!sheetName) { console.warn("⚠️ Aba de lançamentos não encontrada. Abas:", workbook.SheetNames); return []; }
    console.log(`📋 Aba de manutenções: ${sheetName}`);
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (rows.length === 0) return [];

    // Detecta formato pela presença de colunas
    const colunas = Object.keys(rows[0]);
    const isOmieFormat = colunas.includes("Departamento") || colunas.includes("Categoria");

    if (isOmieFormat) {
      // Formato aba Omie: Departamento, Categoria, Valor da Conta, Observação da Conta
      return rows
        .filter((row) => {
          const dept = (row["Departamento"] || "").toString().trim().toLowerCase();
          const categoria = (row["Categoria"] || "").toString().toLowerCase();
          return dept === unidade.toLowerCase() && categoria.includes("manut");
        })
        .map((m) => {
          const obs = (m["Observação da Conta"] || "").toString().trim();
          const valor = Math.abs(Number(m["Valor da Conta"]) || 0);
          return { descricao: obs || m["Categoria"] || "Manutenção", valor };
        });
    } else {
      // Formato lancamentos_omie: unit_name, category, observations, value
      return rows
        .filter((row) =>
          row.unit_name &&
          row.unit_name.toString().trim().toLowerCase() === unidade.toLowerCase() &&
          row.category &&
          row.category.toString().toLowerCase().includes("manutencao")
        )
        .map((m) => {
          const obs = (m.observations || "").toString();
          const descricao = obs.includes("|") ? obs.split("|").slice(1).join(" ").trim() : obs.trim();
          return { descricao, valor: Number(m.value) || 0 };
        });
    }
  } catch (err) {
    console.error("Erro ao ler manutenções:", err.message);
    return [];
  }
};

// Calcula média de repasse bruto do prédio
const calcularMediaPredio = (sigla, fechamentoPath) => {
  try {
    const workbook = XLSX.readFile(fechamentoPath);
    const sheetName = encontrarAba(workbook, ["unidades", "Unidades"]);
    if (!sheetName) return null;
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const unidadesPredio = rows.filter((row) =>
      row.unit_name &&
      row.unit_name.toString().trim().toUpperCase().startsWith(sigla.toUpperCase())
    );

    if (unidadesPredio.length === 0) return null;

    const valoresBrutos = unidadesPredio
      .map((r) => Number(r["plc_less_cleaning"] || 0))
      .filter((v) => v > 0);

    const valoresLiquidos = unidadesPredio
      .map((r) => Number(r["repasse_cliente_ajustado"] || 0))
      .filter((v) => v > 0);

    const mediaBruta = valoresBrutos.length > 0
      ? valoresBrutos.reduce((a, b) => a + b, 0) / valoresBrutos.length : null;

    const mediaLiquida = valoresLiquidos.length > 0
      ? valoresLiquidos.reduce((a, b) => a + b, 0) / valoresLiquidos.length : null;

    return { mediaBruta, mediaLiquida, totalUnidades: unidadesPredio.length };
  } catch (err) {
    console.error("Erro ao calcular média:", err.message);
    return null;
  }
};

// Pega valor da unidade específica
const getValorUnidade = (unidade, fechamentoPath) => {
  try {
    const workbook = XLSX.readFile(fechamentoPath);
    const sheetName = encontrarAba(workbook, ["unidades", "Unidades"]);
    if (!sheetName) return null;
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const linha = rows.find((r) =>
      r.unit_name && r.unit_name.toString().trim().toLowerCase() === unidade.toLowerCase()
    );

    if (!linha) return null;

    return {
      bruto: Number(linha["plc_less_cleaning"]) || null,
      liquido: Number(linha["repasse_cliente_ajustado"]) || null,
      ocupacao: linha["nights_occupied_month"] || null,
      manutencao: Number(linha["manutencao_field"]) || 0,
    };
  } catch (err) {
    console.error("Erro ao buscar valor unidade:", err.message);
    return null;
  }
};

// Detecta tipo de dúvida
const detectarTipoDuvida = async (emailCorpo) => {
  const prompt = `Classifique a dúvida do e-mail abaixo em uma das categorias: "manutencao", "ocupacao", "financeiro", "outro".
Responda apenas com a palavra da categoria, sem explicações.

E-mail: ${emailCorpo.substring(0, 500)}`;
  const texto = await chamarGemini(prompt);
  return texto.trim().toLowerCase();
};

// Gera resposta com Claude (com retry)
const gerarResposta = async (params, tentativa = 1) => {
  const {
    nomeProprietario,
    unidade,
    textoPDF,
    emailProprietario,
    manutencoes,
    tipoDuvida,
    nomePredio,
    mediaPredio,
    valorUnidade,
    dadosMercado,
    ajuste,
    mes,
    ano,
  } = params;

  const totalManutencoes = manutencoes.reduce((acc, m) => acc + m.valor, 0);
  const listaManutencoes =
    manutencoes.length > 0
      ? manutencoes.map((m, i) => `${i + 1}. ${m.descricao} — R$ ${m.valor.toFixed(2)}`).join("\n")
      : "Nenhuma manutenção registrada.";

  // Ajuste de mês anterior
  const infoAjuste = ajuste ? `
AJUSTE DE REPASSE DO MÊS ANTERIOR (Março/2026):
- Valor pago em Março: R$ ${Math.abs(ajuste.pago_marco).toFixed(2)}
- Valor correto (revisado): R$ ${Math.abs(ajuste.revisado_marco).toFixed(2)}
- Diferença aplicada em ${mes}: R$ ${ajuste.diferenca.toFixed(2)} ${ajuste.diferenca > 0 ? "(crédito — recebeu a menos em Março)" : "(desconto — recebeu a mais em Março)"}
→ Explique esse ajuste de forma clara e transparente ao proprietário.` : "Nenhum ajuste de mês anterior para esta unidade.";

  // Dados da unidade vindos da planilha (fonte principal)
  const dadosUnidade = valorUnidade ? `
DADOS DA UNIDADE ${unidade} - ${mes}/${ano} (fonte: planilha de fechamento):
- Ocupação: ${valorUnidade.ocupacao ? (valorUnidade.ocupacao * 100).toFixed(0) + "%" : "N/A"}
- Repasse bruto: R$ ${valorUnidade.bruto?.toFixed(2) || "N/A"}
- Repasse ajustado: R$ ${valorUnidade.liquido?.toFixed(2) || "N/A"}
- Manutenções total: R$ ${valorUnidade.manutencao?.toFixed(2) || "0,00"}
` : "";

  let contextoPredio = "";
  if (mediaPredio && valorUnidade) {
    const repBruto = valorUnidade.bruto || 0;
    const repLiquido = valorUnidade.liquido || 0;
    const mediaBruta = mediaPredio.mediaBruta || 0;
    const mediaLiquida = mediaPredio.mediaLiquida || 0;
    const diffBruto = repBruto - mediaBruta;
    const pctBruto = mediaBruta > 0 ? ((diffBruto / mediaBruta) * 100).toFixed(1) : 0;
    const diffLiquido = repLiquido - mediaLiquida;
    const pctLiquido = mediaLiquida > 0 ? ((diffLiquido / mediaLiquida) * 100).toFixed(1) : 0;
    const liquidoAcima = repLiquido >= mediaLiquida;

    contextoPredio = `
COMPARATIVO COM O PRÉDIO ${nomePredio} (${mediaPredio.totalUnidades} unidades):

FATURAMENTO BRUTO:
- Unidade ${unidade}: R$ ${repBruto.toFixed(2)}
- Média bruta do prédio: R$ ${mediaBruta.toFixed(2)}
- Diferença: ${Number(pctBruto) >= 0 ? "+" : ""}${pctBruto}%
→ Apenas informe esse dado ao proprietário, sem destacar positivo ou negativo.

FATURAMENTO LÍQUIDO (pós deduções):
- Unidade ${unidade}: R$ ${repLiquido.toFixed(2)}
- Média líquida do prédio: R$ ${mediaLiquida.toFixed(2)}
- Diferença: ${Number(pctLiquido) >= 0 ? "+" : ""}${pctLiquido}%
${liquidoAcima
  ? `→ DESTAQUE: A unidade está ${pctLiquido}% ACIMA da média líquida do prédio! Celebre esse resultado!`
  : `→ ATENÇÃO: A unidade está ${Math.abs(Number(pctLiquido))}% abaixo da média líquida.
→ JUSTIFIQUE com os eventos do período abaixo e tranquilize o proprietário.

EVENTOS EM SÃO PAULO (${mes}/${ano}) que impactaram a ocupação:
${dadosMercado || "Dados não disponíveis"}`}`;
  }

  const prompt = `Você é um especialista em relacionamento com proprietários e análise de performance de curta temporada da 360 Suítes.
Sua função é analisar a dúvida do proprietário e responder de forma profissional, objetiva, transparente e contextualizada.

DADOS DISPONÍVEIS:

Proprietário: ${nomeProprietario}
Unidade: ${unidade}
Prédio: ${nomePredio}
Período: ${mes}/${ano}

E-MAIL DO PROPRIETÁRIO:
---
${emailProprietario}
---

PERFORMANCE DA UNIDADE:
- Noites ocupadas: ${valorUnidade?.ocupacao || "N/A"} noites
- Taxa de ocupação: ${valorUnidade?.ocupacao && mes ? ((valorUnidade.ocupacao / new Date(Number(ano), ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'].indexOf(mes.toLowerCase())+1, 0).getDate()) * 100).toFixed(1) + "%" : "N/A"}
- Faturamento bruto: R$ ${valorUnidade?.bruto?.toFixed(2) || "N/A"}
- Faturamento líquido (pós deduções): R$ ${valorUnidade?.liquido?.toFixed(2) || "N/A"}

COMPARATIVO COM O PRÉDIO (${mediaPredio?.totalUnidades || "N/A"} unidades):
- Média bruta do prédio: R$ ${mediaPredio?.mediaBruta?.toFixed(2) || "N/A"}
- Média líquida do prédio: R$ ${mediaPredio?.mediaLiquida?.toFixed(2) || "N/A"}
- Diferença bruto: ${mediaPredio?.mediaBruta && valorUnidade?.bruto ? ((((valorUnidade.bruto - mediaPredio.mediaBruta) / mediaPredio.mediaBruta) * 100).toFixed(1) + "%") : "N/A"}
- Diferença líquido: ${mediaPredio?.mediaLiquida && valorUnidade?.liquido ? ((((valorUnidade.liquido - mediaPredio.mediaLiquida) / mediaPredio.mediaLiquida) * 100).toFixed(1) + "%") : "N/A"}

MANUTENÇÕES E LANÇAMENTOS DETALHADOS:
${listaManutencoes}
Total manutenções: R$ ${totalManutencoes.toFixed(2)}

AJUSTE DE MÊS ANTERIOR:
${infoAjuste}

EVENTOS RELEVANTES NO PERÍODO (${mes}/${ano}):
${dadosMercado || "Nenhum evento relevante registrado para o período."}

REGRAS IMPORTANTES:

1. PRIMEIRO ENTENDA A DÚVIDA DO PROPRIETÁRIO
- Identifique se a dúvida é sobre: ocupação, faturamento, descontos, manutenção, repasse, performance, reservas ou outro tema.
- Responda priorizando exatamente o tema questionado.

2. ANALISE A PERFORMANCE DA UNIDADE
- Verifique se o faturamento bruto está acima, próximo ou abaixo da média bruta do edifício.
- Contextualize sem parecer defensivo.
- Se abaixo: explique possíveis fatores (sazonalidade, baixa demanda, concorrência, antecedência de reservas, eventos, comportamento do mercado, ocupação, perfil da unidade, permanências longas, estratégia de precificação).
- Se acima: destaque positivamente a performance.

3. ANALISE EVENTOS E DEMANDA
- Use os eventos apenas como contextualização de mercado.
- Nunca afirme com certeza absoluta que um evento causou a performance.
- Use termos como: "pode ter contribuído", "coincidiu com", "ajuda a contextualizar", "pode ter influenciado a demanda".

4. ANALISE DESCONTOS E LANÇAMENTOS
- Se a dúvida envolver descontos: explique detalhadamente cada lançamento.
- Diferencie: manutenção, limpeza, taxa operacional, condomínio, IPTU, OTA, ajustes, repasses anteriores, outros.
- Se houver manutenção: explique o motivo, contextualize operacionalmente e destaque se foi preventiva, corretiva ou emergencial.

5. ANALISE OCUPAÇÃO
- Compare com a média do prédio.
- Contextualize comportamento da cidade e região.
- Use eventos e sazonalidade.

6. TOM DA RESPOSTA
- Seja cordial, profissional e consultivo.
- Nunca seja confrontador. Nunca culpe o proprietário. Nunca invente dados.
- Não use respostas genéricas. Demonstre análise real.
- Destaque pontos positivos e negativos de forma equilibrada.

7. ESTRUTURA DA RESPOSTA
- Inicie respondendo diretamente a dúvida.
- Traga contexto operacional e financeiro.
- Explique possíveis fatores de impacto.
- Finalize de forma cordial e disponível para ajudar.

8. CASO NÃO HAJA DADOS SUFICIENTES
- Informe claramente que não foi possível confirmar determinado ponto.
- Nunca invente justificativas.

IMPORTANTE: USE APENAS os dados fornecidos acima. Responda em português brasileiro. Assine como "Equipe 360 Suítes". Retorne APENAS o texto do e-mail, sem comentários extras.`;

  return chamarGemini(prompt);
};

// Busca e-mails
const buscarEmails = async (filtros = {}) => {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const anoBusca = filtros.ano || process.env.ANO_REFERENCIA || "2026";
  const mesFiltro = filtros.mes || null;
  const unidadesFiltro = filtros.unidades || [];
  const nomesFiltro = filtros.nomes || []; // filtro por nome do proprietário

  console.log(`🔍 Buscando e-mails de Performance ${anoBusca}...`);
  const res = await gmail.users.messages.list({
    userId: "me",
    q: `is:unread subject:Performance subject:${anoBusca}`,
    maxResults: 50,
  });

  const mensagens = res.data.messages || [];
  const limite = process.env.TEST_MSG_LIMIT ? Number(process.env.TEST_MSG_LIMIT) : mensagens.length;
  const mensagensFiltradas = mensagens.slice(0, limite);
  console.log(`📬 ${mensagens.length} mensagem(ns) encontrada(s), processando ${mensagensFiltradas.length}`);

  // Agrupa e-mails por proprietário para consolidar
  const emailsPorProprietario = new Map();

  for (const msg of mensagensFiltradas) {
    console.log(`📧 Processando mensagem ${msg.id}...`);
    const detalhe = await gmail.users.messages.get({ userId: "me", id: msg.id });

    const headers = detalhe.data.payload.headers;
    const assunto = headers.find((h) => h.name === "Subject")?.value || "";
    const de = headers.find((h) => h.name === "From")?.value || "";
    const emailRemetente = de.match(/<(.+)>/)?.[1] || de;

    console.log(`👤 Remetente: ${emailRemetente} | Assunto: ${assunto}`);

    // Filtro de teste por remetente
    if (process.env.TEST_EMAIL_REMETENTE &&
        emailRemetente.toLowerCase() !== process.env.TEST_EMAIL_REMETENTE.toLowerCase()) {
      console.log(`⏭️ Pulando — não é o remetente de teste`);
      continue;
    }

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

    const proprietario = encontrarProprietario(emailRemetente);
    if (!proprietario) {
      console.log(`⚠️ Proprietário não encontrado para ${emailRemetente}`);
      continue;
    }

    // Aplica filtro de nome do proprietário
    if (nomesFiltro.length > 0) {
      const nomeMatch = nomesFiltro.some(n => proprietario.nome.toLowerCase().includes(n));
      if (!nomeMatch) {
        console.log(`⏭️ Pulando ${proprietario.nome} — não corresponde ao filtro de nome`);
        continue;
      }
    }

    console.log(`✅ Proprietário: ${proprietario.nome} | Unidades: ${proprietario.unidades.join(", ")}`);

    // Extrai meses do assunto — suporta "Março e Abril/2026" ou "Março/2026"
    const anoMatch = assunto.match(/(\d{4})/);
    const ano = anoMatch ? anoMatch[1] : anoBusca;

    const mesesNomes = ["janeiro","fevereiro","março","marco","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
    const mesesEncontrados = mesesNomes.filter(m => assunto.toLowerCase().includes(m));
    let meses = mesesEncontrados.length > 0 ? mesesEncontrados.map(m => m.charAt(0).toUpperCase() + m.slice(1)) : [process.env.MES_REFERENCIA || "Abril"];

    // Aplica filtro de mês se definido no painel
    if (mesFiltro) meses = meses.filter(m => m.toLowerCase() === mesFiltro.toLowerCase());
    if (mesFiltro && meses.length === 0) {
      console.log(`⏭️ Pulando — mês ${mesFiltro} não encontrado no assunto`);
      continue;
    }

    console.log(`📅 Meses detectados: ${meses.join(", ")} | Ano: ${ano}`);

    // Agrupa por proprietário (um único e-mail por proprietário, cobre todos os meses)
    const chave = `${emailRemetente}__${ano}`;
    if (!emailsPorProprietario.has(chave)) {
      emailsPorProprietario.set(chave, {
        id: msg.id,
        threadId: detalhe.data.threadId,
        de: emailRemetente,
        nome: proprietario.nome,
        unidades: proprietario.unidades,
        assunto,
        corpo,
        meses,
        ano,
      });
    }
  }

  const resultados = [];

  for (const [, emailData] of emailsPorProprietario) {
    const { id, threadId, de, nome, unidades, assunto, corpo, meses, ano } = emailData;

    if (process.env.TEST_UNIT && !unidades.includes(process.env.TEST_UNIT)) {
      console.log(`⏭️ Pulando ${de} — não tem a unidade de teste`);
      continue;
    }

    // Detecta tipo de dúvida uma vez por proprietário
    console.log(`🧠 Detectando tipo de dúvida para ${nome}...`);
    const tipoDuvida = await detectarTipoDuvida(corpo);
    console.log(`📌 Tipo: ${tipoDuvida}`);

    // Processa cada unidade por cada mês
    const dadosUnidades = [];
    for (const mes of meses) {
      for (const unidade of unidades) {
        // Aplica filtro de unidades do painel
        if (unidadesFiltro.length > 0 && !unidadesFiltro.includes(unidade)) {
          console.log(`⏭️ Pulando ${unidade} — não está nos filtros selecionados`);
          continue;
        }
        if (process.env.TEST_UNIT && unidade !== process.env.TEST_UNIT) continue;

        const fechamentoPath = getFechamentoPath(mes, ano);
        if (!fechamentoPath) {
          console.warn(`⚠️ Planilha não encontrada para ${mes}/${ano}`);
          continue;
        }
        console.log(`📊 [${mes}/${ano}] Usando: ${path.basename(fechamentoPath)} para ${unidade}`);

        const pdfFile = encontrarPDF(unidade);
        let textoPDF = "";
        if (pdfFile) textoPDF = await extrairTextoPDF(path.join(PDF_DIR, pdfFile));

        const manutencoes = buscarManutencoes(unidade, fechamentoPath);
        console.log(`🔧 [${mes}] ${manutencoes.length} manutenção(ões) para ${unidade}`);

        const sigla = getSigla(unidade);
        const nomePredio = getNomePredio(unidade);
        const mediaPredio = calcularMediaPredio(sigla, fechamentoPath);
        const valorUnidade = getValorUnidade(unidade, fechamentoPath);
        console.log(`🏢 ${nomePredio} | Bruto: R$ ${valorUnidade?.bruto?.toFixed(2) || "N/A"} | Média: R$ ${mediaPredio?.mediaBruta?.toFixed(2) || "N/A"}`);

      const dadosMercado = null; // eventos desativados
        const ajuste = buscarAjuste(unidade, mes, ano);
        if (ajuste) console.log(`🔄 Ajuste para ${unidade} em ${mes}: R$ ${ajuste.diferenca}`);

        dadosUnidades.push({
          unidade,
          mes,
          nomePredio,
          manutencoes,
          mediaPredio,
          valorUnidade,
          dadosMercado,
          ajuste,
          textoPDF,
        });
      }
    }

    if (dadosUnidades.length === 0) continue;

    console.log(`🤖 Gerando resposta consolidada para ${nome} (${dadosUnidades.length} unidade(s)/mês)...`);
    const resposta = await gerarRespostaConsolidada({
      nomeProprietario: nome,
      emailProprietario: corpo,
      tipoDuvida,
      dadosUnidades,
      meses,
      ano,
    });
    console.log(`✅ Resposta consolidada gerada para ${nome}`);

    resultados.push({
      id,
      de,
      nome,
      unidades: dadosUnidades.map((d) => d.unidade),
      assunto,
      emailRecebido: corpo,
      respostaSugerida: resposta,
      threadId,
    });
  }

  return resultados;
};

// Gera resposta consolidada para múltiplas unidades
const gerarRespostaConsolidada = async (params, tentativa = 1) => {
  const { nomeProprietario, emailProprietario, tipoDuvida, dadosUnidades, meses, ano } = params;

  const blocosPorUnidade = dadosUnidades.map((d) => {
    const totalManutencoes = d.manutencoes.reduce((acc, m) => acc + m.valor, 0);
    const listaManutencoes = d.manutencoes.length > 0
      ? d.manutencoes.map((m, i) => `  ${i + 1}. ${m.descricao} — R$ ${m.valor.toFixed(2)}`).join("\n")
      : "  Nenhuma manutenção registrada.";

    const ajusteInfo = d.ajuste
      ? `  Ajuste de mês anterior: R$ ${d.ajuste.diferenca.toFixed(2)} ${d.ajuste.diferenca > 0 ? "(crédito)" : "(desconto)"} | Pago: R$ ${Math.abs(d.ajuste.pago_marco).toFixed(2)} | Revisado: R$ ${Math.abs(d.ajuste.revisado_marco).toFixed(2)}`
      : "  Sem ajuste de mês anterior.";

    return `UNIDADE ${d.unidade} — ${d.nomePredio} | ${d.mes}/${ano}:
  Noites ocupadas: ${d.valorUnidade?.ocupacao || "N/A"}
  Faturamento bruto: R$ ${d.valorUnidade?.bruto?.toFixed(2) || "N/A"}
  Faturamento líquido: R$ ${d.valorUnidade?.liquido?.toFixed(2) || "N/A"}
  Média bruta do prédio: R$ ${d.mediaPredio?.mediaBruta?.toFixed(2) || "N/A"} (${d.mediaPredio?.totalUnidades || "N/A"} unidades)
  Média líquida do prédio: R$ ${d.mediaPredio?.mediaLiquida?.toFixed(2) || "N/A"}
  Manutenções:
${listaManutencoes}
  Total manutenções: R$ ${totalManutencoes.toFixed(2)}
${ajusteInfo}
  Eventos do período: ${d.dadosMercado?.substring(0, 300) || "N/A"}`;
  }).join("\n\n");

  const totalGeralManutencoes = dadosUnidades.reduce((acc, d) => 
    acc + d.manutencoes.reduce((a, m) => a + m.valor, 0), 0);

  const mesesTexto = [...new Set(dadosUnidades.map(d => `${d.mes}/${ano}`))].join(" e ");

  const prompt = `Você é um especialista em relacionamento com proprietários da 360 Suítes.

Proprietário: ${nomeProprietario}
Período: ${mesesTexto}

E-MAIL RECEBIDO:
---
${emailProprietario}
---

DADOS DE TODAS AS UNIDADES DO PROPRIETÁRIO:
${blocosPorUnidade}

RESUMO FINANCEIRO GERAL (todos os meses e unidades):
- Total de manutenções (todas as unidades e meses): R$ ${totalGeralManutencoes.toFixed(2)}
- Unidades analisadas: ${[...new Set(dadosUnidades.map(d => d.unidade))].join(", ")}
- Meses analisados: ${mesesTexto}

REGRAS:
1. Responda em UM ÚNICO e-mail consolidado cobrindo TODAS as unidades
2. Organize a resposta por unidade quando necessário
3. Identifique o tema da dúvida e responda priorizando esse tema
4. Para cada unidade: compare faturamento bruto com média do prédio, explique manutenções, mencione ajustes
5. Use eventos apenas como contextualização — nunca afirme certeza absoluta
6. Se acima da média: destaque positivamente. Se abaixo: contextualize com fatores de mercado
7. Tom cordial, profissional e consultivo. Nunca invente dados
8. Finalize de forma cordial e disponível
9. Responda em português brasileiro
10. Assine como "Equipe 360 Suítes"
11. Retorne APENAS o texto do e-mail, sem comentários extras`;

  return chamarGemini(prompt);
};

// Envia resposta aprovada
const enviarResposta = async (threadId, para, assunto, corpo) => {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

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

module.exports = { buscarEmails, enviarResposta };
