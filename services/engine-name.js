// Engine names: one name per Engine, kept by that Engine. See "Engine names" in DESIGN.md.
//
// This side: the row `name` of the engine_identity key/value table (it already holds `instance_id`, so no schema change). No row means the default,
// config.engineName (ENGINE_NAME, otherwise the host name).
// A remote side: when its /v1/info has the capability `engine-name`, the name it reports is the name of its remote_servers row here, and of the link
// record when the row belongs to a service link. A remote without the capability keeps the row name its owner typed here.
const CAPABILITY = 'engine-name';
const MAX_LENGTH = 60;
const KEY = 'name';
// The ids of the remote_servers rows whose name comes from the Engine, so that `name_source` survives a restart. One system_state row, no schema change.
const SOURCES_KEY = 'remote_engine_names_v1';

const fault = (code, statusCode) => Object.assign(new Error(code), { statusCode });
// Control characters (C0, DEL, C1, which include every line break but two) and the Unicode line and paragraph separators.
const FORBIDDEN = /[\p{Cc}\u2028\u2029]/u;

// A trimmed name of 1 to 60 characters, or null for "the default". Throws 400 INVALID_ENGINE_NAME.
function parseEngineName(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw fault('INVALID_ENGINE_NAME', 400);
  const name = value.trim();
  if (!name) return null;
  if ([...name].length > MAX_LENGTH || FORBIDDEN.test(name)) throw fault('INVALID_ENGINE_NAME', 400);
  return name;
}

// The `name` of a request body. The field must be there: `{}` is a mistake, not a reset, which is `{ name: '' }` or `{ name: null }`.
function nameFromBody(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'name')) throw fault('INVALID_ENGINE_NAME', 400);
  return parseEngineName(body.name);
}

function defaultEngineName() {
  const config = require('../config'); // read here, so that only the routes and not a test of the remote side load the environment
  const value = typeof config.engineName === 'string' ? config.engineName.trim() : '';
  return value || 'T-Agent';
}

function storedEngineName(db) {
  const row = db.prepare('SELECT value FROM engine_identity WHERE key = ?').get(KEY);
  return row && row.value ? row.value : null;
}

function engineNameState(db) {
  const stored = storedEngineName(db);
  const defaultName = defaultEngineName();
  return { name: stored || defaultName, default_name: defaultName, custom: Boolean(stored) };
}

// `value` is what parseEngineName returned: a name, or null to go back to the default.
function setEngineName(db, value) {
  if (value === null) db.prepare('DELETE FROM engine_identity WHERE key = ?').run(KEY);
  else {
    db.prepare(`INSERT INTO engine_identity (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(KEY, value);
  }
  return engineNameState(db);
}

const hasCapability = info => Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(CAPABILITY));

// The name a remote reports in /v1/info, when it has the capability and the name passes the same rules as here; otherwise null.
function reportedName(info) {
  if (!hasCapability(info)) return null;
  try { return parseEngineName(info.name); } catch { return null; }
}

function engineNamedIds(db) {
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(SOURCES_KEY);
  if (!row) return new Set();
  try { return new Set((JSON.parse(row.value).ids || []).map(Number)); } catch { return new Set(); }
}

function saveEngineNamedIds(db, ids) {
  db.prepare(`INSERT INTO system_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(SOURCES_KEY, JSON.stringify({ ids: [...ids].sort((a, b) => a - b) }));
}

const nameSource = (serverId, named) => (named.has(Number(serverId)) ? 'engine' : 'local');

// After a successful read of /v1/info for the row `serverId`. An Engine with the capability names the row (and, through `renameLink`, the link
// record); one without it leaves the row name alone and makes the source local again, for example after a downgrade. An Engine with the
// capability whose name does not pass the rules here changes nothing.
function syncRemoteInfo(db, serverId, info, renameLink = () => {}) {
  const id = Number(serverId);
  const name = reportedName(info);
  const named = engineNamedIds(db);
  if (!name && hasCapability(info)) return null;
  if (name) {
    if (!named.has(id)) { named.add(id); saveEngineNamedIds(db, named); }
    db.prepare('UPDATE remote_servers SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND name <> ?').run(name, id, name);
    renameLink(id, name);
  } else if (named.delete(id)) {
    saveEngineNamedIds(db, named);
  }
  return name;
}

module.exports = {
  CAPABILITY, MAX_LENGTH, SOURCES_KEY,
  parseEngineName, nameFromBody, defaultEngineName, storedEngineName, engineNameState, setEngineName,
  hasCapability, reportedName, engineNamedIds, nameSource, syncRemoteInfo,
};
