// Phone page (/h5): tasks, phone terminals, image upload and translate-and-send. It shares no state with the desktop page.
// Phone terminals are separate shells (ids start with "h5-"), so a phone never resizes, replaces or reads a desktop terminal.
(() => {
  const $ = id => document.getElementById(id);
  const tell = (message, type = 'info') => notify(message, type);
  const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
  const PHONE_TERMINAL = /^h5-/;
  const SUBMIT_DELAY_MS = 120; // same as the desktop: type the text first, then Enter, so a TUI does not see a pasted newline
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const DEFAULT_GROUPS = [
    { key: 'personal', name: 'Personal tasks', sort_order: 0 },
    { key: 'doing', name: 'In progress', sort_order: 1000 },
    { key: 'todo', name: 'To do', sort_order: 2000 },
    { key: 'done', name: 'Done', sort_order: 3000 },
  ];

  async function api(method, url, body) {
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* plain-text error */ }
    if (!res.ok) throw new Error((data && data.error) || text || `HTTP ${res.status}`);
    return data;
  }
  // Remembered choices are a convenience only; private mode or blocked storage just starts fresh.
  const store = {
    get(key) { try { return localStorage.getItem(`h5-${key}`); } catch { return null; } },
    set(key, value) {
      try { if (value == null) localStorage.removeItem(`h5-${key}`); else localStorage.setItem(`h5-${key}`, String(value)); } catch { /* ignore */ }
    },
  };

  const LOCAL = { key: 'local', label: 'This machine', tasksBase: '/api/tasks', groupsBase: '/api/task-groups', wsPath: '/terminal/ws' };
  let sources = [LOCAL];
  let source = LOCAL;
  let tasks = [];
  let groups = [];
  let task = null;
  let terminals = [];
  let terminalId = null;
  let session = null;
  let mods = {};
  let uploading = false;

  const terminalHost = $('h5-terminal');
  const empty = $('h5-empty');
  const tabs = $('h5-terminal-tabs');
  const keys = $('h5-keys');
  const scrollButtons = $('h5-scroll');
  const sheet = $('h5-tasks');
  const taskList = $('h5-task-list');
  const engineSelect = $('h5-engine');
  const translateForm = $('h5-translate');
  const translateInput = $('h5-translate-input');
  const translateSend = $('h5-translate-send');
  const picker = $('h5-image-picker');

  // ── Layout: follow the visual viewport so the on-screen keyboard pushes the keys up instead of covering them ──
  function fitViewport() {
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--h5-height', `${Math.round(height)}px`);
    if (window.scrollY) window.scrollTo(0, 0);
  }
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.addEventListener('resize', fitViewport);
  fitViewport();

  // ── Tasks ──
  function note(text) {
    const node = document.createElement('div');
    node.className = 'h5-list-note';
    node.textContent = text;
    taskList.replaceChildren(node);
  }

  async function loadSources() {
    try {
      const servers = await api('GET', '/api/remote-servers');
      sources = [LOCAL, ...(Array.isArray(servers) ? servers : []).map(server => ({
        key: `remote:${server.id}`, label: server.name,
        tasksBase: `/api/remote-servers/${server.id}/tasks`,
        groupsBase: `/api/remote-servers/${server.id}/task-groups`,
        wsPath: `/api/remote-servers/${server.id}/terminal/ws`,
      }))];
    } catch { sources = [LOCAL]; }
    source = sources.find(item => item.key === store.get('source')) || LOCAL;
    engineSelect.replaceChildren(...sources.map(item => {
      const option = document.createElement('option');
      option.value = item.key;
      option.textContent = item.label;
      option.selected = item === source;
      return option;
    }));
    $('h5-engine-row').hidden = sources.length < 2;
  }

  async function loadTasks() {
    const current = source;
    if (!tasks.length) note('Loading…');
    try {
      const [list, groupRows] = await Promise.all([
        api('GET', current.tasksBase),
        api('GET', current.groupsBase).catch(() => []),
      ]);
      if (current !== source) return false;
      tasks = Array.isArray(list) ? list : [];
      groups = Array.isArray(groupRows) && groupRows.length ? groupRows : DEFAULT_GROUPS;
      renderTasks();
      return true;
    } catch (error) {
      if (current === source) { tasks = []; note(`Could not load tasks: ${error.message}`); }
      return false;
    }
  }

  function renderTasks() {
    if (!tasks.length) { note('No tasks yet. Create one above'); return; }
    const ordered = [...groups].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const known = new Set(ordered.map(group => group.key));
    for (const item of tasks) {
      if (!known.has(item.status)) { known.add(item.status); ordered.push({ key: item.status, name: item.status }); }
    }
    const nodes = [];
    for (const group of ordered) {
      const members = tasks.filter(item => item.status === group.key);
      if (!members.length) continue;
      const title = document.createElement('h3');
      title.className = 'h5-group-title';
      title.textContent = group.name;
      nodes.push(title);
      for (const item of members) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'h5-task-item';
        button.textContent = item.title;
        if (task && task.id === item.id) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => selectTask(item));
        nodes.push(button);
      }
    }
    taskList.replaceChildren(...nodes);
  }

  function selectTask(item) {
    task = item;
    store.set(`task:${source.key}`, item ? item.id : null);
    $('h5-task-name').textContent = item ? item.title : 'Choose a task';
    closeTasks();
    void loadTerminals();
  }

  function openTasks() {
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    renderTasks();
    void loadTasks();
  }
  function closeTasks() {
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
  }

  $('h5-open-tasks').addEventListener('click', openTasks);
  $('h5-close-tasks').addEventListener('click', closeTasks);
  engineSelect.addEventListener('change', () => {
    source = sources.find(item => item.key === engineSelect.value) || LOCAL;
    store.set('source', source.key === 'local' ? null : source.key);
    tasks = [];
    task = null;
    $('h5-task-name').textContent = 'Choose a task';
    disconnect();
    terminals = [];
    renderTabs();
    showEmpty('Choose a task to open its phone terminal');
    void loadTasks();
  });
  $('h5-new-task').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('h5-new-task-title');
    const button = event.currentTarget.querySelector('button');
    const title = input.value.trim();
    if (!title || button.disabled) return;
    button.disabled = true;
    const current = source;
    try {
      const created = await api('POST', current.tasksBase, { title });
      input.value = '';
      if (current !== source) return;
      await loadTasks();
      selectTask(tasks.find(item => item.id === created.id) || created);
    } catch (error) {
      tell(`Could not create the task: ${error.message}`, 'error');
    } finally { button.disabled = false; }
  });

  // ── Phone terminals ──
  function showEmpty(text) {
    empty.textContent = text;
    empty.hidden = false;
  }

  async function loadTerminals() {
    disconnect();
    terminals = [];
    renderTabs();
    if (!task) { showEmpty('Choose a task to open its phone terminal'); return; }
    const current = task;
    showEmpty('Loading…');
    let rows;
    try { rows = await api('GET', `${source.tasksBase}/${current.id}/terminals?surface=h5`); }
    catch (error) { if (current === task) showEmpty(`Could not load terminals: ${error.message}`); return; }
    if (current !== task) return;
    // An engine that ignores surface=h5 returns desktop terminals; never attach to those.
    terminals = (Array.isArray(rows) ? rows : []).filter(row => PHONE_TERMINAL.test(row.terminal_id));
    if (!terminals.length) { showEmpty('This engine does not support phone terminals yet. Please upgrade it'); return; }
    const saved = store.get(`terminal:${source.key}:${current.id}`);
    terminalId = terminals.some(row => row.terminal_id === saved) ? saved : terminals[0].terminal_id;
    renderTabs();
    connect();
  }

  function renderTabs() {
    const nodes = terminals.map(row => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(row.terminal_id === terminalId));
      button.textContent = row.title;
      button.addEventListener('click', () => {
        // Tapping the current tab reconnects a terminal that was disconnected.
        if (row.terminal_id === terminalId && session && (session.ws || session.timer)) return;
        terminalId = row.terminal_id;
        store.set(`terminal:${source.key}:${task.id}`, terminalId);
        renderTabs();
        connect();
      });
      return button;
    });
    if (terminals.length) {
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+';
      add.setAttribute('aria-label', 'New phone terminal');
      add.addEventListener('click', createTerminal);
      nodes.push(add);
    }
    tabs.replaceChildren(...nodes);
  }

  async function createTerminal() {
    if (!task) return;
    const current = task;
    try {
      const row = await api('POST', `${source.tasksBase}/${current.id}/terminals?surface=h5`, {});
      if (!row || !PHONE_TERMINAL.test(row.terminal_id)) throw new Error('This engine does not support phone terminals yet. Please upgrade it');
      if (current !== task) return;
      terminals.push(row);
      terminalId = row.terminal_id;
      store.set(`terminal:${source.key}:${current.id}`, terminalId);
      renderTabs();
      connect();
    } catch (error) { tell(`Could not create the terminal: ${error.message}`, 'error'); }
  }

  const connected = s => Boolean(s && s === session && !s.paused && s.ws && s.ws.readyState === WebSocket.OPEN);
  function send(s, data) {
    if (uploading || !connected(s)) return false;
    s.ws.send(data);
    return true;
  }
  function sendResize(s) {
    if (s.ws && s.ws.readyState === WebSocket.OPEN && s.term.cols && s.term.rows) {
      s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
    }
  }
  function refit(s) { if (!s.disposed) TerminalViewport.fit(s.term, s.fit, s.el); }

  function connect() {
    disconnect();
    if (!task || !terminalId) return;
    empty.hidden = true;
    const el = document.createElement('div');
    el.className = 'h5-xterm';
    terminalHost.append(el);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1e1e1e' },
      scrollback: 5000,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const s = { term, fit, el, ws: null, timer: null, attempts: 0, paused: false, disposed: false, task, terminalId, source };
    session = s;
    term.onData(data => send(s, withModifiers(data)));
    term.onResize(() => { if (!s.paused) sendResize(s); });
    bindTouchScroll(s);
    s.observer = new ResizeObserver(() => refit(s));
    s.observer.observe(el);
    refit(s);
    open(s);
  }

  // xterm only reacts to the mouse wheel. In the normal buffer the browser scrolls the history natively, but a full-screen
  // program (alternate buffer: Claude Code, Codex, vim, tmux ...) has no scrollback, so a drag is turned into wheel events and
  // xterm forwards them the way a desktop wheel would (mouse reports, or arrow keys when the program has no mouse mode).
  function lineHeight(s) {
    const screen = s.el.querySelector('.xterm-screen');
    return screen && s.term.rows ? Math.max(8, screen.clientHeight / s.term.rows) : 16;
  }
  function wheel(s, lines, x, y) {
    const target = s.el.querySelector('.xterm-screen') || s.el;
    for (let i = 0; i < Math.min(Math.abs(lines), 10); i++) {
      target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 1, deltaY: Math.sign(lines), clientX: x, clientY: y }));
    }
  }
  function bindTouchScroll(s) {
    let touch = null;
    s.el.addEventListener('touchstart', event => {
      touch = event.touches.length === 1 ? { y: event.touches[0].clientY, rest: 0 } : null;
    }, { passive: true });
    s.el.addEventListener('touchmove', event => {
      if (!touch || event.touches.length !== 1 || s.term.buffer.active.type !== 'alternate') return;
      const point = event.touches[0];
      touch.rest += touch.y - point.clientY;
      touch.y = point.clientY;
      const height = lineHeight(s);
      const lines = Math.trunc(touch.rest / height);
      event.preventDefault();
      if (!lines) return;
      touch.rest -= lines * height;
      wheel(s, lines, point.clientX, point.clientY);
    }, { passive: false });
    s.el.addEventListener('touchend', () => { touch = null; }, { passive: true });
    s.el.addEventListener('touchcancel', () => { touch = null; }, { passive: true });
  }

  function open(s) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${s.source.wsPath}?taskId=${s.task.id}&terminalId=${encodeURIComponent(s.terminalId)}`);
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    ws.onopen = () => {
      if (s.ws !== ws || s.disposed) return;
      s.attempts = 0;
      refit(s);
      sendResize(s);
    };
    ws.onmessage = event => {
      if (s.ws !== ws || s.disposed) return;
      if (typeof event.data === 'string' && event.data.startsWith('{')) {
        let message = null;
        try { message = JSON.parse(event.data); } catch { /* terminal output that happens to start with "{" */ }
        if (message && message.type === 'history') { replay(s, ws, message); return; }
        if (message && message.type === 'history-page') return;
      }
      s.term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
    };
    ws.onclose = event => {
      if (s.ws !== ws || s.disposed) return;
      s.ws = null;
      if (event.code === 1000 || event.code === 1008) {
        s.term.write(tr('\r\n[Terminal disconnected. Tap the terminal tab to reconnect]\r\n'));
        return;
      }
      const delay = Math.min(1000 * (2 ** s.attempts), 30000);
      s.attempts += 1;
      s.term.write(tr(`\r\n\x1b[33m[Connection lost, reconnecting in ${Math.ceil(delay / 1000)}s...]\x1b[0m\r\n`));
      s.timer = setTimeout(() => { s.timer = null; if (session === s && !s.disposed) open(s); }, delay);
    };
    ws.onerror = () => {};
  }

  // The server sends the saved screen first; input is held back until it has been drawn.
  function replay(s, ws, message) {
    s.paused = true;
    s.term.reset();
    if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 1000 && message.rows >= 1 && message.rows <= 1000) {
      s.term.resize(message.cols, message.rows);
    }
    s.term.write(typeof message.data === 'string' ? message.data : '', () => {
      if (s.ws !== ws || s.disposed) return;
      refit(s);
      s.term.scrollToBottom();
      sendResize(s);
      requestAnimationFrame(() => requestAnimationFrame(() => { if (s.ws === ws) s.paused = false; }));
    });
  }

  function disconnect() {
    const s = session;
    session = null;
    if (!s) return;
    s.disposed = true;
    clearTimeout(s.timer);
    s.observer?.disconnect();
    if (s.ws) { const ws = s.ws; s.ws = null; try { ws.close(); } catch { /* already closed */ } }
    s.term.dispose();
    s.el.remove();
  }

  // Phones drop sockets in the background; reconnect when the page comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    fitViewport();
    if (session && !session.ws && !session.timer) open(session);
  });

  // ── Keys ──
  function renderMods() {
    keys.querySelectorAll('[data-modifier]').forEach(button => {
      button.setAttribute('aria-pressed', String(Boolean(mods[button.dataset.modifier])));
    });
  }
  function clearMods() { mods = {}; renderMods(); }
  // A latched Ctrl / Alt / Shift also applies to the next character typed on the on-screen keyboard.
  function withModifiers(data) {
    if (!Object.values(mods).some(Boolean) || Array.from(data).length !== 1) return data;
    const encoded = TerminalKeys.encode(data, mods);
    clearMods();
    return encoded ?? data;
  }
  function sendKey(key, modifiers) {
    const data = TerminalKeys.encode(key, modifiers);
    clearMods();
    if (data !== null && !send(session, data)) tell('The terminal is not connected', 'error');
  }
  function toggleKeyboard() {
    if (!session) return;
    if (session.el.contains(document.activeElement)) document.activeElement.blur();
    else session.term.focus();
  }
  async function paste() {
    if (!session) return;
    let text;
    try {
      if (!navigator.clipboard?.readText) throw new Error('unsupported');
      text = await navigator.clipboard.readText();
    } catch {
      tell(window.isSecureContext ? 'Paste failed: the browser denied clipboard access. Check permissions'
        : 'Paste needs HTTPS or localhost; the browser blocks clipboard reads here', 'error');
      return;
    }
    if (!text) { tell('The clipboard is empty'); return; }
    if (uploading || !connected(session)) { tell('The terminal is not connected', 'error'); return; }
    session.term.paste(text);
  }

  // The floating buttons move about a page per click: scrollback in the normal buffer, wheel events in a full-screen program.
  scrollButtons.addEventListener('mousedown', event => event.preventDefault());
  scrollButtons.addEventListener('click', event => {
    const button = event.target.closest('button');
    const s = session;
    if (!button || !s || s.disposed) return;
    const direction = Number(button.dataset.scroll);
    if (s.term.buffer.active.type === 'alternate') {
      const rect = (s.el.querySelector('.xterm-screen') || s.el).getBoundingClientRect();
      wheel(s, direction * 5, rect.left + rect.width / 2, rect.top + rect.height / 2);
    } else {
      s.term.scrollLines(direction * Math.max(1, s.term.rows - 2));
    }
  });

  // Keep focus where it is, so tapping keys does not open or close the on-screen keyboard.
  keys.addEventListener('mousedown', event => event.preventDefault());
  keys.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.modifier) {
      const name = button.dataset.modifier;
      mods[name] = !mods[name];
      renderMods();
    } else if (button.dataset.action === 'keyboard') toggleKeyboard();
    else if (button.dataset.action === 'paste') void paste();
    else if (button.dataset.action === 'image') pickImage();
    else if (button.dataset.action === 'translate') toggleTranslate();
    else if (button.dataset.shortcut === 'ctrl-c') sendKey('c', { ctrl: true });
    else if (button.dataset.key) sendKey(button.dataset.key, mods);
  });

  // ── Translate and send ──
  let translating = false;
  function autosize() {
    translateInput.style.height = 'auto';
    if (translateInput.value) translateInput.style.height = `${translateInput.scrollHeight + 2}px`;
  }
  function toggleTranslate(show = translateForm.hidden, focus = true) {
    translateForm.hidden = !show;
    keys.querySelector('[data-action="translate"]').setAttribute('aria-pressed', String(show));
    store.set('translate', show ? '1' : null);
    if (show && focus) translateInput.focus();
  }
  async function translate() {
    const text = translateInput.value.trim();
    if (translating || !text) return;
    const target = session;
    if (uploading || !connected(target)) { tell('The terminal is not connected', 'error'); return; }
    translating = true;
    translateInput.readOnly = translateSend.disabled = true;
    translateInput.classList.add('translating');
    try {
      const result = await api('POST', '/api/translate', { text });
      const english = TerminalTranslate.sanitize(result && result.text);
      if (!english) throw new Error('Translation result is empty');
      if (!send(target, english)) throw new Error('Terminal not connected; translation was not sent');
      setTimeout(() => send(target, '\r'), SUBMIT_DELAY_MS);
      translateInput.value = '';
      autosize();
    } catch (error) {
      const message = error.message || 'Translation failed';
      tell(message, 'error');
      if (/not configured/i.test(message)) tell('Set up the translation service on the desktop page');
    } finally {
      translating = false;
      translateInput.readOnly = translateSend.disabled = false;
      translateInput.classList.remove('translating');
    }
  }
  translateForm.addEventListener('submit', event => { event.preventDefault(); void translate(); });
  translateInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return; // Enter that picks an IME candidate
    event.preventDefault();
    void translate();
  });
  translateInput.addEventListener('input', autosize);

  // ── Image upload: the Client uploads to OSS and the link is typed into the terminal without Enter ──
  let pickedFor = null;
  function pickImage() {
    if (uploading) return;
    if (!connected(session)) { tell('The original terminal is not connected. Reconnect and retry', 'error'); return; }
    pickedFor = session;
    picker.value = '';
    picker.click();
  }
  picker.addEventListener('change', () => {
    const file = picker.files[0];
    const target = pickedFor;
    pickedFor = null;
    picker.value = '';
    if (file && target) void upload(target, file);
  });

  function lock() {
    uploading = true;
    document.activeElement?.blur();
    const overlay = document.createElement('div');
    overlay.className = 'h5-upload-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Uploading image');
    const card = document.createElement('div');
    card.className = 'h5-upload-card';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Reading OSS settings…';
    const progress = document.createElement('progress');
    progress.max = 100;
    progress.setAttribute('aria-label', 'Browser transfer progress');
    card.append(status, progress);
    overlay.append(card);
    document.body.append(overlay);
    return { status, progress, unlock() { overlay.remove(); uploading = false; } };
  }

  function transfer(file, ui) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/oss/images');
      xhr.timeout = 120000;
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      ui.status.textContent = 'Sending image to the client…';
      ui.progress.value = 0;
      xhr.upload.onprogress = event => {
        if (!event.lengthComputable) { ui.progress.removeAttribute('value'); return; }
        ui.progress.value = Math.min(100, Math.round(event.loaded / event.total * 100));
        ui.status.textContent = tr(`Sending image to the client: ${ui.progress.value}%`);
      };
      xhr.upload.onload = () => { ui.progress.removeAttribute('value'); ui.status.textContent = 'Client received the image; uploading to OSS…'; };
      xhr.onload = () => {
        let result;
        try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('Upload failed: invalid response from the server')); return; }
        if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(result.error || 'Image upload failed')); return; }
        try {
          const url = new URL(result.url);
          if (url.protocol !== 'https:' || /[\s\x00-\x1f\x7f]/.test(result.url)) throw new Error();
          resolve(result);
        } catch { reject(new Error('Upload failed: the server returned an invalid image link')); }
      };
      xhr.onerror = () => reject(new Error('Image upload failed. Check your network and retry'));
      xhr.ontimeout = () => reject(new Error('Image upload timed out. Please retry'));
      xhr.onabort = () => reject(new Error('Image upload cancelled'));
      xhr.send(file);
    });
  }

  // When the terminal went away during the upload, keep the link on screen so it is not lost.
  function retain(url) {
    const overlay = document.createElement('div');
    overlay.className = 'h5-upload-overlay';
    const card = document.createElement('div');
    card.className = 'h5-upload-card';
    const label = document.createElement('p');
    label.textContent = 'Image uploaded; the original terminal was switched or disconnected. Copy the link manually:';
    const field = document.createElement('input');
    field.readOnly = true;
    field.value = url;
    field.style.width = '100%';
    field.setAttribute('aria-label', 'Uploaded image link');
    field.addEventListener('click', () => field.select());
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'h5-header-button';
    close.style.marginTop = '12px';
    close.textContent = 'Close';
    close.addEventListener('click', () => overlay.remove());
    card.append(label, field, close);
    overlay.append(card);
    document.body.append(overlay);
  }

  async function upload(target, file) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
      tell('Choose a PNG, JPEG, GIF or WebP image up to 10 MiB', 'error');
      return;
    }
    const ui = lock();
    let result;
    let failure;
    try {
      let config;
      try { config = await api('GET', '/api/oss/config'); }
      catch { throw new Error('Could not read OSS settings. Check the connection and retry'); }
      if (!config || !config.enabled) throw new Error('Enable Alibaba Cloud OSS image upload in this client’s settings first');
      result = await transfer(file, ui);
    } catch (error) { failure = error; } finally { ui.unlock(); }
    if (failure) { tell(failure.message, 'error'); return; }
    // xterm's paste keeps bracketed-paste semantics; a trailing space lets typing continue, and no Enter is sent.
    if (connected(target)) target.term.paste(`${result.url} `);
    else retain(result.url);
  }

  // ── Start ──
  (async () => {
    if (store.get('translate')) toggleTranslate(true, false);
    await loadSources();
    await loadTasks();
    const savedId = Number(store.get(`task:${source.key}`));
    const saved = tasks.find(item => item.id === savedId);
    if (saved) selectTask(saved);
    else openTasks();
  })();
})();
