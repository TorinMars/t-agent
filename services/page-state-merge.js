// The merge rules of the shared page state (services/page-state.js; "Merge" in docs/design/shared-page-state.md). Pure: the time is passed in.
//
// A state is { recent: { <id>: entry }, keys: { <name>: { value, at, by } } }.
// - A recent entry names a terminal session by its engine-neutral identity: `instance` (the engine's instance id), `task` and `terminal`; with the
//   session's `title` and `agent` as last shown, `used` (when it was last used, ms of the page's clock, the sort key) and its version `at` / `by` (the
//   hybrid clock of the engine that took the change, and that engine's instance id). A removed entry is a tombstone (`gone: true`), so a delete travels.
//   Optional: `client` (the kind of client that noted it: phone, computer, mac, home) and `device` (a random id of that browser), so another device
//   can offer "Continue <session>, last viewed on your <client>" ("The continue hint" in docs/design/continue-and-drafts.md). Left out when unknown,
//   so an entry noted by an older page keeps the same JSON (and digest) as before.
// - A key is one remembered page choice (the old localStorage key names: 'h5-task-list-tab', 'h5-columns', ...), a JSON value of at most VALUE_MAX
//   characters, null for a cleared one (a tombstone too), with its version.
// Merging two states keeps, for every entry and key, the later version (a greater `at`, then a greater `by`, then the greater stable JSON, so every
// engine picks the same one). Then the live entries are cut to RECENT_KEEP by `used` and old tombstones go (trim), so the result is the same on every
// side and merging it again changes nothing.
// - `moves` (only when there is one): a task moved to another engine (services/task-move.js), by its old identity `<instance>|<task>`:
//   { to_instance, to_task, title, at, by }, kept MOVES_KEEP_MS. Every merge re-points what names the old identity (`repoint`): recent entries,
//   the session of a column (`h5-column:<pane>`) and drafts (`ta-draft:<hash>`, whose name is the hash of the identity), so links, columns and
//   "Continue" follow the task on every engine and page. A tombstone of an old identity is dropped (the source's page forgets the sessions of a task
//   that left its list; that must not hide them at their new place). The result is the same on every side, so the merge stays commutative.
// - `cleared` (only when the Recent list was ever cleared): { at, by }, the version of the last "Clear list". The later clear wins, and every merge
//   turns each live entry whose version is older than it into a tombstone of the clear's version (`applyClear`), so a list cleared on one device
//   stays cleared when another engine sends its older copy, also an entry this side never had (a task it may not see, an engine that was away
//   longer than a tombstone lives); an entry noted after the clear (a newer version) stays. The tombstones also clear the list of an older engine
//   that drops the unknown `cleared`. "Remove from Recent and Clear list" in docs/design/shared-page-state.md.
const RECENT_KEEP = 24; // the page shows RECENT_MAX (12) of the entries it can name; twice that here, so one side's cap never drops the other's latest
const GONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const GONE_MAX = 200;
const KEYS_MAX = 128;
const VALUE_MAX = 16384;
const TITLE_MAX = 120;
const INSTANCE = /^[A-Za-z0-9-]{1,64}$/;
const TASK = /^[1-9]\d{0,11}$/;
const TERMINAL = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_NAME = /^[a-z][a-z0-9._:-]{0,95}$/;
const AGENTS = new Set(['claude', 'codex', 'opencode']);
const CLIENTS = new Set(['phone', 'computer', 'mac', 'home']);
const DEVICE = /^[a-z0-9]{8,32}$/;
// Keys whose value is a map of times ({ <kind>: { <name>: ms } }, the recency of saved commands): two versions are merged by the later time of each
// name, so two devices that used different commands at the same time keep both.
const TIME_MAPS = new Set(['ta-saved-commands-used']);
const MOVES_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MOVES_MAX = 500;
const COLUMN_PREFIX = 'h5-column:';
const DRAFT_PREFIX = 'ta-draft:';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}
const recentId = entry => `${entry.instance}|${entry.task}|${entry.terminal}`;

// A well-formed identity { instance, task, terminal } (ids as strings), or null.
function cleanIdentity(raw) {
  if (!isObject(raw)) return null;
  const instance = typeof raw.instance === 'string' ? raw.instance : '';
  const task = raw.task === undefined || raw.task === null ? '' : String(raw.task);
  const terminal = typeof raw.terminal === 'string' ? raw.terminal : '';
  return INSTANCE.test(instance) && TASK.test(task) && TERMINAL.test(terminal) ? { instance, task, terminal } : null;
}

// What a page or a peer sends for one entry, checked: { instance, task, terminal, title, agent, used, gone }. null when malformed.
function cleanRecentChange(raw) {
  const id = cleanIdentity(raw);
  if (!id) return null;
  if (raw.gone === true) return { ...id, title: '', agent: null, used: 0, gone: true };
  const used = time(raw.used);
  return {
    ...id, title: typeof raw.title === 'string' ? raw.title.slice(0, TITLE_MAX) : '', agent: AGENTS.has(raw.agent) ? raw.agent : null,
    used: used === null ? 0 : used, gone: false, ...seenOn(raw),
  };
}
// Where an entry was noted ({ client, device }, each only when well-formed).
function seenOn(raw) {
  const out = {};
  if (CLIENTS.has(raw.client)) out.client = raw.client;
  if (typeof raw.device === 'string' && DEVICE.test(raw.device)) out.device = raw.device;
  return out;
}
// A stored or peer entry with its version, or null.
function cleanRecent(raw) {
  const change = cleanRecentChange(raw);
  const at = isObject(raw) ? time(raw.at) : null;
  if (!change || at === null) return null;
  const by = typeof raw.by === 'string' && INSTANCE.test(raw.by) ? raw.by : '';
  return { ...change, at, by };
}

// A moved record (a peer's, stored, or one made here), checked: { to_instance, to_task, title, at, by } or null.
function cleanMove(raw) {
  if (!isObject(raw)) return null;
  const at = time(raw.at);
  const toInstance = typeof raw.to_instance === 'string' ? raw.to_instance : '';
  const toTask = raw.to_task === undefined || raw.to_task === null ? '' : String(raw.to_task);
  if (at === null || !INSTANCE.test(toInstance) || !TASK.test(toTask)) return null;
  return { to_instance: toInstance, to_task: toTask, title: typeof raw.title === 'string' ? raw.title.slice(0, TITLE_MAX) : '', at, by: typeof raw.by === 'string' && INSTANCE.test(raw.by) ? raw.by : '' };
}
const MOVE_ID = /^[A-Za-z0-9-]{1,64}\|[1-9]\d{0,11}$/;
// A state with its moves, the key left out when there are none (so a state without moves reads, and digests, as before moves existed).
const withMoves = (state, moves) => (moves && Object.keys(moves).length ? { ...state, moves } : state);
// The same for the clear mark: carried along only when there is one.
const withCleared = (state, cleared) => (cleared ? { ...state, cleared } : state);
// A clear mark { at, by } (stored, a peer's or made here), or null.
function cleanCleared(raw) {
  if (!isObject(raw)) return null;
  const at = time(raw.at);
  return at === null ? null : { at, by: typeof raw.by === 'string' && INSTANCE.test(raw.by) ? raw.by : '' };
}
// The live entries older than the clear become tombstones of the clear's version (see the head of this file). Pure and deterministic.
function applyClear(state) {
  const cleared = state.cleared;
  if (!cleared) return state;
  let recent = null;
  for (const [id, entry] of Object.entries(state.recent)) {
    if (entry.gone || entry.at >= cleared.at) continue;
    if (!recent) recent = { ...state.recent };
    recent[id] = { instance: entry.instance, task: entry.task, terminal: entry.terminal, title: '', agent: null, used: 0, gone: true, at: cleared.at, by: cleared.by };
  }
  return recent ? { ...state, recent } : state;
}

// The same FNV-1a pair as public/js/continue-drafts.js `draftKey`: the key name of the draft of a session identity.
function hash32(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const draftKey = id => `${DRAFT_PREFIX}${hash32(id, 0x811c9dc5)}${hash32(id, 0x01234567)}`;

// Where an identity is now: the moves followed (a task moved twice goes to its last place), or null when it did not move.
function movedTo(moves, instance, task) {
  let current = null;
  let key = `${instance}|${task}`;
  for (let hops = 0; hops < 8 && moves[key]; hops += 1) {
    current = { instance: moves[key].to_instance, task: moves[key].to_task };
    key = `${current.instance}|${current.task}`;
  }
  return current;
}

// What names a moved task re-pointed to its new place (see the head of this file). Pure and deterministic: the same on every side.
function repoint(state) {
  const moves = state.moves || {};
  if (!Object.keys(moves).length) return state;
  const recent = {};
  for (const id of Object.keys(state.recent).sort()) {
    const entry = state.recent[id];
    const to = movedTo(moves, entry.instance, entry.task);
    if (to && entry.gone) continue;
    const next = to ? { ...entry, instance: to.instance, task: to.task } : entry;
    const nextId = recentId(next);
    if (!recent[nextId] || later(next, recent[nextId])) recent[nextId] = next;
  }
  const keys = {};
  for (const name of Object.keys(state.keys).sort()) {
    const entry = state.keys[name];
    let nextName = name;
    let next = entry;
    if (name.startsWith(COLUMN_PREFIX) && typeof entry.value === 'string') {
      let shown = null;
      try { shown = JSON.parse(entry.value); } catch { shown = null; }
      const to = shown && isObject(shown) && movedTo(moves, shown.instance, shown.task);
      if (to) next = { ...entry, value: JSON.stringify({ instance: to.instance, task: to.task, terminal: shown.terminal }) };
    } else if (name.startsWith(DRAFT_PREFIX) && isObject(entry.value)) {
      const to = movedTo(moves, entry.value.instance, entry.value.task);
      if (to) {
        const value = { ...entry.value, instance: to.instance, task: to.task };
        next = { ...entry, value };
        nextName = draftKey(`${to.instance}|${to.task}|${value.terminal}`);
      }
    }
    if (!keys[nextName] || later(next, keys[nextName])) keys[nextName] = next;
  }
  return withCleared(withMoves({ recent, keys }, moves), state.cleared);
}

// A key's value, checked: any JSON of at most VALUE_MAX characters (null clears it). Throws for a value that is too large or not JSON.
function cleanValue(value) {
  if (value === undefined || value === null) return null;
  let text;
  try { text = JSON.stringify(value); } catch { text = undefined; }
  if (typeof text !== 'string' || text.length > VALUE_MAX) throw Object.assign(new Error('INVALID_PAGE_STATE'), { statusCode: 400 });
  return JSON.parse(text);
}
const validKeyName = name => typeof name === 'string' && KEY_NAME.test(name);
function cleanKey(raw) {
  if (!isObject(raw)) return null;
  const at = time(raw.at);
  if (at === null) return null;
  let value;
  try { value = cleanValue(raw.value); } catch { return null; }
  return { value, at, by: typeof raw.by === 'string' && INSTANCE.test(raw.by) ? raw.by : '' };
}

// A state read from the database or a peer: anything malformed is dropped.
function cleanState(raw) {
  const state = { recent: {}, keys: {} };
  if (!isObject(raw)) return state;
  const moves = {};
  for (const [id, value] of Object.entries(isObject(raw.moves) ? raw.moves : {}).slice(0, MOVES_MAX * 4)) {
    const move = MOVE_ID.test(id) ? cleanMove(value) : null;
    if (move && (!moves[id] || later(move, moves[id]))) moves[id] = move;
  }
  for (const value of Object.values(isObject(raw.recent) ? raw.recent : {}).slice(0, (RECENT_KEEP + GONE_MAX) * 4)) {
    const entry = cleanRecent(value);
    if (entry && (!state.recent[recentId(entry)] || later(entry, state.recent[recentId(entry)]))) state.recent[recentId(entry)] = entry;
  }
  for (const [name, value] of Object.entries(isObject(raw.keys) ? raw.keys : {}).slice(0, KEYS_MAX * 4)) {
    const entry = validKeyName(name) ? cleanKey(value) : null;
    if (entry) state.keys[name] = entry;
  }
  return withCleared(withMoves(state, moves), cleanCleared(raw.cleared));
}

// Whether version `a` beats `b` (both { at, by, ... }).
function later(a, b) {
  if (!b) return true;
  if (a.at !== b.at) return a.at > b.at;
  if (a.by !== b.by) return a.by > b.by;
  return stableJson(a) > stableJson(b);
}

// The newest time in a state (the hybrid clock moves past it).
function newestAt(state) {
  let newest = 0;
  for (const entry of Object.values(state.recent)) newest = Math.max(newest, entry.at);
  for (const entry of Object.values(state.keys)) newest = Math.max(newest, entry.at);
  for (const entry of Object.values(state.moves || {})) newest = Math.max(newest, entry.at);
  if (state.cleared) newest = Math.max(newest, state.cleared.at);
  return newest;
}

// The state cut to size: the RECENT_KEEP live entries used last (a tie by id), the tombstones of the last GONE_KEEP_MS (at most GONE_MAX, the newest),
// cleared keys of the last GONE_KEEP_MS, and at most KEYS_MAX keys (cleared ones go first, then the oldest). The clear mark stays (one value).
function trim(state, now) {
  const out = { recent: {}, keys: {} };
  const entries = Object.entries(state.recent);
  entries.filter(([, entry]) => !entry.gone).sort(([a, x], [b, y]) => (y.used - x.used) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, RECENT_KEEP)
    .forEach(([id, entry]) => { out.recent[id] = entry; });
  entries.filter(([, entry]) => entry.gone && entry.at >= now - GONE_KEEP_MS).sort(([a, x], [b, y]) => (y.at - x.at) || (a < b ? -1 : 1)).slice(0, GONE_MAX)
    .forEach(([id, entry]) => { out.recent[id] = entry; });
  const keys = Object.entries(state.keys).filter(([, entry]) => entry.value !== null || entry.at >= now - GONE_KEEP_MS);
  keys.sort(([a, x], [b, y]) => ((x.value === null) - (y.value === null)) || (y.at - x.at) || (a < b ? -1 : 1));
  for (const [name, entry] of keys.slice(0, KEYS_MAX)) out.keys[name] = entry;
  const moves = {};
  Object.entries(state.moves || {}).filter(([, move]) => move.at >= now - MOVES_KEEP_MS).sort(([a, x], [b, y]) => (y.at - x.at) || (a < b ? -1 : 1)).slice(0, MOVES_MAX)
    .forEach(([id, move]) => { moves[id] = move; });
  return withCleared(withMoves(out, moves), state.cleared);
}

// Two maps of times merged: every name with its later time (anything that is not such a map gives way to the other value).
const isTimes = value => isObject(value) && Object.values(value).every(inner => isObject(inner) && Object.values(inner).every(at => Number.isFinite(at)));
function mergeTimes(a, b) {
  if (!isTimes(a)) return isTimes(b) ? b : a;
  if (!isTimes(b)) return a;
  const out = {};
  for (const kind of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[kind] || {};
    const y = b[kind] || {};
    out[kind] = {};
    for (const name of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) out[kind][name] = Math.max(Number.isFinite(x[name]) ? x[name] : 0, Number.isFinite(y[name]) ? y[name] : 0);
  }
  return out;
}

// Both states merged and trimmed: { state, changed } (changed: the result differs from `local`).
function merge(local, incoming, now) {
  const mine = cleanState(local);
  const theirs = cleanState(incoming);
  const next = { recent: { ...mine.recent }, keys: { ...mine.keys }, moves: { ...(mine.moves || {}) } };
  for (const [id, move] of Object.entries(theirs.moves || {})) if (later(move, next.moves[id])) next.moves[id] = move;
  for (const [id, entry] of Object.entries(theirs.recent)) if (later(entry, next.recent[id])) next.recent[id] = entry;
  const cleared = theirs.cleared && (!mine.cleared || later(theirs.cleared, mine.cleared)) ? theirs.cleared : mine.cleared || null;
  for (const [name, entry] of Object.entries(theirs.keys)) {
    const mineNow = next.keys[name];
    const winner = later(entry, mineNow) ? entry : mineNow;
    next.keys[name] = TIME_MAPS.has(name) && mineNow ? { ...winner, value: mergeTimes(mineNow.value, entry.value) } : winner;
  }
  const state = trim(applyClear(repoint(withCleared(withMoves({ recent: next.recent, keys: next.keys }, next.moves), cleared))), now);
  return { state, changed: stableJson(state) !== stableJson(mine) };
}

// A page's change as a state of its own, every part with the version { at, by }: { recent: [change, ...], keys: { name: value | null }, clear?: true },
// and the same under `import` (what a browser kept before this feature, sent once: version time 0, so anything changed since wins over it). `clear`
// ("Clear list" of the Recent tab) is the clear mark with this version: every entry older than it goes, the entries sent with it (the current
// session, entries put back by Undo) have the same version and stay. Throws 400 INVALID_PAGE_STATE for a malformed body.
function changeState(body, { at, by }) {
  const bad = () => Object.assign(new Error('INVALID_PAGE_STATE'), { statusCode: 400 });
  if (!isObject(body)) throw bad();
  const state = { recent: {}, keys: {} };
  const add = (part, version) => {
    if (part === undefined || part === null) return;
    if (!isObject(part)) throw bad();
    const recent = part.recent === undefined ? [] : part.recent;
    const keys = part.keys === undefined ? {} : part.keys;
    if (!Array.isArray(recent) || recent.length > RECENT_KEEP * 4 || !isObject(keys) || Object.keys(keys).length > KEYS_MAX) throw bad();
    for (const raw of recent) {
      const change = cleanRecentChange(raw);
      if (!change) throw bad();
      const entry = { ...change, ...version };
      if (later(entry, state.recent[recentId(entry)])) state.recent[recentId(entry)] = entry;
    }
    for (const [name, value] of Object.entries(keys)) {
      if (!validKeyName(name)) throw bad();
      state.keys[name] = { value: cleanValue(value), ...version };
    }
  };
  if (body.clear !== undefined && typeof body.clear !== 'boolean') throw bad();
  add(body.import, { at: 0, by });
  add({ recent: body.recent, keys: body.keys }, { at, by });
  return body.clear === true ? withCleared(state, { at, by }) : state;
}

// A task moved to another engine as a state of its own (services/page-state.js `recordMove`): { from: { instance, task }, to: { instance, task },
// title }. Throws 400 INVALID_PAGE_STATE when malformed.
function moveState(move, { at, by }) {
  const from = isObject(move) && isObject(move.from) ? move.from : {};
  const id = `${from.instance}|${from.task}`;
  const value = cleanMove({ to_instance: move && move.to && move.to.instance, to_task: move && move.to && move.to.task, title: move && move.title, at, by });
  if (!MOVE_ID.test(id) || !value || id === `${value.to_instance}|${value.to_task}`) throw Object.assign(new Error('INVALID_PAGE_STATE'), { statusCode: 400 });
  return { recent: {}, keys: {}, moves: { [id]: value } };
}

// What the page reads: the live entries, used last first ({ instance, task, terminal, title, agent, used }), and every key with its value (null:
// cleared, so the page knows it was cleared and does not fall back to what the browser kept).
function pageView(state) {
  const clean = cleanState(state);
  const recent = Object.values(clean.recent).filter(entry => !entry.gone).sort((x, y) => (y.used - x.used) || (recentId(x) < recentId(y) ? -1 : 1))
    .map(({ instance, task, terminal, title, agent, used, ...rest }) => ({ instance, task, terminal, title, agent, used, ...seenOn(rest) }));
  const keys = {};
  for (const name of Object.keys(clean.keys).sort()) keys[name] = clean.keys[name].value;
  // The moves, newest first, so the page can re-point what it keeps in this browser only (the session this device opens at start).
  const moves = Object.entries(clean.moves || {}).sort(([a, x], [b, y]) => (y.at - x.at) || (a < b ? -1 : 1)).map(([id, move]) => {
    const cut = id.lastIndexOf('|');
    return { from: { instance: id.slice(0, cut), task: id.slice(cut + 1) }, to: { instance: move.to_instance, task: move.to_task }, title: move.title, at: move.at };
  });
  return { recent, keys, moves };
}

module.exports = {
  RECENT_KEEP, GONE_KEEP_MS, GONE_MAX, KEYS_MAX, VALUE_MAX, INSTANCE, MOVES_KEEP_MS, MOVES_MAX,
  stableJson, recentId, cleanState, cleanRecent, later, newestAt, trim, merge, changeState, moveState, pageView, repoint, movedTo, draftKey,
};
