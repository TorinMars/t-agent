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
const AGENTS = new Set(['claude', 'codex']);
const CLIENTS = new Set(['phone', 'computer', 'mac', 'home']);
const DEVICE = /^[a-z0-9]{8,32}$/;
// Keys whose value is a map of times ({ <kind>: { <name>: ms } }, the recency of saved commands): two versions are merged by the later time of each
// name, so two devices that used different commands at the same time keep both.
const TIME_MAPS = new Set(['ta-saved-commands-used']);

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
  for (const value of Object.values(isObject(raw.recent) ? raw.recent : {}).slice(0, (RECENT_KEEP + GONE_MAX) * 4)) {
    const entry = cleanRecent(value);
    if (entry && (!state.recent[recentId(entry)] || later(entry, state.recent[recentId(entry)]))) state.recent[recentId(entry)] = entry;
  }
  for (const [name, value] of Object.entries(isObject(raw.keys) ? raw.keys : {}).slice(0, KEYS_MAX * 4)) {
    const entry = validKeyName(name) ? cleanKey(value) : null;
    if (entry) state.keys[name] = entry;
  }
  return state;
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
  return newest;
}

// The state cut to size: the RECENT_KEEP live entries used last (a tie by id), the tombstones of the last GONE_KEEP_MS (at most GONE_MAX, the newest),
// cleared keys of the last GONE_KEEP_MS, and at most KEYS_MAX keys (cleared ones go first, then the oldest).
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
  return out;
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
  const next = { recent: { ...mine.recent }, keys: { ...mine.keys } };
  for (const [id, entry] of Object.entries(theirs.recent)) if (later(entry, next.recent[id])) next.recent[id] = entry;
  for (const [name, entry] of Object.entries(theirs.keys)) {
    const mineNow = next.keys[name];
    const winner = later(entry, mineNow) ? entry : mineNow;
    next.keys[name] = TIME_MAPS.has(name) && mineNow ? { ...winner, value: mergeTimes(mineNow.value, entry.value) } : winner;
  }
  const state = trim(next, now);
  return { state, changed: stableJson(state) !== stableJson(mine) };
}

// A page's change as a state of its own, every part with the version { at, by }: { recent: [change, ...], keys: { name: value | null } }, and the
// same under `import` (what a browser kept before this feature, sent once: version time 0, so anything changed since wins over it). Throws 400
// INVALID_PAGE_STATE for a malformed body.
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
  add(body.import, { at: 0, by });
  add({ recent: body.recent, keys: body.keys }, { at, by });
  return state;
}

// What the page reads: the live entries, used last first ({ instance, task, terminal, title, agent, used }), and every key with its value (null:
// cleared, so the page knows it was cleared and does not fall back to what the browser kept).
function pageView(state) {
  const clean = cleanState(state);
  const recent = Object.values(clean.recent).filter(entry => !entry.gone).sort((x, y) => (y.used - x.used) || (recentId(x) < recentId(y) ? -1 : 1))
    .map(({ instance, task, terminal, title, agent, used, ...rest }) => ({ instance, task, terminal, title, agent, used, ...seenOn(rest) }));
  const keys = {};
  for (const name of Object.keys(clean.keys).sort()) keys[name] = clean.keys[name].value;
  return { recent, keys };
}

module.exports = {
  RECENT_KEEP, GONE_KEEP_MS, GONE_MAX, KEYS_MAX, VALUE_MAX, INSTANCE,
  stableJson, recentId, cleanState, cleanRecent, later, newestAt, trim, merge, changeState, pageView,
};
