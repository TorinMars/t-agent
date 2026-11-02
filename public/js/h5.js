// Phone page (/h5): tasks, terminals, image upload and translate-and-send. It shares the task terminals with the desktop page;
// only one client at a time is attached to a terminal, and the other one can take it over with a button.
// This file is the controller: the tasks, the terminals and their sockets, the chat, the viewport. What the page looks like is the Material UI shell
// (scripts/h5-shell, js/h5-shell.js): this file writes the state the shell shows (`ui.set`) and registers what a tap does (`ui.actions`).
(() => {
  const $ = id => document.getElementById(id);
  const ui = window.H5UI;
  const tell = (message, type = 'info') => notify(message, type);
  const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
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
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (window.innerWidth !== fullWidth) { fullWidth = window.innerWidth; fullHeight = 0; } // rotated: measure again
    fullHeight = Math.max(fullHeight, height);
    const wasOpen = keyboardOpen;
    keyboardOpen = fullHeight - height > KEYBOARD_MIN_SHRINK;
    if (wasOpen && !keyboardOpen) {
      // The keyboard went away: the translate box returns to rest at once (no timer; blur runs the focusout handler, which collapses the box, the bar and the terminal
      // shift in the same tick). One animation frame of grace only, because iOS can report the full height for a moment while focus moves between two inputs.
      requestAnimationFrame(() => { if (!keyboardOpen && document.activeElement === translateInput) translateInput.blur(); });
      scheduleKeyboardReset();
    }
    document.documentElement.style.setProperty('--h5-height', `${Math.round(height)}px`);
    if (window.scrollY) window.scrollTo(0, 0);
    holdTerminalSize();
  }
  // Android: the back button closes the keyboard but leaves the terminal input focused, so `focusout` never restores
  // inputmode="none" and the next terminal tap would reopen the keyboard. Reset it a moment after the keyboard really closed,
  // unless the keyboard key was used meanwhile (it manages inputmode itself) or the keyboard is open again.
  const KEYBOARD_RESET_DELAY_MS = 350;
  const KEYBOARD_TOGGLE_GRACE_MS = 800;
  let keyboardToggledAt = -Infinity;
  let keyboardResetTimer = 0;
  function scheduleKeyboardReset() {
    clearTimeout(keyboardResetTimer);
    keyboardResetTimer = setTimeout(() => {
      keyboardResetTimer = 0;
      // (The translate box is blurred at once in fitViewport, not here: it has no reason to wait.)
      const textarea = session && session.term && session.term.textarea;
      if (keyboardOpen || !textarea || textarea.getAttribute('inputmode') === 'none') return;
      if (Date.now() - keyboardToggledAt < KEYBOARD_TOGGLE_GRACE_MS) return;
      if (document.activeElement === textarea) textarea.blur(); // the focusout handler sets inputmode to none
      noScreenKeyboard(session.term);
    }, KEYBOARD_RESET_DELAY_MS);
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
    settleTimers = [0, 100, 250, 500, 1000].map(delay => setTimeout(fitViewport, delay));
  }
  document.addEventListener('focusin', settleViewport);
  document.addEventListener('focusout', settleViewport);
  setInterval(() => { if (keyboardOpen) fitViewport(); }, 500);

  // ── Tasks ──
  // The task list the shell draws: a note (loading, an error, no tasks), or groups of tasks, each with the sessions listed under it when it is open.
  function note(text) { ui.set({ taskList: { note: text, groups: [] } }); }

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
      return true;
    } catch (error) {
      if (current === source) { tasks = []; note(`Could not load tasks: ${error.message}`); }
      return false;
    }
  }

  // The sessions of the selected task: its terminals, then its chats (the way back into one that was left by going to a terminal); each has "⋯" actions.
  function ownSessions() {
    return {
      label: 'Phone terminals', note: null,
      rows: [
        ...terminals.map(row => ({ kind: 'terminal', id: row.terminal_id, title: row.title, agent: row.agent || null, current: row.terminal_id === terminalId && !agentChat, more: true })), // only one of a terminal and a chat is shown
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
      ...peek.terminals.map(row => ({ kind: 'terminal', id: row.terminal_id, title: row.title, agent: row.agent || null, current: false, more: false })),
      ...peek.chats.map(row => ({ kind: 'chat', id: row.id, title: row.title, running: Boolean(row.running), pending: Boolean(row.pending), updated: row.updated_at || null, agent: row.agent, current: false, more: false })),
    ];
    if (!rows.length) rows.push({ kind: 'open', id: 'open', title: tr('Open this task'), agent: null, current: false, more: false });
    return { label, note: null, rows };
  }

  function renderTasks() {
    if (!tasks.length) { note('No tasks yet. Create one above'); return; }
    const ordered = [...groups].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const known = new Set(ordered.map(group => group.key));
    for (const item of tasks) {
      if (!known.has(item.status)) { known.add(item.status); ordered.push({ key: item.status, name: item.status }); }
    }
    const out = [];
    for (const group of ordered) {
      const members = tasks.filter(item => item.status === group.key);
      if (!members.length) continue;
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
    const wanted = Boolean(task) && document.visibilityState === 'visible';
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
  function selectTask(item, target = null) {
    // A chat open over another task is put away (but not forgotten: it comes back with its task).
    if (agentChat && agentFor && (!item || agentFor.taskId !== item.id || agentFor.source !== source.key)) hideAgent();
    task = item;
    void syncWakeLock();
    chats = [];
    if (item) { peeks.delete(item.id); expanded.add(item.id); } // the other open lists stay open
    wantedTerminal = target && target.terminal ? target.terminal : null;
    store.set(`task:${source.key}`, item ? item.id : null);
    ui.set({ taskName: item ? item.title : '' });
    closeTasks();
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
  const wideQuery = window.matchMedia('(min-width: 900px)');
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
    if (changed) renderTasks();
  }
  function closeTasks() {
    if (isWide()) return; // the sidebar stays
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

  ui.actions.openTasks = openTasks;
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
    disconnect();
    terminals = [];
    renderTabs();
    showEmpty('Choose a task to open its phone terminal');
    void loadTasks();
  };
  // Resolves to whether the task was made (the shell then empties its input).
  ui.actions.createTask = async title => {
    const current = source;
    ui.set({ creatingTask: true });
    try {
      const created = await api('POST', current.tasksBase, { title });
      if (current !== source) return true;
      await loadTasks();
      selectTask(tasks.find(item => item.id === created.id) || created);
      return true;
    } catch (error) {
      tell(`Could not create the task: ${error.message}`, 'error');
      return false;
    } finally { ui.set({ creatingTask: false }); }
  };

  // ── Phone terminals ──
  function showEmpty(text) { ui.set({ empty: text }); }

  async function loadTerminals() {
    disconnect();
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
    if (!terminals.length) { showEmpty('This task has no terminal yet'); return; }
    const saved = store.get(`terminal:${source.key}:${current.id}`);
    const wanted = wantedTerminal; // a session that was tapped in the task sheet
    wantedTerminal = null;
    terminalId = [wanted, saved].find(id => id && terminals.some(row => row.terminal_id === id)) || terminals[0].terminal_id;
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

  // ── Terminal actions: rename, reopen, restart in the working directory, delete (same endpoints as the desktop tabs) ──
  // One sheet (the shell's `menu`) serves the actions of a terminal, the actions of a chat and the "Session" choices of the "+" of a task. Its items are
  // { label, kind } in the state and their functions are kept here, in the order shown.
  let menuRuns = [];
  let menuRow = null;
  let menuChat = null; // the chat whose actions are open

  function closeTerminalMenu() {
    menuRow = null;
    menuChat = null;
    menuRuns = [];
    ui.set({ menu: null });
  }
  // items: [label, run, kind]; kind 'danger' is drawn as a warning, 'raw' is a name that is not translated.
  function showMenu(title, items) {
    menuRuns = items.map(item => item[1]);
    ui.set({ menu: { title, items: items.map(([label, , kind]) => ({ label, kind: kind || null })), renaming: false, renameValue: '' } });
  }
  const askRename = value => ui.set(state => ({ menu: state.menu && { ...state.menu, renaming: true, renameValue: value } }));
  function openTerminalMenu(row) {
    menuRow = row;
    menuChat = null;
    // "Copy text" is for the terminal that is open (the copy view reads its buffer); the long press on the terminal body is the other way in.
    const open = row.terminal_id === terminalId && !agentChat && session && !session.disposed;
    showMenu(row.title, [
      ...(open ? [['Copy text', () => { closeTerminalMenu(); closeTasks(); openCopy(); }]] : []),
      ...(row.agent ? [] : [['Rename', () => askRename(row.title)]]),
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
  function showSessionMenu(title, items) { showMenu(tr(title), items); }
  async function openSessionMenu() {
    const currentSource = source;
    const currentTask = task;
    menuRow = null;
    menuChat = null;
    const show = chatsAvailable => showSessionMenu('Session', [
      ['New Terminal', () => { closeTerminalMenu(); closeTasks(); void createTerminal(); }],
      ...SESSION_KINDS.map(([agent, label]) => [label, () => void openAgentSessions(agent, label)]),
      ...(chatsAvailable ? [['Claude agent', () => void openAgentChats('claude', 'Claude agent')], ['Codex agent', () => void openAgentChats('codex', 'Codex agent')]] : []),
    ]);
    show(source.key === 'local');
    if (source.key === 'local') return;
    try {
      const info = await api('GET', `${source.tasksBase.replace(/\/tasks$/, '')}/info`);
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
    if (!(task && task.id === item.id)) selectTask(item, null);
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
        const info = await api('GET', `${current.tasksBase.replace(/\/tasks$/, '')}/info`);
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
      try {
        const conversation = await AgentChat.open(chatApi, base, agent, choice);
        closeTerminalMenu();
        closeTasks();
        if (current === task) mountAgent(conversation);
      } catch (error) { tell(`Could not open the chat: ${error.message}`, 'error'); }
    };
    showSessionMenu(label, [
      [`New ${AgentChat.AGENTS[agent].label} chat`, start(null)],
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
    const start = sessionId => () => { closeTerminalMenu(); closeTasks(); void createTerminal({ agent, session_id: sessionId }); };
    showSessionMenu(label, [
      [`New ${label}`, start(undefined)],
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
    if (s.ws && s.ws.readyState === WebSocket.OPEN && s.term.cols && s.term.rows) {
      TerminalProtocol.send(s.ws, { type: 'resize', cols: s.term.cols, rows: s.term.rows });
    }
  }
  function refit(s) { if (!s.disposed) TerminalViewport.fit(s.term, s.fit, s.el); }

  function connect() {
    disconnect();
    if (!task || !terminalId) return;
    ui.set({ empty: null });
    const el = document.createElement('div');
    el.className = 'h5-xterm';
    terminalHost.append(el);
    const term = new Terminal({
      allowProposedApi: true, // needed by the Unicode 11 addon
      cursorBlink: true,
      fontSize: 11,
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
    // textarea stays focusable for a hardware keyboard but asks for no on-screen keyboard. Only the keyboard key opens it.
    noScreenKeyboard(term);
    el.addEventListener('focusout', () => noScreenKeyboard(term)); // the keyboard closed: the next terminal tap must not reopen it
    const s = { term, fit, el, ws: null, timer: null, attempts: 0, paused: false, disposed: false, task, terminalId, source };
    session = s;
    // A pasted image (long-press paste in the xterm textarea) is uploaded like a picked one; plain text keeps xterm's own paste.
    el.addEventListener('paste', event => {
      const images = [...(event.clipboardData?.items || [])].filter(entry => entry.kind === 'file' && entry.type.startsWith('image/'));
      if (!images.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (images.length !== 1) { tell('Upload one image at a time', 'error'); return; }
      if (!uploading) void upload(s, images[0].getAsFile());
    }, true);
    term.onData(data => typed(s, data));
    TerminalIme.attach(term, data => typed(s, data)); // the Apple Chinese keyboard's spaces and punctuation, which xterm drops
    term.onResize(() => { if (!s.paused) sendResize(s); });
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
    let drag = null;
    let fade = 0;
    let lastMoveAt = 0;
    let inertia = 0; // requestAnimationFrame id of the running momentum scroll
    const strip = event => event.target.closest && event.target.closest('#h5-wheel');
    const stopInertia = () => { if (inertia) cancelAnimationFrame(inertia); inertia = 0; };
    const hideLater = el => { clearTimeout(fade); fade = setTimeout(() => { if (!drag && !inertia) el.classList.remove('active'); }, WHEEL_FADE_MS); };
    // Momentum after a quick flick: the speed (px/ms) decays by WHEEL_DECAY per 16 ms frame until it is below WHEEL_MIN_SPEED.
    const coast = (s, el, speed, x, y) => {
      let last = performance.now();
      let rest = 0;
      const frame = now => {
        const dt = Math.min(now - last, 64);
        last = now;
        speed *= Math.pow(WHEEL_DECAY, dt / 16);
        if (Math.abs(speed) < WHEEL_MIN_SPEED || session !== s || s.disposed) { inertia = 0; hideLater(el); return; }
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
      const { el, speed, moved, started } = drag;
      const s = session;
      drag = null;
      const flick = event.type === 'pointerup' && s && !s.disposed && performance.now() - lastMoveAt < WHEEL_FLICK_WINDOW_MS && Math.abs(speed) >= WHEEL_FLICK_SPEED;
      if (event.type === 'pointerup' && Math.abs(moved) < WHEEL_TAP_SLOP && performance.now() - started < WHEEL_TAP_MS) passTap(event, el);
      if (flick) coast(s, el, speed, el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2, event.clientY);
      hideLater(el);
    };
    document.addEventListener('pointerdown', event => {
      const el = strip(event);
      const s = session;
      if (!el || !s || s.disposed || drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
      stopInertia(); // a new touch stops the momentum
      drag = { id: event.pointerId, el, y: event.clientY, rest: 0, total: 0, moved: 0, speed: 0, started: performance.now() };
      lastMoveAt = performance.now();
      clearTimeout(fade);
      el.classList.add('active');
      try { el.setPointerCapture(event.pointerId); } catch { /* the pointer is gone already */ }
      event.preventDefault();
    });
    document.addEventListener('pointermove', event => {
      const s = session;
      if (!drag || event.pointerId !== drag.id || !s || s.disposed) return;
      event.preventDefault();
      const now = performance.now();
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
    // Test hook: lets the browser test see whether the momentum is running.
    window.__h5WheelCoasting = () => Boolean(inertia);
  }
  bindWheelStrip();

  function open(s, takeover = false) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${s.source.wsPath}?taskId=${s.task.id}&terminalId=${encodeURIComponent(s.terminalId)}${TerminalOwner.query(takeover)}${TerminalProtocol.query()}`);
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
  }

  // The server sends the saved screen first; input is held back until it has been drawn.
  function replay(s, ws, message) {
    s.paused = true;
    s.queued = '';
    s.term.reset();
    if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 1000 && message.rows >= 1 && message.rows <= 1000) {
      s.term.resize(message.cols, message.rows);
    }
    s.term.write(typeof message.data === 'string' ? message.data : '', () => {
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

  function disconnect() {
    const s = session;
    session = null;
    if (!s) return;
    s.disposed = true;
    clearTimeout(s.timer);
    s.heartbeat?.stop();
    s.observer?.disconnect();
    if (s.ws) { const ws = s.ws; s.ws = null; try { ws.close(); } catch { /* already closed */ } }
    s.term.dispose();
    s.el.remove();
  }

  // Phones drop sockets in the background; reconnect when the page comes back.
  document.addEventListener('visibilitychange', () => {
    void syncWakeLock();
    if (document.visibilityState !== 'visible') return;
    fitViewport();
    if (session && !session.ws && !session.timer) open(session);
    else if (session && !session.ws && session.timer) { clearTimeout(session.timer); session.timer = null; open(session); } // do not wait out the backoff
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
  function noScreenKeyboard(term) {
    if (term.textarea) term.textarea.setAttribute('inputmode', 'none');
  }
  // The keyboard key is the only way to open the on-screen keyboard from the terminal. iOS reads inputmode only when the
  // element gets focus, so the value is changed while blurred and the focus follows.
  function toggleKeyboard() {
    if (!session || !session.term.textarea) return;
    const textarea = session.term.textarea;
    keyboardToggledAt = Date.now();
    const open = textarea.getAttribute('inputmode') !== 'none';
    textarea.blur(); // the focusout handler sets inputmode to none
    if (open) return;
    textarea.setAttribute('inputmode', 'text');
    session.term.focus();
  }
  // The "Draft keyboard" key: focus the draft box (it is hidden until it has the focus, see TranslateBar), so the on-screen keyboard types into it; a second tap closes the keyboard.
  // The terminal's textarea loses the focus and, through its focusout handler, goes back to inputmode none.
  function toggleDraftKeyboard() {
    if (document.activeElement === translateInput) { translateInput.blur(); return; }
    translateInput.focus();
    autosize();
    relayoutBar();
  }
  // Which keyboard key is blue: the terminal one while the terminal's textarea has the focus with the on-screen keyboard allowed, the draft one while the draft box has the focus.
  function keyboardTarget(el) {
    if (el === translateInput) return 'draft';
    const textarea = session && session.term && session.term.textarea;
    return el && el === textarea && textarea.getAttribute('inputmode') !== 'none' ? 'terminal' : null;
  }
  document.addEventListener('focusin', event => ui.set({ keyboard: keyboardTarget(event.target) }));
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
      if (session && !session.disposed && ui.get().copyText === null) openCopy();
    }, LONG_PRESS_MS) };
  });
  terminalHost.addEventListener('pointermove', event => {
    if (longPress && event.pointerId === longPress.id && Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > LONG_PRESS_SLOP) cancelLongPress();
  });
  for (const type of ['pointerup', 'pointercancel']) terminalHost.addEventListener(type, cancelLongPress);
  terminalHost.addEventListener('scroll', cancelLongPress, true);
  terminalHost.addEventListener('contextmenu', event => { if (event.target.closest && event.target.closest('.h5-xterm') && longPressDone) event.preventDefault(); });

  // Double tap selects a word and triple tap a line, with xterm's own selection (term.select / selectLines), then a small Copy / Cancel bar shows
  // (the shell draws it from `selectionBar`). Only while the program has no mouse mode (term.modes.mouseTrackingMode === 'none'): vim, tmux and
  // Claude Code get every tap as a click, never swallowed. The cell comes from the bounding box of .xterm-screen, which already includes the 4px
  // inset, any transform (scale) and the keyboard shift. New output, or a tap elsewhere, clears the selection.
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
    s.term.onSelectionChange(() => { // the bar follows the selection, however it was made or cleared
      if (session !== s || s.disposed) return;
      const shown = s.term.hasSelection();
      if (shown !== Boolean(ui.get().selectionBar)) ui.set({ selectionBar: shown });
    });
    s.term.onWriteParsed(() => { if (s.term.hasSelection()) { s.term.clearSelection(); ui.set({ selectionBar: false }); } }); // new output moves the text under the selection
  }
  terminalHost.addEventListener('click', event => {
    const s = session;
    if (!s || s.disposed || !lastPointerTouch || longPressDone || !event.target.closest || !event.target.closest('.h5-xterm')) return;
    const now = Date.now();
    const chain = now - tapChain.at < MULTI_TAP_MS && Math.hypot(event.clientX - tapChain.x, event.clientY - tapChain.y) < MULTI_TAP_SLOP ? tapChain.count + 1 : 1;
    tapChain = { count: chain, at: now, x: event.clientX, y: event.clientY };
    hookSelection(s);
    if (chain === 1) { if (s.term.hasSelection()) s.term.clearSelection(); ui.set({ selectionBar: false }); return; } // a tap elsewhere
    if (chain > 3) { tapChain.count = 1; return; }
    if (s.term.modes.mouseTrackingMode !== 'none') return; // the program owns the taps
    const cell = cellAt(s, event.clientX, event.clientY);
    if (cell && selectAt(s, cell, chain)) ui.set({ selectionBar: s.term.hasSelection() }); // xterm reports the change a frame later; do not wait for it
  });
  async function copySelection() {
    const s = session;
    const text = s && !s.disposed ? s.term.getSelection() : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard API (plain HTTP): the legacy copy command from a temporary read-only field.
      const field = document.createElement('textarea');
      field.value = text;
      field.readOnly = true;
      field.setAttribute('aria-hidden', 'true');
      field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.append(field);
      field.select();
      const ok = document.execCommand && document.execCommand('copy');
      field.remove();
      if (!ok) { tell('Could not copy. Select the text and copy it by hand', 'error'); return; }
    }
    s.term.clearSelection();
    ui.set({ selectionBar: false });
    tell('Copied', 'success');
  }
  ui.actions.selectionCopy = () => void copySelection();
  ui.actions.selectionCancel = () => { if (session && !session.disposed) session.term.clearSelection(); ui.set({ selectionBar: false }); };

  // A tap on a key of the key bar (the shell keeps the focus where it is, so tapping keys does not open or close the on-screen keyboard).
  // Types a preset command into the terminal like a paste; no Enter is sent, so the user checks it and presses Enter.
  ui.actions.insertCommand = command => {
    if (uploading || !connected(session)) { tell('The terminal is not connected', 'error'); return; }
    session.term.paste(command);
  };
  ui.actions.key = item => {
    if (item.modifier) {
      mods[item.modifier] = !mods[item.modifier];
      renderMods();
    } else if (item.action === 'keyboard') toggleKeyboard();
    else if (item.action === 'draft') toggleDraftKeyboard();
    else if (item.action === 'paste') void paste();
    else if (item.action === 'image') pickImage();
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
  function autosize() {
    const input = translateInput;
    input.style.height = '';
    input.style.overflowY = 'hidden';
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
  // The translation keeps its line breaks only when the program in the terminal reads a paste as one paste (bracketed paste mode, as Claude Code does). Then it
  // goes in as ONE bracketed paste, so no line is run on its own. Without that mode a shell would run every line at once, so the lines are joined with spaces.
  // Control characters (ESC included) are removed in both cases, so the text cannot carry its own paste end marker or any key sequence.
  const LINE_CONTROLS = new RegExp('[\\u0000-\\u0009\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]+', 'g');
  function pasteText(raw) {
    const lines = String(raw).replace(/\r\n?|\u2028|\u2029/g, '\n').replace(LINE_CONTROLS, ' ').split('\n').map(line => line.replace(/\s+/g, ' ').trim());
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function sendTranslation(target, raw) {
    const text = pasteText(raw);
    if (!text) return false;
    if (!text.includes('\n')) return send(target, text);
    if (target.term && target.term.modes && target.term.modes.bracketedPasteMode) return send(target, `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`);
    return send(target, TerminalTranslate.sanitize(text));
  }
  // Two ways to send what is in the box. Translate button: translate first, then send the English result. Send arrow: send the text as typed, with no translation
  // and no request to the translator. Both use the same safe rules (sendTranslation: control characters removed, bracketed paste or lines joined) and then one Enter.
  // When the translation fails nothing is sent, the error is shown and the text stays in the box.
  async function submitBox(translateFirst) {
    const text = translateInput.value.trim();
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
      } else if (!pasteText(outgoing)) throw new Error('Nothing to send');
      if (!sendTranslation(target, outgoing)) throw new Error('Terminal not connected; the text was not sent');
      setTimeout(() => send(target, '\r'), SUBMIT_DELAY_MS);
      translateInput.value = '';
      translateForm.removeAttribute('data-hold'); // the press on the send button is over: do not keep the box shown
      translateInput.blur(); // sent: the on-screen keyboard goes away and the box hides at once (no timer); the terminal is not focused
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
  // Enter in the box is a new line (the browser inserts it and the `input` event runs autosize); only the Send button submits. There is no keydown handler on purpose.
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
    const overlap = height;
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
    ui.set({ upload: { status: 'Reading OSS settings…', progress: 0 } });
    return {
      status: text => ui.set(state => ({ upload: state.upload && { ...state.upload, status: text } })),
      progress: value => ui.set(state => ({ upload: state.upload && { ...state.upload, progress: value } })),
      unlock() { ui.set({ upload: null }); uploading = false; },
    };
  }

  // The image goes from this browser straight to OSS (oss-direct.js); the Client only signs the upload.
  const transfer = (file, ui2) => OssDirect.upload(file, {
    status: text => ui2.status(text),
    progress: value => ui2.progress(value),
  });

  // When the terminal went away during the upload, keep the link on screen so it is not lost.
  function retain(url) { ui.set({ retainUrl: url }); }
  ui.actions.retainClose = () => ui.set({ retainUrl: null });

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

  // ── Start ──
  (async () => {
    await loadSources();
    await loadTasks();
    // The page opened by a click on a notification: ?openChat=<task id>:<conversation id>.
    const link = /^(\d+):(.+)$/.exec(new URLSearchParams(location.search).get('openChat') || '');
    if (link && await openChatFromLink({ taskId: Number(link[1]), conversationId: link[2] })) return;
    const savedId = Number(store.get(`task:${source.key}`));
    const saved = tasks.find(item => item.id === savedId);
    if (saved) selectTask(saved);
    if (!saved || isWide()) openTasks();
  })();
})();
