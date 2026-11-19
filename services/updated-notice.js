// "Updated to v…": after the service was updated, the person's next visit to the page shows a dialog once ("Notice after an update" in
// docs/design/update-check-and-versions.md).
//
// - At start (`record`) the running version is compared with the one recorded last (system_state `updated_running_v1` { version }). When it went
//   up, the owner gets a notice (system_state `updated_notice_v1:<owner>` { version, previous_version, updated_at }). A notice that was not
//   acknowledged yet keeps its `previous_version`, so several updates in a row show one dialog from the oldest version not seen. A first start
//   (nothing recorded, and no version left in the update state of an older release) records the version and tells nothing; a downgrade drops
//   the notice.
// - `view(owner)` is what the page reads: whether to show, the versions, the time, this engine's name, the release notes of the versions in the
//   range (the "Recent versions" lines of DESIGN.md, `> vX.Y.Z note`, which scripts/release.js appends) and one line per linked engine that has a
//   notice of its own. `acknowledge(owner, version, linked)` removes the notice (only the version that was shown, so an update that came in
//   meanwhile still shows) and acknowledges the linked engines' notices on them.
// - Linked engines: GET /v1/info must list `updated-notice`; then GET /v1/updated-notice and POST /v1/updated-notice/ack (routes/updated-notice.js,
//   link tokens only). An older peer, an offline one or one that does not answer in time is left out.
const fs = require('fs');
const path = require('path');
const { compareSemver, parseSemver } = require('../lib/version-utils');
const { readState, writeState, isPlainObject } = require('./settings-sync-store');

const CAPABILITY = 'updated-notice';
const RUNNING_KEY = 'updated_running_v1';
const noticeKey = owner => `updated_notice_v1:${owner}`;
const NOTE_LINE = /^> v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) +(.+?)\s*$/;
const MAX_NOTES = 60;
const MAX_NOTE_CHARS = 1000;
const PEER_TIMEOUT_MS = 4000;
const INFO_TTL_MS = 10 * 60 * 1000;

const valid = version => typeof version === 'string' && Boolean(parseSemver(version));
const newer = (left, right) => compareSemver(left, right) > 0;

// The "Recent versions" lines of a DESIGN.md text: [{ version, note }] in file order.
function parseNotes(text) {
  const notes = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = NOTE_LINE.exec(line);
    if (match && valid(match[1])) notes.push({ version: match[1], note: match[2].slice(0, MAX_NOTE_CHARS) });
  }
  return notes;
}

// The notes of the versions after `previous` up to `current`, newest first; a version listed twice keeps its last line.
function notesInRange(notes, previous, current) {
  if (!valid(previous) || !valid(current)) return [];
  const byVersion = new Map();
  for (const entry of notes) if (newer(entry.version, previous) && !newer(entry.version, current)) byVersion.set(entry.version, entry);
  return [...byVersion.values()].sort((a, b) => compareSemver(b.version, a.version)).slice(0, MAX_NOTES);
}

function createUpdatedNotice(options) {
  const {
    db,
    runningVersion, // () => the version this process runs
    legacyVersion = () => null, // () => the version an older release left in its update state (the first start of this feature)
    owner = () => require('./single-user').ensureSingleUser().login,
    engineName = () => '',
    notesFile = path.join(__dirname, '..', 'DESIGN.md'),
    updating = () => false, // an update is being applied: the page reloads soon, nothing is shown now
    serviceLinks = null, request = null,
    now = Date.now, log = console,
    timeoutMs = PEER_TIMEOUT_MS, infoTtlMs = INFO_TTL_MS,
  } = options;

  const readNotice = name => {
    const value = readState(db, noticeKey(name));
    return isPlainObject(value) && valid(value.version) && valid(value.previous_version) ? value : null;
  };

  // ---- At start ----
  function record() {
    const current = runningVersion();
    if (!valid(current)) return null;
    const stored = readState(db, RUNNING_KEY);
    let last = isPlainObject(stored) && valid(stored.version) ? stored.version : null;
    if (!last) { try { last = legacyVersion(); } catch { last = null; } }
    writeState(db, RUNNING_KEY, { version: current });
    if (!valid(last) || last === current) return null;
    const name = owner();
    const pending = readNotice(name);
    if (!newer(current, last)) {
      // A downgrade: what the notice tells is not running any more.
      if (pending) writeState(db, noticeKey(name), null);
      return null;
    }
    const previous = pending && newer(current, pending.previous_version) ? pending.previous_version : last;
    const notice = { version: current, previous_version: previous, updated_at: new Date(now()).toISOString() };
    writeState(db, noticeKey(name), notice);
    return notice;
  }

  // The owner's notice about the version running now, or null.
  function pending(name) {
    const notice = readNotice(name);
    return notice && notice.version === runningVersion() ? notice : null;
  }
  const shouldShow = name => Boolean(pending(name)) && !updating();

  // ---- Release notes (cached by the file's time and size) ----
  let cache = null;
  function allNotes() {
    let stat;
    try { stat = fs.statSync(notesFile); } catch { cache = null; return []; }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (!cache || cache.stamp !== stamp) {
      let text = '';
      try { text = fs.readFileSync(notesFile, 'utf8'); } catch { text = ''; }
      cache = { stamp, notes: parseNotes(text) };
    }
    return cache.notes;
  }

  // ---- Linked engines ----
  const infoCache = new Map(); // peer id -> { supported, at }
  const livePeers = () => {
    if (!serviceLinks || !request) return [];
    try { return serviceLinks.peers().filter(peer => peer.online); } catch { return []; }
  };
  const call = (peer, route, opts = {}) => request(peer.baseUrl, route, peer.token, { timeoutMs, ...opts });
  async function supports(peer) {
    const known = infoCache.get(peer.id);
    if (known && now() - known.at < infoTtlMs) return known.supported;
    const info = await call(peer, '/v1/info');
    const supported = Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(CAPABILITY));
    infoCache.set(peer.id, { supported, at: now() });
    return supported;
  }
  const reported = new Set();
  const warn = (peer, error) => {
    const key = `${peer.id}:${error && error.message}`;
    if (reported.has(key)) return;
    reported.add(key);
    log.warn(`[updated-notice] ${peer.name}: ${/^[A-Z0-9_]{1,64}$/.test((error && error.message) || '') ? error.message : 'REQUEST_FAILED'}`);
  };
  // [{ id, name, version }]: the linked engines with a notice of their own.
  async function linkedNotices() {
    const rows = await Promise.all(livePeers().map(async peer => {
      try {
        if (!(await supports(peer))) return null;
        const answer = await call(peer, '/v1/updated-notice');
        if (!answer || answer.pending !== true || !valid(answer.version)) return null;
        return { id: peer.id, name: String(peer.name || answer.name || ''), version: answer.version };
      } catch (error) { warn(peer, error); return null; }
    }));
    return rows.filter(Boolean);
  }

  // ---- The page ----
  async function view(name, { linked = true } = {}) {
    const notice = pending(name);
    if (!notice || updating()) return { show: false };
    let engine = '';
    try { engine = String(engineName() || ''); } catch { engine = ''; }
    return {
      show: true,
      version: notice.version,
      previous_version: notice.previous_version,
      updated_at: notice.updated_at,
      engine_name: engine,
      notes: notesInRange(allNotes(), notice.previous_version, notice.version),
      linked: linked ? await linkedNotices() : [],
    };
  }

  // Removes the owner's notice when `version` is the one it tells about (or no version is given); true when it did.
  function acknowledgeLocal(name, version) {
    const notice = readNotice(name);
    if (!notice || (version !== undefined && version !== null && version !== notice.version)) return false;
    writeState(db, noticeKey(name), null);
    return true;
  }

  async function acknowledge(name, body = {}) {
    const version = body.version === undefined ? undefined : body.version;
    if (version !== undefined && version !== null && !valid(version)) throw Object.assign(new Error('INVALID_UPDATED_NOTICE'), { statusCode: 400 });
    const wanted = Array.isArray(body.linked) ? body.linked.filter(row => isPlainObject(row) && typeof row.id === 'string' && valid(row.version)).slice(0, 32) : [];
    const acknowledged = acknowledgeLocal(name, version);
    const peers = new Map(livePeers().map(peer => [peer.id, peer]));
    const linked = await Promise.all(wanted.map(async row => {
      const peer = peers.get(row.id);
      if (!peer) return { id: row.id, acknowledged: false };
      try {
        if (!(await supports(peer))) return { id: row.id, acknowledged: false };
        const answer = await call(peer, '/v1/updated-notice/ack', { method: 'POST', body: { version: row.version } });
        return { id: row.id, acknowledged: Boolean(answer && answer.acknowledged) };
      } catch (error) { warn(peer, error); return { id: row.id, acknowledged: false }; }
    }));
    return { acknowledged, linked };
  }

  // ---- A linked engine asks (routes/updated-notice.js): this engine's own notice, for its single owner ----
  function engineDescribe() {
    const notice = pending(owner());
    let engine = '';
    try { engine = String(engineName() || ''); } catch { engine = ''; }
    return notice ? { pending: true, version: notice.version, previous_version: notice.previous_version, updated_at: notice.updated_at, name: engine } : { pending: false, name: engine };
  }
  function engineAcknowledge(body = {}) {
    if (!isPlainObject(body) || !valid(body.version)) throw Object.assign(new Error('INVALID_UPDATED_NOTICE'), { statusCode: 400 });
    return { acknowledged: acknowledgeLocal(owner(), body.version) };
  }

  return { record, pending, shouldShow, view, acknowledge, engineDescribe, engineAcknowledge };
}

let singleton = null;
function getUpdatedNotice() {
  if (singleton) return singleton;
  const db = require('../db');
  const updates = require('./update-manager');
  singleton = createUpdatedNotice({
    db,
    runningVersion: () => updates.runningVersion,
    // Before this feature nothing recorded the version; the update state of the release before keeps the version its last check ran under.
    legacyVersion: () => {
      const state = readState(db, 'update_state');
      return isPlainObject(state) && valid(state.running_version) ? state.running_version : null;
    },
    engineName: () => require('./engine-name').engineNameState(db).name,
    updating: () => updates.publicState().status === 'updating',
    serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
  });
  return singleton;
}

module.exports = { createUpdatedNotice, getUpdatedNotice, parseNotes, notesInRange, CAPABILITY, RUNNING_KEY, noticeKey };
