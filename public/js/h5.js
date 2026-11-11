// The page (/ and /h5, for every device): tasks, terminals, image upload and translate-and-send. Its task terminals are shared with other open copies
// of the page and other Clients; only one client at a time is attached to a terminal, and the other one can take it over with a button.
// This file is the controller: the tasks, the terminals and their sockets, the chat, the viewport. What the page looks like is the Material UI shell
// (scripts/h5-shell, js/h5-shell.js): this file writes the state the shell shows (`ui.set`) and registers what a tap does (`ui.actions`).
(() => {
  const $ = id => document.getElementById(id);
  const ui = window.H5UI;
  // Input mode, decided by the shell from media queries (scripts/h5-shell/entry.jsx; never from the user agent): 'pointer' on a computer with a mouse or
  // trackpad and no touch screen, 'touch' otherwise. The on-screen keyboard handling below runs only in touch mode.
  const pointerMode = () => ui.get().input === 'pointer';
  // The computer keyboard shortcuts (typing to the terminal, Escape back to it, Cmd/Ctrl+K): on a computer, and on a touch device once a hardware keyboard was used.
  const deskKeys = () => pointerMode() || Boolean(ui.get().hasKeyboard);
  const terminalFontSize = () => (pointerMode() ? 13 : 11);
  const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const tell = (message, type = 'info') => notify(message, type);
  const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
  const errorOf = body => (typeof I18n !== 'undefined' ? I18n.errorOf(body) : body && body.error);
  const SUBMIT_DELAY_MS = 120; // type the text first, then Enter, so a TUI does not see a pasted newline
  const DEFAULT_GROUPS = [
    { key: 'personal', name: 'Personal tasks', sort_order: 0 },
    { key: 'doing', name: 'In progress', sort_order: 1000 },
    { key: 'todo', name: 'To do', sort_order: 2000 },
    { key: 'done', name: 'Done', sort_order: 3000 },
  ];

  async function api(method, url, body) {
    if (method === 'GET' && early.has(url)) { const answer = early.get(url); early.delete(url); return answer; }
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* plain-text error */ }
    if (!res.ok) throw Object.assign(new Error(errorOf(data) || text || `HTTP ${res.status}`), { data, status: res.status }); // `data`: the whole error body (a `reason` ...)
    return data;
  }
  // Remembered choices are a convenience only; private mode or blocked storage just starts fresh.
  // In a pane of the multi-column view (scripts/h5-shell/pane.mjs) what this view shows is kept per pane (`pane:<id>:h5-...`); the keys in SHARED_KEYS stay
  // one for the device. See "Pane mode" in DESIGN.md for the list.
  const PANE = window.H5Pane || null;
  const SHARED_KEYS = new Set(['terminal-width-noted']);
  const storeKey = key => (PANE && !SHARED_KEYS.has(key) ? PANE.key(`h5-${key}`) : `h5-${key}`);
  const store = {
    get(key) { try { return localStorage.getItem(storeKey(key)); } catch { return null; } },
    set(key, value) {
      try { if (value == null) localStorage.removeItem(storeKey(key)); else localStorage.setItem(storeKey(key), String(value)); } catch { /* ignore */ }
    },
  };

  // ── Early requests (start) ──
  // A slow phone network pays a full round trip for each request that waits for another one. At start the page therefore asks at once for what it
  // will need: the list of services, the tasks and groups of this machine and of the remembered service, and for the remembered task its terminals; and it opens the
  // WebSocket of the remembered terminal. An early answer is used when the normal code asks for the same URL (in `api`, once, within EARLY_MS); the
  // early socket is taken by `open` when the terminal shown is that one, and closed cleanly when it is not (the task or the terminal is gone, another
  // one was chosen), so the server never keeps a stray attachment.
  const EARLY_MS = 20000;
  const early = new Map(); // url -> the promise of its answer
  function prefetch(url) {
    const answer = api('GET', url);
    answer.catch(() => {}); // a failure is handled by whoever uses it
    early.set(url, answer);
    setTimeout(() => { if (early.get(url) === answer) early.delete(url); }, EARLY_MS);
  }
  let earlySocket = null; // { source, taskId, terminalId, ws, events, timer }
  const socketUrl = (from, taskId, id, takeover) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${from.wsPath}?taskId=${taskId}&terminalId=${encodeURIComponent(id)}${TerminalOwner.query(takeover)}${TerminalProtocol.query()}`;
  function openEarlySocket(from, taskId, id) {
    const ws = new WebSocket(socketUrl(from, taskId, id, false));
    ws.binaryType = 'arraybuffer';
    const entry = { source: from, taskId, terminalId: id, ws, events: [] };
    // Until `open` takes it, what arrives is kept in order and handed over then (the history snapshot usually comes before the terminal exists).
    ws.onopen = event => entry.events.push(['onopen', event]);
    ws.onmessage = event => entry.events.push(['onmessage', event]);
    ws.onclose = event => entry.events.push(['onclose', event]);
    ws.onerror = () => {};
    entry.timer = setTimeout(dropEarlySocket, EARLY_MS);
    earlySocket = entry;
  }
  function dropEarlySocket() {
    const entry = earlySocket;
    earlySocket = null;
    if (!entry) return;
    clearTimeout(entry.timer);
    try { entry.ws.close(1000); } catch { /* already closed */ }
  }
  function takeEarlySocket(s) {
    const entry = earlySocket;
    if (!entry || entry.source !== s.source || entry.taskId !== s.task.id || entry.terminalId !== s.terminalId) { dropEarlySocket(); return null; }
    earlySocket = null;
    clearTimeout(entry.timer);
    return entry;
  }

  // A source is one service whose tasks are in the list: this machine, or a connected service (a remote Engine or a linked service). Each keeps its own list:
  // `tasks`, `groups`, `status` ('new' until its first answer, 'ready', or 'offline' when its last read failed) and `failure` (what that read said).
  const withList = from => Object.assign(from, { tasks: [], groups: DEFAULT_GROUPS, status: 'new', failure: '', loadSeq: 0, checkedAt: 0 });
  const LOCAL = withList({ key: 'local', label: 'This machine', tasksBase: '/api/tasks', groupsBase: '/api/task-groups', wsPath: '/terminal/ws', activityBase: '/api/tasks' });
  const remoteSource = (id, name) => withList({
    key: `remote:${id}`, label: name,
    tasksBase: `/api/remote-servers/${id}/tasks`,
    groupsBase: `/api/remote-servers/${id}/task-groups`,
    wsPath: `/api/remote-servers/${id}/terminal/ws`,
    activityBase: `/api/remote-servers/${id}`, // {activityBase}/terminal-activity and /terminal-subagents
  });
  let sources = [LOCAL];
  // The devices left out of the task list ("Show in task list" in Settings, `/api/task-list/hidden-devices`). Display only: a hidden device stays connected.
  const HIDDEN_URL = '/api/task-list/hidden-devices';
  let hiddenDevices = new Set();
  let hiddenSupported = false; // an older server has no such route: nothing is hidden and the switches do not appear
  let hiddenSeq = 0;
  let listReady = false; // both the services and what is hidden are known: until then the list says "Loading…", so a hidden device never flashes by
  // The sources of the list, in list order. At least one device always stays visible. A source without a name is the remembered one, assumed before the list of services has answered.
  function listedSources() {
    const named = sources.filter(item => item === LOCAL || item.label);
    const visible = named.filter(item => !hiddenDevices.has(item.key));
    return visible.length ? visible : named;
  }
  // Task ids repeat between services: everything kept per task is keyed by this. The shell hands it back from a row of the list.
  const taskRef = (from, taskId) => `${from.key}|${taskId}`;
  const findTask = (from, taskId) => from.tasks.find(entry => String(entry.id) === String(taskId));
  // The row a ref names. A bare id (T-Attention's way back) is a task of this machine.
  function resolveRef(ref) {
    const text = String(ref);
    const cut = text.lastIndexOf('|');
    const from = cut < 0 ? LOCAL : sources.find(item => item.key === text.slice(0, cut));
    const item = from && findTask(from, text.slice(cut + 1));
    return item ? { from, item } : null;
  }
  // What an Engine can do: the `capabilities` of its `/info` (`/v1/info` through the proxy), kept on its source object each time the page reads it
  // (the list of a task that is not selected reads it again, so an upgraded Engine is seen). The local Client has no such list and can do everything the
  // page asks for here. One read at a time per Engine.
  const infoUrl = from => `${from.tasksBase.replace(/\/tasks$/, '')}/info`;
  function readInfo(from) {
    if (from.infoPending) return from.infoPending;
    const pending = api('GET', infoUrl(from)).then(info => {
      from.capabilities = Array.isArray(info && info.capabilities) ? info.capabilities : [];
      return info;
    }).finally(() => { if (from.infoPending === pending) from.infoPending = null; });
    from.infoPending = pending;
    return pending;
  }
  // Files at any path of the Engine machine (`/fs/content`, `/fs/image`): the local Client always, a remote Engine with 'fs:read-any'.
  const readsAnyPath = from => from.key === 'local' || Boolean(Array.isArray(from.capabilities) && from.capabilities.includes('fs:read-any'));
  const fsBase = from => `${from.tasksBase.replace(/\/tasks$/, '')}/fs`; // /api/fs, or /api/remote-servers/:id/fs
  // Archiving tasks: the local Client always, a remote Engine with 'tasks:archive'. An Engine that has not said yet shows no archive UI.
  // `archiveMissing`: its answers showed that this source does not implement archiving (`noArchiving`), which holds until the page is loaded again.
  const archives = from => !from.archiveMissing && (from.key === 'local' || Boolean(Array.isArray(from.capabilities) && from.capabilities.includes('tasks:archive')));
  // The service of the task that is shown, set by selecting a task (this machine when none is shown). There is no switch: all the services are in one list.
  let source = LOCAL;
  let task = null;
  const isShown = (from, taskId) => from === source && Boolean(task) && String(task.id) === String(taskId);
  let terminals = [];
  let terminalsState = 'none'; // what `terminals` is for the selected task: 'loading', 'ready' or 'error'
  let terminalsSeq = 0; // the newest `loadTerminals`: an older one is ignored when it answers, also when the same task was selected again
  let terminalId = null;
  const expanded = new Set(); // the refs (`taskRef`) of the tasks whose sessions are listed in the task sheet (a tap on a task opens and closes its list; it does not open the task); any number can be open
  const peeks = new Map(); // ref -> the sessions of an expanded task that is not the selected one: { source, taskId, status, terminals }
  let peekSeq = 0;
  const PEEK_WAIT_MS = 10000; // a list still on "Loading…" after this long says it could not be read (a late answer still replaces that)
  // The Restart and Delete requests on their way, by Engine and task (a promise that ends when all of them have). A list of that task read meanwhile would
  // show the old row, or connect to a terminal that is going away, so `loadTerminals` and `loadPeek` wait for it. Without one there is nothing to wait for.
  const actionsRunning = new Map();
  const actionsDone = (from, taskId) => actionsRunning.get(taskRef(from, taskId));
  function trackAction(target, pending) {
    const key = taskRef(target.from, target.taskId);
    const all = Promise.all([actionsRunning.get(key), pending.catch(() => {})]).then(() => { if (actionsRunning.get(key) === all) actionsRunning.delete(key); });
    actionsRunning.set(key, all);
    return pending;
  }
  let wantedTerminal = null; // the terminal to show when the terminals of the task just selected arrive
  let terminalsLoaded = Promise.resolve(); // settles when the list of the task just selected has been read
  let session = null;
  let mods = {};
  let uploading = false;

  const terminalHost = $('h5-terminal');
  const translateForm = $('h5-translate');
  const translateInput = $('h5-translate-input');
  const bottomArea = $('h5-bottom'); // the function keys and the message bar; this box is what grows over the terminal
  const picker = $('h5-image-picker');

  // ── Layout: follow the visual viewport so the on-screen keyboard pushes the keys up instead of covering them ──
  // The terminal itself keeps the size it had before the keyboard opened and is shifted up instead: a smaller terminal would
  // resize the PTY, and a full-screen program (Claude Code, vim, tmux) redraws its whole screen on every resize.
  const KEYBOARD_MIN_SHRINK = 8;
  const TERMINAL_MIN_HEIGHT = 48; // px; below this the terminal box is treated as collapsed (about three rows)
  const KEYBOARD_CLOSE_MS = 1000; // how long after the focus left a keyboard may still be going down
  // The elements that take typed text. The computer keyboard shortcuts below use this too.
  const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
  const editing = el => Boolean(el && el.closest && el.closest(EDITABLE));
  const NO_KEYBOARD_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
  // Can this focused element have an on-screen keyboard up? Not the terminal's textarea (`noScreenKeyboard` gives it inputmode="none"), and not a field that takes no typing.
  // What has the focus inside an iframe cannot be seen from here, so an iframe counts.
  function raisesKeyboard(el) {
    if (el && el.tagName === 'IFRAME') return true;
    if (!editing(el)) return false;
    const field = el.closest(EDITABLE);
    if (field.tagName === 'INPUT' && NO_KEYBOARD_INPUTS.has(field.type)) return false;
    return field.getAttribute('inputmode') !== 'none' && !field.readOnly && !field.disabled;
  }
  let fullHeight = 0;
  let fullWidth = 0;
  let closedTerminalHeight = 0; // the terminal box height while the keyboard is closed
  let keyboardOpen = false;
  let focusLeftAt = 0;
  function fitViewport() {
    if (pointerMode()) {
      // A computer has no on-screen keyboard: a shorter window is just a shorter window. The page follows the window height and the terminal refits
      // (a real size change, so the PTY resize is right); nothing is pinned or shifted, and no keyboard timers run.
      keyboardOpen = false;
      fullHeight = 0;
      fullWidth = 0;
      document.documentElement.style.setProperty('--h5-height', `${Math.round(window.innerHeight)}px`);
      if (window.scrollY) window.scrollTo(0, 0);
      holdTerminalSize();
      return;
    }
    const reading = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (window.innerWidth !== fullWidth) { fullWidth = window.innerWidth; fullHeight = 0; } // rotated: measure again
    // A shorter visual viewport is the on-screen keyboard only while something that raises one has the focus. With nothing like that, a small reading is not believed
    // (iOS in standalone mode was seen with a page about 200px tall and the terminal box at height 0): the page takes the larger of the two heights, and that is also the
    // new full height, so a bad reading cannot make a later one look like a keyboard. `innerHeight` still follows a real change (a shorter window, the Safari URL bar).
    // After a blur a keyboard that also shortens the window (Android, interactive-widget=resizes-content) is still going down for a moment: the terminal stays pinned, or it
    // would resize the PTY twice.
    const closing = keyboardOpen && window.innerHeight < fullHeight - KEYBOARD_MIN_SHRINK && performance.now() - focusLeftAt < KEYBOARD_CLOSE_MS;
    const typing = raisesKeyboard(document.activeElement) || closing;
    const height = typing ? reading : Math.max(reading, window.innerHeight);
    fullHeight = typing ? Math.max(fullHeight, height) : height;
    const wasOpen = keyboardOpen;
    keyboardOpen = fullHeight - height > KEYBOARD_MIN_SHRINK;
    if (wasOpen && !keyboardOpen) {
      // The keyboard went away: the translate box returns to rest at once (no timer; blur runs the focusout handler, which collapses the box, the bar and the terminal
      // shift in the same tick). One animation frame of grace only, because iOS can report the full height for a moment while focus moves between two inputs.
      requestAnimationFrame(() => { if (!keyboardOpen && document.activeElement === translateInput) translateInput.blur(); });
    }
    document.documentElement.style.setProperty('--h5-height', `${Math.round(height)}px`);
    if (window.scrollY) window.scrollTo(0, 0);
    holdTerminalSize();
  }
  // The terminal is never resized for the translate bar or the keyboard, only moved. While the keyboard is open it keeps its closed height, aligned to the
  // bottom of the (shorter) box; the translate bar growing over the terminal (`barExtra`, see syncBar()) hides more of the bottom. Both are covered by ONE
  // translateY, so the two never add up twice. The shift is capped so the cursor row stays on screen (a shell prompt near the top).
  let barOverlap = 0;
  let barExtra = 0; // px the translate bar currently extends over the bottom of the terminal box
  function holdTerminalSize() {
    const el = session && session.el;
    if (!el) return;
    const pinned = keyboardOpen && closedTerminalHeight;
    if (!pinned && !barExtra) {
      el.style.removeProperty('height');
      el.style.removeProperty('bottom');
      el.style.removeProperty('transform');
      return;
    }
    const hidden = (pinned ? Math.max(0, closedTerminalHeight - terminalHost.clientHeight) : 0) + barExtra;
    const screen = el.querySelector('.xterm-screen');
    const shift = TerminalViewport.keyboardShift(session.term, screen ? screen.clientHeight : 0, hidden);
    if (pinned) {
      el.style.height = `${closedTerminalHeight - 6}px`; // the terminal sits 4px from the top and 2px from the bottom of its box
      el.style.bottom = 'auto';
    } else {
      el.style.removeProperty('height');
      el.style.removeProperty('bottom');
    }
    el.style.transform = shift ? `translateY(${-shift}px)` : '';
  }
  new ResizeObserver(() => { if (!keyboardOpen && terminalHost.clientHeight >= TERMINAL_MIN_HEIGHT) closedTerminalHeight = terminalHost.clientHeight; }).observe(terminalHost);
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', fitViewport);
  window.addEventListener('resize', fitViewport);
  fitViewport();
  // iOS Safari animates the keyboard and sometimes reports its final height without a last resize event (for example when
  // focus moves from the terminal to the translate box), which leaves the page shorter than the visible area. Measure again
  // while focus changes, while the keyboard is up, and when the page comes back (iOS can report late then as well).
  let settleTimers = [];
  function settleViewport() {
    settleTimers.forEach(clearTimeout);
    settleTimers = [];
    if (pointerMode()) return; // touch only: there is no on-screen keyboard to wait for
    settleTimers = [0, 100, 250, 500, 1000].map(delay => setTimeout(measureAgain, delay));
  }
  function measureAgain() {
    fitViewport();
    if (agentChat) fitAgentView();
    if (mindmap) fitMindmapView();
  }
  document.addEventListener('focusin', settleViewport);
  document.addEventListener('focusout', () => { focusLeftAt = performance.now(); settleViewport(); });
  window.addEventListener('pageshow', settleViewport);
  window.addEventListener('orientationchange', settleViewport);
  setInterval(() => { if (keyboardOpen && !pointerMode()) fitViewport(); }, 500);

  // ── Tasks ──
  function note(text) { ui.set({ taskList: { note: text, groups: [], sections: [] } }); }
  // The task list the shell draws: a note (loading, an error, no tasks: a list of this machine alone), or one section per service, each with its groups of tasks,
  // each task with the sessions listed under it when it is open. `groups` is this machine's own, for T-Attention's way back.
  function publishSources() {
    ui.set({
      sources: sources.filter(item => item === LOCAL || item.label).map(item => ({ key: item.key, label: item.label, offline: item.status === 'offline', hidden: hiddenDevices.has(item.key) })),
      sourceKey: source.key,
      sourceLabel: task && source !== LOCAL ? source.label : '', // the header says which service the shown task is on when it is not this machine
    });
  }

  // Reads the connected services. One that is still there keeps its object: requests in flight, sockets and warm terminals compare it.
  async function loadSources() {
    let servers;
    try { servers = await api('GET', '/api/remote-servers'); }
    catch { sources = sources.filter(item => item === LOCAL || item.label); publishSources(); return; } // this time only: what was known stays
    const before = new Map(sources.map(item => [item.key, item]));
    sources = [LOCAL, ...(Array.isArray(servers) ? servers : []).filter(server => server.enabled !== false).map(server => {
      const kept = before.get(`remote:${server.id}`);
      const from = kept ? Object.assign(kept, { label: server.name }) : remoteSource(server.id, server.name);
      if (!kept && server.status === 'offline') from.status = 'offline'; // the first read of its tasks says for sure
      return from;
    })];
    for (const from of before.values()) if (!sources.includes(from)) forgetSource(from);
    publishSources();
  }
  // A service that is no longer connected: nothing of it is kept and, when its task was shown, nothing is shown.
  function forgetSource(from) {
    const prefix = `${from.key}|`;
    for (const ref of [...expanded]) if (ref.startsWith(prefix)) expanded.delete(ref);
    for (const ref of [...peeks.keys()]) if (ref.startsWith(prefix)) peeks.delete(ref);
    if (archived.rows) archived.rows = archived.rows.filter(row => row.from !== from);
    closeWarm(item => item.source === from);
    if (earlySocket && earlySocket.source === from) dropEarlySocket();
    if (store.get('source') === from.key) store.set('source', null);
    if (source === from && task) { hideAgent(); closeTerminalMenu(); selectTask(LOCAL, null, null, { stay: true }); }
    else if (menuScope && menuScope.from === from) closeTerminalMenu();
  }

  // Reads one service. It fails on its own: a slow or offline one neither delays nor blanks the others. An older read that answers late is ignored.
  async function loadSource(from) {
    const seq = (from.loadSeq += 1);
    const stale = () => seq !== from.loadSeq || !sources.includes(from);
    from.checkedAt = Date.now();
    try {
      const [list, groupRows] = await Promise.all([
        api('GET', from.tasksBase),
        api('GET', from.groupsBase).catch(() => []),
      ]);
      if (stale()) return false;
      const back = from.status !== 'ready';
      // A task that was in the list and is not any more: deleted, archived, or hidden from this machine by the machine that owns it (only a real list says so).
      const gone = Array.isArray(list) ? from.tasks.filter(row => !list.some(next => next.id === row.id)) : [];
      from.tasks = Array.isArray(list) ? list : [];
      from.status = 'ready';
      from.failure = '';
      // This machine has no capability list, but every row of a server that can archive has the key `archived_at` (null while in use): an older process, serving
      // these newer page files until it is restarted, leaves it out. An empty list says nothing. A remote Engine is decided by its capability instead.
      if (from.key === 'local' && from.tasks.length && from.tasks.every(row => !row || !('archived_at' in row))) noArchiving(from);
      from.groups = Array.isArray(groupRows) && groupRows.length ? groupRows : DEFAULT_GROUPS;
      for (const row of gone) taskGone(from, row.id);
      renderTasks();
      showActiveCount();
      if (back) { publishSources(); syncFeeds(); } // it came back without a reload: its feed too, and what it can do is read again below
      if (from.key !== 'local' && !Array.isArray(from.capabilities)) {
        readInfo(from).catch(() => { /* an older or offline Engine: no archive UI */ }).finally(() => { showArchived(); if (archives(from)) refreshArchived(); });
      }
      return true;
    } catch (error) {
      if (stale()) return false;
      from.status = 'offline';
      from.failure = error.message;
      renderTasks();
      showActiveCount();
      publishSources();
      syncFeeds();
      return false;
    }
  }
  function loadTasks() { return Promise.all(listedSources().map(from => loadSource(from))); }
  // One read of a service's list after one of its tasks answered 404, however many of its tasks did: the list then drops the rows that are really gone.
  function recheckSource(from) {
    if (!from.recheck) from.recheck = loadSource(from).finally(() => { from.recheck = null; });
    return from.recheck;
  }
  // A slow check of the services that are offline, while the page is visible: a service that returns comes back without a reload.
  const OFFLINE_POLL_MS = 30000;
  const retryOffline = () => { for (const from of listedSources()) if (from.status === 'offline') void loadSource(from); };
  setInterval(() => { if (document.visibilityState === 'visible') retryOffline(); }, OFFLINE_POLL_MS);

  // The directory of a terminal that kept its own after the task's working directory changed (null when it is the task's).
  const otherDir = (row, item) => {
    const own = item && (item.work_dir || (item.md_path ? item.md_path.replace(/\/[^/]*$/, '') : ''));
    return row.work_dir && own && row.work_dir !== own ? row.work_dir : null;
  };
  // The sessions of the selected task: its terminals, each with "⋯" actions. Agent chats are not listed in the task sheet.
  function ownSessions() {
    return {
      label: 'Phone terminals', note: null,
      rows: [
        ...terminals.map(row => ({ kind: 'terminal', id: row.terminal_id, title: row.title, agent: row.agent || null, otherDir: otherDir(row, task), current: row.terminal_id === terminalId && !agentChat, more: true })), // no row is current while a chat covers the terminal
      ],
    };
  }
  // The sessions under an expanded task that is not selected: its terminals, as in the list of the selected task. Each has "⋯" too (see `openOtherMenu`).
  function peekSessions(from, item) {
    const label = item.title;
    const peek = peeks.get(taskRef(from, item.id));
    if (!peek || peek.status === 'loading') return { label, note: 'Loading…', rows: [] };
    if (peek.status === 'error') return { label, note: 'Could not load the sessions', rows: [] };
    const rows = [
      ...peek.terminals.map(row => ({ kind: 'terminal', id: row.terminal_id, title: row.title, agent: row.agent || null, otherDir: otherDir(row, item), current: false, more: true })),
    ];
    if (!rows.length) rows.push({ kind: 'open', id: 'open', title: tr('Open this task'), agent: null, current: false, more: false });
    return { label, note: null, rows };
  }

  // The groups of one service in the order they are drawn, each with its tasks in list order (groups without tasks left out).
  function groupedTasks(from) {
    const ordered = [...from.groups].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const known = new Set(ordered.map(group => group.key));
    for (const item of from.tasks) {
      if (!known.has(item.status)) { known.add(item.status); ordered.push({ key: item.status, name: item.status }); }
    }
    return ordered.map(group => ({ group, members: from.tasks.filter(item => item.status === group.key) })).filter(entry => entry.members.length);
  }

  function taskRow(from, item) {
    const ref = taskRef(from, item.id);
    const selected = isShown(from, item.id);
    const open = expanded.has(ref);
    // A tap opens or closes the list of sessions under the task. Going to a session is a tap on that session.
    const hasSessions = Boolean(selected && terminals.length);
    // The selected task: "+" on the right of its row adds a terminal.
    const ownList = hasSessions ? ownSessions() : terminalsState === 'error' ? { label: item.title, note: 'Could not load the sessions', rows: [] } : null;
    const peek = peeks.get(ref);
    return {
      id: item.id, ref, title: item.title, selected, expanded: open, add: true, ...activeIn(from, item.id),
      count: open ? (selected ? (hasSessions ? terminals.length : null) : (peek && peek.status === 'ready' ? peek.terminals.length : null)) : null,
      sessions: open ? (selected ? ownList : peekSessions(from, item)) : null,
    };
  }
  const sectionGroups = from => groupedTasks(from).map(({ group, members }) => ({ key: group.key, name: group.name, tasks: members.map(item => taskRow(from, item)) }));

  function renderTasks() {
    showArchived(); // first: the entry is there with an empty list too, and `readInfo` of an expanded list may just have changed what the Engine can do
    if (!listReady) { note('Loading…'); return; }
    const listed = listedSources();
    if (listed.length === 1 && listed[0] === LOCAL) { // this machine alone: no header, and it says so when the list is empty
      const message = LOCAL.status === 'new' ? 'Loading…'
        : LOCAL.status === 'offline' ? `Could not load tasks: ${LOCAL.failure}`
          : LOCAL.tasks.length ? null : 'No tasks yet. Create one above';
      if (message) { note(message); return; }
    }
    const header = !(listed.length === 1 && listed[0] === LOCAL);
    const sections = listed.map(from => ({
      key: from.key, label: from.label, local: from === LOCAL, header, offline: from.status === 'offline',
      groups: from.status === 'ready' ? sectionGroups(from) : [],
    }));
    const own = sections.find(section => section.local);
    ui.set({ taskList: { note: null, groups: own ? own.groups : [], sections } });
  }

  // Keep the screen on while a task is open (a terminal or a chat), so the phone does not sleep in the middle of a session and drop the connection.
  // The browser lets go of the lock whenever the page is hidden, so it is asked for again when the page comes back. Browsers without the API just sleep.
  let wakeLock = null;
  async function syncWakeLock() {
    const wanted = !pointerMode() && Boolean(task) && document.visibilityState === 'visible'; // touch only: a computer manages its own screen sleep
    if (!wanted) {
      if (wakeLock) { const lock = wakeLock; wakeLock = null; try { await lock.release(); } catch { /* already released */ } }
      return;
    }
    if (wakeLock || !navigator.wakeLock) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      if (!task || document.visibilityState !== 'visible') void syncWakeLock(); // the page moved on while the request was pending
    } catch { /* refused (low battery, power saver): not worth telling the person */ }
  }

  // from, item: the task and its service (`item` null: no task is shown). target: where to go in the task, { terminal: id } or { chat: row } (a notification link, see
  // `openChatFromLink`); without one, the task opens on its terminal. stay: the task sheet of a phone stays open (the "+" of a task that was not selected shows its Session
  // list in the sheet, under that task). remember: false for a fallback at page load, so the service that was remembered is tried again on the next one.
  function selectTask(from, item, target = null, { stay = false, remember = true } = {}) {
    const next = item ? from : LOCAL;
    // A chat open over another task is put away.
    if (agentChat && agentFor && (!item || agentFor.taskId !== item.id || agentFor.source !== next.key)) hideAgent();
    const leftFrom = source;
    const left = task && !(item && isShown(next, item.id)) && expanded.has(taskRef(leftFrom, task.id)) ? task : null;
    // The task being left is listed from `peeks` from now on, and nothing else would read it until the next `openTasks`: it keeps what is known at once and is read again.
    if (left && terminalsState === 'ready') peeks.set(taskRef(leftFrom, left.id), { source: leftFrom, taskId: left.id, status: 'ready', terminals: [...terminals], seq: (peekSeq += 1) });
    if (!item && leftFrom !== next) store.set(`task:${leftFrom.key}`, null);
    source = next;
    task = item;
    if (left) void loadPeek(leftFrom, left);
    void syncWakeLock();
    const ref = item ? taskRef(next, item.id) : null;
    if (item) { peeks.delete(ref); expanded.add(ref); } // the other open lists stay open
    // The Session list of the task that was selected: its choices act on the selected task, so they cannot stay under another one (the "+" of a task lands here too, and then opens its own).
    const menu = ui.get().menu;
    if (menu && menu.naming && !(item && menu.task === ref)) closeTerminalMenu();
    wantedTerminal = target && target.terminal ? target.terminal : null;
    store.set(`task:${next.key}`, item ? item.id : null);
    if (remember) store.set('source', next === LOCAL ? null : next.key);
    ui.set({ taskName: item ? item.title : '' });
    publishSources();
    syncFeeds(); // the service of the shown task comes first for a live stream
    syncFiles();
    if (!stay) closeTasks();
    terminalsLoaded = loadTerminals();
    if (target && target.chat) mountAgent(target.chat);
  }

  // Opens or closes the list of sessions under a task, without going anywhere.
  function toggleTask(from, item) {
    const ref = taskRef(from, item.id);
    if (expanded.has(ref)) { expanded.delete(ref); peeks.delete(ref); closeListMenu(ref); renderTasks(); return; }
    expanded.add(ref);
    if (!isShown(from, item.id)) void loadPeek(from, item);
    else retryTerminals();
    renderTasks();
  }
  // "Expand all" / "Collapse all" in the header of the task list: every service in the list.
  function setAllExpanded(open) {
    expanded.clear();
    peeks.clear();
    if (!open) closeListMenu();
    if (open) for (const from of listedSources()) for (const item of from.tasks) { expanded.add(taskRef(from, item.id)); if (!isShown(from, item.id)) void loadPeek(from, item); }
    renderTasks();
  }
  // The terminals of a task that is not the selected one, read when its list is opened. `from` is the service of the row.
  async function loadPeek(from, item) {
    const ref = taskRef(from, item.id);
    const mine = { source: from, taskId: item.id, status: 'loading', terminals: [], seq: (peekSeq += 1) };
    const before = peeks.get(ref);
    if (!before) peeks.set(ref, mine); // a list that is already shown stays until the new one is read
    const noAnswer = setTimeout(() => {
      if (peeks.get(ref) !== mine || mine.status !== 'loading') return;
      mine.status = 'error';
      renderTasks();
    }, PEEK_WAIT_MS);
    await actionsDone(from, item.id);
    const [rows] = await Promise.all([
      api('GET', `${from.tasksBase}/${item.id}/terminals`).catch(error => { if (error.status === 404) void recheckSource(from); return null; }),
      // What the Engine can do decides the actions of these rows (`controlsTerminals`). An Engine that does not answer must not hold the list back.
      from.key === 'local' ? null : Promise.race([readInfo(from).catch(() => null), new Promise(resolve => setTimeout(resolve, PEEK_WAIT_MS))]),
    ]);
    clearTimeout(noAnswer);
    if (!expanded.has(ref) || isShown(from, item.id) || (peeks.get(ref) && peeks.get(ref).seq > mine.seq)) return; // the selected task is listed from `terminals`
    peeks.set(ref, mine);
    mine.status = Array.isArray(rows) ? 'ready' : 'error';
    mine.terminals = Array.isArray(rows) ? rows : [];
    renderTasks();
  }
  // A wide screen (a computer, a landscape tablet) shows the task list as a permanent sidebar next to the terminal: it is never closed,
  // the page behind it stays usable, and a phone-sized screen keeps the sheet that slides over the page.
  const wideQuery = (ui.media && ui.media.wideQuery) || window.matchMedia('(min-width: 900px)'); // the same query object as the shell's
  const isWide = () => wideQuery.matches;
  function openTasks() {
    const wide = isWide();
    if (task) expanded.add(taskRef(source, task.id)); // the sheet opens with the sessions of the task that is shown; the lists the person opened stay open
    retryTerminals();
    for (const from of listedSources()) for (const item of from.tasks) if (expanded.has(taskRef(from, item.id)) && !isShown(from, item.id)) void loadPeek(from, item); // read again: they may have changed
    ui.set({ tasksOpen: true, wide });
    renderTasks();
    void loadTasks();
    void loadHidden(); // set on another device too
    void loadLinks();
    void refreshTerminals();
    clearInterval(namesTimer);
    namesTimer = setInterval(() => void refreshTerminals(), 8000);
  }
  // Claude / Codex terminals are named after their session, which can change inside the agent (rename, first prompt): refresh while the list is open.
  let namesTimer = null;
  async function refreshTerminals() {
    const current = task;
    const from = source;
    if (!current || !terminals.some(row => row.agent)) return;
    let rows;
    try { rows = await api('GET', `${from.tasksBase}/${current.id}/terminals`); } catch { return; }
    if (current !== task || !Array.isArray(rows)) return;
    const fresh = new Map(rows.map(row => [row.terminal_id, row]));
    let changed = false;
    for (const row of terminals) {
      const next = fresh.get(row.terminal_id);
      if (next && (next.title !== row.title || next.agent !== row.agent)) { row.title = next.title; row.agent = next.agent; changed = true; }
    }
    if (changed) renderTabs();
  }
  function closeTasks() {
    if (isWide()) return; // the sidebar stays
    // The Session list, the rename field and the popup of a row are drawn inside the sheet or point into it: they go with it.
    const menu = ui.get().menu;
    if (menu && (menu.naming || menu.rename || menu.anchor)) closeTerminalMenu();
    clearInterval(namesTimer);
    ui.set({ tasksOpen: false });
  }
  // Crossing the breakpoint (a window resized, a tablet rotated) turns the sheet into the sidebar or back into a sheet that is closed.
  function syncLayout() {
    ui.set({ wide: isWide() });
    if (isWide()) openTasks();
    else if (ui.get().tasksOpen) closeTasks();
    fitViewport();
    if (agentChat) fitAgentView();
    if (mindmap) fitMindmapView();
  }
  wideQuery.addEventListener('change', syncLayout);

  // The task name in the header (and Cmd/Ctrl+K): on a wide screen with the sidebar folded away, it brings the sidebar back first.
  ui.actions.openTasks = () => {
    if (isWide() && ui.get().sidebarCollapsed && ui.actions.toggleSidebar) ui.actions.toggleSidebar();
    openTasks();
  };
  ui.actions.expandAll = () => setAllExpanded(true);
  ui.actions.collapseAll = () => setAllExpanded(false);
  ui.actions.closeTasks = closeTasks;
  // Force refresh: forget what the browser kept for this site (Cache Storage) and load the page again from the network, so a phone that holds an old
  // copy of the scripts gets the new ones. The login, the settings and the open task are kept (they are in the cookie and localStorage).
  ui.actions.refresh = async () => {
    try {
      if (window.caches) for (const name of await caches.keys()) await caches.delete(name);
      if (navigator.serviceWorker) for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.update().catch(() => {});
    } catch { /* reload anyway */ }
    location.reload();
  };
  ui.actions.openSettings = () => ui.set({ settingsOpen: true }); // the settings themselves are the shell's (scripts/h5-shell/Settings.jsx)
  ui.actions.closeSettings = () => ui.set({ settingsOpen: false });
  ui.actions.toggleTask = ref => { const hit = resolveRef(ref); if (hit) toggleTask(hit.from, hit.item); };
  // A tap on a session row: on the selected task it goes to the terminal or chat; on another task it selects that task and shows the session.
  ui.actions.openRow = (ref, row) => {
    const hit = resolveRef(ref);
    if (!hit) return;
    const { from, item } = hit;
    if (isShown(from, item.id)) {
      if (row.kind === 'terminal') {
        closeTasks();
        leaveChat();
        // Tapping the current terminal reconnects one that was disconnected.
        if (row.id === terminalId && session && (session.ws || session.timer)) return;
        const entry = terminals.find(candidate => candidate.terminal_id === row.id);
        if (entry) switchTerminal(entry);
      }
      return;
    }
    if (row.kind === 'terminal') selectTask(from, item, { terminal: row.id });
    else selectTask(from, item);
  };
  // ── Next running or pending session (row 2, `#h5-cycle`) ──
  // Goes to the next terminal session of any service in the list, in task sheet order (services, groups, tasks, then the terminals of each task), that is running or pending acceptance,
  // wrapping around after the last one. Only terminal sessions count: plain shells ("Terminal") and Claude / Codex terminals ("Session"); agent chats do not.
  // Running: the server's terminal activity state is 'running', or the terminal is a live Claude session with a running sub-agent (`terminal-subagents`).
  // Pending acceptance: the activity state is 'done' (finished, not yet seen; showing the terminal clears it, see the terminal done acknowledgement below).
  // Both come from the pushed snapshot while the activity stream is live (see "Terminal activity push" below), else they are read fresh on the tap.
  // Every service in the list is walked, in list order; one that cannot be read adds nothing.
  let cycling = false;
  async function activeOf(from) {
    const f = feeds.get(from.key);
    const pushed = f && f.live && f.snapshot;
    const [activity, subagents] = pushed ? [pushed.activity, pushed.subagents] : await readActivity(from);
    const stateOf = (taskId, id) => {
      const state = ((activity || {})[taskId] || {})[id];
      if (state === 'running' || Number(((subagents || {})[taskId] || {})[id]) > 0) return 'running';
      return state === 'done' ? 'pending' : null;
    };
    const order = groupedTasks(from).flatMap(entry => entry.members)
      .filter(item => Object.keys((activity || {})[item.id] || {}).length || Object.keys((subagents || {})[item.id] || {}).length);
    // The terminal order of a task as the task sheet lists it: the open task's own list, else a fresh read of that task's terminals.
    const lists = await Promise.all(order.map(item => (isShown(from, item.id) && terminals.length
      ? terminals : api('GET', `${from.tasksBase}/${item.id}/terminals`).catch(() => []))));
    const out = [];
    order.forEach((item, index) => {
      for (const row of Array.isArray(lists[index]) ? lists[index] : []) {
        const state = stateOf(item.id, row.terminal_id);
        if (state) out.push({ from, taskId: item.id, terminalId: row.terminal_id, state });
      }
    });
    return out;
  }
  async function activeSessions() {
    const answers = await Promise.all(listedSources().filter(from => from.status !== 'offline').map(from => activeOf(from).then(list => ({ list }), error => ({ error }))));
    if (answers.length && answers.every(answer => answer.error)) throw answers[0].error;
    return answers.flatMap(answer => answer.list || []);
  }
  ui.actions.nextActiveSession = async () => {
    // Close the on-screen keyboard first (as the design document button does); the terminal is not resized.
    if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    if (cycling) return;
    cycling = true;
    const shown = task;
    try {
      const list = await activeSessions();
      if (task !== shown) return;
      if (!list.length) { tell('No running or pending sessions'); return; }
      const here = list.findIndex(entry => isShown(entry.from, entry.taskId) && entry.terminalId === terminalId && !agentChat);
      if (here >= 0 && list.length === 1) { tell('This is the only running or pending session'); return; }
      const next = list[(here + 1) % list.length]; // not in the list (here = -1): the first one
      ui.actions.openRow(taskRef(next.from, next.taskId), { kind: 'terminal', id: next.terminalId }); // the same path as a tap in the task sheet
    } catch (error) {
      tell(`Could not read the session states: ${error.message}`, 'error');
    } finally { cycling = false; }
  };
  // The "⋯" of a session row, of the task the row is under (`ref`), which may not be the selected one.
  ui.actions.rowMore = (ref, row, anchor) => {
    const hit = resolveRef(ref);
    if (!hit) return;
    const { from, item } = hit;
    if (isShown(from, item.id)) {
      const entry = terminals.find(candidate => candidate.terminal_id === row.id);
      if (entry) openTerminalMenu(entry, anchor);
      return;
    }
    const peek = peeks.get(taskRef(from, item.id));
    if (!peek) return;
    const entry = peek.terminals.find(candidate => candidate.terminal_id === row.id);
    if (entry) openOtherMenu(from, item, row, entry, anchor);
  };
  // Resolves to whether the task was made (the shell then empties its input).
  // workDir: an absolute path, or empty for the default rule (a folder named after the task under the tasks folder); the default is never sent.
  // on: the key of the service it is made on ("Create on" in the form); without one, this machine.
  ui.actions.createTask = async (title, workDir = '', on = null) => {
    const current = sources.find(item => item.key === on) || LOCAL;
    ui.set({ creatingTask: true });
    try {
      const created = await api('POST', current.tasksBase, workDir ? { title, work_dir: workDir } : { title });
      if (!sources.includes(current)) return true;
      await loadSource(current);
      selectTask(current, findTask(current, created.id) || created);
      return true;
    } catch (error) {
      tell(`Could not create the task: ${error.message}`, 'error');
      return false;
    } finally { ui.set({ creatingTask: false }); }
  };
  // The service a new task is made on, for the new-task form: its default folder rule is shown only for this machine (a remote one keeps its own).
  ui.actions.newTaskTarget = (key = 'local') => {
    const from = sources.find(item => item.key === key) || LOCAL;
    return { local: from.key === 'local', label: from.label };
  };

  // ── Task actions (the "⋯" of a task): move to another group, change the working directory, delete (optionally with the directory) ──
  // The task endpoints, through the task base of the engine, so local, Engine and proxied tasks work alike.
  // Every action below belongs to the row it was started from: the service of that row, whichever task is shown.
  const serviceOf = from => (from === LOCAL ? null : from.label); // the name a dialog or menu shows beside the title: tasks of two services can have the same title
  const dialogFor = (kind, from, item, extra = {}) => ({ kind, sourceKey: from.key, service: serviceOf(from), id: item.id, title: item.title, workDir: item.work_dir || '', error: '', busy: false, ...extra });
  const dialogSource = dialog => (dialog ? sources.find(item => item.key === dialog.sourceKey) : null);
  ui.actions.taskMore = ref => {
    const hit = resolveRef(ref);
    if (!hit) return;
    const { from, item } = hit;
    menuRow = null;
    menuTask = taskRef(from, item.id); // so that the task leaving the list closes this sheet too (`leaveTask`)
    void loadLinks(); // for the next time: the menu never waits for it
    const ordered = [...from.groups].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    showMenu(serviceOf(from) ? `${item.title} \u00B7 ${serviceOf(from)}` : item.title, [
      ...ordered.map(group => [`${item.status === group.key ? '\u2713 ' : ''}${tr('Move to')} \u201C${tr(group.name)}\u201D`, () => void moveTask(from, item, group.key), 'raw']),
      ['Edit working directory', () => { closeTerminalMenu(); ui.set({ taskDialog: dialogFor('workdir', from, item) }); }],
      ...(choosesVisibility(from) ? [['Visible to', () => void askVisibility(from, item)]] : []),
      ...(archives(from) ? [['Archive', () => void askArchive(from, item)]] : []),
      ['Delete', () => { closeTerminalMenu(); ui.set({ taskDialog: dialogFor('delete', from, item) }); }, 'danger'],
    ]);
  };
  async function moveTask(from, item, status) {
    closeTerminalMenu();
    if (item.status === status) return;
    try {
      await api('PUT', `${from.tasksBase}/${item.id}`, { status });
      await loadSource(from);
    } catch (error) { tell(`Could not update task: ${error.message}`, 'error'); }
  }
  const patchDialog = patch => ui.set(state => ({ taskDialog: state.taskDialog && { ...state.taskDialog, ...patch } }));
  ui.actions.taskDialogClose = () => { if (!(ui.get().taskDialog || {}).busy) ui.set({ taskDialog: null }); };
  const DELETE_ERRORS = { DIRECTORY_NOT_SAFE_TO_DELETE: 'This directory cannot be deleted (protected or shared with other tasks); the task was not deleted' };
  ui.actions.taskDelete = async deleteDirectory => {
    const dialog = ui.get().taskDialog;
    const from = dialogSource(dialog);
    const item = from && (findTask(from, dialog.id) || archivedByRef(taskRef(from, dialog.id))); // also from the Archived section
    if (!item || dialog.busy) return;
    patchDialog({ busy: true, error: '' });
    let result;
    try {
      result = await api('DELETE', `${from.tasksBase}/${item.id}${deleteDirectory ? '?delete_directory=1' : ''}`);
    } catch (error) {
      const data = error.data || {};
      const label = tr(DELETE_ERRORS[error.message] || error.message);
      patchDialog({ busy: false, error: data.reason ? `${label}: ${data.reason}` : label });
      return;
    }
    ui.set({ taskDialog: null });
    if (deleteDirectory && result && result.directory_error) tell(`${tr('Task deleted, but deleting the directory failed:')} ${result.directory_error}`, 'error');
    else if (deleteDirectory && result && result.directory_deleted === undefined) tell('Task deleted, but the remote service is older and did not delete the directory.', 'error');
    else tell('Task deleted', 'success');
    const ref = taskRef(from, item.id);
    expanded.delete(ref);
    peeks.delete(ref);
    if (isShown(from, item.id)) { hideAgent(); selectTask(LOCAL, null); }
    from.tasks = from.tasks.filter(entry => entry.id !== item.id);
    dropArchivedRow(ref);
    await loadSource(from);
  };
  // ── Archiving a task (`POST {tasksBase}/:id/archive`, `/restore`; `GET {tasksBase}?archived=1`), for this machine and an Engine with 'tasks:archive' ──
  // An archived task leaves the task list and has no terminals; the Archived section at the end of the list (ArchivedTasks.jsx) reads its rows when it is opened.
  // The rows of every service in the list that can archive, each with its service (`from`); one that cannot adds none. `busy`: the ref being restored.
  const archived = { open: false, status: 'idle', rows: null, busy: null, seq: 0 }; // status: 'idle', 'loading', 'ready', 'error'
  const archivedByRef = ref => (archived.rows || []).find(row => taskRef(row.from, row.id) === ref);
  // A source that does not implement archiving: its rows and the Archived entry and Archive item of that source go away for this page load.
  function noArchiving(from) {
    if (from.archiveMissing) return;
    from.archiveMissing = true;
    if (archived.rows) archived.rows = archived.rows.filter(row => row.from !== from);
    showArchived();
  }
  // The rows of an answer to `?archived=1` that are really archived. A server without archiving ignores the parameter and answers its whole list of tasks in use,
  // where Restore and Delete must never appear, so a row without `archived_at` is never used, and an answer with only such rows ends archiving for this source.
  function archivedRowsOf(from, answer) {
    const list = Array.isArray(answer) ? answer : [];
    const rows = list.filter(row => row && row.archived_at);
    if (list.length && !rows.length) noArchiving(from);
    return rows;
  }
  function showArchived() {
    ui.set({ archived: {
      supported: listedSources().some(archives), open: archived.open, status: archived.status, busy: archived.busy, count: archived.rows ? archived.rows.length : null,
      rows: (archived.rows || []).map(row => ({ ref: taskRef(row.from, row.id), id: row.id, title: row.title, archivedAt: row.archived_at || null, service: serviceOf(row.from) })),
    } });
  }
  async function loadArchived() {
    const seq = (archived.seq += 1);
    if (!archived.rows) { archived.status = 'loading'; showArchived(); } // rows already shown stay until the new ones are read
    const readable = listedSources().filter(from => archives(from) && from.status !== 'offline');
    const answers = await Promise.all(readable.map(from => api('GET', `${from.tasksBase}?archived=1`).then(answer => ({ from, answer }), () => ({ from, failed: true }))));
    const fresh = answers.flatMap(entry => (entry.failed ? [] : archivedRowsOf(entry.from, entry.answer).map(row => ({ ...row, from: entry.from })))); // `archivedRowsOf` before the check below: `noArchiving` takes this source's rows away
    if (seq !== archived.seq) return;
    if (answers.length && answers.every(entry => entry.failed) && !archived.rows) { archived.status = 'error'; showArchived(); return; }
    const failed = new Set(answers.filter(entry => entry.failed).map(entry => entry.from));
    archived.status = 'ready';
    archived.rows = [...(archived.rows || []).filter(row => failed.has(row.from)), ...fresh]; // a service that did not answer this time keeps its rows
    showArchived();
  }
  function dropArchivedRow(ref) {
    if (!archivedByRef(ref)) return;
    archived.seq += 1; // a read still on its way may have this row
    archived.status = 'ready';
    archived.rows = archived.rows.filter(row => taskRef(row.from, row.id) !== ref);
    showArchived();
  }
  const refreshArchived = () => { if (archived.rows) void loadArchived(); }; // never read yet: nothing to keep right until it is opened
  ui.actions.toggleArchived = () => {
    archived.open = !archived.open;
    showArchived();
    if (archived.open) void loadArchived();
  };
  // Back in the list, on no terminal: its rows stay and connect when opened, as after a service restart. The task that is shown stays shown.
  ui.actions.archivedRestore = async ref => {
    const row = archivedByRef(ref);
    if (!row || archived.busy) return;
    const { from } = row;
    archived.busy = ref;
    showArchived();
    try { await api('POST', `${from.tasksBase}/${row.id}/restore`); }
    catch (error) {
      archived.busy = null;
      showArchived();
      tell(`Could not restore the task: ${error.message}`, 'error');
      return;
    }
    archived.busy = null;
    dropArchivedRow(ref);
    showArchived();
    tell('Task restored', 'success');
    await loadSource(from);
  };
  ui.actions.archivedDelete = ref => {
    const row = archivedByRef(ref);
    if (row) ui.set({ taskDialog: dialogFor('delete', row.from, row) });
  };
  // Terminals running now (a running state or a running sub-agent), as the next-session button counts them.
  function runningIn(snapshot, taskId) {
    const states = (snapshot.activity || {})[taskId] || {};
    const subs = (snapshot.subagents || {})[taskId] || {};
    return [...new Set([...Object.keys(states), ...Object.keys(subs)])].filter(id => states[id] === 'running' || Number(subs[id]) > 0).length;
  }
  // The confirmation. What is running comes from the pushed snapshot, else from one read; until that answers Archive waits, so the warning is not missed.
  async function askArchive(from, item) {
    closeTerminalMenu();
    const f = feeds.get(from.key);
    const pushed = f && f.live && f.snapshot;
    ui.set({ taskDialog: dialogFor('archive', from, item, { workDir: '', running: pushed ? runningIn(pushed, item.id) : null, checking: !pushed }) });
    if (pushed) return;
    let running = null; // unknown: the general sentence only
    try { const [activity, subagents] = await readActivity(from); running = runningIn({ activity, subagents }, item.id); } catch { /* an offline Engine: Archive itself will say */ }
    const dialog = ui.get().taskDialog;
    if (dialog && dialog.kind === 'archive' && dialog.id === item.id && dialog.sourceKey === from.key) patchDialog({ running, checking: false });
  }
  ui.actions.taskArchive = async () => {
    const dialog = ui.get().taskDialog;
    if (!dialog || dialog.busy) return;
    const from = dialogSource(dialog);
    const item = from && findTask(from, dialog.id);
    if (!item) { ui.set({ taskDialog: null }); return; } // it left the list meanwhile
    patchDialog({ busy: true, error: '' });
    try { await api('POST', `${from.tasksBase}/${item.id}/archive`); }
    catch (error) {
      // No such route on this server (an HTML 404, unlike the JSON of a task that is gone), or the proxy says the Engine is too old: the task stays.
      const unsupported = (error.status === 404 && !(error.data && error.data.error)) || error.message === 'ARCHIVE_UNSUPPORTED';
      if (unsupported) noArchiving(from);
      patchDialog({ busy: false, error: tr(unsupported ? 'This server is too old to archive tasks. Restart or update it first' : error.message) });
      return;
    }
    ui.set({ taskDialog: null });
    tell('Task archived', 'success');
    leaveTask(from, item.id);
    await loadSource(from);
    refreshArchived();
  };
  // A task that left the list by being archived, here or on another device: its terminals and sockets close for good (none is kept warm, so nothing reconnects)
  // and, when it was the shown task, the page goes where deleting the shown task goes (`taskDelete`): no task selected.
  function leaveTask(from, taskId, { stay = false } = {}) {
    const ref = taskRef(from, taskId);
    if (menuTask === ref || (menuScope && menuScope.from === from && menuScope.taskId === taskId)) closeTerminalMenu();
    if (isShown(from, taskId)) disconnect();
    closeWarm(item => item.source === from && item.task.id === taskId);
    if (earlySocket && earlySocket.source === from && earlySocket.taskId === taskId) dropEarlySocket();
    store.set(`terminal:${from.key}:${taskId}`, null);
    expanded.delete(ref);
    peeks.delete(ref);
    if (isShown(from, taskId)) { hideAgent(); selectTask(LOCAL, null, null, { stay }); }
    from.tasks = from.tasks.filter(entry => entry.id !== taskId);
  }
  // A task that is no longer in its service's list: it goes the same quiet way, without a word and with the task sheet left as it is. Only the owner of a task can hide it
  // from this machine, so on this side it looks just like a deleted one (404, or a terminal closed with 1008).
  function taskGone(from, taskId) {
    const dialog = ui.get().taskDialog;
    if (dialog && !dialog.busy && dialog.sourceKey === from.key && String(dialog.id) === String(taskId)) ui.set({ taskDialog: null });
    leaveTask(from, taskId, { stay: true });
  }
  // Another device archived a task this page still has (`TASK_ARCHIVED` on a connect or a new terminal): say so once and read the list again.
  function archivedElsewhere(from, taskId) {
    const shown = isShown(from, taskId);
    leaveTask(from, taskId);
    if (shown) tell('This task was archived on another device');
    void loadSource(from);
    refreshArchived();
  }
  // The server ended the shown terminal's connection for good and gave no reason: when the task turns out to be archived, the same as above.
  async function checkArchived(s) {
    const from = s.source;
    const id = s.task.id;
    if (!archives(from)) return;
    const rows = await api('GET', `${from.tasksBase}?archived=1`).catch(() => null);
    if (!s.disposed && archivedRowsOf(from, rows).some(row => row.id === id)) archivedElsewhere(from, id);
  }
  // A connection of the shown terminal ended: is the task still there at all? A task that is gone must end here, or the page keeps retrying a terminal it can no longer open.
  // A read that fails says nothing (a lost connection also fails it), so this does not touch the state of the list.
  async function checkGone(s) {
    const from = s.source;
    const id = s.task.id;
    const list = await api('GET', from.tasksBase).catch(() => null);
    if (s.disposed || !Array.isArray(list) || list.some(row => row.id === id)) return;
    taskGone(from, id);
    renderTasks();
    showActiveCount();
  }
  // ── Which linked machines can see a task of this machine (`GET` and `PUT /api/tasks/:id/visibility`). Only the owner of a task decides, so never on another service's task ──
  let hasLinks = false; // this machine has a service link that is not over: from `GET /api/service-links` (at start, and each time the list or a task menu opens)
  let linksSeq = 0;
  let visibilityMissing = false; // this server's answer showed that it has no such route, which holds until the page is loaded again
  async function loadLinks() {
    const seq = (linksSeq += 1);
    let answer;
    try { answer = await api('GET', '/api/service-links'); }
    catch (error) { if (seq === linksSeq && error.status === 404) hasLinks = false; return; } // an older server; any other failure says nothing and what was known stays
    if (seq !== linksSeq) return;
    hasLinks = Boolean(answer && answer.supported === true && Array.isArray(answer.links) && answer.links.some(link => link.state !== 'revoked'));
  }
  const choosesVisibility = from => from === LOCAL && hasLinks && !visibilityMissing;
  const VISIBILITY_TOO_OLD = 'This server is too old to choose who can see a task. Restart or update it first';
  const VISIBILITY_ERRORS = { INVALID_VISIBILITY: 'The list of machines has changed. Close this and try again' };
  // No such route on this server (an HTML 404, unlike the JSON of a task that is gone): the item goes away.
  function visibilityError(error) {
    const code = error.data && error.data.error;
    if (error.status === 404 && !code) visibilityMissing = true;
    return tr(error.status === 404 && !code ? VISIBILITY_TOO_OLD : VISIBILITY_ERRORS[code] || error.message);
  }
  const visibilityDialog = () => { const dialog = ui.get().taskDialog; return dialog && dialog.kind === 'visibility' ? dialog : null; };
  let visibilitySeq = 0;
  async function askVisibility(from, item) {
    closeTerminalMenu();
    const seq = (visibilitySeq += 1);
    ui.set({ taskDialog: dialogFor('visibility', from, item, { workDir: '', status: 'loading', devices: [], seq }) });
    let patch;
    try {
      const answer = await api('GET', `${from.tasksBase}/${item.id}/visibility`);
      if (Array.isArray(answer && answer.devices)) patch = { status: 'ready', devices: answer.devices };
      else { visibilityMissing = true; patch = { status: 'error', error: tr(VISIBILITY_TOO_OLD) }; }
    } catch (error) { patch = { status: 'error', error: visibilityError(error) }; }
    const dialog = visibilityDialog();
    if (dialog && dialog.seq === seq) patchDialog(patch);
  }
  ui.actions.taskVisibilitySet = (linkId, allowed) => {
    const dialog = visibilityDialog();
    if (dialog && !dialog.busy) patchDialog({ error: '', devices: dialog.devices.map(device => (device.link_id === linkId ? { ...device, allowed } : device)) });
  };
  // Only the unchecked machines are sent: a machine linked later is allowed, as every machine is by default. None checked is valid: no other machine sees this task.
  ui.actions.taskVisibilitySave = async () => {
    const dialog = visibilityDialog();
    const from = dialogSource(dialog);
    if (!from || dialog.busy || dialog.status !== 'ready') return;
    patchDialog({ busy: true, error: '' });
    try { await api('PUT', `${from.tasksBase}/${dialog.id}/visibility`, { denied: dialog.devices.filter(device => !device.allowed).map(device => device.link_id) }); }
    catch (error) { patchDialog({ busy: false, error: visibilityError(error) }); return; }
    ui.set({ taskDialog: null });
    tell('Saved', 'success');
  };
  // An existing task's working directory: the form shows the saved one; an absolute path is required (the server keeps the old one for an empty value).
  ui.actions.taskWorkdirSave = async value => {
    const dialog = ui.get().taskDialog;
    const from = dialogSource(dialog);
    const item = from && findTask(from, dialog.id);
    if (!item || dialog.busy) return;
    const workDir = String(value || '').trim();
    if (!isAbsolutePath(workDir)) { patchDialog({ error: 'Enter an absolute path' }); return; }
    if (workDir === (item.work_dir || '')) { ui.set({ taskDialog: null }); return; }
    patchDialog({ busy: true, error: '' });
    try {
      await api('PUT', `${from.tasksBase}/${item.id}`, { work_dir: workDir });
    } catch (error) { patchDialog({ busy: false, error: tr(error.message) }); return; }
    ui.set({ taskDialog: null });
    await loadSource(from);
    if (isShown(from, item.id)) { const fresh = findTask(from, item.id); if (fresh) task = fresh; }
    syncFiles(); // a new working directory: a new tree
    peeks.delete(taskRef(from, item.id));
    // Existing terminals keep their directory; the list says which one each has now (a default terminal never started follows the task).
    if (isShown(from, item.id)) {
      const current = task;
      try {
        const rows = await api('GET', `${from.tasksBase}/${current.id}/terminals`);
        if (current === task && Array.isArray(rows)) {
          const fresh = new Map(rows.map(row => [row.terminal_id, row]));
          for (const row of terminals) { const next = fresh.get(row.terminal_id); if (next) row.work_dir = next.work_dir; }
          renderTabs();
        }
      } catch { /* the list is read again on the next visit */ }
    }
    tell('Saved', 'success');
  };
  // The same rule as the server (path.isAbsolute): a POSIX path, or a Windows drive path.
  function isAbsolutePath(value) { return /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value); }
  ui.actions.isAbsolutePath = isAbsolutePath;

  // The Engines settings (scripts/h5-shell/Engines.jsx) or the linked services connected, edited or removed a service: the combined list and the feeds follow. `changedKey`
  // is the service whose connection changed; when its task is the one shown, its terminals are opened again.
  ui.actions.enginesChanged = async (changedKey = null) => {
    await Promise.all([loadSources(), loadHidden(), loadLinks()]);
    const changed = sources.find(item => item.key === changedKey);
    if (changed && changed !== LOCAL) changed.capabilities = undefined; // read again (it may have been upgraded)
    if (changed && changed === source && task) {
      hideAgent();
      closeTerminalMenu();
      closeWarm(item => item.source === changed);
      terminalsLoaded = loadTerminals();
    }
    syncFeeds();
    renderTasks();
    await loadTasks();
  };

  // ── Which devices are in the list ("Show in task list", scripts/h5-shell/Engines.jsx) ──
  // Per service, so the phone and the computer agree. Hiding the device of the shown task leaves that terminal open until the person opens something else.
  function applyHidden(list) {
    const before = hiddenDevices;
    hiddenDevices = new Set(list);
    ui.set({ hiddenDevices: { supported: hiddenSupported, keys: [...hiddenDevices] } });
    if (archived.rows) archived.rows = archived.rows.filter(row => !hiddenDevices.has(row.from.key));
    publishSources();
    syncFeeds();
    showActiveCount();
    renderTasks();
    for (const from of sources) if (before.has(from.key) && !hiddenDevices.has(from.key)) void loadSource(from); // shown again: its list is read
    if (archived.open) void loadArchived();
  }
  async function loadHidden() {
    const seq = (hiddenSeq += 1);
    let answer = null;
    try { answer = await api('GET', HIDDEN_URL); }
    catch (error) {
      if (seq === hiddenSeq && error.status === 404 && hiddenSupported) { hiddenSupported = false; applyHidden([]); } // the server went back to an older version
      return;
    }
    if (seq !== hiddenSeq) return;
    hiddenSupported = Boolean(answer && Array.isArray(answer.hidden));
    const list = hiddenSupported ? answer.hidden : [];
    if (list.length !== hiddenDevices.size || list.some(key => !hiddenDevices.has(key)) || !ui.get().hiddenDevices.supported !== !hiddenSupported) applyHidden(list);
  }
  // Rejects with the server's error, which the settings row shows. A device that was removed drops out here.
  ui.actions.setDeviceVisible = async (key, visible) => {
    const next = new Set([...hiddenDevices].filter(item => sources.some(from => from.key === item)));
    if (visible) next.delete(key); else next.add(key);
    hiddenSeq += 1;
    const saved = await api('PUT', HIDDEN_URL, { hidden: [...next] });
    applyHidden(saved && Array.isArray(saved.hidden) ? saved.hidden : [...next]);
  };

  // ── Phone terminals ──
  function showEmpty(text, { create = false } = {}) { ui.set({ empty: text, emptyCreate: create }); }
  // The selected task has no terminal: nothing connects and nothing is spawned, and nothing of a terminal that is gone is kept (the one remembered for this task,
  // an early socket, hidden warm views). A terminal only comes from the person: the button of the empty state opens the same Session list as the "+" of the task.
  function showNoTerminal() {
    terminalId = null;
    wantedTerminal = null;
    const from = source;
    const taskId = task.id;
    store.set(`terminal:${from.key}:${taskId}`, null);
    dropEarlySocket();
    closeWarm(item => item.source === from && item.task.id === taskId);
    showEmpty('This task has no terminal yet', { create: true });
  }
  ui.actions.newSessionFromEmpty = () => {
    if (!task) return;
    ui.actions.openTasks(); // a phone's task sheet, or the folded sidebar of a computer
    const menu = ui.get().menu;
    if (!(menu && menu.naming && menuTask === taskRef(source, task.id))) ui.actions.addSession(taskRef(source, task.id)); // the "+" would close a list that is already open
  };

  // The list of the selected task could not be read: the next open of the list reads it again.
  function retryTerminals() { if (task && terminalsState === 'error') terminalsLoaded = loadTerminals(); }
  async function loadTerminals() {
    hideShown(); // another task: the terminal shown so far stays warm (WARM_MAX)
    terminals = [];
    terminalsState = 'loading';
    const seq = (terminalsSeq += 1);
    renderTabs();
    if (!task) { showEmpty('Choose a task to open its phone terminal'); return; }
    const current = task;
    const from = source;
    showEmpty('Loading…');
    await actionsDone(from, current.id); // a Restart or Delete started from its row before it was selected
    if (seq !== terminalsSeq) return;
    let rows;
    try { rows = await api('GET', `${from.tasksBase}/${current.id}/terminals`); }
    catch (error) {
      // A 404: the task may be gone from this service (deleted, or hidden from this machine). The list says, and when it is, `taskGone` has already moved the page on.
      if (error.status === 404) await recheckSource(from);
      if (seq === terminalsSeq) { terminalsState = 'error'; showEmpty(`Could not load terminals: ${error.message}`); renderTabs(); }
      return;
    }
    if (seq !== terminalsSeq) return;
    terminalsState = 'ready';
    terminals = Array.isArray(rows) ? rows : [];
    if (!terminals.length) { showNoTerminal(); renderTabs(); return; }
    const saved = store.get(`terminal:${from.key}:${current.id}`);
    const wanted = wantedTerminal; // a session that was tapped in the task sheet
    wantedTerminal = null;
    terminalId = [wanted, saved].find(id => id && terminals.some(row => row.terminal_id === id)) || terminals[0].terminal_id;
    if (earlySocket && earlySocket.terminalId !== terminalId) dropEarlySocket();
    if (wanted && terminalId === wanted) store.set(`terminal:${from.key}:${current.id}`, terminalId);
    renderTabs();
    connect();
  }

  // The terminals of the selected task are a second-level list under it in the task sheet (ownSessions); "⋯" opens the actions of one terminal.
  // Going to a terminal leaves the open chat, like the back arrow used to.
  function leaveChat() { if (agentChat) closeAgent(); }
  function switchTerminal(row) {
    leaveChat();
    terminalId = row.terminal_id;
    store.set(`terminal:${source.key}:${task.id}`, terminalId);
    renderTabs();
    connect();
  }

  // ── Terminal actions: rename, reopen, restart in the working directory, delete ──
  // One `menu` state serves the actions of a terminal, the actions of a chat and the "Session" choices of the "+" of a task. Its items are
  // { label, kind } in the state and their functions are kept here, in the order shown. The actions of a session row are a popup under its "⋯" (`menu.anchor`, TermMenu.jsx); the
  // actions of a task are a sheet from the bottom (TermMenu.jsx); the Session choices (`naming`, under the task `task`) and the rename field (`rename`, in place of that row) are drawn in the task list (TaskDrawer.jsx),
  // where the person tapped.
  let menuRuns = [];
  let menuRow = null;
  // { from, taskId, row, taskTitle }: the Engine and the task of that terminal, and the row. Rename, Restart and Delete go there, whichever task is selected
  // by then. `taskTitle` is only set for a task that is not selected, so its name can be shown in the confirmation.
  let menuScope = null;
  // The optional name typed in the "Session" sheet. It is kept while moving between its lists (Claude session, Back) and names what is created.
  let newName = '';
  let menuCreate = -1; // the item that Enter in the name field runs (New Terminal, New Claude session)
  let menuTask = null; // the ref (`taskRef`) of the task whose "+" opened the Session list

  function closeTerminalMenu() {
    menuRow = null;
    menuScope = null;
    menuRuns = [];
    menuCreate = -1;
    menuTask = null;
    newName = '';
    ui.set({ menu: null });
  }
  // The Session list and the rename field drawn under a task go when that task is collapsed (without an id: under any task). The sheet and the popup of actions are modal: nothing behind them can be tapped (a popup whose row has gone closes by itself, TermMenu.jsx).
  function closeListMenu(ref = null) {
    const menu = ui.get().menu;
    const owner = menu && (menu.naming ? menu.task : menu.rename ? menu.rename.task : null);
    if (owner != null && (ref === null || ref === owner)) closeTerminalMenu();
  }
  // The typed name, as the server will keep it (an empty name: the default "Terminal N" / "Claude N").
  const takeName = () => newName.replace(/\s+/g, ' ').trim();
  // items: [label, run, kind, create]; kind 'danger' is drawn as a warning, 'raw' is a name that is not translated; create: Enter in the name field runs it.
  // naming: the Session list, with the optional name field above it, drawn under the task `menuTask` in the task list.
  // anchor: the "⋯" of a session row: the actions are a popup under it instead of the sheet from the bottom.
  function showMenu(title, items, { naming = false, anchor = null } = {}) {
    menuRuns = items.map(item => item[1]);
    menuCreate = items.findIndex(item => item[3]);
    ui.set({ menu: { title, items: items.map(([label, , kind]) => ({ label, kind: kind || null })), rename: null, renameValue: '', naming, task: naming ? menuTask : null, name: newName, anchor } });
  }
  // The rename field takes the place of the row in the task list ({ kind, id, task } of the row, `task` being its ref: `default` is a terminal id in every task); the sheet of
  // actions goes away.
  const askRename = value => ui.set(state => ({
    menu: state.menu && { ...state.menu, rename: { kind: 'terminal', id: menuRow && menuRow.terminal_id, task: menuScope && taskRef(menuScope.from, menuScope.taskId) }, renameValue: value },
  }));
  function openTerminalMenu(row, anchor) {
    menuRow = row;
    const target = menuScope = { from: source, taskId: task.id, row };
    // "Copy text" is for the terminal that is open (the copy view reads its buffer); the long press on the terminal body is the other way in.
    const open = row.terminal_id === terminalId && !agentChat && session && !session.disposed;
    showMenu(row.title, [
      ...(open ? [['Copy text', () => { closeTerminalMenu(); closeTasks(); openCopy(); }]] : []),
      // Agent terminals too: a name given here is kept (title_custom) and wins over the Claude / Codex session title from then on.
      ['Rename', () => askRename(row.title)],
      ['Reopen', () => { closeTerminalMenu(); closeTasks(); switchTerminal(row); }],
      ['Restart in the working directory', () => void restartTerminal(target), 'danger'],
      ['Delete', () => void deleteTerminal(target), 'danger'],
    ], { anchor });
  }
  // A remote Engine that says what it can do and does not list 'terminal:control' cannot restart or delete a terminal; one that has not said is asked (it answers with an error).
  const controlsTerminals = from => from.key === 'local' || !Array.isArray(from.capabilities) || from.capabilities.includes('terminal:control');
  // The actions of a session of a task that is not selected. Open is the same as a tap on the row; Rename, Restart and Delete go to the row's own Engine and task
  // (`target`) and leave the task, the terminal and the socket that are shown alone.
  function openOtherMenu(from, item, row, entry, anchor) {
    menuRow = entry;
    const target = menuScope = { from, taskId: item.id, row: entry, taskTitle: item.title };
    showMenu(entry.title, [
      ['Rename', () => askRename(entry.title)],
      ['Open', () => { closeTerminalMenu(); ui.actions.openRow(taskRef(from, item.id), { kind: row.kind, id: row.id }); }],
      ...(controlsTerminals(from) ? [
        ['Restart in the working directory', () => void restartTerminal(target), 'danger'],
        ['Delete', () => void deleteTerminal(target), 'danger'],
      ] : []),
    ], { anchor });
  }
  // Shows a saved name: in the list of the selected task, or under a task that is not selected. That list is read again too, so that an older read still on
  // its way cannot bring the old name back, and a name the server cleaned up is shown as it was kept.
  async function showRenamed(scope, id, title) {
    if (isSelected(scope)) {
      const entry = terminals.find(candidate => candidate.terminal_id === id);
      if (entry) entry.title = title;
      renderTabs();
      return;
    }
    const ref = taskRef(scope.from, scope.taskId);
    const peek = peeks.get(ref);
    const entry = peek && peek.terminals.find(candidate => candidate.terminal_id === id);
    if (entry) entry.title = title;
    renderTasks();
    const item = findTask(scope.from, scope.taskId);
    if (item && expanded.has(ref)) void loadPeek(scope.from, item);
  }
  // Is the task of this target the selected one, now?
  const isSelected = target => isShown(target.from, target.taskId);
  // Under a confirmation: which session it is and, for a task that is not selected, which task (`default` is a terminal id in every older task).
  const whichSession = target => `\n${target.row.title}${target.taskTitle ? `\n${tr('Task')}: ${target.taskTitle}` : ''}`;
  // After a Restart or Delete under a task that is not selected. `removed` ('terminal'): the row goes at once. That list is read again; a read already on its way
  // was sent before this and could bring the row back, so it stops counting. When the task has become the selected one meanwhile, its own read is waiting for the action (`actionsDone`).
  function showPeekChange(target, removed = null) {
    const ref = taskRef(target.from, target.taskId);
    const peek = peeks.get(ref);
    if (peek) {
      if (removed === 'terminal') peek.terminals = peek.terminals.filter(entry => entry.terminal_id !== target.row.terminal_id);
      peek.seq = (peekSeq += 1);
    }
    renderTasks();
    const item = findTask(target.from, target.taskId);
    if (item && expanded.has(ref) && !isSelected(target)) void loadPeek(target.from, item);
  }
  // Ends every view of that terminal of that task in this page, then asks the server. The shown one is only ended when it is the target itself: another task's `default` is another terminal.
  async function controlTerminal(target, action) {
    const { row, from, taskId } = target;
    const wasCurrent = isSelected(target) && row.terminal_id === terminalId;
    if (wasCurrent) disconnect(); // end the view first, so the server closing the shell is not shown as a lost connection
    closeWarm(item => item.key === warmKey(from, taskId, row.terminal_id)); // a hidden warm view of it too
    if (earlySocket && earlySocket.source === from && earlySocket.taskId === taskId && earlySocket.terminalId === row.terminal_id) dropEarlySocket();
    try {
      await trackAction(target, api('POST', `${from.tasksBase}/${taskId}/terminal/control`, { action, terminal_id: row.terminal_id }));
    } catch (error) {
      if (wasCurrent && isSelected(target)) connect();
      throw error;
    }
    return wasCurrent;
  }
  async function restartTerminal(target) {
    if (!window.confirm(`${tr('This ends the terminal, clears its history and reopens it from the task working directory. Continue?')}${target.taskTitle ? whichSession(target) : ''}`)) return;
    closeTerminalMenu();
    const selected = isSelected(target);
    try {
      await controlTerminal(target, 'restart-workdir');
      if (selected && isSelected(target)) { closeTasks(); switchTerminal(target.row); }
      else showPeekChange(target); // no view is left: the next Open connects to the new shell
    } catch (error) { tell(`Could not restart the terminal: ${error.message}`, 'error'); }
  }
  async function deleteTerminal(target) {
    const { row } = target;
    if (!window.confirm(`${tr('Delete this terminal? It ends the programs in it and removes its history.')}${whichSession(target)}`)) return;
    closeTerminalMenu();
    try {
      const wasCurrent = await controlTerminal(target, 'delete');
      if (!isSelected(target)) { showPeekChange(target, 'terminal'); return; }
      terminals = terminals.filter(item => item.terminal_id !== row.terminal_id);
      if (wasCurrent && terminals.length) { switchTerminal(terminals[0]); closeTasks(); }
      else {
        if (wasCurrent) showNoTerminal();
        renderTabs();
      }
    } catch (error) { tell(`Could not delete the terminal: ${error.message}`, 'error'); }
  }
  ui.actions.menuRun = index => { const run = menuRuns[index]; if (run) run(); };
  ui.actions.menuCancel = closeTerminalMenu;
  ui.actions.menuName = value => { newName = String(value || ''); };
  ui.actions.menuNameSubmit = () => { const run = menuRuns[menuCreate]; if (run) run(); };
  ui.actions.menuRename = async value => {
    const row = menuRow;
    const scope = menuScope;
    const title = String(value || '').trim();
    if (!scope) return;
    const base = `${scope.from.tasksBase}/${scope.taskId}`;
    if (!row || !title) return;
    try {
      const renamed = await api('PATCH', `${base}/terminals/${encodeURIComponent(row.terminal_id)}`, { title });
      closeTerminalMenu();
      await showRenamed(scope, row.terminal_id, (renamed && renamed.title) || title);
    } catch (error) { tell(`Could not rename the terminal: ${error.message}`, 'error'); }
  };
  // The name of what is shown (the chat that is open, otherwise the current terminal) in small text under the task name.
  function renderSessionName() {
    let name = '';
    const current = terminalId ? terminals.find(entry => entry.terminal_id === terminalId) : null;
    const agent = (current && current.agent) || null; // the kind of the current terminal, as the task list shows it: picks the saved commands presets
    if (ui.get().terminalAgent !== agent) ui.set({ terminalAgent: agent });
    if (agentChat && agentFor) {
      name = agentFor.title || '';
    } else if (terminalId) {
      const row = terminals.find(entry => entry.terminal_id === terminalId);
      name = (row && row.title) || '';
    }
    if (ui.get().sessionName !== name) ui.set({ sessionName: name });
  }
  function renderTabs() { renderTasks(); renderSessionName(); }

  // ── Session: a plain terminal, or a Claude / Codex session of the task directory (new or resumed) ──
  const SESSION_KINDS = [['claude', 'Claude session'], ['codex', 'Codex session']];
  function showSessionMenu(title, items) { showMenu(tr(title), items, { naming: true }); }
  function openSessionMenu() {
    menuRow = null;
    showSessionMenu('Session', [
      ['New Terminal', () => { const title = takeName(); closeTerminalMenu(); closeTasks(); void createTerminal(title ? { title } : {}); }, null, true],
      ...SESSION_KINDS.map(([agent, label]) => [label, () => void openAgentSessions(agent, label)]),
    ]);
  }
  ui.actions.openSessionMenu = openSessionMenu;
  // The "+" of any task: a task that is not shown is selected first, then the menu adds a session to it.
  ui.actions.addSession = ref => {
    const hit = resolveRef(ref);
    if (!hit) return;
    const { from, item } = hit;
    const own = taskRef(from, item.id);
    const menu = ui.get().menu;
    if (menu && menu.naming && menuTask === own) { closeTerminalMenu(); return; } // the "+" again closes its list
    if (!isShown(from, item.id)) selectTask(from, item, null, { stay: true });
    else if (!expanded.has(own)) { expanded.add(own); renderTasks(); } // as for a task that is not selected: the list goes with an open task, so one tap on the task closes both
    menuTask = own;
    newName = ''; // a new "Session" list starts with an empty name
    openSessionMenu();
  };

  // ── Mind maps (public/js/mindmap.js): a full-window view over the terminal, independent of the tasks; the terminal stays connected underneath ──
  const mindmapView = $('h5-mindmap');
  let mindmap = null;
  // The same height rule as fitViewport: visualViewport.height is believed only while something that raises a keyboard is focused (iOS Home Screen apps report wrong small heights).
  function fitMindmapView() {
    const viewport = window.visualViewport;
    const offset = viewport ? viewport.offsetTop : 0;
    const visible = viewport ? offset + viewport.height : window.innerHeight;
    const typing = pointerMode() || keyboardOpen || raisesKeyboard(document.activeElement);
    const bottom = typing ? visible : Math.max(visible, window.innerHeight);
    mindmapView.style.top = `${offset}px`;
    mindmapView.style.height = `${Math.max(0, bottom - offset)}px`;
    mindmapView.toggleAttribute('data-keyboard', !pointerMode() && keyboardOpen);
  }
  function closeMindmaps() {
    if (!mindmap) return;
    mindmap.destroy();
    mindmap = null;
    mindmapView.hidden = true;
    mindmapView.style.height = mindmapView.style.top = '';
    window.visualViewport?.removeEventListener('resize', fitMindmapView);
    window.visualViewport?.removeEventListener('scroll', fitMindmapView);
    ui.set({ mindmapLayers: [] });
  }
  function openMindmaps() {
    if (mindmap) return;
    if (!isWide()) closeTasks();
    mindmapView.hidden = false;
    window.visualViewport?.addEventListener('resize', fitMindmapView);
    window.visualViewport?.addEventListener('scroll', fitMindmapView);
    mindmap = MindMap.mount(mindmapView, { onClose: closeMindmaps, notify: (message, kind) => tell(message, kind), onLayers: layers => ui.set({ mindmapLayers: layers }) });
    fitMindmapView();
  }
  ui.actions.openMindmaps = openMindmaps;

  // ── Agent chat: the same Claude / Codex sessions as a conversation view instead of a terminal. The task sheet neither lists nor creates chats; a notification link opens one (`openChatFromLink`). ──
  const agentView = $('h5-agent');
  const chatApi = { get: url => api('GET', url), post: (url, body) => api('POST', url, body), patch: (url, body) => api('PATCH', url, body), del: url => api('DELETE', url) };
  let agentChat = null;
  // The chat fills the screen below the page header (task name and settings), the same header the terminal has, and follows the
  // visual viewport so the on-screen keyboard never covers the composer.
  function fitAgentView() {
    const top = document.querySelector('.h5-header').getBoundingClientRect().bottom;
    const viewport = window.visualViewport;
    const visible = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    // The same rule as fitViewport: without a keyboard a small reading is not believed.
    const bottom = pointerMode() || keyboardOpen || raisesKeyboard(document.activeElement) ? visible : Math.max(visible, window.innerHeight);
    agentView.style.top = `${top}px`;
    agentView.style.height = `${Math.max(0, bottom - top)}px`;
  }
  // Which chat of which task is shown. It is not brought back by a refresh: the page opens on a terminal, whatever earlier versions saved (the open flag of the
  // conversation on the server, `h5-agent:...` in localStorage).
  let agentFor = null;
  // Takes the chat view away.
  function hideAgent() {
    if (agentChat) agentChat.destroy();
    agentChat = null;
    agentFor = null;
    agentView.hidden = true;
    agentView.style.height = agentView.style.top = '';
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', fitAgentView);
      window.visualViewport.removeEventListener('scroll', fitAgentView);
    }
  }
  function closeAgent() {
    hideAgent();
    ackShown(); // the terminal under the chat is shown again
    renderTabs();
  }
  function mountAgent(conversation, { draft = '' } = {}) {
    if (agentChat) agentChat.destroy();
    agentView.hidden = false;
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitAgentView);
      window.visualViewport.addEventListener('scroll', fitAgentView);
    }
    fitAgentView();
    agentChat = AgentChat.mount(agentView, { api: chatApi, base: `${source.tasksBase}/${task.id}/agent`, conversation, onClose: closeAgent, notify: message => tell(message, 'error'), draft,
      onOpenChat: (created, extra = {}) => mountAgent(created, { draft: extra.draft || '' }), // a fork or a new chat replaces the one shown
      onTitle: title => { // a rename or the first message gave the chat a new name
        if (!agentFor || agentFor.conversation !== conversation.id) return;
        agentFor.title = title;
        renderTabs();
      } });
    agentFor = { source: source.key, taskId: task.id, conversation: conversation.id, title: conversation.title };
    renderTabs();
  }
  async function openAgentSessions(agent, label) {
    const current = task;
    const from = source;
    showSessionMenu(label, [['Loading…', () => {}]]);
    const loading = ui.get().menu; // the answer belongs to this list only: not to one opened after this one was closed
    let rows = [];
    try { rows = await api('GET', `${from.tasksBase}/${current.id}/agent-sessions?agent=${agent}`); }
    catch (error) { if (current === task) tell(`Could not load sessions: ${error.message}`, 'error'); }
    if (current !== task || ui.get().menu !== loading) return;
    const start = sessionId => () => {
      const title = takeName();
      closeTerminalMenu();
      closeTasks();
      void createTerminal({ agent, session_id: sessionId, ...(title ? { title } : {}) });
    };
    showSessionMenu(label, [
      [`New ${label}`, start(undefined), null, true],
      ...(Array.isArray(rows) ? rows : []).map(row => [row.title, start(row.id), 'raw']),
      ['Back', openSessionMenu],
    ]);
  }

  async function createTerminal(options = {}) {
    if (!task) return;
    const current = task;
    const from = source;
    leaveChat();
    try {
      await terminalsLoaded; // a new one made while the list is on its way is not wiped by that list (a task with no terminal answers an empty one)
      if (current !== task) return;
      const row = await api('POST', `${from.tasksBase}/${current.id}/terminals`, options);
      if (!row || !row.terminal_id) throw new Error('The engine returned no terminal');
      if (current !== task) return;
      terminals.push(row);
      terminalId = row.terminal_id;
      store.set(`terminal:${from.key}:${current.id}`, terminalId);
      renderTabs();
      connect();
    } catch (error) {
      if (error.message === 'TASK_ARCHIVED') { archivedElsewhere(from, current.id); return; }
      tell(`Could not create the terminal: ${error.message}`, 'error');
    }
  }

  const connected = s => Boolean(s && s === session && !s.paused && s.ws && s.ws.readyState === WebSocket.OPEN);
  function send(s, data) {
    if (uploading || !connected(s)) return false;
    s.ws.send(data);
    s.follow = true; // input (typed, a key of the key bar or the on-screen keyboard, a paste) brings the cursor of a wide terminal back into view
    followCursor(s);
    return true;
  }
  // Typed input. While the saved screen is replayed it is kept (modifiers stay latched until the text is really sent).
  function typed(s, data) {
    if (uploading || s !== session || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
    if (s.paused) { if (!s.queued || s.queued.length < 4096) s.queued = (s.queued || '') + withModifiers(data); return; }
    send(s, withModifiers(data));
  }
  function flushQueued(s) {
    const data = s.queued;
    s.queued = '';
    if (data) send(s, data);
  }
  // A box with no usable height (the page collapsed for a moment) says nothing about the size the terminal should have: a fit would give it one or two rows and a
  // full-screen program would redraw for them. The size stays as it is; the box's ResizeObserver fits the terminal again when it has room.
  const usableBox = s => s.el.clientHeight >= TERMINAL_MIN_HEIGHT;
  function sendResize(s) {
    if (s !== session) return; // a hidden warm terminal leaves the PTY size alone
    if (!usableBox(s)) { s.sizeUnsent = true; return; }
    if (s.ws && s.ws.readyState === WebSocket.OPEN && s.term.cols && s.term.rows) {
      s.sizeUnsent = false;
      TerminalProtocol.send(s.ws, { type: 'resize', cols: s.term.cols, rows: s.term.rows });
    }
  }
  function refit(s) { // a hidden one has no size
    if (s.disposed || s !== session || !usableBox(s)) return;
    TerminalViewport.fit(s.term, s.fit, s.el, wideMin());
    layoutWide(s);
    if (s.sizeUnsent && !s.paused) sendResize(s); // refused while the box was collapsed, and the fit changed nothing that would send it
  }

  // ── Recent terminals stay connected (WARM_MAX, the shown one included) ──
  // Going back to one of them shows it at once: its xterm is kept, hidden, and its socket keeps receiving output, so nothing is reconnected or replayed.
  // Only the shown one is acked, sends input and sends its size (a hidden terminal must not resize the PTY of someone else's view); the least recently
  // shown one is closed when a new one opens. A hidden terminal that another device takes over is closed quietly (shown again, it connects normally and
  // asks to take over). After WARM_IDLE_MS on a hidden page all of them are closed; the shown one connects again when the page is shown.
  const WARM_MAX = 3;
  const WARM_IDLE_MS = 60000;
  let warm = []; // the connected sessions, most recently shown first (the shown one, `session`, is first)
  const warmKey = (from, taskId, id) => `${from.key}|${taskId}|${id}`;
  function hideShown() {
    const s = session;
    session = null;
    if (!s) return;
    s.el.hidden = true;
    s.term.blur();
    s.clipboard?.dismiss(); // a copy request of a terminal that is no longer shown goes away
    scheduleWheelSync();
  }
  function showWarm(s) {
    warm = [s, ...warm.filter(item => item !== s)];
    session = s;
    s.el.hidden = false;
    ui.set({ empty: null });
    holdTerminalSize();
    refit(s);
    scheduleWheelSync();
    sendResize(s); // the size may have changed (another view, the keyboard) while it was hidden
    if (!s.ws) { clearTimeout(s.timer); s.timer = null; open(s); }
    ackShown();
    focusTerminalSoon(s);
  }
  // Closes the warm sessions of one terminal (it is restarted or deleted), or all of them.
  function closeWarm(match = () => true) {
    for (const s of warm.filter(match)) disposeSession(s);
  }

  function connect() {
    hideShown();
    if (!task || !terminalId) return;
    const key = warmKey(source, task.id, terminalId);
    const kept = warm.find(item => item.key === key && !item.disposed);
    if (kept) { showWarm(kept); return; }
    ui.set({ empty: null });
    const el = document.createElement('div');
    el.className = 'h5-xterm';
    el.dataset.terminalId = terminalId;
    el.dataset.taskId = String(task.id);
    terminalHost.append(el);
    const term = new Terminal({
      allowProposedApi: true, // needed by the Unicode 11 addon
      cursorBlink: true,
      fontSize: terminalFontSize(), // 13px on a computer, 11px on a phone
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#121212' },
      scrollback: 5000,
      // Hyperlinks printed by programs with OSC 8 (the visible text may differ from the real address): only http(s) is opened, after
      // the real address is confirmed; any other scheme (javascript:, data:, file:) is ignored silently.
      linkHandler: {
        allowNonHttpProtocols: false,
        activate(event, uri) {
          if (!/^https?:\/\//i.test(uri)) return;
          if (window.confirm(`${tr('Open this link?')}\n\n${uri}`)) window.open(uri, '_blank', 'noopener,noreferrer');
        },
      },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; // same width rules as the server snapshot
    term.open(el);
    // Tapping the terminal must not open the on-screen keyboard (xterm focuses its helper textarea on every touch): the
    // textarea stays focusable for a hardware keyboard but asks for no on-screen keyboard, ever: the "Terminal keyboard" key shows the page's own keyboard instead.
    noScreenKeyboard(term);
    // workDir: the terminal's own directory (it keeps the one it was created in when the task's directory changes later); an older Engine sends none.
    const own = terminals.find(row => row.terminal_id === terminalId);
    const s = { term, fit, el, ws: null, timer: null, attempts: 0, paused: false, disposed: false, task, terminalId, source, key, workDir: (own && own.work_dir) || null };
    session = s;
    warm = [s, ...warm];
    while (warm.length > WARM_MAX) disposeSession(warm[warm.length - 1]);
    // Both input modes (terminal-clipboard.js), one rule: copy on select. A finished mouse selection, Cmd+C / Ctrl+Shift+C, the double / triple tap
    // below and a program's OSC 52 copy right after the user's own gesture on this terminal are written at once; a program's copy without one
    // shows the bar with a preview first (`state.clipboard`). Only the shown terminal may copy.
    if (typeof TerminalClipboard !== 'undefined') s.clipboard = TerminalClipboard.attach(term, el, { isActive: () => session === s && !s.disposed && !s.el.hidden });
    attachFileLinks(s);
    watchWheel(s); // the wheel strip's thumb follows this terminal's buffer while it is shown
    attachGestures(s); // a sideways pan moves the wide terminal; vertical scrolling is the wheel strip's and xterm's
    // A pasted image or file (long-press paste in the xterm textarea, a file copied in the file manager) is uploaded like a picked one;
    // plain text keeps xterm's own paste.
    el.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.items || [])].filter(entry => entry.kind === 'file');
      if (!files.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (files.length !== 1) { tell('Upload one file at a time', 'error'); return; }
      if (!uploading) void upload(s, files[0].getAsFile());
    }, true);
    term.onData(data => typed(s, data));
    TerminalIme.attach(term, data => typed(s, data)); // the Apple Chinese keyboard's spaces and punctuation, which xterm drops
    term.onResize(() => { if (!s.paused) sendResize(s); requestAnimationFrame(() => layoutWide(s)); }); // only the shown one (sendResize)
    term.onWriteParsed(() => { if (s.follow && session === s) followCursor(s); }); // the wide terminal keeps the cursor in view
    let cursorFrame = 0;
    term.onCursorMove(() => { // the cursor decides how far the terminal is shifted while the keyboard is open
      if (!keyboardOpen || cursorFrame) return;
      cursorFrame = requestAnimationFrame(() => { cursorFrame = 0; if (session === s && !s.disposed) holdTerminalSize(); });
    });
    s.observer = new ResizeObserver(() => { refit(s); if (session === s) scheduleWheelSync(); });
    s.observer.observe(el);
    holdTerminalSize();
    refit(s);
    open(s);
    ackShown();
    focusTerminalSoon(s);
  }
  // With a keyboard (a computer, or a tablet with a hardware keyboard) the terminal that was just shown takes the focus, so typing goes there at once;
  // not when the person is typing somewhere else or a dialog is open. On a touch screen without a keyboard nothing is focused (no on-screen keyboard).
  // A pane of the multi-column view waits until the person used it (pane.mjs `engaged`): every column would take the focus as it loads.
  function focusTerminalSoon(s) {
    if (!deskKeys() || (PANE && !PANE.engaged())) return;
    setTimeout(() => {
      if (session !== s || s.disposed || agentChat || modalOpen() || editing(document.activeElement)) return;
      s.term.focus();
    }, 0);
  }
  // The wheel strip: a scrollbar on the right edge of the terminal (drawn by the shell, scripts/h5-shell/Terminal.jsx; touch mode only).
  // Its mode (`data-mode`) follows the shown terminal's buffer:
  // - 'bar' (normal buffer with history): a thumb whose size is rows / (rows + scrollback in use) and whose position is viewportY / baseY.
  //   Dragging the thumb moves the view like a scrollbar (down = newer, up = older), mapped 1:1 to the buffer; a tap on the track above or
  //   below the thumb scrolls one page. The thumb also follows scrolling done elsewhere (new output, a native drag on the body, keys).
  // - 'spring' (alternate buffer: Claude Code, Codex, vim, tmux ...; the page cannot know the program's position): the thumb rests in the
  //   middle; pulling it down scrolls down (newer), up scrolls up (older), faster the further it is pulled; released, it springs back. The
  //   steps are wheel events, which xterm forwards the way a desktop wheel would (mouse reports, or arrow keys without mouse mode).
  // - 'none' (no terminal, or a normal buffer without history): nothing is drawn and touches go through to the terminal.
  // A drag on the terminal body does not make wheel events; xterm's own touch handling scrolls the normal-buffer history there (touch-action: pan-y).
  // Tuning. Change these to tune the feel.
  const WHEEL_THUMB_MIN = 32; // px, the smallest bar thumb
  const WHEEL_THUMB_SLOP = 8; // px around the bar thumb that still grab it
  const WHEEL_FADE_MS = 700; // how long the strip stays bright after the finger is lifted
  const WHEEL_MAX_EVENTS = 200; // wheel events sent per step in the alternate buffer (one per line)
  const WHEEL_SPRING_DEAD = 6; // px of pull around the middle that do not scroll yet
  const WHEEL_SPRING_RATE = 8; // lines per second for each terminal row of pull beyond the dead zone
  const WHEEL_SPRING_MAX = 200; // lines per second at most
  const WHEEL_SPRING_REACH = 0.42; // the spring thumb moves at most this share of the strip height from the middle
  const WHEEL_TAP_SLOP = 8; // px of travel still counted as a tap
  const WHEEL_TAP_MS = 400; // a tap is shorter than this
  const WHEEL_STALE_MS = 3000; // a finger with no pointer event for this long dims the strip and stops the spring (a lost pointerup must not keep it)
  const wheelStrip = () => document.getElementById('h5-wheel');
  function lineHeight(s) {
    const screen = s.el.querySelector('.xterm-screen');
    return screen && s.term.rows ? Math.max(8, screen.clientHeight / s.term.rows) : 16;
  }
  function wheel(s, lines, x, y) {
    const target = s.el.querySelector('.xterm-screen') || s.el;
    for (let i = 0; i < Math.min(Math.abs(lines), WHEEL_MAX_EVENTS); i++) {
      target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 1, deltaY: Math.sign(lines), clientX: x, clientY: y }));
    }
  }
  // One spring step. The buffer type is read here, at the moment of sending, so a program that leaves the alternate screen during a pull is followed.
  function scrollStep(s, lines, x, y) {
    if (s.term.buffer.active.type === 'alternate') wheel(s, lines, x, y);
    else s.term.scrollLines(lines);
  }
  function wheelMode(s) {
    if (!s || s.disposed || s.el.hidden) return 'none';
    const buf = s.term.buffer.active;
    if (buf.type === 'alternate') return 'spring';
    return buf.baseY > 0 ? 'bar' : 'none';
  }
  // The bar geometry in px of the strip: thumb size, the room it moves in, its top, and the buffer numbers behind them.
  function wheelBar(s, el) {
    const buf = s.term.buffer.active;
    const height = el.clientHeight;
    const rows = s.term.rows || 1;
    const base = buf.baseY;
    const thumb = Math.min(height, Math.max(WHEEL_THUMB_MIN, Math.round(height * rows / (rows + base))));
    const room = Math.max(height - thumb, 0);
    const top = base && room ? Math.round(room * Math.min(buf.viewportY, base) / base) : room;
    return { height, thumb, room, top, base, line: buf.viewportY };
  }
  let wheelFrame = 0;
  // Draws the strip for the shown terminal. Cheap: it only sets a data attribute, two CSS variables and the ARIA values.
  function syncWheel() {
    if (wheelFrame) cancelAnimationFrame(wheelFrame);
    wheelFrame = 0;
    const el = wheelStrip();
    if (!el) return;
    const s = session;
    const mode = wheelMode(s);
    if (el.dataset.mode !== mode) el.dataset.mode = mode;
    if (mode === 'none') {
      el.setAttribute('aria-hidden', 'true');
      for (const name of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow']) el.removeAttribute(name);
      return;
    }
    el.removeAttribute('aria-hidden');
    if (mode === 'bar') {
      const bar = wheelBar(s, el);
      el.style.setProperty('--h5-thumb-top', `${bar.top}px`);
      el.style.setProperty('--h5-thumb-size', `${bar.thumb}px`);
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', String(bar.base));
      el.setAttribute('aria-valuenow', String(Math.min(bar.line, bar.base)));
    } else {
      // The program's position is unknown: the spring rests in the middle of a 0-100 range.
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', '100');
      el.setAttribute('aria-valuenow', '50');
    }
  }
  const scheduleWheelSync = () => { if (!wheelFrame) wheelFrame = requestAnimationFrame(syncWheel); };
  // Keeps the strip in step with one terminal: scrolls of any kind, new lines, a switch of buffer, a new size. The native scroll of the
  // xterm viewport (a drag on the body) does not fire onScroll in xterm 5.5, so its DOM scroll event is listened to as well.
  function watchWheel(s) {
    const sync = () => { if (session === s) scheduleWheelSync(); };
    s.term.onScroll(sync);
    s.term.onLineFeed(sync);
    s.term.onResize(sync);
    s.term.buffer.onBufferChange(sync);
    s.el.querySelector('.xterm-viewport')?.addEventListener('scroll', sync, { passive: true });
    sync();
  }
  function bindWheelStrip() {
    // The browser does not always end a touch: an Android system gesture (edge back swipe, notification shade, app switch),
    // a hidden page, a dialog over the strip, a re-mounted strip or a second finger can swallow the pointerup / pointercancel.
    // So a drag also ends on lostpointercapture, a hidden page, pagehide, window blur, a switched or closed terminal and a
    // detached strip; a new touch always takes over from an old drag; and the strip is dimmed (and the spring stopped) when no
    // pointer event came for WHEEL_STALE_MS (the next move of the same finger brings it back). Every element that got 'active' loses it.
    let drag = null;
    let fade = 0;
    let watch = 0; // interval that checks the running drag (only while a finger is down)
    let spring = 0; // requestAnimationFrame id of the running spring scroll
    const shown = new Set(); // strip elements with the 'active' class
    const strip = event => event.target.closest && event.target.closest('#h5-wheel');
    const show = el => { el.classList.add('active'); shown.add(el); };
    const hideAll = () => { for (const el of shown) el.classList.remove('active'); shown.clear(); };
    const hideLater = () => { clearTimeout(fade); fade = setTimeout(() => { if (!drag) hideAll(); }, WHEEL_FADE_MS); };
    const stopSpring = () => { if (spring) cancelAnimationFrame(spring); spring = 0; };
    // The spring thumb back in the middle (the CSS transition makes it spring).
    const release = el => { el.removeAttribute('data-pulling'); el.style.setProperty('--h5-spring-offset', '0px'); };
    // Ends the drag without a tap.
    const drop = () => {
      if (!drag) return;
      const { el } = drag;
      drag = null;
      clearInterval(watch);
      stopSpring();
      release(el);
      hideLater();
    };
    const check = () => {
      if (!drag) { clearInterval(watch); return; }
      if (drag.s !== session || drag.s.disposed || !drag.el.isConnected) { drop(); return; }
      if (performance.now() - drag.seen > WHEEL_STALE_MS) { hideAll(); drag.stale = true; stopSpring(); release(drag.el); return; }
      tick(); // the spring keeps its speed when frames are throttled
    };
    // The spring scrolls by time: lines per second grow with the pull. Called every frame and on every move (frames may be slow).
    const tick = () => {
      if (!drag || drag.mode !== 'spring' || drag.stale) return;
      const now = performance.now();
      const dt = Math.min(now - drag.tick, 1000); // by real time: slow frames (a loaded machine, a sleeping display) do not slow the scroll
      drag.tick = now;
      const pull = Math.abs(drag.offset) - WHEEL_SPRING_DEAD;
      if (pull <= 0) { drag.rest = 0; return; }
      const speed = Math.min(WHEEL_SPRING_MAX, WHEEL_SPRING_RATE * pull / lineHeight(drag.s)); // lines per second
      drag.rest += Math.sign(drag.offset) * speed * dt / 1000; // pulled down: positive, newer output
      const lines = Math.trunc(drag.rest);
      if (!lines) return;
      drag.rest -= lines;
      const rect = drag.el.getBoundingClientRect();
      scrollStep(drag.s, lines, rect.left + rect.width / 2, rect.top + rect.height / 2);
    };
    const frame = () => {
      spring = 0;
      if (!drag || drag.mode !== 'spring' || drag.stale) return;
      if (drag.s !== session || drag.s.disposed || !drag.el.isConnected) { drop(); return; }
      tick();
      spring = requestAnimationFrame(frame);
    };
    const startSpring = (y) => {
      drag.mode = 'spring';
      drag.from = y;
      drag.offset = 0;
      drag.rest = 0;
      drag.tick = performance.now();
      drag.el.setAttribute('data-pulling', '');
    };
    // Moves the bar thumb so that its grab point is under the finger, and scrolls the buffer to the matching line.
    const barTo = (y) => {
      const { s, el } = drag;
      const rect = el.getBoundingClientRect();
      const bar = wheelBar(s, el);
      if (!bar.base) return;
      const top = Math.max(0, Math.min(bar.room, y - rect.top - drag.grab));
      const line = bar.room ? Math.round(top / bar.room * bar.base) : bar.base;
      if (line !== s.term.buffer.active.viewportY) s.term.scrollToLine(line);
      syncWheel();
    };
    // A tap that is not for the strip is handed to whatever is under it, for example a link.
    const passTap = (event, el) => {
      const old = el.style.pointerEvents;
      el.style.pointerEvents = 'none';
      const under = document.elementFromPoint(event.clientX, event.clientY);
      el.style.pointerEvents = old;
      if (!under) return;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        under.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: event.clientX, clientY: event.clientY }));
      }
    };
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (event.type === 'pointerup' && drag.s === session && drag.el.isConnected) tick(); // the time held since the last frame counts
      const { el, moved, started, s, mode, onThumb, y } = drag;
      drop();
      if (event.type !== 'pointerup' || s !== session || s.disposed || !el.isConnected) return;
      if (moved >= WHEEL_TAP_SLOP || performance.now() - started >= WHEEL_TAP_MS) return;
      // A tap: on the bar's track it scrolls one page toward the tap; on the thumb or on the spring it goes through.
      if (mode === 'bar' && !onThumb && wheelMode(s) === 'bar') {
        const bar = wheelBar(s, el);
        s.term.scrollPages(y - el.getBoundingClientRect().top < bar.top ? -1 : 1);
        syncWheel();
      } else passTap(event, el);
    };
    document.addEventListener('pointerdown', event => {
      const el = strip(event);
      const s = session;
      if (!el || !s || s.disposed || (event.pointerType === 'mouse' && event.button !== 0)) return;
      drop(); // a drag still open here lost its end (or this is a second finger): the new touch takes over
      syncWheel();
      const mode = wheelMode(s);
      if (mode === 'none') return;
      const now = performance.now();
      drag = { id: event.pointerId, el, s, mode, y: event.clientY, moved: 0, started: now, seen: now, stale: false, onThumb: false, grab: 0, dragging: false };
      if (mode === 'bar') {
        const bar = wheelBar(s, el);
        const at = event.clientY - el.getBoundingClientRect().top;
        drag.onThumb = at >= bar.top - WHEEL_THUMB_SLOP && at <= bar.top + bar.thumb + WHEEL_THUMB_SLOP;
        drag.grab = drag.onThumb ? Math.max(0, Math.min(bar.thumb, at - bar.top)) : bar.thumb / 2;
        drag.dragging = drag.onThumb; // a touch beside the thumb drags only once it travels (a tap pages)
      } else startSpring(event.clientY);
      clearTimeout(fade);
      show(el);
      watch = setInterval(check, 250);
      try { el.setPointerCapture(event.pointerId); } catch { /* the pointer is gone already */ }
      event.preventDefault();
    });
    document.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const s = session;
      if (drag.s !== s || !s || s.disposed || !drag.el.isConnected) { drop(); return; }
      event.preventDefault();
      drag.seen = performance.now();
      if (drag.stale) { drag.stale = false; if (drag.mode === 'spring') { drag.tick = drag.seen; drag.el.setAttribute('data-pulling', ''); } }
      if (!shown.has(drag.el)) show(drag.el); // dimmed by the stale check while the finger was still
      drag.moved += Math.abs(event.clientY - drag.y);
      drag.y = event.clientY;
      // The buffer type is read on every move: a program that switches screens during the drag switches the drag with it.
      const mode = wheelMode(s);
      if (mode === 'spring' && drag.mode !== 'spring') startSpring(event.clientY);
      else if (mode === 'bar' && drag.mode !== 'bar') { stopSpring(); release(drag.el); drag.mode = 'bar'; drag.dragging = true; drag.grab = wheelBar(s, drag.el).thumb / 2; }
      if (drag.mode === 'bar') {
        if (!drag.dragging && drag.moved >= WHEEL_TAP_SLOP) drag.dragging = true;
        if (drag.dragging && mode === 'bar') barTo(event.clientY);
        return;
      }
      tick(); // the time pulled so far, at the old offset
      const reach = drag.el.clientHeight * WHEEL_SPRING_REACH;
      drag.offset = Math.max(-reach, Math.min(reach, event.clientY - drag.from));
      drag.el.style.setProperty('--h5-spring-offset', `${Math.round(drag.offset)}px`);
      if (!spring) spring = requestAnimationFrame(frame);
    });
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    // Capture lost without a pointerup first (the strip was removed, or the browser took the pointer): the drag is over.
    document.addEventListener('lostpointercapture', finish, true);
    const away = () => { drop(); hideLater(); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) away(); });
    window.addEventListener('pagehide', away);
    window.addEventListener('blur', event => { if (event.target === window) drop(); });
    // The strip is drawn by React and can be re-mounted (input mode, layout): every store change draws it again (once per frame at most).
    ui.subscribe(scheduleWheelSync);
    window.addEventListener('resize', scheduleWheelSync);
    // Test hooks: whether the spring is scrolling, and a synchronous redraw.
    window.__h5WheelSpring = () => Boolean(spring);
    window.__h5WheelSync = syncWheel;
  }
  bindWheelStrip();

  // ── Sideways: the wide terminal (public/js/terminal-gestures.js; "Terminal width" in DESIGN.md) ──
  // Terminal width, one setting for this device (localStorage): 'fit' gives the PTY the columns that fit the screen; 'wide' gives it `cols`
  // (120 / 160 / 200, never fewer than fit), so programs that wrap their own output (Claude Code, Codex) keep whole sentences, and the screen,
  // wider than the view, moves sideways. Only the shown terminal sizes its PTY (sendResize), and the server lets one client own a terminal.
  const widthPref = { mode: store.get('terminal-width') === 'wide' ? 'wide' : 'fit', cols: TerminalGestures.wideCols(store.get('terminal-wide-cols')) };
  const wideMin = () => (widthPref.mode === 'wide' ? widthPref.cols : 0);
  const screenOf = s => s.el.querySelector('.xterm-screen');
  function wideGeometry(s) {
    const screen = screenOf(s);
    return { content: screen ? screen.offsetWidth : 0, visible: s.el.clientWidth };
  }
  const maxOffsetOf = s => { const { content, visible } = wideGeometry(s); return TerminalGestures.maxOffset(content, visible); };
  // The sideways offset is a transform on .xterm-screen: xterm reads its mouse, selection and link positions from that element's bounding box,
  // which includes the transform, and the viewport (xterm's own vertical scroller) keeps the visible width.
  function setOffset(s, px) {
    const { content, visible } = wideGeometry(s);
    s.offset = TerminalGestures.clampOffset(px, content, visible);
    const screen = screenOf(s);
    if (screen) screen.style.transform = s.offset ? `translateX(${-s.offset}px)` : '';
  }
  function layoutWide(s) {
    if (s.disposed) return;
    s.el.classList.toggle('h5-wide', maxOffsetOf(s) > 0);
    setOffset(s, s.offset || 0);
    if (s === session) publishWidth();
  }
  function publishWidth() {
    const current = session && !session.disposed ? session.term.cols : 0;
    const now = ui.get().terminalWidth;
    if (now && now.mode === widthPref.mode && now.cols === widthPref.cols && now.current === current) return;
    ui.set({ terminalWidth: { mode: widthPref.mode, cols: widthPref.cols, current } });
  }
  function cursorBox(s) {
    const { content } = wideGeometry(s);
    const cell = s.term.cols ? content / s.term.cols : 0;
    const x = s.term.buffer.active.cursorX;
    return { left: x * cell, right: (x + 1) * cell, cell };
  }
  function cursorInView(s) {
    if (!maxOffsetOf(s)) return true;
    const box = cursorBox(s);
    return TerminalGestures.inView(s.offset || 0, box.left, box.right, wideGeometry(s).visible);
  }
  // Keeps the cursor (where the user types) in view after input and output, while the user has not panned it away (`s.follow`; input sets it again).
  function followCursor(s) {
    // The class first: in Fit mode nothing is measured (this runs on every chunk of output).
    if (s.disposed || s !== session || !s.follow || !s.el.classList.contains('h5-wide') || (s.gestures && s.gestures.panning()) || !maxOffsetOf(s)) return;
    const { content, visible } = wideGeometry(s);
    const box = cursorBox(s);
    setOffset(s, TerminalGestures.followOffset({ offset: s.offset || 0, left: box.left, right: box.right, visible, content, margin: box.cell * TerminalGestures.FOLLOW_MARGIN }));
  }
  function setTerminalWidth({ mode = widthPref.mode, cols = widthPref.cols } = {}) {
    const next = { mode: mode === 'wide' ? 'wide' : 'fit', cols: TerminalGestures.wideCols(cols) };
    if (next.mode === widthPref.mode && next.cols === widthPref.cols) return;
    Object.assign(widthPref, next);
    store.set('terminal-width', next.mode);
    store.set('terminal-wide-cols', next.cols);
    if (!store.get('terminal-width-noted')) {
      store.set('terminal-width-noted', '1');
      tell('The new width applies to new output. Text that is already wrapped stays as it is; full-screen programs redraw.');
    }
    publishWidth();
    const s = session; // a hidden warm terminal refits when it is shown again (showWarm)
    if (s && !s.disposed) { s.follow = true; refit(s); followCursor(s); }
  }
  ui.actions.setTerminalWidth = setTerminalWidth;
  ui.actions.toggleTerminalWidth = () => setTerminalWidth({ mode: widthPref.mode === 'wide' ? 'fit' : 'wide' });
  // The sideways position indicator: a thin bar at the bottom of the wide terminal, shown only while the user pans it. It is never a control.
  let indicator = null;
  function showScroll(s) {
    if (s !== session || s.disposed) return;
    const { content, visible } = wideGeometry(s);
    const max = TerminalGestures.maxOffset(content, visible);
    if (!max) return;
    if (!indicator || !indicator.isConnected) {
      indicator = document.createElement('div');
      indicator.className = 'h5-scroll-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      terminalHost.append(indicator);
    }
    const size = Math.max(24, Math.round(visible * visible / content));
    indicator.style.setProperty('--h5-ind-size', `${size}px`);
    indicator.style.setProperty('--h5-ind-pos', `${Math.round((visible - size) * (s.offset || 0) / max)}px`);
    indicator.classList.add('shown');
    clearTimeout(indicator.hideTimer);
    indicator.hideTimer = setTimeout(() => indicator.classList.remove('shown'), 700);
  }
  function attachGestures(s) {
    s.offset = 0;
    s.follow = true;
    if (typeof TerminalGestures === 'undefined') return;
    s.gestures = TerminalGestures.attach(s.el, {
      // Not while the copy view is open or right after the long press that opened it (the finger is still down).
      active: () => session === s && !s.disposed && !longPressDone && ui.get().copyText === null,
      offset: { get: () => s.offset || 0, set: px => setOffset(s, px), max: () => maxOffsetOf(s) },
      onScroll: () => showScroll(s),
      onHorizontalEnd: () => { s.follow = cursorInView(s); },
    });
  }

  function open(s, takeover = false) {
    const taken = takeover ? (dropEarlySocket(), null) : takeEarlySocket(s);
    const ws = taken ? taken.ws : new WebSocket(socketUrl(s.source, s.task.id, s.terminalId, takeover));
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    if (s.heartbeat) s.heartbeat.stop();
    // A half-open connection never fires onclose (phone slept): close it ourselves and go through the normal reconnect.
    const heartbeat = s.heartbeat = TerminalProtocol.heartbeat(ws, () => {
      try { ws.close(); } catch { /* already closed */ }
      closed({ code: 1006 });
    });
    ws.onopen = () => {
      if (s.ws !== ws || s.disposed) return;
      s.attempts = 0;
      refit(s);
      sendResize(s);
    };
    ws.onmessage = event => {
      if (s.ws !== ws || s.disposed) return;
      heartbeat.touch();
      const message = TerminalProtocol.parse(ws, event.data); // null: terminal output, never a control message
      if (message) {
        if (message.type === 'history') replay(s, ws, message);
        return; // history-page, pong
      }
      s.term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
    };
    function closed(event) {
      heartbeat.stop();
      if (s.ws !== ws || s.disposed) return;
      s.ws = null;
      if (/task[_ ]archived/i.test(event.reason || '')) { archivedElsewhere(s.source, s.task.id); return; } // never reconnects
      if (TerminalOwner.isBlocked(event.code)) {
        if (session !== s) { disposeSession(s); return; } // a hidden warm terminal taken over elsewhere: shown again, it asks then
        TerminalOwner.prompt(s.el.parentElement || s.el, event.code, () => { if (session === s && !s.disposed) open(s, true); });
        return;
      }
      if (event.code === 1000 || event.code === 1008) {
        s.term.write(tr('\r\n[Terminal disconnected. Tap the terminal tab to reconnect]\r\n'));
        if (s === session) void checkArchived(s).then(() => { if (!s.disposed) return checkGone(s); });
        return;
      }
      if (s === session) void checkGone(s); // a task that is gone can also be refused before a socket opens, which reads as a lost connection
      const delay = Math.min(1000 * (2 ** s.attempts), 30000);
      s.attempts += 1;
      s.term.write(tr(`\r\n\x1b[33m[Connection lost, reconnecting in ${Math.ceil(delay / 1000)}s...]\x1b[0m\r\n`));
      s.timer = setTimeout(() => { s.timer = null; if (session === s && !s.disposed) open(s); }, delay);
    }
    ws.onclose = closed;
    ws.onerror = () => {};
    // The early socket: what it got before this terminal existed is handled now, in order.
    if (taken) for (const [handler, event] of taken.events) { if (s.ws !== ws || s.disposed) break; ws[handler](event); }
  }

  // The server sends the saved screen first; input is held back until it has been drawn.
  function replay(s, ws, message) {
    s.paused = true;
    s.queued = '';
    s.term.reset();
    if (s.fileLinks) s.fileLinks.resetCwd(); // the shell may be a new one; it reports again at its next prompt, the server knows meanwhile
    if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 1000 && message.rows >= 1 && message.rows <= 1000) {
      s.term.resize(message.cols, message.rows);
    }
    const history = typeof message.data === 'string' ? message.data : '';
    const write = s.clipboard ? (data, done) => s.clipboard.writeHistory(data, done) : (data, done) => s.term.write(data, done); // a replayed OSC 52 never asks again
    write(history, () => {
      if (s.ws !== ws || s.disposed) return;
      refit(s);
      s.term.scrollToBottom();
      sendResize(s);
      // Animation frames do not run in a hidden tab, so a timer clears the flag there (and as a fallback when frames stall).
      const unpause = () => { if (s.ws === ws && s.paused) { s.paused = false; flushQueued(s); } };
      if (document.visibilityState === 'hidden') unpause();
      else { requestAnimationFrame(() => requestAnimationFrame(unpause)); setTimeout(unpause, 300); }
    });
  }

  // Ends the shown terminal's connection and view for good (it is restarted or deleted, or the page shows something else for a long time).
  function disconnect() {
    const s = session;
    session = null;
    if (s) disposeSession(s);
  }
  function disposeSession(s) {
    if (s.disposed) return;
    if (session === s) session = null;
    warm = warm.filter(item => item !== s);
    s.disposed = true;
    scheduleWheelSync();
    s.gestures?.dispose();
    clearTimeout(s.timer);
    s.heartbeat?.stop();
    s.observer?.disconnect();
    s.clipboard?.dispose();
    if (s.ws) { const ws = s.ws; s.ws = null; try { ws.close(); } catch { /* already closed */ } }
    disposeTerm(s.term);
    s.el.remove();
  }
  // xterm 5.5 never disposes its screen-DPR monitor, which keeps a window `resize` listener and a matchMedia listener per terminal: two leaked listeners
  // for every terminal ever opened. It is disposed here after the terminal (a private field; nothing happens when a later xterm renames it).
  function disposeTerm(term) {
    const monitor = term._core && term._core._coreBrowserService && term._core._coreBrowserService._screenDprMonitor;
    term.dispose();
    try { if (monitor && typeof monitor.dispose === 'function') monitor.dispose(); } catch { /* already gone */ }
  }

  // Phones drop sockets in the background; reconnect when the page comes back.
  let warmIdle = 0;
  function sleepWarm() { // the page has been hidden for WARM_IDLE_MS: close every socket; the shown terminal keeps its view and connects when shown
    warmIdle = 0;
    for (const s of warm) {
      if (s !== session) { disposeSession(s); continue; }
      clearTimeout(s.timer);
      s.timer = null;
      s.heartbeat?.stop();
      if (s.ws) { const ws = s.ws; s.ws = null; try { ws.close(); } catch { /* already closed */ } }
    }
  }
  document.addEventListener('visibilitychange', () => {
    void syncWakeLock();
    clearTimeout(warmIdle);
    warmIdle = 0;
    if (document.visibilityState !== 'visible') { warmIdle = setTimeout(sleepWarm, WARM_IDLE_MS); return; }
    fitViewport();
    settleViewport(); // iOS can report the real height late and send no event
    ackShown(); // the person is looking again: a terminal that finished meanwhile is seen now
    if (session && !session.ws && !session.timer) open(session);
    else if (session && !session.ws && session.timer) { clearTimeout(session.timer); session.timer = null; open(session); } // do not wait out the backoff
  });

  // ── Terminal "done" acknowledgement ──
  // The server keeps each terminal's activity state: running, done (finished, not yet seen) or idle (lib/terminal-activity.js). Seeing a finished
  // terminal is what clears 'done': when a terminal is shown while the page is visible, when the shown one turns 'done' while it is visible (pushed, see below), and when
  // the page becomes visible again, `POST {tasksBase}/{task}/terminal/ack` tells the server (local, Engine `/v1` and the remote proxy alike; the server
  // ignores it unless the state is 'done'). The next-session button then sees that terminal as idle. A terminal hidden under a chat is not seen.
  const shownTerminal = () => (session && !session.disposed && !agentChat && document.visibilityState === 'visible' ? session : null);
  function ackShown() {
    const s = shownTerminal();
    if (!s) return;
    api('POST', `${s.source.tasksBase}/${s.task.id}/terminal/ack`, { terminal_id: s.terminalId }).catch(() => { /* an older Engine, or offline: it stays pending */ });
  }

  // ── Terminal activity push (`GET {activityBase}/terminal-activity/stream`, server-sent events read with fetch) ──
  // The server sends `event: activity` with { activity, subagents } (the answers of the two polling endpoints) on connect and on every change
  // (lib/terminal-activity-stream.js). It drives the count on #h5-cycle, the next-session button and the "done" ack of the shown terminal.
  // fetch, not EventSource, so the status is seen: 404 / 405 / 501 means an Engine older than the stream (also through the remote proxy), and the page then
  // polls slowly instead (FALLBACK_POLL_MS). Other failures reconnect with a backoff (1 s doubling to 30 s), polling slowly meanwhile. A stream that is
  // silent for STALL_MS (the server sends a comment every 20 s) is taken as dead. The stream is closed while the page is hidden and opened again, with a
  // fresh snapshot, when it is shown: nothing on a hidden page needs the state, and phones drop background connections anyway. Each tab has its own stream.
  const FALLBACK_POLL_MS = 30000;
  const STALL_MS = 50000;
  // One feed per listed service with its own backoff (`feeds`, by source key), none for a service that is hidden or offline. Every stream is a long-lived fetch to this
  // origin and HTTP/1.1 allows about 6 connections: the page keeps at most MAX_STREAMS live (this machine and the service of the shown task first) and polls the others
  // every FALLBACK_POLL_MS, so normal requests are never blocked. WebSockets do not count against that limit; T-Attention has one stream of its own, so 2 stay free.
  const MAX_STREAMS = 3;
  const MAX_STREAMS_H2 = 16; // one connection carries them all
  // A pane of the multi-column view opens none: several panes would use up the connections, so each one polls (only while it is visible).
  const streamLimit = () => {
    if (PANE) return 0;
    const nav = performance.getEntriesByType('navigation')[0];
    return /^h[23]/.test((nav && nav.nextHopProtocol) || '') ? MAX_STREAMS_H2 : MAX_STREAMS;
  };
  const feeds = new Map();
  function feedOf(from) {
    let f = feeds.get(from.key);
    if (!f || f.source !== from) {
      if (f) stopFeed(f);
      f = { source: from, live: false, snapshot: null, ctrl: null, retry: 0, retryTimer: null, poll: null, stall: null, wanted: null, noStream: false };
      feeds.set(from.key, f);
    }
    return f;
  }
  const feedRuns = f => Boolean(f.ctrl || f.retryTimer || f.poll);
  // Decides which feeds run and how: after a change of the services, of what is shown, of what is hidden, of a service going offline or back, and of the page being shown.
  function syncFeeds() {
    if (!listReady) return; // what is listed and hidden is not known yet
    const listed = listedSources();
    for (const [key, f] of feeds) {
      if (listed.includes(f.source) && sources.includes(f.source) && f.source.status !== 'offline') continue;
      stopFeed(f);
      feeds.delete(key);
    }
    if (document.visibilityState !== 'visible') { for (const f of feeds.values()) stopFeed(f); showActiveCount(); return; }
    const online = listed.filter(from => from.status !== 'offline');
    const order = [LOCAL, source, ...online].filter((from, index, all) => online.includes(from) && all.indexOf(from) === index);
    const max = streamLimit();
    let streams = 0;
    for (const from of order) {
      const f = feedOf(from);
      const stream = !f.noStream && streams < max;
      if (stream) streams += 1;
      const wanted = stream ? 'stream' : 'poll';
      if (f.wanted === wanted && feedRuns(f)) continue;
      stopFeed(f);
      f.wanted = wanted;
      if (stream) void connectFeed(f); else startFallbackPoll(f);
    }
    showActiveCount();
  }
  async function readActivity(from) {
    return Promise.all([
      api('GET', `${from.activityBase}/terminal-activity`),
      api('GET', `${from.activityBase}/terminal-subagents`).catch(() => ({})), // an Engine older than this feature: no sub-agent information
    ]);
  }
  // A failed feed may mean that the service went away: the list is read at once (at most every few seconds), which says so.
  function checkSource(from) {
    if (from.status === 'offline' || Date.now() - from.checkedAt < 5000) return;
    void loadSource(from);
  }
  const snapshotOf = from => {
    const f = feeds.get(from.key);
    return f && from.status !== 'offline' && !hiddenDevices.has(from.key) ? f.snapshot : null;
  };
  // The running and pending terminals of one task, for the Running and Pending filters of the list.
  function activeIn(from, taskId) {
    const snap = snapshotOf(from);
    if (!snap) return { running: 0, pending: 0 };
    const states = snap.activity[taskId] || {};
    const subs = snap.subagents[taskId] || {};
    let running = 0;
    let pending = 0;
    for (const id of new Set([...Object.keys(states), ...Object.keys(subs)])) {
      if (states[id] === 'running' || Number(subs[id]) > 0) running += 1;
      else if (states[id] === 'done') pending += 1;
    }
    return { running, pending };
  }
  // Running (a running state or a running sub-agent) and pending ('done') terminals of the listed tasks of every listed service: the same set the next-session button goes through.
  function showActiveCount() {
    let count = 0;
    for (const from of listedSources()) {
      const snap = snapshotOf(from);
      if (!snap) continue;
      const listed = new Set(from.tasks.map(item => String(item.id)));
      for (const taskId of new Set([...Object.keys(snap.activity), ...Object.keys(snap.subagents)])) {
        if (!listed.has(taskId)) continue;
        const states = snap.activity[taskId] || {};
        const subs = snap.subagents[taskId] || {};
        for (const id of new Set([...Object.keys(states), ...Object.keys(subs)])) if (states[id] === 'running' || states[id] === 'done' || Number(subs[id]) > 0) count += 1;
      }
    }
    ui.set({ activeCount: count });
  }
  function applyActivity(f, snap) {
    const from = f.source;
    if (feeds.get(from.key) !== f) return;
    const object = value => (value && typeof value === 'object' ? value : {});
    const next = { activity: object(snap && snap.activity), subagents: object(snap && snap.subagents) };
    const changed = JSON.stringify(next) !== JSON.stringify(f.snapshot);
    f.snapshot = next;
    showActiveCount();
    if (changed) renderTasks(); // the Running and Pending filters
    // The shown terminal finished while the person is looking at it: it is seen.
    const s = shownTerminal();
    if (s && s.source === from && ((next.activity[s.task.id] || {})[s.terminalId]) === 'done') ackShown();
  }
  function stopFeed(f) {
    if (f.ctrl) f.ctrl.abort();
    clearTimeout(f.retryTimer);
    clearTimeout(f.stall);
    clearInterval(f.poll);
    Object.assign(f, { live: false, ctrl: null, retryTimer: null, stall: null, poll: null });
  }
  function startFallbackPoll(f) {
    if (f.poll) return;
    const from = f.source;
    const tick = async () => {
      if (document.visibilityState !== 'visible' || f.live || feeds.get(from.key) !== f) return;
      try { const [activity, subagents] = await readActivity(from); applyActivity(f, { activity, subagents }); } catch { checkSource(from); /* keep the last state */ }
    };
    f.poll = setInterval(() => void tick(), FALLBACK_POLL_MS);
    void tick();
  }
  function retryFeed(f) {
    f.live = false;
    startFallbackPoll(f);
    clearTimeout(f.retryTimer);
    f.retryTimer = setTimeout(() => void connectFeed(f), Math.min(30000, 1000 * 2 ** f.retry++));
    checkSource(f.source);
  }
  async function connectFeed(f) {
    const from = f.source;
    if (f.ctrl) f.ctrl.abort();
    clearTimeout(f.retryTimer);
    clearTimeout(f.stall);
    Object.assign(f, { ctrl: null, retryTimer: null, stall: null, live: false });
    if (document.visibilityState !== 'visible' || feeds.get(from.key) !== f) return;
    const ctrl = new AbortController();
    f.ctrl = ctrl;
    const stalled = () => { clearTimeout(f.stall); f.stall = setTimeout(() => ctrl.abort(), STALL_MS); };
    let res;
    try {
      res = await fetch(`${from.activityBase}/terminal-activity/stream`, { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/event-stream' }, cache: 'no-store', signal: ctrl.signal });
    } catch { if (f.ctrl === ctrl) retryFeed(f); return; }
    if (f.ctrl !== ctrl) return;
    if (!res.ok || !res.body || !/text\/event-stream/.test(res.headers.get('content-type') || '')) {
      ctrl.abort();
      if ([404, 405, 501].includes(res.status) || res.ok) { f.ctrl = null; f.noStream = true; startFallbackPoll(f); } // no stream on this Engine: poll slowly
      else retryFeed(f);
      return;
    }
    f.live = true;
    f.retry = 0;
    clearInterval(f.poll);
    f.poll = null;
    stalled();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stalled();
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
          }
          if (event === 'activity' && data) { try { applyActivity(f, JSON.parse(data)); } catch { /* a broken message: wait for the next */ } }
        }
      }
    } catch { /* aborted or dropped */ }
    if (f.ctrl !== ctrl) return; // closed on purpose (hidden page, a service gone)
    clearTimeout(f.stall);
    retryFeed(f);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { syncFeeds(); retryOffline(); }
    else for (const f of feeds.values()) stopFeed(f);
  });

  // ── A hardware keyboard: type to the terminal, Escape back to it, Cmd/Ctrl+K for the search (deskKeys: a computer, or a tablet with a keyboard) ──
  // A dialog, a temporary drawer (task sheet, settings, menus) or the copy view is open: keys belong to it.
  const modalOpen = () => Boolean(document.querySelector('.MuiModal-root:not(.MuiModal-hidden), dialog[open]')) || ui.get().copyText !== null;
  const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'AltGraph', 'Dead', 'Unidentified', 'Process', 'Compose']);
  // Cmd+K (Apple) or Ctrl+K (others) focuses the session search; on a wide screen a folded sidebar comes back first. Inside the terminal, Ctrl+K stays the
  // shell's own key (kill to the end of the line), so on other systems it works only outside the terminal.
  document.addEventListener('keydown', event => {
    if (mindmap || !deskKeys() || event.defaultPrevented || event.repeat || event.shiftKey || event.altKey || (event.key || '').toLowerCase() !== 'k') return; // the mind map view keeps its keys
    if (APPLE ? !(event.metaKey && !event.ctrlKey) : !(event.ctrlKey && !event.metaKey)) return;
    if (!APPLE && document.activeElement && document.activeElement.closest && document.activeElement.closest('.xterm')) return;
    if (document.querySelector('dialog[open]') || ui.get().copyText !== null) return;
    event.preventDefault();
    event.stopPropagation();
    ui.actions.openTasks();
    const focusSearch = (tries = 0) => {
      const box = $('h5-task-search-input');
      if (box) { box.focus(); box.select(); } else if (tries < 10) setTimeout(() => focusSearch(tries + 1), 30);
    };
    setTimeout(focusSearch, 0);
  }, true);
  // Typing with nothing editable focused goes to the terminal: the key is sent and the terminal takes the focus, so the next keys go to it directly.
  // Keys with Cmd stay the browser's (and Ctrl ones on other systems: reload, tabs ...); function keys (F1-F12) and lone modifiers are left alone. A focused
  // button or link keeps Enter, Space, Tab and the arrows; only characters go on from there. A dialog, the chat and the side panel keep their keys.
  document.addEventListener('keydown', event => {
    if (mindmap || !deskKeys() || event.defaultPrevented || !event.key || MODIFIER_KEYS.has(event.key) || event.metaKey) return; // nothing goes to the terminal while the mind map view is open
    if (event.ctrlKey && !APPLE) return;
    const s = session;
    if (!s || s.disposed || agentChat || modalOpen()) return;
    const active = document.activeElement;
    if (editing(active) || (active && active.closest && active.closest('#h5-design-sheet, #h5-files-sheet, #h5-attention-sheet, #h5-agent'))) return;
    if (event.key === 'Escape' && isWide() && ui.get().attention && ui.get().attention.open) { ui.actions.closeAttention(); return; } // the T-Attention panel
    const onBody = !active || active === document.body || active === document.documentElement;
    const printable = Array.from(event.key).length === 1;
    if (!onBody && (!printable || event.key === ' ')) return;
    if (event.isComposing || event.keyCode === 229) { s.term.focus(); return; } // an IME starts: let it compose in the terminal
    const data = printable && !event.ctrlKey && (!event.altKey || APPLE) ? event.key // Option on a Mac types its own characters
      : TerminalKeys.encode(event.key, { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey });
    if (data === null || data === undefined) return;
    event.preventDefault();
    s.term.focus();
    typed(s, data);
  });
  // A click on the terminal gives it the focus (xterm does this on mouse down too; this also covers a click on its padding).
  terminalHost.addEventListener('click', event => {
    const s = session;
    if (!deskKeys() || !s || s.disposed || s.term.hasSelection() || (event.target.closest && event.target.closest('#h5-wheel, #h5-clipboard-bar'))) return;
    s.term.focus();
  });

  // ── Keys ──
  function renderMods() { ui.set({ mods: { ...mods } }); }
  function clearMods() { if (Object.values(mods).some(Boolean)) { mods = {}; renderMods(); } else mods = {}; }
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
  // A key combination of the saved commands list ("Keys", scripts/h5-shell/commands.mjs): its exact bytes, or a list of byte strings sent one after another
  // KEY_GAP ms apart, so "Esc Esc" reaches the program as two presses and not as one Alt+Esc. The entry already is the whole key, so a latched Ctrl / Alt / Shift
  // from row 1 is dropped, not added to it (and not left for the next typed character).
  const KEY_GAP = 120;
  function sendBytes(data) {
    const parts = Array.isArray(data) ? data : [data];
    const target = session;
    clearMods();
    if (!send(target, parts[0])) { tell('The terminal is not connected', 'error'); return; }
    parts.slice(1).forEach((part, index) => setTimeout(() => send(target, part), KEY_GAP * (index + 1)));
  }
  function noScreenKeyboard(term) {
    if (term.textarea) term.textarea.setAttribute('inputmode', 'none');
  }
  // The "Terminal keyboard" key shows and hides the terminal's own on-screen keyboard (`state.osk`, drawn by scripts/h5-shell/Osk.jsx); the system keyboard
  // is never opened for the terminal. Opening it closes a system keyboard that is up: the draft box and the terminal's textarea lose the focus, and the
  // textarea keeps inputmode="none". The keyboard takes room under row 2, so the terminal box gets shorter and refits (its ResizeObserver) like on any
  // size change; nothing here waits for the visual viewport. Its keys call `ui.actions.key`, like row 1.
  function setOsk(open) {
    if (Boolean(ui.get().osk) === open) return;
    if (open) {
      if (document.activeElement === translateInput) translateInput.blur();
      const textarea = session && session.term && session.term.textarea;
      if (textarea) { noScreenKeyboard(session.term); if (document.activeElement === textarea) textarea.blur(); }
    }
    ui.set({ osk: open });
  }
  function toggleKeyboard() {
    if (!ui.get().osk && !session) return; // nothing to type into
    setOsk(!ui.get().osk);
  }
  // The "Draft keyboard" key: focus the draft box (it is hidden until it has the focus, see TranslateBar), so the on-screen keyboard types into it; a second tap closes the keyboard.
  // The terminal's textarea loses the focus (it always has inputmode none). The terminal's own keyboard is hidden first.
  function toggleDraftKeyboard() {
    if (document.activeElement === translateInput) { translateInput.blur(); return; }
    setOsk(false);
    translateInput.focus();
    autosize();
    relayoutBar();
  }
  // Which keyboard key is blue: the draft one while the draft box has the focus (the terminal one follows `state.osk`, see ActionBar).
  const keyboardTarget = el => (el === translateInput ? 'draft' : null);
  document.addEventListener('focusin', event => {
    ui.set({ keyboard: keyboardTarget(event.target) });
    if (event.target === translateInput) setOsk(false); // the system keyboard comes up for the draft box: the terminal keyboard steps aside
  });
  document.addEventListener('focusout', event => ui.set({ keyboard: keyboardTarget(event.relatedTarget) }));
  // ── Paste (the "Paste text" row of the saved commands list) ──
  // ONE clipboard read per tap, started synchronously in the tap's click handler (TerminalClipboard.readClipboard): WebKit, so every iOS browser, allows
  // a read only inside the user gesture and shows its "Paste" callout for each read, so a second read (or a read after an await) is refused. An image
  // goes to the upload, text to the terminal as one paste (xterm keeps bracketed paste). When the browser refuses the read, the user dismisses the
  // callout or there is no clipboard API, the Paste sheet opens: a box where the system's own paste (long-press, Paste) always works.
  let pasteReading = false;
  function paste() {
    if (!session || pasteReading || typeof TerminalClipboard === 'undefined') return;
    const target = session;
    pasteReading = true;
    const reading = TerminalClipboard.readClipboard(navigator.clipboard); // no await before this line: it must run inside the tap
    reading.then(result => {
      if (result.kind === 'image') { pasteImage(target, new File([result.blob], 'pasted-image', { type: result.type })); return; }
      if (result.kind === 'text') { pasteInto(target, result.text); return; }
      if (result.kind === 'empty') { tell('The clipboard is empty'); return; }
      if (!window.isSecureContext) tell('Paste needs HTTPS or localhost; the browser blocks clipboard reads here', 'error');
      openPasteSheet(target);
    }).finally(() => { pasteReading = false; });
  }
  function pasteInto(target, text) {
    if (!text) return false;
    if (uploading || !connected(target)) { tell('The terminal is not connected', 'error'); return false; }
    target.clipboard?.gesture();
    target.term.paste(text);
    return true;
  }
  function pasteImage(target, file) {
    if (!uploading && target && !target.disposed) void upload(target, file);
  }
  // The Paste sheet (Dialogs.jsx `PasteDialog`, `state.pasteSheet`). The element that had the focus (usually the terminal's textarea) gets it back on close.
  let pasteSheet = null; // { target, focus }
  function openPasteSheet(target) {
    pasteSheet = { target, focus: document.activeElement };
    ui.set({ pasteSheet: { open: true } });
  }
  function closePasteSheet() {
    const was = pasteSheet;
    pasteSheet = null;
    ui.set({ pasteSheet: null });
    const focus = was && was.focus;
    if (focus && focus.isConnected && focus !== document.body && typeof focus.focus === 'function') setTimeout(() => { try { focus.focus({ preventScroll: true }); } catch { /* gone */ } }, 0);
  }
  ui.actions.pasteSheetSend = text => {
    const target = pasteSheet ? pasteSheet.target : session;
    if (!text) return;
    if (pasteInto(target, text)) closePasteSheet();
  };
  ui.actions.pasteSheetFile = file => {
    const target = pasteSheet ? pasteSheet.target : session;
    if (!file) return;
    closePasteSheet();
    pasteImage(target, file);
  };
  ui.actions.pasteSheetClose = () => closePasteSheet();

  // ── Copy text: the terminal buffer as plain text in an overlay, so the browser's own selection handles work ──
  function bufferText(term) {
    const buffer = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      // A row that a wrapped row continues must keep its trailing spaces (a space in the last cell is real text); only the end of a logical line is trimmed.
      const next = buffer.getLine(i + 1);
      const text = line.translateToString(!(next && next.isWrapped));
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  }
  let copyWatch = null; // { term, listener, timer }: refreshes the open copy view when new output arrives
  function stopCopyWatch() {
    if (!copyWatch) return;
    clearTimeout(copyWatch.timer);
    copyWatch.listener.dispose();
    copyWatch = null;
  }
  function copyBoxSelected() { // the user holds a text selection inside the copy view
    const box = $('h5-copy-text');
    const selection = window.getSelection();
    return Boolean(box && selection && !selection.isCollapsed && selection.rangeCount && box.contains(selection.anchorNode));
  }
  function refreshCopy(force = false) {
    if (ui.get().copyText === null || !session || session.disposed) return;
    const text = bufferText(session.term);
    if (!text || text === ui.get().copyText) { if (ui.get().copyStale) ui.set({ copyStale: false }); return; }
    if (!force && copyBoxSelected()) { ui.set({ copyStale: true }); return; } // never replace text under an active selection
    if (force) window.getSelection()?.removeAllRanges();
    ui.set({ copyText: text, copyStale: false });
  }
  function openCopy() {
    const text = session && !session.disposed ? bufferText(session.term) : '';
    if (!text) { tell('Nothing to copy'); return; }
    stopCopyWatch();
    const term = session.term;
    copyWatch = { term, timer: 0, listener: term.onWriteParsed(() => { // debounced: a busy program must not rebuild the text on every chunk
      clearTimeout(copyWatch.timer);
      copyWatch.timer = setTimeout(() => refreshCopy(false), 400);
    }) };
    searchState = { query: '', from: 0 };
    ui.set({ copyText: text, copyStale: false });
  }
  function closeCopy() { stopCopyWatch(); clearCopyHighlight(); ui.set({ copyText: null, copyStale: false }); }

  // Search in the copy view: jump to the next match (wrapping around) and mark it. The Custom Highlight API marks it without touching the user's
  // selection; without it the match is selected instead.
  let searchState = { query: '', from: 0 };
  function clearCopyHighlight() { try { window.CSS?.highlights?.delete('h5-copy-match'); } catch { /* not supported */ } }
  function copySearch(query) {
    const box = $('h5-copy-text');
    const text = ui.get().copyText || '';
    const node = box && box.firstChild;
    clearCopyHighlight();
    if (!query || !node || node.nodeType !== 3) { searchState = { query, from: 0 }; return false; }
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    const from = searchState.query === query ? searchState.from : 0;
    let at = hay.indexOf(needle, from);
    if (at < 0) at = hay.indexOf(needle); // wrap around
    if (at < 0) { searchState = { query, from: 0 }; return false; }
    searchState = { query, from: at + needle.length };
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    if (window.CSS?.highlights && typeof Highlight === 'function') {
      CSS.highlights.set('h5-copy-match', new Highlight(range));
    } else {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const row = text.slice(0, at).split('\n').length - 1; // one terminal row is one line, so the row decides the scroll position
    const lineHeight = parseFloat(getComputedStyle(box).lineHeight) || 13;
    box.scrollTop = Math.max(0, row * lineHeight - box.clientHeight / 2);
    return true;
  }
  async function copyAll() {
    const text = ui.get().copyText || '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard API (plain HTTP): select everything and use the legacy copy command.
      const copyText = $('h5-copy-text');
      const range = document.createRange();
      range.selectNodeContents(copyText);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand || !document.execCommand('copy')) { tell('Could not copy. Select the text and copy it by hand', 'error'); return; }
    }
    tell('Copied', 'success');
  }
  ui.actions.openCopy = openCopy;
  ui.actions.copyClose = closeCopy;
  ui.actions.copyAll = () => void copyAll();
  ui.actions.copyRefresh = () => refreshCopy(true);
  ui.actions.copySearch = query => {
    if (copySearch(query) === false && query) tell('No match');
  };

  // Long press on the terminal body opens the copy view (also reachable from the terminal actions menu, "Copy text"), scrolled to the latest output. It is cancelled by any movement
  // (a scroll or a drag), by lifting the finger, and it ignores the wheel strip, the buttons and mouse input.
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_SLOP = 8; // px a finger may move before it is a scroll, not a press
  let longPress = null;
  let lastPointerTouch = false;
  let longPressDone = false; // the next click belongs to the press that opened the view
  function cancelLongPress() { if (longPress) { clearTimeout(longPress.timer); longPress = null; } }
  terminalHost.addEventListener('pointerdown', event => {
    cancelLongPress();
    longPressDone = false;
    lastPointerTouch = event.pointerType !== 'mouse'; // a mouse keeps xterm's own double-click selection
    if (event.pointerType === 'mouse' || !event.isPrimary || !event.target.closest || !event.target.closest('.h5-xterm')) return;
    longPress = { id: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(() => {
      longPress = null;
      longPressDone = true;
      cancelPendingLink();
      if (session && !session.disposed && ui.get().copyText === null) openCopy();
    }, LONG_PRESS_MS) };
  });
  terminalHost.addEventListener('pointermove', event => {
    if (longPress && event.pointerId === longPress.id && Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > LONG_PRESS_SLOP) cancelLongPress();
  });
  for (const type of ['pointerup', 'pointercancel']) terminalHost.addEventListener(type, cancelLongPress);
  terminalHost.addEventListener('scroll', cancelLongPress, true);
  terminalHost.addEventListener('contextmenu', event => { if (event.target.closest && event.target.closest('.h5-xterm') && longPressDone) event.preventDefault(); });

  // Double tap selects a word and triple tap a line, with xterm's own selection (term.select / selectLines), and copies it at once, inside the
  // tap (copy on select, terminal-clipboard.js `copy`: the same notice and bar as a program's OSC 52 copy). Only while the program has no mouse
  // mode (term.modes.mouseTrackingMode === 'none'): vim, tmux and Claude Code get every tap as a click, never swallowed. The cell comes from the
  // bounding box of .xterm-screen, which already includes the 4px inset, any transform (scale) and the keyboard shift. New output, or a tap
  // elsewhere, clears the highlight.
  const MULTI_TAP_MS = 400;
  const MULTI_TAP_SLOP = 24; // px between taps of one multi-tap
  let tapChain = { count: 0, at: 0, x: 0, y: 0 };
  function cellAt(s, x, y) {
    const screen = s.el.querySelector('.xterm-screen');
    if (!screen || !s.term.cols || !s.term.rows) return null;
    const rect = screen.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return null;
    const col = Math.min(s.term.cols - 1, Math.floor((x - rect.left) / (rect.width / s.term.cols)));
    const row = Math.min(s.term.rows - 1, Math.floor((y - rect.top) / (rect.height / s.term.rows)));
    return { col, row: s.term.buffer.active.viewportY + row, screenRow: row };
  }
  const WORD_BREAK = /[\s()[\]{}<>'"`,;|]/;
  function wordRange(line, col, cols) {
    const at = c => { // the text of a cell; the second half of a wide character belongs to the first
      let cell = line.getCell(c);
      if (cell && cell.getWidth() === 0 && c > 0) { c -= 1; cell = line.getCell(c); }
      return cell ? { chars: cell.getChars() || ' ', start: c, width: Math.max(1, cell.getWidth()) } : null;
    };
    const hit = at(col);
    if (!hit || WORD_BREAK.test(hit.chars)) return null;
    let start = hit.start;
    while (start > 0) {
      const previous = at(start - 1);
      if (!previous || WORD_BREAK.test(previous.chars)) break;
      start = previous.start;
    }
    let end = hit.start + hit.width;
    while (end < cols) {
      const next = at(end);
      if (!next || WORD_BREAK.test(next.chars)) break;
      end = next.start + next.width;
    }
    return { start, length: end - start };
  }
  function selectAt(s, cell, count) {
    const buffer = s.term.buffer.active;
    if (count === 2) {
      const line = buffer.getLine(cell.row);
      const range = line && wordRange(line, cell.col, s.term.cols);
      if (!range) return false;
      s.term.select(range.start, cell.row, range.length);
    } else {
      let first = cell.row;
      let last = cell.row;
      while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
      while (buffer.getLine(last + 1)?.isWrapped) last++;
      s.term.selectLines(first, last);
    }
    return true;
  }
  function hookSelection(s) {
    if (s.selectionHooked) return;
    s.selectionHooked = true;
    s.term.onWriteParsed(() => { if (s.term.hasSelection()) s.term.clearSelection(); }); // new output moves the text under the highlight
  }
  terminalHost.addEventListener('click', event => {
    const s = session;
    if (!s || s.disposed || !lastPointerTouch || longPressDone || !event.target.closest || !event.target.closest('.h5-xterm')) return;
    if (s.gestures?.recentlyPanned()) return; // the end of a pan, not a tap
    const now = Date.now();
    const chain = now - tapChain.at < MULTI_TAP_MS && Math.hypot(event.clientX - tapChain.x, event.clientY - tapChain.y) < MULTI_TAP_SLOP ? tapChain.count + 1 : 1;
    tapChain = { count: chain, at: now, x: event.clientX, y: event.clientY };
    hookSelection(s);
    if (chain > 1) cancelPendingLink(); // a double or triple tap on a file link selects; it does not open the file
    if (chain === 1) { if (s.term.hasSelection()) s.term.clearSelection(); return; } // a tap elsewhere
    if (chain > 3) { tapChain.count = 1; return; }
    if (s.term.modes.mouseTrackingMode !== 'none') return; // the program owns the taps
    const cell = cellAt(s, event.clientX, event.clientY);
    if (cell && selectAt(s, cell, chain) && s.term.hasSelection()) void s.clipboard?.copy(s.term.getSelection()); // inside this tap's user activation
  });
  // The copy bar (terminal-clipboard.js, `state.clipboard`): a program's copy waiting for Copy, or a copy the browser refused ("Tap to copy").
  // The button writes inside its own tap, Cancel drops it.
  if (typeof TerminalClipboard !== 'undefined') TerminalClipboard.setHost({ show: request => ui.set({ clipboard: request }) });
  ui.actions.clipboardConfirm = () => { if (typeof TerminalClipboard !== 'undefined') void TerminalClipboard.confirm(); };
  ui.actions.clipboardCancel = () => { if (typeof TerminalClipboard !== 'undefined') TerminalClipboard.cancel(); };

  // A tap on a key of the key bar (the shell keeps the focus where it is, so tapping keys does not open or close the on-screen keyboard).
  // Types a preset command into the terminal like a paste; no Enter is sent, so the user checks it and presses Enter.
  ui.actions.insertCommand = command => {
    if (uploading || !connected(session)) { tell('The terminal is not connected', 'error'); return; }
    session.clipboard?.gesture();
    session.term.paste(command);
  };
  ui.actions.key = item => {
    if (session && !session.disposed && (item.send || item.key || item.shortcut)) session.clipboard?.gesture(); // a key the user sent to this terminal (key bar, on-screen keyboard)
    if (item.modifier) {
      mods[item.modifier] = !mods[item.modifier];
      renderMods();
    } else if (item.action === 'keyboard') toggleKeyboard();
    else if (item.action === 'draft') toggleDraftKeyboard();
    else if (item.action === 'paste') void paste();
    else if (item.action === 'image') pickImage();
    else if (item.send) sendBytes(item.send);
    else if (item.shortcut === 'ctrl-c') sendKey('c', { ctrl: true });
    else if (item.key) sendKey(item.key, mods);
  };

  // ── Translate and send ──
  let translating = false;
  // The one place that sets the height of the translate box: while it has focus it grows with its text and shows ALL of it (wrapped lines and Enter
  // new lines included), measured from the textarea's own scrollHeight. Only a safety cap makes it scroll inside: half of the visible viewport height
  // (visualViewport, so the on-screen keyboard is already subtracted), cut down to whole lines, so the key row, the buttons and part of the terminal stay in view.
  // Called on input, on focus changes, after a send, when the viewport changes and at start.
  const TRANSLATE_MAX_VIEWPORT_FRACTION = 0.5;
  let oneLineInput = 0;
  function autosize() {
    const input = translateInput;
    input.style.height = '';
    input.style.overflowY = 'hidden';
    oneLineInput = input.offsetHeight; // rows=1 with no height set: the one-line box (the resting line that a computer's layout keeps room for)
    // One line while the box is empty, or while it has no focus (keyboard dismissed): the text stays in the box, clipped to the first line, and is shown in full again on focus.
    // A pressed bar button (data-hold) keeps the current size so the button does not move under the finger.
    const resting = document.activeElement !== input && !translateForm.hasAttribute('data-hold');
    if (!input.value || resting) { if (resting) input.scrollTop = 0; syncBar(); return; } // the natural height of rows=1
    const style = getComputedStyle(input);
    const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 15) * 1.4375;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    const visible = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const maxLines = Math.max(2, Math.floor((visible * TRANSLATE_MAX_VIEWPORT_FRACTION - padding) / lineHeight));
    const cap = Math.round(lineHeight * maxLines + padding); // scrollHeight includes the padding
    const wanted = Math.min(input.scrollHeight, cap);
    input.style.height = `${style.boxSizing === 'border-box' ? wanted + border : wanted - padding}px`;
    input.style.overflowY = input.scrollHeight > cap + 1 ? 'auto' : 'hidden';
    syncBar(); // the bar grows over the terminal; the terminal is moved, not resized
  }
  // The TRANSLATION (machine output the user has not seen) keeps its line breaks only when the program in the terminal reads a paste as one paste (bracketed paste
  // mode, as Claude Code does). Then it goes in as ONE bracketed paste, so no line is run on its own. Without that mode a shell would run every line at once, so the
  // lines are joined with spaces. Control characters (ESC included) are removed in both cases, so the text cannot carry its own paste end marker or any key sequence.
  const LINE_CONTROLS = new RegExp('[\\u0000-\\u0009\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]+', 'g');
  function pasteText(raw) {
    const lines = String(raw).replace(/\r\n?|\u2028|\u2029/g, '\n').replace(LINE_CONTROLS, ' ').split('\n').map(line => line.replace(/\s+/g, ' ').trim());
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  // A long single line must go in as one bracketed paste too. The PTY hands the program its input in pieces of about 1 KB, and Claude Code reads a big
  // unbracketed piece as a paste of its own: the first piece became a "[Pasted text #1]" chip and the rest was typed after it, so the line seemed to start in
  // the middle of a word. A short line (at most PASTE_LINE_CHARS, so at most 800 bytes of UTF-8: always one piece) is still typed as keys, so a "/command" or
  // a "!" at the start keeps working as if it was typed.
  const PASTE_LINE_CHARS = 200;
  const bracketedPaste = target => Boolean(target.term && target.term.modes && target.term.modes.bracketedPasteMode);
  const asPaste = (target, text) => bracketedPaste(target) && (/[\n\t]/.test(text) || text.length > PASTE_LINE_CHARS);
  function sendTranslation(target, raw) {
    const text = pasteText(raw);
    if (!text) return false;
    if (asPaste(target, text)) return send(target, `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`);
    if (!text.includes('\n')) return send(target, text);
    return send(target, TerminalTranslate.sanitize(text));
  }
  // What the user TYPED (the send arrow) reaches the terminal as typed: any length, every character, spaces, tabs, blank lines and indentation kept, nothing trimmed.
  // Line breaks become carriage returns (what the Enter key sends). Text with a line break or a tab, or one line longer than PASTE_LINE_CHARS, goes in as ONE
  // bracketed paste when the program has that mode on, so a shell or Claude Code neither runs a line early, completes on the tab nor cuts a long line in two;
  // without the mode it is typed key by key, as a desktop paste into xterm is.
  // Only invisible control characters (ESC, NUL, C1 and the like, which a keyboard cannot type but a paste can carry) are dropped: they could end the paste early
  // or act as key sequences. Tab and line breaks are kept.
  const TYPED_CONTROLS = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]', 'g');
  const typedText = raw => String(raw).replace(/\r\n?|\u2028|\u2029/g, '\n').replace(TYPED_CONTROLS, '');
  function sendTyped(target, raw) {
    const text = typedText(raw);
    if (!text) return false;
    const keys = text.replace(/\n/g, '\r');
    return send(target, asPaste(target, text) ? `\x1b[200~${keys}\x1b[201~` : keys);
  }
  // Two ways to send what is in the box. Translate button: translate first, then send the English result (sendTranslation). Send arrow: send the text as typed
  // (sendTyped), with no translation and no request to the translator. Both are followed by one Enter. A box with only spaces sends nothing.
  // The box never blocks typing: while a translation runs the user can keep typing; after the send only the text that was sent is taken out of the box, and the
  // keyboard is dismissed only when nothing is left. When the translation fails nothing is sent, the error is shown and the text stays in the box.
  async function submitBox(translateFirst) {
    const typed = translateInput.value;
    const text = typed.trim();
    if (translating || !text) return;
    const target = session;
    if (uploading || !connected(target)) { tell('The terminal is not connected', 'error'); return; }
    translating = true;
    ui.set({ translating: true });
    try {
      let outgoing = text;
      if (translateFirst) {
        const result = await api('POST', '/api/translate', { text });
        outgoing = result && result.text;
        if (!pasteText(outgoing)) throw new Error('Translation result is empty');
      } else if (!typedText(typed).trim()) throw new Error('Nothing to send');
      if (!(translateFirst ? sendTranslation(target, outgoing) : sendTyped(target, typed))) throw new Error('Terminal not connected; the text was not sent');
      setTimeout(() => send(target, '\r'), SUBMIT_DELAY_MS);
      const now = translateInput.value; // typed on while the translation ran: keep what came after the sent text
      translateInput.value = now === typed ? '' : now.startsWith(typed) ? now.slice(typed.length) : now;
      translateForm.removeAttribute('data-hold'); // the press on the send button is over: do not keep the box shown
      // Sent: on a touch screen the on-screen keyboard goes away and the box hides at once (no timer); the terminal is not focused. With a keyboard there is
      // no on-screen keyboard to dismiss, and blurring would leave the focus nowhere, so the terminal takes it: its answer is right there, and the next keys
      // (a confirmation, Ctrl+C) reach it. The box itself stays shown on a computer, ready for the next message.
      if (!translateInput.value) {
        if (deskKeys() && target === session && !target.disposed) target.term.focus();
        else translateInput.blur();
      }
      autosize();
      relayoutBar();
    } catch (error) {
      const message = error.message || (translateFirst ? 'Translation failed' : 'Send failed');
      tell(message, 'error');
      if (/not configured/i.test(message)) tell('Set up the translation service in Settings');
    } finally {
      translating = false;
      ui.set({ translating: false });
    }
  }
  translateForm.addEventListener('submit', event => { event.preventDefault(); void submitBox(false); }); // the send arrow: as typed
  // The keys of the box (the user's rule; there is one box for the phone and the computer layouts):
  // - Enter from a hardware keyboard is the translate-and-send button (the same submitBox, so an empty box or a running translation does nothing). It never adds a line.
  // - Enter from an on-screen keyboard stays a new line (the browser inserts it): that keyboard has no other way to make one, and the buttons are right there.
  // - Cmd+Enter or Ctrl+Enter inserts a new line at the caret, replacing a selection. Only a hardware keyboard can press them. Browsers do nothing for these, so it is done here.
  // - Shift+Enter is a new line (the browser's own). Option+Enter (Alt+Enter) is the send arrow, as typed.
  // - An Enter that confirms an IME candidate is left alone in every combination: isComposing, or keyCode 229 (Safari ends the composition before this keydown).
  // A browser cannot name the keyboard, so "hardware" is: a computer (pointer mode), or a touch device where a hardware key was seen (`hasKeyboard`, entry.jsx) and no
  // on-screen keyboard is open right now (`hasKeyboard` is never cleared, so a keyboard taken away later must not turn the on-screen Return into a send).
  const hardwareEnter = () => pointerMode() || (Boolean(ui.get().hasKeyboard) && !keyboardOpen);
  function insertNewline() {
    const input = translateInput;
    // insertText is what typing does: it keeps the undo history and fires `input`, which runs autosize.
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, '\n'); } catch { /* not supported: below */ }
    if (!inserted) {
      input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    revealCaret(input);
  }
  // At its height cap the box scrolls inside, and autosize (which collapses the box to measure it, during the `input` event) loses the scroll the browser just made
  // for the caret. A copy of the text up to the caret, wrapped at the same width, gives the caret's line; only that line is scrolled into view.
  function revealCaret(input) {
    if (input.scrollHeight <= input.clientHeight + 1) return;
    const style = getComputedStyle(input);
    const mirror = document.createElement('div');
    for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'lineHeight', 'tabSize', 'wordBreak', 'overflowWrap']) mirror.style[name] = style[name];
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', whiteSpace: 'pre-wrap', width: `${input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px` });
    mirror.textContent = `${input.value.slice(0, input.selectionStart)}\u200b`; // the mark gives a last empty line its height
    document.body.appendChild(mirror);
    const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 15) * 1.4375;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const bottom = paddingTop + mirror.offsetHeight;
    mirror.remove();
    const top = bottom - lineHeight;
    if (bottom + paddingBottom > input.scrollTop + input.clientHeight) input.scrollTop = bottom + paddingBottom - input.clientHeight;
    else if (top - paddingTop < input.scrollTop) input.scrollTop = Math.max(0, top - paddingTop);
  }
  translateInput.addEventListener('keydown', event => {
    // With a keyboard, Escape leaves the draft box for the terminal (the text stays in the box).
    if (event.key === 'Escape' && deskKeys() && !event.isComposing && session && !session.disposed) { event.preventDefault(); session.term.focus(); return; }
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.shiftKey) return;
    if (event.metaKey || event.ctrlKey) { event.preventDefault(); insertNewline(); return; }
    if (!event.altKey && !hardwareEnter()) return; // the on-screen Return: the browser's new line
    event.preventDefault();
    if (!event.repeat) void submitBox(!event.altKey); // a held key sends once
  });
  translateInput.addEventListener('input', () => { autosize(); relayoutBar(); }); // the bar also changes layout when the box gains or loses text
  $('h5-translate-button').addEventListener('click', () => void submitBox(true));
  // The draft box is hidden (no height) until it has the focus, a button is pressed, voice is recording or a translation runs (CSS only, see TranslateBar). It covers the terminal:
  // the page layout reserves nothing for it (`--h5-bar-extra` is a negative top margin of `#h5-bottom`), so no fit and no PTY resize happens. The terminal is moved up by the
  // covered height with one transform (holdTerminalSize), and that move and the bar's own growth or shrink animate over the same time (nothing at all with prefers-reduced-motion).
  const FLIP_MS = 180;
  const FLIP_EASING = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
  let barHeight = barOuterHeight();
  let flips = [];
  let movingTimer = 0;
  const finishFlips = () => { flips.forEach(animation => { try { animation.finish(); } catch { /* already gone */ } }); flips = []; };
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The bar keeps no height in the page layout: it is hidden until the draft box has the focus, and then it covers the terminal. Its outer height (the margin above it counts) is all `--h5-bar-extra`.
  function barOuterHeight() {
    const style = getComputedStyle(translateForm);
    return translateForm.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  }
  // Called whenever the bar height may have changed. The page layout always gets exactly the reserved height (the margin takes the difference, positive or
  // negative), so the terminal box cannot change by even a fraction of a pixel; what the bar covers is moved, not resized.
  function syncBar(animate = false) {
    const height = barOuterHeight();
    // Touch: the whole box covers the terminal (it is hidden at rest). Computer: the box is always shown and its resting line has its own room in the
    // layout, so only the growth beyond one line covers the terminal (the terminal is moved for it, never resized while typing).
    const overlap = pointerMode() ? Math.max(0, translateInput.offsetHeight - oneLineInput) : height;
    const extra = Math.max(0, overlap);
    if (overlap !== barOverlap) bottomArea.style.setProperty('--h5-bar-extra', `${overlap}px`);
    barOverlap = overlap;
    const delta = height - barHeight;
    const moved = Math.abs(extra - barExtra) > 0.5;
    barHeight = height;
    barExtra = extra;
    const el = session && session.el;
    const motion = moved && !reducedMotion() && el && el.animate;
    if (motion) {
      el.classList.add('h5-bar-moving'); // CSS: transform transition + will-change, only while it moves
      clearTimeout(movingTimer);
      movingTimer = setTimeout(() => { if (el) el.classList.remove('h5-bar-moving'); }, FLIP_MS + 60);
    }
    holdTerminalSize();
    if (motion && delta && bottomArea.animate) {
      const grow = delta > 0;
      const d = Math.abs(delta);
      const frames = grow ? [{ clipPath: `inset(${d}px 0 0 0)` }, { clipPath: 'inset(0)' }] : [{ boxShadow: `0 -${d}px 0 0 var(--h5-bg)` }, { boxShadow: '0 0 0 0 var(--h5-bg)' }];
      flips.push(bottomArea.animate(frames, { duration: FLIP_MS, easing: FLIP_EASING }));
    }
  }
  // The bar has one layout, so a change of its height is all there is to follow. Both the focus events and the mutation observer call this; the second call finds nothing new.
  function relayoutBar() { syncBar(); }
  new MutationObserver(records => {
    if (records.some(record => record.attributeName === 'data-hold')) autosize(); // the press ended: a box that lost focus meanwhile collapses now
    relayoutBar();
  }).observe(translateForm, { attributes: true, subtree: true, attributeFilter: ['class', 'data-hold'] });
  // The bar size also changes when the window turns or the font loads: keep the overlap and the measured layout current (no animation).
  new ResizeObserver(() => { if (!flips.length) syncBar(false); }).observe(translateForm);
  autosize(); // the first height (and the first syncBar) once the bar state exists
  // The cap follows the visible height: the keyboard opening or closing, or a rotation, changes it.
  const refitBox = () => { autosize(); relayoutBar(); };
  window.visualViewport?.addEventListener('resize', refitBox);
  window.addEventListener('resize', refitBox);
  // A press on a button: the controls jump to their final places first and the button captures the pointer, so a tap during the animation still ends
  // on the same button. `data-hold` keeps an already active layout from collapsing until a moment after the release; a press at rest does not expand it.
  const PRESS_HOLD_MS = 400;
  let pressTimer = 0;
  bottomArea.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse') return; // a mouse does not slide off a button while the layout animates, and its focus is kept by mousedown
    const button = event.target.closest && event.target.closest('button');
    if (!button) return;
    finishFlips();
    if (button.setPointerCapture) { try { button.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ } }
    clearTimeout(pressTimer);
    // The two keyboard keys move the focus themselves, so the box must follow the focus at once; any other button keeps a shown box until the press ends.
    if (translateForm.getBoundingClientRect().height > 0 && !button.matches('[data-action="keyboard"], [data-action="draft"]')) translateForm.setAttribute('data-hold', '');
  });
  const endPress = () => {
    if (!translateForm.hasAttribute('data-hold')) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => translateForm.removeAttribute('data-hold'), PRESS_HOLD_MS);
  };
  window.addEventListener('pointerup', endPress);
  window.addEventListener('pointercancel', endPress);
  // Focus decides the box height (autosize): expand on focus, collapse to one line on blur, then switch the bar layout.
  translateForm.addEventListener('focusin', () => { autosize(); relayoutBar(); });
  translateForm.addEventListener('focusout', () => { autosize(); relayoutBar(); });

  // ── Image and file upload: the browser uploads to OSS and the link is typed into the terminal without Enter ──
  // The file input covers the upload button (Terminal.jsx), so a tap opens the picker natively, inside the user's own gesture: iOS WebKit (the Home Screen
  // web app above all) ignores a script click() on a hidden file input from another button's handler. The checks run on the input's click and cancel it.
  let pickedFor = null;
  picker.addEventListener('click', event => {
    if (uploading) { event.preventDefault(); return; }
    if (!connected(session)) { event.preventDefault(); tell('The original terminal is not connected. Reconnect and retry', 'error'); return; }
    pickedFor = session;
    picker.value = '';
  });
  // The image action from code (for example a hardware keyboard): the same input, through its click.
  function pickImage() { picker.click(); }
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
    ui.set({ upload: { status: 'Reading OSS settings…', progress: 0 } });
    return {
      status: text => ui.set(state => ({ upload: state.upload && { ...state.upload, status: text } })),
      progress: value => ui.set(state => ({ upload: state.upload && { ...state.upload, progress: value } })),
      unlock() { ui.set({ upload: null }); uploading = false; },
    };
  }

  // The image or file goes from this browser straight to OSS (oss-direct.js); the Client only signs the upload.
  const transfer = (file, ui2) => OssDirect.upload(file, {
    status: text => ui2.status(text),
    progress: value => ui2.progress(value),
  });

  // When the terminal went away during the upload, keep the link on screen so it is not lost.
  function retain(url) { ui.set({ retainUrl: url }); }
  ui.actions.retainClose = () => ui.set({ retainUrl: null });

  // ── Design document: DESIGN.md of the task's working directory, in a sheet from the bottom (scripts/h5-shell/Design.jsx) ──
  // Read through the task file API (`GET {tasksBase}/{task}/files/content?path=DESIGN.md`, local, Engine and remote proxy alike), which takes only paths
  // relative to the working directory and follows no symbolic links. Read only: nothing is written. Opening blurs the focused input first, so the on-screen
  // keyboard closes; the terminal keeps its size, so no resize reaches the PTY.
  let designSeq = 0;
  const taskDir = item => (item && (item.work_dir || (item.md_path ? item.md_path.replace(/\/[^/]*$/, '') : ''))) || '';
  // Opens one file of the task's working directory in the sheet: DESIGN.md from the row 2 button, any file from a terminal link (`link`: true, with the
  // line the link named). `filePath` is relative to the working directory. A folder is not listed on the phone; the sheet says so.
  // `terminal`: the id of a terminal whose own directory is not the task's: the file is read from that directory (`&terminal=` on the file API).
  // `forTask`: a task of this machine other than the shown one whose working directory holds the file (T-Attention's context files).
  // `absolute`: `filePath` is an absolute (or '~/...') path outside the working directory, read with the any-path read of the Engine `from`
  // (`GET {fs}/content?path=`; see openAnyFile).
  async function openFileSheet(filePath, { link = false, line = null, directory = false, terminal = null, terminalDir = null, forTask = null, absolute = false, from = source } = {}) {
    if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    const seq = ++designSeq;
    if (absolute) { await openAnyFile(seq, filePath, { link, line, directory, from }); return; }
    const current = forTask || task;
    const base = { open: true, path: filePath, link, line };
    if (!current) { ui.set({ design: { ...base, status: 'no-task' } }); return; }
    const dir = (terminal && terminalDir) || taskDir(current);
    if (directory) { ui.set({ design: { ...base, status: 'folder', dir } }); return; }
    const files = `${from.tasksBase}/${current.id}/files`;
    const scope = terminal ? `terminal=${encodeURIComponent(terminal)}&` : '';
    // An image or a PDF / audio / video file is not read as text: the sheet shows it from its address (see fileByUrl).
    const kind = link ? fileKind(filePath) : 'markdown'; // DESIGN.md from the Docs button is always Markdown
    if (kind === 'image' || isRawKind(kind)) {
      await fileByUrl(seq, { ...base, kind, dir }, from, `${files}/${kind === 'image' ? 'image' : 'raw'}?${scope}path=${encodeURIComponent(filePath)}`);
      return;
    }
    ui.set({ design: { ...base, kind, status: 'loading', dir } });
    try {
      const file = await api('GET', `${files}/content?${scope}path=${encodeURIComponent(filePath)}`);
      if (seq !== designSeq) return;
      // imageBase: relative images of a Markdown file are read through the same file API (`…/files/image?path=`, images only, at most 5 MB).
      ui.set({ design: { ...base, kind, status: 'ready', dir, content: String((file && file.content) || ''), imageBase: `${files}/image?${scope}path=` } });
    } catch (error) {
      if (seq !== designSeq) return;
      let code = error.message;
      // A folder named without a trailing slash: the content read refuses it; a listing tells a folder from a binary file.
      if (link && code === 'FILE_UNSUPPORTED') {
        try { await api('GET', `${files}?${scope}path=${encodeURIComponent(filePath)}&offset=0`); code = 'FOLDER'; } catch { /* not a folder */ }
        if (seq !== designSeq) return;
      }
      const status = code === 'FOLDER' ? 'folder' : code === 'FILE_NOT_FOUND' ? 'missing' : code === 'TASK_ROOT_UNAVAILABLE' ? 'no-dir' : 'error';
      ui.set({ design: { ...base, kind, status, dir, message: code } });
    }
  }
  // How the sheet reads a file (scripts/h5-shell/file-kinds.mjs, through the shell): markdown, json, csv, html and code are read as text
  // (`…/content`); an image through the image read (`…/image?path=`); pdf, audio and video as raw bytes (`…/raw?path=`, with Range, so a video seeks).
  const fileKind = filePath => (ui.fileKinds ? ui.fileKinds.kindOf(filePath) : 'code');
  const isRawKind = kind => Boolean(ui.fileKinds && ui.fileKinds.isRaw(kind));
  // The raw read needs 'files:raw': the local Client always has it, a remote Engine says so in its /info (read once here when not known yet).
  async function readsRaw(from) {
    if (from.key === 'local') return true;
    if (!Array.isArray(from.capabilities)) await readInfo(from).catch(() => { /* an older or offline Engine */ });
    return Array.isArray(from.capabilities) && from.capabilities.includes('files:raw');
  }
  // One byte of a raw file (Range: bytes=0-0), to know before the sheet shows it whether it can be read at all: an <iframe>, <audio> or <video>
  // cannot tell why it failed. The answer's body is not read (the request is cut off). null when it can be read, else the server's error code.
  async function probeRaw(url) {
    const controller = new AbortController();
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-0', 'X-Requested-With': 'XMLHttpRequest' }, signal: controller.signal });
      if (res.ok || res.status === 416) { controller.abort(); return null; } // 416: an empty file, which the viewer shows as empty
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* plain-text error */ }
      return (data && data.error) || `HTTP ${res.status}`;
    } catch {
      return 'NETWORK';
    }
  }
  // An image, PDF, audio or video file: `design.src` is its address. An image is shown at once (the sheet reads the error itself when it does not
  // load); a raw file waits for probeRaw. An Engine without 'files:raw' gets the note "This Engine cannot show this file type" (RAW_UNSUPPORTED).
  async function fileByUrl(seq, base, from, src) {
    if (base.kind === 'image') { ui.set({ design: { ...base, status: 'ready', src } }); return; }
    ui.set({ design: { ...base, status: 'loading' } });
    let code = (await readsRaw(from)) ? await probeRaw(src) : 'RAW_UNSUPPORTED';
    if (seq !== designSeq) return;
    if (code === 'RAW_UNSUPPORTED' && Array.isArray(from.capabilities)) from.capabilities = from.capabilities.filter(name => name !== 'files:raw');
    if (code === 'FS_READ_UNSUPPORTED') { anyPathUnsupported(from, base.path); return; }
    if (!code) { ui.set({ design: { ...base, status: 'ready', src } }); return; }
    if (code === 'HTTP 404') code = 'NOT_FOUND';
    const status = code === 'FILE_NOT_FOUND' || code === 'NOT_FOUND' ? 'missing' : code === 'IS_DIRECTORY' ? 'folder' : code === 'TASK_ROOT_UNAVAILABLE' ? 'no-dir' : 'error';
    ui.set({ design: { ...base, status, message: code } });
  }
  // The proxy says the remote Engine has no any-path read (an older Engine after all): forget the capability and say so, as before.
  function anyPathUnsupported(from, filePath) {
    if (Array.isArray(from.capabilities)) from.capabilities = from.capabilities.filter(name => name !== 'fs:read-any');
    ui.actions.closeDesign();
    tell(`Outside the working directory: ${filePath}`, 'error');
  }
  ui.actions.openDesign = () => openFileSheet('DESIGN.md');
  // A file outside the working directory (Engines with 'fs:read-any'): `GET {fs}/content?path=` (local `/api/fs`, remote `/api/remote-servers/:id/fs`),
  // read only, as the terminal user, regular files only. The sheet's title is the file name and its second line the full path (the Engine's normalized
  // `path`, so '~/x.md' shows where it is). Relative images of a Markdown file are read with `{fs}/image?path=` from the file's folder.
  async function openAnyFile(seq, filePath, { link, line, directory, from }) {
    const base = { open: true, path: filePath, link, line, absolute: true, dir: '' };
    if (directory) { ui.set({ design: { ...base, status: 'folder' } }); return; }
    const fs = fsBase(from);
    const kind = fileKind(filePath);
    if (kind === 'image' || isRawKind(kind)) {
      await fileByUrl(seq, { ...base, kind }, from, `${fs}/${kind === 'image' ? 'image' : 'raw'}?path=${encodeURIComponent(filePath)}`);
      return;
    }
    ui.set({ design: { ...base, kind, status: 'loading' } });
    try {
      const file = await api('GET', `${fs}/content?path=${encodeURIComponent(filePath)}`);
      if (seq !== designSeq) return;
      const shown = file && typeof file.path === 'string' && /^\/./.test(file.path) ? file.path : filePath;
      // Design.jsx resolves an image against the folder of `path` without its leading '/' and appends it encoded: the '/' goes in front here.
      const imageBase = `${fs}/image?path=${shown.startsWith('/') ? encodeURIComponent('/') : ''}`;
      ui.set({ design: { ...base, kind, path: shown, status: 'ready', content: String((file && file.content) || ''), imageBase } });
    } catch (error) {
      if (seq !== designSeq) return;
      const code = error.message;
      if (code === 'FS_READ_UNSUPPORTED') { anyPathUnsupported(from, filePath); return; }
      const status = code === 'IS_DIRECTORY' ? 'folder' : code === 'NOT_FOUND' ? 'missing' : 'error';
      ui.set({ design: { ...base, kind, status, message: code } });
    }
  }

  // ── File links in the terminal (public/js/terminal-file-links.js): a tap on a path inside the working directory opens it in the sheet above ──
  // The tap waits out the double-tap time first, so a double or triple tap on a path still selects the word or the line and opens nothing. A long press
  // (the copy view) or an open copy view also open nothing. Nothing is read from the server until the tap.
  let pendingLink = 0;
  function cancelPendingLink() { clearTimeout(pendingLink); pendingLink = 0; }
  function attachFileLinks(s) {
    if (typeof TerminalFileLinks === 'undefined') return;
    s.fileLinks = TerminalFileLinks.attach(s.term, {
      // Links resolve against the terminal's own directory (the task's when the Engine does not send one).
      root: () => s.workDir || taskDir(s.task) || null,
      // Relative paths come from the shell's live directory: its OSC 7 report, else the server reads it (an older Engine: the work dir).
      liveCwd: () => api('GET', `${s.source.tasksBase}/${s.task.id}/terminals/${encodeURIComponent(s.terminalId)}/cwd`).catch(() => null),
      // Paths outside it are links too when the Engine reads any path (the local Client; a remote Engine with 'fs:read-any', known after its /info).
      anyPath: () => readsAnyPath(s.source),
      activate: link => {
        cancelPendingLink();
        if (session !== s || s.disposed || longPressDone || ui.get().copyText !== null || s.gestures?.recentlyPanned()) return; // a pan is not a tap
        pendingLink = setTimeout(async () => {
          pendingLink = 0;
          if (session !== s || s.disposed || longPressDone || ui.get().copyText !== null) return;
          const target = await link.locate();
          if (session !== s || s.disposed) return;
          // Outside the working directory: an Engine that reads any path opens it; an older one cannot (the old note).
          if (target && target.absolute && readsAnyPath(s.source)) {
            void openFileSheet(target.absolute, { link: true, line: link.line, directory: link.directory, absolute: true, from: s.source });
            return;
          }
          const relative = target && target.relative != null ? target.relative : null;
          if (relative == null) { tell(`Outside the working directory: ${link.path}`, 'error'); return; }
          const elsewhere = s.workDir && s.workDir !== taskDir(s.task) ? s.terminalId : null;
          void openFileSheet(relative || '.', { link: true, line: link.line, directory: link.directory || !relative, terminal: elsewhere, terminalDir: s.workDir });
        }, MULTI_TAP_MS);
      },
    });
    if (s.source.key !== 'local' && !Array.isArray(s.source.capabilities)) readInfo(s.source).catch(() => { /* an older or offline Engine: the old rule */ });
  }
  ui.actions.closeDesign = () => { designSeq += 1; ui.set(state => ({ design: state.design ? { ...state.design, open: false } : null })); };

  // ── Files: the read-only tree of the task's working directory (scripts/h5-shell/FileTree.jsx), "Files" in row 2 ──
  // The tree reads folders itself through `base` (`GET {tasksBase}/{task}/files?path=`, local, Engine and remote proxy alike); a file opens in the sheet
  // above with `openFileSheet`. `key` names the tree: another task, working directory or Engine draws a new one (folders closed, scroll at the top).
  const filesFor = () => (task
    ? { key: `${source.key}:${task.id}:${taskDir(task)}`, base: `${source.tasksBase}/${task.id}/files`, dir: taskDir(task) }
    : { key: `${source.key}:`, base: null, dir: '' });
  function syncFiles() {
    const files = ui.get().files;
    if (!files) return;
    const next = filesFor();
    if (next.key !== files.key) ui.set({ files: { ...files, ...next } });
  }
  ui.actions.openFiles = () => {
    if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    const state = ui.get();
    const viewer = Boolean(state.design && state.design.open);
    // A file shown over the tree goes, so the tree is seen.
    if (viewer) ui.actions.closeDesign();
    const files = state.files && state.files.key === filesFor().key ? state.files : filesFor();
    ui.set({ files: { ...files, open: true } });
  };
  ui.actions.closeFiles = () => ui.set(state => ({ files: state.files ? { ...state.files, open: false } : null }));
  ui.actions.openTreeFile = filePath => openFileSheet(filePath, { link: true });
  // T-Attention (scripts/h5-shell/Attention.jsx): a file named by a task's context is an absolute path. It opens in the file sheet when it lies inside
  // the working directory of a task of this machine (the deepest one); the file API checks the path again (relative, no symbolic links).
  const localTaskFor = absolute => {
    if (typeof absolute !== 'string' || !absolute.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(absolute)) return null;
    let best = null;
    for (const item of LOCAL.tasks) {
      const dir = taskDir(item).replace(/\/+$/, '');
      if (dir && absolute.startsWith(`${dir}/`) && (!best || dir.length > best.dir.length)) best = { item, dir };
    }
    return best;
  };
  ui.actions.canOpenLocalPath = absolute => Boolean(localTaskFor(absolute));
  // The preview of any path for T-Attention: the central list belongs to this Client, so its files are read with the local Engine's any-path read
  // (`GET /api/fs/content`, read only, as the terminal user), whatever Engine the page shows. Attention.jsx calls it only for a context of this machine.
  ui.actions.openAnyPath = absolute => {
    if (typeof absolute !== 'string' || !(absolute.startsWith('/') || absolute === '~' || absolute.startsWith('~/'))) return false;
    void openFileSheet(absolute, { link: true, absolute: true, from: LOCAL });
    return true;
  };
  ui.actions.openLocalPath = absolute => {
    const found = localTaskFor(absolute);
    if (!found) return false;
    void openFileSheet(absolute.slice(found.dir.length + 1), { link: true, forTask: found.item, from: LOCAL });
    return true;
  };

  async function upload(target, file) {
    // The type and size limits (images 10 MiB, other files 100 MiB) are checked by OssDirect, which reads the first bytes.
    if (!file || file.size <= 0) { tell('The file is empty', 'error'); return; }
    const ui = lock();
    let result;
    let failure;
    try {
      let config;
      try { config = await api('GET', '/api/oss/config'); }
      catch { throw new Error('Could not read OSS settings. Check the connection and retry'); }
      // `shared_from`: not set up here, but a linked service signs the upload.
      if (!config || (!config.enabled && !config.shared_from)) throw new Error('Enable Alibaba Cloud OSS upload in this client’s settings first');
      result = await transfer(file, ui);
    } catch (error) { failure = error; } finally { ui.unlock(); }
    if (failure) { tell(failure.message, 'error'); return; }
    // xterm's paste keeps bracketed-paste semantics; a trailing space lets typing continue, and no Enter is sent.
    if (connected(target)) target.term.paste(`${result.url} `);
    else retain(result.url);
  }

  // ── A click on the notification that a chat's turn ended: the task is selected and the chat opens (the chat is shown at once when it is the open one). ──
  // Resolves to whether it went there. A chat of a remote Engine is not opened from here.
  async function openChatFromLink({ taskId, conversationId }) {
    if (!taskId) return false;
    if (agentChat && agentFor && agentFor.source === 'local' && agentFor.conversation === conversationId) { closeTasks(); return true; }
    const item = findTask(LOCAL, taskId);
    if (!item) return false;
    const rows = await chatApi.get(`${LOCAL.tasksBase}/${item.id}/agent/conversations`).catch(() => null);
    const row = Array.isArray(rows) ? rows.find(entry => entry.id === conversationId) : null;
    if (!row) return false;
    selectTask(LOCAL, item, { chat: row });
    return true;
  }
  if (typeof AgentChat !== 'undefined' && AgentChat.setOpenHandler) AgentChat.setOpenHandler(data => { if (!data.remote) void openChatFromLink(data); });
  // The same for the service worker that shows these notifications (the phone shows them only through it).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // The input mode can change while the page is open (a mouse or a touch screen attached): the terminal font, the layout measurements and the wake lock follow.
  let lastInput = ui.get().input;
  ui.subscribe(() => {
    const input = ui.get().input;
    if (input === lastInput) return;
    lastInput = input;
    if (session && !session.disposed) { session.term.options.fontSize = terminalFontSize(); refit(session); }
    fitViewport();
    autosize();
    void syncWakeLock();
  });

  // ── Start ──
  // How long the page waits for the service of the remembered task before it falls back to this machine (a slow or offline one must not hold the page).
  const REMEMBER_WAIT_MS = 5000;
  let markListsKnown = null;
  const listsKnown = new Promise(resolve => { markListsKnown = resolve; }); // the services and what is hidden are known
  // The multi-column view asks a pane to show a task and terminal, or an agent chat of a task (a `?openChat=` link handled by the top page while its columns
  // are shown; scripts/h5-shell/pane.mjs): a terminal as a tap on that row of the list does, on the named service; a chat as `openChatFromLink` does (this
  // machine only, like the link). An unknown service, task or chat is ignored quietly.
  if (PANE) {
    ui.actions.paneOpen = async ({ sourceKey, taskId, terminalId = null, conversationId = null }) => {
      await listsKnown;
      const from = sources.find(item => item.key === sourceKey && (item === LOCAL || item.label));
      if (!from) return false;
      if (from.status !== 'ready' || !findTask(from, taskId)) await loadSource(from);
      const item = from.status === 'ready' ? findTask(from, taskId) : null;
      if (!item) return false;
      if (conversationId && !terminalId) return from === LOCAL ? openChatFromLink({ taskId: item.id, conversationId }) : false;
      if (terminalId) ui.actions.openRow(taskRef(from, item.id), { kind: 'terminal', id: String(terminalId) });
      else if (isShown(from, item.id)) closeTasks();
      else selectTask(from, item);
      return true;
    };
  }
  (async () => {
    // The remembered service is assumed until the list of services says otherwise: its tasks are asked for at the same time as that list. Its object is put in
    // `sources` so that loadSources keeps it; without a name it is not listed yet.
    const remembered = /^remote:(\d+)$/.exec(store.get('source') || '');
    const assumed = remembered ? remoteSource(Number(remembered[1]), '') : LOCAL;
    if (remembered) sources = [LOCAL, assumed];
    // The page opened by a click on a notification: ?openChat=<task id>:<conversation id>.
    const link = /^(\d+):(.+)$/.exec(new URLSearchParams(location.search).get('openChat') || '');
    const savedId = Number(store.get(`task:${assumed.key}`));
    if (savedId > 0 && !link) {
      prefetch(`${assumed.tasksBase}/${savedId}/terminals`);
      if (assumed.key !== 'local') prefetch(infoUrl(assumed));
      const savedTerminal = store.get(`terminal:${assumed.key}:${savedId}`);
      if (savedTerminal) openEarlySocket(assumed, savedId, savedTerminal);
    }
    renderTasks(); // "Loading…"
    // A phone with nothing to bring back opens on the task sheet at once; that does not wait for the lists.
    if (!link && !(savedId > 0) && !isWide()) ui.set({ tasksOpen: true, wide: false });
    const reads = new Map([[LOCAL, loadSource(LOCAL)]]);
    if (assumed !== LOCAL) reads.set(assumed, loadSource(assumed));
    void loadLinks(); // the "⋯" of a task needs it, the list does not wait for it
    await Promise.all([loadSources(), loadHidden()]);
    listReady = true;
    markListsKnown();
    for (const from of listedSources()) if (!reads.has(from)) reads.set(from, loadSource(from));
    renderTasks();
    syncFeeds();
    if (link && await openChatFromLink({ taskId: Number(link[1]), conversationId: link[2] })) return;
    // The remembered service and task when it is listed and answers in time; else the remembered task of another listed service; else no task and the list.
    const listed = listedSources();
    const tried = [assumed, LOCAL, ...listed].filter((from, index, all) => listed.includes(from) && all.indexOf(from) === index);
    await Promise.race([Promise.all(tried.slice(0, 2).map(from => reads.get(from))), new Promise(resolve => setTimeout(resolve, REMEMBER_WAIT_MS))]);
    if (!task) { // nothing was opened by hand meanwhile
      const found = tried.map(from => ({ from, item: from.status === 'ready' ? findTask(from, Number(store.get(`task:${from.key}`))) : null })).find(entry => entry.item);
      if (!found || found.from !== assumed) dropEarlySocket(); // the remembered task is gone, hidden or offline
      if (found) selectTask(found.from, found.item, null, { remember: found.from === assumed });
    }
    // A wide screen always has the sidebar. A phone opens the sheet only when no task is shown, and not over Settings opened meanwhile.
    if (isWide() || (!task && !ui.get().settingsOpen)) openTasks();
  })();
})();
