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
    keys.hidden = keyboardOpen; // the on-screen keyboard has its own keys; the function keys come back when it closes
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
        if (task && task.id === item.id && terminals.length) {
          // The selected task: "+" on the right of its row adds a terminal, and its terminals are listed under it.
          const row = document.createElement('div');
          row.className = 'h5-task-row';
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'h5-task-add';
          add.textContent = '+';
          add.setAttribute('aria-label', 'Session');
          add.addEventListener('click', openSessionMenu);
          row.append(button, add);
          nodes.push(row, terminalList());
        } else {
          nodes.push(button);
        }
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
    void refreshTerminals();
    clearInterval(namesTimer);
    namesTimer = setInterval(() => void refreshTerminals(), 8000);
  }
  // Claude / Codex terminals are named after their session, which can change inside the agent (rename, first prompt): refresh while the list is open.
  let namesTimer = null;
  async function refreshTerminals() {
    const current = task;
    if (!current || !terminals.some(row => row.agent)) return;
    let rows;
    try { rows = await api('GET', `${source.tasksBase}/${current.id}/terminals?surface=h5`); } catch { return; }
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
    clearInterval(namesTimer);
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
  }

  // ── Settings: language and the PC one-click update (same /api/system endpoints as the desktop page) ──
  const settings = $('h5-settings');
  const updateButton = $('h5-update-check');
  const updateHint = $('h5-update-hint');
  const updateConfirm = $('h5-update-confirm');
  const updateLog = $('h5-update-log');
  let updateTimer = null;
  let updateBusy = false;

  function openSettings() {
    settings.classList.add('open');
    settings.setAttribute('aria-hidden', 'false');
  }
  function closeSettings() {
    settings.classList.remove('open');
    settings.setAttribute('aria-hidden', 'true');
  }
  function showUpdate(message, lines) {
    updateHint.textContent = tr(message);
    updateHint.hidden = false;
    if (Array.isArray(lines) && lines.length) {
      const stuck = updateLog.scrollHeight - updateLog.scrollTop - updateLog.clientHeight < 24;
      updateLog.hidden = false;
      updateLog.textContent = lines.map(line => line.text).join('\n');
      if (stuck) updateLog.scrollTop = updateLog.scrollHeight;
    }
  }
  function endUpdate() {
    clearInterval(updateTimer);
    updateBusy = false;
    updateButton.disabled = false;
  }
  async function checkUpdate() {
    if (updateBusy) return;
    updateBusy = true;
    updateButton.disabled = true;
    updateConfirm.hidden = true;
    updateLog.hidden = true;
    showUpdate('Checking for the latest version…');
    try {
      const status = await api('POST', '/api/system/check-update', {});
      if (status.status === 'updating') { monitorUpdate(); return; }
      if (status.status === 'available') {
        if (!status.is_update_admin) { showUpdate('Only the update administrator can run updates'); endUpdate(); return; }
        showUpdate('Update available');
        $('h5-update-confirm-text').textContent = `${status.local_version || '?'} → ${status.remote_version}. ${tr('The PC service restarts and terminals running on it are interrupted.')}`;
        updateConfirm.hidden = false;
      } else {
        showUpdate(status.error ? `${status.error}${status.error_details ? `: ${status.error_details}` : ''}` : (status.message || 'Already up to date'));
      }
    } catch (error) {
      showUpdate(error.message || 'Update failed');
    }
    endUpdate();
  }
  async function applyUpdate() {
    if (updateBusy) return;
    updateBusy = true;
    updateButton.disabled = true;
    updateConfirm.hidden = true;
    showUpdate('Updating…');
    try {
      let bootId = null;
      try { bootId = (await api('GET', '/api/system/version')).boot_id || null; } catch { /* the monitor falls back to the restart grace period */ }
      await api('POST', '/api/system/apply-update', { confirm: true });
      monitorUpdate(bootId);
    } catch (error) {
      showUpdate(error.message || 'Update not run');
      endUpdate();
    }
  }
  // Poll the update progress; while the PC service restarts the polls fail, and a changed boot id (or the grace period) proves it is back.
  function monitorUpdate(bootId = null) {
    clearInterval(updateTimer);
    updateBusy = true;
    updateButton.disabled = true;
    let restartingAt = null;
    let down = false;
    updateTimer = setInterval(async () => {
      let status;
      try { status = await api('GET', '/api/system/update-status'); } catch { down = true; return; }
      const restarted = down || (restartingAt && Date.now() - restartingAt > 4000) || (bootId && status.boot_id && status.boot_id !== bootId);
      if (status.status === 'blocked' || status.status === 'failed') {
        showUpdate(`${status.error || status.message || 'Update failed'}${status.error_details ? `: ${status.error_details}` : ''}`, status.log);
        endUpdate();
      } else if (status.stage === 'completed' || (status.status !== 'updating' && restarted)) {
        showUpdate('Update complete, reloading…', status.log);
        endUpdate();
        setTimeout(() => location.reload(), 1500);
      } else {
        if (status.stage === 'restarting' && !restartingAt) restartingAt = Date.now();
        showUpdate(status.stage === 'restarting' ? 'Restarting the PC service, this page reloads when it is back…' : (status.message || 'Updating…'), status.log);
      }
    }, 1000);
  }
  $('h5-open-settings').addEventListener('click', openSettings);
  $('h5-close-settings').addEventListener('click', closeSettings);
  updateButton.addEventListener('click', () => void checkUpdate());
  $('h5-update-apply').addEventListener('click', () => void applyUpdate());

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

  // The terminals of the selected task are a second-level list under it in the task sheet; "⋯" opens the actions of one terminal.
  const TERMINAL_ICONS = { shell: '>_', claude: '\u2733', codex: '\u25ce' };
  function terminalList() {
    const list = document.createElement('div');
    list.className = 'h5-terminal-list';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Phone terminals');
    for (const row of terminals) {
      const line = document.createElement('div');
      line.className = 'h5-terminal-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'h5-terminal-main';
      const icon = document.createElement('span');
      icon.className = `h5-terminal-icon ${row.agent || 'shell'}`;
      icon.textContent = TERMINAL_ICONS[row.agent] || TERMINAL_ICONS.shell;
      icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'h5-terminal-name';
      name.textContent = row.title;
      button.append(icon, name);
      if (row.terminal_id === terminalId) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => {
        closeTasks();
        // Tapping the current terminal reconnects one that was disconnected.
        if (row.terminal_id === terminalId && session && (session.ws || session.timer)) return;
        switchTerminal(row);
      });
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'h5-terminal-more';
      more.textContent = '⋯';
      more.setAttribute('aria-label', 'Terminal actions');
      more.addEventListener('click', () => openTerminalMenu(row));
      line.append(button, more);
      list.append(line);
    }
    return list;
  }
  function switchTerminal(row) {
    terminalId = row.terminal_id;
    store.set(`terminal:${source.key}:${task.id}`, terminalId);
    renderTabs();
    connect();
  }

  // ── Terminal actions: rename, reopen, restart in the working directory, delete (same endpoints as the desktop tabs) ──
  const termMenu = $('h5-term-menu');
  const termMenuActions = $('h5-term-menu-actions');
  const renameForm = $('h5-term-rename');
  const renameInput = $('h5-term-rename-input');
  let menuRow = null;

  function closeTerminalMenu() {
    menuRow = null;
    termMenu.hidden = true;
    renameForm.hidden = true;
  }
  function openTerminalMenu(row) {
    menuRow = row;
    $('h5-term-menu-title').textContent = row.title;
    renameForm.hidden = true;
    const items = [
      ...(row.agent ? [] : [['Rename', () => { termMenuActions.hidden = true; renameForm.hidden = false; renameInput.value = row.title; renameInput.focus(); renameInput.select(); }]]),
      ['Reopen', () => { closeTerminalMenu(); closeTasks(); switchTerminal(row); }],
      ['Restart in the working directory', () => void restartTerminal(row), 'danger'],
    ];
    if (row.terminal_id !== 'h5-default') items.push(['Delete', () => void deleteTerminal(row), 'danger']);
    termMenuActions.hidden = false;
    termMenuActions.replaceChildren(...items.map(([label, run, kind]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = tr(label);
      if (kind) button.className = kind;
      button.addEventListener('click', run);
      return button;
    }));
    termMenu.hidden = false;
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
      if (wasCurrent && terminals.length) { switchTerminal(terminals[0]); closeTasks(); } else renderTabs();
    } catch (error) { tell(`Could not delete the terminal: ${error.message}`, 'error'); }
  }
  renameForm.addEventListener('submit', async event => {
    event.preventDefault();
    const row = menuRow;
    const title = renameInput.value.trim();
    if (!row || !title) return;
    try {
      const renamed = await api('PATCH', `${source.tasksBase}/${task.id}/terminals/${encodeURIComponent(row.terminal_id)}`, { title });
      row.title = (renamed && renamed.title) || title;
      closeTerminalMenu();
      renderTabs();
    } catch (error) { tell(`Could not rename the terminal: ${error.message}`, 'error'); }
  });
  $('h5-term-menu-cancel').addEventListener('click', closeTerminalMenu);
  termMenu.addEventListener('click', event => { if (event.target === termMenu) closeTerminalMenu(); });
  function renderTabs() { if (tasks.length) renderTasks(); }

  // ── Session: a plain terminal, or a Claude / Codex session of the task directory (new or resumed) ──
  const SESSION_KINDS = [['claude', 'Claude session'], ['codex', 'Codex session']];
  function showSessionMenu(title, items) {
    $('h5-term-menu-title').textContent = tr(title);
    renameForm.hidden = true;
    termMenuActions.hidden = false;
    termMenuActions.replaceChildren(...items.map(([label, run, kind]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = kind === 'raw' ? label : tr(label);
      button.addEventListener('click', run);
      return button;
    }));
    termMenu.hidden = false;
  }
  function openSessionMenu() {
    menuRow = null;
    showSessionMenu('Session', [
      ['New Terminal', () => { closeTerminalMenu(); closeTasks(); void createTerminal(); }],
      ...SESSION_KINDS.map(([agent, label]) => [label, () => void openAgentSessions(agent, label)]),
    ]);
  }
  async function openAgentSessions(agent, label) {
    const current = task;
    showSessionMenu(label, [['Loading…', () => {}]]);
    let rows = [];
    try { rows = await api('GET', `${source.tasksBase}/${current.id}/agent-sessions?agent=${agent}`); }
    catch (error) { if (current === task) tell(`Could not load sessions: ${error.message}`, 'error'); }
    if (current !== task || termMenu.hidden) return;
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
    try {
      const row = await api('POST', `${source.tasksBase}/${current.id}/terminals?surface=h5`, options);
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
      fontSize: 11,
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

  // ── Copy text: the terminal buffer as plain text in an overlay, so the browser's own selection handles work ──
  const copyView = $('h5-copy');
  const copyText = $('h5-copy-text');
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
    copyText.textContent = text;
    copyView.hidden = false;
    copyView.setAttribute('aria-hidden', 'false');
    copyText.scrollTop = copyText.scrollHeight; // the latest output first
  }
  function closeCopy() {
    copyView.hidden = true;
    copyView.setAttribute('aria-hidden', 'true');
    copyText.textContent = '';
  }
  async function copyAll() {
    const text = copyText.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard API (plain HTTP): select everything and use the legacy copy command.
      const range = document.createRange();
      range.selectNodeContents(copyText);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand || !document.execCommand('copy')) { tell('Could not copy. Select the text and copy it by hand', 'error'); return; }
    }
    tell('Copied', 'success');
  }
  $('h5-copy-all').addEventListener('click', () => void copyAll());
  $('h5-copy-close').addEventListener('click', closeCopy);

  // The floating buttons move about a page per click: scrollback in the normal buffer, wheel events in a full-screen program.
  scrollButtons.addEventListener('mousedown', event => event.preventDefault());
  scrollButtons.addEventListener('click', event => {
    const button = event.target.closest('button');
    const s = session;
    if (button && button.dataset.copy !== undefined) { openCopy(); return; }
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
    else if (button.dataset.shortcut === 'ctrl-c') sendKey('c', { ctrl: true });
    else if (button.dataset.key) sendKey(button.dataset.key, mods);
  });

  // ── Translate and send ──
  let translating = false;
  // The box shows a single line: the one holding the cursor (the visual line, so a wrapped long line also counts). The browser scrolls the
  // cursor into view; this then snaps the scroll to whole lines so no half of a neighbouring line shows.
  const INPUT_LINE = 38; // the inner height of the box, so exactly one line fits
  function keepCaretLine() {
    const lines = Math.max(0, Math.round(translateInput.scrollHeight / INPUT_LINE) - 1);
    translateInput.scrollTop = Math.min(lines, Math.max(0, Math.round(translateInput.scrollTop / INPUT_LINE))) * INPUT_LINE;
  }
  const autosize = () => requestAnimationFrame(keepCaretLine);
  for (const type of ['keyup', 'click', 'focus']) translateInput.addEventListener(type, autosize);
  document.addEventListener('selectionchange', () => { if (document.activeElement === translateInput) autosize(); });
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
    await loadSources();
    await loadTasks();
    const savedId = Number(store.get(`task:${source.key}`));
    const saved = tasks.find(item => item.id === savedId);
    if (saved) selectTask(saved);
    else openTasks();
  })();
})();
