'use strict';
// GET /api/me — usuário atual + status de acesso + uso do dia.
// Exige Authorization: Bearer <token do Supabase Auth>.
const { json, getUserFromToken, getAccess, getUsageToday } = require('./_lib');

const DAILY_LIMIT = 50;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'Método não permitido.' });
  }
  try {
    const user = await getUserFromToken(req);
    if (!user) {
      return json(res, 401, { error: 'Você não está logado. Faça login para continuar.' });
    }
    const access = await getAccess(user.id);
    const used = await getUsageToday(user.id);
    return json(res, 200, {
      user: { id: user.id, email: user.email },
      access: access
        ? { active: true, plan: access.plan, expiresAt: access.expires_at }
        : { active: false, plan: null, expiresAt: null },
      usage: { used, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used) },
    });
  } catch (err) {
    if (err && err.message === 'supabase_env_missing') {
      return json(res, 500, { error: 'Configuração do servidor incompleta.' });
    }
    return json(res, 500, { error: 'Não foi possível carregar seus dados. Tente de novo.' });
  }
};
