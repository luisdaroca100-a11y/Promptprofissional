'use strict';
// GET /api/finance?month=YYYY-MM — resumo do mês + entradas do usuário.
// DELETE /api/finance?id=<uuid> — remove uma entrada do próprio usuário.
//
// Exige login (token Supabase) + acesso ativo, no mesmo padrão de
// /api/me. Se a tabela finance_entries ainda não existir (trecho novo
// do supabase.sql não rodado no Supabase), responde com needsSql: true
// e mensagem clara em pt-BR, em vez de um erro genérico.
const {
  json,
  getUserFromToken,
  getAccess,
  supabaseRest,
} = require('./_lib');

const TIPOS_GASTO = new Set(['gasto', 'conta']);

function monthRange(monthParam) {
  const fallback = new Date().toISOString().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(monthParam || '') ? monthParam : fallback;
  const year = Number(month.slice(0, 4));
  const mo = Number(month.slice(5, 7));
  const start = month + '-01';
  const next =
    mo === 12
      ? String(year + 1) + '-01-01'
      : month.slice(0, 5) + String(mo + 1).padStart(2, '0') + '-01';
  return { month, start, next };
}

function isMissingTable(status, text) {
  return (
    status === 404 ||
    /PGRST205|42P01|does not exist|Could not find the table/i.test(text || '')
  );
}

async function selectEntries(userId, start, next) {
  const path =
    'finance_entries?user_id=eq.' + encodeURIComponent(userId) +
    '&data=gte.' + start +
    '&data=lt.' + next +
    '&select=id,tipo,descricao,valor,categoria,data,cartao,vencimento,pago,created_at' +
    '&order=data.desc&order=created_at.desc&limit=500';
  const r = await supabaseRest(path);
  if (!r.ok) {
    let text = '';
    try { text = await r.text(); } catch (_) { /* sem corpo */ }
    const err = new Error('finance_select_failed');
    err.status = r.status;
    err.missingTable = isMissingTable(r.status, text);
    throw err;
  }
  return r.json();
}

// Totais do mês. Fatura de cartão fica separada dos gastos para não
// contar duas vezes (o gasto no cartão e a fatura). Dívida entra só
// como "em aberto" (não paga), fora do saldo do mês.
function summarize(entries) {
  const sum = (pred) =>
    entries.filter(pred).reduce((acc, e) => acc + Number(e.valor || 0), 0);
  const ganhos = sum((e) => e.tipo === 'ganho');
  const gastos = sum((e) => TIPOS_GASTO.has(e.tipo));
  const faturas = sum((e) => e.tipo === 'fatura');
  const dividas = sum((e) => e.tipo === 'divida' && !e.pago);
  return {
    ganhos,
    gastos,
    faturas,
    dividas,
    saldo: ganhos - gastos - faturas,
  };
}

const NEEDS_SQL_MESSAGE =
  'Falta rodar o SQL novo da tabela finance_entries no Supabase. ' +
  'Rode o trecho marcado "NOVO (Assistente Financeiro)" do arquivo supabase.sql ' +
  'no SQL Editor e recarregue a página.';

module.exports = async function handler(req, res) {
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

    if (req.method === 'GET') {
      const url = new URL(req.url || '/api/finance', 'http://localhost');
      const { month, start, next } = monthRange(url.searchParams.get('month'));
      try {
        const entries = await selectEntries(user.id, start, next);
        return json(res, 200, {
          month,
          totals: summarize(entries),
          entries,
          needsSql: false,
        });
      } catch (err) {
        if (err && err.missingTable) {
          return json(res, 200, {
            month,
            totals: summarize([]),
            entries: [],
            needsSql: true,
            message: NEEDS_SQL_MESSAGE,
          });
        }
        throw err;
      }
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url || '/api/finance', 'http://localhost');
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) {
        return json(res, 400, { error: 'Falta o id da entrada.' });
      }
      const r = await supabaseRest(
        'finance_entries?id=eq.' + encodeURIComponent(id) +
          '&user_id=eq.' + encodeURIComponent(user.id),
        { method: 'DELETE' }
      );
      if (!r.ok) {
        let text = '';
        try { text = await r.text(); } catch (_) { /* sem corpo */ }
        if (isMissingTable(r.status, text)) {
          return json(res, 500, {
            error: 'Não foi possível excluir: ' + NEEDS_SQL_MESSAGE,
            needsSql: true,
          });
        }
        return json(res, 500, { error: 'Não foi possível excluir agora. Tente de novo.' });
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: 'Método não permitido.' });
  } catch (err) {
    if (err && err.message === 'supabase_env_missing') {
      return json(res, 500, { error: 'Configuração do servidor incompleta.' });
    }
    return json(res, 500, { error: 'Não foi possível carregar o resumo. Tente de novo.' });
  }
};
