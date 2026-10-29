'use strict';
// Helpers compartilhados das funções serverless (zero dependências).
// Nenhuma chave é escrita aqui: tudo vem de process.env.

function json(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json(obj);
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function supabaseRest(path, { method = 'GET', body, service = true } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = service ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('supabase_env_missing');
  }
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
  return fetch(url + '/rest/v1/' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function sbSelect(path) {
  const r = await supabaseRest(path);
  if (!r.ok) throw new Error('supabase_select_failed');
  return r.json();
}

async function sbUpsert(path, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase_env_missing');
  const r = await fetch(url + '/rest/v1/' + path, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('supabase_upsert_failed');
  return r.json().catch(() => ({}));
}

// Valida o token do usuário chamando o Auth do Supabase.
// Retorna o usuário { id, email } ou null quando o token é inválido.
async function getUserFromToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const token = String(auth).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('supabase_env_missing');
  const r = await fetch(url + '/auth/v1/user', {
    headers: { apikey: anon, Authorization: 'Bearer ' + token },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user || !user.id) return null;
  return { id: user.id, email: user.email || '' };
}

// Acesso ativo: registro em user_access com status active e expires_at no futuro.
async function getAccess(userId) {
  const rows = await sbSelect(
    'user_access?user_id=eq.' + encodeURIComponent(userId) + '&select=plan,status,expires_at'
  );
  if (!rows.length) return null;
  const a = rows[0];
  if (a.status !== 'active') return null;
  if (new Date(a.expires_at).getTime() <= Date.now()) return null;
  return a;
}

// Contador diário de mensagens (coluna message_count da tabela usage).
// Robusto à migração pendente: se a coluna nova ainda não existe, a
// leitura/gravação falha, é registrada no log e o contador é tratado
// como 0 — o contador nunca pode quebrar o chat.
async function getUsageToday(userId) {
  try {
    const rows = await sbSelect(
      'usage?user_id=eq.' + encodeURIComponent(userId) +
      '&day=eq.' + todayISODate() + '&select=message_count'
    );
    return rows.length ? rows[0].message_count : 0;
  } catch (e) {
    console.error('getUsageToday failed (migration may be pending):', e.message);
    return 0;
  }
}

async function incrementUsage(userId) {
  const used = await getUsageToday(userId);
  const day = todayISODate();
  try {
    await sbUpsert('usage?on_conflict=user_id,day', {
      user_id: userId,
      day,
      message_count: used + 1,
    });
    return;
  } catch (e) {
    console.error('incrementUsage upsert failed:', e.message);
  }
  try {
    // Fallback: PATCH direto na linha do dia.
    await supabaseRest(
      'usage?user_id=eq.' + encodeURIComponent(userId) + '&day=eq.' + day,
      { method: 'PATCH', body: { message_count: used + 1 } }
    );
  } catch (e) {
    console.error('incrementUsage patch failed (migration may be pending):', e.message);
  }
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

// ---------- Planos e concessão de acesso (pagamentos) ----------

const PLANS = {
  trial: { amount: 1.99, days: 1, label: 'Assistente Financeiro — Teste de 1 dia' },
  monthly: { amount: 19.9, days: 30, label: 'Assistente Financeiro — Assinatura mensal' },
};

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// Estende o acesso do usuário após pagamento aprovado.
// Idempotente: pagamentos já registrados em processed_payments são ignorados.
async function grantAccess(userId, plan, paymentId, amountCents) {
  const existing = await sbSelect(
    'processed_payments?payment_id=eq.' + encodeURIComponent(String(paymentId)) + '&select=payment_id'
  );
  if (existing.length) return { already: true };

  await supabaseRest('processed_payments', {
    method: 'POST',
    body: { payment_id: String(paymentId), user_id: userId, plan, amount_cents: amountCents },
  });

  const days = PLANS[plan].days;
  const current = await sbSelect(
    'user_access?user_id=eq.' + encodeURIComponent(userId) + '&select=expires_at,status'
  );
  const now = new Date();
  let base = now;
  if (current.length && current[0].status === 'active') {
    const currentExpiry = new Date(current[0].expires_at);
    if (currentExpiry.getTime() > now.getTime()) base = currentExpiry;
  }
  const expiresAt = addDays(base, days);
  await sbUpsert('user_access?on_conflict=user_id', {
    user_id: userId,
    plan,
    status: 'active',
    expires_at: expiresAt.toISOString(),
    updated_at: now.toISOString(),
  });
  return { already: false, expiresAt: expiresAt.toISOString() };
}

module.exports = {
  json,
  todayISODate,
  supabaseRest,
  sbSelect,
  sbUpsert,
  getUserFromToken,
  getAccess,
  getUsageToday,
  incrementUsage,
  parseBody,
  PLANS,
  addDays,
  grantAccess,
};
