// Terminal clipboard (both input modes, touch and pointer): the copy shortcuts for a selection made in the page, and the OSC 52 copy
// requests of programs in the terminal (`ESC ] 52 ; c ; <base64> BEL`, sent for example by Claude Code, tmux or vim when they copy text).
// A program can never overwrite the clipboard silently:
// - a request that arrives within GESTURE_WINDOW_MS after the user's own pointer, touch or key gesture on THAT terminal (the user just selected
//   or copied something in the program) is written at once, one write per gesture, with a short "Copied" notice. When the browser refuses the
//   write there (no user activation any more, iOS Safari), the page offers "Tap to copy", and the tap writes inside its own gesture;
// - any other request asks first: the page shows the text and copies only on "Confirm copy". A request that waits expires after REQUEST_TTL_MS.
// The same text again from the same terminal within DUPLICATE_WINDOW_MS is one copy (Claude Code runs pbcopy, which the PTY's shim turns into
// OSC 52, and also sends its own OSC 52): one write, one notice, one dialog.
// Never answered: clipboard reads (`?`); ignored: replayed history, hidden terminals, invalid base64 or UTF-8, more than MAX_BYTES.
// The page draws the question (the MUI shell, `state.clipboard`); it registers with `setHost({ show })` and calls `confirm()` / `cancel()`.
const TerminalClipboard = (() => {
  const GESTURE_WINDOW_MS = 1500;
  const REQUEST_TTL_MS = 60000;
  const MAX_BYTES = 65536;
  const DUPLICATE_WINDOW_MS = 2000;
  const tell = (message, type) => (typeof notify === 'function' ? notify(message, type) : undefined); // the floating notice of the page
  const now = () => Date.now();
  let host = null; // { show(request | null) }: the page's question UI
  let current = null; // the one request the page shows: { id, kind: 'ask' | 'tap', text, chars, failed, item, expiry }
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

  const view = request => (request ? { id: request.id, kind: request.kind, text: request.text, chars: countChars(request.text), failed: Boolean(request.failed) } : null);
  function show(request) { if (host && host.show) host.show(view(request)); }
  function clear(request = current) {
    if (!request || current !== request) return;
    clearTimeout(request.expiry);
    current = null;
    show(null);
  }
  function offer(item, text, kind) {
    if (current) clear();
    if (!host) return; // no page to ask on: copy nothing
    const request = { id: ++ids, kind, text, item, failed: false };
    request.expiry = setTimeout(() => clear(request), REQUEST_TTL_MS);
    current = request;
    show(request);
  }
  // "Confirm copy" (kind 'ask') or "Tap to copy" (kind 'tap'): called from the tap itself, so the write is inside its user activation.
  function confirm() {
    const request = current;
    if (!request) return Promise.resolve(false);
    if (!request.item.attached || !request.item.isActive()) { clear(request); return Promise.resolve(false); }
    return writeText(request.text).then(ok => {
      if (current !== request) return ok;
      if (ok) { clear(request); tell(copiedMessage(request.text), 'success'); return true; }
      request.failed = true; // the dialog says so and keeps the text, so it can be selected and copied by hand
      show(request);
      return false;
    });
  }
  function cancel() { clear(); }

  // isActive: whether this terminal is the one the user sees (only that one may copy or ask). The page passes its own test.
  function attach(term, el, { isActive } = {}) {
    const item = {
      term, el, attached: true, replaying: false, gestureAt: -Infinity, lastText: null, lastAt: -Infinity,
      isActive: isActive || (() => el.isConnected && !el.hidden && el.style.display !== 'none' && !(el.closest && el.closest('[hidden]'))),
    };
    term.options.macOptionClickForcesSelection = true;
    const copySelection = () => {
      const text = term.getSelection();
      if (!text) return;
      writeText(text).then(ok => tell(ok ? 'Copied' : 'Copy failed: the browser denied clipboard access. Check permissions', ok ? 'success' : 'error'));
    };
    term.attachCustomKeyEventHandler(event => {
      const shortcut = (event.metaKey && !event.ctrlKey && !event.altKey) || (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey);
      if (!shortcut || (event.key || '').toLowerCase() !== 'c' || !item.isActive() || !term.hasSelection()) return true;
      if (event.type === 'keydown') { if (event.preventDefault) event.preventDefault(); copySelection(); }
      return false;
    });
    const onCopy = event => {
      // Don't intercept selection in dialogs, editors or other DOM text.
      if (!item.isActive() || !el.contains(event.target) || !term.hasSelection() || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', term.getSelection());
      event.preventDefault(); event.stopImmediatePropagation(); tell('Copied', 'success');
    };
    el.addEventListener('copy', onCopy, true);
    // The user's own gestures on this terminal: a lifted finger, mouse button or pen, and a key press in its xterm textarea. Only real (trusted)
    // events count; page scripts and programs cannot make them. The page also calls `gesture()` for its key bar and on-screen keyboard.
    const onGesture = event => { if (event.isTrusted) item.gestureAt = now(); };
    const GESTURES = ['pointerup', 'mouseup', 'touchend', 'keydown'];
    for (const type of GESTURES) el.addEventListener(type, onGesture, true);
    const osc = term.parser.registerOscHandler(52, data => {
      const text = decodeOsc52(data);
      if (!text || item.replaying || !item.isActive()) return true;
      if (text === item.lastText && now() - item.lastAt <= DUPLICATE_WINDOW_MS) return true; // the same copy twice (pbcopy shim + the program's own OSC 52)
      if (current && current.kind === 'ask') return true; // the text shown for approval cannot be replaced by later output
      item.lastText = text;
      item.lastAt = now();
      if (now() - item.gestureAt <= GESTURE_WINDOW_MS) {
        item.gestureAt = -Infinity; // one write per gesture
        if (current) clear();
        writeText(text).then(ok => {
          if (!item.attached) return;
          if (ok) tell(copiedMessage(text), 'success');
          else if (!current || current.kind !== 'ask') offer(item, text, 'tap'); // the browser wants a tap of its own (no user activation left)
        });
      } else offer(item, text, 'ask');
      return true;
    });
    return {
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
        for (const type of GESTURES) el.removeEventListener(type, onGesture, true);
        if (current && current.item === item) clear();
      },
    };
  }
  function setHost(next) { host = next || null; }
  return { attach, setHost, confirm, cancel, decodeOsc52, writeText, GESTURE_WINDOW_MS, REQUEST_TTL_MS, DUPLICATE_WINDOW_MS, MAX_BYTES };
})();
