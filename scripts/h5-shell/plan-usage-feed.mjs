// The readings of "Plan usage" ("Plan usage: the page" in docs/design/plan-usage-page.md), started once by entry.jsx on the top page (a pane of the
// multi-column view has no session header of its own). It keeps `state.planUsage` = { readings: { [engine key]: { status, answer, fetchedAt } },
// open, refreshing } and registers the actions of the details (PlanUsage.jsx).
// When it reads (`GET {base}/agent-usage`, which answers the server's last reading at once):
// - the engine of the shown session (this machine when none; plan-usage.mjs `shownKeyOf`) every 5 minutes while the page is visible, every 60 s while
//   a Claude or Codex session of that engine runs (the server reads every minute then);
// - about 10 s after a Claude or Codex session of that engine stops running (a turn ended), at most once in 30 s;
// - at once when the page is shown again and the last read is older than 60 s, and when another engine's session is shown;
// - the other engines that report plan usage when the details open, and with each read while they are open.
// Refresh in the details posts `{base}/agent-usage/refresh` (the server reads now) for the shown engine.
// A read that fails keeps the last reading as 'offline' (dimmed); an answer 404 or 501 (an engine without plan usage) is 'missing'.
import {
  POLL_MS, RUNNING_POLL_MS, TURN_DELAY_MS, TURN_GAP_MS, VISIBLE_STALE_MS, runningSessions, shownKeyOf, usageBase, usageEngines,
} from './plan-usage.mjs';

const TICK_MS = 15000; // how often the schedule is looked at (no request unless one is due)

export function startPlanUsage(ui, { api, win = window, doc = document, now = () => Date.now() } = {}) {
  const pending = new Map(); // engine key -> the GET on its way
  let lastShownRead = 0; // when the shown engine was last asked
  let lastKey = null;
  let running = new Set();
  let turnTimer = 0;
  let lastTurnRead = 0;

  const get = () => ui.get().planUsage || { readings: {}, open: false, refreshing: false };
  const patch = next => ui.set({ planUsage: { ...get(), ...next } });
  const setReading = (key, reading) => patch({ readings: { ...get().readings, [key]: reading } });
  const visible = () => doc.visibilityState === 'visible';
  const engines = () => usageEngines(ui.get().sources);
  // The engine the header asks: the shown one when it reports plan usage, else this machine (plan-usage.mjs `usageModel` says so in the details).
  function askedKey() {
    const key = shownKeyOf(ui.get());
    const reading = get().readings[key];
    return engines().some(engine => engine.key === key) && !(reading && reading.status === 'missing') ? key : 'local';
  }

  function failed(key, error) {
    const before = get().readings[key];
    if (error && (error.status === 404 || error.status === 501)) setReading(key, { status: 'missing', answer: null, fetchedAt: now() });
    else setReading(key, { ...(before || { answer: null }), status: 'offline', failedAt: now() });
  }
  function accept(key, answer) {
    if (answer && Array.isArray(answer.agents)) setReading(key, { status: 'ok', answer, fetchedAt: now() });
    else failed(key, { status: 404 });
  }
  function read(key) {
    if (pending.has(key)) return pending.get(key);
    const engine = engines().find(item => item.key === key);
    if (!engine) return Promise.resolve();
    if (engine.offline) { // not asked: its last reading stays, dimmed
      const before = get().readings[key];
      if (before && before.status !== 'offline') setReading(key, { ...before, status: 'offline' });
      return Promise.resolve();
    }
    const request = api('GET', `${usageBase(key)}/agent-usage`).then(answer => accept(key, answer), error => failed(key, error))
      .finally(() => { pending.delete(key); });
    pending.set(key, request);
    return request;
  }
  // The shown engine (and, while the details are open, the others).
  function readShown() {
    lastShownRead = now();
    const key = askedKey();
    const done = read(key).then(() => {
      if (key !== 'local' && askedKey() === 'local') return read('local'); // it turned out to have no plan usage: this machine's
      return null;
    });
    if (get().open) for (const engine of engines()) if (engine.key !== key) void read(engine.key);
    return done;
  }

  const interval = () => (running.size ? RUNNING_POLL_MS : POLL_MS);
  function tick() {
    if (!visible()) return;
    if (now() - lastShownRead >= interval()) void readShown();
  }
  const timer = win.setInterval(tick, TICK_MS);
  doc.addEventListener('visibilitychange', () => {
    if (visible() && now() - lastShownRead >= VISIBLE_STALE_MS) void readShown();
  });

  // Another engine shown, or its capability just read: ask it. The running sessions of the shown engine: a turn that ended reads again in about 10 s.
  function onChange() {
    const state = ui.get();
    const key = askedKey();
    if (key !== lastKey) {
      lastKey = key;
      running = runningSessions(state, shownKeyOf(state));
      const reading = get().readings[key];
      if (!reading || now() - (reading.fetchedAt || 0) >= VISIBLE_STALE_MS) void readShown();
      return;
    }
    const next = runningSessions(state, shownKeyOf(state));
    const ended = [...running].some(id => !next.has(id));
    const started = [...next].some(id => !running.has(id));
    running = next;
    if (started && visible() && now() - lastShownRead >= RUNNING_POLL_MS) void readShown();
    if (ended && !turnTimer && now() - lastTurnRead >= TURN_GAP_MS) {
      turnTimer = win.setTimeout(() => {
        turnTimer = 0;
        lastTurnRead = now();
        if (visible()) void readShown();
      }, TURN_DELAY_MS);
    }
  }
  let lastSources = null;
  let lastTarget = null;
  ui.subscribe(() => {
    const state = ui.get();
    // Only the parts this reads: the activity, the shown task's engine and the list of engines.
    const target = `${shownKeyOf(state)}`;
    if (state.sources === lastSources && target === lastTarget && state.terminalActivity === onChange.activity && state.taskList === onChange.list) return;
    lastSources = state.sources;
    lastTarget = target;
    onChange.activity = state.terminalActivity;
    onChange.list = state.taskList;
    onChange();
  });

  ui.actions.openPlanUsage = () => {
    patch({ open: true });
    void readShown();
  };
  ui.actions.closePlanUsage = () => patch({ open: false });
  ui.actions.refreshPlanUsage = async () => {
    if (get().refreshing) return;
    const key = askedKey();
    patch({ refreshing: true });
    lastShownRead = now();
    try { accept(key, await api('POST', `${usageBase(key)}/agent-usage/refresh`)); } catch (error) { failed(key, error); }
    patch({ refreshing: false });
    for (const engine of engines()) if (engine.key !== key) void read(engine.key);
  };

  onChange();
  return { stop: () => win.clearInterval(timer), readShown };
}
