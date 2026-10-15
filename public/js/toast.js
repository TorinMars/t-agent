// 悬浮提示：不占用页面布局（不会撑高工具栏），自动消失，点击可立即关闭。文本一律用 textContent 写入。
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

  // type: info | success | error。相同文字已经在显示时只重新计时，不重复堆叠。
  function show(message, { type = 'info', duration } = {}) {
    const raw = String(message === undefined || message === null ? '' : message).trim();
    const text = typeof I18n !== 'undefined' ? I18n.t(raw) : raw;
    if (!text) return null;
    const kind = DURATIONS[type] ? type : 'info';
    const host = container();
    const existing = [...host.children].find(node => node.textContent === text && node.dataset.type === kind);
    const node = existing || document.createElement('div');
    if (!existing) {
      node.className = `toast toast-${kind}`;
      node.dataset.type = kind;
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

// 没有加载 toast.js 的环境（测试页）退回到 alert，保证消息不会丢。
function notify(message, type = 'info') {
  if (typeof Toast !== 'undefined') return Toast.show(message, { type });
  if (typeof alert === 'function') alert(message);
  return null;
}
