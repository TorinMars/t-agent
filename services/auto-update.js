// Applies an available update without asking, when that costs nobody anything. See "Update check and versions" in DESIGN.md.
// An update that needs no restart is applied at once. One that needs a restart waits until lib/update-idle.js has found nothing to lose for a whole quiet window.
// Everything it needs is injected, so it has no database, git or process.exit of its own.
const { idleBlockers } = require('../lib/update-idle');

const TICK_MS = 60_000;
const DEFAULT_QUIET_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
// A retry cannot fix these: a person has to look at the checkout.
const PERMANENT_FAILURES = new Set(['WORKTREE_DIRTY', 'BRANCH_DIVERGED', 'NO_GIT_CHANGES']);
// The remote moved between the decision and the update, and the new target needs a restart: not a failure, the normal waiting starts.
const AUTO_RESTART_REQUIRED = 'AUTO_RESTART_REQUIRED';

function defaults() {
  return { enabled: true, attempts: null, last_auto_version: null, last_auto_at: null };
}

function createAutoUpdate({
  readStore, writeStore, updateState, isApplying, apply, log, supervisor,
  checksEnabled, checkIntervalMs, quietMs = DEFAULT_QUIET_MS,
  now = () => Date.now(), setIntervalFn = setInterval,
}) {
  let stored = null;
  let probe = null;
  let probeError = null;
  let quietStart = null;
  let waitingFor = [];
  let lastLogged = null;
  let applying = false;
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
    waitingFor = [];
    probeError = null;
    lastLogged = null;
  }

  // The attempts recorded for this version; those of any other version no longer count.
  function attemptsFor(version) {
    const attempts = load().attempts;
    return attempts && attempts.version === version ? attempts : null;
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
    waitingFor = reasons || [];
    if (!reasons) return logChange(`probe:${probeError}`, `Auto update: the idle check gave no answer (${probeError}), not restarting`);
    const codes = reasons.map(reason => reason.code).join(', ');
    return logChange(`blocked:${codes}`, `Auto update: waiting for ${codes}`);
  }

  async function attempt(version, restartRequired) {
    const previous = attemptsFor(version);
    const count = (previous ? previous.count : 0) + 1;
    // Saved before the update starts, so an update that kills the process still counts.
    save({ attempts: { version, count, last_at: now(), gave_up: false, last_error: null } });
    applying = true;
    clearWait();
    log('auto', `Auto update: applying ${version}, attempt ${count}`);
    let restarting = false;
    try {
      // Never `force`: local changes stop an automatic update.
      const result = await apply(restartRequired ? {} : { expectNoRestart: true });
      if (!result || !['restarting', 'completed'].includes(result.stage)) throw new Error('AUTO_UPDATE_NOT_COMPLETED');
      restarting = result.stage === 'restarting'; // the process exits in a moment: it stays "applying" until then
      const applied = result.remote_version || version;
      save({ attempts: null, last_auto_version: applied, last_auto_at: new Date(now()).toISOString() });
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
    }
  }

  async function evaluate() {
    if (!support().supported || !load().enabled || isApplying()) return clearWait();
    const update = updateState();
    if (update.status !== 'available' || !update.remote_version) return clearWait();
    const version = update.remote_version;
    const attempts = attemptsFor(version);
    if (attempts && attempts.gave_up) return clearWait();
    const retryAt = attempts ? attempts.last_at + checkIntervalMs : 0;

    if (update.restart_required === false) {
      clearWait();
      if (now() >= retryAt) await attempt(version, false);
      return undefined;
    }

    const reasons = readBlockers();
    if (!reasons || reasons.length) return noteBlocked(reasons);
    waitingFor = [];
    if (quietStart === null) {
      quietStart = now();
      logChange('quiet', `Auto update: quiet window started, restarting for ${version} at ${new Date(quietStart + quietMs).toISOString()} if nothing changes`);
    }
    if (now() - quietStart < quietMs || now() < retryAt) return undefined;
    // The last look before the restart that ends the terminals.
    const finalReasons = readBlockers();
    if (!finalReasons || finalReasons.length) return noteBlocked(finalReasons);
    return attempt(version, true);
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

  function publicState() {
    const { supported, unsupported_reason: unsupportedReason } = support();
    const setting = load();
    const update = updateState();
    const attempts = attemptsFor(update.remote_version);
    const pendingAfterFailure = update.status === 'blocked' && Boolean(attempts);
    // A failed update can leave the new code on disk: the next check says restart_pending, and only a person restarts the service.
    const stuck = update.status === 'restart_pending' && Boolean(attempts);
    let current = 'idle';
    if (!supported) current = 'unsupported';
    else if (applying) current = 'applying';
    else if (!setting.enabled) current = 'off';
    else if (stuck || (attempts && attempts.gave_up && (update.status === 'available' || pendingAfterFailure))) current = 'gave_up';
    else if (update.status === 'available' || pendingAfterFailure) current = 'waiting';
    const retryAt = attempts ? attempts.last_at + checkIntervalMs : 0;
    const counting = current === 'waiting' && update.status === 'available' && quietStart !== null;
    return {
      enabled: setting.enabled,
      supported,
      unsupported_reason: unsupportedReason,
      state: current,
      waiting_for: current === 'waiting' ? waitingFor.map(reason => ({ ...reason })) : [],
      quiet_until: counting ? new Date(Math.max(quietStart + quietMs, retryAt)).toISOString() : null,
      last_error: current === 'waiting' || current === 'gave_up' ? (attempts && attempts.last_error) || probeError : null,
      last_auto_version: setting.last_auto_version,
      last_auto_at: setting.last_auto_at,
    };
  }

  return { tick, kick, start, setEnabled, setIdleProbe, publicState };
}

module.exports = { createAutoUpdate, AUTO_RESTART_REQUIRED, DEFAULT_QUIET_MS, MAX_ATTEMPTS, TICK_MS };
