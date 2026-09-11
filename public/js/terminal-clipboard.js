// Clipboard operations stay in the Client. OSC 52 never writes without confirmation.
const TerminalClipboard = (() => {
  const instances = new Map();
  const toolbar = document.querySelector('.terminal-toolbar');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'terminal-toolbar-btn';
  copy.textContent = '复制选中内容';
  const request = document.createElement('button');
  request.type = 'button';
  request.className = 'terminal-toolbar-btn';
  request.textContent = '查看程序复制请求';
  request.hidden = true;
  const status = document.createElement('span');
  status.className = 'terminal-copy-status';
  status.setAttribute('role', 'status');
  toolbar.append(copy, request, status);
  const pane = document.getElementById('terminal-pane');
  const container = document.getElementById('xterm-container');
  const hint = /Mac|iPhone|iPad/.test(navigator.platform) ? '按住 Option 拖选，再复制' : '按住 Shift 拖选，再复制';
  let shown = null;

  function active() {
    if (pane.style.display === 'none' || container.style.display === 'none') return null;
    return [...instances.values()].find(item => item.el.isConnected && item.el.style.display !== 'none') || null;
  }
  function render() {
    const item = active();
    if (shown !== item) { status.textContent = hint; shown = item; }
    copy.disabled = !item;
    request.hidden = !item?.pending;
  }
  function message(item, text) { if (active() === item) status.textContent = text; }

  async function writeText(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return; } catch {}
    }
    const previous = document.activeElement;
    const field = document.createElement('textarea');
    field.value = text;
    field.style.cssText = 'position:fixed;left:-10000px;top:0';
    document.body.append(field);
    field.select();
    try {
      if (!document.execCommand('copy')) throw new Error('剪贴板写入被拒绝');
    } finally { field.remove(); previous?.focus({ preventScroll: true }); }
  }

  async function copySelection(item) {
    const text = item.term.getSelection();
    if (!text) { message(item, `没有客户端选区；${hint}，或查看程序复制请求`); return; }
    try { await writeText(text); message(item, '已复制'); }
    catch { message(item, '复制失败：浏览器拒绝写入剪贴板，请检查权限'); }
  }
  // Keep the terminal selection/focus while using the toolbar with a mouse.
  copy.addEventListener('mousedown', event => event.preventDefault());
  copy.addEventListener('click', () => { const item = active(); if (item) void copySelection(item); });
  request.addEventListener('click', () => {
    const item = active();
    if (!item?.pending || item.dialog) return;
    const text = item.pending; // Snapshot: subsequent remote output cannot change approval contents.
    const dialog = document.createElement('dialog');
    dialog.className = 'terminal-copy-dialog';
    const title = document.createElement('h3');
    title.textContent = '程序请求复制以下内容';
    const note = document.createElement('p');
    note.textContent = '内容来自此终端程序。确认后将覆盖你的剪贴板；取消不会复制。';
    const preview = document.createElement('textarea');
    preview.readOnly = true;
    preview.value = text;
    preview.setAttribute('aria-label', '待复制内容');
    const feedback = document.createElement('p');
    feedback.setAttribute('role', 'status');
    const confirm = document.createElement('button');
    confirm.type = 'button'; confirm.textContent = '确认复制';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = '取消';
    dialog.append(title, note, preview, feedback, confirm, cancel);
    document.body.append(dialog);
    item.dialog = dialog;
    const close = () => {
      dialog.remove(); item.dialog = null; item.pending = null;
      clearTimeout(item.expiry); render();
    };
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    confirm.addEventListener('click', async () => {
      if (active() !== item || !instances.has(item.term)) { close(); return; }
      confirm.disabled = true;
      try { await writeText(text); close(); message(item, '已复制程序提供的内容'); }
      catch { feedback.textContent = '复制失败；可选中上方文本后手动复制。'; confirm.disabled = false; }
    });
    dialog.showModal();
    cancel.focus();
  });

  function decodeOsc52(data) {
    const separator = data.indexOf(';');
    if (separator < 0 || !/^[cps0-7]*$/.test(data.slice(0, separator))) return null;
    const encoded = data.slice(separator + 1);
    // Never answer clipboard read queries, clear the clipboard, or accept unbounded data.
    if (!encoded || encoded === '?' || encoded.length > 87384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
    try {
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      if (bytes.length > 65536) return null;
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes) || null;
    } catch { return null; }
  }

  function attach(term, el) {
    const item = { term, el, pending: null, dialog: null, expiry: null };
    instances.set(term, item);
    term.options.macOptionClickForcesSelection = true;
    term.attachCustomKeyEventHandler(event => {
      const shortcut = (event.metaKey && !event.ctrlKey && !event.altKey) || (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey);
      if (!shortcut || event.key.toLowerCase() !== 'c' || active() !== item || !term.hasSelection()) return true;
      if (event.type === 'keydown') { event.preventDefault(); void copySelection(item); }
      return false;
    });
    const onCopy = event => {
      // Don't intercept selection in dialogs, editors or other DOM text.
      if (active() !== item || !el.contains(event.target) || !term.hasSelection() || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', term.getSelection());
      event.preventDefault(); event.stopImmediatePropagation(); message(item, '已复制');
    };
    el.addEventListener('copy', onCopy, true);
    const osc = term.parser.registerOscHandler(52, data => {
      const text = decodeOsc52(data);
      if (text && !item.replaying && active() === item && !item.pending) {
        item.pending = text;
        message(item, '程序请求复制：请点击“查看程序复制请求”确认');
        item.expiry = setTimeout(() => { item.pending = null; item.dialog?.remove(); item.dialog = null; render(); }, 60000);
        render();
      }
      return true;
    });
    render();
    return { writeHistory(data, callback) {
      item.replaying = true;
      term.write(data, () => { item.replaying = false; callback?.(); });
    }, dispose() {
      instances.delete(term); osc.dispose(); el.removeEventListener('copy', onCopy, true);
      clearTimeout(item.expiry); item.dialog?.remove(); item.pending = null; render();
    } };
  }
  const observer = new MutationObserver(render);
  observer.observe(container, { attributes: true, attributeFilter: ['style'], subtree: true, childList: true });
  observer.observe(pane, { attributes: true, attributeFilter: ['style'] });
  render();
  return { attach, decodeOsc52 };
})();
