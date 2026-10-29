'use strict';
// GET /api/config — configuração pública do frontend.
// Retorna SOMENTE valores seguros para o navegador (URL + anon key).
// A service_role key, a chave do Gemini e o token do Mercado Pago
// NUNCA saem do servidor.
const { json } = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'Método não permitido.' });
  }
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return json(res, 500, {
      error: 'Configuração do servidor incompleta. Faltam variáveis de ambiente do Supabase.',
    });
  }
  return json(res, 200, {
    supabaseUrl: url,
    supabaseAnonKey: anon,
    // Só um booleano: o navegador (e a conferência do deploy) sabe se
    // a chave da Groq está configurada, sem nunca ver o valor dela.
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
  });
};
