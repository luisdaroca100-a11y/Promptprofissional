// Controlador do overlay do chat do Robô Financeiro (só o assistente).
// Sem dependências: opera apenas sobre os elementos recebidos, para ser
// testável em Node com elementos falsos (fakes). O overlay é uma camada
// por cima da tela inicial (resumo do mês): abrir mostra o chat e foca o
// campo de mensagem; fechar volta ao resumo e dispara onClose (que
// recarrega o painel do resumo no app.js).
export function createChatOverlay(els, options = {}) {
  const overlay = els.overlay;
  const openButton = els.openButton || null;
  const closeButton = els.closeButton || null;
  const input = els.input || null;
  const messages = els.messages || null;
  const body = els.body || null;
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
  let isOpen = false;

  function scrollToBottom() {
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    overlay.hidden = false;
    if (body) body.classList.add('chat-open');
    scrollToBottom();
    // Foco síncrono, dentro do gesto do toque: no iOS, é o que permite
    // o teclado abrir junto com o chat.
    if (input) input.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    overlay.hidden = true;
    if (body) body.classList.remove('chat-open');
    onClose();
  }

  if (openButton && openButton.addEventListener) openButton.addEventListener('click', open);
  if (closeButton && closeButton.addEventListener) closeButton.addEventListener('click', close);
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  return { open, close, isOpen: () => isOpen };
}
