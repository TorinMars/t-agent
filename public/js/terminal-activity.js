// Server-derived terminal activity, shared by the task list, terminal tabs and engine tabs.
// States per terminal: 'running' (foreground job) | 'done' (finished, unseen).
// Each source (the local Client or a remote Engine) is polled separately; the
// source being viewed is polled quickly, the others slowly.
const TerminalActivity = (() => {
  const ACTIVE_POLL_MS = 1500;
  const BACKGROUND_POLL_MS = 10000;
  const LOCAL = 'local';

  // key -> { activityUrl, tasksBase, snapshot: { taskId: { terminalId: state } }, lastPoll }
  const sources = new Map([[LOCAL, { activityUrl: '/api/tasks/terminal-activity', tasksBase: '/api/tasks', snapshot: {}, lastPoll: 0 }]]);
  const listeners = new Set();
  let activeKey = LOCAL;
  let timer = null;

  const snapshotOf = key => (sources.get(key) || {}).snapshot || {};
  const stateOf = (taskId, terminalId, key = LOCAL) => (snapshotOf(key)[taskId] || {})[terminalId] || 'idle';

  const combine = states => (states.includes('running') ? 'running' : states.includes('done') ? 'done' : 'idle');

  // Task-level summary: running wins over done.
  const taskState = (taskId, key = LOCAL) => combine(Object.values(snapshotOf(key)[taskId] || {}));

  // Source-level summary, shown on the engine tab so background work is visible.
  const sourceState = key => combine(Object.values(snapshotOf(key)).flatMap(rows => Object.values(rows)));

  function emit() { listeners.forEach(fn => { try { fn(); } catch {} }); }

  async function poll(key, source) {
    source.lastPoll = Date.now();
    try {
      const next = await API.get(source.activityUrl);
      if (JSON.stringify(next) === JSON.stringify(source.snapshot)) return;
      source.snapshot = next && typeof next === 'object' ? next : {};
      emit();
    } catch { /* keep the last known state */ }
  }

  function tick() {
    const now = Date.now();
    for (const [key, source] of sources) {
      const interval = key === activeKey ? ACTIVE_POLL_MS : BACKGROUND_POLL_MS;
      if (now - source.lastPoll >= interval - 50) poll(key, source);
    }
  }

  async function refresh(key = activeKey) {
    const source = sources.get(key);
    if (source) await poll(key, source);
  }

  async function acknowledge(taskId, terminalId, key = LOCAL) {
    const source = sources.get(key);
    if (!source || stateOf(taskId, terminalId, key) !== 'done') return;
    // Optimistic: clear locally, then tell the server.
    const rows = { ...(source.snapshot[taskId] || {}) };
    delete rows[terminalId];
    source.snapshot = { ...source.snapshot, [taskId]: rows };
    emit();
    try { await API.post(`${source.tasksBase}/${taskId}/terminal/ack`, { terminal_id: terminalId }); } catch {}
  }

  // Engines that do not report activity (older versions) are simply not registered.
  function registerSource(key, { activityUrl, tasksBase }) {
    const existing = sources.get(key);
    if (existing) { Object.assign(existing, { activityUrl, tasksBase }); return; }
    sources.set(key, { activityUrl, tasksBase, snapshot: {}, lastPoll: 0 });
  }

  function unregisterSource(key) {
    if (key === LOCAL || !sources.delete(key)) return;
    emit();
  }

  function setActive(key) {
    activeKey = sources.has(key) ? key : LOCAL;
    tick();
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, ACTIVE_POLL_MS);
  }

  return {
    start, refresh, acknowledge, stateOf, taskState, sourceState,
    registerSource, unregisterSource, setActive,
    onChange: fn => listeners.add(fn),
  };
})();
