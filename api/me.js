'use strict';
// GET /api/me — usuário atual + status de acesso.
// Exige Authorization: Bearer <token do Supabase Auth>.
// Não há limite de mensagens: o chat é ilimitado para quem tem
// acesso ativo (só o acesso — trial/assinatura — é verificado).
const { json, getUserFromToken, getAccess } = require('./_lib');

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
    return json(res, 200, {
      user: { id: user.id, email: user.email },
      access: access
        ? { active: true, plan: access.plan, expiresAt: access.expires_at }
        : { active: false, plan: null, expiresAt: null },
    });
  } catch (err) {
    if (err && err.message === 'supabase_env_missing') {
      return json(res, 500, { error: 'Configuração do servidor incompleta.' });
    }
    return json(res, 500, { error: 'Não foi possível carregar seus dados. Tente de novo.' });
  }
};
