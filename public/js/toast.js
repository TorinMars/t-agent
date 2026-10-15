// Floating notice: takes no layout space (never makes a toolbar taller), disappears on its own and can be dismissed by clicking. Text is always written with textContent.
const Toast = (() => {
  const MAX_VISIBLE = 4;
  const DURATIONS = { info: 3500, success: 2500, error: 6000 };
  let stack = null;

  function container() {
    if (stack && stack.isConnected) return stack;
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.append(stack);
    return stack;
  }

  function dismiss(node) {
    if (!node || !node.isConnected) return;
    clearTimeout(node._timer);
    node.remove();
  }

  // type: info | success | error. If the same text is already shown, only the timer restarts; notices are not stacked.
  function show(message, { type = 'info', duration } = {}) {
    const text = String(message === undefined || message === null ? '' : message).trim();
    if (!text) return null;
    const kind = DURATIONS[type] ? type : 'info';
    const host = container();
    const existing = [...host.children].find(node => node.dataset.message === text && node.dataset.type === kind);
    const node = existing || document.createElement('div');
    if (!existing) {
      node.className = `toast toast-${kind}`;
      node.dataset.type = kind;
      node.dataset.message = text; // compared against the source text, because the displayed text may be translated
      node.textContent = text;
      node.addEventListener('click', () => dismiss(node));
      host.append(node);
      while (host.children.length > MAX_VISIBLE) dismiss(host.firstElementChild);
    }
    clearTimeout(node._timer);
    node._timer = setTimeout(() => dismiss(node), duration || DURATIONS[kind]);
    return node;
  }

  return { show, success: (message, options) => show(message, { ...options, type: 'success' }), error: (message, options) => show(message, { ...options, type: 'error' }) };
})();

// Where toast.js is not loaded (test pages) fall back to alert so the message is never lost.
function notify(message, type = 'info') {
  if (typeof Toast !== 'undefined') return Toast.show(message, { type });
  if (typeof alert === 'function') alert(message);
  return null;
}
