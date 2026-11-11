// T-Attention first-run guide (scripts/h5-shell/AttentionGuide.jsx): what the guide needs to remember per owner, beside what the plugin
// overview (GET /api/attention/plugins) already tells: { dismissed, pageOnly, paired, tested, updatedAt }.
//   dismissed  the person closed the guide ("Show setup guide" in Settings brings it back)
//   pageOnly   step 2 was answered with "This page only" (no notifier plugin needed)
//   paired     step 1 was done with a pairing code for another machine (the overview only sees this machine)
//   tested     step 3: one test (a notifier's or the page's) worked
// Stored as plain JSON in system_state ('attention-guide:<owner>'); nothing secret. Served by GET / PUT /api/attention/settings/guide
// (routes/attention.js, the browser session only).
const FLAGS = ['dismissed', 'pageOnly', 'paired', 'tested'];

const defaults = () => ({ dismissed: false, pageOnly: false, paired: false, tested: false, updatedAt: null });

function createAttentionGuide({ db, now = () => new Date(), AttentionError = Error } = {}) {
  if (!db) throw new Error('createAttentionGuide needs a database');
  const key = owner => `attention-guide:${owner}`;
  const fail = message => { const error = new AttentionError('VALIDATION_FAILED', message); if (!error.code) { error.code = 'VALIDATION_FAILED'; error.statusCode = 400; } return error; };

  function get(owner) {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key(owner));
    if (!row) return defaults();
    let stored;
    try { stored = JSON.parse(row.value); } catch { return defaults(); }
    if (!stored || typeof stored !== 'object') return defaults();
    const state = defaults();
    for (const flag of FLAGS) state[flag] = stored[flag] === true;
    state.updatedAt = typeof stored.updatedAt === 'string' ? stored.updatedAt : null;
    return state;
  }

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
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key(owner), JSON.stringify(next));
    return next;
  }

  return { get, save };
}

module.exports = { createAttentionGuide, GUIDE_FLAGS: FLAGS };
