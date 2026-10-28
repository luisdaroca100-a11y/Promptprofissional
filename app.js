// Gerador de Prompts — frontend (chat com o Robô de Prompts).
// O navegador fala SOMENTE com /api/* deste site e com o Supabase Auth
// (login e tabelas, protegidas por RLS). Nenhuma chave de IA ou de
// pagamento passa pelo navegador.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const $ = (id) => document.getElementById(id);

const MODES = {
  foto: 'Foto',
  video: 'Vídeo',
  edicao_foto: 'Edição de foto',
  edicao_video: 'Edição de vídeo',
};

const ROBOT_SVG =
  '<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<line x1="32" y1="4" x2="32" y2="14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
  '<circle cx="32" cy="4" r="3.5" fill="#f5b301"/>' +
  '<rect x="10" y="14" width="44" height="34" rx="10" fill="#1c1c1c" stroke="currentColor" stroke-width="2.5"/>' +
  '<rect x="4" y="26" width="6" height="12" rx="3" fill="currentColor"/>' +
  '<rect x="54" y="26" width="6" height="12" rx="3" fill="currentColor"/>' +
  '<circle cx="23" cy="29" r="4.5" fill="#f5b301"/>' +
  '<circle cx="41" cy="29" r="4.5" fill="#f5b301"/>' +
  '<path d="M23 39 Q32 45 41 39" stroke="#f5b301" stroke-width="2.5" stroke-linecap="round" fill="none"/>' +
  '<rect x="24" y="50" width="16" height="6" rx="3" fill="currentColor"/></svg>';

let supabase = null;
let session = null;
let me = null;
let currentConversationId = null;
let currentMode = 'foto';
let currentFinal = { pt: '', en: '' };
let currentPaymentId = null;
let authMode = 'login';
let sending = false;

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
      showView('auth');
    }
  });

  bindAuth();
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
    $('usageLabel').textContent = 'Prompts hoje: ' + me.usage.used + '/' + me.usage.limit;
    showView('app');
    await loadConversations();
  } else {
    $('payHello').textContent = 'Olá, ' + me.user.email + '! Escolha um plano para conversar com o Robô de Prompts.';
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
  showView('auth');
}

// ---------- Conversas ----------

async function loadConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, mode, title, created_at')
    .order('created_at', { ascending: false });
  const list = $('conversationList');
  list.innerHTML = '';
  if (error || !data || !data.length) {
    const p = document.createElement('p');
    p.className = 'conversation-empty';
    p.textContent = 'Nenhuma conversa ainda. Comece uma nova!';
    list.appendChild(p);
  } else {
    for (const c of data) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'conversation-item' + (c.id === currentConversationId ? ' active' : '');
      b.textContent = c.title || 'Nova conversa';
      b.addEventListener('click', () => openConversation(c.id, c.mode));
      list.appendChild(b);
    }
  }
  if (!currentConversationId) {
    renderWelcome();
  }
}

async function newConversation(mode) {
  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: session.user.id, mode, title: 'Nova conversa' })
    .select('id')
    .single();
  if (error || !data) return null;
  currentConversationId = data.id;
  currentMode = mode;
  syncModeChips();
  $('messages').innerHTML = '';
  renderWelcome();
  $('finalPanel').hidden = true;
  await loadConversations();
  $('sidebar').classList.remove('open');
  return data.id;
}

async function openConversation(id, mode) {
  currentConversationId = id;
  currentMode = mode || 'foto';
  syncModeChips();
  $('finalPanel').hidden = true;
  const { data } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });
  const box = $('messages');
  box.innerHTML = '';
  if (!data || !data.length) {
    renderWelcome();
  } else {
    for (const m of data) appendMessage(m.role, m.content);
  }
  scrollMessages();
  await loadConversations();
  $('sidebar').classList.remove('open');
}

function syncModeChips() {
  document.querySelectorAll('.mode-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.mode === currentMode);
  });
}

function renderWelcome() {
  const box = $('messages');
  const card = document.createElement('div');
  card.className = 'message-row assistant';
  card.innerHTML =
    '<span class="robot-avatar robot-avatar-sm" aria-hidden="true">' + ROBOT_SVG + '</span>' +
    '<div class="welcome-card"><h2>Olá! Eu sou o Robô de Prompts 🤖</h2>' +
    '<p>Me conte o que você quer criar — uma foto, um vídeo ou uma edição. Eu vou perguntando o que falta, lembrando de tudo que você disser e refinando o prompt com você.</p>' +
    '<p>Quando estiver pronto, toque em <strong>✨ Gerar prompt final</strong> e eu entrego o prompt em português e em inglês, pronto para copiar.</p></div>';
  box.appendChild(card);
  scrollMessages();
}

function appendMessage(role, content, isError) {
  const box = $('messages');
  const row = document.createElement('div');
  row.className = 'message-row ' + role;
  if (role === 'assistant') {
    row.innerHTML =
      '<span class="robot-avatar robot-avatar-sm" aria-hidden="true">' + ROBOT_SVG + '</span>' +
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

async function sendMessage(text, { final = false } = {}) {
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
  // Título da conversa: começo da primeira mensagem do usuário.
  try {
    const { data } = await supabase
      .from('conversations')
      .select('title')
      .eq('id', currentConversationId)
      .single();
    if (data && data.title === 'Nova conversa') {
      await supabase
        .from('conversations')
        .update({ title: content.slice(0, 40) })
        .eq('id', currentConversationId);
      loadConversations();
    }
  } catch { /* título é cosmético */ }

  // A persistência das mensagens é feita pelo backend (/api/chat),
  // que salva a pergunta e a resposta e carrega o histórico completo.
  // Aqui só exibimos — inserir aqui também duplicaria as mensagens.
  setTyping(true);
  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: { conversationId: currentConversationId, message: content, final },
    });
    setTyping(false);
    appendMessage('assistant', data.reply);
    if (data.usage) {
      $('usageLabel').textContent = 'Prompts hoje: ' + data.usage.used + '/' + data.usage.limit;
    }
    if (final) showFinalPanel(data.reply);
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

// ---------- Painel do prompt final ----------

function parseFinalPrompt(reply) {
  const ptMatch = reply.match(/---PROMPT_PT---([\s\S]*?)(?:---PROMPT_EN---|---END---|$)/);
  const enMatch = reply.match(/---PROMPT_EN---([\s\S]*?)(?:---END---|$)/);
  return {
    pt: ptMatch ? ptMatch[1].trim() : reply.trim(),
    en: enMatch ? enMatch[1].trim() : '',
  };
}

function showFinalPanel(reply) {
  currentFinal = parseFinalPrompt(reply);
  setFinalTab('pt');
  $('finalPanel').hidden = false;
  $('finalPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setFinalTab(which) {
  $('tabPt').classList.toggle('active', which === 'pt');
  $('tabEn').classList.toggle('active', which === 'en');
  $('finalText').textContent =
    which === 'pt'
      ? currentFinal.pt
      : (currentFinal.en || 'A versão em inglês não veio nesta resposta. Peça ao Robô de Prompts para gerar o prompt final de novo.');
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

  document.querySelectorAll('.mode-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      currentMode = chip.dataset.mode;
      syncModeChips();
      if (currentConversationId) {
        await supabase
          .from('conversations')
          .update({ mode: currentMode })
          .eq('id', currentConversationId);
      }
    });
  });

  document.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      sendMessage(chip.dataset.suggestion);
    });
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

  $('finalPromptBtn').addEventListener('click', () => {
    sendMessage('Gere o prompt final com tudo que conversamos.', { final: true });
  });
  $('tabPt').addEventListener('click', () => setFinalTab('pt'));
  $('tabEn').addEventListener('click', () => setFinalTab('en'));
  $('finalPanelClose').addEventListener('click', () => { $('finalPanel').hidden = true; });
  $('finalCopy').addEventListener('click', () => {
    const which = $('tabEn').classList.contains('active') ? 'en' : 'pt';
    copyText(which === 'pt' ? currentFinal.pt : currentFinal.en, $('finalCopy'));
  });
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
