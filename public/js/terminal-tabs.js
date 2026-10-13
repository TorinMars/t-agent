// A shared tab strip for local and remote tasks. Controllers cache each
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
    const buttons = [];
    const acknowledgements = [];
    for (const row of current.rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = typeof TerminalControls !== 'undefined' && Boolean(TerminalControls.busy);
      button.className = 'terminal-toolbar-btn terminal-tab';
      button.classList.toggle('active', row.terminal_id === current.active);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(row.terminal_id === current.active));
      button.textContent = row.title;
      // 删除终端的入口在标签页里：默认终端不能删除，其余标签带一个 ×（也可在标签上按 Delete 键）。
      if (row.terminal_id !== 'default') {
        const remove = () => {
          if (typeof TerminalControls === 'undefined') return;
          TerminalControls.run('deleteTerminal', `删除“${row.title}”会终止其中的程序，并永久移除该终端标签和历史记录，确认删除吗？`, row.terminal_id);
        };
        const close = document.createElement('span');
        close.className = 'terminal-tab-close';
        close.setAttribute('role', 'button');
        close.setAttribute('aria-label', `删除${row.title}`);
        close.dataset.tip = `删除${row.title}`;
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
        if (current.active === row.terminal_id) return;
        current.active = row.terminal_id;
        render();
        select();
      });
      buttons.push(button);
    }
    strip.replaceChildren(...buttons);
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
      const revision = state(scope).revision;
      API.get(`${scope}/terminals`).then(rows => {
        if (state(scope).revision !== revision) return;
        state(scope).rows = rows;
        if (mounted && mounted.scope === scope) render();
      }).catch(() => { /* Legacy Engines still support the default terminal. */ });
    }
    return state(scope).active;
  }

  async function create() {
    if (!mounted) return;
    const target = mounted;
    try {
      const row = await API.post(`${target.scope}/terminals`, {});
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
        throw new Error('远程 Engine 暂不支持新开终端，请先升级该 Engine');
      }
      throw error;
    }
  }

  function remove(scope, terminalId) {
    const current = state(scope);
    current.revision++;
    current.rows = current.rows.filter(row => row.terminal_id !== terminalId);
    const wasActive = current.active === terminalId;
    if (wasActive) current.active = 'default';
    if (mounted && mounted.scope === scope) {
      render();
      // 删除的不是当前标签时，当前终端不用重新连接。
      if (wasActive) mounted.select();
    }
  }

  return { show, create, refresh: render, remove, current: scope => state(scope).active };
})();
