'use strict';
// POST /api/mp-create-payment.js — cria pagamento Pix no Mercado Pago.
// Duas ações:
//   { plan: 'trial' | 'monthly' }  -> cria o pagamento e devolve QR Code Pix.
//   { action: 'check', paymentId }  -> consulta o status e, se aprovado,
//                                      garante o acesso (fallback síncrono
//                                      caso o webhook atrase). Idempotente.
// O token do Mercado Pago fica SÓ no servidor (MP_ACCESS_TOKEN).
// Pagamento avulso por período — v1 NÃO tem débito automático.

const {
  json,
  parseBody,
  getUserFromToken,
  sbSelect,
  PLANS,
  grantAccess,
} = require('./_lib');

async function mpGetPayment(token, paymentId) {
  const r = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(paymentId), {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) throw new Error('mp_fetch_failed');
  return r.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Método não permitido.' });
  }
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    return json(res, 500, { error: 'Pagamentos não configurados no servidor. Fale com o responsável pelo site.' });
  }
  try {
    const user = await getUserFromToken(req);
    if (!user) {
      return json(res, 401, { error: 'Você não está logado. Faça login para continuar.' });
    }
    const body = parseBody(req);

    // ---- Ação: verificar pagamento já feito ----
    if (body.action === 'check') {
      const paymentId = String(body.paymentId || '').trim();
      if (!paymentId) return json(res, 400, { error: 'Pagamento não informado.' });
      let payment;
      try {
        payment = await mpGetPayment(token, paymentId);
      } catch {
        return json(res, 502, { error: 'Não foi possível consultar o pagamento agora. Tente de novo.' });
      }
      if (payment.status !== 'approved') {
        return json(res, 200, { approved: false, status: payment.status || 'pending' });
      }
      const ref = String(payment.external_reference || '');
      const [refUserId, refPlan] = ref.split(':');
      if (refUserId !== user.id || !PLANS[refPlan]) {
        return json(res, 200, { approved: false, status: 'approved_unmatched' });
      }
      const amountCents = Math.round(Number(payment.transaction_amount || 0) * 100);
      await grantAccess(user.id, refPlan, payment.id, amountCents);
      return json(res, 200, { approved: true, plan: refPlan });
    }

    // ---- Ação: criar pagamento Pix ----
    const plan = String(body.plan || '');
    if (!PLANS[plan]) {
      return json(res, 400, { error: 'Plano inválido.' });
    }

    // O teste de 1 dia só pode ser usado uma vez por usuário.
    if (plan === 'trial') {
      const used = await sbSelect(
        'processed_payments?user_id=eq.' + encodeURIComponent(user.id) +
        '&plan=eq.trial&select=payment_id'
      );
      if (used.length) {
        return json(res, 400, { error: 'O teste de 1 dia já foi usado nesta conta. Ative a assinatura mensal.' });
      }
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const notificationUrl = host ? 'https://' + host + '/api/mp-webhook' : undefined;
    const paymentBody = {
      transaction_amount: PLANS[plan].amount,
      description: PLANS[plan].label,
      payment_method_id: 'pix',
      payer: { email: user.email || 'cliente@geradordeprompts.com.br' },
      external_reference: user.id + ':' + plan + ':' + Date.now(),
    };
    if (notificationUrl) paymentBody.notification_url = notificationUrl;

    const r = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': user.id + '-' + plan + '-' + Date.now(),
      },
      body: JSON.stringify(paymentBody),
    });
    if (!r.ok) {
      return json(res, 502, { error: 'Não foi possível gerar o Pix agora. Tente de novo.' });
    }
    const payment = await r.json();
    const tx = payment.point_of_interaction && payment.point_of_interaction.transaction_data;
    return json(res, 200, {
      paymentId: payment.id,
      status: payment.status,
      qrCodeBase64: tx ? tx.qr_code_base64 : null,
      qrCodeText: tx ? tx.qr_code : null,
      amount: PLANS[plan].amount,
      plan,
    });
  } catch (err) {
    if (err && err.message === 'supabase_env_missing') {
      return json(res, 500, { error: 'Configuração do servidor incompleta.' });
    }
    return json(res, 500, { error: 'Algo deu errado. Tente de novo.' });
  }
};
