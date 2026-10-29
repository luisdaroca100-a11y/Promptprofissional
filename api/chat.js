'use strict';
// POST /api/chat — assistente de finanças pessoais (Robô Financeiro).
// O navegador NUNCA fala com a IA: as chaves ficam só no servidor.
//
// Body: { conversationId: string, message: string }
// - Verifica o login (token Supabase) e o acesso ativo.
// - Enforça o limite diário de mensagens.
// - Carrega TODAS as mensagens da conversa no banco e envia o
//   histórico completo à IA a cada turno (é isso que faz o
//   assistente "lembrar da conversa inteira").
// - Quando a IA emite um bloco ---REGISTRO---, o servidor extrai o
//   bloco, salva o registro na tabela finance_entries, REMOVE o bloco
//   da resposta visível e confirma o que foi salvo. Se a tabela ainda
//   não existir (SQL novo não rodado), a resposta avisa com clareza —
//   o registro nunca se perde em silêncio.
// - Salva a resposta no banco e conta o uso somente após sucesso.

const {
  json,
  parseBody,
  getUserFromToken,
  getAccess,
  getUsageToday,
  incrementUsage,
  supabaseRest,
  sbSelect,
} = require('./_lib');

const DAILY_LIMIT = 50;
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
    'O que você faz: ajuda a registrar gastos, ganhos, faturas de cartão, contas e dívidas; calcula totais e mostra o resumo do mês; ajuda a montar e acompanhar um orçamento; explica conceitos de finanças de forma simples e pode simular cenários ("e se eu gastar X a menos...?"). ' +
    'Regras obrigatórias: ' +
    '1) Faça no máximo UMA pergunta de esclarecimento por vez quando faltar informação importante — nunca faça várias perguntas de uma vez. ' +
    '2) NUNCA repita a mesma pergunta: se o usuário não responder, responder pela metade ou mudar de assunto, NÃO pergunte de novo. Siga em frente assumindo um valor padrão razoável para o que faltava, avise em UMA frase curta o que assumiu (ex.: "vou assumir que foi hoje") e continue. Perguntar duas vezes a mesma coisa é proibido. ' +
    '3) A CADA resposta, mostre o resumo atual do que já foi registrado ou combinado nesta conversa (valores e totais parciais), de forma enxuta — nunca responda só com uma pergunta, sem mostrar o resumo. ' +
    '4) Lembre-se de TUDO que o usuário já disse nesta conversa. NUNCA ignore um valor já informado: cada resposta deve incorporar o que foi conversado. ' +
    '5) Se o usuário pedir para registrar ("registra", "anota aí", "tá bom", "pode anotar" ou confirmar um valor), registre NA HORA com as informações que já tem, sem fazer mais nenhuma pergunta. ' +
    '6) Dinheiro sempre em R$ (real), com formato pt-BR (ex.: R$ 1.234,56). Ao falar de datas com o usuário, use dia/mês/ano. ' +
    '7) Você organiza e calcula — não promete rentabilidade e não dá recomendação de investimento personalizada. Pode explicar conceitos e comparar cenários de forma educativa. ' +
    'Quando o usuário relatar um gasto, ganho, fatura, conta ou dívida, emita o registro em um bloco EXATAMENTE neste formato, no fim da resposta, um bloco por item: ' +
    '---REGISTRO--- {"tipo":"gasto|ganho|fatura|conta|divida","descricao":"...","valor":123.45,"categoria":"...","data":"YYYY-MM-DD","cartao":null|"nome do cartão","vencimento":null|"YYYY-MM-DD","pago":false} ---END--- ' +
    '"tipo": gasto (compra ou pagamento avulso), ganho (salário, renda, entrada), fatura (total da fatura do cartão), conta (conta fixa ou recorrente: aluguel, luz, internet), divida (valor devido ou parcela). ' +
    '"valor": número, com ponto decimal, sem R$ e sem texto. ' +
    '"data": data do gasto ou ganho (YYYY-MM-DD); se o usuário não disser, use a data de hoje. ' +
    '"cartao": só para fatura ou gasto no cartão — o nome do cartão; senão null. ' +
    '"vencimento": só para fatura, conta ou dívida com vencimento — YYYY-MM-DD; senão null. ' +
    '"pago": true só se o usuário disser que já pagou; senão false. ' +
    '"categoria": curta, ex.: mercado, moradia, transporte, lazer, saúde, assinaturas, cartão. ' +
    'O texto visível da resposta deve ser curto (uma frase) e NÃO deve repetir o JSON. O bloco é removido antes de aparecer para o usuário.'
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

// ---------- Registros financeiros (blocos ---REGISTRO---) ----------

const REGISTRO_RE = /---REGISTRO---\s*([\s\S]*?)\s*---END---/g;
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
  return s;
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
  };
}

function isMissingTable(status, text) {
  return status === 404 || /PGRST205|42P01|does not exist|Could not find the table/i.test(text || '');
}

// Insere um registro. Retorna { ok: true } ou { ok: false, missingTable }.
async function insertRegistro(userId, registro) {
  const r = await supabaseRest('finance_entries', {
    method: 'POST',
    body: { user_id: userId, ...registro },
  });
  if (r.ok) return { ok: true };
  let text = '';
  try { text = (await r.text()).slice(0, 500); } catch (_) { /* sem corpo */ }
  console.error('finance_entries insert failed', r.status, text);
  return { ok: false, missingTable: isMissingTable(r.status, text) };
}

// Extrai os blocos ---REGISTRO--- da resposta, salva cada um e devolve
// a resposta visível (sem os blocos) + o resumo do que foi salvo.
// Nunca perde um registro em silêncio: falha de gravação vira aviso
// claro na própria resposta, com os dados do registro à mostra.
async function processRegistros(userId, reply) {
  let visible = reply;
  const saved = [];
  let failed = false;
  let needsSql = false;

  const blocks = [];
  let m;
  REGISTRO_RE.lastIndex = 0;
  while ((m = REGISTRO_RE.exec(reply)) !== null) blocks.push(m[1]);
  visible = reply.replace(REGISTRO_RE, '').trim();
  // Bloco aberto sem ---END---: remove o resto para o JSON não vazar
  // para o usuário e trata como registro não entendido.
  const strayIdx = visible.indexOf('---REGISTRO---');
  let strayBlock = false;
  if (strayIdx !== -1) {
    visible = visible.slice(0, strayIdx).trim();
    strayBlock = true;
  }

  for (const raw of blocks) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    const registro = normalizeRegistro(parsed);
    if (!registro) {
      failed = true;
      continue;
    }
    const result = await insertRegistro(userId, registro);
    if (result.ok) {
      saved.push(registro);
    } else {
      failed = true;
      if (result.missingTable) needsSql = true;
      saved.push({ ...registro, _failed: true, _missingTable: !!result.missingTable });
    }
  }

  const notes = [];
  for (const r of saved) {
    if (r._failed && r._missingTable) {
      notes.push(
        'Não consegui salvar este registro no banco: a tabela nova (finance_entries) ainda não existe no Supabase — ' +
        'falta rodar o SQL novo (trecho "NOVO (Assistente Financeiro)" do arquivo supabase.sql) no SQL Editor e tente de novo. O registro era: ' + describeRegistro(r) + '.'
      );
    } else if (r._failed) {
      notes.push(
        'Não consegui salvar este registro agora (erro no banco). Tente de novo. O registro era: ' + describeRegistro(r) + '.'
      );
    } else {
      notes.push('Registrado: ' + describeRegistro(r) + '.');
    }
  }
  if (strayBlock || (blocks.length && failed && !saved.length)) {
    notes.push('Não consegui entender os dados de um registro (vieram incompletos). Pode me falar de novo o valor e a descrição?');
  } else if (failed && blocks.length && saved.some((r) => !r._failed)) {
    notes.push('Um dos registros veio com dados incompletos e não foi salvo. Pode me falar de novo o valor e a descrição?');
  }

  if (notes.length) {
    visible = (visible ? visible + '\n\n' : '') + notes.join('\n');
  }
  return {
    visible: visible.trim(),
    savedCount: saved.filter((r) => !r._failed).length,
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
    const used = await getUsageToday(user.id);
    if (used >= DAILY_LIMIT) {
      return json(res, 429, {
        error: 'Você atingiu o limite de ' + DAILY_LIMIT + ' mensagens de hoje. Volte amanhã.',
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

    // Registros financeiros: extrai, salva e limpa a resposta visível.
    const processed = await processRegistros(user.id, reply);
    const visibleReply = processed.visible || reply;

    // Salva a resposta (visível, sem os blocos JSON) e conta o uso
    // (só após sucesso).
    await supabaseRest('messages', {
      method: 'POST',
      body: { conversation_id: conversationId, role: 'assistant', content: visibleReply },
    });
    await incrementUsage(user.id);

    return json(res, 200, {
      reply: visibleReply,
      provider,
      finance: {
        saved: processed.savedCount,
        failed: processed.failed,
        needsSql: processed.needsSql,
      },
      usage: { used: used + 1, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used - 1) },
    });
  } catch (err) {
    if (err && err.message === 'supabase_env_missing') {
      return json(res, 500, { error: 'Configuração do servidor incompleta.' });
    }
    return json(res, 500, { error: 'Algo deu errado. Tente de novo.' });
  }
};
