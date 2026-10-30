'use strict';
// GET /api/finance?month=YYYY-MM — resumo do mês: entradas, cartões
// com limites, parcelas do mês e totais. Entradas recorrentes contam
// em todos os meses a partir do mês de `data`.
// DELETE /api/finance?type=entry|installment|card&id=<uuid> — remove um
// registro do próprio usuário (type padrão: entry, compatibilidade).
//
// Exige login (token Supabase) + acesso ativo, no mesmo padrão de
// /api/me. Se alguma tabela nova ainda não existir (trecho "NOVO v2"
// do supabase.sql não rodado), responde com needsSql: true e mensagem
// clara em pt-BR, em vez de um erro genérico. Se a coluna
// `recorrente` ainda não existir, o resumo vem sem a expansão de
// recorrência (e needsSql: true), sem quebrar a resposta.
const {
  json,
  getUserFromToken,
  getAccess,
  supabaseRest,
} = require('./_lib');

const TIPOS_GASTO = new Set(['gasto', 'conta']);

const ENTRY_FIELDS =
  'id,tipo,descricao,valor,categoria,data,cartao,vencimento,pago,created_at,recorrente';
const ENTRY_FIELDS_NO_REC =
  'id,tipo,descricao,valor,categoria,data,cartao,vencimento,pago,created_at';
const CARD_FIELDS = 'id,nome,limite,dia_fechamento,dia_vencimento,created_at';
const INSTALLMENT_FIELDS =
  'id,descricao,valor_total,num_parcelas,valor_parcela,data_inicio,cartao,categoria,created_at';

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

function monthIndex(ym) {
  const [y, m] = String(ym).slice(0, 7).split('-').map(Number);
  return y * 12 + (m - 1);
}

// Parcela k de N: o mês M inclui a parcela quando data_inicio cai em
// M ou antes, e M está dentro dos num_parcelas meses da compra.
// k = meses decorridos desde o início + 1 (virada de ano coberta pelo
// índice ano*12+mês).
function expandInstallments(rows, month) {
  const mi = monthIndex(month);
  const out = [];
  for (const row of rows || []) {
    const startMi = monthIndex(String(row.data_inicio || '').slice(0, 7));
    const diff = mi - startMi;
    if (!Number.isFinite(diff) || diff < 0 || diff >= Number(row.num_parcelas || 0)) continue;
    out.push({ ...row, parcela_atual: diff + 1 });
  }
  return out;
}

function isMissingTable(status, text) {
  return (
    status === 404 ||
    /PGRST205|42P01|does not exist|Could not find the table/i.test(text || '')
  );
}

function isMissingColumn(text) {
  return /PGRST204|42703|column .* does not exist/i.test(text || '');
}

async function sbGet(path) {
  const r = await supabaseRest(path);
  if (r.ok) return r.json();
  let text = '';
  try { text = await r.text(); } catch (_) { /* sem corpo */ }
  const err = new Error('finance_select_failed');
  err.status = r.status;
  err.missingTable = isMissingTable(r.status, text);
  err.missingColumn = !err.missingTable && isMissingColumn(text);
  throw err;
}

// Entradas do mês: as do intervalo [start, next) + as recorrentes com
// data anterior ao mês (que valem em todos os meses seguintes).
// Se a coluna `recorrente` não existir, tenta de novo sem ela e avisa.
async function selectEntries(userId, start, next) {
  const base =
    'finance_entries?user_id=eq.' + encodeURIComponent(userId);
  const common = '&order=data.desc&order=created_at.desc&limit=500';
  let fields = ENTRY_FIELDS;
  let monthRows;
  try {
    monthRows = await sbGet(
      base + '&data=gte.' + start + '&data=lt.' + next + '&select=' + fields + common
    );
  } catch (err) {
    if (err.missingColumn) {
      fields = ENTRY_FIELDS_NO_REC;
      monthRows = await sbGet(
        base + '&data=gte.' + start + '&data=lt.' + next + '&select=' + fields + common
      );
      return { entries: monthRows, recorrenteSupported: false };
    }
    throw err;
  }
  const recurringRows = await sbGet(
    base + '&data=lt.' + start + '&recorrente=eq.true&select=' + fields + common
  );
  return { entries: monthRows.concat(recurringRows), recorrenteSupported: true };
}

async function selectCards(userId) {
  return sbGet(
    'cards?user_id=eq.' + encodeURIComponent(userId) +
    '&select=' + CARD_FIELDS + '&order=nome.asc&limit=100'
  );
}

async function selectInstallments(userId) {
  return sbGet(
    'installments?user_id=eq.' + encodeURIComponent(userId) +
    '&select=' + INSTALLMENT_FIELDS + '&order=data_inicio.asc&limit=500'
  );
}

function normName(s) {
  return String(s || '').trim().toLowerCase();
}

// Totais do mês. Fatura de cartão fica separada dos gastos para não
// contar duas vezes (o gasto no cartão e a fatura). Parcelas do mês
// contam nos gastos. Dívida entra só como "em aberto" (não paga),
// fora do saldo do mês.
function summarize(entries, parcelasTotal) {
  const sum = (pred) =>
    entries.filter(pred).reduce((acc, e) => acc + Number(e.valor || 0), 0);
  const ganhos = sum((e) => e.tipo === 'ganho');
  const gastos = sum((e) => TIPOS_GASTO.has(e.tipo)) + parcelasTotal;
  const faturas = sum((e) => e.tipo === 'fatura');
  const dividas = sum((e) => e.tipo === 'divida' && !e.pago);
  return {
    ganhos,
    gastos,
    faturas,
    dividas,
    parcelas: parcelasTotal,
    saldo: ganhos - gastos - faturas,
  };
}

// Usado do cartão no mês = faturas com aquele cartão + parcelas do mês
// naquele cartão. Disponível = limite − usado (negativo = acima do limite).
function summarizeCards(cards, entries, parcelasDoMes) {
  return (cards || []).map((c) => {
    const name = normName(c.nome);
    const usadoFaturas = entries
      .filter((e) => e.tipo === 'fatura' && normName(e.cartao) === name)
      .reduce((acc, e) => acc + Number(e.valor || 0), 0);
    const usadoParcelas = parcelasDoMes
      .filter((p) => normName(p.cartao) === name)
      .reduce((acc, p) => acc + Number(p.valor_parcela || 0), 0);
    const usado = usadoFaturas + usadoParcelas;
    const limite = Number(c.limite || 0);
    return {
      id: c.id,
      nome: c.nome,
      limite,
      dia_fechamento: c.dia_fechamento,
      dia_vencimento: c.dia_vencimento,
      usado,
      disponivel: limite - usado,
      acimaDoLimite: usado > limite,
    };
  });
}

const NEEDS_SQL_ENTRIES_MESSAGE =
  'Falta rodar o SQL novo da tabela finance_entries no Supabase. ' +
  'Rode o trecho marcado "NOVO (Assistente Financeiro)" do arquivo supabase.sql ' +
  'no SQL Editor e recarregue a página.';

const NEEDS_SQL_V2_MESSAGE =
  'Falta rodar o SQL novo (tabelas cards e installments e a coluna recorrente) no Supabase. ' +
  'Rode o trecho marcado "NOVO v2" do arquivo supabase.sql no SQL Editor e recarregue a página.';

const DELETE_TABLES = {
  entry: 'finance_entries',
  installment: 'installments',
  card: 'cards',
};

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

      let entries = [];
      let recorrenteSupported = true;
      let entriesMissing = false;
      try {
        const got = await selectEntries(user.id, start, next);
        entries = got.entries;
        recorrenteSupported = got.recorrenteSupported;
      } catch (err) {
        if (err && err.missingTable) entriesMissing = true;
        else throw err;
      }

      let cards = [];
      let cardsMissing = false;
      try {
        cards = await selectCards(user.id);
      } catch (err) {
        if (err && err.missingTable) cardsMissing = true;
        else throw err;
      }

      let installmentRows = [];
      let installmentsMissing = false;
      try {
        installmentRows = await selectInstallments(user.id);
      } catch (err) {
        if (err && err.missingTable) installmentsMissing = true;
        else throw err;
      }

      const parcelasDoMes = expandInstallments(installmentRows, month);
      const parcelasTotal = parcelasDoMes.reduce(
        (acc, p) => acc + Number(p.valor_parcela || 0),
        0
      );

      const needsSql = entriesMissing || cardsMissing || installmentsMissing || !recorrenteSupported;
      const messages = [];
      if (entriesMissing) messages.push(NEEDS_SQL_ENTRIES_MESSAGE);
      if (cardsMissing || installmentsMissing || !recorrenteSupported) {
        messages.push(NEEDS_SQL_V2_MESSAGE);
      }

      return json(res, 200, {
        month,
        totals: needsSql && entriesMissing
          ? summarize([], 0)
          : summarize(entries, parcelasTotal),
        entries: entriesMissing ? [] : entries,
        cartoes: cardsMissing ? [] : summarizeCards(cards, entriesMissing ? [] : entries, parcelasDoMes),
        parcelas: installmentsMissing ? [] : parcelasDoMes,
        parcelasTotal: installmentsMissing ? 0 : parcelasTotal,
        needsSql,
        message: messages.join(' '),
      });
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url || '/api/finance', 'http://localhost');
      const id = String(url.searchParams.get('id') || '').trim();
      const type = String(url.searchParams.get('type') || 'entry').trim();
      const table = DELETE_TABLES[type] || DELETE_TABLES.entry;
      if (!id) {
        return json(res, 400, { error: 'Falta o id do registro.' });
      }
      const r = await supabaseRest(
        table + '?id=eq.' + encodeURIComponent(id) +
          '&user_id=eq.' + encodeURIComponent(user.id),
        { method: 'DELETE' }
      );
      if (!r.ok) {
        let text = '';
        try { text = await r.text(); } catch (_) { /* sem corpo */ }
        if (isMissingTable(r.status, text)) {
          return json(res, 500, {
            error: 'Não foi possível excluir: ' +
              (table === 'finance_entries' ? NEEDS_SQL_ENTRIES_MESSAGE : NEEDS_SQL_V2_MESSAGE),
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
