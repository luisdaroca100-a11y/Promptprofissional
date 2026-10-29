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

// Instrução única e neutra: sem botões de modo na tela, o robô
// interpreta pelo que o cliente escreve se é foto, vídeo ou edição.
function systemInstruction() {
  return (
    'Você é o Robô de Prompts, um engenheiro de prompts profissional que conversa em português. ' +
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
  const r = await fetch(GEMINI_URL + '?key=' + encodeURIComponent(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction() }] },
      contents,
      generationConfig: { temperature: 0.7 },
    }),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 500); } catch (_) { /* sem corpo */ }
    // Registra só status + corpo do erro (nunca a chave, que vai na URL).
    console.error('gemini upstream error', r.status, detail);
    const e = new Error(r.status === 429 ? 'gemini_rate_limited' : 'gemini_error');
    e.status = r.status;
    throw e;
  }
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Método não permitido.' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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

    let reply;
    try {
      reply = await callGemini(apiKey, mode, history, finalRequest);
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
      usage: { used: used + 1, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used - 1) },
    });
  } catch (err) {
    if (err && err.message === 'supabase_env_missing') {
      return json(res, 500, { error: 'Configuração do servidor incompleta.' });
    }
    return json(res, 500, { error: 'Algo deu errado. Tente de novo.' });
  }
};
