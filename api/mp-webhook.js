'use strict';
// POST /api/mp-webhook.js — webhook do Mercado Pago.
// Recebe notificações de pagamento, consulta o status real na API
// do Mercado Pago e, quando aprovado, estende o acesso do usuário.
// Idempotente: notificações duplicadas do mesmo pagamento são ignoradas
// (tabela processed_payments). Sempre responde 200 para o Mercado Pago
// não ficar reenviando — erros de processamento não viram 500 aqui.
// Sem autenticação de usuário: a verificação é feita consultando o
// pagamento na API com o token do servidor (MP_ACCESS_TOKEN).

const { json, parseBody, PLANS, grantAccess } = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Método não permitido.' });
  }
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    // Sem token não há como validar: responde 200 para não gerar retries.
    return json(res, 200, { received: true });
  }
  try {
    const body = parseBody(req);
    // Formatos de notificação do Mercado Pago:
    //  - { type: 'payment', data: { id: '123' } }
    //  - { action: 'payment.created'|'payment.updated', data: { id: '123' } }
    //  - query ?id=123&topic=payment (IPN legado)
    const paymentId =
      (body.data && body.data.id) || body.id || req.query.id || (req.query.data && req.query.data.id);
    const topic = body.type || body.topic || req.query.topic || '';
    if (!paymentId || (topic && topic !== 'payment' && body.action !== 'payment.created' && body.action !== 'payment.updated')) {
      return json(res, 200, { received: true });
    }

    const r = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(String(paymentId)), {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) {
      return json(res, 200, { received: true });
    }
    const payment = await r.json();
    if (payment.status !== 'approved') {
      return json(res, 200, { received: true });
    }

    const ref = String(payment.external_reference || '');
    const [refUserId, refPlan] = ref.split(':');
    if (!refUserId || !PLANS[refPlan]) {
      return json(res, 200, { received: true });
    }
    const amountCents = Math.round(Number(payment.transaction_amount || 0) * 100);
    await grantAccess(refUserId, refPlan, payment.id, amountCents);
    return json(res, 200, { received: true });
  } catch {
    // Nunca derruba o webhook com 500: o Mercado Pago reenviaria sem parar.
    return json(res, 200, { received: true });
  }
};
