// T-Attention first-run guide (scripts/h5-shell/AttentionGuide.jsx): what the guide needs to remember per owner, beside what the plugin
// overview (GET /api/attention/plugins) already tells: { dismissed, pageOnly, paired, tested, updatedAt }.
//   dismissed  the person closed the guide ("Show setup guide" in Settings brings it back)
//   pageOnly   step 2 was answered with "This page only" (no notifier plugin needed)
//   paired     step 1 was done with a pairing code for another machine (the overview only sees this machine)
//   tested     step 3: one test (a notifier's or the page's) worked
// Stored as plain JSON in system_state ('attention-guide:<owner>'); nothing secret. Served by GET / PUT /api/attention/settings/guide
// (routes/attention.js, the browser session only).
// dismissed and pageOnly describe the person, so they are one choice for every linked engine (settings sync group attention-guide, exportForSync
// below): a guide closed on one engine stays closed on the others. paired and tested stay on this machine: they say what was done here.
const syncStore = require('./settings-sync-store');

const FLAGS = ['dismissed', 'pageOnly', 'paired', 'tested'];
const SHARED_FLAGS = ['dismissed', 'pageOnly'];
const SYNC_GROUP = 'attention-guide';
const guideKey = owner => `attention-guide:${owner}`;

const defaults = () => ({ dismissed: false, pageOnly: false, paired: false, tested: false, updatedAt: null });

// The stored flags of an owner, or null when there is no row.
function readGuide(db, owner) {
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(guideKey(owner));
  if (!row) return null;
  let stored;
  try { stored = JSON.parse(row.value); } catch { return defaults(); }
  if (!stored || typeof stored !== 'object') return defaults();
  const state = defaults();
  for (const flag of FLAGS) state[flag] = stored[flag] === true;
  state.updatedAt = typeof stored.updatedAt === 'string' ? stored.updatedAt : null;
  return state;
}
function writeGuide(db, owner, state) {
  db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(guideKey(owner), JSON.stringify(state));
}

function createAttentionGuide({ db, now = () => new Date(), AttentionError = Error } = {}) {
  if (!db) throw new Error('createAttentionGuide needs a database');
  const fail = message => { const error = new AttentionError('VALIDATION_FAILED', message); if (!error.code) { error.code = 'VALIDATION_FAILED'; error.statusCode = 400; } return error; };

  const get = owner => readGuide(db, owner) || defaults();

  // Only the flags in the body change; each must be true or false. Unknown fields are refused, so a typo does not pass silently.
  function save(owner, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('The request body must be a JSON object');
    const unknown = Object.keys(body).filter(name => !FLAGS.includes(name));
    if (unknown.length) throw fail(`Unknown guide setting: ${unknown[0].slice(0, 40)}`);
    const next = get(owner);
    for (const flag of FLAGS) {
      if (body[flag] === undefined) continue;
      if (typeof body[flag] !== 'boolean') throw fail(`${flag} must be true or false`);
      next[flag] = body[flag];
    }
    next.updatedAt = now().toISOString();
    writeGuide(db, owner, next);
    if (SHARED_FLAGS.some(flag => body[flag] !== undefined)) syncStore.settingChanged(SYNC_GROUP);
    return next;
  }

  return { get, save };
}

// ---- Settings sync (services/settings-sync.js) ----
// The shared value: { dismissed, pageOnly } while either is set, else null, so an engine where the guide was never closed never reopens it on one
// where it was.
function exportForSync({ db }, owner) {
  const state = readGuide(db, owner);
  if (!state || !SHARED_FLAGS.some(flag => state[flag])) return null;
  return { dismissed: state.dismissed, pageOnly: state.pageOnly };
}
// A linked engine's flags (null: neither is set there any more, for example after "Show setup guide"); paired and tested are kept. Anything but
// null or { dismissed, pageOnly } of booleans throws INVALID_SYNC_VALUE.
function importFromSync({ db }, owner, value) {
  if (value !== null && (!syncStore.isPlainObject(value) || Object.keys(value).some(flag => !SHARED_FLAGS.includes(flag))
    || !SHARED_FLAGS.every(flag => typeof value[flag] === 'boolean'))) {
    throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 });
  }
  const current = readGuide(db, owner);
  if (!current && value === null) return;
  const next = current || defaults();
  for (const flag of SHARED_FLAGS) next[flag] = value ? value[flag] : false;
  writeGuide(db, owner, next);
}

module.exports = { createAttentionGuide, exportForSync, importFromSync, SYNC_GROUP, GUIDE_FLAGS: FLAGS, SHARED_GUIDE_FLAGS: SHARED_FLAGS };
