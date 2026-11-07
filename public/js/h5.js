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
    if (!res.ok) throw Object.assign(new Error((data && data.error) || text || `HTTP ${res.status}`), { data }); // `data`: the whole error body (a `reason` ...)
    return data;
  }
  // Remembered choices are a convenience only; private mode or blocked storage just starts fresh.
  const store = {
    get(key) { try { return localStorage.getItem(`h5-${key}`); } catch { return null; } },
    set(key, value) {
      try { if (value == null) localStorage.removeItem(`h5-${key}`); else localStorage.setItem(`h5-${key}`, String(value)); } catch { /* ignore */ }
    },
  };

  // ── Early requests (start) ──
  // A slow phone network pays a full round trip for each request that waits for another one. At start the page therefore asks at once for what it
  // will need: the Engine list, the tasks and groups of the remembered Engine, and for the remembered task its terminals and chats; and it opens the
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

  const LOCAL = { key: 'local', label: 'This machine', tasksBase: '/api/tasks', groupsBase: '/api/task-groups', wsPath: '/terminal/ws', activityBase: '/api/tasks' };
  const remoteSource = (id, name) => ({
    key: `remote:${id}`, label: name,
    tasksBase: `/api/remote-servers/${id}/tasks`,
    groupsBase: `/api/remote-servers/${id}/task-groups`,
    wsPath: `/api/remote-servers/${id}/terminal/ws`,
    activityBase: `/api/remote-servers/${id}`, // {activityBase}/terminal-activity and /terminal-subagents
  });
  let sources = [LOCAL];
  // What an Engine can do: the `capabilities` of its `/info` (`/v1/info` through the proxy), kept on its source object each time the page reads it
  // (the session menu and the chat list read it again, so an upgraded Engine is seen). The local Client has no such list and can do everything the
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
  let source = LOCAL;
  let tasks = [];
  let groups = [];
  let task = null;
  let terminals = [];
  let terminalId = null;
  const expanded = new Set(); // the tasks whose sessions are listed in the task sheet (a tap on a task opens and closes its list; it does not open the task); any number can be open
  const peeks = new Map(); // task id -> the sessions of an expanded task that is not the selected one: { source, taskId, status, terminals, chats }
  let peekSeq = 0;
  let wantedTerminal = null; // the terminal to show when the terminals of the task just selected arrive
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
  let fullHeight = 0;
  let fullWidth = 0;
  let closedTerminalHeight = 0; // the terminal box height while the keyboard is closed
  let keyboardOpen = false;
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
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (window.innerWidth !== fullWidth) { fullWidth = window.innerWidth; fullHeight = 0; } // rotated: measure again
    fullHeight = Math.max(fullHeight, height);
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
  new ResizeObserver(() => { if (!keyboardOpen) closedTerminalHeight = terminalHost.clientHeight; }).observe(terminalHost);
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', fitViewport);
  window.addEventListener('resize', fitViewport);
  fitViewport();
  // iOS Safari animates the keyboard and sometimes reports its final height without a last resize event (for example when
  // focus moves from the terminal to the translate box), which leaves the page shorter than the visible area. Measure again
  // while focus changes and while the keyboard is up.
  let settleTimers = [];
  function settleViewport() {
    settleTimers.forEach(clearTimeout);
    settleTimers = [];
    if (pointerMode()) return; // touch only: there is no on-screen keyboard to wait for
    settleTimers = [0, 100, 250, 500, 1000].map(delay => setTimeout(fitViewport, delay));
  }
  document.addEventListener('focusin', settleViewport);
  document.addEventListener('focusout', settleViewport);
  setInterval(() => { if (keyboardOpen && !pointerMode()) fitViewport(); }, 500);

  // ── Tasks ──
  // The task list the shell draws: a note (loading, an error, no tasks), or groups of tasks, each with the sessions listed under it when it is open.
  function note(text) { ui.set({ taskList: { note: text, groups: [] } }); }

  async function loadSources() {
    try {
      const servers = await api('GET', '/api/remote-servers');
      const before = new Map(sources.map(item => [item.key, item]));
      // An Engine that is still there keeps its object (only its name can change): requests in flight compare it with `source`.
      sources = [LOCAL, ...(Array.isArray(servers) ? servers : []).map(server => (before.has(`remote:${server.id}`) ? Object.assign(before.get(`remote:${server.id}`), { label: server.name }) : remoteSource(server.id, server.name)))];
    } catch { sources = [LOCAL]; }
    source = sources.find(item => item.key === store.get('source')) || LOCAL;
    ui.set({ sources: sources.map(item => ({ key: item.key, label: item.label })), sourceKey: source.key });
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
      showActiveCount();
      return true;
    } catch (error) {
      if (current === source) { tasks = []; note(`Could not load tasks: ${error.message}`); }
      return false;
    }
  }

  // The directory of a terminal that kept its own after the task's working directory changed (null when it is the task's).
  const otherDir = (row, item) => {
    const own = item && (item.work_dir || (item.md_path ? item.md_path.replace(/\/[^/]*$/, '') : ''));
    return row.work_dir && own && row.work_dir !== own ? row.work_dir : null;
  };
  // The sessions of the selected task: its terminals, then its chats (the way back into one that was left by going to a terminal); each has "⋯" actions.
  function ownSessions() {
    return {
      label: 'Phone terminals', note: null,
      rows: [
        ...terminals.map(row => ({ kind: 'terminal', id: row.terminal_id, title: row.title, agent: row.agent || null, otherDir: otherDir(row, task), current: row.terminal_id === terminalId && !agentChat, more: true })), // only one of a terminal and a chat is shown
        ...chats.map(row => ({ kind: 'chat', id: row.id, title: row.title, running: Boolean(row.running), pending: Boolean(row.pending), updated: row.updated_at || null, agent: row.agent, current: Boolean(agentFor && agentFor.conversation === row.id) && !agentViews.view, children: agentFor && agentFor.conversation === row.id ? agentViews.agents.map(sub => ({ kind: 'subagent', id: sub.id, title: sub.name, status: sub.status, current: agentViews.view === sub.id })) : [], more: true })),
      ],
    };
  }
  // The sessions under an expanded task that is not selected: its terminals, then its chats, as in the list of the selected task (without the "⋯" actions).
  function peekSessions(item) {
    const label = item.title;
    const peek = peeks.get(item.id);
    if (!peek || peek.source !== source || peek.status === 'loading') return { label, note: 'Loading…', rows: [] };
    if (peek.status === 'error') return { label, note: 'Could not load the sessions', rows: [] };
    const rows = [
      ...peek.terminals.map(row => ({ kind: 'terminal', id: row.terminal_id, title: row.title, agent: row.agent || null, otherDir: otherDir(row, item), current: false, more: false })),
      ...peek.chats.map(row => ({ kind: 'chat', id: row.id, title: row.title, running: Boolean(row.running), pending: Boolean(row.pending), updated: row.updated_at || null, agent: row.agent, current: false, more: false })),
    ];
    if (!rows.length) rows.push({ kind: 'open', id: 'open', title: tr('Open this task'), agent: null, current: false, more: false });
    return { label, note: null, rows };
  }

  // The groups of the task sheet in the order they are drawn, each with its tasks in list order (groups without tasks left out).
  function groupedTasks() {
    const ordered = [...groups].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const known = new Set(ordered.map(group => group.key));
    for (const item of tasks) {
      if (!known.has(item.status)) { known.add(item.status); ordered.push({ key: item.status, name: item.status }); }
    }
    return ordered.map(group => ({ group, members: tasks.filter(item => item.status === group.key) })).filter(entry => entry.members.length);
  }

  function renderTasks() {
    if (!tasks.length) { note('No tasks yet. Create one above'); return; }
    const out = [];
    for (const { group, members } of groupedTasks()) {
      out.push({
        key: group.key, name: group.name,
        tasks: members.map(item => {
          const selected = Boolean(task && task.id === item.id);
          const open = expanded.has(item.id);
          // A tap opens or closes the list of sessions under the task. Going to a session is a tap on that session.
          const hasSessions = Boolean(selected && (terminals.length || chats.length));
          // The selected task: "+" on the right of its row adds a terminal.
          return { id: item.id, title: item.title, count: open ? (selected ? (hasSessions ? terminals.length + chats.length : null) : (peeks.get(item.id) && peeks.get(item.id).status === 'ready' ? peeks.get(item.id).terminals.length + peeks.get(item.id).chats.length : null)) : null, selected, expanded: open, add: true, sessions: open ? (selected ? (hasSessions ? ownSessions() : null) : peekSessions(item)) : null };
        }),
      });
    }
    ui.set({ taskList: { note: null, groups: out } });
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

  // target: where to go in the task, { terminal: id } or { chat: row }; without one, the task opens as it was left (its terminal, or the chat that was open).
  // stay: the task sheet of a phone stays open (the "+" of a task that was not selected shows its Session list in the sheet, under that task).
  function selectTask(item, target = null, { stay = false } = {}) {
    // A chat open over another task is put away (but not forgotten: it comes back with its task).
    if (agentChat && agentFor && (!item || agentFor.taskId !== item.id || agentFor.source !== source.key)) hideAgent();
    task = item;
    void syncWakeLock();
    chats = [];
    if (item) { peeks.delete(item.id); expanded.add(item.id); } // the other open lists stay open
    wantedTerminal = target && target.terminal ? target.terminal : null;
    store.set(`task:${source.key}`, item ? item.id : null);
    ui.set({ taskName: item ? item.title : '' });
    syncFiles();
    if (!stay) closeTasks();
    void loadTerminals();
    if (target && target.chat) mountAgent(target.chat);
    else if (item && !target) void restoreAgent(item);
  }

  // Opens or closes the list of sessions under a task, without going anywhere.
  function toggleTask(item) {
    if (expanded.has(item.id)) { expanded.delete(item.id); peeks.delete(item.id); renderTasks(); return; }
    expanded.add(item.id);
    if (!(task && task.id === item.id)) void loadPeek(item);
    renderTasks();
  }
  // "Expand all" / "Collapse all" in the header of the task list.
  function setAllExpanded(open) {
    expanded.clear();
    peeks.clear();
    if (open) for (const item of tasks) { expanded.add(item.id); if (!(task && task.id === item.id)) void loadPeek(item); }
    renderTasks();
  }
  // The terminals and chats of a task that is not the selected one, read when its list is opened.
  async function loadPeek(item) {
    const current = source;
    const mine = { source: current, taskId: item.id, status: 'loading', terminals: [], chats: [], seq: (peekSeq += 1) };
    const before = peeks.get(item.id);
    if (!before || before.source !== current) peeks.set(item.id, mine); // a list that is already shown stays until the new one is read
    const [rows, chatRows] = await Promise.all([
      api('GET', `${current.tasksBase}/${item.id}/terminals`).catch(() => null),
      readChats(item, { peek: true }),
    ]);
    if (source !== current || !expanded.has(item.id) || (peeks.get(item.id) && peeks.get(item.id).seq > mine.seq)) return;
    peeks.set(item.id, mine);
    mine.status = Array.isArray(rows) ? 'ready' : 'error';
    mine.terminals = Array.isArray(rows) ? rows : [];
    mine.chats = chatRows || [];
    renderTasks();
  }
  // Goes to a session of a task that is not the selected one: the task is selected and that session is shown.
  function openFromPeek(item, target) {
    // A chat that was open on the phone for this task is not any more once a terminal is shown, as when going to a terminal inside the task.
    const peek = peeks.get(item.id);
    if (target.terminal && peek) for (const row of peek.chats) if (row.opened && row.opened.h5) setOpened(item.id, row.id, false);
    selectTask(item, target);
  }
  // A wide screen (a computer, a landscape tablet) shows the task list as a permanent sidebar next to the terminal: it is never closed,
  // the page behind it stays usable, and a phone-sized screen keeps the sheet that slides over the page.
  const wideQuery = (ui.media && ui.media.wideQuery) || window.matchMedia('(min-width: 900px)'); // the same query object as the shell's
  const isWide = () => wideQuery.matches;
  function openTasks() {
    const wide = isWide();
    if (task) expanded.add(task.id); // the sheet opens with the sessions of the task that is shown; the lists the person opened stay open
    for (const item of tasks) if (expanded.has(item.id) && !(task && task.id === item.id)) void loadPeek(item); // read again: they may have changed
    ui.set({ tasksOpen: true, wide });
    renderTasks();
    void loadTasks();
    void refreshTerminals();
    void loadChats();
    clearInterval(namesTimer);
    namesTimer = setInterval(() => void refreshTerminals(), 8000);
  }
  // Claude / Codex terminals are named after their session, which can change inside the agent (rename, first prompt): refresh while the list is open.
  let namesTimer = null;
  async function refreshTerminals() {
    const current = task;
    if (!current || !terminals.some(row => row.agent)) return;
    let rows;
    try { rows = await api('GET', `${source.tasksBase}/${current.id}/terminals`); } catch { return; }
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
    // The Session list and the rename field are drawn inside the sheet: they go with it.
    const menu = ui.get().menu;
    if (menu && (menu.naming || menu.rename)) closeTerminalMenu();
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
  ui.actions.toggleTask = id => { const item = tasks.find(entry => entry.id === id); if (item) toggleTask(item); };
  // A tap on a session row: on the selected task it goes to the terminal or chat; on another task it selects that task and shows the session.
  ui.actions.openRow = (taskId, row) => {
    const item = tasks.find(entry => entry.id === taskId);
    if (!item) return;
    if (task && task.id === taskId) {
      if (row.kind === 'terminal') {
        closeTasks();
        leaveChat();
        // Tapping the current terminal reconnects one that was disconnected.
        if (row.id === terminalId && session && (session.ws || session.timer)) return;
        const entry = terminals.find(candidate => candidate.terminal_id === row.id);
        if (entry) switchTerminal(entry);
      } else if (row.kind === 'chat') {
        if (agentChat && agentFor && agentFor.conversation === row.id) { agentChat.setView(''); closeTasks(); return; } // the open chat: back to its main agent
        const entry = chats.find(candidate => candidate.id === row.id);
        if (entry) { closeTasks(); mountAgent(entry); }
      } else if (row.kind === 'subagent') {
        if (agentChat) { agentChat.setView(row.id); closeTasks(); }
      }
      return;
    }
    if (row.kind === 'terminal') openFromPeek(item, { terminal: row.id });
    else if (row.kind === 'chat') { const peek = peeks.get(item.id); const entry = peek && peek.chats.find(candidate => candidate.id === row.id); if (entry) openFromPeek(item, { chat: entry }); }
    else selectTask(item);
  };
  // ── Next running or pending session (row 2, `#h5-cycle`) ──
  // Goes to the next terminal session, in task sheet order (groups, tasks, then the terminals of each task), that is running or pending acceptance,
  // wrapping around after the last one. Only terminal sessions count: plain shells ("Terminal") and Claude / Codex terminals ("Session"); agent chats do not.
  // Running: the server's terminal activity state is 'running', or the terminal is a live Claude session with a running sub-agent (`terminal-subagents`).
  // Pending acceptance: the activity state is 'done' (finished, not yet seen; showing the terminal clears it, see the terminal done acknowledgement below).
  // Both come from the pushed snapshot while the activity stream is live (see "Terminal activity push" below), else they are read fresh on the tap.
  let cycling = false;
  async function activeSessions(from) {
    const pushed = feed.live && feed.source === from && feed.snapshot;
    const [activity, subagents] = pushed ? [pushed.activity, pushed.subagents] : await readActivity(from);
    const stateOf = (taskId, id) => {
      const state = ((activity || {})[taskId] || {})[id];
      if (state === 'running' || Number(((subagents || {})[taskId] || {})[id]) > 0) return 'running';
      return state === 'done' ? 'pending' : null;
    };
    const order = groupedTasks().flatMap(entry => entry.members)
      .filter(item => Object.keys((activity || {})[item.id] || {}).length || Object.keys((subagents || {})[item.id] || {}).length);
    // The terminal order of a task as the task sheet lists it: the open task's own list, else a fresh read of that task's terminals.
    const lists = await Promise.all(order.map(item => (task && task.id === item.id && terminals.length
      ? terminals : api('GET', `${from.tasksBase}/${item.id}/terminals`).catch(() => []))));
    const out = [];
    order.forEach((item, index) => {
      for (const row of Array.isArray(lists[index]) ? lists[index] : []) {
        const state = stateOf(item.id, row.terminal_id);
        if (state) out.push({ taskId: item.id, terminalId: row.terminal_id, state });
      }
    });
    return out;
  }
  ui.actions.nextActiveSession = async () => {
    // Close the on-screen keyboard first (as the design document button does); the terminal is not resized.
    if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    if (cycling) return;
    cycling = true;
    const from = source;
    try {
      const list = await activeSessions(from);
      if (from !== source) return;
      if (!list.length) { tell('No running or pending sessions'); return; }
      const here = list.findIndex(entry => task && entry.taskId === task.id && entry.terminalId === terminalId && !agentChat);
      if (here >= 0 && list.length === 1) { tell('This is the only running or pending session'); return; }
      const next = list[(here + 1) % list.length]; // not in the list (here = -1): the first one
      ui.actions.openRow(next.taskId, { kind: 'terminal', id: next.terminalId }); // the same path as a tap in the task sheet
    } catch (error) {
      tell(`Could not read the session states: ${error.message}`, 'error');
    } finally { cycling = false; }
  };
  ui.actions.rowMore = row => {
    if (row.kind === 'chat') { const entry = chats.find(candidate => candidate.id === row.id); if (entry) openChatMenu(entry); }
    else { const entry = terminals.find(candidate => candidate.terminal_id === row.id); if (entry) openTerminalMenu(entry); }
  };
  ui.actions.changeEngine = key => {
    hideAgent();
    source = sources.find(item => item.key === key) || LOCAL;
    store.set('source', source.key === 'local' ? null : source.key);
    tasks = [];
    task = null;
    void syncWakeLock();
    expanded.clear();
    peeks.clear();
    ui.set({ taskName: '', sourceKey: source.key });
    syncFiles();
    hideShown(); // its connection stays warm (WARM_MAX)
    terminals = [];
    renderTabs();
    showEmpty('Choose a task to open its phone terminal');
    void loadTasks();
    void connectFeed();
  };
  // Resolves to whether the task was made (the shell then empties its input).
  // workDir: an absolute path, or empty for the default rule (a folder named after the task under the tasks folder); the default is never sent.
  ui.actions.createTask = async (title, workDir = '') => {
    const current = source;
    ui.set({ creatingTask: true });
    try {
      const created = await api('POST', current.tasksBase, workDir ? { title, work_dir: workDir } : { title });
      if (current !== source) return true;
      await loadTasks();
      selectTask(tasks.find(item => item.id === created.id) || created);
      return true;
    } catch (error) {
      tell(`Could not create the task: ${error.message}`, 'error');
      return false;
    } finally { ui.set({ creatingTask: false }); }
  };
  // The engine whose tasks are listed, for the new-task form: its default folder rule is shown only for this machine (a remote one keeps its own).
  ui.actions.newTaskTarget = () => ({ local: source.key === 'local', label: source.label });

  // ── Task actions (the "⋯" of a task): move to another group, change the working directory, delete (optionally with the directory) ──
  // The task endpoints, through the task base of the engine, so local, Engine and proxied tasks work alike.
  const taskById = id => tasks.find(entry => entry.id === id);
  ui.actions.taskMore = id => {
    const item = taskById(id);
    if (!item) return;
    menuRow = null;
    menuChat = null;
    const ordered = [...groups].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    showMenu(item.title, [
      ...ordered.map(group => [`${item.status === group.key ? '\u2713 ' : ''}${tr('Move to')} \u201C${tr(group.name)}\u201D`, () => void moveTask(item, group.key), 'raw']),
      ['Edit working directory', () => { closeTerminalMenu(); ui.set({ taskDialog: { kind: 'workdir', id: item.id, title: item.title, workDir: item.work_dir || '', error: '', busy: false } }); }],
      ['Delete', () => { closeTerminalMenu(); ui.set({ taskDialog: { kind: 'delete', id: item.id, title: item.title, workDir: item.work_dir || '', error: '', busy: false } }); }, 'danger'],
    ]);
  };
  async function moveTask(item, status) {
    closeTerminalMenu();
    if (item.status === status) return;
    const from = source;
    try {
      await api('PUT', `${from.tasksBase}/${item.id}`, { status });
      if (from === source) await loadTasks();
    } catch (error) { tell(`Could not update task: ${error.message}`, 'error'); }
  }
  const patchDialog = patch => ui.set(state => ({ taskDialog: state.taskDialog && { ...state.taskDialog, ...patch } }));
  ui.actions.taskDialogClose = () => { if (!(ui.get().taskDialog || {}).busy) ui.set({ taskDialog: null }); };
  const DELETE_ERRORS = { DIRECTORY_NOT_SAFE_TO_DELETE: 'This directory cannot be deleted (protected or shared with other tasks); the task was not deleted' };
  ui.actions.taskDelete = async deleteDirectory => {
    const dialog = ui.get().taskDialog;
    const item = dialog && taskById(dialog.id);
    if (!item || dialog.busy) return;
    const from = source;
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
    if (from !== source) return;
    expanded.delete(item.id);
    peeks.delete(item.id);
    if (task && task.id === item.id) { hideAgent(); selectTask(null); }
    tasks = tasks.filter(entry => entry.id !== item.id);
    await loadTasks();
  };
  // An existing task's working directory: the form shows the saved one; an absolute path is required (the server keeps the old one for an empty value).
  ui.actions.taskWorkdirSave = async value => {
    const dialog = ui.get().taskDialog;
    const item = dialog && taskById(dialog.id);
    if (!item || dialog.busy) return;
    const workDir = String(value || '').trim();
    if (!isAbsolutePath(workDir)) { patchDialog({ error: 'Enter an absolute path' }); return; }
    if (workDir === (item.work_dir || '')) { ui.set({ taskDialog: null }); return; }
    const from = source;
    patchDialog({ busy: true, error: '' });
    try {
      await api('PUT', `${from.tasksBase}/${item.id}`, { work_dir: workDir });
    } catch (error) { patchDialog({ busy: false, error: tr(error.message) }); return; }
    ui.set({ taskDialog: null });
    if (from !== source) return;
    await loadTasks();
    if (task && task.id === item.id) { const fresh = taskById(item.id); if (fresh) task = fresh; }
    syncFiles(); // a new working directory: a new tree
    peeks.delete(item.id);
    // Existing terminals keep their directory; the list says which one each has now (a default terminal never started follows the task).
    if (task && task.id === item.id) {
      const current = task;
      try {
        const rows = await api('GET', `${source.tasksBase}/${current.id}/terminals`);
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

  // The Engines settings (scripts/h5-shell/Engines.jsx) connected, edited or removed an Engine: read the list of engines again. `changedKey` is the
  // Engine whose connection changed; when it is the one shown (or the one shown was removed), its tasks and terminals are opened again.
  ui.actions.enginesChanged = async (changedKey = null) => {
    const before = source;
    await loadSources();
    if (source !== before || changedKey === before.key) ui.actions.changeEngine(source.key);
    else ui.set({ sourceKey: source.key });
  };

  // ── Phone terminals ──
  function showEmpty(text) { ui.set({ empty: text }); }

  async function loadTerminals() {
    hideShown(); // another task: the terminal shown so far stays warm (WARM_MAX)
    terminals = [];
    renderTabs();
    if (!task) { showEmpty('Choose a task to open its phone terminal'); return; }
    const current = task;
    showEmpty('Loading…');
    let rows;
    try { rows = await api('GET', `${source.tasksBase}/${current.id}/terminals`); }
    catch (error) { if (current === task) showEmpty(`Could not load terminals: ${error.message}`); return; }
    if (current !== task) return;
    terminals = Array.isArray(rows) ? rows : [];
    if (!terminals.length) { dropEarlySocket(); showEmpty('This task has no terminal yet'); return; }
    const saved = store.get(`terminal:${source.key}:${current.id}`);
    const wanted = wantedTerminal; // a session that was tapped in the task sheet
    wantedTerminal = null;
    terminalId = [wanted, saved].find(id => id && terminals.some(row => row.terminal_id === id)) || terminals[0].terminal_id;
    if (earlySocket && earlySocket.terminalId !== terminalId) dropEarlySocket();
    if (wanted && terminalId === wanted) store.set(`terminal:${source.key}:${current.id}`, terminalId);
    renderTabs();
    connect();
  }

  // The terminals of the selected task are a second-level list under it in the task sheet (ownSessions); "⋯" opens the actions of one terminal.
  // Going to a terminal leaves the open chat, like the back arrow used to; the chat stays listed in the task sheet.
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
  // { label, kind } in the state and their functions are kept here, in the order shown. The actions are a sheet from the bottom (TermMenu.jsx); the
  // Session choices (`naming`, under the task `task`) and the rename field (`rename`, in place of that row) are drawn in the task list (TaskDrawer.jsx),
  // where the person tapped.
  let menuRuns = [];
  let menuRow = null;
  let menuChat = null; // the chat whose actions are open
  // The optional name typed in the "Session" sheet. It is kept while moving between its lists (Claude session, Back) and names what is created.
  let newName = '';
  let menuCreate = -1; // the item that Enter in the name field runs (New Terminal, New Claude session, New Claude chat)
  let menuTask = null; // the id of the task whose "+" opened the Session list

  function closeTerminalMenu() {
    menuRow = null;
    menuChat = null;
    menuRuns = [];
    menuCreate = -1;
    menuTask = null;
    newName = '';
    ui.set({ menu: null });
  }
  // The typed name, as the server will keep it (an empty name: the default "Terminal N" / "Claude N" / chat name).
  const takeName = () => newName.replace(/\s+/g, ' ').trim();
  // items: [label, run, kind, create]; kind 'danger' is drawn as a warning, 'raw' is a name that is not translated; create: Enter in the name field runs it.
  // naming: the Session list, with the optional name field above it, drawn under the task `menuTask` in the task list.
  function showMenu(title, items, { naming = false } = {}) {
    menuRuns = items.map(item => item[1]);
    menuCreate = items.findIndex(item => item[3]);
    ui.set({ menu: { title, items: items.map(([label, , kind]) => ({ label, kind: kind || null })), rename: null, renameValue: '', naming, task: naming ? menuTask : null, name: newName } });
  }
  // The rename field takes the place of the row in the task list ({ kind, id } of the row); the sheet of actions goes away.
  const askRename = value => ui.set(state => ({
    menu: state.menu && { ...state.menu, rename: menuChat ? { kind: 'chat', id: menuChat.id } : { kind: 'terminal', id: menuRow && menuRow.terminal_id }, renameValue: value },
  }));
  function openTerminalMenu(row) {
    menuRow = row;
    menuChat = null;
    // "Copy text" is for the terminal that is open (the copy view reads its buffer); the long press on the terminal body is the other way in.
    const open = row.terminal_id === terminalId && !agentChat && session && !session.disposed;
    showMenu(row.title, [
      ...(open ? [['Copy text', () => { closeTerminalMenu(); closeTasks(); openCopy(); }]] : []),
      // Agent terminals too: a name given here is kept (title_custom) and wins over the Claude / Codex session title from then on.
      ['Rename', () => askRename(row.title)],
      ['Reopen', () => { closeTerminalMenu(); closeTasks(); switchTerminal(row); }],
      ['Restart in the working directory', () => void restartTerminal(row), 'danger'],
      ['Delete', () => void deleteTerminal(row), 'danger'],
    ]);
  }
  // Chat actions: the same sheet as a terminal's, with the actions a chat has (rename, open, delete).
  function openChatMenu(row) {
    menuRow = null;
    menuChat = row;
    showMenu(row.title, [
      ['Rename', () => askRename(row.title)],
      ['Open', () => { closeTerminalMenu(); closeTasks(); mountAgent(row); }],
      ['Delete', () => void deleteChat(row), 'danger'],
    ]);
  }
  async function deleteChat(row) {
    if (!window.confirm(`${tr('Delete this chat? Its messages are removed from this task.')}\n${row.title}`)) return;
    const current = task;
    closeTerminalMenu();
    try {
      await api('DELETE', `${source.tasksBase}/${current.id}/agent/conversations/${encodeURIComponent(row.id)}`);
      if (agentFor && agentFor.conversation === row.id) hideAgent();
      if (current === task) await loadChats();
    } catch (error) { tell(`Could not delete the chat: ${error.message}`, 'error'); }
  }
  async function controlTerminal(row, action) {
    const current = task;
    const wasCurrent = row.terminal_id === terminalId;
    if (wasCurrent) disconnect(); // end the view first, so the server closing the shell is not shown as a lost connection
    const from = source;
    closeWarm(item => item.key === warmKey(from, current.id, row.terminal_id)); // a hidden warm view of it too
    try {
      await api('POST', `${source.tasksBase}/${current.id}/terminal/control`, { action, terminal_id: row.terminal_id });
    } catch (error) {
      if (wasCurrent && current === task) connect();
      throw error;
    }
    return wasCurrent;
  }
  async function restartTerminal(row) {
    if (!window.confirm(tr('This ends the terminal, clears its history and reopens it from the task working directory. Continue?'))) return;
    closeTerminalMenu();
    try {
      await controlTerminal(row, 'restart-workdir');
      closeTasks();
      switchTerminal(row);
    } catch (error) { tell(`Could not restart the terminal: ${error.message}`, 'error'); }
  }
  async function deleteTerminal(row) {
    if (!window.confirm(`${tr('Delete this terminal? It ends the programs in it and removes its history.')}\n${row.title}`)) return;
    closeTerminalMenu();
    try {
      const wasCurrent = await controlTerminal(row, 'delete');
      terminals = terminals.filter(item => item.terminal_id !== row.terminal_id);
      if (wasCurrent && terminals.length) { switchTerminal(terminals[0]); closeTasks(); }
      else {
        if (wasCurrent) terminalId = null;
        renderTabs();
        if (wasCurrent) showEmpty('This task has no terminal yet');
      }
    } catch (error) { tell(`Could not delete the terminal: ${error.message}`, 'error'); }
  }
  ui.actions.menuRun = index => { const run = menuRuns[index]; if (run) run(); };
  ui.actions.menuCancel = closeTerminalMenu;
  ui.actions.menuName = value => { newName = String(value || ''); };
  ui.actions.menuNameSubmit = () => { const run = menuRuns[menuCreate]; if (run) run(); };
  ui.actions.menuRename = async value => {
    const row = menuRow;
    const title = String(value || '').trim();
    if (menuChat && title) {
      const chat = menuChat;
      try {
        await api('PATCH', `${source.tasksBase}/${task.id}/agent/conversations/${encodeURIComponent(chat.id)}`, { title });
        closeTerminalMenu();
        await loadChats();
      } catch (error) { tell(`Could not rename the chat: ${error.message}`, 'error'); }
      return;
    }
    if (!row || !title) return;
    try {
      const renamed = await api('PATCH', `${source.tasksBase}/${task.id}/terminals/${encodeURIComponent(row.terminal_id)}`, { title });
      row.title = (renamed && renamed.title) || title;
      closeTerminalMenu();
      renderTabs();
    } catch (error) { tell(`Could not rename the terminal: ${error.message}`, 'error'); }
  };
  // The name of what is shown (the chat that is open, otherwise the current terminal) in small text under the task name.
  function renderSessionName() {
    let name = '';
    const current = terminalId ? terminals.find(entry => entry.terminal_id === terminalId) : null;
    const agent = (current && current.agent) || null; // the kind of the current terminal, as the task list shows it: picks the saved commands presets
    if (ui.get().terminalAgent !== agent) ui.set({ terminalAgent: agent });
    if (agentChat && agentFor) {
      const row = chats.find(entry => entry.id === agentFor.conversation);
      name = (row && row.title) || agentFor.title || '';
    } else if (terminalId) {
      const row = terminals.find(entry => entry.terminal_id === terminalId);
      name = (row && row.title) || '';
    }
    if (ui.get().sessionName !== name) ui.set({ sessionName: name });
  }
  function renderTabs() { if (tasks.length) renderTasks(); renderSessionName(); }

  // ── Session: a plain terminal, or a Claude / Codex session of the task directory (new or resumed) ──
  const SESSION_KINDS = [['claude', 'Claude session'], ['codex', 'Codex session']];
  function showSessionMenu(title, items) { showMenu(tr(title), items, { naming: true }); }
  async function openSessionMenu() {
    const currentSource = source;
    const currentTask = task;
    menuRow = null;
    menuChat = null;
    const show = chatsAvailable => showSessionMenu('Session', [
      ['New Terminal', () => { const title = takeName(); closeTerminalMenu(); closeTasks(); void createTerminal(title ? { title } : {}); }, null, true],
      ...SESSION_KINDS.map(([agent, label]) => [label, () => void openAgentSessions(agent, label)]),
      ...(chatsAvailable ? [['Claude agent', () => void openAgentChats('claude', 'Claude agent')], ['Codex agent', () => void openAgentChats('codex', 'Codex agent')]] : []),
    ]);
    show(source.key === 'local');
    if (source.key === 'local') return;
    try {
      const info = await readInfo(source);
      const menu = ui.get().menu;
      if (source !== currentSource || task !== currentTask || !menu || menu.title !== tr('Session')) return;
      show(Array.isArray(info.capabilities) && info.capabilities.includes('agent-chat:manage'));
    } catch { /* old or offline Engines keep offering terminals only */ }
  }
  ui.actions.openSessionMenu = openSessionMenu;
  // The "+" of any task: a task that is not shown is selected first, then the menu adds a session to it.
  ui.actions.addSession = id => {
    const item = tasks.find(entry => entry.id === id);
    if (!item) return;
    const menu = ui.get().menu;
    if (menu && menu.naming && menuTask === item.id) { closeTerminalMenu(); return; } // the "+" again closes its list
    if (!(task && task.id === item.id)) selectTask(item, null, { stay: true });
    menuTask = item.id;
    newName = ''; // a new "Session" list starts with an empty name
    void openSessionMenu();
  };

  // ── Agent chat: the same Claude / Codex sessions as a conversation view instead of a terminal ──
  const agentView = $('h5-agent');
  const chatApi = { get: url => api('GET', url), post: (url, body) => api('POST', url, body), patch: (url, body) => api('PATCH', url, body), del: url => api('DELETE', url) };
  let agentChat = null;
  let agentViews = { agents: [], view: '' }; // the sub-agents of the open chat and the view shown, listed under its row in the sidebar
  // The chat fills the screen below the page header (task name and settings), the same header the terminal has, and follows the
  // visual viewport so the on-screen keyboard never covers the composer.
  function fitAgentView() {
    const top = document.querySelector('.h5-header').getBoundingClientRect().bottom;
    const viewport = window.visualViewport;
    const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    agentView.style.top = `${top}px`;
    agentView.style.height = `${Math.max(0, bottom - top)}px`;
  }
  // Which chat of which task is shown. The chat that is open on a task is kept in the database (the open flag of the conversation, one per
  // task on this page), so a refresh, or another phone, brings it back. Earlier versions remembered it in localStorage (`h5-agent:...`);
  // that is moved to the database the first time it is found.
  let agentFor = null;
  let chats = []; // the agent chats of the selected task, listed under its terminals in the task sheet
  const legacyKey = item => `agent:${source.key}:${item.id}`;
  // Tells the server that a chat is open (or not) on the phone page; a failure is shown, the chat just is not remembered.
  // POST first, because some network paths (a proxy in front of the Client) let POST through but not PATCH; an older Engine without that route gets the PATCH.
  function setOpened(taskId, id, opened) {
    const url = `${source.tasksBase}/${taskId}/agent/conversations/${id}`;
    const body = { opened, surface: 'h5' };
    chatApi.post(`${url}/opened`, body)
      .catch(() => chatApi.patch(url, body))
      .catch(error => tell(`Could not save which chat is open: ${error.message}`, 'error'));
  }
  // Takes the chat view away without forgetting the chat.
  function hideAgent() {
    if (agentChat) agentChat.destroy();
    agentChat = null;
    agentViews = { agents: [], view: '' };
    agentFor = null;
    agentView.hidden = true;
    agentView.style.height = agentView.style.top = '';
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', fitAgentView);
      window.visualViewport.removeEventListener('scroll', fitAgentView);
    }
  }
  // Closing it with the back button is the person saying they are done with it.
  function closeAgent() {
    if (agentFor && agentFor.source === source.key) setOpened(agentFor.taskId, agentFor.conversation, false);
    hideAgent();
    ackShown(); // the terminal under the chat is shown again
    renderTabs();
    void loadChats();
  }
  // `remember`: the person opened it, so the server is told; a chat that is shown again because it was already open is not sent again.
  function mountAgent(conversation, { remember = true, draft = '' } = {}) {
    if (agentChat) agentChat.destroy();
    agentView.hidden = false;
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitAgentView);
      window.visualViewport.addEventListener('scroll', fitAgentView);
    }
    fitAgentView();
    agentChat = AgentChat.mount(agentView, { api: chatApi, base: `${source.tasksBase}/${task.id}/agent`, conversation, onClose: closeAgent, notify: message => tell(message, 'error'), draft, hostTabs: true,
      onViews: views => { if (!agentFor || agentFor.conversation !== conversation.id) return; agentViews = views; renderTasks(); },
      onOpenChat: (created, extra = {}) => mountAgent(created, { draft: extra.draft || '' }), // a fork or a new chat replaces the one shown
      onTitle: title => { // a rename or the first message gave the chat a new name
        if (!agentFor || agentFor.conversation !== conversation.id) return;
        agentFor.title = title;
        const row = chats.find(entry => entry.id === conversation.id);
        if (row) row.title = title;
        renderTabs();
      } });
    agentFor = { source: source.key, taskId: task.id, conversation: conversation.id, title: conversation.title };
    if (remember) setOpened(task.id, conversation.id, true);
    renderTabs();
    void loadChats();
  }
  // The chats of a task on the selected Engine, or null when the Engine has none to offer, the list cannot be read or the page moved on.
  async function readChats(item, { peek: forOther = false } = {}) {
    const current = source;
    const stale = () => source !== current || (!forOther && task !== item); // forOther: the task is not the selected one (its list is opened in the sheet)
    try {
      if (current.key !== 'local') {
        const info = await readInfo(current);
        if (!Array.isArray(info.capabilities) || !info.capabilities.includes('agent-chat:manage')) return null;
        if (stale()) return null;
      }
      const rows = await chatApi.get(`${current.tasksBase}/${item.id}/agent/conversations`);
      return !stale() && Array.isArray(rows) ? rows : null;
    } catch { return null; } // nothing is lost: the chats stay on the server for the next time
  }
  // Keeps the chats listed under the task in the task sheet up to date.
  async function loadChats() {
    const item = task;
    if (!item) { chats = []; return; }
    const rows = await readChats(item);
    if (!rows || task !== item) return;
    chats = rows;
    renderTabs();
  }
  // Opens again the chat saved on this task by the selected Engine.
  async function restoreAgent(item) {
    if (agentChat) return;
    const current = source;
    const list = await readChats(item);
    if (!list || agentChat) return;
    chats = list;
    renderTabs();
    let row = list.filter(entry => entry.opened && entry.opened.h5).sort((x, y) => y.opened.h5 - x.opened.h5)[0];
    const legacy = store.get(legacyKey(item));
    if (legacy) {
      store.set(legacyKey(item), null);
      const old = list.find(entry => entry.id === legacy);
      if (!row && old) { row = old; setOpened(item.id, old.id, true); } // moved to the database
    }
    if (row) mountAgent(row, { remember: false });
  }
  async function openAgentChats(agent, label) {
    const current = task;
    const base = `${source.tasksBase}/${current.id}/agent`;
    showSessionMenu(label, [['Loading…', () => {}]]);
    let rows = [];
    try { rows = await AgentChat.choices(chatApi, base, agent); }
    catch (error) { if (current === task) tell(`Could not load sessions: ${error.message}`, 'error'); }
    if (current !== task || !ui.get().menu) return;
    const start = choice => async () => {
      const title = takeName();
      try {
        const conversation = await AgentChat.open(chatApi, base, agent, choice, title);
        closeTerminalMenu();
        closeTasks();
        if (current === task) mountAgent(conversation);
      } catch (error) { tell(`Could not open the chat: ${error.message}`, 'error'); }
    };
    showSessionMenu(label, [
      [`New ${AgentChat.AGENTS[agent].label} chat`, start(null), null, true],
      ...rows.map(choice => [`${choice.running ? '● ' : ''}${choice.title}`, start(choice), 'raw']),
      ['Back', openSessionMenu],
    ]);
  }
  async function openAgentSessions(agent, label) {
    const current = task;
    showSessionMenu(label, [['Loading…', () => {}]]);
    let rows = [];
    try { rows = await api('GET', `${source.tasksBase}/${current.id}/agent-sessions?agent=${agent}`); }
    catch (error) { if (current === task) tell(`Could not load sessions: ${error.message}`, 'error'); }
    if (current !== task || !ui.get().menu) return;
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
    leaveChat();
    try {
      const row = await api('POST', `${source.tasksBase}/${current.id}/terminals`, options);
      if (!row || !row.terminal_id) throw new Error('The engine returned no terminal');
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
  function sendResize(s) {
    if (s !== session) return; // a hidden warm terminal leaves the PTY size alone
    if (s.ws && s.ws.readyState === WebSocket.OPEN && s.term.cols && s.term.rows) {
      TerminalProtocol.send(s.ws, { type: 'resize', cols: s.term.cols, rows: s.term.rows });
    }
  }
  function refit(s) { if (!s.disposed && s === session) TerminalViewport.fit(s.term, s.fit, s.el); } // a hidden one has no size

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
  }
  function showWarm(s) {
    warm = [s, ...warm.filter(item => item !== s)];
    session = s;
    s.el.hidden = false;
    ui.set({ empty: null });
    holdTerminalSize();
    refit(s);
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
    term.onResize(() => { if (!s.paused) sendResize(s); }); // only the shown one (sendResize)
    let cursorFrame = 0;
    term.onCursorMove(() => { // the cursor decides how far the terminal is shifted while the keyboard is open
      if (!keyboardOpen || cursorFrame) return;
      cursorFrame = requestAnimationFrame(() => { cursorFrame = 0; if (session === s && !s.disposed) holdTerminalSize(); });
    });
    s.observer = new ResizeObserver(() => refit(s));
    s.observer.observe(el);
    holdTerminalSize();
    refit(s);
    open(s);
    ackShown();
    focusTerminalSoon(s);
  }
  // With a keyboard (a computer, or a tablet with a hardware keyboard) the terminal that was just shown takes the focus, so typing goes there at once;
  // not when the person is typing somewhere else or a dialog is open. On a touch screen without a keyboard nothing is focused (no on-screen keyboard).
  function focusTerminalSoon(s) {
    if (!deskKeys()) return;
    setTimeout(() => {
      if (session !== s || s.disposed || agentChat || modalOpen() || editing(document.activeElement)) return;
      s.term.focus();
    }, 0);
  }
  // The wheel strip: a transparent touch strip on the right edge of the terminal (drawn by the shell, scripts/h5-shell/Terminal.jsx).
  // A vertical drag on it works like a scroll wheel. In the normal buffer it scrolls the history with term.scrollLines; a
  // full-screen program (alternate buffer: Claude Code, Codex, vim, tmux ...) has no scrollback, so the drag is sent as wheel
  // events and xterm forwards them the way a desktop wheel would (mouse reports, or arrow keys when the program has no mouse mode).
  // A drag on the terminal body does not make wheel events; the browser scrolls the normal-buffer history natively there.
  // Wheel strip tuning. Change these to tune the feel.
  const WHEEL_GAIN = 2; // lines per terminal row of finger travel
  const WHEEL_FADE_MS = 700; // how long the strip stays visible after the finger is lifted
  const WHEEL_MAX_EVENTS = 200; // wheel events sent per step in the alternate buffer (one per line); high so fast flicks lose no lines
  const WHEEL_FLICK_SPEED = 0.4; // px/ms at release that starts momentum scrolling
  const WHEEL_FLICK_WINDOW_MS = 80; // the finger must have moved this recently when lifted for a flick
  const WHEEL_DECAY = 0.95; // momentum speed factor per 16 ms frame
  const WHEEL_MIN_SPEED = 0.03; // px/ms below which momentum stops
  const WHEEL_TAP_SLOP = 8; // px of travel still counted as a tap
  const WHEEL_TAP_MS = 400; // a tap is shorter than this
  const WHEEL_STALE_MS = 3000; // a finger with no pointer event for this long hides the track (a lost pointerup must not keep it)
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
  // One scroll step. The buffer type is read here, at the moment of sending, so a program that switches between the normal
  // and the alternate screen during a gesture (or during inertia) is followed.
  function scrollStep(s, lines, x, y) {
    if (s.term.buffer.active.type === 'alternate') wheel(s, lines, x, y);
    else s.term.scrollLines(lines);
  }
  function bindWheelStrip() {
    // The browser does not always end a touch: an Android system gesture (edge back swipe, notification shade, app switch),
    // a hidden page, a dialog over the strip, a re-mounted strip or a second finger can swallow the pointerup / pointercancel.
    // So a drag also ends on lostpointercapture, a hidden page, pagehide, window blur, a switched or closed terminal and a
    // detached strip; a new touch always takes over from an old drag; and the track is hidden when no pointer event came for
    // WHEEL_STALE_MS (the next move of the same finger shows it again). Every element that got 'active' loses it.
    let drag = null;
    let fade = 0;
    let watch = 0; // interval that checks the running drag (only while a finger is down)
    let lastMoveAt = 0;
    let inertia = 0; // requestAnimationFrame id of the running momentum scroll
    const shown = new Set(); // strip elements with the 'active' class
    const strip = event => event.target.closest && event.target.closest('#h5-wheel');
    const stopInertia = () => { if (inertia) cancelAnimationFrame(inertia); inertia = 0; };
    const show = el => { el.classList.add('active'); shown.add(el); };
    const hideAll = () => { for (const el of shown) el.classList.remove('active'); shown.clear(); };
    const hideLater = () => { clearTimeout(fade); fade = setTimeout(() => { if (!drag && !inertia) hideAll(); }, WHEEL_FADE_MS); };
    // Ends the drag without a flick or a tap.
    const drop = () => {
      if (!drag) return;
      drag = null;
      clearInterval(watch);
      hideLater();
    };
    const check = () => {
      if (!drag) { clearInterval(watch); return; }
      if (drag.s !== session || drag.s.disposed || !drag.el.isConnected) { drop(); return; }
      if (performance.now() - drag.seen > WHEEL_STALE_MS) hideAll();
    };
    // Momentum after a quick flick: the speed (px/ms) decays by WHEEL_DECAY per 16 ms frame until it is below WHEEL_MIN_SPEED.
    const coast = (s, el, speed, x, y) => {
      let last = performance.now();
      let rest = 0;
      const frame = now => {
        const dt = Math.min(now - last, 64);
        last = now;
        speed *= Math.pow(WHEEL_DECAY, dt / 16);
        if (Math.abs(speed) < WHEEL_MIN_SPEED || session !== s || s.disposed || !el.isConnected) { inertia = 0; hideLater(); return; }
        rest += speed * dt * WHEEL_GAIN;
        const height = lineHeight(s);
        const lines = Math.trunc(rest / height);
        if (lines) { rest -= lines * height; scrollStep(s, lines, x, y); }
        inertia = requestAnimationFrame(frame);
      };
      inertia = requestAnimationFrame(frame);
    };
    // The strip takes the touches, so a tap (no travel) is handed to whatever is under it, for example a link.
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
      const { el, speed, moved, started, s } = drag;
      drop();
      if (event.type !== 'pointerup' || s !== session || s.disposed || !el.isConnected) return;
      const flick = performance.now() - lastMoveAt < WHEEL_FLICK_WINDOW_MS && Math.abs(speed) >= WHEEL_FLICK_SPEED;
      if (Math.abs(moved) < WHEEL_TAP_SLOP && performance.now() - started < WHEEL_TAP_MS) passTap(event, el);
      if (flick) coast(s, el, speed, el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2, event.clientY);
    };
    document.addEventListener('pointerdown', event => {
      const el = strip(event);
      const s = session;
      if (!el || !s || s.disposed || (event.pointerType === 'mouse' && event.button !== 0)) return;
      drop(); // a drag still open here lost its end (or this is a second finger): the new touch takes over
      stopInertia(); // a new touch stops the momentum
      const now = performance.now();
      drag = { id: event.pointerId, el, s, y: event.clientY, rest: 0, total: 0, moved: 0, speed: 0, started: now, seen: now };
      lastMoveAt = now;
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
      const now = performance.now();
      drag.seen = now;
      if (!shown.has(drag.el)) show(drag.el); // hidden by the stale check while the finger was still
      const delta = drag.y - event.clientY; // dragging down is negative: older output, like a wheel turned up
      const dt = Math.max(now - lastMoveAt, 1);
      drag.speed = dt > WHEEL_FLICK_WINDOW_MS ? 0 : drag.speed * 0.5 + (delta / dt) * 0.5; // smoothed finger speed in px/ms
      lastMoveAt = now;
      drag.rest += delta * WHEEL_GAIN;
      drag.total += delta;
      drag.moved += Math.abs(delta);
      drag.y = event.clientY;
      drag.el.style.setProperty('--h5-wheel-offset', `${Math.round(drag.total % 24)}px`); // the ticks follow the finger
      const height = lineHeight(s);
      const lines = Math.trunc(drag.rest / height);
      if (!lines) return;
      drag.rest -= lines * height;
      const rect = drag.el.getBoundingClientRect();
      scrollStep(s, lines, rect.left + rect.width / 2, event.clientY);
    });
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    // Capture lost without a pointerup first (the strip was removed, or the browser took the pointer): the drag is over.
    document.addEventListener('lostpointercapture', finish, true);
    const away = () => { drop(); stopInertia(); hideLater(); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) away(); });
    window.addEventListener('pagehide', away);
    window.addEventListener('blur', event => { if (event.target === window) drop(); });
    // Test hook: lets the browser test see whether the momentum is running.
    window.__h5WheelCoasting = () => Boolean(inertia);
  }
  bindWheelStrip();

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
      if (TerminalOwner.isBlocked(event.code)) {
        if (session !== s) { disposeSession(s); return; } // a hidden warm terminal taken over elsewhere: shown again, it asks then
        TerminalOwner.prompt(s.el.parentElement || s.el, event.code, () => { if (session === s && !s.disposed) open(s, true); });
        return;
      }
      if (event.code === 1000 || event.code === 1008) {
        s.term.write(tr('\r\n[Terminal disconnected. Tap the terminal tab to reconnect]\r\n'));
        return;
      }
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
  const feed = { source: null, live: false, snapshot: null, ctrl: null, retry: 0, retryTimer: null, poll: null, stall: null };
  // The agent counters of the top bar (agent-activity.js) travel in the stream of this machine as `agents`: while they arrive nothing is polled for them;
  // without them (a remote Engine is shown, the stream is down, the page is hidden) they are read every FALLBACK_POLL_MS instead of every 5 s.
  const agentCounters = () => (typeof AgentActivity !== 'undefined' && AgentActivity.page) || null;
  agentCounters()?.setPollMs(FALLBACK_POLL_MS);
  async function readActivity(from) {
    return Promise.all([
      api('GET', `${from.activityBase}/terminal-activity`),
      api('GET', `${from.activityBase}/terminal-subagents`).catch(() => ({})), // an Engine older than this feature: no sub-agent information
    ]);
  }
  // Running (a running state or a running sub-agent) and pending ('done') terminals of the listed tasks: the same set the next-session button goes through.
  function showActiveCount() {
    const snap = feed.snapshot && feed.source === source ? feed.snapshot : null;
    let count = 0;
    if (snap) {
      const listed = new Set(tasks.map(item => String(item.id)));
      for (const taskId of new Set([...Object.keys(snap.activity), ...Object.keys(snap.subagents)])) {
        if (!listed.has(taskId)) continue;
        const states = snap.activity[taskId] || {};
        const subs = snap.subagents[taskId] || {};
        for (const id of new Set([...Object.keys(states), ...Object.keys(subs)])) if (states[id] === 'running' || states[id] === 'done' || Number(subs[id]) > 0) count += 1;
      }
    }
    ui.set({ activeCount: count });
  }
  function applyActivity(from, snap) {
    if (from !== source || feed.source !== from) return;
    const object = value => (value && typeof value === 'object' ? value : {});
    feed.snapshot = { activity: object(snap && snap.activity), subagents: object(snap && snap.subagents) };
    showActiveCount();
    if (from.key === 'local' && snap && snap.agents && typeof snap.agents === 'object') agentCounters()?.push(snap.agents);
    // The shown terminal finished while the person is looking at it: it is seen.
    const s = shownTerminal();
    if (s && s.source === from && ((feed.snapshot.activity[s.task.id] || {})[s.terminalId]) === 'done') ackShown();
  }
  function stopFeed() {
    agentCounters()?.unlive();
    if (feed.ctrl) feed.ctrl.abort();
    clearTimeout(feed.retryTimer);
    clearTimeout(feed.stall);
    clearInterval(feed.poll);
    Object.assign(feed, { live: false, ctrl: null, retryTimer: null, stall: null, poll: null });
  }
  function startFallbackPoll(from) {
    agentCounters()?.unlive();
    if (feed.poll) return;
    const tick = async () => {
      if (document.visibilityState !== 'visible' || feed.live) return;
      try { const [activity, subagents] = await readActivity(from); applyActivity(from, { activity, subagents }); } catch { /* keep the last state */ }
    };
    feed.poll = setInterval(() => void tick(), FALLBACK_POLL_MS);
    void tick();
  }
  function retryFeed(from) {
    feed.live = false;
    startFallbackPoll(from);
    clearTimeout(feed.retryTimer);
    feed.retryTimer = setTimeout(() => void connectFeed(), Math.min(30000, 1000 * 2 ** feed.retry++));
  }
  async function connectFeed() {
    const from = source;
    if (feed.source !== from) { stopFeed(); feed.snapshot = null; feed.retry = 0; showActiveCount(); }
    else { if (feed.ctrl) feed.ctrl.abort(); clearTimeout(feed.retryTimer); clearTimeout(feed.stall); feed.ctrl = null; feed.live = false; }
    feed.source = from;
    if (document.visibilityState !== 'visible') return;
    const ctrl = new AbortController();
    feed.ctrl = ctrl;
    const stalled = () => { clearTimeout(feed.stall); feed.stall = setTimeout(() => ctrl.abort(), STALL_MS); };
    let res;
    try {
      res = await fetch(`${from.activityBase}/terminal-activity/stream`, { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/event-stream' }, cache: 'no-store', signal: ctrl.signal });
    } catch { if (feed.ctrl === ctrl) retryFeed(from); return; }
    if (feed.ctrl !== ctrl) return;
    if (!res.ok || !res.body || !/text\/event-stream/.test(res.headers.get('content-type') || '')) {
      ctrl.abort();
      if ([404, 405, 501].includes(res.status) || res.ok) { feed.ctrl = null; startFallbackPoll(from); } // no stream on this Engine: poll slowly
      else retryFeed(from);
      return;
    }
    feed.live = true;
    feed.retry = 0;
    clearInterval(feed.poll);
    feed.poll = null;
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
          if (event === 'activity' && data) { try { applyActivity(from, JSON.parse(data)); } catch { /* a broken message: wait for the next */ } }
        }
      }
    } catch { /* aborted or dropped */ }
    if (feed.ctrl !== ctrl) return; // closed on purpose (hidden page, another Engine)
    clearTimeout(feed.stall);
    retryFeed(from);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void connectFeed();
    else stopFeed();
  });

  // ── A hardware keyboard: type to the terminal, Escape back to it, Cmd/Ctrl+K for the search (deskKeys: a computer, or a tablet with a keyboard) ──
  const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
  const editing = el => Boolean(el && el.closest && el.closest(EDITABLE));
  // A dialog, a temporary drawer (task sheet, settings, menus) or the copy view is open: keys belong to it.
  const modalOpen = () => Boolean(document.querySelector('.MuiModal-root:not(.MuiModal-hidden), dialog[open]')) || ui.get().copyText !== null;
  const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'AltGraph', 'Dead', 'Unidentified', 'Process', 'Compose']);
  // Cmd+K (Apple) or Ctrl+K (others) focuses the session search; on a wide screen a folded sidebar comes back first. Inside the terminal, Ctrl+K stays the
  // shell's own key (kill to the end of the line), so on other systems it works only outside the terminal.
  document.addEventListener('keydown', event => {
    if (!deskKeys() || event.defaultPrevented || event.repeat || event.shiftKey || event.altKey || (event.key || '').toLowerCase() !== 'k') return;
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
    if (!deskKeys() || event.defaultPrevented || !event.key || MODIFIER_KEYS.has(event.key) || event.metaKey) return;
    if (event.ctrlKey && !APPLE) return;
    const s = session;
    if (!s || s.disposed || agentChat || modalOpen()) return;
    const active = document.activeElement;
    if (editing(active) || (active && active.closest && active.closest('#h5-design-sheet, #h5-files-sheet, #h5-attention-sheet, #h5-agent'))) return;
    if (event.key === 'Escape' && isWide() && ui.get().design && ui.get().design.open) { ui.actions.closeDesign(); return; } // closes the side panel first
    if (event.key === 'Escape' && isWide() && ui.get().files && ui.get().files.open) { ui.actions.closeFiles(); return; } // then the file tree
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
  // The first image on the clipboard, or null when there is none or the browser cannot read images.
  async function clipboardImage() {
    if (!navigator.clipboard?.read) return null;
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(name => /^image\/(png|jpeg|gif|webp)$/.test(name));
        if (type) return new File([await item.getType(type)], 'pasted-image', { type });
      }
    } catch { /* fall back to reading text */ }
    return null;
  }
  async function paste() {
    if (!session) return;
    const target = session;
    const image = await clipboardImage();
    if (image) {
      if (!uploading) void upload(target, image);
      return;
    }
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
  // Enter in the box is a new line (the browser inserts it and the `input` event runs autosize), and so is Shift+Enter. A hardware keyboard has two shortcuts:
  // Cmd+Enter (Ctrl+Enter on other systems) is the translate-and-send button and Option+Enter (Alt+Enter) is the send arrow, through the same submitBox. The key
  // never inserts a new line (preventDefault), and an Enter that confirms an IME candidate (isComposing, keyCode 229) is left alone, so it never sends.
  translateInput.addEventListener('keydown', event => {
    // With a keyboard, Escape leaves the draft box for the terminal (the text stays in the box).
    if (event.key === 'Escape' && deskKeys() && !event.isComposing && session && !session.disposed) { event.preventDefault(); session.term.focus(); return; }
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.shiftKey) return;
    const translateFirst = (event.metaKey || event.ctrlKey) && !event.altKey;
    if (!translateFirst && !(event.altKey && !event.metaKey && !event.ctrlKey)) return; // plain Enter, or Cmd and Option together: a new line as before
    event.preventDefault();
    if (!event.repeat) void submitBox(translateFirst); // a held key sends once
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
    ui.set({ design: { ...base, status: 'loading', dir } });
    const files = `${from.tasksBase}/${current.id}/files`;
    const scope = terminal ? `terminal=${encodeURIComponent(terminal)}&` : '';
    try {
      const file = await api('GET', `${files}/content?${scope}path=${encodeURIComponent(filePath)}`);
      if (seq !== designSeq) return;
      // imageBase: relative images of a Markdown file are read through the same file API (`…/files/image?path=`, images only, at most 5 MB).
      ui.set({ design: { ...base, status: 'ready', dir, content: String((file && file.content) || ''), imageBase: `${files}/image?${scope}path=` } });
    } catch (error) {
      if (seq !== designSeq) return;
      let code = error.message;
      // A folder named without a trailing slash: the content read refuses it; a listing tells a folder from a binary file.
      if (link && code === 'FILE_UNSUPPORTED') {
        try { await api('GET', `${files}?${scope}path=${encodeURIComponent(filePath)}&offset=0`); code = 'FOLDER'; } catch { /* not a folder */ }
        if (seq !== designSeq) return;
      }
      const status = code === 'FOLDER' ? 'folder' : code === 'FILE_NOT_FOUND' ? 'missing' : code === 'TASK_ROOT_UNAVAILABLE' ? 'no-dir' : 'error';
      ui.set({ design: { ...base, status, dir, message: code } });
    }
  }
  ui.actions.openDesign = () => openFileSheet('DESIGN.md');
  // A file outside the working directory (Engines with 'fs:read-any'): `GET {fs}/content?path=` (local `/api/fs`, remote `/api/remote-servers/:id/fs`),
  // read only, as the terminal user, regular files only. The sheet's title is the file name and its second line the full path (the Engine's normalized
  // `path`, so '~/x.md' shows where it is). Relative images of a Markdown file are read with `{fs}/image?path=` from the file's folder.
  async function openAnyFile(seq, filePath, { link, line, directory, from }) {
    const base = { open: true, path: filePath, link, line, absolute: true, dir: '' };
    if (directory) { ui.set({ design: { ...base, status: 'folder' } }); return; }
    ui.set({ design: { ...base, status: 'loading' } });
    const fs = fsBase(from);
    try {
      const file = await api('GET', `${fs}/content?path=${encodeURIComponent(filePath)}`);
      if (seq !== designSeq) return;
      const shown = file && typeof file.path === 'string' && /^\/./.test(file.path) ? file.path : filePath;
      // Design.jsx resolves an image against the folder of `path` without its leading '/' and appends it encoded: the '/' goes in front here.
      const imageBase = `${fs}/image?path=${shown.startsWith('/') ? encodeURIComponent('/') : ''}`;
      ui.set({ design: { ...base, path: shown, status: 'ready', content: String((file && file.content) || ''), imageBase } });
    } catch (error) {
      if (seq !== designSeq) return;
      const code = error.message;
      if (code === 'FS_READ_UNSUPPORTED') {
        // The proxy says the remote Engine has no any-path read (an older Engine after all): forget the capability and say so, as before.
        if (Array.isArray(from.capabilities)) from.capabilities = from.capabilities.filter(name => name !== 'fs:read-any');
        ui.actions.closeDesign();
        tell(`Outside the working directory: ${filePath}`, 'error');
        return;
      }
      const status = code === 'IS_DIRECTORY' ? 'folder' : code === 'NOT_FOUND' ? 'missing' : 'error';
      ui.set({ design: { ...base, status, message: code } });
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
        if (session !== s || s.disposed || longPressDone || ui.get().copyText !== null) return;
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
    // A wide screen: the button shows and hides the panel; a file shown over the tree goes, so the tree is seen.
    if (isWide() && state.files && state.files.open && !viewer) { ui.actions.closeFiles(); return; }
    if (viewer) ui.actions.closeDesign();
    const files = state.files && state.files.key === filesFor().key ? state.files : filesFor();
    ui.set({ files: { ...files, open: true } });
  };
  ui.actions.closeFiles = () => ui.set(state => ({ files: state.files ? { ...state.files, open: false } : null }));
  ui.actions.openTreeFile = filePath => openFileSheet(filePath, { link: true });
  // T-Attention (scripts/h5-shell/Attention.jsx): a file named by a task's context is an absolute path. It opens in the file sheet when it lies inside
  // the working directory of a task of this machine (the deepest one); the file API checks the path again (relative, no symbolic links).
  const localTaskFor = absolute => {
    if (source.key !== 'local' || typeof absolute !== 'string' || !absolute.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(absolute)) return null;
    let best = null;
    for (const item of tasks) {
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
    void openFileSheet(absolute.slice(found.dir.length + 1), { link: true, forTask: found.item });
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
      if (!config || !config.enabled) throw new Error('Enable Alibaba Cloud OSS upload in this client’s settings first');
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
    if (source.key !== 'local' || !taskId) return false;
    if (agentChat && agentFor && agentFor.conversation === conversationId) { closeTasks(); return true; }
    const item = tasks.find(entry => entry.id === Number(taskId));
    if (!item) return false;
    const rows = await readChats(item, { peek: true });
    const row = rows && rows.find(entry => entry.id === conversationId);
    if (!row) return false;
    selectTask(item, { chat: row });
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
  (async () => {
    // The remembered Engine is assumed until the Engine list says otherwise: its tasks are asked for at the same time as the list. Its object is put in
    // `sources` so that loadSources keeps it (requests in flight compare with `source`).
    const remembered = /^remote:(\d+)$/.exec(store.get('source') || '');
    if (remembered) { source = remoteSource(Number(remembered[1]), ''); sources = [LOCAL, source]; }
    const assumed = source;
    // The page opened by a click on a notification: ?openChat=<task id>:<conversation id>.
    const link = /^(\d+):(.+)$/.exec(new URLSearchParams(location.search).get('openChat') || '');
    const savedId = Number(store.get(`task:${assumed.key}`));
    if (savedId > 0 && !link) {
      prefetch(`${assumed.tasksBase}/${savedId}/terminals`);
      if (assumed.key === 'local') prefetch(`${assumed.tasksBase}/${savedId}/agent/conversations`);
      else prefetch(infoUrl(assumed));
      const savedTerminal = store.get(`terminal:${assumed.key}:${savedId}`);
      if (savedTerminal) openEarlySocket(assumed, savedId, savedTerminal);
    }
    const tasksLoaded = loadTasks();
    await loadSources();
    await tasksLoaded;
    if (source !== assumed) { dropEarlySocket(); early.clear(); await loadTasks(); } // the remembered Engine is gone: this machine's tasks
    void connectFeed();
    if (link && await openChatFromLink({ taskId: Number(link[1]), conversationId: link[2] })) return;
    const saved = tasks.find(item => item.id === Number(store.get(`task:${source.key}`)));
    if (saved) selectTask(saved);
    else dropEarlySocket(); // the remembered task is gone
    if (!saved || isWide()) openTasks();
  })();
})();
