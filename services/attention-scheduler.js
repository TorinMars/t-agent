// The timer of T-Attention schedules ("Firing" in docs/design/attention-schedules.md). It runs on the engine that owns the items (this database's
// attention_items; the read copies of other engines are never fired here), at the start and then at the next fire time, at most a minute apart.
// Each round fires every item whose next_at has come (services/attention.js fireDue): the firing is stored before anything is sent or published,
// so a firing is never sent or notified twice, also across a restart. A change that brings a fire time closer (a new schedule, a past "once")
// sets the timer again at once.
const MAX_WAIT_MS = 60 * 1000;

function createAttentionScheduler({ service, now = Date.now, timers = null, maxWaitMs = MAX_WAIT_MS, log = message => console.warn(`[attention-schedule] ${message}`) } = {}) {
  if (!service || typeof service.fireDue !== 'function') throw new Error('createAttentionScheduler needs the attention service');
  const clock = timers || {
    setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); if (handle.unref) handle.unref(); return handle; },
    clearTimeout: handle => clearTimeout(handle),
  };
  let timer = null;
  let wakeAt = Infinity;
  let running = false;
  let ticking = false;
  let unsubscribe = null;

  function arm() {
    if (timer) clock.clearTimeout(timer);
    timer = null;
    if (!running) return;
    let wait = maxWaitMs;
    let due = null;
    try { due = service.nextDueAt(); } catch (error) { log(`next time not read: ${error.message}`); }
    if (due) wait = Math.max(0, Math.min(maxWaitMs, Date.parse(due) - now()));
    wakeAt = now() + wait;
    timer = clock.setTimeout(tick, wait);
  }

  function tick() {
    timer = null;
    if (!running) return [];
    ticking = true;
    let fired = [];
    try { fired = service.fireDue(now()); } catch (error) { log(`round failed: ${error.message}`); } finally { ticking = false; }
    arm();
    return fired;
  }

  // A change with a fire time before the timer's: look again then.
  function onChange(change) {
    if (!running || ticking || !change || !change.item || !change.item.next_at) return;
    const at = Date.parse(change.item.next_at);
    if (Number.isFinite(at) && at < wakeAt) arm();
  }

  function start() {
    if (running) return;
    running = true;
    unsubscribe = service.onChange(onChange);
    // A script run that was open when the server stopped ended with it: it is recorded as stopped before the first round.
    if (typeof service.recoverScripts === 'function') { try { service.recoverScripts(); } catch (error) { log(`open script runs not ended: ${error.message}`); } }
    tick();
  }

  function stop() {
    running = false;
    if (timer) clock.clearTimeout(timer);
    timer = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  return { start, stop, tick, running: () => running };
}

let shared = null;
function sharedScheduler() {
  if (!shared) shared = createAttentionScheduler({ service: require('./attention').defaultService() });
  return shared;
}

module.exports = { createAttentionScheduler, sharedScheduler, MAX_WAIT_MS };
