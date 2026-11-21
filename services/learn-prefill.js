// The meanings and transcriptions of the word cards of Learn, translated ahead of time and stored ("Meanings are translated ahead of time" in
// docs/design/learn-english.md), so a practice queue (services/learn.js queue()) and Spell seldom wait for the translator.
//
// - What: services/learn.js prefill(), batch after batch (BATCH cards each, in practice order) until no card is left, the translator fails or the
//   run reached MAX_PER_RUN cards; the next run goes on from there. It uses the translator the person set up (the same check as the picking of
//   services/learn-pick.js), and only the English word is sent, as for a word looked up on the page.
// - When: a few minutes after the server starts (with up to a minute of jitter), then every hour, and a few seconds after new word cards were stored
//   (a starter list, a word added through the API or picked from a translation; several in a row make one run).
// - Where: never on a company computer (its cards come filled from its home through the Learn sync). With linked engines only on one of them, the
//   one the picking elects (learn-pick.js pickRunner: no online normal engine that picks has a smaller instance id), so two engines do not ask the
//   translator twice for the same words; the meanings reach the others with the sync (a filled meaning keeps the content clock).
// - Logged once per reason without any content, and once when it works again. Tests hand in their own service, clock and timers.
const { pickRunner } = require('./learn-pick');

const BATCH = 40;
const MAX_PER_RUN = 300;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 3 * 60 * 1000;
const AFTER_NEW_MS = 5000;

const cut = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

// `learn`: the learning service (prefill, missingMeanings); `isConfigured(owner)`: a translator is set up; `sync`: the learning sync (me(), pickPeers(),
// company()) or null; `company()`: the company computer flag; `timers`: { setTimeout, clearTimeout, setInterval, clearInterval } (tests hand in fakes).
function createLearnPrefill({
  learn, isConfigured, sync = null, company = null, owner = () => require('./single-user').ensureSingleUser().login, log = console,
  checkEveryMs = CHECK_EVERY_MS, firstCheckMs = FIRST_CHECK_MS, afterNewMs = AFTER_NEW_MS, random = Math.random, batch = BATCH, maxPerRun = MAX_PER_RUN,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
}) {
  const isCompany = () => Boolean(company ? company() : sync && sync.company());
  const running = new Map(); // owner -> the run in progress
  const again = new Set(); // owners with new words while their run went on: one more run after it

  const reported = new Map();
  function note(what, error = null) {
    const reason = error ? cut(error.message || 'failed', 160) : null;
    const before = reported.get(what) || null;
    if (reason === before) return;
    if (reason) { reported.set(what, reason); log.warn(`[learn-prefill] ${what} failed: ${reason}`); } else if (before) {
      reported.delete(what);
      (log.info || log.warn).call(log, `[learn-prefill] ${what} works again`);
    }
  }

  // Why this engine does not translate now, or null.
  function blocked(name) {
    if (isCompany()) return 'company';
    if (!isConfigured(name)) return 'no-model';
    if (sync && !pickRunner(sync.me(), sync.pickPeers())) return 'other-engine';
    return null;
  }

  // One run: batch after batch, at most maxPerRun cards. Returns 'done' | 'capped' | 'failed' | the reason it stopped ('company', 'no-model',
  // 'other-engine').
  async function runPrefill(name) {
    let taken = 0;
    while (taken < maxPerRun) {
      const reason = blocked(name);
      if (reason) return reason;
      const result = await learn.prefill(name, { max: Math.min(batch, maxPerRun - taken) });
      taken += result.tried;
      if (result.failed) {
        note('translating word cards ahead of time', result.error);
        return 'failed';
      }
      note('translating word cards ahead of time');
      if (!result.tried || !result.left) return 'done';
    }
    const left = learn.missingMeanings(name);
    if (left) (log.info || log.warn).call(log, `[learn-prefill] ${left} word cards still without a meaning; the next run goes on`);
    return 'capped';
  }
  // Starts a run for the owner unless one is going (then one more follows it, for words stored after its last batch was read).
  function run(name) {
    if (running.has(name)) { again.add(name); return running.get(name); }
    const work = runPrefill(name).catch(error => { note('translating word cards ahead of time', error); return 'failed'; }).finally(() => {
      running.delete(name);
      if (again.delete(name)) run(name);
    });
    running.set(name, work);
    track(work);
    return work;
  }

  // New word cards: a run a moment later (several in a row make one run).
  const soon = new Map(); // owner -> { timer, done, resolve }
  function afterNewWords(name) {
    if (isCompany()) return;
    let entry = soon.get(name);
    if (entry) timers.clearTimeout(entry.timer);
    else {
      entry = {};
      entry.done = new Promise(resolve => { entry.resolve = resolve; });
      soon.set(name, entry);
      track(entry.done);
    }
    entry.timer = timers.setTimeout(() => { soon.delete(name); run(name).then(entry.resolve, entry.resolve); }, afterNewMs);
    if (entry.timer && entry.timer.unref) entry.timer.unref();
  }

  // The start and hourly check. Returns the reason it did not run, or what the run returned.
  async function check() {
    const name = owner();
    const reason = blocked(name);
    if (reason) return reason;
    if (running.has(name)) return 'running';
    return run(name);
  }

  // What is going on in the background, for tests (settle) and for stop.
  let last = Promise.resolve();
  function track(work) { last = Promise.all([last, work]).then(() => {}, () => {}); }
  async function settle() {
    for (let seen = null; seen !== last;) { seen = last; await seen; }
  }

  let timer = null;
  let interval = null;
  function start() {
    if (interval) return;
    const tick = () => { check().catch(() => {}); };
    timer = timers.setTimeout(tick, firstCheckMs + Math.floor(random() * 60_000));
    interval = timers.setInterval(tick, checkEveryMs);
    if (timer && timer.unref) timer.unref();
    if (interval && interval.unref) interval.unref();
  }
  function stop() {
    if (timer) timers.clearTimeout(timer);
    if (interval) timers.clearInterval(interval);
    timer = null;
    interval = null;
    for (const entry of soon.values()) { timers.clearTimeout(entry.timer); if (entry.resolve) entry.resolve(); }
    soon.clear();
  }
  const started = () => Boolean(interval);

  return { run, check, afterNewWords, settle, start, stop, started };
}

let singleton = null;
function getLearnPrefill() {
  if (singleton) return singleton;
  const db = require('../db');
  const config = require('../config');
  const learnSync = require('./learn-sync');
  const sync = learnSync.syncEnabled() ? learnSync.getLearnSync() : null;
  const translator = require('./translator').createTranslator({ db, sessionSecret: config.sessionSecret });
  singleton = createLearnPrefill({
    learn: require('./learn').sharedLearn(), sync, isConfigured: name => translator.isConfigured(name),
    company: () => require('./device-tier').getDeviceTier().isCompany(),
  });
  return singleton;
}
// New word cards were stored (services/learn.js, services/learn-pick.js): nothing unless the server started the translation ahead of time.
function afterNewWords(name) { if (singleton && singleton.started()) singleton.afterNewWords(name); }
const stopShared = () => { if (singleton) singleton.stop(); };

module.exports = { createLearnPrefill, getLearnPrefill, afterNewWords, stopShared, BATCH, MAX_PER_RUN, AFTER_NEW_MS };
