// A tab strip for a task's terminals. The controller caches each
// terminal view and connection independently; switching tabs only changes visibility.
const TerminalTabs = (() => {
  const states = new Map();
  let mounted = null;
  const strip = document.getElementById('terminal-tabs');

  function state(scope) {
    if (!states.has(scope)) states.set(scope, {
      active: 'default', revision: 0, rows: [{ terminal_id: 'default', title: '终端 1' }],
    });
    return states.get(scope);
  }

  function render() {
    strip.replaceChildren();
    if (!mounted) return;
    const { scope, select } = mounted;
    const current = state(scope);
    const deleteButton = document.getElementById('btn-terminal-delete');
    if (deleteButton) deleteButton.hidden = current.active === 'default';
    for (const row of current.rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = typeof TerminalControls !== 'undefined' && Boolean(TerminalControls.busy);
      button.className = 'terminal-toolbar-btn terminal-tab';
      button.classList.toggle('active', row.terminal_id === current.active);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(row.terminal_id === current.active));
      button.textContent = row.title;
      if (typeof TerminalActivity !== 'undefined' && mounted.taskId != null) {
        const activity = TerminalActivity.stateOf(mounted.taskId, row.terminal_id);
        if (activity !== 'idle') button.classList.add(`term-${activity}`);
        // Viewing a finished terminal counts as confirming it.
        if (activity === 'done' && row.terminal_id === current.active && mounted.viewing && mounted.viewing()) {
          TerminalActivity.acknowledge(mounted.taskId, row.terminal_id);
        }
      }
      button.addEventListener('click', () => {
        if (current.active === row.terminal_id) return;
        current.active = row.terminal_id;
        render();
        select();
      });
      strip.appendChild(button);
    }
  }

  // options.taskId enables activity indicators (local tasks only);
  // options.viewing() tells whether the active terminal is actually on screen.
  function show(scope, select, options = {}) {
    const changed = !mounted || mounted.scope !== scope;
    mounted = { scope, select, taskId: options.taskId ?? null, viewing: options.viewing };
    render();
    if (changed) {
      const revision = state(scope).revision;
      API.get(`${scope}/terminals`).then(rows => {
        if (state(scope).revision !== revision) return;
        state(scope).rows = rows;
        if (mounted && mounted.scope === scope) render();
      }).catch(() => { /* The default terminal stays usable without the list. */ });
    }
    return state(scope).active;
  }

  async function create() {
    if (!mounted) return;
    const target = mounted;
    const row = await API.post(`${target.scope}/terminals`, {});
    const current = state(target.scope);
    current.revision++;
    current.rows.push(row);
    current.active = row.terminal_id;
    if (mounted && mounted.scope === target.scope) {
      render();
      target.select();
    }
  }

  function remove(scope, terminalId) {
    const current = state(scope);
    current.revision++;
    current.rows = current.rows.filter(row => row.terminal_id !== terminalId);
    if (current.active === terminalId) current.active = 'default';
    if (mounted && mounted.scope === scope) {
      render();
      mounted.select();
    }
  }

  return { show, create, refresh: render, remove, current: scope => state(scope).active };
})();
