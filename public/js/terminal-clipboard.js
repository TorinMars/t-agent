// Clipboard operations stay in the Client. OSC 52 never writes without confirmation.
const TerminalClipboard = (() => {
  const tell = (message, type) => (typeof notify === 'function' ? notify(message, type) : (typeof alert === 'function' ? alert(message) : undefined)); // floating notice; falls back to alert where toast.js is not loaded
  const instances = new Map();
  const toolbar = document.querySelector('.terminal-toolbar');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'terminal-toolbar-btn';
  copy.textContent = '⧉';
  copy.setAttribute('aria-label', 'Copy selection');
  const request = document.createElement('button');
  request.type = 'button';
  request.className = 'terminal-toolbar-btn';
  request.textContent = '📨';
  request.setAttribute('aria-label', 'Review program copy request');
  request.dataset.tip = 'Review program copy request: a program asked to write to your clipboard through the terminal and needs your confirmation';
  request.hidden = true;
  toolbar.append(copy, request);
  const pane = document.getElementById('terminal-pane');
  const container = document.getElementById('xterm-container');
  const hint = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Hold Option while selecting, then copy' : 'Hold Shift while selecting, then copy';
  copy.dataset.tip = `Copy selection: ${hint}`;
  let shown = null;

  function active() {
    if (pane.style.display === 'none' || container.style.display === 'none') return null;
    return [...instances.values()].find(item => item.el.isConnected && item.el.style.display !== 'none') || null;
  }
  function render() {
    const item = active();
    shown = item;
    copy.disabled = !item;
    request.hidden = !item?.pending;
  }
  // Copy results use a floating notice so they take no space in the terminal toolbar.
  function message(item, text) {
    if (active() === item) tell(text, /fail|denied|no selection|nothing selected|not selected/i.test(text) ? 'error' : 'success');
  }

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
      if (!document.execCommand('copy')) throw new Error('Clipboard write was denied');
    } finally { field.remove(); previous?.focus({ preventScroll: true }); }
  }

  async function copySelection(item) {
    const text = item.term.getSelection();
    if (!text) {
      message(item, window.matchMedia?.('(pointer: coarse)').matches
        ? 'Nothing selected. You can review the program copy request'
        : `No selection in the client; ${hint}, or review the program copy request`);
      return;
    }
    try { await writeText(text); message(item, 'Copied'); }
    catch { message(item, 'Copy failed: the browser denied clipboard access. Check permissions'); }
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
    title.textContent = 'A program asks to copy the following';
    const note = document.createElement('p');
    note.textContent = 'This content comes from a program in this terminal. Confirming overwrites your clipboard; cancelling copies nothing.';
    const preview = document.createElement('textarea');
    preview.readOnly = true;
    preview.value = text;
    preview.setAttribute('aria-label', 'Content to copy');
    const feedback = document.createElement('p');
    feedback.setAttribute('role', 'status');
    const confirm = document.createElement('button');
    confirm.type = 'button'; confirm.textContent = 'Confirm copy';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
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
      try { await writeText(text); close(); message(item, 'Copied the content provided by the program'); }
      catch { feedback.textContent = 'Copy failed; select the text above and copy it manually.'; confirm.disabled = false; }
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
      event.preventDefault(); event.stopImmediatePropagation(); message(item, 'Copied');
    };
    el.addEventListener('copy', onCopy, true);
    const osc = term.parser.registerOscHandler(52, data => {
      const text = decodeOsc52(data);
      if (text && !item.replaying && active() === item && !item.pending) {
        item.pending = text;
        message(item, 'A program wants to copy: click “Review program copy request” to confirm');
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
