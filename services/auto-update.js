// Applies an available update without asking, when that costs nobody anything. See "Update check and versions" in DESIGN.md.
// An update that needs no restart is applied at once. One that needs a restart waits until lib/update-idle.js has found nothing to lose for a whole quiet window.
// Code on disk that is newer than the running process (status restart_pending, for example after a manual git pull) is loaded the same way: the same wait, then a restart.
// Everything it needs is injected, so it has no database, git or process.exit of its own.
const { idleBlockers } = require('../lib/update-idle');

const TICK_MS = 60_000;
const DEFAULT_QUIET_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
// Automatic restarts for one restart target (the HEAD commit, or the version on disk of an archive install).
const MAX_RESTARTS = 2;
// A retry cannot fix these: a person has to look at the checkout.
const PERMANENT_FAILURES = new Set(['WORKTREE_DIRTY', 'BRANCH_DIVERGED', 'NO_GIT_CHANGES']);
// The remote moved between the decision and the update, and the new target needs a restart: not a failure, the normal waiting starts.
const AUTO_RESTART_REQUIRED = 'AUTO_RESTART_REQUIRED';
// The process restarted for this target and still runs older code (for example a commit that is not read right): restarting again would not help.
const RESTART_DID_NOT_HELP = 'RESTART_DID_NOT_HELP';
// Something else holds the update lock, or a restart from the page was accepted meanwhile: not a failure of the automatic restart.
const RESTART_BUSY = new Set(['UPDATE_IN_PROGRESS', 'RESTART_PENDING']);

function defaults() {
  return { enabled: true, attempts: null, restart: null, last_auto_version: null, last_auto_at: null, last_auto_action: null, last_auto_boot: null };
}

function createAutoUpdate({
  readStore, writeStore, updateState, isApplying, apply, restart = async () => { throw new Error('AUTO_RESTART_UNAVAILABLE'); },
  log, supervisor, restartPending = () => false, bootId = null,
  checksEnabled, checkIntervalMs, quietMs = DEFAULT_QUIET_MS,
  now = () => Date.now(), setIntervalFn = setInterval,
}) {
  let stored = null;
  let probe = null;
  let probeError = null;
  let quietStart = null;
  let quietAction = null; // what the running quiet window is for: 'update' or 'restart'
  let waitingFor = [];
  let lastLogged = null;
  let applying = false;
  let applyingAction = null;
  let ticking = false;
  let timer = null;

  function load() {
    if (stored) return stored;
    let saved = null;
    try { saved = JSON.parse(readStore()); } catch { /* nothing saved yet, or unreadable */ }
    const merged = { ...defaults(), ...(saved && typeof saved === 'object' ? saved : {}) };
    stored = { ...merged, enabled: merged.enabled !== false };
    return stored;
  }

  function save(patch) {
    stored = { ...load(), ...patch };
    writeStore(JSON.stringify(stored));
  }

  function support() {
    if (!checksEnabled) return { supported: false, unsupported_reason: 'CHECKS_DISABLED' };
    if (!supervisor()) return { supported: false, unsupported_reason: 'NO_PROCESS_MANAGER' };
    return { supported: true, unsupported_reason: null };
  }

  function logChange(signature, message) {
    if (signature === lastLogged) return;
    lastLogged = signature;
    log('auto', message);
  }

  function clearWait() {
    quietStart = null;
    quietAction = null;
    waitingFor = [];
    probeError = null;
    lastLogged = null;
  }

  // The attempts recorded for this version; those of any other version no longer count.
  function attemptsFor(version) {
    const attempts = load().attempts;
    return attempts && attempts.version === version ? attempts : null;
  }

  // The automatic restarts recorded for this target; a new target starts a new count.
  function restartsFor(target) {
    const record = load().restart;
    return target && record && record.target === target ? record : null;
  }

  // A later process still finds this target pending after the last allowed restart: give up instead of restarting in a loop.
  function restartExhausted(record) {
    return Boolean(record) && !record.gave_up && record.count >= MAX_RESTARTS && record.boot !== bootId;
  }

  // The reasons not to restart, or null when they cannot be known (then nothing restarts).
  function readBlockers() {
    if (!probe) {
      probeError = 'IDLE_PROBE_UNAVAILABLE';
      return null;
    }
    try {
      const reasons = idleBlockers(probe(), { quietMs, now: now() });
      probeError = null;
      return reasons;
    } catch (error) {
      console.error('[auto-update] idle check failed:', error.message);
      probeError = 'IDLE_PROBE_FAILED';
      return null;
    }
  }

  function noteBlocked(reasons) {
    quietStart = null;
    quietAction = null;
    waitingFor = reasons || [];
    if (!reasons) return logChange(`probe:${probeError}`, `Auto update: the idle check gave no answer (${probeError}), not restarting`);
    const codes = reasons.map(reason => reason.code).join(', ');
    return logChange(`blocked:${codes}`, `Auto update: waiting for ${codes}`);
  }

  // The idle gate shared by an update that needs a restart and a restart for code already on disk.
  // True once nothing has blocked for a whole quiet window, `retryAt` has passed, and a last look still finds nothing.
  function quietGate(action, label, retryAt) {
    if (quietAction !== action) { quietStart = null; quietAction = action; }
    const reasons = readBlockers();
    if (!reasons || reasons.length) { noteBlocked(reasons); return false; }
    waitingFor = [];
    if (quietStart === null) {
      quietStart = now();
      quietAction = action;
      logChange(`quiet:${action}`, `Auto update: quiet window started, restarting for ${label} at ${new Date(quietStart + quietMs).toISOString()} if nothing changes`);
    }
    if (now() - quietStart < quietMs || now() < retryAt) return false;
    // The last look before the restart that ends the terminals.
    const finalReasons = readBlockers();
    if (!finalReasons || finalReasons.length) { noteBlocked(finalReasons); return false; }
    return true;
  }

  async function attempt(version, restartRequired) {
    const previous = attemptsFor(version);
    const count = (previous ? previous.count : 0) + 1;
    // Saved before the update starts, so an update that kills the process still counts.
    save({ attempts: { version, count, last_at: now(), gave_up: false, last_error: null } });
    applying = true;
    applyingAction = 'update';
    clearWait();
    log('auto', `Auto update: applying ${version}, attempt ${count}`);
    let restarting = false;
    try {
      // Never `force`: local changes stop an automatic update.
      const result = await apply(restartRequired ? {} : { expectNoRestart: true });
      if (!result || !['restarting', 'completed'].includes(result.stage)) throw new Error('AUTO_UPDATE_NOT_COMPLETED');
      restarting = result.stage === 'restarting'; // the process exits in a moment: it stays "applying" until then
      const applied = result.remote_version || version;
      // last_auto_boot names the process that an automatic update or restart replaced; an update with no restart replaced none.
      save({ attempts: null, last_auto_version: applied, last_auto_at: new Date(now()).toISOString(), last_auto_action: 'update', last_auto_boot: restarting ? bootId : null });
      log('auto', `Auto update: finished ${applied}`);
    } catch (error) {
      const message = String(error && error.message || '');
      if (message === AUTO_RESTART_REQUIRED) {
        save({ attempts: previous });
        log('auto', 'Auto update: the new version needs a restart, waiting for a quiet time');
        return;
      }
      const code = /^[A-Z0-9_]+$/.test(message) ? message : 'UPDATE_FAILED';
      const gaveUp = PERMANENT_FAILURES.has(code) || count >= MAX_ATTEMPTS;
      save({ attempts: { version, count, last_at: now(), gave_up: gaveUp, last_error: code } });
      log('auto', gaveUp ? `Auto update: stopped for ${version}: ${code}` : `Auto update: attempt ${count} for ${version} failed: ${code}`);
    } finally {
      applying = restarting;
      if (!restarting) applyingAction = null;
    }
  }

  async function attemptRestart(target, version) {
    const previous = restartsFor(target);
    const count = (previous ? previous.count : 0) + 1;
    // Saved before the restart starts, so a process that dies on the way still counts.
    const record = { target, count, last_at: now(), boot: bootId, restarted: false, gave_up: false, last_error: null };
    save({ restart: record });
    applying = true;
    applyingAction = 'restart';
    clearWait();
    log('auto', `Auto update: restarting to load ${target}, attempt ${count}`);
    let restarting = false;
    try {
      // Checks the target again, installs dependencies when the lock file changed, checks node-pty, then asks lib/server-restart.js for the exit.
      const result = await restart({ target });
      if (result && result.stage === 'stale') {
        save({ restart: previous });
        log('auto', 'Auto update: the code on disk changed or is already running, not restarting');
        return;
      }
      if (!result || result.stage !== 'restarting') throw new Error('AUTO_RESTART_NOT_COMPLETED');
      restarting = true;
      const running = result.version || version || null;
      save({ restart: { ...record, restarted: true }, last_auto_version: running, last_auto_at: new Date(now()).toISOString(), last_auto_action: 'restart', last_auto_boot: bootId });
      log('auto', `Auto update: restarting the service for ${running || target}`);
    } catch (error) {
      const message = String(error && error.message || '');
      if (RESTART_BUSY.has(message)) {
        save({ restart: previous });
        log('auto', `Auto update: not restarting now: ${message}`);
        return;
      }
      // The code on disk cannot start as it is (npm ci or node-pty failed): restarting into it would break the service, so this target is given up.
      const code = /^[A-Z0-9_]+$/.test(message) ? message : 'RESTART_FAILED';
      save({ restart: { ...record, gave_up: true, last_error: code } });
      log('auto', `Auto update: stopped restarting for ${target}: ${code}`);
    } finally {
      applying = restarting;
      if (!restarting) applyingAction = null;
    }
  }

  async function evaluateUpdate(update) {
    const version = update.remote_version;
    const attempts = attemptsFor(version);
    if (attempts && attempts.gave_up) return clearWait();
    const retryAt = attempts ? attempts.last_at + checkIntervalMs : 0;

    if (update.restart_required === false) {
      clearWait();
      if (now() >= retryAt) await attempt(version, false);
      return undefined;
    }
    if (!quietGate('update', version, retryAt)) return undefined;
    return attempt(version, true);
  }

  async function evaluateRestart(update) {
    const target = update.restart_target;
    const record = restartsFor(target);
    if (record && record.gave_up) return clearWait();
    if (restartExhausted(record)) {
      save({ restart: { ...record, gave_up: true, last_error: RESTART_DID_NOT_HELP } });
      log('auto', `Auto update: ${record.count} restarts did not load ${target}; restart the service by hand`);
      return clearWait();
    }
    // At least one quiet window between two restarts for the same target.
    const retryAt = record ? record.last_at + quietMs : 0;
    if (!quietGate('restart', target, retryAt)) return undefined;
    return attemptRestart(target, update.local_version);
  }

  async function evaluate() {
    // A restart asked for from the page exits within a second: skip this tick, and keep the wait as it is for the new process to rebuild anyway.
    if (restartPending()) return undefined;
    if (!support().supported || !load().enabled || isApplying()) return clearWait();
    const update = updateState();
    // An available update goes first: it restarts as well when it needs to.
    if (update.status === 'available' && update.remote_version) return evaluateUpdate(update);
    if (update.status === 'restart_pending' && update.restart_target) return evaluateRestart(update);
    return clearWait();
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try { await evaluate(); }
    catch (error) { console.error('[auto-update]', error.message); }
    finally { ticking = false; }
  }

  // Looks again now instead of at the next minute. Does nothing before start().
  function kick() {
    if (timer) void tick();
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(() => void tick(), TICK_MS);
    if (timer && timer.unref) timer.unref();
    const { supported, unsupported_reason: reason } = support();
    if (!supported) log('auto', `Auto update is not available here: ${reason}`);
  }

  function setEnabled(enabled) {
    if (enabled !== load().enabled) log('auto', enabled ? 'Auto update turned on' : 'Auto update turned off');
    save({ enabled });
    if (enabled) kick(); else clearWait();
  }

  function setIdleProbe(fn) {
    probe = fn || null;
  }

  // What the scheduler does about the current status, without the switch: { state, action, last_error, retryAt }.
  function plan(update) {
    const attempts = attemptsFor(update.remote_version);
    const pendingAfterFailure = update.status === 'blocked' && Boolean(attempts);
    if (update.status === 'available' || pendingAfterFailure) {
      const gaveUp = Boolean(attempts && attempts.gave_up);
      return { state: gaveUp ? 'gave_up' : 'waiting', action: 'update', last_error: (attempts && attempts.last_error) || null, retryAt: attempts ? attempts.last_at + checkIntervalMs : 0 };
    }
    if (update.status === 'restart_pending' && update.restart_target) {
      const record = restartsFor(update.restart_target);
      if (record && record.gave_up) return { state: 'gave_up', action: 'restart', last_error: record.last_error, retryAt: 0 };
      if (restartExhausted(record)) return { state: 'gave_up', action: 'restart', last_error: RESTART_DID_NOT_HELP, retryAt: 0 };
      return { state: 'waiting', action: 'restart', last_error: null, retryAt: record ? record.last_at + quietMs : 0 };
    }
    // restart_pending with no known target (an older state, or HEAD could not be read): nothing is restarted automatically.
    if (update.status === 'restart_pending' && attempts) return { state: 'gave_up', action: 'update', last_error: attempts.last_error || null, retryAt: 0 };
    return { state: 'idle', action: null, last_error: null, retryAt: 0 };
  }

  function publicState() {
    const { supported, unsupported_reason: unsupportedReason } = support();
    const setting = load();
    const update = updateState();
    const next = plan(update);
    let current = next.state;
    let action = next.action;
    if (!supported) { current = 'unsupported'; action = null; }
    else if (applying) { current = 'applying'; action = applyingAction; }
    else if (!setting.enabled) { current = 'off'; action = null; }
    const counting = current === 'waiting' && quietStart !== null && quietAction === action;
    return {
      enabled: setting.enabled,
      supported,
      unsupported_reason: unsupportedReason,
      state: current,
      action,
      waiting_for: current === 'waiting' ? waitingFor.map(reason => ({ ...reason })) : [],
      quiet_until: counting ? new Date(Math.max(quietStart + quietMs, next.retryAt)).toISOString() : null,
      last_error: current === 'waiting' || current === 'gave_up' ? next.last_error || probeError : null,
      last_auto_version: setting.last_auto_version,
      last_auto_at: setting.last_auto_at,
      last_auto_action: setting.last_auto_action,
      last_auto_boot: setting.last_auto_boot,
    };
  }

  return { tick, kick, start, setEnabled, setIdleProbe, publicState };
}

module.exports = { createAutoUpdate, AUTO_RESTART_REQUIRED, RESTART_DID_NOT_HELP, DEFAULT_QUIET_MS, MAX_ATTEMPTS, MAX_RESTARTS, TICK_MS };
