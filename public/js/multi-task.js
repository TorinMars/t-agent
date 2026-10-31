// The multi-task page: up to four agent chats (Claude / Codex) side by side, filling the whole page. Each chat belongs to a task; the
// "Add session" dialog picks the task, the agent, and either a new chat or an existing one. Switching to another page only hides this
// one, so the chats stay connected. The open chats are remembered in this browser (localStorage).
const MultiTask = (() => {
  const MAX = 4;
  const STORE_KEY = 'multiTaskSessions';
  const $ = id => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const toast = message => { if (typeof Toast !== 'undefined') Toast.error(message); };
  // The API wrappers throw the raw response text; the chat view wants the server's error code.
  const unwrap = async run => {
    try { return await run(); } catch (error) {
      let message = error.message;
      try { message = JSON.parse(message).error || message; } catch { /* plain text */ }
      throw new Error(message);
    }
  };
  const api = {
    get: url => unwrap(() => API.get(url)),
    post: (url, body) => unwrap(() => API.post(url, body)),
    patch: (url, body) => unwrap(() => API.patch(url, body)),
    del: url => unwrap(() => API.delete(url)),
  };

  const cells = []; // { id, base, agent, taskTitle, chat, node, titleNode }
  let active = false;
  let restored = false;
  let retained = []; // stored sessions whose list could not be read yet; kept so a failed request never forgets them
  let picker = null;

  const readStore = () => {
    try { const list = JSON.parse(localStorage.getItem(STORE_KEY)); return Array.isArray(list) ? list : []; } catch { return []; }
  };
  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...cells.map(cell => ({ base: cell.base, id: cell.id, taskTitle: cell.taskTitle })), ...retained.filter(item => !cells.some(cell => cell.base === item.base && cell.id === item.id))])); } catch { /* storage is full or blocked */ }
  };

  // The tasks of the engine that is shown on the Tasks page. A remote engine must declare that it supports agent chats.
  function engineTasks() {
    const tasks = typeof Tasks === 'undefined' ? null : Tasks;
    const src = tasks && tasks.getSource(tasks.getActiveKey());
    if (!src) return { tasks: [], base: '/api/tasks', label: 'Default', unavailable: null };
    let unavailable = null;
    if (!src.local) {
      if (tasks.problemOf(src.key)) unavailable = 'This engine cannot be reached right now. Fix the connection in the engine bar at the top first.';
      else if (!src.caps || !src.caps.has('agent-chat:manage')) unavailable = 'This engine does not support agent chats.';
    }
    return { tasks: Array.isArray(src.tasks) ? src.tasks : [], base: src.tasksBase, label: src.label, unavailable };
  }

  function layout() {
    const grid = $('mt-grid');
    grid.style.setProperty('--mt-columns', String(Math.max(1, cells.length)));
    grid.classList.toggle('empty', !cells.length);
    $('mt-add').disabled = cells.length >= MAX;
    $('mt-count').textContent = `${cells.length} / ${MAX}`;
  }

  function closeCell(cell) {
    const index = cells.indexOf(cell);
    if (index < 0) return;
    cells.splice(index, 1);
    cell.chat.destroy();
    cell.node.remove();
    save();
    layout();
  }

  function addCell(base, conversation, taskTitle, draft = '') {
    if (cells.some(cell => cell.base === base && cell.id === conversation.id)) return false;
    if (cells.length >= MAX) return false;
    const node = el('section', 'mt-cell');
    const head = el('div', 'mt-cell-head');
    const mark = el('span', `mt-cell-mark ${conversation.agent}`);
    mark.append(AgentChat.icon(conversation.agent));
    const titles = el('div', 'mt-cell-titles');
    const taskNode = el('div', 'mt-cell-task', taskTitle);
    const titleNode = el('div', 'mt-cell-title', conversation.title || '');
    titles.append(taskNode, titleNode);
    const close = el('button', 'mt-cell-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close session');
    close.title = 'Close session';
    const holder = el('div', 'mt-holder');
    head.append(mark, titles, close);
    node.append(head, holder);
    $('mt-grid').append(node);
    const cell = { id: conversation.id, base, agent: conversation.agent, taskTitle, node, titleNode, chat: null };
    cell.chat = AgentChat.mount(holder, {
      api, base, conversation,
      onClose: () => closeCell(cell),
      onTitle: title => { cell.titleNode.textContent = title; },
      draft,
      onOpenChat: (created, extra = {}) => { // a fork or a new chat gets a cell of its own
        if (!addCell(base, created, taskTitle, extra.draft || '')) toast('No room for another session. Close one first.');
      },
      onOpen: () => { if (typeof Tools !== 'undefined') Tools.showPage('multi-task'); },
      notify: toast,
    });
    close.addEventListener('click', () => closeCell(cell));
    cells.push(cell);
    save();
    layout();
    return true;
  }

  // `base` is stored as it was mounted (`<tasks base>/<task id>/agent`), so it is used as is.
  async function restore() {
    restored = true;
    const stored = readStore().filter(item => item && typeof item.base === 'string' && Number.isInteger(item.id)).slice(0, MAX);
    const lists = new Map();
    for (const base of new Set(stored.map(item => item.base))) {
      lists.set(base, api.get(`${base}/conversations`).catch(() => null));
    }
    retained = [];
    for (const item of stored) {
      const rows = await lists.get(item.base);
      if (!Array.isArray(rows)) { retained.push(item); continue; }
      const row = rows.find(candidate => candidate.id === item.id);
      if (row) addCell(item.base, row, item.taskTitle || '');
    }
    if (retained.length) restored = false; // try again on the next visit of the page
    else save();
  }

  // The "Add session" dialog.
  function closePicker() {
    if (!picker) return;
    document.removeEventListener('keydown', picker.onKey, true);
    picker.node.remove();
    picker = null;
  }

  function openPicker() {
    if (picker || cells.length >= MAX) return;
    const engine = engineTasks();
    const state = { taskId: null, agent: 'claude', token: 0 };
    const overlay = el('div', 'mt-picker-overlay');
    const box = el('div', 'mt-picker');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Add session');
    box.append(el('div', 'mt-picker-title', 'Add session'));
    const body = el('div', 'mt-picker-body');
    box.append(body);
    const actions = el('div', 'mt-picker-actions');
    const cancel = el('button', 'btn-logout', 'Cancel');
    cancel.type = 'button';
    actions.append(cancel);
    box.append(actions);
    overlay.append(box);
    document.body.append(overlay);
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); closePicker(); } };
    document.addEventListener('keydown', onKey, true);
    picker = { node: overlay, onKey };
    cancel.addEventListener('click', closePicker);
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) closePicker(); });

    if (engine.unavailable) { body.append(el('div', 'form-hint', engine.unavailable)); return; }
    if (!engine.tasks.length) { body.append(el('div', 'form-hint', 'There are no tasks yet. Create a task on the Tasks page first.')); return; }

    const taskLabel = el('label', 'mt-picker-label', 'Task');
    const select = el('select', 'mt-picker-select');
    for (const task of engine.tasks) {
      const option = el('option', '', task.title);
      option.value = String(task.id);
      select.append(option);
    }
    taskLabel.append(select);
    const agents = el('div', 'mt-picker-agents');
    agents.setAttribute('role', 'group');
    agents.setAttribute('aria-label', 'Agent');
    const agentButtons = new Map();
    for (const [key, spec] of Object.entries(AgentChat.AGENTS)) {
      const button = el('button', 'mt-picker-agent');
      button.type = 'button';
      button.append(AgentChat.icon(key), el('span', '', spec.label));
      button.addEventListener('click', () => { state.agent = key; refresh(); });
      agentButtons.set(key, button);
      agents.append(button);
    }
    const list = el('div', 'mt-picker-list');
    list.setAttribute('role', 'listbox');
    body.append(taskLabel, agents, el('div', 'mt-picker-label', 'Session'), list);
    select.addEventListener('change', refresh);
    state.taskId = Number(select.value);

    async function start(task, choice) {
      const base = `${engine.base}/${task.id}/agent`;
      try {
        const conversation = await AgentChat.open(api, base, state.agent, choice);
        if (!picker) return;
        if (cells.some(cell => cell.base === base && cell.id === conversation.id)) { toast('This session is already open here.'); return; }
        closePicker();
        addCell(base, conversation, task.title);
      } catch (error) { toast(error.message); }
    }

    function refresh() {
      state.taskId = Number(select.value);
      const task = engine.tasks.find(item => item.id === state.taskId);
      for (const [key, button] of agentButtons) { button.classList.toggle('active', key === state.agent); button.setAttribute('aria-pressed', String(key === state.agent)); }
      list.replaceChildren(el('div', 'form-hint', 'Loading sessions…'));
      const token = ++state.token;
      AgentChat.choices(api, `${engine.base}/${task.id}/agent`, state.agent).then(rows => {
        if (token !== state.token || !picker) return;
        list.replaceChildren();
        const add = (label, choice, extra) => {
          const item = el('button', 'mt-picker-item');
          item.type = 'button';
          item.append(el('span', 'mt-picker-item-title', label));
          if (extra) item.append(el('span', 'mt-picker-item-extra', extra));
          item.addEventListener('click', () => void start(task, choice));
          list.append(item);
        };
        add(`New ${AgentChat.AGENTS[state.agent].label} chat`, null, '');
        for (const row of rows) add(row.title || 'Untitled', row, row.running ? 'Running' : (row.conversation ? '' : 'CLI session'));
      }).catch(error => { if (token === state.token && picker) list.replaceChildren(el('div', 'form-hint', error.message)); });
    }
    refresh();
    select.focus();
  }

  function setActive(value) {
    active = value;
    if (active && !restored) void restore();
    if (active) window.dispatchEvent(new Event('resize'));
  }

  const add = $('mt-add');
  if (add) add.addEventListener('click', openPicker);
  const empty = $('mt-empty-add');
  if (empty) empty.addEventListener('click', openPicker);
  layout();
  return { setActive, openPicker, get count() { return cells.length; }, get active() { return active; } };
})();
