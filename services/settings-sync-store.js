// Small pieces shared by the settings that linked devices keep as one set (services/settings-sync.js). See "Settings sync across linked devices" in
// DESIGN.md.
//
// - settingChanged(group) is called by the save paths of the synced settings (translator, voice input, OSS, T-Attention ...) after a local change.
//   It only says "look again": services/settings-sync.js compares a hash of the stored value, so a call without a real change does nothing.
//   A value written by the sync itself (importFromSync) never calls it.
// - readState / writeState are the system_state rows behind those settings, plain or encrypted with the session secret (lib/token-crypto.js).
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const listeners = new Set();

function settingChanged(group) {
  for (const listener of listeners) {
    try { listener(group); } catch { /* the next sync round compares the hashes again */ }
  }
}

function onSettingChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The stored JSON value of one system_state row, or null when there is none or it cannot be read. `secret`: the row is encrypted.
function readState(db, key, secret = null) {
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(secret ? decryptToken(row.value, secret) : row.value); } catch { return null; }
}

// Writes the JSON value, or removes the row for null.
function writeState(db, key, value, secret = null) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM system_state WHERE key = ?').run(key);
    return;
  }
  const text = JSON.stringify(value);
  db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, secret ? encryptToken(text, secret) : text);
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// A value received from a peer must be a plain object, or null. Throws INVALID_SYNC_VALUE.
function objectOrNull(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 });
  return value;
}

module.exports = { settingChanged, onSettingChanged, readState, writeState, isPlainObject, objectOrNull };
