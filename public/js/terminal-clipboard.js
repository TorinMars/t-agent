// Terminal clipboard (both input modes, touch and pointer). One rule for every copy from a terminal: COPY ON SELECT, and one code path, so a
// selection made in the page and a program's OSC 52 copy (`ESC ] 52 ; c ; <base64> BEL`, sent for example by Claude Code, tmux or vim) look
// and feel the same: the same write, the same notice ("Copied N characters"), the same bar and the same failure notice.
// - The page's own selection: the page calls `handle.copy(text)` when the user finished a selection (touch: h5.js after a double / triple tap;
//   mouse: this module on mouseup after a drag, double / triple click or Option / Shift selection). Cmd+C and Ctrl+Shift+C copy the selection too.
// - A program's request that arrives within GESTURE_WINDOW_MS after the user's own pointer, touch or key gesture on THAT terminal (the user just
//   selected or copied something in the program) is written at once, one write per gesture.
// - Either way, when the browser refuses the write (no user activation any more, iOS Safari), the page shows the bar ("Tap to copy"), and the
//   tap writes inside its own gesture. If that also fails, one error notice says how to copy by hand.
// - A program's request without a recent gesture is never written silently: the same bar shows a one-line preview with Copy / Cancel. Nothing is
//   written before Copy, later output cannot replace the text, and the request expires after REQUEST_TTL_MS.
// The same text again from the same terminal within DUPLICATE_WINDOW_MS is one copy, whatever the source (Claude Code runs pbcopy, which the
// PTY's shim turns into OSC 52, and also sends its own OSC 52; a page selection and the program's copy of it): one write, one notice, one bar.
// Never answered: clipboard reads (`?`); ignored: replayed history, hidden terminals, invalid base64 or UTF-8, more than MAX_BYTES.
// The page draws the bar (the MUI shell, `state.clipboard`); it registers with `setHost({ show })` and calls `confirm()` / `cancel()`.
const TerminalClipboard = (() => {
  const GESTURE_WINDOW_MS = 1500;
  const REQUEST_TTL_MS = 60000;
  const MAX_BYTES = 65536;
  const DUPLICATE_WINDOW_MS = 2000;
  const PREVIEW_CHARS = 120;
  const tell = (message, type) => (typeof notify === 'function' ? notify(message, type) : undefined); // the floating notice of the page
  const now = () => Date.now();
  let host = null; // { show(request | null) }: the page's bar
  let current = null; // the one request the page shows: { id, kind: 'ask' | 'tap', text, item, expiry }
  let ids = 0;

  function decodeOsc52(data) {
    const separator = data.indexOf(';');
    if (separator < 0 || !/^[cps0-7]*$/.test(data.slice(0, separator))) return null;
    const encoded = data.slice(separator + 1);
    // Never answer clipboard read queries, clear the clipboard, or accept unbounded data.
    if (!encoded || encoded === '?' || encoded.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
    try {
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      if (bytes.length > MAX_BYTES) return null;
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes) || null;
    } catch { return null; }
  }
  const countChars = text => Array.from(text).length;
  const copiedMessage = text => (countChars(text) === 1 ? 'Copied 1 character' : `Copied ${countChars(text)} characters`);
  // The way to copy by hand that is left when the browser refuses every write: the copy view (a long press on touch, "Copy text" in the
  // terminal menu with a mouse).
  const failedMessage = () => (typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset
    && document.documentElement.dataset.input === 'pointer'
    ? 'Could not copy. Use Copy text in the terminal menu' : 'Could not copy. Long-press to open the copy view');
  // One line for the bar: white space folded, cut after PREVIEW_CHARS (the bar cuts it again to its width).
  function previewOf(text) {
    const line = text.replace(/\s+/g, ' ').trim();
    const chars = Array.from(line);
    return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : line;
  }

  // The legacy copy command from a temporary read-only field (plain HTTP has no clipboard API). Needs a user activation in most browsers.
  function legacyCopy(text) {
    if (typeof document.execCommand !== 'function') return false;
    const previous = document.activeElement;
    const field = document.createElement('textarea');
    let ok = false;
    try {
      field.value = text;
      field.readOnly = true;
      field.setAttribute('aria-hidden', 'true');
      field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.append(field);
      field.select();
      ok = Boolean(document.execCommand('copy'));
    } catch { ok = false; } finally {
      field.remove();
      if (previous && previous.focus) previous.focus({ preventScroll: true });
    }
    return ok;
  }
  // Writes the text; resolves true when the browser took it. The clipboard API is called synchronously, so a call from a tap handler is
  // still inside that tap's user activation (iOS Safari needs that).
  function writeText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      let call;
      try { call = navigator.clipboard.writeText(text); } catch (error) { call = Promise.reject(error); }
      return Promise.resolve(call).then(() => true, () => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }

  const view = request => (request ? { id: request.id, kind: request.kind, text: request.text, preview: previewOf(request.text), chars: countChars(request.text) } : null);
  function show(request) { if (host && host.show) host.show(view(request)); }
  function clear(request = current) {
    if (!request || current !== request) return;
    clearTimeout(request.expiry);
    current = null;
    show(null);
  }
  function offer(item, text, kind) {
    if (current) clear();
    if (!host) return; // no page to show the bar on: copy nothing
    const request = { id: ++ids, kind, text, item };
    request.expiry = setTimeout(() => clear(request), REQUEST_TTL_MS);
    current = request;
    show(request);
  }
  // Copy (kind 'ask') or Tap to copy (kind 'tap') on the bar: called from the tap itself, so the write is inside its user activation.
  function confirm() {
    const request = current;
    if (!request) return Promise.resolve(false);
    if (!request.item.attached || !request.item.isActive()) { clear(request); return Promise.resolve(false); }
    return writeText(request.text).then(ok => {
      clear(request);
      tell(ok ? copiedMessage(request.text) : failedMessage(), ok ? 'success' : 'error');
      return ok;
    });
  }
  function cancel() { clear(); }

  // The one write of a user-initiated copy (a page selection, Cmd+C, or a program's copy right after a gesture): the notice when the browser
  // takes it, else the bar, so the next tap writes it.
  function write(item, text) {
    if (current) clear();
    return writeText(text).then(ok => {
      if (!item.attached) return false;
      if (ok) tell(copiedMessage(text), 'success');
      else if (!current || current.kind !== 'ask') offer(item, text, 'tap');
      return ok;
    });
  }
  // The same text from the same terminal within DUPLICATE_WINDOW_MS is the copy just made; it is remembered here for both sources.
  function duplicate(item, text) {
    if (text === item.lastText && now() - item.lastAt <= DUPLICATE_WINDOW_MS) return true;
    item.lastText = text;
    item.lastAt = now();
    return false;
  }

  // isActive: whether this terminal is the one the user sees (only that one may copy or ask). The page passes its own test.
  function attach(term, el, { isActive } = {}) {
    const item = {
      term, el, attached: true, replaying: false, gestureAt: -Infinity, lastText: null, lastAt: -Infinity, mouseDown: false, selectionCopied: '',
      isActive: isActive || (() => el.isConnected && !el.hidden && el.style.display !== 'none' && !(el.closest && el.closest('[hidden]'))),
    };
    term.options.macOptionClickForcesSelection = true;
    // A page selection the user finished (or copies again with Cmd+C). Uses up the gesture: a program cannot copy on the same one.
    const copy = (text, { again = false } = {}) => {
      if (!text || !item.attached || !item.isActive()) return Promise.resolve(false);
      item.gestureAt = -Infinity;
      item.selectionCopied = text;
      if (duplicate(item, text)) {
        // Cmd+C on the text whose write the browser refused: this key press is the gesture the bar waits for.
        if (again && current && current.item === item && current.kind === 'tap' && current.text === text) return confirm();
        return Promise.resolve(true);
      }
      return write(item, text);
    };
    term.attachCustomKeyEventHandler(event => {
      const shortcut = (event.metaKey && !event.ctrlKey && !event.altKey) || (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey);
      if (!shortcut || (event.key || '').toLowerCase() !== 'c' || !item.isActive() || !term.hasSelection()) return true;
      if (event.type === 'keydown') { if (event.preventDefault) event.preventDefault(); void copy(term.getSelection(), { again: true }); }
      return false;
    });
    const onCopy = event => {
      // Don't intercept selection in dialogs, editors or other DOM text.
      if (!item.isActive() || !el.contains(event.target) || !term.hasSelection() || !event.clipboardData) return;
      const text = term.getSelection();
      event.clipboardData.setData('text/plain', text);
      event.preventDefault(); event.stopImmediatePropagation();
      item.selectionCopied = text;
      if (current && current.item === item && current.text === text) clear();
      if (!duplicate(item, text)) tell(copiedMessage(text), 'success');
    };
    el.addEventListener('copy', onCopy, true);
    // The user's own gestures on this terminal: a lifted finger, mouse button or pen, and a key press in its xterm textarea. Only real (trusted)
    // events count; page scripts and programs cannot make them. The page also calls `gesture()` for its key bar and on-screen keyboard.
    const onGesture = event => { if (event.isTrusted) item.gestureAt = now(); };
    const GESTURES = ['pointerup', 'mouseup', 'touchend', 'keydown'];
    for (const type of GESTURES) el.addEventListener(type, onGesture, true);
    // Copy on select with a mouse: a press on this terminal, then the button goes up (anywhere: a drag may end outside). The window listener
    // runs after xterm's own document listener, so the selection is final; it is still inside the mouseup's user activation. A plain click
    // (no selection) and a selection that did not change copy nothing. Touch and pen are handled by the page (double / triple tap).
    const onMouseDown = event => { item.mouseDown = event.isTrusted && event.pointerType === 'mouse' && event.button === 0; };
    const onMouseUp = event => {
      if (!item.mouseDown || event.button !== 0) return;
      item.mouseDown = false;
      const text = term.hasSelection() ? term.getSelection() : '';
      if (!text) { item.selectionCopied = ''; return; }
      if (text === item.selectionCopied) return;
      void copy(text);
    };
    el.addEventListener('pointerdown', onMouseDown, true);
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('mouseup', onMouseUp);
    const osc = term.parser.registerOscHandler(52, data => {
      const text = decodeOsc52(data);
      if (!text || item.replaying || !item.isActive()) return true;
      if (current && current.kind === 'ask' && text !== current.text) return true; // the text shown for approval cannot be replaced by later output
      if (duplicate(item, text)) return true; // the same copy twice (pbcopy shim + the program's own OSC 52, or the page's selection of it)
      if (now() - item.gestureAt <= GESTURE_WINDOW_MS) {
        item.gestureAt = -Infinity; // one write per gesture
        void write(item, text);
      } else offer(item, text, 'ask');
      return true;
    });
    return {
      copy: text => copy(text),
      // Replayed history (the saved screen after a reconnect) never copies or asks.
      writeHistory(data, callback) {
        item.replaying = true;
        term.write(data, () => { item.replaying = false; if (callback) callback(); });
      },
      gesture() { item.gestureAt = now(); },
      // The terminal is hidden (another one is shown): its waiting request goes away.
      dismiss() { if (current && current.item === item) clear(); },
      dispose() {
        item.attached = false;
        osc.dispose();
        el.removeEventListener('copy', onCopy, true);
        el.removeEventListener('pointerdown', onMouseDown, true);
        if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('mouseup', onMouseUp);
        for (const type of GESTURES) el.removeEventListener(type, onGesture, true);
        if (current && current.item === item) clear();
      },
    };
  }
  function setHost(next) { host = next || null; }

  // ── Paste: reading the clipboard for the page's Paste action ──
  // WebKit (Safari and every iOS browser) lets a page read the clipboard only inside a user gesture, and each read shows the system "Paste" callout
  // (https://webkit.org/blog/10855/async-clipboard-api/); a tap elsewhere dismisses it and the read is rejected. The page used to read twice per tap
  // (`read()` for an image, then `readText()`), so the second read had no gesture left and was always refused. `readClipboard` makes exactly ONE read
  // and starts it synchronously, before its first await, so the caller must call it directly in the tap's handler. `read()` is preferred (the first
  // image, else text/plain of the same items); `readText()` is used only when `read()` does not exist, never after `read()` was refused.
  // Resolves to { kind: 'image', blob, type } | { kind: 'text', text } | { kind: 'empty' } | { kind: 'denied', error } | { kind: 'unsupported' }.
  const PASTE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;
  const blobText = blob => (typeof blob.text === 'function' ? blob.text() : new Response(blob).text());
  async function pickClipboard(items) {
    const list = [...(items || [])];
    for (const item of list) {
      const type = (item.types || []).find(name => PASTE_IMAGE.test(name));
      if (type) return { kind: 'image', blob: await item.getType(type), type };
    }
    for (const item of list) {
      if (!(item.types || []).includes('text/plain')) continue;
      const text = await blobText(await item.getType('text/plain'));
      if (text) return { kind: 'text', text };
    }
    return { kind: 'empty' };
  }
  function readClipboard(clipboard) {
    let pending;
    try {
      if (clipboard && typeof clipboard.read === 'function') pending = Promise.resolve(clipboard.read()).then(pickClipboard);
      else if (clipboard && typeof clipboard.readText === 'function') pending = Promise.resolve(clipboard.readText()).then(text => (text ? { kind: 'text', text } : { kind: 'empty' }));
      else return Promise.resolve({ kind: 'unsupported' });
    } catch (error) { return Promise.resolve({ kind: 'denied', error }); } // a read that throws at once (no gesture, policy)
    return pending.catch(error => ({ kind: 'denied', error }));
  }
  return { attach, setHost, confirm, cancel, readClipboard, pickClipboard, decodeOsc52, writeText, previewOf, GESTURE_WINDOW_MS, REQUEST_TTL_MS, DUPLICATE_WINDOW_MS, MAX_BYTES };
})();
