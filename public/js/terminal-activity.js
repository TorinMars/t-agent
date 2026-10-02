// Server-derived terminal activity, shared by the task list and terminal tabs.
// States per terminal: 'running' (foreground job) | 'done' (finished, unseen).
const TerminalActivity = (() => {
  const POLL_MS = 1500;
  let snapshot = {};           // taskId -> { terminalId: state }
  const listeners = new Set();
  let timer = null;

  const stateOf = (taskId, terminalId) => (snapshot[taskId] || {})[terminalId] || 'idle';

  // Task-level summary: running wins over done.
  function taskState(taskId) {
    const states = Object.values(snapshot[taskId] || {});
    if (states.includes('running')) return 'running';
    if (states.includes('done')) return 'done';
    return 'idle';
  }

  function emit() { listeners.forEach(fn => { try { fn(); } catch {} }); }

  async function refresh() {
    try {
      const next = await API.get('/api/tasks/terminal-activity');
      if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
      snapshot = next;
      emit();
    } catch { /* keep the last known state */ }
  }

  async function acknowledge(taskId, terminalId) {
    if (stateOf(taskId, terminalId) !== 'done') return;
    // Optimistic: clear locally, then tell the server.
    const rows = { ...(snapshot[taskId] || {}) };
    delete rows[terminalId];
    snapshot = { ...snapshot, [taskId]: rows };
    emit();
    try { await API.post(`/api/tasks/${taskId}/terminal/ack`, { terminal_id: terminalId }); } catch {}
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }

  return { start, refresh, acknowledge, stateOf, taskState, onChange: fn => listeners.add(fn) };
})();
