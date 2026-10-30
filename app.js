// Assistente Financeiro — frontend (chat com a Secretária).
// O navegador fala SOMENTE com /api/* deste site e com o Supabase Auth
// (login e tabelas, protegidas por RLS). Nenhuma chave de IA ou de
// pagamento passa pelo navegador.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { createChatOverlay } from './chat-overlay.js';

const $ = (id) => document.getElementById(id);

const AVATAR_EMOJI = '💼';

let supabase = null;
let session = null;
let me = null;
let currentConversationId = null;
// Modo interno fixo (legado da tabela conversations, que exige um
// valor válido): a Secretária interpreta tudo pelo texto do usuário.
let currentMode = 'foto';
let currentPaymentId = null;
let authMode = 'login';
let sending = false;
let financeMonth = new Date().toISOString().slice(0, 7);
let financeLoading = false;
let chatOverlay = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showError(el, msg) {
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function showView(name) {
  $('authView').hidden = name !== 'auth';
  $('payView').hidden = name !== 'pay';
  $('appView').hidden = name !== 'app';
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && session && session.access_token) {
    headers.Authorization = 'Bearer ' + session.access_token;
  }
  const r = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || 'Algo deu errado. Tente de novo.');
    err.status = r.status;
    err.needsAccess = !!data.needsAccess;
    throw err;
  }
  return data;
}

// ---------- Inicialização ----------

async function init() {
  let config;
  try {
    const r = await fetch('/api/config');
    config = await r.json();
  } catch {
    config = {};
  }
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    showView('auth');
    showError($('authError'), 'O site ainda não foi configurado no servidor. Fale com o responsável.');
    return;
  }
  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

  const { data } = await supabase.auth.getSession();
  session = data.session || null;
  supabase.auth.onAuthStateChange((_event, newSession) => {
    session = newSession;
    if (!newSession) {
      currentConversationId = null;
      if (chatOverlay) chatOverlay.close();
      showView('auth');
    }
  });

  bindAuth();
  bindLanding();
  bindChat();
  bindPay();
  await route();
}

async function route() {
  if (!session) { showView('auth'); return; }
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status === 401) { showView('auth'); return; }
    showView('auth');
    showError($('authError'), err.message);
    return;
  }
  $('userEmailLabel').textContent = me.user.email;
  if (me.access.active) {
    const until = new Date(me.access.expiresAt).toLocaleDateString('pt-BR');
    const planName = me.access.plan === 'trial' ? 'Teste de 1 dia' : 'Assinatura mensal';
    $('accessLabel').textContent = planName + ' · válido até ' + until;
    showView('app');
    buildMonthOptions();
    if (!currentConversationId) renderWelcome();
    await loadFinanceSummary();
  } else {
    $('payHello').textContent = 'Olá, ' + me.user.email + '! Escolha um plano para conversar com a Secretária.';
    $('pixArea').hidden = true;
    showView('pay');
  }
}

// ---------- Auth ----------

function bindAuth() {
  $('tabLogin').addEventListener('click', () => setAuthMode('login'));
  $('tabSignup').addEventListener('click', () => setAuthMode('signup'));
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('authError'), '');
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    if (!email || password.length < 6) {
      showError($('authError'), 'Informe um e-mail válido e uma senha com no mínimo 6 caracteres.');
      return;
    }
    const btn = $('authSubmit');
    btn.disabled = true;
    try {
      if (authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session) {
          session = data.session;
        } else {
          showError($('authError'), 'Conta criada! Confira seu e-mail para confirmar o cadastro e depois faça login.');
          btn.disabled = false;
          return;
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        session = data.session;
      }
      await route();
    } catch (err) {
      showError($('authError'), translateAuthError(err));
    } finally {
      btn.disabled = false;
    }
  });
}

function setAuthMode(mode) {
  authMode = mode;
  $('tabLogin').classList.toggle('active', mode === 'login');
  $('tabSignup').classList.toggle('active', mode === 'signup');
  $('authSubmit').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  $('authPassword').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}

// Botões da página pública: escolhem a aba (Entrar/Criar conta) e rolam
// até o cartão de login/cadastro, com foco no campo de e-mail.
function goToAuth(mode) {
  setAuthMode(mode);
  const target = $('authSection');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => { const el = $('authEmail'); if (el) el.focus({ preventScroll: true }); }, 400);
}

function bindLanding() {
  document.querySelectorAll('.js-go-login').forEach((b) =>
    b.addEventListener('click', () => goToAuth('login')));
  document.querySelectorAll('.js-go-signup').forEach((b) =>
    b.addEventListener('click', () => goToAuth('signup')));
}

function translateAuthError(err) {
  const msg = String((err && err.message) || '');
  if (/already registered|already exists/i.test(msg)) return 'Este e-mail já tem conta. Faça login.';
  if (/invalid login|invalid credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
  if (/password/i.test(msg)) return 'A senha precisa de no mínimo 6 caracteres.';
  if (/email/i.test(msg)) return 'Informe um e-mail válido.';
  return msg || 'Não foi possível entrar. Tente de novo.';
}

async function logout() {
  if (supabase) await supabase.auth.signOut();
  session = null;
  me = null;
  currentConversationId = null;
  if (chatOverlay) chatOverlay.close();
  showView('auth');
}

// ---------- Conversas ----------

async function newConversation(mode) {
  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: session.user.id, mode, title: 'Nova conversa' })
    .select('id')
    .single();
  if (error || !data) return null;
  currentConversationId = data.id;
  currentMode = mode;
  $('messages').innerHTML = '';
  renderWelcome();
  $('sidebar').classList.remove('open');
  return data.id;
}

function renderWelcome() {
  const box = $('messages');
  const card = document.createElement('div');
  card.className = 'message-row assistant';
  card.innerHTML =
    '<span class="assistant-avatar assistant-avatar-sm" aria-hidden="true">' + AVATAR_EMOJI + '</span>' +
    '<div class="welcome-card"><h2>Olá! Eu sou a Secretária 💼</h2>' +
    '<p>Me conte seus gastos, ganhos, faturas de cartão, contas e dívidas — por exemplo: "Gastei R$ 120 no mercado hoje" ou "Minha fatura do cartão fechou em R$ 850, vence dia 10". Eu registro tudo e lembro da conversa.</p>' +
    '<p>O resumo do mês fica na tela inicial: feche o chat no ✕ para ver os totais atualizados.</p></div>';
  box.appendChild(card);
  scrollMessages();
}

function appendMessage(role, content, isError) {
  const box = $('messages');
  const row = document.createElement('div');
  row.className = 'message-row ' + role;
  if (role === 'assistant') {
    row.innerHTML =
      '<span class="assistant-avatar assistant-avatar-sm" aria-hidden="true">' + AVATAR_EMOJI + '</span>' +
      '<div class="bubble' + (isError ? ' bubble-error' : '') + '">' + escapeHtml(content) + '</div>';
  } else {
    row.innerHTML = '<div class="bubble">' + escapeHtml(content) + '</div>';
  }
  box.appendChild(row);
  scrollMessages();
  return row;
}

function scrollMessages() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function setTyping(on) {
  $('typingRow').hidden = !on;
  if (on) scrollMessages();
}

// ---------- Envio de mensagens ----------

async function sendMessage(text) {
  if (sending) return;
  const content = String(text || '').trim();
  if (!content) return;
  if (!currentConversationId) {
    const id = await newConversation(currentMode);
    if (!id) {
      showError($('chatError'), 'Não foi possível criar a conversa. Tente de novo.');
      return;
    }
  }
  showError($('chatError'), '');
  sending = true;
  $('sendBtn').disabled = true;
  appendMessage('user', content);

  // A persistência das mensagens é feita pelo backend (/api/chat),
  // que salva a pergunta e a resposta e carrega o histórico completo.
  // Aqui só exibimos — inserir aqui também duplicaria as mensagens.
  setTyping(true);
  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: { conversationId: currentConversationId, message: content },
    });
    setTyping(false);
    appendMessage('assistant', data.reply);
    // Novo registro salvo: volta o painel para o mês atual e atualiza.
    if (data.finance && data.finance.saved > 0) {
      financeMonth = new Date().toISOString().slice(0, 7);
      $('monthSelect').value = financeMonth;
      await loadFinanceSummary();
    }
  } catch (err) {
    setTyping(false);
    if (err.needsAccess) {
      await route();
      return;
    }
    appendMessage('assistant', err.message, true);
  } finally {
    sending = false;
    $('sendBtn').disabled = false;
    $('composerInput').focus();
  }
}

// ---------- Resumo do mês ----------

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function previousMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

function buildMonthOptions() {
  const select = $('monthSelect');
  select.innerHTML = '';
  let ym = new Date().toISOString().slice(0, 7);
  for (let i = 0; i < 2; i++) {
    const opt = document.createElement('option');
    opt.value = ym;
    opt.textContent = monthLabel(ym);
    select.appendChild(opt);
    ym = previousMonth(ym);
  }
  select.value = financeMonth;
}

function formatDateBR(iso) {
  const parts = String(iso || '').split('-');
  return parts.length === 3 ? parts[2] + '/' + parts[1] + '/' + parts[0] : iso;
}

const TIPO_LABEL = {
  gasto: 'Gasto',
  ganho: 'Ganho',
  fatura: 'Fatura',
  conta: 'Conta',
  divida: 'Dívida',
};

async function loadFinanceSummary() {
  if (financeLoading) return;
  financeLoading = true;
  try {
    const data = await api('/api/finance?month=' + encodeURIComponent(financeMonth), { method: 'GET' });
    if (data.needsSql) {
      showError($('financeWarning'), data.message || 'Falta rodar o SQL novo da tabela finance_entries no Supabase.');
    } else {
      showError($('financeWarning'), '');
    }
    const t = data.totals || {};
    $('totalGanhos').textContent = formatBRL(t.ganhos || 0);
    $('totalGastos').textContent = formatBRL(t.gastos || 0);
    $('totalFaturas').textContent = formatBRL(t.faturas || 0);
    $('totalDividas').textContent = formatBRL(t.dividas || 0);
    $('totalParcelas').textContent = formatBRL(t.parcelas || 0);
    $('totalSaldo').textContent = formatBRL(t.saldo || 0);
    $('totalSaldo').classList.toggle('negative', (t.saldo || 0) < 0);
    renderFinanceList(data.entries || []);
    renderCardList(data.cartoes || []);
    renderInstallmentList(data.parcelas || []);
  } catch (err) {
    showError($('financeWarning'), err.message || 'Não foi possível carregar o resumo.');
  } finally {
    financeLoading = false;
  }
}

function renderFinanceList(entries) {
  const list = $('financeList');
  list.innerHTML = '';
  $('financeEmpty').hidden = entries.length > 0;
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'finance-item';
    const main = document.createElement('div');
    main.className = 'finance-item-main';
    const desc = document.createElement('strong');
    desc.textContent = e.descricao;
    const meta = document.createElement('span');
    const parts = [TIPO_LABEL[e.tipo] || e.tipo, formatDateBR(e.data)];
    if (e.categoria) parts.push(e.categoria);
    if (e.cartao) parts.push('cartão ' + e.cartao);
    if (e.vencimento) parts.push('vence ' + formatDateBR(e.vencimento));
    if (e.pago) parts.push('pago');
    if (e.recorrente) parts.push('🔁 todo mês');
    meta.textContent = parts.join(' · ');
    main.appendChild(desc);
    main.appendChild(meta);
    const value = document.createElement('strong');
    value.className = 'finance-item-value' + (e.tipo === 'ganho' ? ' positive' : '');
    value.textContent = (e.tipo === 'ganho' ? '+' : '−') + ' ' + formatBRL(e.valor);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost icon-btn finance-delete';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Excluir registro ' + e.descricao);
    del.addEventListener('click', () => deleteFinanceItem('entry', e.id, e.descricao));
    li.appendChild(main);
    li.appendChild(value);
    li.appendChild(del);
    list.appendChild(li);
  }
}

async function deleteFinanceItem(type, id, descricao) {
  const what = type === 'card' ? 'o cartão' : type === 'installment' ? 'a compra parcelada' : 'o registro';
  if (!window.confirm('Excluir ' + what + ' "' + descricao + '"?')) return;
  try {
    await api('/api/finance?type=' + encodeURIComponent(type) + '&id=' + encodeURIComponent(id), { method: 'DELETE' });
    await loadFinanceSummary();
  } catch (err) {
    showError($('financeWarning'), err.message);
  }
}

function renderCardList(cartoes) {
  const list = $('cardList');
  list.innerHTML = '';
  $('cardEmpty').hidden = cartoes.length > 0;
  for (const c of cartoes) {
    const li = document.createElement('li');
    li.className = 'finance-item card-item' + (c.acimaDoLimite ? ' over-limit' : '');
    const main = document.createElement('div');
    main.className = 'finance-item-main';
    const desc = document.createElement('strong');
    desc.textContent = '💳 ' + c.nome;
    const meta = document.createElement('span');
    const parts = ['Limite ' + formatBRL(c.limite)];
    if (c.dia_fechamento) parts.push('fecha dia ' + c.dia_fechamento);
    if (c.dia_vencimento) parts.push('vence dia ' + c.dia_vencimento);
    parts.push('usado ' + formatBRL(c.usado));
    meta.textContent = parts.join(' · ');
    main.appendChild(desc);
    main.appendChild(meta);
    const value = document.createElement('strong');
    value.className = 'finance-item-value' + (c.acimaDoLimite ? ' over-limit-value' : ' positive');
    value.textContent = c.acimaDoLimite
      ? formatBRL(Math.abs(c.disponivel)) + ' acima do limite'
      : 'Disponível ' + formatBRL(c.disponivel);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost icon-btn finance-delete';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Excluir cartão ' + c.nome);
    del.addEventListener('click', () => deleteFinanceItem('card', c.id, c.nome));
    li.appendChild(main);
    li.appendChild(value);
    li.appendChild(del);
    list.appendChild(li);
  }
}

function renderInstallmentList(parcelas) {
  const list = $('installmentList');
  list.innerHTML = '';
  $('installmentEmpty').hidden = parcelas.length > 0;
  for (const p of parcelas) {
    const li = document.createElement('li');
    li.className = 'finance-item';
    const main = document.createElement('div');
    main.className = 'finance-item-main';
    const desc = document.createElement('strong');
    desc.textContent = p.descricao;
    const meta = document.createElement('span');
    const parts = ['Parcela ' + p.parcela_atual + '/' + p.num_parcelas, formatDateBR(p.data_inicio)];
    if (p.categoria) parts.push(p.categoria);
    if (p.cartao) parts.push('cartão ' + p.cartao);
    parts.push('total ' + formatBRL(p.valor_total));
    meta.textContent = parts.join(' · ');
    main.appendChild(desc);
    main.appendChild(meta);
    const value = document.createElement('strong');
    value.className = 'finance-item-value';
    value.textContent = '− ' + formatBRL(p.valor_parcela);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost icon-btn finance-delete';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Excluir parcela ' + p.descricao);
    del.addEventListener('click', () => deleteFinanceItem('installment', p.id, p.descricao));
    li.appendChild(main);
    li.appendChild(value);
    li.appendChild(del);
    list.appendChild(li);
  }
}

async function copyText(text, feedbackBtn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (feedbackBtn) {
    const old = feedbackBtn.textContent;
    feedbackBtn.textContent = 'Copiado! ✓';
    setTimeout(() => { feedbackBtn.textContent = old; }, 1600);
  }
}

// ---------- Ligações da tela de chat ----------

function bindChat() {
  $('logoutBtn').addEventListener('click', logout);
  $('sidebarOpen').addEventListener('click', () => $('sidebar').classList.add('open'));
  $('sidebarClose').addEventListener('click', () => $('sidebar').classList.remove('open'));
  $('newChatBtn').addEventListener('click', async () => {
    currentConversationId = null;
    await newConversation(currentMode);
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('composerInput').value;
    $('composerInput').value = '';
    autoresizeComposer();
    sendMessage(value);
  });
  $('composerInput').addEventListener('input', autoresizeComposer);
  $('composerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  $('financeRefresh').addEventListener('click', loadFinanceSummary);
  $('monthSelect').addEventListener('change', () => {
    financeMonth = $('monthSelect').value;
    loadFinanceSummary();
  });

  // O chat vive num overlay por cima da tela inicial: abre pelo botão
  // central na parte de baixo; fechar recarrega o resumo do mês.
  chatOverlay = createChatOverlay(
    {
      overlay: $('chatOverlay'),
      openButton: $('openChatBtn'),
      closeButton: $('chatCloseBtn'),
      input: $('composerInput'),
      messages: $('messages'),
      body: document.body,
    },
    { onClose: () => { if (session) loadFinanceSummary(); } },
  );
  $('chatSidebarOpen').addEventListener('click', () => $('sidebar').classList.add('open'));
}

function autoresizeComposer() {
  const ta = $('composerInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
}

// ---------- Pagamento (Pix) ----------

function bindPay() {
  $('payLogout').addEventListener('click', logout);
  document.querySelectorAll('[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => startPayment(btn.dataset.plan));
  });
  $('pixCopy').addEventListener('click', () => copyText($('pixCode').value, $('pixCopy')));
  $('pixCheck').addEventListener('click', checkPayment);
}

function formatBRL(value) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function startPayment(plan) {
  showError($('pixError'), '');
  $('pixStatus').textContent = 'Gerando o Pix…';
  $('pixArea').hidden = false;
  try {
    const data = await api('/api/mp-create-payment', {
      method: 'POST',
      body: { plan },
    });
    currentPaymentId = data.paymentId;
    if (data.qrCodeBase64) {
      $('pixQr').src = 'data:image/png;base64,' + data.qrCodeBase64;
    }
    $('pixCode').value = data.qrCodeText || '';
    $('pixAmount').textContent = formatBRL(data.amount) + ' · ' + (plan === 'trial' ? 'Teste de 1 dia' : 'Assinatura mensal (30 dias)');
    $('pixStatus').textContent = 'Aguardando pagamento… Pague e toque em "Já paguei, verificar".';
  } catch (err) {
    showError($('pixError'), err.message);
    $('pixStatus').textContent = 'Não foi possível gerar o Pix.';
  }
}

async function checkPayment() {
  if (!currentPaymentId) return;
  const btn = $('pixCheck');
  btn.disabled = true;
  $('pixStatus').textContent = 'Verificando pagamento…';
  try {
    const data = await api('/api/mp-create-payment', {
      method: 'POST',
      body: { action: 'check', paymentId: currentPaymentId },
    });
    if (data.approved) {
      $('pixStatus').textContent = 'Pagamento aprovado! Ativando seu acesso…';
      await route();
    } else {
      $('pixStatus').textContent = 'Pagamento ainda não identificado. Se já pagou, aguarde alguns segundos e tente de novo.';
    }
  } catch (err) {
    showError($('pixError'), err.message);
  } finally {
    btn.disabled = false;
  }
}

init();
