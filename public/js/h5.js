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
  const terminalFontSize = () => (pointerMode() ? 13 : 12); // a phone: 12px (11px until the single-view redesign); no user setting
  const TERMINAL_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace';
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
  // Kept in this browser (docs/design/shared-page-state.md, "Key audit"): `source`, `task:<source>` and `terminal:<source>:<task>` say which session this
  // window opens at start (they decide the first requests before any answer, and the session last looked at anywhere is the top of the shared Recent
  // list), the terminal width (the screen's size) and its one-time hint (this device's gesture). The person's own choices are the shared page state's.
  // In a pane of the multi-column view (scripts/h5-shell/pane.mjs) what this view shows is kept per pane (`pane:<id>:h5-...`); the keys in SHARED_KEYS stay
  // one for the device. See "Pane mode" in docs/design/page-shell-and-columns.md for the list.
  const PANE = window.H5Pane || null;
  const SHARED_KEYS = new Set(['terminal-width-noted']);
  const storeKey = key => (PANE && !SHARED_KEYS.has(key) ? PANE.key(`h5-${key}`) : `h5-${key}`);
  // Through the registry of browser storage (public/js/local-keys.js), where each of these keys is declared with its reason.
  const LocalKeys = window.TALocalKeys || { get: () => null, set: () => false };
  const store = {
    get(key) { return LocalKeys.get(storeKey(key)); },
    set(key, value) { LocalKeys.set(storeKey(key), value == null ? null : value); },
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
  const socketUrl = (from, taskId, id, takeover) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${from.wsPath}?taskId=${taskId}&terminalId=${encodeURIComponent(id)}${TerminalOwner.query(takeover)}${TerminalProtocol.query()}${deviceQuery()}`;
  // The id of this browser for the access log ("Devices and sign-ins" in docs/design/page-files-and-settings.md); nothing without TALocalKeys.
  const deviceQuery = () => { try { const keys = window.TALocalKeys; const id = keys && typeof keys.deviceId === 'function' ? keys.deviceId() : ''; return id ? `&device=${encodeURIComponent(id)}` : ''; } catch { return ''; } };
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
  // `instanceId`: the device's own id (`instance_id` of /api/system/version for this machine, of its /api/remote-servers row for a service), which names its tasks in
  // the shared order (`<instance id>:<task id>`, see "Task order" below); null until known, and on an older Engine.
  const withList = from => Object.assign(from, { tasks: [], groups: DEFAULT_GROUPS, status: 'new', failure: '', loadSeq: 0, checkedAt: 0, instanceId: null });
  // `label` stays the "This machine" text the shell translates; `name` is this machine's engine name ('' until known, and on an older server; `readLocalName`).
  const LOCAL = withList({ key: 'local', label: 'This machine', name: '', tasksBase: '/api/tasks', groupsBase: '/api/task-groups', wsPath: '/terminal/ws', activityBase: '/api/tasks', mindmapBase: '/api/mindmaps' });
  const remoteSource = (id, name) => withList({
    key: `remote:${id}`, label: name,
    tasksBase: `/api/remote-servers/${id}/tasks`,
    groupsBase: `/api/remote-servers/${id}/task-groups`,
    wsPath: `/api/remote-servers/${id}/terminal/ws`,
    activityBase: `/api/remote-servers/${id}`, // {activityBase}/terminal-activity and /terminal-subagents
    mindmapBase: `/api/remote-servers/${id}/mindmaps`, // the mind map view lists and edits its maps there
  });
  let sources = [LOCAL];
  // The shared page state (public/js/page-state.js, docs/design/shared-page-state.md), and the devices of this page as it names them: { key,
  // instanceId } (it maps instance ids to source keys and back).
  const PageState = window.TAPageState || null;
  const pageSources = () => sources.filter(item => item === LOCAL || item.label).map(from => ({ key: from.key, instanceId: from.instanceId || null }));
  // The devices left out of the task list ("Show in task list" in Settings, `/api/task-list/hidden-devices`). Display only: a hidden device stays connected.
  const HIDDEN_URL = '/api/task-list/hidden-devices';
  let hiddenDevices = new Set();
  let hiddenSupported = false; // an older server has no such route: nothing is hidden and the switches do not appear
  let hiddenSeq = 0;
  let listReady = false; // both the services and what is hidden are known: until then the list says "Loading…", so a hidden device never flashes by
  let mindmap = null; // the open mind map view (see "Mind maps" below); here because publishSources tells it when the services change
  let mindmapSourcesSent = '';
  let mindmapTab = null; // the Mind maps tab of the multi-column view: { view, sent } (see "Mind maps" below)
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
      const before = Array.isArray(from.capabilities) ? from.capabilities.join('\n') : null;
      from.capabilities = Array.isArray(info && info.capabilities) ? info.capabilities : [];
      if (from.capabilities.join('\n') !== before && sources.includes(from)) publishSources(); // T-Attention reads an Engine that has 'attention:remote'
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
  // Sorting the sessions of a task ("Session order" below): the local Client always, a remote Engine with 'terminals:order'. An Engine that has not said
  // yet offers no sorting; one whose proxy answered TERMINAL_ORDER_UNSUPPORTED (an older Engine) loses the capability until its info is read again.
  const ordersTerminals = from => from.key === 'local' || Boolean(Array.isArray(from.capabilities) && from.capabilities.includes('terminals:order'));
  // The service of the task that is shown, set by selecting a task (this machine when none is shown). There is no switch: all the services are in one list.
  let source = LOCAL;
  let task = null;
  const isShown = (from, taskId) => from === source && Boolean(task) && String(task.id) === String(taskId);
  let terminals = [];
  let terminalsState = 'none'; // what `terminals` is for the selected task: 'loading', 'ready' or 'error'
  let terminalsSeq = 0; // the newest `loadTerminals`: an older one is ignored when it answers, also when the same task was selected again
  // The session order ("Session order" below). `dragging`: a session row is being dragged, and the list is not drawn again until the drop (`later`: it was
  // asked to be). `saves`: by task ref, the order last saved from here, { order, end }, `end` being the `clock` when the save settled (null while it runs);
  // `clock` counts the starts and the ends of the saves, so a list read can tell whether it started before one settled.
  const sessionOrder = { dragging: false, later: false, saves: new Map(), clock: 0 };
  let terminalId = null;
  const expanded = new Set(); // the refs (`taskRef`) of the tasks whose sessions are listed in the task sheet (a tap on a task opens and closes its list; it does not open the task); any number can be open
  const peeks = new Map(); // ref -> the sessions of an expanded task that is not the selected one: { source, taskId, status, terminals }
  // The recent sessions of the switcher and the last lines of terminals closed in this page (see "Recent sessions" below; here, before anything is shown).
  // The list is the shared page state's (public/js/page-state.js, docs/design/shared-page-state.md): the same on every device and engine.
  // `h5-recent-sessions` is the list this browser kept before that: sent once as an import, then removed (`importOldRecent`).
  const RECENT_STORE = 'recent-sessions';
  let recentList = [];
  const previews = new Map();
  let peekSeq = 0;
  const PEEK_WAIT_MS = 10000; // a list still on "Loading…" after this long says it could not be read (a late answer still replaces that)
  // The Restart and Delete requests on their way, by Engine and task (a promise that ends when all of them have). A list of that task read meanwhile would
  // show the old row, or connect to a terminal that is going away, so `loadTerminals` and `loadPeek` wait for it. Without one there is nothing to wait for.
  const actionsRunning = new Map();
  const actionsDone = (from, taskId) => actionsRunning.get(taskRef(from, taskId));
  // How many of them were ever started, by Engine and task: a list read while one started may be older than that action (`loadTerminals` reads it again).
  const actionStarts = new Map();
  const actionsStarted = (from, taskId) => actionStarts.get(taskRef(from, taskId)) || 0;
  function trackAction(target, pending) {
    const key = taskRef(target.from, target.taskId);
    actionStarts.set(key, (actionStarts.get(key) || 0) + 1);
    const all = Promise.all([actionsRunning.get(key), pending.catch(() => {})]).then(() => { if (actionsRunning.get(key) === all) actionsRunning.delete(key); });
    actionsRunning.set(key, all);
    return pending;
  }
  let wantedTerminal = null; // the terminal to show when the terminals of the task just selected arrive
  let terminalsLoaded = Promise.resolve(); // settles when the list of the task just selected has been read
  let session = null;
  // The shell notebook shown instead of a terminal ({ key, source, taskId, terminalId, view, status }), see `showNotebook`; null when none is.
  let notebook = null;
  let mods = {};
  let uploading = false;

  const terminalHost = $('h5-terminal');
  const translateForm = $('h5-translate');
  const translateInput = $('h5-translate-input');
  // The draft box's text follows its session across devices (public/js/continue-drafts.js, kept in the shared page state; "Drafts" in
  // docs/design/continue-and-drafts.md); wired below, after the box's own handlers ("Drafts that follow their session").
  const drafts = PageState && window.TAContinue ? window.TAContinue.createDrafts({ input: translateInput, store: PageState, setText: text => setDraftText(text), onNote: note => showDraftNote(note) }) : null;
  const bottomArea = $('h5-bottom'); // the function keys and the message bar; this box is what grows over the terminal
  const picker = $('h5-image-picker');
  const UPLOAD_MAX_FILES = 9; // files per pick or paste; more are refused before anything goes up

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
      if (ui.get().softKeyboard) ui.set({ softKeyboard: false });
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
    if (ui.get().softKeyboard !== keyboardOpen) ui.set({ softKeyboard: keyboardOpen }); // the phone's bottom navigation steps aside (BottomNav.jsx)
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
    if (notebook) fitNotebookView();
  }
  document.addEventListener('focusin', settleViewport);
  document.addEventListener('focusout', () => { focusLeftAt = performance.now(); settleViewport(); });
  window.addEventListener('pageshow', settleViewport);
  window.addEventListener('orientationchange', settleViewport);
  setInterval(() => { if (keyboardOpen && !pointerMode()) fitViewport(); }, 500);

  // ── Tasks ──
  // The list is built afresh on every drawing; `share` (scripts/h5-shell/store.mjs) keeps every row (and part of one) that did not change the same object,
  // so the shell draws again only the rows that changed, and nothing at all when the list is the same.
  const setTaskList = next => ui.set({ taskList: ui.share(ui.get().taskList, next) });
  function note(text) { setTaskList({ note: text, groups: [], tasks: [], sortable: false }); }
  // The task list the shell draws: a note (loading, an error, no tasks), or the tasks of every listed device in one flat list in the shared order (see
  // "Task order" below), each task with its device tag and the sessions listed under it when it is open. `groups` is this machine's own, for T-Attention's way back.
  // `sources` also tells T-Attention (attention-feed.mjs) which Engines to read: `listed` (in the task list: known and not hidden; false for all until the
  // services and what is hidden are known), `instanceId` (the colour of its tag) and `capabilities` (null until its `/info` was read; this machine: null).
  function publishSources() {
    const listed = listReady ? listedSources() : [];
    ui.set({
      sources: ui.share(ui.get().sources, sources.filter(item => item === LOCAL || item.label).map(item => ({
        key: item.key, label: item.label, name: item.name || '', offline: item.status === 'offline', hidden: hiddenDevices.has(item.key),
        listed: listed.includes(item), instanceId: item.instanceId || null, capabilities: item !== LOCAL && Array.isArray(item.capabilities) ? item.capabilities : null,
      }))),
      sourceKey: source.key,
      sourceLabel: task && source !== LOCAL ? source.label : '', // the header says which service the shown task is on when it is not this machine
    });
    if (PageState) PageState.setSources(pageSources()); // the shared page state names devices by instance id (public/js/page-state.js)
    syncMindmapSources();
  }

  // Reads the connected services. One that is still there keeps its object: requests in flight, sockets and warm terminals compare it.
  // This machine's own engine name comes with them (`engine_name` of /api/system/version; an older server has none, and the page says just "This machine").
  async function loadSources() {
    let servers;
    const version = api('GET', '/api/system/version').then(answer => answer, () => null);
    try { servers = await api('GET', '/api/remote-servers'); }
    catch { sources = sources.filter(item => item === LOCAL || item.label); await readLocalName(version); sources = inOrder(sources); publishSources(); return; } // this time only: what was known stays
    await readLocalName(version);
    const before = new Map(sources.map(item => [item.key, item]));
    sources = inOrder([LOCAL, ...(Array.isArray(servers) ? servers : []).filter(server => server.enabled !== false).map(server => {
      const kept = before.get(`remote:${server.id}`);
      const from = kept ? Object.assign(kept, { label: server.name }) : remoteSource(server.id, server.name);
      from.instanceId = instanceIdOf(server.instance_id);
      if (!kept && server.status === 'offline') from.status = 'offline'; // the first read of its tasks says for sure
      return from;
    })]);
    for (const from of before.values()) if (!sources.includes(from)) forgetSource(from);
    publishSources();
  }
  // The services in the one order of devices (device-order.mjs: by name, then instance id), this machine among them, so the page of every engine lists them
  // alike: the task list (new tasks before the shared order has them), "Create on", the mind maps and T-Attention ("Devices in one order" in
  // docs/design/entry-symmetry.md). An older server without its engine name is "This machine" here too.
  const sourceName = from => (from === LOCAL ? LOCAL.name || LOCAL.label : from.label);
  const byDevice = (list, describe) => (ui.orderDevices ? ui.orderDevices(list, describe) : list);
  const inOrder = list => byDevice(list, from => ({ name: sourceName(from), instanceId: from.instanceId, key: from.key }));
  // A failed read keeps the name (and the instance id) that was known.
  async function readLocalName(pending) {
    const answer = await pending;
    if (answer && typeof answer === 'object') {
      LOCAL.name = typeof answer.engine_name === 'string' ? answer.engine_name.trim() : '';
      LOCAL.instanceId = instanceIdOf(answer.instance_id);
    }
  }
  const instanceIdOf = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
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
      from.lastKnown = null;
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
      // A linked engine that did not answer in this page load: its tasks as this engine last read them (`last_known`, services/linked-last-tasks.js),
      // dimmed and not opened until it is back ("Tasks of an offline engine" in docs/design/failover-and-one-login.md).
      const last = error.data && error.data.last_known;
      if (!from.tasks.length && last && Array.isArray(last.tasks)) { from.tasks = last.tasks; from.lastKnown = last.at || true; }
      renderTasks();
      showActiveCount();
      publishSources();
      syncFeeds();
      return false;
    }
  }
  function loadTasks() { return Promise.all([...listedSources().map(from => loadSource(from)), loadOrder()]); }
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
  // The kind of the question a terminal waits at ('select' | 'accept', "Two waiting kinds" in docs/design/terminals.md), from a feed snapshot; null
  // when it does not wait at one (an older Engine sends no kinds: its waits are plain "needs you"). Such a terminal needs the person even while
  // its sub-agents run.
  const waitKind = (snap, taskId, id) => {
    const kind = ((snap.waiting_kind[taskId] || {})[id]) || null;
    return (kind === 'select' || kind === 'accept') && ((snap.activity[taskId] || {})[id]) === 'done' ? kind : null;
  };
  // The live state of a session row, from the pushed terminal activity of its service (the feed snapshot that also drives the Running and Needs you
  // filters): 'running' (also a running sub-agent), 'waiting' (at a question, or finished and not seen yet: it needs the person), 'idle', or null while
  // the service's activity is not known (hidden, offline, no feed yet). TaskDrawer.jsx shows it as the row's dot and status line, with `sessionKind`
  // naming the question; a change redraws only the rows it changes (`share`).
  function sessionState(from, taskId, id) {
    const snap = snapshotOf(from);
    if (!snap) return null;
    if (waitKind(snap, taskId, id)) return 'waiting';
    if (((snap.activity[taskId] || {})[id]) === 'running' || Number((snap.subagents[taskId] || {})[id]) > 0) return 'running';
    return ((snap.activity[taskId] || {})[id]) === 'done' ? 'waiting' : 'idle';
  }
  const sessionKind = (from, taskId, id) => { const snap = snapshotOf(from); return snap ? waitKind(snap, taskId, id) : null; };
  // The states of a task's terminals that are not idle, `{ <terminal id>: 'running' | 'waiting' | 'select' | 'accept' }` (the last two: waiting at that
  // kind of question), from the activity feed (null while none is known): T-Attention's session chip reads them for a task whose sessions are not
  // listed (a folded task; `sessionOf` in attention-model.mjs).
  function sessionStates(from, taskId) {
    const snap = snapshotOf(from);
    if (!snap) return null;
    const states = {};
    for (const id of new Set([...Object.keys(snap.activity[taskId] || {}), ...Object.keys(snap.subagents[taskId] || {})])) {
      const state = sessionState(from, taskId, id);
      if (state !== 'idle') states[id] = waitKind(snap, taskId, id) || state;
    }
    return states;
  }
  // A session row of the task list: a terminal, or a shell notebook whose second line says what its shell does ("Notebook · Running cell 3" while it is
  // shown here, from its view; "Notebook · Running" / "Notebook · Idle" from the activity feed otherwise: the feed knows only whether a cell runs).
  function sessionRow(from, item, row, current) {
    const status = sessionState(from, item.id, row.terminal_id);
    const entry = { kind: 'terminal', id: row.terminal_id, title: row.title, agent: row.agent || null, otherDir: otherDir(row, item), current, more: true, status, waiting: sessionKind(from, item.id, row.terminal_id) };
    if (row.agent !== 'notebook') return entry;
    const live = notebook && notebook.key === warmKey(from, item.id, row.terminal_id) && notebook.status ? notebook.status : null;
    const running = live ? live.running : status === 'running';
    return { ...entry, waiting: null, status: status === null && !live ? null : running ? 'running' : 'idle', line: live ? live.line : running ? 'Notebook · Running' : 'Notebook · Idle' };
  }
  // The sessions of the selected task: its terminals, each with "⋯" actions. Agent chats are not listed in the task sheet.
  function ownSessions() {
    return {
      label: 'Phone terminals', note: null, movable: ordersTerminals(source) && terminals.length > 1,
      rows: [
        ...terminals.map(row => sessionRow(source, task, row, row.terminal_id === terminalId && !agentChat)), // no row is current while a chat covers the terminal
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
      ...peek.terminals.map(row => sessionRow(from, item, row, false)),
    ];
    if (!rows.length) rows.push({ kind: 'open', id: 'open', title: tr('Open this task'), agent: null, current: false, more: false });
    return { label, note: null, rows, movable: ordersTerminals(from) && peek.terminals.length > 1 };
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
    // An offline service's rows are dimmed; the ones only known from what this engine last read (`lastKnown`) cannot be opened or changed.
    const offline = from.status === 'offline';
    if (offline && from.lastKnown) return { id: item.id, ref, title: item.title, selected: false, expanded: false, add: false, offline, stale: true, count: null, sessions: null };
    return {
      id: item.id, ref, title: item.title, selected, expanded: open, add: true, offline, ...activeIn(from, item.id), sessionStates: sessionStates(from, item.id),
      count: open ? (selected ? (hasSessions ? terminals.length : null) : (peek && peek.status === 'ready' ? peek.terminals.length : null)) : null,
      sessions: open ? (selected ? ownList : peekSessions(from, item)) : null,
    };
  }
  const sectionGroups = from => groupedTasks(from).map(({ group, members }) => ({ key: group.key, name: group.name, tasks: members.map(item => taskRow(from, item)) }));

  // ── Task order: one flat list in the order every client shares (`GET` / `PUT /api/task-order`; rules in scripts/h5-shell/task-order.mjs) ──
  // The list has no section per device and no group headers (it never showed group titles): every task of the listed devices, in the shared order. A task
  // is named in it by `<instance id>:<task id>`. The tasks not in the order (new, restored) come first, each device in its own order (groups by `sort_order`,
  // then its list), the devices by name (`inOrder`); the tasks of a device without an instance id (an older Engine) come last and cannot be moved. The keys in the order
  // that match no task shown here (a hidden or offline device, a task not visible here) are kept in their places when a new order is saved.
  // An older server answers 404: then the list keeps today's order (each device after the other) and offers no sorting.
  const ORDER_URL = '/api/task-order';
  const ORDER_POLL_MS = 30000; // while the list is shown and the page visible; in a pane of the multi-column view every read is at most this often
  // `known`: an order was read (sorting is offered only then: a save is the whole order, and one made without it would drop the keys of other devices).
  // `seq`: raised by each move, so a read that was on its way meanwhile is dropped. `deferred`: an answer that came during a drag, applied when it ends.
  const taskOrder = { supported: false, known: false, order: [], updatedAt: null, seq: 0, saving: 0, readAt: 0, pending: null, dragging: false, deferred: null };
  const sortable = () => taskOrder.supported && taskOrder.known;
  const orderKey = (from, item) => (from.instanceId ? `${from.instanceId}:${item.id}` : null);
  // Every task of the list, in list order: { from, item, key }. An offline device keeps the tasks it had, where they were.
  function orderedTasks() {
    const rows = listedSources().flatMap(from => groupedTasks(from).flatMap(entry => entry.members).map(item => ({ from, item, key: orderKey(from, item) })));
    return ui.taskOrder.arrangeTasks(rows, taskOrder.known ? taskOrder.order : null);
  }
  const shownKeys = () => orderedTasks().filter(row => row.key).map(row => row.key);
  function applyOrder(answer) {
    taskOrder.order = answer.order.filter(key => typeof key === 'string');
    taskOrder.updatedAt = answer.updated_at === undefined ? null : answer.updated_at;
    renderTasks();
  }
  // Reads the shared order: when the list is loaded or refreshed, when the page is shown again, and every ORDER_POLL_MS while the list is open. A newer one
  // is applied at once, also under an open menu (its actions look at the order when they run); during a drag it waits for the drop.
  function loadOrder() {
    if (taskOrder.pending) return taskOrder.pending;
    if (PANE && taskOrder.readAt && Date.now() - taskOrder.readAt < ORDER_POLL_MS) return Promise.resolve();
    const seq = taskOrder.seq;
    taskOrder.readAt = Date.now();
    const pending = taskOrder.pending = (async () => {
      let answer;
      try { answer = await api('GET', ORDER_URL); }
      catch (error) {
        if (error.status === 404 && seq === taskOrder.seq && (taskOrder.supported || taskOrder.known)) { // the server went back to an older version
          Object.assign(taskOrder, { supported: false, known: false, order: [], updatedAt: null });
          renderTasks();
        }
        return; // any other failure keeps what was known
      }
      if (seq !== taskOrder.seq || taskOrder.saving || !answer || !Array.isArray(answer.order)) return; // a move made meanwhile is newer
      const first = !taskOrder.known;
      taskOrder.supported = true;
      taskOrder.known = true;
      if (!first && answer.updated_at === taskOrder.updatedAt && ui.taskOrder.sameOrder(answer.order, taskOrder.order)) return;
      if (taskOrder.dragging) { taskOrder.deferred = answer; return; }
      applyOrder(answer);
    })().finally(() => { if (taskOrder.pending === pending) taskOrder.pending = null; });
    return pending;
  }
  // A remote row can answer `instance_id: null` for about a minute after the page loads (the server fills it from the Engine's /v1/info in the background), and
  // an older Engine never has one. While a listed service has none, its rows are read again every ID_RETRY_MS for ID_RETRY_FOR_MS; its tasks are placed by
  // the fallback rule (after the others, not movable) until it is known.
  const ID_RETRY_MS = 15000;
  const ID_RETRY_FOR_MS = 180000;
  const startedAt = Date.now();
  const missingIds = () => listedSources().some(from => from !== LOCAL && !from.instanceId);
  setInterval(async () => {
    if (!listReady || document.visibilityState !== 'visible' || Date.now() - startedAt > ID_RETRY_FOR_MS || !missingIds()) return;
    const before = sources.map(from => from.instanceId).join('\n');
    await loadSources();
    if (sources.map(from => from.instanceId).join('\n') !== before) renderTasks();
  }, ID_RETRY_MS);
  const orderShown = () => listReady && document.visibilityState === 'visible' && !columnsShown() && (isWide() ? !ui.get().sidebarCollapsed : Boolean(ui.get().tasksOpen));
  setInterval(() => { if (orderShown()) void loadOrder(); }, ORDER_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && listReady) void loadOrder(); });
  // Saves the whole new order once (the keys this page does not show stay in their places; the server also keeps any key a PUT leaves out, and its answer
  // is the new truth). The list moves at once; when the save fails it moves back and says so.
  async function saveOrder(order) {
    const before = { order: taskOrder.order, updated_at: taskOrder.updatedAt };
    const seq = (taskOrder.seq += 1);
    taskOrder.order = order;
    taskOrder.saving += 1;
    renderTasks();
    try {
      const answer = await api('PUT', ORDER_URL, { order });
      if (seq === taskOrder.seq && answer && Array.isArray(answer.order)) applyOrder(answer);
    } catch (error) {
      if (seq === taskOrder.seq) applyOrder(before);
      tell(`Could not save the task order: ${error.message}`, 'error');
    } finally { taskOrder.saving -= 1; }
  }
  // Moves the task `ref` before the task `target` (or after it, with `after`). From a drop of a drag (TaskDrawer.jsx) and the task menu.
  function reorderTask(ref, target, after = false) {
    if (!sortable()) return;
    const rows = orderedTasks();
    const keyOf = wanted => { const row = rows.find(entry => taskRef(entry.from, entry.item.id) === wanted); return row ? row.key : null; };
    const key = keyOf(ref);
    const to = keyOf(target);
    if (!key || !to) return;
    const display = rows.filter(row => row.key).map(row => row.key);
    const next = ui.taskOrder.moveKey(display, key, to, after);
    if (next) void saveOrder(ui.taskOrder.mergeOrder(taskOrder.order, display, next));
  }
  // A drag in the list (TaskDrawer.jsx): while it runs, an order read meanwhile waits, so the rows do not move under the finger; it is applied before the drop.
  function endDrag() {
    taskOrder.dragging = false;
    const answer = taskOrder.deferred;
    taskOrder.deferred = null;
    if (answer) applyOrder(answer);
  }
  ui.actions.taskDragging = on => { if (on) taskOrder.dragging = true; else endDrag(); };
  ui.actions.reorderTask = (ref, target, after = false) => { endDrag(); reorderTask(ref, target, after); };

  // ── Session order: the terminals of a task in the order the person put them (a held row is dragged in TaskDrawer.jsx; "Move up" / "Move down" in its "⋯") ──
  // The server keeps the order of each task (`PUT {tasksBase}/:id/terminals/order` with the whole order; `GET …/terminals` answers in it, new terminals
  // last), so every client lists the same order on its next read; nothing is pushed. A move here shows at once (the rows slide) and saves the task's whole
  // order. A list read that started before a save settled may be older than it, so it is put in the saved order (`inSavedOrder`). A failed save moves the
  // rows back and says so. Everything that lists the selected task's terminals (the task sheet, the next running or pending session) reads `terminals` in
  // its order; nothing sorts it.
  // The rows in the order of `ids` (terminal ids); rows that `ids` does not name keep their order after them.
  function arrangeRows(rows, ids) {
    const place = new Map(ids.map((id, index) => [id, index]));
    const at = row => (place.has(row.terminal_id) ? place.get(row.terminal_id) : Infinity);
    return rows.map((row, index) => ({ row, index })).sort((a, b) => at(a.row) - at(b.row) || a.index - b.index).map(entry => entry.row);
  }
  const sameRows = (a, b) => a.length === b.length && a.every((row, index) => row === b[index]);
  function inSavedOrder(ref, rows, asked) {
    const saved = sessionOrder.saves.get(ref);
    if (!saved || !Array.isArray(rows) || (saved.end !== null && asked >= saved.end)) return rows;
    return arrangeRows(rows, saved.order);
  }
  // The terminals listed under a task: `terminals` for the selected one, its peek for another (null while they are not read).
  function sessionRows(from, item) {
    if (isShown(from, item.id)) return terminalsState === 'ready' ? terminals : null;
    const peek = peeks.get(taskRef(from, item.id));
    return peek && peek.status === 'ready' ? peek.terminals : null;
  }
  function putSessionRows(from, item, rows) {
    if (isShown(from, item.id)) terminals = rows;
    else { const peek = peeks.get(taskRef(from, item.id)); if (peek) peek.terminals = rows; }
  }
  // Puts the sessions of the task `ref` in the order `ids` and saves it. False when nothing changed.
  function reorderSessions(ref, ids) {
    const hit = resolveRef(ref);
    if (!hit || !ordersTerminals(hit.from)) return false;
    const { from, item } = hit;
    const rows = sessionRows(from, item);
    if (!rows) return false;
    const next = arrangeRows(rows, ids);
    if (sameRows(next, rows)) return false;
    putSessionRows(from, item, next);
    renderTasks();
    void saveSessionOrder(from, item, next.map(row => row.terminal_id), rows.map(row => row.terminal_id));
    return true;
  }
  async function saveSessionOrder(from, item, order, before) {
    const ref = taskRef(from, item.id);
    const mine = { order, end: null };
    sessionOrder.clock += 1;
    sessionOrder.saves.set(ref, mine);
    try {
      const answer = await api('PUT', `${from.tasksBase}/${item.id}/terminals/order`, { order });
      if (sessionOrder.saves.get(ref) !== mine) return; // a newer move is on its way
      if (answer && Array.isArray(answer.order)) mine.order = answer.order.filter(id => typeof id === 'string');
      mine.end = (sessionOrder.clock += 1);
      const rows = sessionRows(from, item);
      const next = rows && arrangeRows(rows, mine.order);
      if (next && !sameRows(next, rows)) { putSessionRows(from, item, next); renderTasks(); }
    } catch (error) {
      if (error.message === 'TERMINAL_ORDER_UNSUPPORTED' && Array.isArray(from.capabilities)) from.capabilities = from.capabilities.filter(name => name !== 'terminals:order');
      if (sessionOrder.saves.get(ref) === mine) {
        sessionOrder.saves.delete(ref);
        const rows = sessionRows(from, item);
        if (rows) putSessionRows(from, item, arrangeRows(rows, before));
      }
      renderTasks();
      tell(`Could not save the session order: ${error.message}`, 'error');
    }
  }
  // The live region of the task list (TaskDrawer.jsx) says where a session went.
  const sayOrder = text => { const node = document.getElementById('h5-task-order-live'); if (node) node.textContent = text; };
  // "Move up" / "Move down" in the "⋯" of a session row (`openTerminalMenu`, `openOtherMenu`): each only where the row can go that way.
  function sessionSteps(from, item, id) {
    const rows = ordersTerminals(from) ? sessionRows(from, item) : null;
    const at = rows ? rows.findIndex(row => row.terminal_id === id) : -1;
    if (at < 0 || rows.length < 2) return [];
    const move = by => {
      closeTerminalMenu();
      const ids = (sessionRows(from, item) || []).map(row => row.terminal_id);
      const index = ids.indexOf(id);
      const to = index + by;
      if (index < 0 || to < 0 || to >= ids.length) return;
      ids.splice(index, 1);
      ids.splice(to, 0, id);
      if (reorderSessions(taskRef(from, item.id), ids)) sayOrder(tr(`Moved to position ${to + 1} of ${ids.length}`));
    };
    return [...(at > 0 ? [['Move up', () => move(-1)]] : []), ...(at < rows.length - 1 ? [['Move down', () => move(1)]] : [])];
  }
  // A drag of a session row (TaskDrawer.jsx): while it runs the list is not drawn again (a terminal list read meanwhile is kept and shown at the drop), so
  // the rows do not move under the finger. The drop puts the task's sessions in the order shown.
  ui.actions.sessionDragging = on => {
    sessionOrder.dragging = Boolean(on);
    if (!on && sessionOrder.later) { sessionOrder.later = false; renderTasks(); }
  };
  ui.actions.reorderSessions = (ref, ids) => {
    const later = sessionOrder.later;
    Object.assign(sessionOrder, { dragging: false, later: false });
    if (!reorderSessions(ref, ids) && later) renderTasks(); // one drawing for the drop and what came meanwhile
  };
  // The engine tag at the left edge of a task row (TaskDrawer.jsx draws it): shown whenever the order can be changed (it is the drag grip) or more than
  // one device is listed. Only an older server (no sorting) with this machine alone has no tags.
  const deviceTag = from => ({ key: from.key, local: from === LOCAL, label: from.label, name: from.name || '', instanceId: from.instanceId, offline: from.status === 'offline' });

  function renderTasks() {
    if (sessionOrder.dragging) { sessionOrder.later = true; return; } // a session row is being dragged: the list is drawn again at the drop
    showArchived(); // first: the entry is there with an empty list too, and `readInfo` of an expanded list may just have changed what the Engine can do
    if (!listReady) { note('Loading…'); return; }
    const listed = listedSources();
    if (listed.length === 1 && listed[0] === LOCAL) { // this machine alone: it says so when the list is empty
      const message = LOCAL.status === 'new' ? 'Loading…'
        : LOCAL.status === 'offline' ? `Could not load tasks: ${LOCAL.failure}`
          : LOCAL.tasks.length ? null : 'No tasks yet. Create one above';
      if (message) { note(message); return; }
    }
    const canSort = sortable();
    const tagged = listed.length > 1 || canSort;
    const tasks = orderedTasks().map(({ from, item, key }) => ({
      ...taskRow(from, item), source: from.key, movable: canSort && Boolean(key), device: tagged ? deviceTag(from) : null, unplaced: canSort && !key,
    }));
    if (!tasks.length) {
      note(listed.some(from => from.status === 'new') ? 'Loading…' : listed.includes(LOCAL) && LOCAL.status === 'offline' ? `Could not load tasks: ${LOCAL.failure}` : 'No tasks yet. Create one above');
      return;
    }
    // `groups`: this machine's tasks by group, for T-Attention's way back. `offline`: the names of the listed services that are offline and still have
    // rows in the list (one info line each above the list).
    const offline = listed.filter(from => from !== LOCAL && from.status === 'offline' && from.tasks.length).map(sourceName);
    setTaskList({ note: null, groups: listed.includes(LOCAL) ? sectionGroups(LOCAL) : [], tasks, sortable: canSort, offline });
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

  // from, item: the task and its service (`item` null: no task is shown). target: where to go in the task, { terminal: id } or { chat: row } (a chat link, see
  // `openChatFromLink`); without one, the task opens on its terminal. `target.known`: the terminals of that task just read elsewhere (the next-session button), used like
  // the list already shown under its row (see `loadTerminals`). stay: the task sheet of a phone stays open (the "+" of a task that was not selected opens the New session
  // dialog over the sheet). remember: false for a fallback at page load, so the service that was remembered is tried again on the next one.
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
    // What is already listed under its row (a task that was expanded, or selected before) is carried over to `terminals`, so its sessions and count stay on screen.
    const peek = item ? peeks.get(ref) : null;
    const known = target && Array.isArray(target.known) ? target.known : peek && peek.status === 'ready' ? peek.terminals : null;
    if (item) { peeks.delete(ref); expanded.add(ref); } // the other open lists stay open
    // The New session dialog acts on the selected task, so it cannot stay open for another one (the "+" of a task lands here too, and then opens its own).
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
    terminalsLoaded = loadTerminals(known);
    if (target && target.chat) mountAgent(target.chat);
  }

  // Opens or closes the list of sessions under a task, without going anywhere.
  function toggleTask(from, item) {
    if (from.status === 'offline' && from.lastKnown) return; // only known from what this engine last read: nothing to open until it is back
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
    const asked = sessionOrder.clock;
    const [rows] = await Promise.all([
      api('GET', `${from.tasksBase}/${item.id}/terminals`).catch(error => { if (error.status === 404) void recheckSource(from); return null; }),
      // What the Engine can do decides the actions of these rows (`controlsTerminals`). An Engine that does not answer must not hold the list back.
      from.key === 'local' ? null : Promise.race([readInfo(from).catch(() => null), new Promise(resolve => setTimeout(resolve, PEEK_WAIT_MS))]),
    ]);
    clearTimeout(noAnswer);
    if (!expanded.has(ref) || isShown(from, item.id) || (peeks.get(ref) && peeks.get(ref).seq > mine.seq)) return; // the selected task is listed from `terminals`
    peeks.set(ref, mine);
    mine.status = Array.isArray(rows) ? 'ready' : 'error';
    mine.terminals = Array.isArray(rows) ? inSavedOrder(ref, rows, asked) : [];
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
    // The rename field and the popup of a row are drawn inside the sheet or point into it: they go with it. The New session dialog lies over the page and stays.
    const menu = ui.get().menu;
    if (menu && (menu.rename || menu.anchor)) closeTerminalMenu();
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
    if (notebook) fitNotebookView();
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
  // The settings themselves are the shell's (scripts/h5-shell/Settings.jsx). `group` (optional) opens one group of the sheet and shows one part of it:
  // a group id (devices, voice-translate, ...), a part id (remote, rule-sync, ...) or a group id from before the sheet was tidied up (engines, translate,
  // access, ...); see scripts/h5-shell/settings-target.mjs. Without it the sheet opens with every group folded.
  let settingsSeq = 0;
  ui.actions.openSettings = group => ui.set({ settingsOpen: true, settingsTarget: typeof group === 'string' && group ? { id: group, seq: ++settingsSeq } : null });
  ui.actions.closeSettings = () => ui.set({ settingsOpen: false, settingsTarget: null });
  // The Learn page (scripts/h5-shell/Learn.jsx, a destination of the rail and the bottom navigation; "The Learn page" in docs/design/learn-english-page.md).
  // `view` 'chat' opens it on the English coach (the link /h5?learn=coach of the coach's reminder; "Which chat opens" in docs/design/learn-english-coach-page.md).
  let learnSeq = 0;
  const LEARN_VIEWS = /^(?:chat|coach|mistakes|reports|progress|material|settings|how|review|practice|spell|dictation|fill|say)$/;
  // `view`: a Learn view to open with it (learn-coach.mjs `screenView`: chat, coach, mistakes, reports, progress, material, settings, how, review,
  // practice, spell, dictation, fill, say); Learn opens it once and clears learnTarget.
  ui.actions.openLearn = view => ui.set({ learnOpen: true, ...(typeof view === 'string' && LEARN_VIEWS.test(view) ? { learnTarget: { view, seq: ++learnSeq } } : {}) });
  ui.actions.closeLearn = () => ui.set({ learnOpen: false });
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
    // `row.known`: the terminals of that task, when the caller has just read them (the next-session button).
    if (row.kind === 'terminal') selectTask(from, item, { terminal: row.id, known: row.known });
    else selectTask(from, item);
  };
  // ── Next running or pending session (row 2, `#h5-cycle`) ──
  // Goes to the next terminal session of any service in the list, in task sheet order (the tasks in the shared list order, then the terminals of each task), that is running or pending acceptance,
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
      const rows = Array.isArray(lists[index]) ? lists[index] : [];
      for (const row of rows) {
        const state = stateOf(item.id, row.terminal_id);
        if (state) out.push({ from, taskId: item.id, terminalId: row.terminal_id, state, rows });
      }
    });
    return out;
  }
  async function activeSessions() {
    const answers = await Promise.all(listedSources().filter(from => from.status !== 'offline').map(from => activeOf(from).then(list => ({ list }), error => ({ error }))));
    if (answers.length && answers.every(answer => answer.error)) throw answers[0].error;
    // In list order (the shared order across devices); the terminals of one task stay in their order (a stable sort).
    const place = new Map(orderedTasks().map((row, index) => [taskRef(row.from, row.item.id), index]));
    const at = entry => { const index = place.get(taskRef(entry.from, entry.taskId)); return index === undefined ? Infinity : index; };
    return answers.flatMap(answer => answer.list || []).sort((a, b) => at(a) - at(b));
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
      // The same path as a tap in the task sheet. The list of that task was just read, so its terminal is shown at once (a copy: `terminals` is changed in place).
      ui.actions.openRow(taskRef(next.from, next.taskId), { kind: 'terminal', id: next.terminalId, known: next.rows.map(row => ({ ...row })) });
    } catch (error) {
      tell(`Could not read the session states: ${error.message}`, 'error');
    } finally { cycling = false; }
  };
  // ── Recent sessions: the session switcher (`#h5-cycle`, Switcher.jsx; "Session switcher" in docs/design/session-switcher.md) ──
  // The terminal sessions this page showed, most recently shown first (scripts/h5-shell/recent-sessions.mjs, through `ui.recent`), noted whenever the
  // shown terminal changes by any path (`noteShown`, from `renderSessionName`) and kept in the shared page state, the same on every device and engine. `state.recent` is the list without the
  // sessions that are gone (their task left the list, or the terminal is not among the task's known terminals). A pane keeps none: the switcher is
  // the single view's. The cards' preview lines cost no request: a warm terminal gives its buffer's last lines, one closed earlier in this page what
  // it showed then (`previews`, kept in memory only), any other none (the card shows its state instead).
  const PREVIEW_LINES = 40;
  let switcherSeq = 0;
  function knownTerminals() {
    const out = {};
    if (task && terminalsState === 'ready') out[taskRef(source, task.id)] = terminals.map(row => String(row.terminal_id));
    for (const [ref, peek] of peeks) if (peek.status === 'ready') out[ref] = peek.terminals.map(row => String(row.terminal_id));
    return out;
  }
  const sharedEntry = entry => (PageState ? PageState.toShared(entry, pageSources()) : null);
  // `listChanged`: called because the task list was drawn again, so it matches what the devices answered (only then is anything forgotten).
  function publishRecent(listChanged = false) {
    if (PANE) return;
    if (PageState) recentList = PageState.recentForPage(PageState.recent(), pageSources());
    const list = ui.get().taskList;
    const shown = listReady && list && Array.isArray(list.tasks) ? ui.recent.prune(recentList, list.tasks, knownTerminals()) : [];
    // A session that is gone for sure leaves the shared list (a tombstone, so every device forgets it): its task is listed here with its sessions
    // known and it is not among them, or it is a task of this machine that left the list (once that list answered, while it is listed). A task of
    // another engine that is not in the list is only left out here: this page may not see all its tasks (per-task visibility).
    if (PageState && listChanged && shown !== recentList && listReady && list && Array.isArray(list.tasks)) {
      const kept = new Set(shown.map(ui.recent.key));
      const known = knownTerminals();
      const listed = new Set(list.tasks.map(row => `${row.source}|${row.id}`));
      const ownGone = LOCAL.status === 'ready' && listedSources().includes(LOCAL);
      const gone = recentList.filter(entry => {
        const ref = `${entry.sourceKey}|${entry.taskId}`;
        if (kept.has(ui.recent.key(entry))) return false;
        return (listed.has(ref) && Array.isArray(known[ref])) || (entry.sourceKey === LOCAL.key && ownGone);
      }).map(sharedEntry).filter(Boolean);
      if (gone.length) PageState.noteRecent(gone.map(entry => ({ ...entry, gone: true }))); // it publishes again (the list without them)
    }
    ui.set({ recent: ui.share(ui.get().recent, shown) });
    if (!hintDone) maybeHint();
  }
  // The entries that differ between two lists of this page go to the shared page state (the new top, the one left with its time, a new name).
  function sendRecent(before, next) {
    if (!PageState) return;
    const old = new Map(before.map(entry => [ui.recent.key(entry), entry]));
    const changed = next.filter(entry => { const was = old.get(ui.recent.key(entry)); return !was || was.title !== entry.title || was.agent !== entry.agent || was.lastUsed !== entry.lastUsed; });
    PageState.noteRecent(changed.map(sharedEntry).filter(Boolean));
  }
  // The list this browser kept before the shared page state, sent once (its order kept: an entry without a time gets a small one), then removed.
  function importOldRecent() {
    if (PANE || !PageState) return;
    const old = ui.recent.parse(store.get(RECENT_STORE));
    if (old.length) PageState.importRecent(old.map((entry, index) => sharedEntry({ ...entry, lastUsed: entry.lastUsed || old.length - index })).filter(Boolean));
    store.set(RECENT_STORE, null);
  }
  if (PageState && !PANE) PageState.subscribe(what => { if (!what || what.includes('recent') || what.includes('sources')) publishRecent(); });
  let recentTaskList = null;
  ui.subscribe(() => { const list = ui.get().taskList; if (list !== recentTaskList) { recentTaskList = list; publishRecent(true); } });
  let recentShownKey = null; // the entry this page showed last: when it is still the first, leaving it stamps the time it was last used (`leave`)
  let notedHere = new Map(); // the sessions this page came to since it opened (or came back), with their entry before that: the "Continue" hint reads those
  function noteShown(target, row) {
    // Only a terminal of the task's list: while another task's list loads, the terminal id is still the one left (not a session of this task).
    if (!target || !row) return;
    if (PANE) { noteColumn(target); return; }
    const before = recentList[0];
    const same = before && ui.recent.key(before) === ui.recent.key(target);
    const leave = Boolean(before) && ui.recent.key(before) === recentShownKey; // first because another device showed it: not stamped from here
    // Where it was seen (the "Continue" hint of another device): this device when it just came to this session; else what the entry says.
    const fresh = recentShownKey !== ui.recent.key(target);
    if (fresh && !notedHere.has(ui.recent.key(target))) notedHere.set(ui.recent.key(target), recentList.find(entry => ui.recent.key(entry) === ui.recent.key(target)) || null);
    const seen = drafts && (fresh || !same) ? { client: drafts.kind, device: drafts.device } : same ? { client: before.client, device: before.device } : {};
    const next = ui.recent.note(recentList, { ...target, title: row ? row.title || '' : same ? before.title : '', agent: row ? row.agent || null : same ? before.agent : null, ...seen }, undefined, { now: Date.now(), leave });
    recentShownKey = ui.recent.key(target);
    if (!same && ui.get().switcher) ui.actions.closeSwitcher(); // shown another way (the task list, T-Attention): the switcher is out of date
    if (next === recentList) return;
    const was = recentList;
    recentList = next;
    sendRecent(was, next);
    publishRecent();
  }
  // ── The "Continue <session>" hint ("The continue hint" in docs/design/continue-and-drafts.md) ──
  // Once on entry (and when the page comes back after 5 minutes or more hidden), after the task list and a fresh shared state are known: when the
  // session last looked at anywhere (the shared Recent list past what this page itself came to) is another one than this device shows, was looked at
  // on another device in the last 12 hours and still exists, a notice offers it ("Open"). It never switches by itself and goes after 10 s.
  let hintDone = Boolean(PANE) || !drafts;
  let hintFresh = Boolean(PageState && PageState.answered && PageState.answered()); // a state read or pushed since the page opened (or came back), not only the cache
  const HINT_START = Date.now();
  function maybeHint() {
    if (hintDone || !listReady || !hintFresh || columnsShown()) return;
    const shown = ui.get().shownTarget || null;
    if (!shown && Date.now() - HINT_START < 4000) { setTimeout(maybeHint, 4100 - (Date.now() - HINT_START)); return; } // let the page open its own first
    hintDone = true;
    // The session last looked at anywhere before this page came: an entry this page noted since counts as it was before.
    let top = null;
    for (const entry of PageState.recentForPage(PageState.recent(), pageSources(), 24)) {
      const before = notedHere.has(ui.recent.key(entry)) ? notedHere.get(ui.recent.key(entry)) : entry;
      if (before && (!top || (Number(before.lastUsed) || 0) > (Number(top.lastUsed) || 0))) top = before;
    }
    const listed = Boolean(top) && ui.get().recent.some(entry => ui.recent.key(entry) === ui.recent.key(top));
    const now = Date.now();
    const hint = window.TAContinue.hintFor({ top, listed, shown, device: drafts.device, now });
    if (!hint) return;
    const taskRow = (ui.get().taskList.tasks || []).find(row => row.source === top.sourceKey && String(row.id) === String(top.taskId));
    const name = top.title || (taskRow ? taskRow.title : '') || tr('Terminal');
    ui.notify(name, 'info', {
      lead: 'Continue', detail: window.TAContinue.lastViewedText(hint.client, hint.at, now), close: true, ms: window.TAContinue.HINT_MS,
      action: { label: 'Open', run: () => ui.actions.openRow(`${top.sourceKey}|${top.taskId}`, { kind: 'terminal', id: top.terminalId }) },
    });
  }
  if (!hintDone) {
    PageState.subscribe(what => { if (!what) { hintFresh = true; maybeHint(); } });
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (!hiddenAt || Date.now() - hiddenAt < 5 * 60 * 1000) return;
      notedHere = new Map();
      hintDone = false; hintFresh = false; // the read that coming back starts decides
    });
  }
  // A column of the multi-column view shows the same session on every device: the pane keeps it in the shared page state as `h5-column:<pane id>`
  // ({ instance, task, terminal } as JSON), and opens what another device chose there, at start and when it changes ("Columns" in
  // docs/design/shared-page-state.md). Its own pane keys stay the cache of this browser.
  const COLUMN_KEY = PANE && PageState ? `h5-column:${PANE.id}` : null;
  let columnShown = null; // the value this pane showed last (its own or one it followed)
  function noteColumn(target) {
    const from = COLUMN_KEY && target && sources.find(item => item.key === target.sourceKey);
    if (!from || !from.instanceId) return;
    const first = columnShown === null; // what the pane brought back by itself at start: kept only when no device chose one (the import rule)
    columnShown = JSON.stringify({ instance: from.instanceId, task: String(target.taskId), terminal: String(target.terminalId) });
    if (PageState.get(COLUMN_KEY) === columnShown) return;
    if (first) PageState.importKey(COLUMN_KEY, columnShown); else PageState.set(COLUMN_KEY, columnShown);
  }
  function followColumn() {
    if (!COLUMN_KEY || !listReady) return null;
    const text = PageState.get(COLUMN_KEY);
    if (typeof text !== 'string' || text === columnShown) return null;
    let wanted = null;
    try { wanted = JSON.parse(text); } catch { return null; }
    const from = wanted && listedSources().find(item => item.instanceId && item.instanceId === wanted.instance);
    if (!from) return null;
    columnShown = text;
    if (task && source === from && String(task.id) === String(wanted.task) && String(terminalId) === String(wanted.terminal)) return null;
    return ui.actions.paneOpen({ sourceKey: from.key, taskId: Number(wanted.task), terminalId: String(wanted.terminal) });
  }
  if (COLUMN_KEY) PageState.subscribe(what => { if (!what || what.includes(COLUMN_KEY)) void followColumn(); });
  // A session renamed (`title`) or deleted (null) from a menu: its entry follows at once, also when its task's terminals are not known to the page.
  function changeRecent(target, terminal, title) {
    if (PANE) return;
    const key = ui.recent.key({ sourceKey: target.from.key, taskId: String(target.taskId), terminalId: String(terminal) });
    const next = ui.recent.edit(recentList, key, title);
    if (next === recentList) return;
    if (title === null && key === recentShownKey) recentShownKey = null; // the shown one went: the next first entry was not in use until now
    const entry = sharedEntry(recentList.find(item => ui.recent.key(item) === key));
    recentList = next;
    if (entry && PageState) PageState.noteRecent([title === null ? { ...entry, gone: true } : { ...entry, title: String(title).slice(0, 120) }]);
    publishRecent();
  }
  // ── Remove from Recent and Clear list ("Remove from Recent and Clear list" in docs/design/shared-page-state.md) ──
  // Only the Recent list changes: the session, its task, its terminal and its draft stay, and showing the session again puts it back on top
  // (`noteShown`). The shown session is never removed (it is in use: it would come back at once). Both go to every device and engine through the
  // shared page state (a tombstone per entry; a clear is the server's clear mark), and a snackbar offers Undo, which notes the same entries again
  // with their times (so the order and "when" come back as they were).
  const shownKey = () => { const shown = ui.get().shownTarget; return shown ? ui.recent.key({ sourceKey: shown.sourceKey, taskId: String(shown.taskId), terminalId: String(shown.terminalId) }) : null; };
  // The shared entries of the list by this page's key (`<source>|<task>|<terminal>`).
  function sharedByKey() {
    const out = new Map();
    for (const entry of PageState.recent()) { const row = PageState.toPage(entry, pageSources()); if (row && !out.has(ui.recent.key(row))) out.set(ui.recent.key(row), entry); }
    return out;
  }
  const undoRecent = (message, removed) => ui.notify(message, 'info', { action: { label: 'Undo', run: () => PageState.noteRecent(removed) } });
  // `keys`: this page's keys of the entries to remove (a row of the Recent tab, a card of the switcher). True when one went.
  ui.actions.removeRecent = keys => {
    if (PANE || !PageState) return false;
    const current = shownKey();
    const byKey = sharedByKey();
    const removed = (Array.isArray(keys) ? keys : [keys]).filter(key => key !== current).map(key => byKey.get(key)).filter(Boolean);
    if (!removed.length) return false;
    PageState.noteRecent(removed.map(entry => ({ ...entry, gone: true }))); // it publishes again (the list without them)
    undoRecent('Removed from Recent', removed);
    return true;
  };
  // "Clear list": every entry but the shown session, also the ones this page cannot name (another engine's tasks it does not see).
  ui.actions.clearRecent = () => {
    if (PANE || !PageState) return false;
    const current = shownKey();
    const keep = current ? [sharedByKey().get(current)].filter(Boolean) : [];
    const removed = PageState.recent().filter(entry => !keep.includes(entry));
    if (!removed.length) return false;
    PageState.clearRecent(keep);
    undoRecent('Recent list cleared', removed);
    return true;
  };
  // "Remove from Recent" in the popup of a row of the Recent tab: above the destructive items, not for the shown session.
  const removeStep = (from, taskId, terminal) => {
    const key = ui.recent.key({ sourceKey: from.key, taskId: String(taskId), terminalId: String(terminal) });
    return key === shownKey() ? [] : [['Remove from Recent', () => { closeTerminalMenu(); ui.actions.removeRecent([key]); }, 'list']];
  };
  // The "⋯" of a row of the Recent tab (RecentList.jsx): the menu of a session row of the task list, with "Remove from Recent". The task's terminals
  // are known when it is shown or open in the list; otherwise they are read first, and the menu opens under the button if it is still there.
  ui.actions.recentMore = async (ref, row, anchor) => {
    const hit = resolveRef(ref);
    if (!hit) return;
    const { from, item } = hit;
    const peek = peeks.get(ref);
    if (isShown(from, item.id) || (peek && peek.status === 'ready')) { ui.actions.rowMore(ref, row, anchor, { recent: true }); return; }
    const rows = await api('GET', `${from.tasksBase}/${item.id}/terminals`).catch(() => null);
    const entry = Array.isArray(rows) ? rows.find(candidate => String(candidate.terminal_id) === String(row.id)) : null;
    if (!entry) { if (Array.isArray(rows)) changeRecent({ from, taskId: item.id }, row.id, null); return; } // gone meanwhile
    if (anchor && anchor.isConnected && !ui.get().menu) openOtherMenu(from, item, row, entry, anchor, { recent: true });
  };
  // The last lines of a terminal's buffer (trailing empty rows left out), plain text.
  function linesOf(term) {
    try {
      const buffer = term.buffer.active;
      const text = index => { const line = buffer.getLine(index); return line ? line.translateToString(true).slice(0, 300) : ''; };
      let last = buffer.length - 1;
      while (last >= 0 && !text(last).trim()) last -= 1;
      const out = [];
      for (let index = Math.max(0, last - PREVIEW_LINES + 1); index <= last; index += 1) out.push(text(index));
      return out;
    } catch { return []; }
  }
  function keepPreview(s) {
    if (PANE || !s || !s.term) return;
    previews.delete(s.key);
    previews.set(s.key, linesOf(s.term));
    while (previews.size > ui.recent.max) previews.delete(previews.keys().next().value);
  }
  ui.actions.openSwitcher = () => {
    if (PANE || columnsShown() || ui.get().switcher) return;
    // The keyboards close first (as the next-session button did): the switcher covers the key row and the draft box.
    if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    setOsk(false);
    publishRecent();
    const lines = {};
    for (const s of warm) if (!s.disposed) lines[s.key] = { lines: linesOf(s.term), live: true };
    for (const entry of ui.get().recent) { const key = ui.recent.key(entry); if (!lines[key] && previews.has(key)) lines[key] = { lines: previews.get(key), live: false }; }
    ui.set({ switcher: { seq: ++switcherSeq, press: 0, previews: lines } });
  };
  ui.actions.closeSwitcher = () => { if (ui.get().switcher) ui.set({ switcher: null }); };
  // The switch button: the first press opens the switcher; a press while it is open switches to its centred card (Switcher.jsx watches `press`).
  ui.actions.pressSwitcher = () => {
    const open = ui.get().switcher;
    if (open) ui.set({ switcher: { ...open, press: open.press + 1 } });
    else ui.actions.openSwitcher();
  };
  // The "⋯" of a session row, of the task the row is under (`ref`), which may not be the selected one.
  // `opts.recent`: opened from a row of the Recent tab (it adds "Remove from Recent").
  ui.actions.rowMore = (ref, row, anchor, opts = {}) => {
    const hit = resolveRef(ref);
    if (!hit) return;
    const { from, item } = hit;
    if (isShown(from, item.id)) {
      const entry = terminals.find(candidate => candidate.terminal_id === row.id);
      if (entry) openTerminalMenu(entry, anchor, opts);
      return;
    }
    const peek = peeks.get(taskRef(from, item.id));
    if (!peek) return;
    const entry = peek.terminals.find(candidate => candidate.terminal_id === row.id);
    if (entry) openOtherMenu(from, item, row, entry, anchor, opts);
  };
  // Resolves to whether the task was made (the shell then empties its input).
  // workDir: an absolute path, or empty for the default rule (a folder named after the task under the tasks folder); the default is never sent.
  // on: the key of the service it is made on ("Create on" in the form); without one, this machine.
  ui.actions.createTask = async (title, workDir = '', on = null) => {
    const current = sources.find(item => item.key === on) || LOCAL;
    ui.set({ creatingTask: true });
    try {
      const created = await api('POST', current.tasksBase, workDir ? { title, work_dir: workDir } : { title });
      ui.set({ newTaskOpen: false }); // the New task dialog closes once the task is made
      if (!sources.includes(current)) return true;
      await loadSource(current);
      selectTask(current, findTask(current, created.id) || created);
      return true;
    } catch (error) {
      tell(`Could not create the task: ${error.message}`, 'error');
      return false;
    } finally { ui.set({ creatingTask: false }); }
  };
  // The New task dialog (`NewTaskDialog` in TaskDrawer.jsx), opened by "New task" at the end of the task list. It cannot be closed while the task is being made.
  ui.actions.openNewTask = () => ui.set({ newTaskOpen: true });
  ui.actions.closeNewTask = () => { if (!ui.get().creatingTask) ui.set({ newTaskOpen: false }); };
  // The service a new task is made on, for the new-task form: its default folder rule is shown only for this machine (a remote one keeps its own).
  ui.actions.newTaskTarget = (key = 'local') => {
    const from = sources.find(item => item.key === key) || LOCAL;
    return { local: from.key === 'local', label: from.label };
  };

  // ── Task actions (the "⋯" of a task): move to another group, change the working directory, delete (optionally with the directory) ──
  // The task endpoints, through the task base of the engine, so local, Engine and proxied tasks work alike.
  // Every action below belongs to the row it was started from: the service of that row, whichever task is shown.
  // The name a dialog or menu shows beside the title (tasks of two services can have the same title): with more than one device, every task's device,
  // this machine's too, so the same task reads the same on every engine's page; with this machine alone, none.
  const serviceOf = from => (from === LOCAL ? (sources.length > 1 && LOCAL.name) || null : from.label);
  const dialogFor = (kind, from, item, extra = {}) => ({ kind, sourceKey: from.key, service: serviceOf(from), id: item.id, title: item.title, workDir: item.work_dir || '', error: '', busy: false, ...extra });
  const dialogSource = dialog => (dialog ? sources.find(item => item.key === dialog.sourceKey) : null);
  // anchor: the "⋯" it was opened from: the actions are a popup under it, like those of a session row (TermMenu.jsx `SessionPopup`), which lists only
  // what can be done (no disabled items). On a touch screen the row has no "+", so the popup starts with New session. Without an anchor: the sheet.
  ui.actions.taskMore = (ref, anchor = null) => {
    const hit = resolveRef(ref);
    if (!hit) return;
    const { from, item } = hit;
    menuRow = null;
    menuTask = taskRef(from, item.id); // so that the task leaving the list closes this sheet too (`leaveTask`)
    void loadLinks(); // for the next time: the menu never waits for it
    const ordered = [...from.groups].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    // Its place in the shared order: each step is disabled where the task cannot go (already first or last). They look at the order when they run.
    const key = sortable() ? orderKey(from, item) : null;
    const display = key ? shownKeys() : [];
    const steps = key && display.length > 1 ? [['Move to top', 'top'], ['Move up', 'up'], ['Move down', 'down'], ['Move to bottom', 'bottom']] : [];
    const moveStep = step => {
      closeTerminalMenu();
      const to = ui.taskOrder.stepTarget(shownKeys(), key, step);
      const target = to && orderedTasks().find(row => row.key === to.target);
      if (target) reorderTask(taskRef(from, item.id), taskRef(target.from, target.item.id), to.after);
    };
    const items = [
      ...(anchor && !pointerMode() ? [['New session', () => { closeTerminalMenu(); ui.actions.addSession(taskRef(from, item.id)); }]] : []),
      ...steps.map(([label, step]) => [label, () => moveStep(step), null, null, null, !ui.taskOrder.stepTarget(display, key, step)]),
      ...ordered.map(group => [`${item.status === group.key ? '\u2713 ' : ''}${tr('Move to')} \u201C${tr(group.name)}\u201D`, () => void moveTask(from, item, group.key), 'raw']),
      ['Rename', () => void askTaskRename(from, item)],
      ['Remember this', () => askRemember(from, item, null, '')],
      ['Edit working directory', () => { closeTerminalMenu(); ui.set({ taskDialog: dialogFor('workdir', from, item) }); }],
      ...(choosesVisibility(from) ? [['Visible to', () => void askVisibility(from, item)]] : []),
      ...(movesTasks(from) ? [['Move to another machine\u2026', () => void askTaskMove(from, item)]] : []),
      ...(archives(from) ? [['Archive', () => void askArchive(from, item)]] : []),
      ['Delete', () => { closeTerminalMenu(); ui.set({ taskDialog: dialogFor('delete', from, item) }); }, 'danger'],
    ];
    showMenu(serviceOf(from) ? `${item.title} \u00B7 ${serviceOf(from)}` : item.title, anchor ? items.filter(entry => !entry[5]) : items, { anchor });
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
  ui.actions.taskDialogClose = () => {
    const dialog = ui.get().taskDialog || {};
    if (dialog.busy) return;
    ui.set({ taskDialog: null });
    // A rename that closed the shown terminal and then did not happen: the terminal opens again where it was.
    if (dialog.kind === 'rename' && dialog.reopen && isShown(dialogSource(dialog), dialog.id) && terminalId === dialog.reopen && !session) connect();
  };
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
      if (Array.isArray(answer && answer.devices)) patch = { status: 'ready', devices: byDevice(answer.devices.filter(Boolean), device => ({ name: device.name, key: String(device.link_id) })) }; // by name, as every list of devices
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
  // ── Moving a task to another machine (the "Move to another machine…" of its "⋯"; services/task-move.js, docs/design/task-move.md). The task's own engine
  // does the move: `GET {tasksBase}/:id/move` says what it would do (size, terminals, the machines it can go to), `POST` starts it, `/move/progress` is read
  // every 700 ms while a move started or seen here runs (the dialog can be closed: the move goes on, and the same menu item shows its progress again),
  // `/move/cancel` stops it until the target has verified the copy. The dialog is MoveTaskDialog in TaskDialogs.jsx (the task dialogs chunk). Offered
  // for a task of this machine when it has a service link, and of an online Engine that lists 'tasks:move'.
  const movesTasks = from => from.status !== 'offline' && (from === LOCAL ? hasLinks : Boolean(Array.isArray(from.capabilities) && from.capabilities.includes('tasks:move')));
  const moveDialog = (from, id) => { const dialog = ui.get().taskDialog; return dialog && dialog.kind === 'move' && (!from || (dialog.sourceKey === from.key && String(dialog.id) === String(id))) ? dialog : null; };
  const movePolls = new Map(); // task ref -> timer of the progress read
  async function askTaskMove(from, item) {
    closeTerminalMenu();
    ui.set({ taskDialog: dialogFor('move', from, item, { stage: 'loading', preview: null, progress: null, from: serviceOf(from) || sourceName(from) }) });
    let preview;
    try { preview = await api('GET', `${from.tasksBase}/${item.id}/move`); } catch (error) {
      if (moveDialog(from, item.id)) patchDialog({ stage: 'error', error: (error.data && error.data.error) || error.message });
      return;
    }
    if (!moveDialog(from, item.id)) return;
    const named = preview && preview.self && preview.self.name ? { from: preview.self.name } : {}; // the engine's own name, the same on every page
    if (preview && preview.active) { patchDialog({ stage: 'progress', preview, progress: preview.active, ...named }); pollMove(from, item.id); return; }
    patchDialog({ stage: 'ready', preview, ...named });
  }
  ui.actions.taskMoveStart = async ({ target, tierAck = false } = {}) => {
    const dialog = moveDialog();
    const from = dialogSource(dialog);
    if (!dialog || !from || dialog.busy) return;
    patchDialog({ busy: true, error: '' });
    try {
      const progress = await api('POST', `${from.tasksBase}/${dialog.id}/move`, { target, tier_ack: tierAck === true });
      if (moveDialog(from, dialog.id)) patchDialog({ busy: false, stage: 'progress', progress });
      pollMove(from, dialog.id);
    } catch (error) {
      const data = error.data || {};
      if (moveDialog(from, dialog.id)) patchDialog({ busy: false, error: data.error || error.message, reason: data.reason || null });
    }
  };
  ui.actions.taskMoveCancel = async () => {
    const dialog = moveDialog();
    const from = dialogSource(dialog);
    if (!dialog || !from || dialog.busy) return;
    patchDialog({ busy: true });
    try {
      const answer = await api('POST', `${from.tasksBase}/${dialog.id}/move/cancel`);
      if (moveDialog(from, dialog.id)) patchDialog({ busy: false, progress: answer && answer.move ? answer.move : dialog.progress });
    } catch (error) {
      if (moveDialog(from, dialog.id)) patchDialog({ busy: false, error: (error.data && error.data.error) || error.message });
    }
  };
  function pollMove(from, taskId) {
    const ref = taskRef(from, taskId);
    if (movePolls.has(ref)) return;
    const step = async () => {
      let move = null;
      try { move = (await api('GET', `${from.tasksBase}/${taskId}/move/progress`) || {}).move; } catch { /* asked again */ }
      const open = moveDialog(from, taskId);
      if (open && move) patchDialog({ progress: move });
      if (!move || !['done', 'failed', 'cancelled'].includes(move.phase)) { movePolls.set(ref, setTimeout(step, 700)); return; }
      movePolls.delete(ref);
      await moveEnded(from, taskId, move, Boolean(open));
    };
    movePolls.set(ref, setTimeout(step, 700));
  }
  async function moveEnded(from, taskId, move, open) {
    const name = move.target ? move.target.name : '';
    if (move.phase !== 'done') {
      if (!open) tell(move.phase === 'cancelled' ? 'Move cancelled' : `The task was not moved; nothing was changed: ${move.error || ''}`, move.phase === 'cancelled' ? 'info' : 'error');
      return;
    }
    const shown = isShown(from, taskId);
    if (open) ui.set({ taskDialog: null });
    tell(`Moved \u201C${move.title}\u201D to ${name}`, 'success');
    const to = move.target && sources.find(item => item.instanceId && item.instanceId === move.target.instance_id);
    await Promise.all([loadSource(from), to ? loadSource(to) : null]);
    const item = to && findTask(to, move.new_task_id);
    if (shown && item) selectTask(to, item); // the task that was open opens at its new place (its terminals resume their carried sessions)
  }
  // ── Renaming a task (the "Rename" of its "⋯"): the title through `PUT {tasksBase}/:id`, or the title and the folder through `POST {tasksBase}/:id/rename-folder`
  // (services/task-rename.js), which moves the folder's Claude Code and Codex sessions with it. The folder part is offered on this machine and on an Engine with
  // 'tasks:rename-folder' (asked for when not known yet: `folderSupported` is null until then). A task with open terminals is refused (TASK_BUSY with their ids):
  // the dialog then offers to close them (the same path as a terminal's Close) and try again. See "Task rename" in docs/design/architecture-data.md.
  const renamesFolder = from => from.key === 'local' || Boolean(Array.isArray(from.capabilities) && from.capabilities.includes('tasks:rename-folder'));
  const renameDialog = () => { const dialog = ui.get().taskDialog; return dialog && dialog.kind === 'rename' ? dialog : null; };
  async function askTaskRename(from, item) {
    closeTerminalMenu();
    const known = from.key === 'local' || Array.isArray(from.capabilities);
    ui.set({ taskDialog: dialogFor('rename', from, item, { folderSupported: known ? renamesFolder(from) : null, blocked: null }) });
    if (known) return;
    try { await readInfo(from); } catch { /* an older or offline Engine: the title only */ }
    const dialog = renameDialog();
    if (dialog && dialog.sourceKey === from.key && dialog.id === item.id) patchDialog({ folderSupported: renamesFolder(from) });
  }
  const RENAME_ERRORS = {
    TASK_NOT_FOUND: 'This task no longer exists',
    TITLE_REQUIRED: 'Enter a title',
    INVALID_FOLDER_NAME: 'Enter a folder name without / or \\',
    FOLDER_NAME_UNCHANGED: 'The folder already has this name',
    FOLDER_EXISTS: 'A folder with this name already exists',
    FOLDER_MISSING: 'The working directory does not exist',
    FOLDER_NOT_RENAMABLE: 'This folder cannot be renamed',
    RENAME_FOLDER_UNSUPPORTED: 'This server is too old to rename folders. Update it first',
    RENAME_FAILED: 'The folder was not renamed; everything was put back',
    RENAME_ROLLBACK_FAILED: 'Renaming failed and not everything could be put back',
  };
  // A closed terminal's shell (and an agent in it) is given a moment to write its last lines and exit before the folder moves.
  const CLOSE_SETTLE_MS = 1500;
  ui.actions.taskRenameSave = async ({ title, folder = null } = {}) => {
    const dialog = renameDialog();
    const from = dialogSource(dialog);
    const item = from && findTask(from, dialog.id);
    if (!item || dialog.busy) return;
    const value = String(title || '').trim();
    if (!value) { patchDialog({ error: tr('Enter a title') }); return; }
    if (!folder && value === item.title) { ui.set({ taskDialog: null }); return; }
    patchDialog({ busy: true, error: '', blocked: null });
    try {
      if (folder) await api('POST', `${from.tasksBase}/${item.id}/rename-folder`, { name: folder, ...(value !== item.title ? { title: value } : {}) });
      else await api('PUT', `${from.tasksBase}/${item.id}`, { title: value });
    } catch (error) {
      const data = error.data || {};
      if (error.message === 'TASK_BUSY') { patchDialog({ busy: false, blocked: { terminals: Array.isArray(data.terminals) ? data.terminals : [], chat: data.chat === true } }); return; }
      if (error.message === 'RENAME_FOLDER_UNSUPPORTED' && from.capabilities) from.capabilities = from.capabilities.filter(name => name !== 'tasks:rename-folder');
      const label = tr(RENAME_ERRORS[error.message] || error.message);
      patchDialog({ busy: false, error: data.reason ? `${label}: ${data.reason}` : label, ...(error.message === 'RENAME_FOLDER_UNSUPPORTED' ? { folderSupported: false } : {}) });
      return;
    }
    ui.set({ taskDialog: null });
    tell(folder ? 'Task and folder renamed' : 'Task renamed', 'success');
    await loadSource(from);
    const fresh = findTask(from, item.id);
    if (isShown(from, item.id) && fresh) { task = fresh; ui.set({ taskName: fresh.title }); }
    if (!folder) return;
    peeks.delete(taskRef(from, item.id));
    if (!isShown(from, item.id)) return;
    syncFiles(); // a new folder: a new tree
    const current = task;
    try {
      const rows = await api('GET', `${from.tasksBase}/${current.id}/terminals`);
      if (current === task && Array.isArray(rows)) {
        const next = new Map(rows.map(row => [row.terminal_id, row]));
        for (const row of terminals) { const update = next.get(row.terminal_id); if (update) row.work_dir = update.work_dir; }
        renderTabs();
      }
    } catch { /* the list is read again on the next visit */ }
    // The terminal that was shown was closed for the rename: it opens again in the new folder and resumes its agent session.
    if (dialog.reopen && current === task && terminalId === dialog.reopen && !session) connect();
  };
  // TASK_BUSY: close the terminals the server named (as a terminal's Close does: the view is ended first), wait a moment, then save again.
  ui.actions.taskRenameCloseRetry = async ({ title, folder } = {}) => {
    const dialog = renameDialog();
    const from = dialogSource(dialog);
    if (!dialog || dialog.busy || !dialog.blocked || !from) return;
    patchDialog({ busy: true, error: '' });
    let reopen = dialog.reopen || null;
    try {
      for (const id of dialog.blocked.terminals) {
        const wasCurrent = await controlTerminal({ from, taskId: dialog.id, row: { terminal_id: id } }, 'close');
        if (wasCurrent) reopen = id;
      }
    } catch (error) {
      patchDialog({ busy: false, error: `${tr('Could not close the terminals:')} ${tr(error.message)}` });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, CLOSE_SETTLE_MS));
    patchDialog({ busy: false, blocked: null, reopen });
    await ui.actions.taskRenameSave({ title, folder });
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
  // an early socket, hidden warm views). A terminal only comes from the person: the button of the empty state opens the same New session dialog as the "+" of the task.
  function showNoTerminal() {
    closeNotebook();
    terminalId = null;
    wantedTerminal = null;
    const from = source;
    const taskId = task.id;
    store.set(`terminal:${from.key}:${taskId}`, null);
    dropEarlySocket();
    closeWarm(item => item.source === from && item.task.id === taskId);
    showEmpty('This task has no terminal yet', { create: true });
  }
  // The dialog lies over the page: neither the phone's task sheet nor a folded sidebar is opened for it.
  ui.actions.newSessionFromEmpty = () => { if (task) ui.actions.addSession(taskRef(source, task.id)); };

  // The list of the selected task could not be read: the next open of the list reads it again.
  function retryTerminals() { if (task && terminalsState === 'error') terminalsLoaded = loadTerminals(); }
  // known: the terminals of this task that the list already shows (the sessions under its expanded row, see `selectTask`). They are carried over, so the row keeps
  // its sessions and count without a gap while the list is read again, and the terminal to show (the tapped one, else the saved one, else the first) is shown and
  // connected at once instead of after that read: a remote service answers in hundreds of milliseconds. The answer then reconciles: rows, names and count are
  // the server's, and a terminal that is gone meanwhile is closed and the same rules choose another. Nothing connects early while a Restart or Delete of that task
  // is on its way (the terminal may be the one going away). Without known terminals the list is read first, as for a task never expanded ("Loading…").
  async function loadTerminals(known = null) {
    hideShown(); // another task: the terminal shown so far stays warm (WARM_MAX)
    if (notebook && !(task && notebook.source === source && String(notebook.taskId) === String(task.id))) closeNotebook(); // a notebook is not kept warm
    const carried = task && Array.isArray(known) && known.length ? [...known] : null;
    terminals = carried || [];
    terminalsState = carried ? 'ready' : 'loading';
    const seq = (terminalsSeq += 1);
    if (!task) { renderTabs(); showEmpty('Choose a task to open its phone terminal'); return; }
    const current = task;
    const from = source;
    const savedKey = `terminal:${from.key}:${current.id}`;
    const early = Boolean(carried && !actionsDone(from, current.id));
    if (early) {
      terminalId = [wantedTerminal, store.get(savedKey)].find(id => id && carried.some(row => row.terminal_id === id)) || carried[0].terminal_id;
      if (earlySocket && earlySocket.terminalId !== terminalId) dropEarlySocket();
      renderTabs();
      connect(); // a warm one is shown as it is
    } else {
      if (carried) terminalId = null; // the id of the task left (every older task has a `default`) must not mark one of these rows as the current one
      renderTabs();
      showEmpty('Loading…');
    }
    let rows;
    try {
      for (;;) {
        await actionsDone(from, current.id); // a Restart or Delete started from its row before it was selected, or from a carried row since
        if (seq !== terminalsSeq) return;
        const started = actionsStarted(from, current.id);
        const asked = sessionOrder.clock;
        rows = inSavedOrder(taskRef(from, current.id), await api('GET', `${from.tasksBase}/${current.id}/terminals`), asked);
        if (seq !== terminalsSeq) return;
        if (actionsStarted(from, current.id) === started) break; // else this list may be older than that action: read again once it is done
      }
    } catch (error) {
      // A 404: the task may be gone from this service (deleted, or hidden from this machine). The list says, and when it is, `taskGone` has already moved the page on.
      if (error.status === 404) await recheckSource(from);
      if (seq !== terminalsSeq) return;
      // The row says the list could not be read, and the next open of the list reads it again. A terminal connected early stays shown (a lost one reconnects or
      // ends by itself); only the terminal area of a task with nothing shown says so.
      terminals = [];
      terminalsState = 'error';
      wantedTerminal = null;
      if (!(early && session && !session.disposed)) showEmpty(`Could not load terminals: ${error.message}`);
      renderTabs();
      return;
    }
    terminalsState = 'ready';
    terminals = Array.isArray(rows) ? rows : [];
    const listed = id => terminals.some(row => row.terminal_id === id);
    // A terminal of this task that is no longer listed was ended elsewhere: its views here go too (the shown one included, so its socket does not linger).
    closeWarm(item => item.source === from && String(item.task.id) === String(current.id) && !listed(item.terminalId));
    if (!terminals.length) { showNoTerminal(); renderTabs(); return; }
    const wanted = wantedTerminal; // a session that was tapped in the task sheet
    wantedTerminal = null;
    if (early && terminalId && listed(terminalId) && session && !session.disposed && session.terminalId === terminalId) {
      // Still there and shown: it stays connected; only the rows, names and count follow the server.
      if (wanted && terminalId === wanted) store.set(savedKey, terminalId);
      const own = terminals.find(row => row.terminal_id === terminalId);
      session.workDir = (own && own.work_dir) || null;
      renderTabs();
      return;
    }
    const saved = store.get(savedKey);
    terminalId = (early && terminalId && listed(terminalId) ? terminalId : null) // chosen meanwhile (another row tapped) and not shown yet
      || [wanted, saved].find(id => id && listed(id)) || terminals[0].terminal_id;
    if (earlySocket && earlySocket.terminalId !== terminalId) dropEarlySocket();
    if (wanted && terminalId === wanted) store.set(savedKey, terminalId);
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
  // One `menu` state serves the actions of a terminal, the actions of a chat and the choices of the New session dialog of the "+" of a task. Its items are
  // { label, kind } in the state and their functions are kept here, in the order shown. The actions of a session row are a popup under its "⋯" (`menu.anchor`, TermMenu.jsx); the
  // actions of a task are a sheet from the bottom (TermMenu.jsx); the New session choices (`naming`, for the task `task`) are a dialog (`NewSessionDialog` in TaskDrawer.jsx) and
  // the rename field (`rename`, in place of that row) is drawn in the task list (TaskDrawer.jsx), where the person tapped.
  let menuRuns = [];
  let menuRow = null;
  // { from, taskId, row, taskTitle }: the Engine and the task of that terminal, and the row. Rename, Restart and Delete go there, whichever task is selected
  // by then. `taskTitle` is only set for a task that is not selected, so its name can be shown in the confirmation.
  let menuScope = null;
  // The optional name typed in the New session dialog. It is kept while moving between its lists (Claude session, Back) and names what is created.
  let newName = '';
  // The initial command typed in the New session dialog ("Initial command" in docs/design/terminals.md): sent only with New Terminal, then cleared.
  let newCommand = '';
  let menuCreate = -1; // the item that Enter in the name field runs in a sub-list (New Claude session, New Codex session, New OpenCode session)
  // The keyboard way of each item of the first list of the New session dialog (Claude session, Codex session, OpenCode session, New Terminal): Enter on the
  // highlighted choice makes a NEW session of that kind at once, where a press on a session kind opens its sub-list (`menuPick`, `NewSessionDialog`). null: not a choice.
  let menuQuick = [];
  let menuTask = null; // the ref (`taskRef`) of the task whose "+" opened the New session dialog (or whose "⋯" opened its sheet)
  let creating = 0; // counts the terminals asked for from the New session dialog; closing the dialog counts too, so an answer for a dialog that was closed is dropped

  function closeTerminalMenu() {
    menuRow = null;
    menuScope = null;
    menuRuns = [];
    menuCreate = -1;
    menuQuick = [];
    menuTask = null;
    newName = '';
    newCommand = '';
    creating += 1;
    ui.set({ menu: null });
  }
  // The rename field drawn under a task goes when that task is collapsed (without an id: under any task). The New session dialog, the sheet and the popup of actions are modal:
  // nothing behind them can be tapped (a popup whose row has gone closes by itself, TermMenu.jsx).
  function closeListMenu(ref = null) {
    const menu = ui.get().menu;
    const owner = menu && menu.rename ? menu.rename.task : null;
    if (owner != null && (ref === null || ref === owner)) closeTerminalMenu();
  }
  // The typed name, as the server will keep it (an empty name: the default "Terminal N" / "Claude N").
  const takeName = () => newName.replace(/\s+/g, ' ').trim();
  // items: [label, run, kind, create, quick, disabled, look]; kind 'danger' is drawn as a warning, 'raw' is a name that is not translated; create: Enter in the name field runs it;
  // quick: the item is a choice of the keyboard list (`pick` in the state), and Enter on it runs `quick` instead of `run`; look (the New session dialog only):
  // { icon, note }, the mark at the start of the row ('claude', 'codex', 'opencode', 'shell' or 'back') and a second line already in the page's language.
  // naming: the New session dialog of the task `menuTask`, with the optional name field above the choices; `extra` adds its own fields (the task's title and service,
  // the sub-list shown, busy and error).
  // anchor: the "⋯" of a session row: the actions are a popup under it instead of the sheet from the bottom.
  function showMenu(title, items, { naming = false, anchor = null, extra = null } = {}) {
    menuRuns = items.map(item => (item[5] ? null : item[1])); // item[5]: disabled
    menuCreate = items.findIndex(item => item[3]);
    menuQuick = items.map(item => item[4] || null);
    ui.set({ menu: { title, items: items.map(([label, , kind, , quick, disabled, look]) => ({ label, kind: kind || null, pick: Boolean(quick), disabled: Boolean(disabled), icon: (look && look.icon) || null, note: (look && look.note) || '' })), rename: null, renameValue: '', naming, task: naming ? menuTask : null, name: newName, anchor, ...extra } });
  }
  // The rename field takes the place of the row in the task list ({ kind, id, task } of the row, `task` being its ref: `default` is a terminal id in every task); the sheet of
  // actions goes away.
  const askRename = value => ui.set(state => ({
    menu: state.menu && { ...state.menu, rename: { kind: 'terminal', id: menuRow && menuRow.terminal_id, task: menuScope && taskRef(menuScope.from, menuScope.taskId) }, renameValue: value },
  }));
  // Only plain shells have a start command. Keep the dialog bound to the row's Engine and task even when a different task is shown.
  function startCommandSteps({ from, taskId, row }) {
    if (row.agent) return [];
    const support = startCommandState(from);
    if (!support.on) return [[support.note ? 'This computer needs an update first' : 'Start command…', null, null, false, null, true]];
    return [['Start command…', () => {
      closeTerminalMenu();
      ui.set({ startCommandDialog: `${from.tasksBase}/${taskId}/terminals/${encodeURIComponent(row.terminal_id)}` });
    }]];
  }
  function refreshStartCommandMenu({ from, row }, reopen) {
    if (row.agent || from.key === 'local' || Array.isArray(from.capabilities)) return;
    const shown = ui.get().menu;
    readInfo(from).then(() => { if (ui.get().menu === shown) reopen(); }, () => {});
  }
  // "Delete session" (not "Delete"): beside "Remove from Recent" the two must not be mixed up.
  function openTerminalMenu(row, anchor, { recent = false } = {}) {
    menuRow = row;
    const target = menuScope = { from: source, taskId: task.id, row };
    // "Copy text" is for the terminal that is open (the copy view reads its buffer); the long press on the terminal body is the other way in.
    const open = row.terminal_id === terminalId && !agentChat && session && !session.disposed;
    showMenu(row.title, [
      ...(open ? [['Copy text', () => { closeTerminalMenu(); closeTasks(); openCopy(); }]] : []),
      // Agent terminals too: a name given here is kept (title_custom) and wins over the Claude / Codex session title from then on.
      ['Rename', () => askRename(row.title)],
      ...startCommandSteps(target),
      ['Remember this', () => askRemember(source, task, row.terminal_id, row.title)],
      ['Reopen', () => { closeTerminalMenu(); closeTasks(); switchTerminal(row); }],
      ...sessionSteps(source, task, row.terminal_id),
      ...(recent ? removeStep(source, task.id, row.terminal_id) : []),
      ['Restart in the working directory', () => void restartTerminal(target), 'danger'],
      ['Delete session', () => void deleteTerminal(target), 'danger'],
    ], { anchor });
    refreshStartCommandMenu(target, () => openTerminalMenu(row, anchor, { recent }));
  }
  // A remote Engine that says what it can do and does not list 'terminal:control' cannot restart or delete a terminal; one that has not said is asked (it answers with an error).
  const controlsTerminals = from => from.key === 'local' || !Array.isArray(from.capabilities) || from.capabilities.includes('terminal:control');
  // The actions of a session of a task that is not selected. Open is the same as a tap on the row; Rename, Restart and Delete go to the row's own Engine and task
  // (`target`) and leave the task, the terminal and the socket that are shown alone.
  function openOtherMenu(from, item, row, entry, anchor, { recent = false } = {}) {
    menuRow = entry;
    const target = menuScope = { from, taskId: item.id, row: entry, taskTitle: item.title };
    showMenu(entry.title, [
      ['Rename', () => askRename(entry.title)],
      ...startCommandSteps(target),
      ['Remember this', () => askRemember(from, item, entry.terminal_id, entry.title)],
      ['Open', () => { closeTerminalMenu(); ui.actions.openRow(taskRef(from, item.id), { kind: row.kind, id: row.id }); }],
      ...sessionSteps(from, item, entry.terminal_id),
      ...(recent ? removeStep(from, item.id, entry.terminal_id) : []),
      ...(controlsTerminals(from) ? [
        ['Restart in the working directory', () => void restartTerminal(target), 'danger'],
        ['Delete session', () => void deleteTerminal(target), 'danger'],
      ] : []),
    ], { anchor });
    refreshStartCommandMenu(target, () => openOtherMenu(from, item, row, entry, anchor, { recent }));
  }
  // ── "Remember this" ("Remember this" in docs/design/usage-time-page.md): a note of the person's own with the time, the task and the session ──
  // From a session's "⋯" (its row, or the session header's More while it is shown) or a task's "⋯": the dialog of the task dialogs chunk
  // (TaskDialogs.jsx `RememberDialog`), saved with POST /api/memories on this page's server. The task and session are named by engine-neutral ids
  // (`<instance id>|<task id>[|<terminal id>]`, usage-beats.mjs), so a note opens its session from any device; a device whose instance id is not
  // known yet saves the note without them. Never the terminal text.
  function askRemember(from, item, terminal, sessionTitle) {
    closeTerminalMenu();
    const instance = from && from.instanceId;
    const task = instance ? `${instance}|${item.id}` : null;
    ui.set({ taskDialog: dialogFor('remember', from, item, { task, session: task && terminal ? `${task}|${terminal}` : null, sessionTitle: sessionTitle || '' }) });
  }
  // The session the page shows (the session header's More, h5-shell/Header.jsx).
  ui.actions.rememberShown = () => {
    const row = task && terminalId && !agentChat ? terminals.find(entry => entry.terminal_id === terminalId) : null;
    if (row) askRemember(source, task, row.terminal_id, row.title);
  };
  ui.actions.rememberSave = async text => {
    const dialog = ui.get().taskDialog;
    const note = String(text || '').trim().slice(0, 500);
    if (!dialog || dialog.kind !== 'remember' || dialog.busy || !note) return;
    patchDialog({ busy: true, error: '' });
    try {
      await api('POST', '/api/memories', { text: note, ...(dialog.task ? { task: dialog.task } : {}), ...(dialog.session ? { session: dialog.session } : {}) });
      ui.set({ taskDialog: null });
      tell('Saved to Memories', 'success');
    } catch (error) { patchDialog({ busy: false, error: `${tr('Could not save the note')}: ${tr(error.message)}` }); }
  };
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
      changeRecent(target, row.terminal_id, null);
      if (!isSelected(target)) { showPeekChange(target, 'terminal'); return; }
      terminals = terminals.filter(item => item.terminal_id !== row.terminal_id);
      if (wasCurrent && terminals.length) { switchTerminal(terminals[0]); closeTasks(); }
      else {
        if (wasCurrent) showNoTerminal();
        renderTabs();
      }
    } catch (error) { tell(`Could not delete the terminal: ${error.message}`, 'error'); }
  }
  ui.actions.menuRun = index => { const run = menuRuns[index]; if (run && !(ui.get().menu || {}).busy) run(); }; // nothing more while a new terminal is being made
  ui.actions.menuCancel = closeTerminalMenu;
  ui.actions.menuName = value => { newName = String(value || ''); };
  ui.actions.menuCommand = value => { newCommand = String(value || ''); };
  ui.actions.menuNameSubmit = () => { const run = menuRuns[menuCreate]; if (run) run(); };
  // Enter on the highlighted choice of the New session dialog (from the name field or from the choice itself): a new session of that kind, with the typed name.
  ui.actions.menuPick = index => { const run = menuQuick[index]; if (run && !(ui.get().menu || {}).busy) run(); };
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
      changeRecent(scope, row.terminal_id, (renamed && renamed.title) || title);
      await showRenamed(scope, row.terminal_id, (renamed && renamed.title) || title);
    } catch (error) { tell(`Could not rename the terminal: ${error.message}`, 'error'); }
  };
  // The name of what is shown (the chat that is open, otherwise the current terminal) in small text under the task name.
  function renderSessionName() {
    let name = '';
    const current = terminalId ? terminals.find(entry => entry.terminal_id === terminalId) : null;
    const agent = (current && current.agent) || null; // the kind of the current terminal, as the task list shows it: picks the saved commands presets
    if (ui.get().terminalAgent !== agent) ui.set({ terminalAgent: agent });
    // The terminal shown (none under a chat): a pane of the multi-column view tells the top page, whose column header, rail tile and badge show its state.
    const target = task && terminalId && !agentChat ? { sourceKey: source.key, taskId: task.id, terminalId: String(terminalId) } : null;
    const shownBefore = ui.get().shownTarget || null;
    if (JSON.stringify(shownBefore) !== JSON.stringify(target)) ui.set({ shownTarget: target });
    noteShown(target, current); // the recent sessions of the switcher
    if (drafts && (!target || current)) drafts.bind(target && { ident: sharedEntry({ ...target, title: '' }), pageKey: ui.recent.key(target) }); // its draft
    if (agentChat && agentFor) {
      name = agentFor.title || '';
    } else if (terminalId) {
      const row = terminals.find(entry => entry.terminal_id === terminalId);
      name = (row && row.title) || '';
    }
    if (ui.get().sessionName !== name) ui.set({ sessionName: name });
  }
  function renderTabs() { renderTasks(); renderSessionName(); }

  // ── Session: a plain terminal, a Claude / Codex / OpenCode session of the task directory (new or resumed), or a shell notebook ──
  // The kinds of the first list in their order; New Terminal comes after the agents, the shell notebook ("Shell notebook: the page" in
  // docs/design/shell-notebook-page.md) after New Terminal. A kind's caption (`KIND_NOTES`) is its second line.
  const SESSION_KINDS = [['claude', 'Claude session'], ['codex', 'Codex session'], ['opencode', 'OpenCode session'], ['notebook', 'Shell notebook']];
  const AFTER_TERMINAL = new Set(['notebook']);
  const KIND_NOTES = { notebook: 'Cells of shell commands that share one shell' };
  // An agent that came after the first Engines: offered only on an Engine whose `/info` lists its capability (this machine always runs it). An older Engine
  // would start a plain shell for it, so the row is greyed with "<engine> needs an update first" ("Session menu" in docs/design/page-task-list.md).
  const AGENT_CAPABILITY = { opencode: 'terminal:opencode', notebook: 'terminal:notebook' };
  const runsAgent = (from, agent) => !AGENT_CAPABILITY[agent] || from.key === 'local' || Boolean(Array.isArray(from.capabilities) && from.capabilities.includes(AGENT_CAPABILITY[agent]));
  // The time an earlier session was last used, on the second line of its row in a sub-list: "11-22 18:40" (local time), '' without a time.
  const two = value => String(value).padStart(2, '0');
  const sessionTime = at => {
    const date = new Date(Number(at));
    return Number(at) > 0 && Number.isFinite(date.getTime()) ? `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}` : '';
  };
  // The New session dialog (`NewSessionDialog` in TaskDrawer.jsx). sub: null for the first list (Claude session, Codex session, OpenCode session, New Terminal), else the
  // label of the sub-list shown (Claude session: New Claude session, the earlier sessions, Back). The dialog names the task and, when it is not on this machine, its service.
  function showSessionMenu(sub, items) {
    const hit = resolveRef(menuTask);
    const extra = { sub, taskTitle: hit ? hit.item.title : '', service: hit ? serviceOf(hit.from) : null, busy: false, error: '', startCommand: startCommandState(hit ? hit.from : source) };
    showMenu(tr(sub || 'New session'), items, { naming: true, extra });
  }
  // Whether the task's Engine can persist a start command (capability `terminal:start-command`; this machine always can): { on, note }. An older Engine
  // may only run it once, so the field is disabled with a note; while a remote Engine has not said what it can do, it is disabled
  // without one (its `/info` is read and the list drawn again).
  function startCommandState(from) {
    if (from.key === 'local') return { on: true, note: '' };
    const known = Array.isArray(from.capabilities);
    const on = known && from.capabilities.includes('terminal:start-command');
    return { on, note: known && !on ? tr('This computer needs an update to run a command at start') : '' };
  }
  // The first list, in the order of the keyboard choices: Claude session (highlighted first), Codex session, OpenCode session, New Terminal. A press on a session
  // kind opens its sub-list; Enter on the highlighted one (`menuPick`) makes a new session of that kind at once, as "New Claude session" in the sub-list does.
  // A kind the task's Engine cannot run (`runsAgent`) is a greyed row that is not a choice. While a remote Engine has not said what it can do, its `/info` is
  // read once and the list drawn again (still the same list: not after Back, a sub-list or closing).
  function openSessionMenu() { showSessionKinds(true); }
  function showSessionKinds(ask) {
    menuRow = null;
    const hit = resolveRef(menuTask);
    const from = hit ? hit.from : source;
    const known = from.key === 'local' || Array.isArray(from.capabilities);
    const kind = ([agent, label]) => (runsAgent(from, agent)
      ? [label, () => void openAgentSessions(agent, label), null, false, () => void startSession({ agent }), false, { icon: agent, note: KIND_NOTES[agent] ? tr(KIND_NOTES[agent]) : '' }]
      : [label, null, null, false, null, true, { icon: agent, note: known ? tr(`${sourceName(from)} needs an update first`) : KIND_NOTES[agent] ? tr(KIND_NOTES[agent]) : '' }]);
    showSessionMenu(null, [
      ...SESSION_KINDS.filter(([agent]) => !AFTER_TERMINAL.has(agent)).map(kind),
      ['New Terminal', () => void startSession({}), null, false, () => void startSession({}), false, { icon: 'shell' }],
      ...SESSION_KINDS.filter(([agent]) => AFTER_TERMINAL.has(agent)).map(kind),
    ]);
    if (known || !ask) return;
    const shown = ui.get().menu;
    readInfo(from).catch(() => { /* an offline Engine: the row stays greyed */ }).finally(() => { if (ui.get().menu === shown) showSessionKinds(false); });
  }
  ui.actions.openSessionMenu = openSessionMenu;
  // A choice of the New session dialog. The dialog stays while the terminal is made (busy: nothing in it can be pressed and it cannot be closed), shows a failure in
  // place, and closes when the terminal is there; the new terminal opens and the phone's task sheet closes, as before.
  async function startSession(options) {
    const menu = ui.get().menu;
    if (!menu || !menu.naming || menu.busy) return;
    const title = takeName();
    const command = options.agent ? '' : newCommand.trim(); // only a plain terminal runs an initial command
    const run = (creating += 1);
    const patchMenu = patch => ui.set(state => ({ menu: state.menu && { ...state.menu, ...patch } }));
    patchMenu({ busy: true, error: '' });
    let made = false;
    let failure = null;
    try { made = await createTerminal({ ...options, ...(title ? { title } : {}), ...(command ? { command } : {}) }); } catch (error) { failure = error; }
    if (run !== creating) return; // the dialog was closed meanwhile (another task was selected, the task left the list)
    if (failure) { patchMenu({ busy: false, error: tr(`Could not create the terminal: ${failure.message}`) }); return; }
    if (made && command && typeof ui.actions.startCommandUsed === 'function') ui.actions.startCommandUsed(command); // the Recent menu (start-commands.mjs)
    closeTerminalMenu();
    if (made) closeTasks();
  }
  // The "+" of any task: a task that is not shown is selected first (the phone's sheet stays open), then the New session dialog adds a session to it.
  ui.actions.addSession = ref => {
    const hit = resolveRef(ref);
    if (!hit) return;
    const { from, item } = hit;
    const own = taskRef(from, item.id);
    if (!isShown(from, item.id)) selectTask(from, item, null, { stay: true });
    else if (!expanded.has(own)) { expanded.add(own); renderTasks(); } // as for a task that is not selected: its sessions are listed, so the new one is seen there
    menuTask = own;
    newName = ''; // a new dialog starts with an empty name
    newCommand = '';
    openSessionMenu();
  };

  // ── Mind maps (public/js/mindmap.js): a full-window view over the terminal, independent of the tasks; the terminal stays connected underneath ──
  const mindmapView = $('h5-mindmap');
  // The services whose maps the view lists: the same ones, in the same order, as the task list (a device hidden from the list is left out). Until the
  // services and what is hidden are known, none: the view says "Loading…", so a hidden device's maps never flash by.
  const mindmapSources = () => (listReady ? listedSources() : []).map(from => ({ key: from.key, label: sourceName(from), base: from.mindmapBase, online: from.status !== 'offline', instanceId: from.instanceId || null }));
  function syncMindmapSources() {
    const list = mindmapSources();
    const text = JSON.stringify(list);
    // `publishSources` runs on every selection; a view hears only of a real change
    if (mindmap && text !== mindmapSourcesSent) { mindmapSourcesSent = text; mindmap.setSources(list); }
    if (mindmapTab && text !== mindmapTab.sent) { mindmapTab.sent = text; mindmapTab.view.setSources(list); }
  }
  // The phone's bottom navigation (BottomNav.jsx, `html[data-bnav]` while it is shown): the full-window views end above it.
  const bottomNavSpace = () => {
    if (!document.documentElement.hasAttribute('data-bnav')) return 0;
    const bar = document.getElementById('h5-bnav');
    return bar ? bar.getBoundingClientRect().height : 0;
  };
  // The same height rule as fitViewport: visualViewport.height is believed only while something that raises a keyboard is focused (iOS Home Screen apps report wrong small heights).
  function fitMindmapView() {
    const viewport = window.visualViewport;
    const offset = viewport ? viewport.offsetTop : 0;
    const visible = viewport ? offset + viewport.height : window.innerHeight;
    const typing = pointerMode() || keyboardOpen || raisesKeyboard(document.activeElement);
    const bottom = (typing ? visible : Math.max(visible, window.innerHeight)) - bottomNavSpace();
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
    ui.set({ mindmapLayers: [], mindmapOpen: false });
  }
  ui.actions.closeMindmaps = () => { if (mindmap) { void mindmap.flush(); closeMindmaps(); } }; // the bottom navigation's other destinations (a waiting save is sent)
  // While the top page shows its columns, its own view would be hidden under them: the view's Mind maps tab is shown instead (Columns.jsx). A pane
  // shows no mind map: it asks the top page for that tab.
  function openMindmaps() {
    if (mindmap) return;
    if (PANE) { PANE.post('mindmaps'); return; }
    if (columnsShown() && ui.actions.showColumnsTab) { ui.actions.showColumnsTab('maps'); return; }
    if (!isWide()) closeTasks();
    mindmapView.hidden = false;
    window.visualViewport?.addEventListener('resize', fitMindmapView);
    window.visualViewport?.addEventListener('scroll', fitMindmapView);
    const list = mindmapSources();
    mindmapSourcesSent = JSON.stringify(list);
    mindmap = MindMap.mount(mindmapView, { onClose: closeMindmaps, notify: (message, kind) => tell(message, kind), onLayers: layers => ui.set({ mindmapLayers: layers }), sources: list });
    ui.set({ mindmapOpen: true });
    fitMindmapView();
  }
  ui.actions.openMindmaps = openMindmaps;
  // The Mind maps tab of the multi-column view (Columns.jsx `MapsTab`): the same view, mounted inside the tab's area right of the navigation rail
  // (`split`: the list of maps beside the open map) instead of over the whole window. It is mounted the first time the tab is shown and stays while the
  // view is shown, hidden when the Columns tab is (the open map and the list keep their state); `setActive` tells it whether its keys are its own.
  // The full-window view of the normal page, if it is still open under the strip, is closed first: one editor at a time.
  ui.actions.mountMindmapTab = (host, active = true) => {
    if (!host || mindmapTab) return;
    if (mindmap) { void mindmap.flush(); closeMindmaps(); }
    const list = mindmapSources();
    mindmapTab = { sent: JSON.stringify(list), view: null };
    mindmapTab.view = MindMap.mount(host, { embedded: true, active, onClose: () => {}, notify: (message, kind) => tell(message, kind), sources: list });
  };
  ui.actions.unmountMindmapTab = () => {
    if (!mindmapTab) return;
    const { view } = mindmapTab;
    mindmapTab = null;
    void view.flush({ keepalive: true }); // the request starts at once; the draft stays on this device anyway
    view.destroy();
  };
  ui.actions.setMindmapTabActive = on => { if (mindmapTab) mindmapTab.view.setActive(on); };
  // A page that starts on the Mind maps tab drew the tab's element before this script ran: it is mounted now.
  const waitingTab = document.getElementById('h5-columns-maps-view');
  if (waitingTab) ui.actions.mountMindmapTab(waitingTab, Boolean(ui.get().columns && ui.get().columns.tab === 'maps'));

  // ── Agent chat: the same Claude / Codex sessions as a conversation view instead of a terminal. The task sheet neither lists nor creates chats; a chat link opens one (`openChatFromLink`). ──
  const agentView = $('h5-agent');
  const chatApi = { get: url => api('GET', url), post: (url, body) => api('POST', url, body), patch: (url, body) => api('PATCH', url, body), del: url => api('DELETE', url) };
  let agentChat = null;
  // The chat fills the screen below the page header (task name and settings), the same header the terminal has, and follows the
  // visual viewport so the on-screen keyboard never covers the composer. A pane has no header of its own (the column's header is the top page's).
  function fitAgentView() {
    const header = document.querySelector('.h5-header');
    const top = header ? header.getBoundingClientRect().bottom : 0;
    const viewport = window.visualViewport;
    const visible = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    // The same rule as fitViewport: without a keyboard a small reading is not believed. It ends above the phone's bottom navigation.
    const bottom = (pointerMode() || keyboardOpen || raisesKeyboard(document.activeElement) ? visible : Math.max(visible, window.innerHeight)) - bottomNavSpace();
    agentView.style.top = `${top}px`;
    agentView.style.height = `${Math.max(0, bottom - top)}px`;
  }
  // The phone's bottom navigation appeared or went away (BottomNav.jsx): the full-window views that end above it fit again (the terminal refits by itself:
  // its box changed size).
  ui.actions.fitAboveBottomNav = () => { if (mindmap) fitMindmapView(); if (agentChat) fitAgentView(); if (notebook) fitNotebookView(); };
  // Which chat of which task is shown. It is not brought back by a refresh: the page opens on a terminal, whatever earlier versions saved (the open flag of the
  // conversation on the server, `h5-agent:...` in localStorage).
  let agentFor = null;
  // Takes the chat view away.
  function hideAgent() {
    if (agentChat) agentChat.destroy();
    agentChat = null;
    agentFor = null;
    queueMicrotask(syncPresence); // the terminal under the chat may be in the foreground again
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
    queueMicrotask(syncPresence); // a terminal hidden under the chat is not in the foreground
  }
  // ── Shell notebook ("Shell notebook: the page" in docs/design/shell-notebook-page.md): a session row with agent 'notebook' has no terminal. Its view
  // (public/js/notebook.js, the bundle notebook-ui.js) lies over the terminal area as the chat does: below the page header, above the phone's bottom
  // navigation, following the visual viewport (the on-screen keyboard). It is not kept warm: another row or task unmounts it (what was typed is sent).
  const notebookHost = $('h5-notebook');
  const notebookApi = { get: url => api('GET', url), post: (url, body) => api('POST', url, body) };
  function fitNotebookView() {
    const header = PANE ? null : document.querySelector('.h5-header');
    const top = header ? header.getBoundingClientRect().bottom : 0;
    const viewport = window.visualViewport;
    const visible = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const bottom = (pointerMode() || keyboardOpen || raisesKeyboard(document.activeElement) ? visible : Math.max(visible, window.innerHeight)) - bottomNavSpace();
    notebookHost.style.top = `${top}px`;
    notebookHost.style.height = `${Math.max(0, bottom - top)}px`;
  }
  // What the page header shows for the notebook (Header.jsx): its path and save state, the shell's state, and its menu.
  const notebookHeader = status => ({ path: (status && status.path) || '', saved: (status && status.saved) || '', live: Boolean(status && status.live), kernel: status ? status.kernel : null });
  function showNotebook(row) {
    const from = source;
    const current = task;
    const key = warmKey(from, current.id, row.terminal_id);
    if (earlySocket && earlySocket.source === from && earlySocket.taskId === current.id && earlySocket.terminalId === row.terminal_id) dropEarlySocket(); // it never becomes a terminal
    ui.set({ empty: null });
    if (notebook && notebook.key === key) { fitNotebookView(); return; }
    closeNotebook();
    notebookHost.hidden = false;
    window.visualViewport?.addEventListener('resize', fitNotebookView);
    window.visualViewport?.addEventListener('scroll', fitNotebookView);
    fitNotebookView();
    const mine = { key, source: from, taskId: current.id, terminalId: row.terminal_id, view: null, status: null };
    notebook = mine;
    mine.view = Notebook.mount(notebookHost, {
      api: notebookApi, base: `${from.tasksBase}/${current.id}/notebooks/${encodeURIComponent(row.terminal_id)}`, notebookId: row.terminal_id,
      title: row.title, taskTitle: current.title, embedded: Boolean(PANE), active: true,
      notify: (message, kind) => tell(message, kind || 'error'),
      onTitle: title => {
        const entry = isShown(from, current.id) ? terminals.find(item => item.terminal_id === row.terminal_id) : null;
        if (entry && title && entry.title !== title) { entry.title = title; renderTabs(); }
      },
      onStatus: status => {
        if (notebook !== mine) return;
        mine.status = status;
        ui.set({ notebook: notebookHeader(status) });
        renderTasks();
      },
      onOpenTerminal: () => void openTerminalBeside(from, current),
      // The row was deleted (here or on another device): the list is read again, which closes the view and shows another session.
      onGone: () => { if (notebook === mine && isShown(from, current.id)) terminalsLoaded = loadTerminals(); },
      onRename: () => renameShown(),
    });
    ui.set({ notebook: notebookHeader(null) });
    ackNotebook();
  }
  function closeNotebook() {
    if (!notebook) return;
    const { view } = notebook;
    notebook = null;
    view.destroy(); // sends what was typed first
    notebookHost.hidden = true;
    notebookHost.style.height = notebookHost.style.top = '';
    window.visualViewport?.removeEventListener('resize', fitNotebookView);
    window.visualViewport?.removeEventListener('scroll', fitNotebookView);
    ui.set({ notebook: null });
  }
  // A notebook whose cell finished while it is shown is seen (as `ackShown` does for a terminal).
  function ackNotebook() {
    if (!notebook || agentChat || document.visibilityState !== 'visible') return;
    api('POST', `${notebook.source.tasksBase}/${notebook.taskId}/terminal/ack`, { terminal_id: notebook.terminalId }).catch(() => { /* an older Engine, or offline */ });
  }
  // "Open in a terminal" of a cell whose program draws a full screen: a New Terminal in the same task, as the New session dialog makes it.
  async function openTerminalBeside(from, current) {
    if (!isShown(from, current.id)) return;
    try { await createTerminal({}); } catch (error) { tell(`Could not create the terminal: ${error.message}`, 'error'); }
  }
  // Rename of the session shown (the notebook's menu, a column's header): the task sheet opens with the name field in place of its row.
  function renameShown() {
    const row = task && terminalId && !agentChat ? terminals.find(entry => entry.terminal_id === terminalId) || null : null;
    if (!row) return false;
    ui.actions.openTasks();
    menuRow = row;
    menuScope = { from: source, taskId: task.id, row };
    menuRuns = [];
    menuCreate = -1;
    menuQuick = [];
    ui.set({ menu: { title: row.title, items: [], rename: { kind: 'terminal', id: row.terminal_id, task: taskRef(source, task.id) }, renameValue: row.title, naming: false, task: null, name: '', anchor: null } });
    return true;
  }
  // The menu of the page header while a notebook is shown (Header.jsx): Rename, Download .ipynb, Clear outputs, Stop shell, Restart shell.
  ui.actions.notebookAction = name => {
    if (name === 'rename') { renameShown(); return; }
    if (notebook) notebook.view.action(name);
  };

  async function openAgentSessions(agent, label) {
    const current = task;
    const from = source;
    showSessionMenu(label, [['Loading…', () => {}]]);
    const loading = ui.get().menu; // the answer belongs to this list only: not to one opened after this one was closed
    let rows = [];
    try { rows = await api('GET', `${from.tasksBase}/${current.id}/agent-sessions?agent=${agent}`); }
    catch (error) { if (current === task) tell(`Could not load sessions: ${error.message}`, 'error'); }
    if (current !== task || ui.get().menu !== loading) return;
    const start = sessionId => () => void startSession({ agent, session_id: sessionId });
    // A notebook's row says its file and when it last changed ("release-check.ipynb · 11-23 14:21"); New notebook makes notebooks/<name>.ipynb.
    const note = row => (agent === 'notebook' ? [String(row.id || '').split('/').pop(), sessionTime(row.updated_at)].filter(Boolean).join(' \u00b7 ') : sessionTime(row.updated_at));
    showSessionMenu(label, [
      [agent === 'notebook' ? 'New notebook' : `New ${label}`, start(undefined), null, true, null, false, { icon: agent }],
      // An OpenCode session still on its default title comes `untitled` (its title is then a piece of its id): it reads "Untitled session".
      ...(Array.isArray(rows) ? rows : []).map(row => (row.untitled
        ? ['Untitled session', start(row.id), null, false, null, false, { icon: agent, note: note(row) }]
        : [row.title, start(row.id), 'raw', false, null, false, { icon: agent, note: note(row) }])),
      ['Back', openSessionMenu, null, false, null, false, { icon: 'back' }],
    ]);
  }

  // Makes a terminal in the selected task and opens it. Resolves to true when it was made and opened, false when there is nothing more to do (no task, another task
  // was selected meanwhile, the task was archived on another device); rejects with the server's error, which the New session dialog shows.
  async function createTerminal(options = {}) {
    if (!task) return false;
    const current = task;
    const from = source;
    leaveChat();
    try {
      await terminalsLoaded; // a new one made while the list is on its way is not wiped by that list (a task with no terminal answers an empty one)
      if (current !== task) return false;
      const row = await api('POST', `${from.tasksBase}/${current.id}/terminals`, options);
      if (!row || !row.terminal_id) throw new Error('The engine returned no terminal');
      if (current !== task) return false;
      // A notebook file that already has a row answers that row (`existing: true`): it is opened, not listed twice.
      if (!terminals.some(entry => entry.terminal_id === row.terminal_id)) terminals.push(row);
      terminalId = row.terminal_id;
      store.set(`terminal:${from.key}:${current.id}`, terminalId);
      renderTabs();
      connect();
      return true;
    } catch (error) {
      if (error.message === 'TASK_ARCHIVED') { archivedElsewhere(from, current.id); return false; }
      throw error;
    }
  }

  const connected = s => Boolean(s && s === session && !s.paused && s.ws && s.ws.readyState === WebSocket.OPEN);
  function send(s, data) {
    if (uploading || !connected(s)) return false;
    s.imePairs?.observe(data); // an Enter, Ctrl+C or Ctrl+U from any path: the next auto-paired quote opens again
    s.ws.send(data);
    // Input (typed, a key of the key bar or the on-screen keyboard, a paste) brings the cursor of a wide terminal back into view. A mouse report (a
    // wheel step, a click or a motion report for a program in mouse mode) points at a cell the person sees, so it leaves the view where it is.
    if (!TerminalGestures.isMouseReport(data)) {
      s.follow = true;
      followCursor(s);
    }
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
  // The link bar's queue ("Links opened by programs" below): declared here, because hideShown can run before that part of the script.
  const LINK_TTL_MS = 30000;
  const LINK_QUEUE_MAX = 5;
  let links = [];
  let linkIds = 0;
  let linkTimer = 0;
  let linkHold = { on: false, round: 0 };
  // The notice "This terminal is in use on another device" of a session (terminal-owner.js `prompt`, drawn over the box all terminals share).
  function clearOwnerPrompt(s) {
    if (!s.ownerPrompt) return;
    s.ownerPrompt();
    s.ownerPrompt = null;
  }
  function hideShown() {
    const s = session;
    session = null;
    if (!s) return;
    s.el.hidden = true;
    s.term.blur();
    clearOwnerPrompt(s); // its "in use on another device" notice sits on the box every terminal shares: it must not stay over the next one (showing it again connects again and asks again)
    s.clipboard?.dismiss(); // a copy request of a terminal that is no longer shown goes away
    dropLinks(s); // and so do its links waiting on the link bar
    scheduleWheelSync();
    syncPresence();
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
    syncPresence();
  }
  // ── Foreground presence (`{ type: 'presence', foreground }`, a binary control frame; routes/terminal.js, lib/terminal-presence.js) ──
  // Every connected terminal socket tells the server whether this terminal is in the foreground: it is the one shown in this page (not hidden
  // under a chat), the page is visible, and the person used the page (pointerdown, keydown, touchstart, wheel, input; loading the page counts) in
  // the last PRESENCE_IDLE_MS. The T-Attention notifiers send nothing for a session in the foreground. It is sent once after every (re)connect (with the
  // history snapshot) and then only when the value changes: a terminal shown or hidden, a chat opened or closed, visibilitychange, the idle timer
  // running out, activity after it ran out. Only to a server that speaks the binary protocol: an old text-protocol server would type it into the shell.
  // In the multi-column view each pane is a page of its own with its own sockets and visibility; the activity is shared by the top page and all
  // its panes (one record on the top window, `__tAgentActivity`), so using one column keeps every visible column in the foreground.
  // A page that is left (pagehide: the app switched, the tab closed or put in the page cache) says false at once, even where the browser still
  // reports it visible; the server also stops believing a "true" from a socket that went quiet (a frozen page sends no pings, lib/terminal-presence.js).
  // The agent chat shown over the terminal reports the same rule for its own session (`setForeground` of the chat, POST .../presence).
  const PRESENCE_IDLE_MS = 5 * 60 * 1000;
  let pageLeft = false;
  const activity = (() => {
    if (PANE) { try { const shared = window.top.__tAgentActivity; if (shared && shared.listeners) return shared; } catch { /* no shared record: own one */ } }
    const own = { at: Date.now(), listeners: new Set() };
    if (!PANE) window.__tAgentActivity = own;
    return own;
  })();
  const activeNow = () => Date.now() - activity.at < PRESENCE_IDLE_MS;
  function noteActivity() {
    const now = Date.now();
    const before = activity.at;
    activity.at = now;
    if (now - before < 1000) return; // nobody changes state within a second; the idle timers read `at` when they fire
    for (const fn of [...activity.listeners]) { try { fn(); } catch { activity.listeners.delete(fn); } }
  }
  for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'input']) document.addEventListener(type, noteActivity, { capture: true, passive: true });
  let idleTimer = 0;
  function onActivityChange() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    const left = activity.at + PRESENCE_IDLE_MS - Date.now();
    if (left > 0) idleTimer = setTimeout(onActivityChange, left + 50);
    syncPresence();
  }
  activity.listeners.add(onActivityChange);
  window.addEventListener('pagehide', () => { activity.listeners.delete(onActivityChange); pageLeft = true; syncPresence(); });
  window.addEventListener('pageshow', () => { pageLeft = false; activity.listeners.add(onActivityChange); onActivityChange(); }); // back from the page cache
  document.addEventListener('visibilitychange', () => syncPresence());
  const foregroundOf = s => !pageLeft && shownTerminal() === s && activeNow();
  const chatForeground = () => Boolean(agentChat) && !agentView.hidden && !pageLeft && document.visibilityState === 'visible' && activeNow();
  function sendPresence(s, force = false) {
    const ws = s.ws;
    if (s.disposed || !ws || ws.readyState !== WebSocket.OPEN || TerminalProtocol.state(ws).mode !== 'binary') return;
    const foreground = foregroundOf(s);
    if (!force && s.presenceWs === ws && s.presence === foreground) return;
    s.presenceWs = ws;
    s.presence = foreground;
    try { TerminalProtocol.send(ws, { type: 'presence', foreground }); } catch { /* closing */ }
  }
  function syncPresence() {
    for (const s of warm) sendPresence(s);
    if (agentChat && agentChat.setForeground) agentChat.setForeground(chatForeground());
  }
  queueMicrotask(onActivityChange); // starts the idle timer once the whole page script has run

  // Closes the warm sessions of one terminal (it is restarted or deleted), or all of them.
  function closeWarm(match = () => true) {
    for (const s of warm.filter(match)) disposeSession(s);
  }

  function connect() {
    hideShown();
    if (!task || !terminalId || columnsShown()) { closeNotebook(); return; } // the multi-column view shows its own columns: this page opens no terminal (see below)
    // A shell notebook has no terminal socket: its view is mounted over the terminal area instead (`showNotebook`).
    const shownRow = terminals.find(row => row.terminal_id === terminalId);
    if (shownRow && shownRow.agent === 'notebook') { showNotebook(shownRow); return; }
    closeNotebook();
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
      fontSize: terminalFontSize(), // 13px on a computer, 12px on a phone
      fontFamily: TERMINAL_FONT_FAMILY,
      theme: { background: '#121212' },
      scrollback: 5000,
      // Hyperlinks printed by programs with OSC 8 (the visible text may differ from the real address): only http(s) is opened, after
      // the real address is confirmed; any other scheme (javascript:, data:, file:) is ignored silently.
      linkHandler: {
        allowNonHttpProtocols: false,
        activate(event, uri) {
          if (!/^https?:\/\//i.test(uri)) return;
          // Where the person is: the Mac app's default browser, Safari / the default browser from a Home Screen app (open-link.js).
          if (window.confirm(`${tr('Open this link?')}\n\n${uri}`)) OpenLink.open(uri);
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
    // Pasted images or files (long-press paste in the xterm textarea, files copied in the file manager) are uploaded like picked ones, all of them
    // in order (at most UPLOAD_MAX_FILES, checked by upload); plain text keeps xterm's own paste.
    el.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.items || [])].filter(entry => entry.kind === 'file');
      if (!files.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!uploading) void upload(s, files.map(entry => entry.getAsFile()));
    }, true);
    // An input method's auto-paired “” or 【】 followed by its Left key becomes one character (terminal-ime-pairs.js); all of xterm's data goes through it.
    s.imePairs = TerminalImePairs.attach(term, data => typed(s, data));
    term.onData(data => s.imePairs.forward(data));
    TerminalIme.attach(term, data => s.imePairs.forward(data)); // the Apple Chinese keyboard's spaces and punctuation, which xterm drops
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
  // A layer that opened by itself before the terminal took the focus (the "Updated to v…" dialog, UpdatedNotice.jsx) hands it back here once it is gone.
  ui.actions.focusTerminal = () => { if (session && !session.disposed) focusTerminalSoon(session); };
  // The wheel strip: a scrollbar on the right edge of the terminal (drawn by the shell, scripts/h5-shell/Terminal.jsx; touch mode only).
  // Its mode (`data-mode`) follows the shown terminal's buffer:
  // - 'bar' (normal buffer with history): a thumb whose size is rows / (rows + scrollback in use) and whose position is viewportY / baseY.
  //   Dragging the thumb moves the view like a scrollbar (down = newer, up = older), mapped 1:1 to the buffer; a tap on the track above or
  //   below the thumb scrolls one page. The thumb also follows scrolling done elsewhere (new output, a native drag on the body, keys).
  // - 'spring' (alternate buffer: Claude Code, Codex, vim, tmux ...; the page cannot know the program's position): the thumb rests in the
  //   middle; pulling it down scrolls down (newer), up scrolls up (older), faster the further it is pulled; released, it springs back. The
  //   steps are wheel events, which xterm forwards the way a desktop wheel would (mouse reports, or arrow keys without mouse mode). They point at the
  //   middle of the visible terminal, not at the strip: a program that scrolls the pane under the mouse (opencode) has its main content there, and
  //   the strip's own x is over its right-most columns (opencode's sidebar, which does not scroll the messages).
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
      const box = drag.s.el.getBoundingClientRect(); // the visible terminal (a wide screen is moved inside it)
      scrollStep(drag.s, lines, box.left + box.width / 2, rect.top + rect.height / 2);
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
      drag = { id: event.pointerId, el, s, mode, y: event.clientY, moved: 0, started: now, seen: now, stale: false, onThumb: false, grab: 0, dragging: false,
        x0: event.clientX, y0: event.clientY, line0: s.term.buffer.active.viewportY, axis: null };
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
      // A slide to the left takes the mouse ball out of the strip ("Mouse ball" in docs/design/page-terminal-mouse-ball.md; its chunk registers
      // `stripMouse`). The axis is decided in the first px of travel and kept; until then the drag scrolls as always, and a bar scroll is undone
      // when it becomes the mouse. From then on the ball's chunk has the finger (the strip keeps the pointer capture).
      const mouse = ui.actions.stripMouse;
      if (!drag.axis && mouse && (drag.axis = mouse.axis(event.clientX - drag.x0, event.clientY - drag.y0)) === 'mouse') {
        if (drag.mode === 'bar' && s.term.buffer.active.viewportY !== drag.line0) s.term.scrollToLine(drag.line0);
        syncWheel();
        if (mouse.begin({ id: drag.id, el: drag.el, from: { x: drag.x0, y: drag.y0 }, at: { x: event.clientX, y: event.clientY }, sync: syncWheel })) { drop(); return; }
      }
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
    // A mouse wheel or trackpad over the strip (a touch screen that also has a mouse or trackpad: the strip is drawn in input mode 'touch') goes to the
    // terminal under it at the same point, as if the strip were not there: xterm scrolls, or reports the cell under the pointer to the program, and a
    // sideways wheel moves the wide terminal. A pinch (ctrlKey) stays the browser's.
    document.addEventListener('wheel', event => {
      const el = strip(event);
      if (!el || event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const old = el.style.pointerEvents;
      el.style.pointerEvents = 'none';
      const under = document.elementFromPoint(event.clientX, event.clientY);
      el.style.pointerEvents = old;
      if (!under || (under.closest && under.closest('#h5-wheel'))) return;
      const { deltaX, deltaY, deltaZ, deltaMode, clientX, clientY, screenX, screenY, shiftKey, altKey, metaKey, buttons } = event;
      under.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, view: window, deltaX, deltaY, deltaZ, deltaMode, clientX, clientY, screenX, screenY, shiftKey, altKey, metaKey, buttons }));
    }, { capture: true, passive: false });
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

  // ── Sideways: the wide terminal (public/js/terminal-gestures.js; "Terminal width" in docs/design/page-terminal-and-bottom-bar.md) ──
  // Terminal width, one setting for this device (localStorage): 'fit' gives the PTY the columns that fit the screen; 'wide' gives it `cols`
  // (200 / 500 / 1000 / 2000, never fewer than fit), so programs that wrap their own output (Claude Code, Codex) keep whole sentences, and the screen,
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
    clearOwnerPrompt(s);
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
        if (message.type === 'history') { replay(s, ws, message); sendPresence(s, true); } // once after every (re)connect
        else if (message.type === 'open-link') offerLink(s, ws, message);
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
        clearOwnerPrompt(s);
        s.ownerPrompt = TerminalOwner.prompt(s.el.parentElement || s.el, event.code, () => { s.ownerPrompt = null; if (session === s && !s.disposed) open(s, true); });
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
    closeNotebook();
  }
  // ── Multi-column view (scripts/h5-shell/Columns.jsx) ──
  // While the column strip of a wide screen is shown, every column is an iframe of this page in pane mode, with its own terminals. This page's own
  // terminal is hidden under the strip, so it holds no socket: the warm terminals and an early socket are closed, `connect` opens nothing, and
  // going back connects the task and terminal that were shown before (they stay selected). The feed, notices, notifications and updates go on here.
  function columnsShown() { return Boolean(ui.get().columns && ui.get().columns.shown); }
  let columnsParked = columnsShown();
  ui.subscribe(() => {
    const shown = columnsShown();
    if (shown === columnsParked) return;
    columnsParked = shown;
    if (shown) { ui.actions.closeSwitcher(); dropEarlySocket(); closeWarm(); closeNotebook(); return; }
    setTimeout(() => { if (!columnsShown()) connect(); }, 0); // after the shell has drawn the page again, so the terminal box has its size
  });
  function disposeSession(s) {
    if (s.disposed) return;
    keepPreview(s); // what it showed last, for its card in the switcher
    if (session === s) session = null;
    warm = warm.filter(item => item !== s);
    clearOwnerPrompt(s);
    s.disposed = true;
    scheduleWheelSync();
    s.gestures?.dispose();
    clearTimeout(s.timer);
    s.imePairs?.dispose();
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
    if (!s) { ackNotebook(); return; }
    api('POST', `${s.source.tasksBase}/${s.task.id}/terminal/ack`, { terminal_id: s.terminalId }).catch(() => { /* an older Engine, or offline: it stays pending */ });
  }

  // ── Terminal activity push (`GET {activityBase}/terminal-activity/stream`, server-sent events read with fetch) ──
  // The server sends `event: activity` with { activity, subagents } (the answers of the two polling endpoints) on connect and on every change
  // (lib/terminal-activity-stream.js). It drives the count on #h5-cycle, the next-session button and the "done" ack of the shown terminal.
  // fetch, not EventSource, so the status is seen: 404 / 405 / 501 means an Engine older than the stream (also through the remote proxy), and the page then
  // polls slowly instead (FALLBACK_POLL_MS). Other failures reconnect with a backoff (1 s doubling to 30 s), polling slowly meanwhile. A stream that is
  // silent for STALL_MS (the server sends a comment every 20 s) is taken as dead. The stream is closed while the page is hidden and opened again, with a
  // fresh snapshot, when it is shown: nothing on a hidden page needs the state, and phones drop background connections anyway. Each tab has its own stream.
  // This machine's stream asks for `?state=1`: the shared page state rides on it (`event: page-state`, given to TAPageState.pushed), so a change made
  // on another device or engine shows here in about a second ("The page push" in docs/design/shared-page-state.md); a pane opens no stream.
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
  // -> [activity, subagents, waiting_kind]. `?kinds=1` answers { activity, waiting_kind }; an older Engine answers the bare activity (task ids are
  // numbers, so it has no "activity" key) and no kinds.
  async function readActivity(from) {
    const [answer, subagents] = await Promise.all([
      api('GET', `${from.activityBase}/terminal-activity?kinds=1`),
      api('GET', `${from.activityBase}/terminal-subagents`).catch(() => ({})), // an Engine older than this feature: no sub-agent information
    ]);
    const withKinds = Boolean(answer && answer.activity && typeof answer.activity === 'object');
    return [withKinds ? answer.activity : answer, subagents, withKinds ? answer.waiting_kind : null];
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
      if (waitKind(snap, taskId, id)) pending += 1; // both kinds of question count as Needs you
      else if (states[id] === 'running' || Number(subs[id]) > 0) running += 1;
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
    publishActivity();
  }
  // The running ('running', also a running sub-agent), waiting ('select' / 'accept': at that kind of question) and finished-not-seen ('done') terminals of
  // every listed service, for the rail of a maximized column, the column headers, the session header, the Recent list and the switcher (columns.mjs
  // `columnStatus`): `state.terminalActivity` = { sourceKey: { taskId: { terminalId: state } } }. Only the top page, which keeps the feeds; set only when it changed.
  function publishActivity() {
    if (PANE) return;
    const all = {};
    for (const from of listedSources()) {
      const snap = snapshotOf(from);
      if (!snap) continue;
      const tasks = {};
      for (const taskId of new Set([...Object.keys(snap.activity), ...Object.keys(snap.subagents)])) {
        const states = snap.activity[taskId] || {};
        const subs = snap.subagents[taskId] || {};
        const row = {};
        for (const id of new Set([...Object.keys(states), ...Object.keys(subs)])) {
          const kind = waitKind(snap, taskId, id);
          if (kind) row[id] = kind;
          else if (states[id] === 'running' || Number(subs[id]) > 0) row[id] = 'running';
          else if (states[id] === 'done') row[id] = 'done';
        }
        if (Object.keys(row).length) tasks[taskId] = row;
      }
      if (Object.keys(tasks).length) all[from.key] = tasks;
    }
    if (JSON.stringify(all) !== JSON.stringify(ui.get().terminalActivity || {})) ui.set({ terminalActivity: all });
  }
  function applyActivity(f, snap) {
    const from = f.source;
    if (feeds.get(from.key) !== f) return;
    const object = value => (value && typeof value === 'object' ? value : {});
    const next = { activity: object(snap && snap.activity), subagents: object(snap && snap.subagents), waiting_kind: object(snap && snap.waiting_kind) };
    const changed = JSON.stringify(next) !== JSON.stringify(f.snapshot);
    f.snapshot = next;
    showActiveCount();
    if (changed) renderTasks(); // the Running and Pending filters
    // The shown terminal finished while the person is looking at it: it is seen (a question stays until it is answered; the server keeps it).
    const s = shownTerminal();
    if (s && s.source === from && ((next.activity[s.task.id] || {})[s.terminalId]) === 'done' && !waitKind(next, s.task.id, s.terminalId)) ackShown();
    else if (!s && notebook && notebook.source === from && ((next.activity[notebook.taskId] || {})[notebook.terminalId]) === 'done') ackNotebook();
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
      try { const [activity, subagents, kinds] = await readActivity(from); applyActivity(f, { activity, subagents, waiting_kind: kinds }); } catch { checkSource(from); /* keep the last state */ }
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
      res = await fetch(`${from.activityBase}/terminal-activity/stream${from === LOCAL && PageState ? '?state=1' : ''}`, { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/event-stream' }, cache: 'no-store', signal: ctrl.signal });
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
          else if (event === 'page-state' && data && from === LOCAL && PageState && PageState.pushed) PageState.pushed(data);
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
  const modalOpen = () => Boolean(document.querySelector('.MuiModal-root:not(.MuiModal-hidden), dialog[open]')) || ui.get().copyText !== null || Boolean(ui.get().switcher);
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
  // Cmd+Shift+O (Apple) or Ctrl+Shift+O (others) opens the New session dialog for the task shown, on its own service, also from inside the terminal: this listens
  // in the capture phase, before xterm (Ctrl+O alone stays the terminal's). The browser's own Cmd/Ctrl+Shift+O (the bookmarks manager in Chrome and Firefox) is
  // prevented whenever the page gets the key. With no task shown, another dialog, a menu or the copy view open (the phone's task sheet does not count), it does
  // nothing; a held key opens the dialog once.
  const otherModalOpen = () => Boolean(document.querySelector('.MuiModal-root:not(.MuiModal-hidden):not(#h5-tasks), dialog[open]')) || ui.get().copyText !== null;
  document.addEventListener('keydown', event => {
    if (mindmap || !deskKeys() || event.defaultPrevented || !event.shiftKey || event.altKey) return;
    if (APPLE ? !(event.metaKey && !event.ctrlKey) : !(event.ctrlKey && !event.metaKey)) return;
    const key = (event.key || '').toLowerCase();
    if (key !== 'o' && !(event.code === 'KeyO' && !/^[a-z]$/.test(key))) return; // another layout: the key in the place of O
    const menu = ui.get().menu;
    const already = Boolean(menu && menu.naming); // the dialog is open already: the key stays with it
    if (!already && (!task || otherModalOpen())) return;
    event.preventDefault();
    event.stopPropagation();
    if (already || event.repeat) return;
    ui.actions.addSession(taskRef(source, task.id));
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
  // `files`: one File or an array of them (a paste can carry several); upload takes them all in order.
  function pasteImage(target, files) {
    if (!uploading && target && !target.disposed) void upload(target, files);
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
  // `files`: the pasted Files in order (PasteDialog), or a single File.
  ui.actions.pasteSheetFile = files => {
    const target = pasteSheet ? pasteSheet.target : session;
    const list = Array.isArray(files) ? files : [files];
    if (!list.some(Boolean)) return;
    closePasteSheet();
    pasteImage(target, list);
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
  // The last non-empty lines of the terminal shown, for the peek card of this column's tile in the top page's rail (pane.mjs `peek`); none under a chat.
  ui.actions.paneTail = count => {
    if (!session || session.disposed || agentChat || !session.term) return [];
    return bufferText(session.term).split('\n').filter(line => line.trim()).slice(-count);
  };
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
  // ── Mouse ball (docs/design/page-terminal-mouse-ball.md; scripts/h5-shell/MouseBall.jsx, a chunk of its own) ──
  // It comes out of the wheel strip (a slide to the left, `bindWheelStrip`). The ball asks for the shown terminal at each touch: its xterm, its
  // screen, the copy path of the double tap (the same notice, the same refusal bar) and the gesture mark for a program's own copy, or null while no
  // terminal is shown (empty, the chat over it, the copy view, a notebook).
  ui.actions.mouseBallTarget = () => {
    const s = session;
    if (!s || s.disposed || s.el.hidden || !agentView.hidden || ui.get().copyText !== null) return null;
    const screen = s.el.querySelector('.xterm-screen');
    if (!screen) return null;
    return {
      term: s.term,
      el: s.el,
      screen,
      copy: text => s.clipboard?.copy(text), // call it inside the lift (pointerup): the write needs the user activation
      hookSelection: () => hookSelection(s), // new output clears the highlight, as after a double tap
      // The lift that releases a program's mouse button (the program copies on it): the user's gesture, so its OSC 52 copy is written at once.
      gesture: () => s.clipboard?.gesture(),
    };
  };
  // ── Links opened by programs (docs/design/open-links.md; routes/open-link.js and offerLink in routes/terminal.js) ──
  // A program in a terminal opened a web link; the server offers it to this page as { type: 'open-link', id, url, agent }. The page takes it
  // only when that terminal is in the foreground (the one shown, the page visible and used lately: the presence rule) and answers
  // { type: 'open-link-result', id, shown } at once; when it says no, the engine opens the link as before. The Mac app opens a taken link at
  // once (OpenLink); elsewhere the link bar (`state.openLink`) waits for Open, which opens inside its click. Links in a row queue (at most
  // LINK_QUEUE_MAX, the bar shows the first and "+N"); the bar of a link goes away after LINK_TTL_MS like Dismiss (held while a mouse is
  // over it or the focus is in it), and the links of a terminal that is hidden go away with it.
  // (The queue's state is declared next to the warm terminals: hideShown runs before this part of the script.)
  function showLinks() {
    clearTimeout(linkTimer);
    const first = links[0];
    if (first && !linkHold.on) linkTimer = setTimeout(() => dropLink(first), LINK_TTL_MS);
    ui.set({ openLink: first ? { id: first.id, url: first.url, program: first.program, more: links.length - 1, ttl: LINK_TTL_MS, holding: linkHold.on, round: linkHold.round } : null });
  }
  function dropLink(item) {
    if (!item || !links.includes(item)) return;
    links = links.filter(other => other !== item);
    if (!links.length) linkHold = { on: false, round: 0 };
    showLinks();
  }
  function dropLinks(s) {
    if (!links.some(item => item.s === s)) return;
    links = links.filter(item => item.s !== s);
    showLinks();
  }
  function offerLink(s, ws, message) {
    const shown = typeof OpenLink !== 'undefined' && OpenLink.valid(message.url) && foregroundOf(s);
    try { TerminalProtocol.send(ws, { type: 'open-link-result', id: message.id, shown }); } catch { /* closing */ }
    if (!shown) return;
    const env = OpenLink.environment();
    if (env.app) { OpenLink.open(message.url, env); return; }
    links = [...links, { id: ++linkIds, s, url: message.url, program: OpenLink.programName(message.agent) }].slice(-LINK_QUEUE_MAX);
    showLinks();
  }
  // Open on the bar: inside this click's user activation.
  ui.actions.openLinkOpen = () => {
    const item = links[0];
    dropLink(item);
    if (item && item.s === session && !item.s.disposed) OpenLink.open(item.url);
  };
  ui.actions.openLinkCopy = () => {
    const item = links[0];
    if (!item) return;
    dropLink(item);
    void TerminalClipboard.writeText(item.url).then(ok => tell(ok ? 'Link copied' : 'Could not copy the link', ok ? 'success' : 'error'));
  };
  ui.actions.openLinkDismiss = () => dropLink(links[0]);
  ui.actions.openLinkHold = on => {
    if (!links.length || linkHold.on === Boolean(on)) return;
    linkHold = { on: Boolean(on), round: linkHold.round + (on ? 0 : 1) };
    showLinks();
  };

  // The copy bar (terminal-clipboard.js, `state.clipboard`): a program's copy waiting for Copy, or a copy the browser refused (kind tap).
  // The button writes inside its own tap, Cancel drops it; it hides by itself after TerminalClipboard.BAR_TTL_MS.
  if (typeof TerminalClipboard !== 'undefined') TerminalClipboard.setHost({ show: request => ui.set({ clipboard: request }) });
  ui.actions.clipboardConfirm = () => { if (typeof TerminalClipboard !== 'undefined') void TerminalClipboard.confirm(); };
  ui.actions.clipboardCancel = () => { if (typeof TerminalClipboard !== 'undefined') TerminalClipboard.cancel(); };
  // The user is on the bar (a mouse over it, the keyboard focus inside it): the bar does not hide by itself until they leave it.
  ui.actions.clipboardHold = on => { if (typeof TerminalClipboard !== 'undefined') TerminalClipboard.hold(on); };

  // A tap on a key of the key bar (the shell keeps the focus where it is, so tapping keys does not open or close the on-screen keyboard).
  // "Edit before sending" (the pencil of a saved command): types the command into the terminal like a paste, WITHOUT Enter, so the user can add to it.
  // Returns whether it was typed (the list counts it as a use only then).
  ui.actions.insertCommand = command => {
    if (uploading || !connected(session)) { tell('The terminal is not connected', 'error'); return false; }
    session.clipboard?.gesture();
    session.term.paste(command);
    return true;
  };
  // A tap on a saved command: types it as the send arrow types text (`sendTyped`: a short line goes in as keys, so a "/command" acts as typed), then one
  // Enter after SUBMIT_DELAY_MS, as translate-and-send does. No confirmation, /clear included (the user's decision). Returns whether it was sent.
  ui.actions.sendCommand = command => {
    const target = session;
    if (uploading || !connected(target)) { tell('The terminal is not connected', 'error'); return false; }
    target.clipboard?.gesture();
    if (!sendTyped(target, command)) return false;
    setTimeout(() => send(target, '\r'), SUBMIT_DELAY_MS);
    return true;
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
  // The touch draft box (one row with its send buttons, "Draft box" in docs/design/page-terminal-and-bottom-bar.md) stops at PHONE_MAX_LINES lines instead,
  // so the terminal above it keeps its room while the system keyboard is up.
  // Called on input, on focus changes, after a send, when the viewport changes and at start.
  const TRANSLATE_MAX_VIEWPORT_FRACTION = 0.5;
  const PHONE_MAX_LINES = 4;
  let oneLineInput = 0;
  // A column of the multi-column view has the compact bottom area (Terminal.jsx CompactBottom): one row whose draft box is always shown and grows
  // upward over the terminal, like a computer's. A column that is not the focused one keeps its box on one line (a window that lost the focus keeps
  // its active element, so the focus alone cannot tell), and the box's text on one line is published for the "Draft" tag (`draftPeek`).
  const COMPACT_ROW = Boolean(PANE);
  const restingColumn = () => COMPACT_ROW && !ui.get().paneFocused;
  const draftLine = text => String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
  function publishDraft() {
    if (!COMPACT_ROW) return;
    const line = draftLine(translateInput.value);
    if (ui.get().draftPeek !== line) ui.set({ draftPeek: line });
  }
  function autosize() {
    const input = translateInput;
    publishDraft();
    input.style.height = '';
    input.style.overflowY = 'hidden';
    oneLineInput = input.offsetHeight; // rows=1 with no height set: the one-line box (the resting line that a computer's layout keeps room for)
    // One line while the box is empty, or while it has no focus (keyboard dismissed): the text stays in the box, clipped to the first line, and is shown in full again on focus.
    // A pressed bar button (data-hold) keeps the current size so the button does not move under the finger.
    const resting = restingColumn() || (document.activeElement !== input && !translateForm.hasAttribute('data-hold'));
    if (!input.value || resting) { if (resting) input.scrollTop = 0; syncBar(); return; } // the natural height of rows=1
    const style = getComputedStyle(input);
    const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 15) * 1.4375;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    const visible = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const phoneBox = !pointerMode() && !COMPACT_ROW;
    const fitLines = Math.max(2, Math.floor((visible * TRANSLATE_MAX_VIEWPORT_FRACTION - padding) / lineHeight));
    const maxLines = phoneBox ? Math.min(PHONE_MAX_LINES, fitLines) : fitLines; // a phone on its side keeps the half-viewport cap too
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
  // Does the terminal's input line already hold typed text? Read from the xterm screen (public/js/terminal-input-line.js); a line it cannot understand counts
  // as empty, which keeps the plain send.
  function inputLineHasText(target) {
    try {
      return Boolean(window.TerminalInputLine && target.term && TerminalInputLine.read(target.term.buffer.active).hasText);
    } catch { return false; }
  }
  // The owner's rule: when the input line is empty the translation is typed as before; when it already has text, the translation goes on a NEW line after
  // it, and the caller's Enter then sends the whole input. The line break is a carriage return inside ONE bracketed paste (Claude Code, Codex and zsh take a
  // pasted line break as a new line, not as Enter). Without bracketed paste a line break would make a shell run the line, so a space joins the two instead.
  function sendTranslation(target, raw) {
    const text = pasteText(raw);
    if (!text) return false;
    if (inputLineHasText(target)) {
      if (bracketedPaste(target)) return send(target, `\x1b[200~\r${text.replace(/\n/g, '\r')}\x1b[201~`);
      return send(target, ` ${TerminalTranslate.sanitize(text)}`);
    }
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
  // (sendTyped), with no translation and no request to the translator. Both are followed by one Enter (after text already on the input line, the translation
  // goes on a new line first, so that Enter sends both). A box with only spaces sends nothing.
  // The box never blocks typing: while a translation runs the user can keep typing; after the send only the text that was sent is taken out of the box, and the
  // focus stays in the box. When the translation fails nothing is sent, the error is shown and the text stays in the box.
  async function submitBox(translateFirst) {
    const typed = translateInput.value;
    const text = typed.trim();
    if (translating || !text) return;
    const target = session;
    if (uploading || !connected(target)) { tell('The terminal is not connected', 'error'); return; }
    const draftId = drafts ? drafts.id : '';
    translating = true;
    ui.set({ translating: true });
    try {
      let outgoing = text;
      let translated = false;
      const taskTitle = task ? task.title : '';
      if (translateFirst) {
        const result = await api('POST', '/api/translate', { text });
        outgoing = result && result.text;
        translated = Boolean(result && result.translated !== false);
        if (!pasteText(outgoing)) throw new Error('Translation result is empty');
      } else if (!typedText(typed).trim()) throw new Error('Nothing to send');
      if (!(translateFirst ? sendTranslation(target, outgoing) : sendTyped(target, typed))) throw new Error('Terminal not connected; the text was not sent');
      setTimeout(() => send(target, '\r'), SUBMIT_DELAY_MS);
      // Sent after a real translation: the sentence becomes a study card ("Collection hooks" in docs/design/learn-english.md), in the background.
      if (translated && window.LearnCollect) window.LearnCollect.sentence(outgoing, text, taskTitle);
      const now = translateInput.value; // typed on while the translation ran: keep what came after the sent text
      translateInput.value = now === typed ? '' : now.startsWith(typed) ? now.slice(typed.length) : now;
      translateForm.removeAttribute('data-hold'); // the press on the send button is over: do not keep the box shown
      if (drafts) drafts.sent(draftId); // a sent draft is cleared on every device
      // Sent: the focus stays in the box, on a computer and on a touch screen (the user's rule, 2026-11-19), so the next message can be typed at once; on a
      // touch screen the on-screen keyboard stays open and the box stays shown. The bar buttons keep the box's focus on press (mousedown is cancelled), and
      // the focus is put back here in case something else took it. A column the person left while its translation ran does not take the focus back
      // (restingColumn: not the focused column): its box is blurred instead.
      if (target === session && !target.disposed && !restingColumn()) {
        if (document.activeElement !== translateInput) translateInput.focus({ preventScroll: true });
      } else if (document.activeElement === translateInput) translateInput.blur();
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
  // ── Drafts that follow their session ("Drafts" in docs/design/continue-and-drafts.md) ──
  // Typing is written to the shared page state at most every 2 s, at once on blur and when the page hides; a draft from another device comes into an
  // empty box that does not have the focus (with the caption "Draft from your <device>"), or is offered when this box has its own text.
  function setDraftText(text) { translateInput.value = text; autosize(); relayoutBar(); }
  function showDraftNote(note) {
    const C = window.TAContinue;
    const next = note ? { kind: note.kind, text: note.kind === 'offer' ? C.useDraftText(note.client) : C.draftFromText(note.client, note.at, Date.now()) } : null;
    if (JSON.stringify(ui.get().draftNote) !== JSON.stringify(next)) ui.set({ draftNote: next });
  }
  if (drafts) {
    translateInput.addEventListener('input', () => drafts.input());
    translateInput.addEventListener('blur', () => drafts.blur());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') drafts.flush(); });
    window.addEventListener('pagehide', () => drafts.flush());
    // The top page clears drafts older than 7 days (and the oldest beyond 20) once the server's state is read.
    let swept = Boolean(PANE);
    const sweep = () => { if (!swept && PageState.answered && PageState.answered()) { swept = true; drafts.sweep(); } };
    PageState.subscribe(() => { drafts.changed(); sweep(); });
    sweep();
    ui.actions.useDraft = () => drafts.useOffer();
  }
  // Send (translate, then send) sits in the draft box on a touch screen and in the row on a computer, so it is remounted when the input mode changes:
  // its click is heard on the bottom area, which stays.
  bottomArea.addEventListener('click', event => { if (event.target.closest && event.target.closest('#h5-translate-button')) void submitBox(true); });
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
    // A column (COMPACT_ROW) is like a computer in both input modes: its row has its own fixed room, only the growth covers the terminal.
    const overlap = pointerMode() || COMPACT_ROW ? Math.max(0, translateInput.offsetHeight - oneLineInput) : height;
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
    if (motion && delta && bottomArea.animate && !COMPACT_ROW && !pointerMode()) { // a column's or the computer row's box grows out of its row, which a clip of the row would hide
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
  // A column that stops (or starts) being the focused one: its draft box goes back to one line (or shows its text again while it has the focus).
  if (COMPACT_ROW) {
    let wasFocused = ui.get().paneFocused;
    ui.subscribe(() => {
      const now = ui.get().paneFocused;
      if (now === wasFocused) return;
      wasFocused = now;
      autosize();
    });
  }

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
  // The picker takes several files (`multiple`); they all go to one upload, in the order the picker gives them.
  picker.addEventListener('change', () => {
    const files = [...(picker.files || [])];
    const target = pickedFor;
    pickedFor = null;
    picker.value = '';
    if (files.length && target) void upload(target, files);
  });

  // The page stays locked for the whole batch. `count` ({ index, total }) says which file goes up; UploadDialog shows it when there are several.
  function lock(total) {
    uploading = true;
    document.activeElement?.blur();
    ui.set({ upload: { status: 'Reading OSS settings…', progress: 0, count: { index: 1, total } } });
    const change = patch => ui.set(state => ({ upload: state.upload && { ...state.upload, ...patch } }));
    return {
      status: text => change({ status: text }),
      progress: value => change({ progress: value }),
      next: index => change({ progress: 0, count: { index, total } }),
      unlock() { ui.set({ upload: null }); uploading = false; },
    };
  }

  // The image or file goes from this browser straight to OSS (oss-direct.js); the Client only signs the upload.
  const transfer = (file, ui2) => OssDirect.upload(file, {
    status: text => ui2.status(text),
    progress: value => ui2.progress(value),
  });

  // When the terminal went away during the upload, keep the link (or the links, joined with spaces) on screen so it is not lost.
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
  // An item of another Engine (`sourceKey`, its T-Attention list is read there) opens its files on that Engine, when it reads any path ('fs:read-any').
  ui.actions.canOpenAnyPath = (sourceKey = 'local') => {
    const from = sources.find(item => item.key === sourceKey);
    return Boolean(from && (from === LOCAL || (from.status !== 'offline' && readsAnyPath(from))));
  };
  ui.actions.openAnyPath = (absolute, sourceKey = 'local') => {
    if (typeof absolute !== 'string' || !(absolute.startsWith('/') || absolute === '~' || absolute.startsWith('~/'))) return false;
    if (!ui.actions.canOpenAnyPath(sourceKey)) return false;
    void openFileSheet(absolute, { link: true, absolute: true, from: sources.find(item => item.key === sourceKey) });
    return true;
  };
  ui.actions.openLocalPath = absolute => {
    const found = localTaskFor(absolute);
    if (!found) return false;
    void openFileSheet(absolute.slice(found.dir.length + 1), { link: true, forTask: found.item, from: LOCAL });
    return true;
  };

  // Uploads one File or several (an array, in order): the picker, a paste into the terminal and the Paste sheet all come here. More than
  // UPLOAD_MAX_FILES are refused before anything is read. The OSS settings are read once for the batch; the files then go up one after another,
  // and an empty or failed file does not stop the others. The links of the files that went up are typed with one paste at the end.
  async function upload(target, files) {
    const list = Array.isArray(files) ? files : [files];
    if (list.length > UPLOAD_MAX_FILES) { tell(`Upload at most ${UPLOAD_MAX_FILES} files at a time`, 'error'); return; }
    // The type and size limits (images 10 MiB, other files 100 MiB) are checked by OssDirect, which reads the first bytes.
    const errors = list.map(file => (!file || file.size <= 0 ? 'The file is empty' : null));
    const first = () => errors.find(Boolean);
    if (!list.length || errors.every(Boolean)) { tell(first() || 'The file is empty', 'error'); return; }
    const ui = lock(list.length);
    const urls = [];
    try {
      let config;
      try { config = await api('GET', '/api/oss/config'); }
      catch { throw new Error('Could not read OSS settings. Check the connection and retry'); }
      // `shared_from`: not set up here, but a linked service signs the upload.
      if (!config || (!config.enabled && !config.shared_from)) throw new Error('Enable Alibaba Cloud OSS upload in this client’s settings first');
      for (let index = 0; index < list.length; index++) {
        if (errors[index]) continue;
        ui.next(index + 1);
        try { urls.push((await transfer(list[index], ui)).url); }
        catch (error) { errors[index] = (error && error.message) || 'Upload failed'; }
      }
    } catch (error) { ui.unlock(); tell(error.message, 'error'); return; }
    ui.unlock();
    if (!urls.length) { tell(first(), 'error'); return; }
    if (urls.length < list.length) tell(`${urls.length} of ${list.length} files uploaded. ${first()}`, 'error');
    // xterm's paste keeps bracketed-paste semantics; one paste carries every link, a trailing space lets typing continue, and no Enter is sent.
    const text = urls.join(' ');
    if (connected(target)) target.term.paste(`${text} `);
    else retain(text);
  }

  // ── A link to a chat (`?openChat=<task id>:<conversation id>`): the task is selected and the chat opens (the chat is shown at once when it is the open one). ──
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
  // ── A link to a terminal (`?openTerminal=<engine>:<task id>:<terminal id>`, engine `local` or `remote:<id>`; the T-Attention desktop window opens it): that
  // task is selected on that service and that terminal is shown, or, while the multi-column view is shown, it opens in the focused column. `pending`: the read of
  // that service's tasks already on its way. Resolves to whether it went there; a service, task or terminal that is not there any more is false.
  async function openTerminalFromLink({ sourceKey, taskId, terminalId }, pending = null) {
    const from = sources.find(item => item.key === sourceKey && (item === LOCAL || item.label));
    if (!from) return false;
    if (pending) await pending;
    if (from.status !== 'ready' || !findTask(from, taskId)) await loadSource(from);
    const item = from.status === 'ready' ? findTask(from, taskId) : null;
    if (!item) return false;
    const rows = await api('GET', `${from.tasksBase}/${item.id}/terminals`).catch(() => null);
    if (!Array.isArray(rows) || !rows.some(row => row.terminal_id === terminalId)) return false;
    if (columnsShown()) return Boolean(ui.actions.openInColumn && ui.actions.openInColumn({ sourceKey: from.key, taskId: item.id, terminalId }));
    if (isShown(from, item.id)) { const entry = terminals.find(row => row.terminal_id === terminalId); if (entry) switchTerminal(entry); closeTasks(); return true; }
    selectTask(from, item, { terminal: terminalId });
    return true;
  }
  // The service worker makes the page installable as a Home Screen app and shows public/offline.html while this engine is down (public/sw.js); it
  // shows no notifications. A hand-over this page was opened with when it was signed in already is taken off the address ("One login for linked engines").
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (/^#handover=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  // The offline page's "Continue on <engine>" needs this engine's name and the linked engines' addresses while this one is down: kept from
  // /api/sign-in-handover/peers in `ta-linked-engines`, a little after the start (the top page only). An engine the answer has no address for keeps
  // the addresses known before. "The page while its engine is down" in docs/design/failover-and-one-login.md.
  if (!PANE) setTimeout(() => api('GET', '/api/sign-in-handover/peers').then(answer => {
    if (!answer || !Array.isArray(answer.peers)) return;
    let before = [];
    try { before = (JSON.parse(LocalKeys.get('ta-linked-engines') || '{}') || {}).peers || []; } catch { /* written again below */ }
    const peers = answer.peers.filter(peer => peer && peer.instance_id).map(peer => {
      const old = before.find(item => item && item.instance_id === peer.instance_id);
      return { instance_id: peer.instance_id, name: peer.name, addresses: peer.addresses && peer.addresses.length ? peer.addresses : (old && old.addresses) || [] };
    });
    LocalKeys.set('ta-linked-engines', JSON.stringify({ self: { instance_id: answer.instance_id, name: answer.name }, peers }));
  }, () => { /* an older server: no offline page offers */ }), 4000);

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
  // The desktop window's Open session reaches an open page through its T-Attention stream (attention-feed.mjs, `open-terminal`): the top page shows that
  // terminal in place, as the `?openTerminal=` link does (openTerminalFromLink: the task selected on its service and the terminal shown, or the focused
  // column while the multi-column view is shown), without a reload. A terminal that is not there any more says so, like the link.
  if (!PANE) {
    ui.actions.openTerminalLink = async ({ sourceKey, taskId, terminalId }) => {
      await listsKnown;
      const ok = /^(local|remote:[1-9]\d*)$/.test(String(sourceKey)) && Number.isSafeInteger(taskId) && taskId > 0 && /^[A-Za-z0-9_-]{1,64}$/.test(String(terminalId))
        && await openTerminalFromLink({ sourceKey, taskId, terminalId }).catch(() => false);
      if (!ok) tell('That terminal is not available any more');
      return Boolean(ok);
    };
  }
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
    // The actions of the column's header (drawn by the top page in place of this page's header; pane.mjs `runAction`). The task sheet: the drawer
    // under 900px, the sidebar from there; `toggle` (the header's "Project · session" button) hides a sheet that is shown.
    ui.actions.paneTasks = ({ toggle = false } = {}) => {
      const shown = isWide() ? !ui.get().sidebarCollapsed : ui.get().tasksOpen;
      if (toggle && shown) { if (isWide()) ui.actions.toggleSidebar(); else closeTasks(); return; }
      ui.actions.openTasks();
    };
    // The terminal shown (none under a chat or with no task): Rename and Restart act on it as its row's menu does.
    const shownRow = () => (task && terminalId && !agentChat ? terminals.find(entry => entry.terminal_id === terminalId) || null : null);
    // Rename: the task sheet opens with the name field in place of the session's row (the field the row's menu shows).
    ui.actions.paneRename = () => renameShown();
    // Restart in the working directory, with the row menu's confirmation.
    ui.actions.paneRestart = () => {
      const row = shownRow();
      if (!row) return false;
      return restartTerminal({ from: source, taskId: task.id, row });
    };
  }
  (async () => {
    // The remembered service is assumed until the list of services says otherwise: its tasks are asked for at the same time as that list. Its object is put in
    // `sources` so that loadSources keeps it; without a name it is not listed yet.
    const remembered = /^remote:(\d+)$/.exec(store.get('source') || '');
    const assumed = remembered ? remoteSource(Number(remembered[1]), '') : LOCAL;
    if (remembered) sources = [LOCAL, assumed];
    // The page opened with a link to a chat: ?openChat=<task id>:<conversation id>.
    const link = /^(\d+):(.+)$/.exec(new URLSearchParams(location.search).get('openChat') || '');
    // Or with a link to a terminal (openTerminalFromLink). It is taken out of the address at once, so a reload shows the page as usual and does not open it again.
    const query = new URLSearchParams(location.search);
    const terminalAsked = query.has('openTerminal');
    const terminalLink = /^(local|remote:[1-9]\d*):([1-9]\d*):([A-Za-z0-9_-]{1,64})$/.exec(query.get('openTerminal') || '');
    if (terminalAsked) {
      query.delete('openTerminal');
      const rest = query.toString();
      try { history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`); } catch { /* the address stays; nothing else changes */ }
    }
    // Or with a link to the details of a T-Attention task (?openAttention=<engine>:<id>, the desktop window's click on a task when no page took it): the
    // T-Attention panel opens with that task's edit view once the lists are known (`openAttention({ item })`; Attention.jsx waits for a task that is not
    // listed yet, and a task that is not there, or a value that is not a key, leaves the panel shown). Taken out of the address at once, like openTerminal;
    // the page goes on underneath as without it.
    const attentionAsked = !PANE && query.has('openAttention');
    const attentionLink = /^(local|remote:[1-9]\d{0,14}):[1-9]\d{0,14}$/.exec(query.get('openAttention') || '');
    if (query.has('openAttention')) {
      query.delete('openAttention');
      const rest = query.toString();
      try { history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`); } catch { /* the address stays */ }
    }
    // Or with a link into Learn (?learn=coach, the coach's reminder in T-Attention; ?learn=mistakes, progress … a screen of Learn, LEARN_VIEWS):
    // Learn opens on it. Taken out of the address at once, like openTerminal.
    if (query.has('learn')) {
      const learnView = query.get('learn') || '';
      query.delete('learn');
      const rest = query.toString();
      try { history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`); } catch { /* the address stays */ }
      if (LEARN_VIEWS.test(learnView)) ui.actions.openLearn(learnView === 'coach' ? 'chat' : learnView);
    }
    const savedId = Number(store.get(`task:${assumed.key}`));
    if (savedId > 0 && !link && !terminalAsked) {
      prefetch(`${assumed.tasksBase}/${savedId}/terminals`);
      if (assumed.key !== 'local') prefetch(infoUrl(assumed));
      const savedTerminal = store.get(`terminal:${assumed.key}:${savedId}`);
      if (savedTerminal && !columnsShown()) openEarlySocket(assumed, savedId, savedTerminal);
    }
    renderTasks(); // "Loading…"
    // A phone with nothing to bring back opens on the task sheet at once; that does not wait for the lists.
    if (!link && !terminalAsked && !attentionAsked && !(savedId > 0) && !isWide()) ui.set({ tasksOpen: true, wide: false });
    const reads = new Map([[LOCAL, loadSource(LOCAL)]]);
    if (assumed !== LOCAL) reads.set(assumed, loadSource(assumed));
    void loadLinks(); // the "⋯" of a task needs it, the list does not wait for it
    await Promise.all([loadSources(), loadHidden(), loadOrder()]);
    listReady = true;
    publishSources(); // what is listed is known now (T-Attention follows it)
    markListsKnown();
    importOldRecent(); // the devices' instance ids are known now
    syncMindmapSources();
    for (const from of listedSources()) if (!reads.has(from)) reads.set(from, loadSource(from));
    renderTasks();
    syncFeeds();
    if (attentionAsked && ui.actions.openAttention) ui.actions.openAttention({ item: attentionLink ? attentionLink[0] : null });
    // While the multi-column view is shown (Columns.jsx) the link goes to the focused column (else the first) and the hidden normal view still brings
    // back its remembered task below.
    if (link && columnsShown()) ui.actions.openInColumn({ sourceKey: LOCAL.key, taskId: Number(link[1]), conversationId: link[2] });
    else if (link && await openChatFromLink({ taskId: Number(link[1]), conversationId: link[2] })) return;
    // A terminal link that cannot be followed says so, and the page goes on as without it (the remembered task below).
    let linked = false;
    if (terminalAsked) {
      const sourceKey = terminalLink && terminalLink[1];
      linked = Boolean(terminalLink) && await openTerminalFromLink({ sourceKey, taskId: Number(terminalLink[2]), terminalId: terminalLink[3] },
        reads.get(sources.find(item => item.key === sourceKey)) || null).catch(() => false);
      if (!linked) tell('That terminal is not available any more');
    }
    // A pane opens the session its column shows on the other devices (the shared page state), before its own remembered one.
    if (!linked && !link && PANE) linked = Boolean(await followColumn());
    // Sent to a column, the hidden normal view still brings back its remembered task, as for a chat link.
    const shownByLink = linked && !columnsShown();
    // The remembered service and task when it is listed and answers in time; else the remembered task of another listed service; else no task and the list.
    const listed = listedSources();
    const tried = [assumed, LOCAL, ...listed].filter((from, index, all) => listed.includes(from) && all.indexOf(from) === index);
    if (!shownByLink) await Promise.race([Promise.all(tried.slice(0, 2).map(from => reads.get(from))), new Promise(resolve => setTimeout(resolve, REMEMBER_WAIT_MS))]);
    if (!task && !shownByLink) { // nothing was opened by hand meanwhile
      const found = tried.map(from => ({ from, item: from.status === 'ready' ? findTask(from, Number(store.get(`task:${from.key}`))) : null })).find(entry => entry.item);
      if (!found || found.from !== assumed) dropEarlySocket(); // the remembered task is gone, hidden or offline
      if (found) selectTask(found.from, found.item, null, { remember: found.from === assumed });
    }
    // A wide screen always has the sidebar. A phone opens the sheet only when no task is shown, and not over Settings opened meanwhile.
    if (isWide() || (!task && !ui.get().settingsOpen && !attentionAsked)) openTasks();
  })();
})();
