'use strict';
// POST /api/chat — assistente de finanças pessoais (Robô Financeiro).
// O navegador NUNCA fala com a IA: as chaves ficam só no servidor.
//
// Body: { conversationId: string, message: string }
// - Verifica o login (token Supabase) e o acesso ativo.
// - NÃO há limite de mensagens: o chat é ilimitado para quem tem
//   acesso ativo (só o acesso é verificado, nunca um contador).
// - Carrega TODAS as mensagens da conversa no banco e envia o
//   histórico completo à IA a cada turno (é isso que faz o
//   assistente "lembrar da conversa inteira").
// - Quando a IA emite um bloco ---REGISTRO---, ---CARTAO--- ou
//   ---PARCELA---, o servidor extrai o bloco, salva os dados nas
//   tabelas (finance_entries, cards, installments), REMOVE o bloco
//   da resposta visível e confirma o que foi salvo. Se alguma tabela
//   ainda não existir (SQL novo não rodado), a resposta avisa com
//   clareza — o registro nunca se perde em silêncio.
// - Salva a resposta no banco após o sucesso.

const {
  json,
  parseBody,
  getUserFromToken,
  getAccess,
  supabaseRest,
  sbSelect,
  sbUpsert,
} = require('./_lib');

const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';

// Groq (API compatível com OpenAI): usada quando GROQ_API_KEY está
// configurada. Sem ela, o chat usa só o Gemini (comportamento atual).
// GROQ_MODEL permite trocar o modelo sem novo deploy de código;
// GROQ_API_BASE existe para testes locais (aponta para um mock).
const GROQ_BASE = (process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// Instrução do assistente de finanças pessoais.
function systemInstruction() {
  const today = new Date().toISOString().slice(0, 10);
  return (
    'Você é o Robô Financeiro, um assistente de finanças pessoais que conversa em português. ' +
    'Hoje é ' + today + '. ' +
    'O usuário quer organizar as finanças pessoais: gastos mensais, faturas de cartão, contas, dívidas e orçamento. ' +
    'O que você faz: ajuda a registrar gastos, ganhos, faturas de cartão, contas, dívidas, cartões com limites e compras parceladas; calcula totais e mostra o resumo do mês; ajuda a montar e acompanhar um orçamento; explica conceitos de finanças de forma simples e pode simular cenários ("e se eu gastar X a menos...?"). ' +
    'Regras obrigatórias: ' +
    '1) Faça no máximo UMA pergunta de esclarecimento por vez quando faltar informação importante — nunca faça várias perguntas de uma vez. ' +
    '2) NUNCA repita a mesma pergunta: se o usuário não responder, responder pela metade ou mudar de assunto, NÃO pergunte de novo. Siga em frente assumindo um valor padrão razoável para o que faltava, avise em UMA frase curta o que assumiu (ex.: "vou assumir que foi hoje") e continue. Perguntar duas vezes a mesma coisa é proibido. ' +
    '3) A CADA resposta, mostre o resumo atual do que já foi registrado ou combinado nesta conversa (valores e totais parciais), de forma enxuta — nunca responda só com uma pergunta, sem mostrar o resumo. ' +
    '4) Lembre-se de TUDO que o usuário já disse nesta conversa. NUNCA ignore um valor já informado: cada resposta deve incorporar o que foi conversado. ' +
    '5) Se o usuário pedir para registrar ("registra", "anota aí", "tá bom", "pode anotar" ou confirmar um valor), registre NA HORA com as informações que já tem, sem fazer mais nenhuma pergunta. ' +
    '6) Dinheiro sempre em R$ (real), com formato pt-BR (ex.: R$ 1.234,56). Ao falar de datas com o usuário, use dia/mês/ano. ' +
    '7) Você organiza e calcula — não promete rentabilidade e não dá recomendação de investimento personalizada. Pode explicar conceitos e comparar cenários de forma educativa. ' +
    '8) Recorrência: quando o usuário informar um ganho, gasto ou conta que se repete TODO mês (ex.: "meu salário é R$ 3.000 todo mês", "o aluguel é R$ 1.200 por mês"), registre com "recorrente":true — ele passa a contar em todos os meses a partir daquele mês. Todo o resto usa "recorrente":false. ' +
    '9) REGRA ANTI-DUPLICIDADE, obrigatória: compra parcelada vira SÓ uma parcela — NUNCA crie também um registro avulso de gasto ou fatura para a mesma compra. E fatura de cartão NÃO vira gasto: a fatura fica separada no resumo, para não contar duas vezes. ' +
    '10) Cartões e limites: quando o usuário informar ou mudar o limite de um cartão ("meu cartão X tem limite de R$ 5.000", "aumentou o limite do X pra 7 mil"), emita o bloco ---CARTAO---. Quando informar uma compra parcelada, emita o bloco ---PARCELA--- (e nenhum REGISTRO para ela). ' +
    'Quando o usuário relatar um gasto, ganho, fatura, conta ou dívida, emita o registro em um bloco EXATAMENTE neste formato, no fim da resposta, um bloco por item: ' +
    '---REGISTRO--- {"tipo":"gasto|ganho|fatura|conta|divida","descricao":"...","valor":123.45,"categoria":"...","data":"YYYY-MM-DD","cartao":null|"nome do cartão","vencimento":null|"YYYY-MM-DD","pago":false,"recorrente":false} ---END--- ' +
    '"tipo": gasto (compra ou pagamento avulso), ganho (salário, renda, entrada), fatura (total da fatura do cartão), conta (conta fixa ou recorrente: aluguel, luz, internet), divida (valor devido ou parcela). ' +
    '"valor": número, com ponto decimal, sem R$ e sem texto. ' +
    '"data": data do gasto ou ganho (YYYY-MM-DD); se o usuário não disser, use a data de hoje. ' +
    '"cartao": só para fatura ou gasto no cartão — o nome do cartão; senão null. ' +
    '"vencimento": só para fatura, conta ou dívida com vencimento — YYYY-MM-DD; senão null. ' +
    '"pago": true só se o usuário disser que já pagou; senão false. ' +
    '"recorrente": true só para ganho, gasto ou conta que se repete todo mês; senão false. ' +
    '"categoria": curta, ex.: mercado, moradia, transporte, lazer, saúde, assinaturas, cartão. ' +
    'Bloco de cartão (um por cartão, no fim da resposta): ' +
    '---CARTAO--- {"nome":"...","limite":5000,"dia_fechamento":null,"dia_vencimento":10} ---END--- ' +
    '"nome": nome do cartão; "limite": número, com ponto decimal, sem R$; "dia_fechamento" e "dia_vencimento": dia do mês (1 a 31) ou null quando o usuário não disser. ' +
    'Bloco de parcela (um por compra parcelada, no fim da resposta): ' +
    '---PARCELA--- {"descricao":"...","valor_total":1200,"num_parcelas":10,"valor_parcela":120,"data_inicio":"YYYY-MM-DD","cartao":null|"nome do cartão","categoria":"..."} ---END--- ' +
    '"valor_total": valor cheio da compra; "num_parcelas": quantidade de parcelas; "valor_parcela": valor de cada parcela (valor_total dividido por num_parcelas, quando o usuário não disser); "data_inicio": data da primeira parcela (se não disser, hoje). ' +
    'O texto visível da resposta deve ser curto (uma frase) e NÃO deve repetir o JSON. Os blocos são removidos antes de aparecer para o usuário.'
  );
}

async function callGemini(apiKey, history) {
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemInstruction() }] },
    contents,
    // thinkingLevel baixo: as respostas aqui são conversas curtas, não
    // precisam do raciocínio longo padrão do modelo (que alongava muito
    // cada resposta). Se a API rejeitar o parâmetro, os logs mostram 400.
    generationConfig: { temperature: 0.7, thinkingConfig: { thinkingLevel: 'low' } },
  });
  // O modelo responde 503 quando está sobrecarregado — pico temporário.
  // Tenta de novo sozinho (até 3 vezes, com espera crescente) antes de
  // devolver erro ao cliente, em vez de falhar na primeira tentativa.
  // Cada tentativa tem limite de 60s: sem isso, uma chamada travada no
  // Google segurava a resposta até o limite de 5 minutos da função.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let r;
    try {
      r = await fetch(GEMINI_URL + '?key=' + encodeURIComponent(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        console.error('gemini timeout', 'attempt', attempt);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
          continue;
        }
        const e = new Error('gemini_error');
        e.status = 504;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (r.ok) {
      const data = await r.json();
      const text =
        data &&
        data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts &&
        data.candidates[0].content.parts.map((p) => p.text || '').join('');
      if (!text) throw new Error('gemini_empty');
      return text;
    }
    let detail = '';
    try { detail = (await r.text()).slice(0, 500); } catch (_) { /* sem corpo */ }
    // Registra só status + corpo do erro (nunca a chave, que vai na URL).
    console.error('gemini upstream error', r.status, detail);
    const transient = r.status === 503 || r.status === 429;
    if (transient && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      continue;
    }
    const e = new Error(r.status === 429 ? 'gemini_rate_limited' : 'gemini_error');
    e.status = r.status;
    throw e;
  }
  throw new Error('gemini_error');
}

// Mesmo contrato do callGemini, mas via endpoint compatível com a API
// de chat da OpenAI (Groq). A chave vai no header Authorization, nunca
// na URL. Mesma política de retentativa: até 3 tentativas, 60s cada,
// espera crescente em 429/5xx.
async function callGroq(apiKey, history) {
  const messages = [{ role: 'system', content: systemInstruction() }];
  for (const m of history) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  const body = JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.7 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let r;
    try {
      r = await fetch(GROQ_BASE + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        console.error('groq timeout', 'attempt', attempt);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
          continue;
        }
        const e = new Error('groq_error');
        e.status = 504;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (r.ok) {
      const data = await r.json();
      const text =
        data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content;
      if (!text) throw new Error('groq_empty');
      return text;
    }
    let detail = '';
    try { detail = (await r.text()).slice(0, 500); } catch (_) { /* sem corpo */ }
    // Registra só status + corpo do erro (a chave vai no header, fora do log).
    console.error('groq upstream error', r.status, detail);
    const transient = r.status === 429 || r.status >= 500;
    if (transient && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      continue;
    }
    const e = new Error(r.status === 429 ? 'groq_rate_limited' : 'groq_error');
    e.status = r.status;
    throw e;
  }
  throw new Error('groq_error');
}

// ---------- Registros financeiros (blocos ---REGISTRO--- / ---CARTAO--- / ---PARCELA---) ----------

const REGISTRO_RE = /---REGISTRO---\s*([\s\S]*?)\s*---END---/g;
const CARTAO_RE = /---CARTAO---\s*([\s\S]*?)\s*---END---/g;
const PARCELA_RE = /---PARCELA---\s*([\s\S]*?)\s*---END---/g;
const TIPOS_VALIDOS = new Set(['gasto', 'ganho', 'fatura', 'conta', 'divida']);

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function formatBRL(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateBR(iso) {
  const [y, m, d] = String(iso).split('-');
  return d + '/' + m + '/' + y;
}

function describeRegistro(r) {
  let s = r.descricao + ' — ' + formatBRL(r.valor) + ' (' + r.categoria + ', ' + formatDateBR(r.data) + ')';
  if (r.cartao) s += ' · cartão ' + r.cartao;
  if (r.vencimento) s += ' · vence ' + formatDateBR(r.vencimento);
  if (r.pago) s += ' · pago';
  if (r.recorrente) s += ' · todo mês';
  return s;
}

function describeCartao(c) {
  let s = 'Limite do cartão ' + c.nome + ' atualizado: ' + formatBRL(c.limite) + '.';
  const bits = [];
  if (c.dia_fechamento) bits.push('fecha dia ' + c.dia_fechamento);
  if (c.dia_vencimento) bits.push('vence dia ' + c.dia_vencimento);
  if (bits.length) s += ' (' + bits.join(', ') + ')';
  return s;
}

function describeParcela(p) {
  let s = 'Parcela registrada: ' + p.descricao + ' — ' + p.num_parcelas + 'x de ' + formatBRL(p.valor_parcela) +
    ' (' + formatBRL(p.valor_total) + ' no total), a partir de ' + formatDateBR(p.data_inicio);
  if (p.cartao) s += ' · cartão ' + p.cartao;
  return s + '.';
}

function validDay(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 31) return null;
  return n;
}

// Valida e normaliza um registro vindo do bloco JSON.
// Retorna o objeto pronto para o banco ou null quando inválido.
function normalizeRegistro(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tipo = String(raw.tipo || '').trim();
  if (!TIPOS_VALIDOS.has(tipo)) return null;
  const descricao = String(raw.descricao || '').trim().slice(0, 200);
  if (!descricao) return null;
  const valor = Number(raw.valor);
  if (!Number.isFinite(valor) || valor <= 0) return null;
  const today = new Date().toISOString().slice(0, 10);
  const data = isValidDate(raw.data) ? raw.data : today;
  const categoria = String(raw.categoria || '').trim().slice(0, 60) || 'outros';
  const cartao = raw.cartao === null || raw.cartao === undefined
    ? null
    : String(raw.cartao).trim().slice(0, 60) || null;
  const vencimento = isValidDate(raw.vencimento) ? raw.vencimento : null;
  return {
    tipo,
    descricao,
    valor: Math.round(valor * 100) / 100,
    categoria,
    data,
    cartao,
    vencimento,
    pago: raw.pago === true,
    recorrente: raw.recorrente === true,
  };
}

function normalizeCartao(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const nome = String(raw.nome || '').trim().slice(0, 60);
  if (!nome) return null;
  const limite = Number(raw.limite);
  if (!Number.isFinite(limite) || limite <= 0) return null;
  return {
    nome,
    limite: Math.round(limite * 100) / 100,
    dia_fechamento: validDay(raw.dia_fechamento),
    dia_vencimento: validDay(raw.dia_vencimento),
  };
}

function normalizeParcela(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const descricao = String(raw.descricao || '').trim().slice(0, 200);
  if (!descricao) return null;
  const valorTotal = Number(raw.valor_total);
  if (!Number.isFinite(valorTotal) || valorTotal <= 0) return null;
  const numParcelas = Number(raw.num_parcelas);
  if (!Number.isInteger(numParcelas) || numParcelas < 1) return null;
  let valorParcela = Number(raw.valor_parcela);
  if (!Number.isFinite(valorParcela) || valorParcela <= 0) {
    valorParcela = Math.round((valorTotal / numParcelas) * 100) / 100;
  }
  const today = new Date().toISOString().slice(0, 10);
  const dataInicio = isValidDate(raw.data_inicio) ? raw.data_inicio : today;
  const cartao = raw.cartao === null || raw.cartao === undefined
    ? null
    : String(raw.cartao).trim().slice(0, 60) || null;
  const categoria = String(raw.categoria || '').trim().slice(0, 60) || 'outros';
  return {
    descricao,
    valor_total: Math.round(valorTotal * 100) / 100,
    num_parcelas: numParcelas,
    valor_parcela: Math.round(valorParcela * 100) / 100,
    data_inicio: dataInicio,
    cartao,
    categoria,
  };
}

function isMissingTable(status, text) {
  return status === 404 || /PGRST205|42P01|does not exist|Could not find the table/i.test(text || '');
}

function isMissingColumn(text) {
  return /PGRST204|42703|column .* does not exist/i.test(text || '');
}

// Insere um registro. Retorna { ok: true } ou { ok: false, missingTable }.
// Se a coluna `recorrente` ainda não existe (SQL novo não rodado), salva
// sem ela e avisa (recorrenteDropped) em vez de perder o registro.
async function insertRegistro(userId, registro) {
  const r = await supabaseRest('finance_entries', {
    method: 'POST',
    body: { user_id: userId, ...registro },
  });
  if (r.ok) return { ok: true };
  let text = '';
  try { text = (await r.text()).slice(0, 500); } catch (_) { /* sem corpo */ }
  if (/recorrente/i.test(text) && isMissingColumn(text)) {
    const { recorrente, ...semRecorrente } = registro; // eslint-disable-line no-unused-vars
    const r2 = await supabaseRest('finance_entries', {
      method: 'POST',
      body: { user_id: userId, ...semRecorrente },
    });
    if (r2.ok) return { ok: true, recorrenteDropped: true };
    let text2 = '';
    try { text2 = (await r2.text()).slice(0, 500); } catch (_) { /* sem corpo */ }
    console.error('finance_entries insert failed', r2.status, text2);
    return { ok: false, missingTable: isMissingTable(r2.status, text2) };
  }
  console.error('finance_entries insert failed', r.status, text);
  return { ok: false, missingTable: isMissingTable(r.status, text) };
}

// Cria ou atualiza o cartão pelo nome (um cartão por nome, por usuário).
// A tabela cards tem unique(user_id, nome), então o upsert por
// on_conflict funde duplicados em vez de criar outro cartão.
async function upsertCartao(userId, cartao) {
  try {
    await sbUpsert('cards?on_conflict=user_id,nome', { user_id: userId, ...cartao });
    return { ok: true };
  } catch (e) {
    console.error('cards upsert failed', e.status, e.body);
    return { ok: false, missingTable: isMissingTable(e.status || 0, e.body || '') };
  }
}

async function insertParcela(userId, parcela) {
  const r = await supabaseRest('installments', {
    method: 'POST',
    body: { user_id: userId, ...parcela },
  });
  if (r.ok) return { ok: true };
  let text = '';
  try { text = (await r.text()).slice(0, 500); } catch (_) { /* sem corpo */ }
  console.error('installments insert failed', r.status, text);
  return { ok: false, missingTable: isMissingTable(r.status, text) };
}

function extractBlocks(reply, re) {
  const blocks = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(reply)) !== null) blocks.push(m[1]);
  return blocks;
}

// Extrai os blocos ---REGISTRO--- / ---CARTAO--- / ---PARCELA--- da
// resposta, salva cada um e devolve a resposta visível (sem os blocos)
// + o resumo do que foi salvo. Nunca perde um dado em silêncio: falha
// de gravação vira aviso claro na própria resposta, com os dados à mostra.
async function processBlocks(userId, reply) {
  let visible = reply;
  const notes = [];
  let savedCount = 0;
  let failed = false;
  let needsSql = false;

  const registroBlocks = extractBlocks(reply, REGISTRO_RE);
  const cartaoBlocks = extractBlocks(reply, CARTAO_RE);
  const parcelaBlocks = extractBlocks(reply, PARCELA_RE);
  visible = reply
    .replace(REGISTRO_RE, '')
    .replace(CARTAO_RE, '')
    .replace(PARCELA_RE, '')
    .trim();
  // Bloco aberto sem ---END---: remove o resto para o JSON não vazar
  // para o usuário e trata como dado não entendido.
  const strayIdx = Math.min(
    ...['---REGISTRO---', '---CARTAO---', '---PARCELA---'].map((marker) => {
      const i = visible.indexOf(marker);
      return i === -1 ? Infinity : i;
    })
  );
  let strayBlock = false;
  if (strayIdx !== Infinity) {
    visible = visible.slice(0, strayIdx).trim();
    strayBlock = true;
  }

  const totalBlocks = registroBlocks.length + cartaoBlocks.length + parcelaBlocks.length;

  for (const raw of registroBlocks) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    const registro = normalizeRegistro(parsed);
    if (!registro) { failed = true; continue; }
    const result = await insertRegistro(userId, registro);
    if (result.ok) {
      savedCount += 1;
      notes.push('Registrado: ' + describeRegistro(registro) + '.');
      if (result.recorrenteDropped) {
        needsSql = true;
        notes.push('Atenção: salvei o registro, mas a recorrência (todo mês) só passa a valer depois de rodar o SQL novo no Supabase — falta a coluna nova na tabela.');
      }
    } else {
      failed = true;
      if (result.missingTable) {
        needsSql = true;
        notes.push(
          'Não consegui salvar este registro no banco: a tabela nova (finance_entries) ainda não existe no Supabase — ' +
          'falta rodar o SQL novo (trecho "NOVO (Assistente Financeiro)" do arquivo supabase.sql) no SQL Editor e tente de novo. O registro era: ' + describeRegistro(registro) + '.'
        );
      } else {
        notes.push(
          'Não consegui salvar este registro agora (erro no banco). Tente de novo. O registro era: ' + describeRegistro(registro) + '.'
        );
      }
    }
  }

  for (const raw of cartaoBlocks) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    const cartao = normalizeCartao(parsed);
    if (!cartao) { failed = true; continue; }
    const result = await upsertCartao(userId, cartao);
    if (result.ok) {
      savedCount += 1;
      notes.push(describeCartao(cartao));
    } else {
      failed = true;
      if (result.missingTable) {
        needsSql = true;
        notes.push(
          'Não consegui salvar o cartão ' + cartao.nome + ' (limite ' + formatBRL(cartao.limite) + '): falta rodar o SQL novo das tabelas cards/installments no Supabase (trecho "NOVO v2" do arquivo supabase.sql).'
        );
      } else {
        notes.push('Não consegui salvar o cartão ' + cartao.nome + ' agora (erro no banco). Tente de novo.');
      }
    }
  }

  for (const raw of parcelaBlocks) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    const parcela = normalizeParcela(parsed);
    if (!parcela) { failed = true; continue; }
    const result = await insertParcela(userId, parcela);
    if (result.ok) {
      savedCount += 1;
      notes.push(describeParcela(parcela));
    } else {
      failed = true;
      if (result.missingTable) {
        needsSql = true;
        notes.push(
          'Não consegui salvar esta parcela (' + describeParcela(parcela) + '): falta rodar o SQL novo das tabelas cards/installments no Supabase (trecho "NOVO v2" do arquivo supabase.sql).'
        );
      } else {
        notes.push('Não consegui salvar esta parcela agora (erro no banco). Tente de novo. Era: ' + describeParcela(parcela));
      }
    }
  }

  if (strayBlock || (totalBlocks && failed && savedCount === 0)) {
    notes.push('Não consegui entender os dados de um registro (vieram incompletos). Pode me falar de novo o valor e a descrição?');
  } else if (failed && totalBlocks && savedCount > 0) {
    notes.push('Um dos dados veio incompleto e não foi salvo. Pode me falar de novo o valor e a descrição?');
  }

  if (notes.length) {
    visible = (visible ? visible + '\n\n' : '') + notes.join('\n');
  }
  return {
    visible: visible.trim(),
    savedCount,
    failed,
    needsSql,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Método não permitido.' });
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!geminiKey && !groqKey) {
    return json(res, 500, { error: 'A IA não está configurada no servidor. Fale com o responsável pelo site.' });
  }
  try {
    const user = await getUserFromToken(req);
    if (!user) {
      return json(res, 401, { error: 'Você não está logado. Faça login para continuar.' });
    }
    const access = await getAccess(user.id);
    if (!access) {
      return json(res, 402, {
        error: 'Você não tem acesso ativo. Ative o teste de 1 dia por R$ 1,99 ou a assinatura de R$ 19,90/mês.',
        needsAccess: true,
      });
    }

    const body = parseBody(req);
    const conversationId = String(body.conversationId || '').trim();
    const message = String(body.message || '').trim();
    if (!conversationId || !message) {
      return json(res, 400, { error: 'Faltam dados da conversa.' });
    }

    // A conversa precisa pertencer ao usuário.
    const conv = await sbSelect(
      'conversations?id=eq.' + encodeURIComponent(conversationId) +
      '&user_id=eq.' + encodeURIComponent(user.id) + '&select=id'
    );
    if (!conv.length) {
      return json(res, 404, { error: 'Conversa não encontrada.' });
    }

    // Salva a mensagem do usuário.
    await supabaseRest('messages', {
      method: 'POST',
      body: { conversation_id: conversationId, role: 'user', content: message },
    });

    // Carrega o histórico COMPLETO da conversa (memória total).
    const history = await sbSelect(
      'messages?conversation_id=eq.' + encodeURIComponent(conversationId) +
      '&select=role,content&order=created_at.asc&limit=200'
    );

    // Provedor: Groq primeiro quando a chave existe; se ela falhar
    // (após as retentativas) e o Gemini estiver configurado, cai para
    // o Gemini em vez de devolver erro ao cliente. Sem chave da Groq,
    // o comportamento é o de sempre (só Gemini).
    let reply;
    let provider = null;
    try {
      if (groqKey) {
        try {
          reply = await callGroq(groqKey, history);
          provider = 'groq';
        } catch (groqErr) {
          console.error('groq failed, trying gemini fallback', groqErr && groqErr.status);
          if (!geminiKey) throw groqErr;
          reply = await callGemini(geminiKey, history);
          provider = 'gemini';
        }
      } else {
        reply = await callGemini(geminiKey, history);
        provider = 'gemini';
      }
    } catch (err) {
      if (err && err.status === 429) {
        return json(res, 429, { error: 'A IA está com muitas requisições agora. Tente de novo em alguns minutos.' });
      }
      return json(res, 502, { error: 'A IA não respondeu agora. Tente de novo em alguns segundos.' });
    }

    // Blocos financeiros: extrai, salva e limpa a resposta visível.
    const processed = await processBlocks(user.id, reply);
    const visibleReply = processed.visible || reply;

    // Salva a resposta (visível, sem os blocos JSON) após o sucesso.
    await supabaseRest('messages', {
      method: 'POST',
      body: { conversation_id: conversationId, role: 'assistant', content: visibleReply },
    });

    return json(res, 200, {
      reply: visibleReply,
      provider,
      finance: {
        saved: processed.savedCount,
        failed: processed.failed,
        needsSql: processed.needsSql,
      },
    });
  } catch (err) {
    if (err && err.message === 'supabase_env_missing') {
      return json(res, 500, { error: 'Configuração do servidor incompleta.' });
    }
    return json(res, 500, { error: 'Algo deu errado. Tente de novo.' });
  }
};
