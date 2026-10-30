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
  let expandedId = null; // the task whose sessions are listed in the task sheet (a tap on a task opens and closes its list; it does not open the task)
  let peek = null; // the sessions of an expanded task that is not the selected one: { source, taskId, status, terminals, chats }
  let wantedTerminal = null; // the terminal to show when the terminals of the task just selected arrive
  let session = null;
  let mods = {};
  let uploading = false;

  const terminalHost = $('h5-terminal');
  const translateForm = $('h5-translate');
  const translateInput = $('h5-translate-input');
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
    keyboardOpen = fullHeight - height > KEYBOARD_MIN_SHRINK;
    if (ui.get().keysHidden !== keyboardOpen) ui.set({ keysHidden: keyboardOpen }); // the on-screen keyboard has its own keys; the function keys come back when it closes
    document.documentElement.style.setProperty('--h5-height', `${Math.round(height)}px`);
    if (window.scrollY) window.scrollTo(0, 0);
    holdTerminalSize();
  }
  // While the keyboard is open the terminal keeps its closed height, aligned to the bottom of the (shorter) box so the cursor stays visible.
  function holdTerminalSize() {
    const el = session && session.el;
    if (!el) return;
    if (!keyboardOpen || !closedTerminalHeight) {
      el.style.removeProperty('height');
      el.style.removeProperty('bottom');
      el.style.removeProperty('transform');
      return;
    }
    // Shift up by the hidden height, but keep the cursor row on screen when it sits near the top (a shell prompt).
    const hidden = Math.max(0, closedTerminalHeight - terminalHost.clientHeight);
    const screen = el.querySelector('.xterm-screen');
    const shift = TerminalViewport.keyboardShift(session.term, screen ? screen.clientHeight : 0, hidden);
    el.style.height = `${closedTerminalHeight - 6}px`; // the terminal sits 4px from the top and 2px from the bottom of its box
    el.style.bottom = 'auto';
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
        ...chats.map(row => ({ kind: 'chat', id: row.id, title: `${row.running ? '\u25CF ' : ''}${row.title}`, agent: row.agent, current: Boolean(agentFor && agentFor.conversation === row.id), more: true })),
      ],
    };
  }
  // The sessions under an expanded task that is not selected: its terminals, then its chats, as in the list of the selected task (without the "⋯" actions).
  function peekSessions(item) {
    const label = item.title;
    if (!peek || peek.taskId !== item.id || peek.source !== source || peek.status === 'loading') return { label, note: 'Loading…', rows: [] };
    if (peek.status === 'error') return { label, note: 'Could not load the sessions', rows: [] };
    const rows = [
      ...peek.terminals.map(row => ({ kind: 'terminal', id: row.terminal_id, title: row.title, agent: row.agent || null, current: false, more: false })),
      ...peek.chats.map(row => ({ kind: 'chat', id: row.id, title: `${row.running ? '\u25CF ' : ''}${row.title}`, agent: row.agent, current: false, more: false })),
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
          const open = expandedId === item.id;
          // A tap opens or closes the list of sessions under the task. Going to a session is a tap on that session.
          const hasSessions = Boolean(selected && (terminals.length || chats.length));
          // The selected task: "+" on the right of its row adds a terminal.
          return { id: item.id, title: item.title, selected, expanded: open, add: hasSessions, sessions: open ? (selected ? (hasSessions ? ownSessions() : null) : peekSessions(item)) : null };
        }),
      });
    }
    ui.set({ taskList: { note: null, groups: out } });
  }

  // target: where to go in the task, { terminal: id } or { chat: row }; without one, the task opens as it was left (its terminal, or the chat that was open).
  function selectTask(item, target = null) {
    // A chat open over another task is put away (but not forgotten: it comes back with its task).
    if (agentChat && agentFor && (!item || agentFor.taskId !== item.id || agentFor.source !== source.key)) hideAgent();
    task = item;
    chats = [];
    peek = null;
    expandedId = item ? item.id : null;
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
    if (expandedId === item.id) { expandedId = null; renderTasks(); return; }
    expandedId = item.id;
    if (!(task && task.id === item.id)) void loadPeek(item);
    renderTasks();
  }
  // The terminals and chats of a task that is not the selected one, read when its list is opened.
  async function loadPeek(item) {
    const current = source;
    const mine = { source: current, taskId: item.id, status: 'loading', terminals: [], chats: [] };
    peek = mine;
    const [rows, chatRows] = await Promise.all([
      api('GET', `${current.tasksBase}/${item.id}/terminals`).catch(() => null),
      readChats(item, { peek: true }),
    ]);
    if (peek !== mine || source !== current) return;
    mine.status = Array.isArray(rows) ? 'ready' : 'error';
    mine.terminals = Array.isArray(rows) ? rows : [];
    mine.chats = chatRows || [];
    renderTasks();
  }
  // Goes to a session of a task that is not the selected one: the task is selected and that session is shown.
  function openFromPeek(item, target) {
    // A chat that was open on the phone for this task is not any more once a terminal is shown, as when going to a terminal inside the task.
    if (target.terminal && peek && peek.taskId === item.id) for (const row of peek.chats) if (row.opened && row.opened.h5) setOpened(item.id, row.id, false);
    selectTask(item, target);
  }
  // A wide screen (a computer, a landscape tablet) shows the task list as a permanent sidebar next to the terminal: it is never closed,
  // the page behind it stays usable, and a phone-sized screen keeps the sheet that slides over the page.
  const wideQuery = window.matchMedia('(min-width: 900px)');
  const isWide = () => wideQuery.matches;
  function openTasks() {
    const wide = isWide();
    if (!wide || !ui.get().tasksOpen) expandedId = task ? task.id : null; // the sheet opens with the sessions of the task that is shown, as before
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
  ui.actions.closeTasks = closeTasks;
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
        const entry = chats.find(candidate => candidate.id === row.id);
        if (entry) { closeTasks(); mountAgent(entry); }
      }
      return;
    }
    if (row.kind === 'terminal') openFromPeek(item, { terminal: row.id });
    else if (row.kind === 'chat') { const entry = peek && peek.chats.find(candidate => candidate.id === row.id); if (entry) openFromPeek(item, { chat: entry }); }
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
    expandedId = null;
    peek = null;
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
    showMenu(row.title, [
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

  // ── Agent chat: the same Claude / Codex sessions as a conversation view instead of a terminal ──
  const agentView = $('h5-agent');
  const chatApi = { get: url => api('GET', url), post: (url, body) => api('POST', url, body), patch: (url, body) => api('PATCH', url, body), del: url => api('DELETE', url) };
  let agentChat = null;
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
  function mountAgent(conversation, { remember = true } = {}) {
    if (agentChat) agentChat.destroy();
    agentView.hidden = false;
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitAgentView);
      window.visualViewport.addEventListener('scroll', fitAgentView);
    }
    fitAgentView();
    agentChat = AgentChat.mount(agentView, { api: chatApi, base: `${source.tasksBase}/${task.id}/agent`, conversation, onClose: closeAgent, notify: message => tell(message, 'error'),
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
  function sendResize(s) {
    if (s.ws && s.ws.readyState === WebSocket.OPEN && s.term.cols && s.term.rows) {
      s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
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
      cursorBlink: true,
      fontSize: 11,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#121212' },
      scrollback: 5000,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
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
    term.onData(data => send(s, withModifiers(data)));
    TerminalIme.attach(term, data => send(s, withModifiers(data))); // the Apple Chinese keyboard's spaces and punctuation, which xterm drops
    term.onResize(() => { if (!s.paused) sendResize(s); });
    let cursorFrame = 0;
    term.onCursorMove(() => { // the cursor decides how far the terminal is shifted while the keyboard is open
      if (!keyboardOpen || cursorFrame) return;
      cursorFrame = requestAnimationFrame(() => { cursorFrame = 0; if (session === s && !s.disposed) holdTerminalSize(); });
    });
    bindTouchScroll(s);
    s.observer = new ResizeObserver(() => refit(s));
    s.observer.observe(el);
    holdTerminalSize();
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

  function open(s, takeover = false) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${s.source.wsPath}?taskId=${s.task.id}&terminalId=${encodeURIComponent(s.terminalId)}${TerminalOwner.query(takeover)}`);
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
  function toggleKeyboard() {
    if (!session) return;
    if (session.el.contains(document.activeElement)) document.activeElement.blur();
    else session.term.focus();
  }
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
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  }
  function openCopy() {
    const text = session && !session.disposed ? bufferText(session.term) : '';
    if (!text) { tell('Nothing to copy'); return; }
    ui.set({ copyText: text });
  }
  function closeCopy() { ui.set({ copyText: null }); }
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

  // The floating buttons move about a page per click: scrollback in the normal buffer, wheel events in a full-screen program.
  ui.actions.scrollPage = direction => {
    const s = session;
    if (!s || s.disposed) return;
    if (s.term.buffer.active.type === 'alternate') {
      const rect = (s.el.querySelector('.xterm-screen') || s.el).getBoundingClientRect();
      wheel(s, direction * 5, rect.left + rect.width / 2, rect.top + rect.height / 2);
    } else {
      s.term.scrollLines(direction * Math.max(1, s.term.rows - 2));
    }
  };

  // A tap on a key of the key bar (the shell keeps the focus where it is, so tapping keys does not open or close the on-screen keyboard).
  ui.actions.key = item => {
    if (item.modifier) {
      mods[item.modifier] = !mods[item.modifier];
      renderMods();
    } else if (item.action === 'keyboard') toggleKeyboard();
    else if (item.action === 'paste') void paste();
    else if (item.action === 'image') pickImage();
    else if (item.shortcut === 'ctrl-c') sendKey('c', { ctrl: true });
    else if (item.key) sendKey(item.key, mods);
  };

  // ── Translate and send ──
  let translating = false;
  function autosize() {
    translateInput.style.height = 'auto';
    if (translateInput.value) translateInput.style.height = `${translateInput.scrollHeight + 2}px`;
  }
  async function translate() {
    const text = translateInput.value.trim();
    if (translating || !text) return;
    const target = session;
    if (uploading || !connected(target)) { tell('The terminal is not connected', 'error'); return; }
    translating = true;
    ui.set({ translating: true });
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
      if (/not configured/i.test(message)) tell('Set up the translation service in Settings');
    } finally {
      translating = false;
      ui.set({ translating: false });
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
