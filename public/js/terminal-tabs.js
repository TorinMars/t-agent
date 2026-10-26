// A shared tab strip for local and remote tasks. Controllers cache each
// terminal view and connection independently; switching tabs only changes visibility.
const TerminalTabs = (() => {
  const MAX_TITLE = 40; // keep in step with MAX_TERMINAL_TITLE in routes/terminal.js
  const states = new Map();
  let mounted = null;
  const strip = document.getElementById('terminal-tabs');

  function state(scope) {
    if (!states.has(scope)) states.set(scope, {
      active: 'default', editing: null, draft: '', revision: 0, rows: [{ terminal_id: 'default', title: 'Terminal 1' }],
      chats: null, // { rows: [{ id, agent, title }], active, select(id), close(id), leave() } for the agent chats open on this task
    });
    return states.get(scope);
  }

  function beginRename(scope, row) {
    const current = state(scope);
    current.editing = row.terminal_id;
    current.draft = row.title;
    current.selectAll = true;
    render();
  }

  function endRename(scope) {
    const current = state(scope);
    current.editing = null;
    current.draft = '';
    if (mounted && mounted.scope === scope) render();
  }

  async function commitRename(scope, row, input) {
    const current = state(scope);
    const title = input.value.replace(/\s+/g, ' ').trim();
    if (!title || title === row.title) return endRename(scope);
    if (title.length > MAX_TITLE) return input.setCustomValidity(`Terminal names are limited to ${MAX_TITLE} characters`), input.reportValidity();
    try {
      const saved = await API.patch(`${scope}/terminals/${encodeURIComponent(row.terminal_id)}`, { title });
      const target = current.rows.find(item => item.terminal_id === row.terminal_id);
      if (target) target.title = saved.title;
      current.revision++;
    } catch (error) {
      const unsupported = /ENGINE_ROUTE_NOT_FOUND|REMOTE_HTTP_404|Cannot PATCH/.test(error.message);
      if (typeof Toast !== 'undefined') Toast.error(unsupported ? 'This remote engine does not support renaming terminals yet. Please upgrade it' : 'Could not rename the terminal');
    }
    endRename(scope);
  }

  function editorFor(scope, current, row) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'terminal-tab-edit';
    input.maxLength = MAX_TITLE;
    input.value = current.draft;
    input.setAttribute('aria-label', 'Terminal name');
    input.addEventListener('input', () => { current.draft = input.value; input.setCustomValidity(''); });
    let done = false;
    const finish = action => { if (done) return; done = true; action(); };
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); finish(() => commitRename(scope, row, input)); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(() => endRename(scope)); }
    });
    input.addEventListener('blur', () => { if (!input.dataset.detached) finish(() => commitRename(scope, row, input)); });
    return input;
  }

  function render() {
    // Replacing the strip removes a focused editor, which fires blur; flag it so that does not count as "commit".
    const stale = strip.querySelector('.terminal-tab-edit');
    if (stale) stale.dataset.detached = '1';
    strip.replaceChildren();
    if (!mounted) return;
    const { scope, select } = mounted;
    const current = state(scope);
    const buttons = [];
    const acknowledgements = [];
    let editor = null;
    for (const row of current.rows) {
      if (current.editing === row.terminal_id) {
        editor = editorFor(scope, current, row);
        buttons.push(editor);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = typeof TerminalControls !== 'undefined' && Boolean(TerminalControls.busy);
      button.className = 'terminal-toolbar-btn terminal-tab';
      const shown = row.terminal_id === current.active && !(current.chats && current.chats.active);
      button.classList.toggle('active', shown);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(shown));
      button.textContent = row.title;
      // Rename: double-click the tab, or press F2 on it.
      button.title = 'Double-click to rename';
      button.addEventListener('dblclick', () => beginRename(scope, row));
      button.addEventListener('keydown', event => { if (event.key === 'F2') { event.preventDefault(); beginRename(scope, row); } });
      // Deleting a terminal happens from its tab: the default terminal cannot be deleted, the others get a × (or press Delete on the tab).
      if (row.terminal_id !== 'default') {
        const remove = () => {
          if (typeof TerminalControls === 'undefined') return;
          TerminalControls.run('deleteTerminal', `Deleting “${row.title}” ends the programs in it and permanently removes the terminal tab and its history. Continue?`, row.terminal_id);
        };
        const close = document.createElement('span');
        close.className = 'terminal-tab-close';
        close.setAttribute('role', 'button');
        close.setAttribute('aria-label', `Delete ${row.title}`);
        close.dataset.tip = `Delete ${row.title}`;
        close.addEventListener('click', event => { event.stopPropagation(); remove(); });
        button.append(close);
        button.addEventListener('keydown', event => { if (event.key === 'Delete') { event.preventDefault(); remove(); } });
      }
      if (typeof TerminalActivity !== 'undefined' && mounted.taskId != null) {
        const activity = TerminalActivity.stateOf(mounted.taskId, row.terminal_id, mounted.sourceKey);
        if (activity !== 'idle') button.classList.add(`term-${activity}`);
        // Viewing a finished terminal counts as confirming it.
        if (activity === 'done' && row.terminal_id === current.active && mounted.viewing && mounted.viewing()) {
          acknowledgements.push([mounted.taskId, row.terminal_id, mounted.sourceKey]);
        }
      }
      button.addEventListener('click', () => {
        const chats = current.chats;
        const leaving = Boolean(chats && chats.active);
        if (leaving) chats.leave();
        if (current.active === row.terminal_id && !leaving) return;
        current.active = row.terminal_id;
        render();
        select();
      });
      buttons.push(button);
    }
    // Agent chats open on this task sit after the terminals, in the same strip.
    if (current.chats) {
      for (const chat of current.chats.rows) {
        const active = current.chats.active === chat.id;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'terminal-toolbar-btn terminal-tab agent-tab';
        button.classList.toggle('active', active);
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(active));
        const badge = document.createElement('span');
        badge.className = `agent-tab-badge ${chat.agent}`;
        badge.setAttribute('aria-hidden', 'true');
        badge.textContent = chat.agent === 'codex' ? '◎' : '✳';
        const label = document.createElement('span');
        label.translate = false;
        label.textContent = chat.title;
        button.title = chat.title;
        const close = document.createElement('span');
        close.className = 'terminal-tab-close';
        close.setAttribute('role', 'button');
        close.setAttribute('aria-label', `Close ${chat.title}`);
        close.addEventListener('click', event => { event.stopPropagation(); current.chats.close(chat.id); });
        button.append(badge, label, close);
        button.addEventListener('keydown', event => { if (event.key === 'Delete') { event.preventDefault(); current.chats.close(chat.id); } });
        button.addEventListener('click', () => { if (current.chats.active !== chat.id) current.chats.select(chat.id); });
        buttons.push(button);
      }
    }
    strip.replaceChildren(...buttons);
    if (editor) {
      const current = state(mounted.scope);
      editor.focus();
      // Select the whole name when editing starts; on later re-renders keep typing at the end.
      if (current.selectAll) { editor.select(); current.selectAll = false; }
      else editor.setSelectionRange(editor.value.length, editor.value.length);
    }
    // acknowledge() notifies listeners synchronously and they call render() again, so it
    // must run after the strip is complete; re-entering mid-loop duplicated every tab.
    for (const args of acknowledgements) TerminalActivity.acknowledge(...args);
  }

  // options.taskId and options.sourceKey enable activity indicators for that Engine;
  // options.viewing() tells whether the active terminal is actually on screen.
  function show(scope, select, options = {}) {
    const changed = !mounted || mounted.scope !== scope;
    mounted = { scope, select, taskId: options.taskId ?? null, sourceKey: options.sourceKey || 'local', viewing: options.viewing };
    render();
    if (changed) {
      for (const listener of scopeListeners) listener();
      const revision = state(scope).revision;
      API.get(`${scope}/terminals`).then(rows => {
        if (state(scope).revision !== revision) return;
        state(scope).rows = rows;
        if (mounted && mounted.scope === scope) render();
      }).catch(() => { /* Legacy Engines still support the default terminal. */ });
    }
    return state(scope).active;
  }

  // options: { agent: 'claude' | 'codex', session_id? } starts that agent in the new terminal (a new session, or the given one resumed).
  async function create(options = {}) {
    if (!mounted) return;
    const target = mounted;
    try {
      const row = await API.post(`${target.scope}/terminals`, options);
      const current = state(target.scope);
      current.revision++;
      current.rows.push(row);
      current.active = row.terminal_id;
      if (mounted && mounted.scope === target.scope) {
        render();
        target.select();
      }
    } catch (error) {
      if (/ENGINE_ROUTE_NOT_FOUND|REMOTE_HTTP_404/.test(error.message)) {
        throw new Error('This remote engine does not support new terminals yet. Please upgrade it');
      }
      throw error;
    }
  }

  // Sessions of an agent CLI that ran in the task working directory, newest first.
  function agentSessions(agent) {
    if (!mounted) return Promise.resolve([]);
    return API.get(`${mounted.scope}/agent-sessions?agent=${encodeURIComponent(agent)}`);
  }

  function remove(scope, terminalId) {
    const current = state(scope);
    current.revision++;
    current.rows = current.rows.filter(row => row.terminal_id !== terminalId);
    const wasActive = current.active === terminalId;
    if (wasActive) current.active = 'default';
    if (mounted && mounted.scope === scope) {
      render();
      // When the deleted tab is not the current one, the current terminal does not need to reconnect.
      if (wasActive) mounted.select();
    }
  }

  // Called when the tabs move to another task or engine (the chat view of the previous task closes then).
  const scopeListeners = [];
  const onScopeChange = listener => { scopeListeners.push(listener); };

  // Agent chats of a task show as tabs after its terminals; null removes them.
  function setChats(scope, chats) {
    state(scope).chats = chats;
    if (mounted && mounted.scope === scope) render();
  }

  // Where the mounted terminal tabs belong: the API scope, the task id and the engine the task lives on.
  const context = () => (mounted ? { scope: mounted.scope, taskId: mounted.taskId, sourceKey: mounted.sourceKey } : null);

  return { show, create, setChats, context, onScopeChange, agentSessions, refresh: render, remove, current: scope => state(scope).active };
})();
