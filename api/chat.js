'use strict';
// POST /api/chat — proxy do Gemini com memória total da conversa.
// O navegador NUNCA fala com o Google: a chave fica só no servidor.
//
// Body: { conversationId: string, message: string, final?: boolean }
// - Verifica o login (token Supabase) e o acesso ativo.
// - Enforça o limite diário de prompts.
// - Carrega TODAS as mensagens da conversa no banco e envia o
//   histórico completo ao Gemini a cada turno (é isso que faz o
//   assistente "lembrar da conversa inteira").
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

// Instrução única e neutra: sem botões de modo na tela, o robô
// interpreta pelo que o cliente escreve se é foto, vídeo ou edição.
function systemInstruction() {
  return (
    'Você é o Robô dos Prompts, um engenheiro de prompts profissional que conversa em português. ' +
    'O usuário está criando um prompt — interprete pelo que ele escrever se é FOTO, VÍDEO, EDIÇÃO DE FOTO ou EDIÇÃO DE VÍDEO, e adapte as perguntas e o prompt a esse tipo. ' +
    'Para FOTO: pense em composição, luz, câmera e lente, cenário, cores, estilo e proporção. ' +
    'Para VÍDEO: pense em duração, movimento de câmera, ritmo, narração, formato (vertical 9:16 para redes sociais, salvo pedido diferente) e som. ' +
    'Para EDIÇÃO DE FOTO: pergunte o que deve ser mantido e o que deve mudar, e se há foto de referência; descreva a edição de forma objetiva e reproduzível. ' +
    'Para EDIÇÃO DE VÍDEO: pense em cortes, ritmo, trilha, legendas e formato final. ' +
    'Regras obrigatórias: ' +
    '1) Faça UMA pergunta de esclarecimento por vez quando faltar informação importante — nunca faça várias perguntas de uma vez. ' +
    '2) Lembre-se de TUDO que o usuário já disse nesta conversa e refine o prompt a cada resposta, mostrando a evolução. ' +
    '3) NUNCA repita o mesmo prompt genérico: cada resposta deve incorporar o que foi conversado. ' +
    '4) Seja direto e útil, em português, com tom profissional e amigável. ' +
    'Quando o usuário pedir o prompt final, gere o prompt final completo e estruturado, ' +
    'envolvido EXATAMENTE nestes marcadores, sem texto fora deles: ' +
    '---PROMPT_PT--- (o prompt final em português) ---PROMPT_EN--- (o mesmo prompt em inglês, ' +
    'otimizado para geradores de imagem e vídeo, que funcionam melhor em inglês) ---END---'
  );
}

async function callGemini(apiKey, mode, history, finalRequest) {
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  if (finalRequest) {
    contents.push({
      role: 'user',
      parts: [{
        text: 'Com base em TODA esta conversa, gere agora o prompt final completo e estruturado, '
          + 'envolvido exatamente nos marcadores ---PROMPT_PT---, ---PROMPT_EN--- e ---END---, sem nenhum texto fora deles.',
      }],
    });
  }
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
async function callGroq(apiKey, mode, history, finalRequest) {
  const messages = [{ role: 'system', content: systemInstruction() }];
  for (const m of history) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  if (finalRequest) {
    messages.push({
      role: 'user',
      content: 'Com base em TODA esta conversa, gere agora o prompt final completo e estruturado, '
        + 'envolvido exatamente nos marcadores ---PROMPT_PT---, ---PROMPT_EN--- e ---END---, sem nenhum texto fora deles.',
    });
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
        error: 'Você atingiu o limite de ' + DAILY_LIMIT + ' prompts de hoje. Volte amanhã.',
      });
    }

    const body = parseBody(req);
    const conversationId = String(body.conversationId || '').trim();
    const message = String(body.message || '').trim();
    const finalRequest = body.final === true;
    if (!conversationId || !message) {
      return json(res, 400, { error: 'Faltam dados da conversa.' });
    }

    // A conversa precisa pertencer ao usuário.
    const conv = await sbSelect(
      'conversations?id=eq.' + encodeURIComponent(conversationId) +
      '&user_id=eq.' + encodeURIComponent(user.id) + '&select=id,mode'
    );
    if (!conv.length) {
      return json(res, 404, { error: 'Conversa não encontrada.' });
    }
    const mode = conv[0].mode;

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
          reply = await callGroq(groqKey, mode, history, finalRequest);
          provider = 'groq';
        } catch (groqErr) {
          console.error('groq failed, trying gemini fallback', groqErr && groqErr.status);
          if (!geminiKey) throw groqErr;
          reply = await callGemini(geminiKey, mode, history, finalRequest);
          provider = 'gemini';
        }
      } else {
        reply = await callGemini(geminiKey, mode, history, finalRequest);
        provider = 'gemini';
      }
    } catch (err) {
      if (err && err.status === 429) {
        return json(res, 429, { error: 'A IA está com muitas requisições agora. Tente de novo em alguns minutos.' });
      }
      return json(res, 502, { error: 'A IA não respondeu agora. Tente de novo em alguns segundos.' });
    }

    // Salva a resposta e conta o uso (só após sucesso).
    await supabaseRest('messages', {
      method: 'POST',
      body: { conversation_id: conversationId, role: 'assistant', content: reply },
    });
    await incrementUsage(user.id);

    return json(res, 200, {
      reply,
      final: finalRequest,
      provider,
      usage: { used: used + 1, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used - 1) },
    });
  } catch (err) {
    if (err && err.message === 'supabase_env_missing') {
      return json(res, 500, { error: 'Configuração do servidor incompleta.' });
    }
    return json(res, 500, { error: 'Algo deu errado. Tente de novo.' });
  }
};
