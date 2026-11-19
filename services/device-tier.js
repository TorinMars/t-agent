// The "Company computer" flag of this machine ("Company computer" in docs/design/learn-english.md, "Device tier" in
// docs/design/linked-device-settings.md). A machine marked so keeps none of the person's own data for long: the English learning data lives on the
// normal machines it is linked to, and the company computer keeps only a cache of the cards and the answers that wait for a normal machine.
// Shared settings (translator, voice, OSS, the site library) are not affected.
//
// - Stored on the machine itself, never synced: system_state `device_tier_v1` { company: true }; no row is the default (a normal machine).
// - Told to the peers in GET /v1/info (`company_computer`, capability `device:tier`), and readable and changeable from a linked device's page through
//   /v1/device-settings/device-tier (routes/device-settings.js), like the other per-device settings.
const STATE_KEY = 'device_tier_v1';
const CAPABILITY = 'device:tier';
const listeners = new Set();

function createDeviceTier({ db }) {
  function read() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    if (!row) return false;
    try { return JSON.parse(row.value).company === true; } catch { return false; }
  }
  function write(company) {
    if (typeof company !== 'boolean') throw Object.assign(new Error('company_computer must be true or false'), { statusCode: 400, code: 'VALIDATION_FAILED' });
    const before = read();
    if (company) {
      db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify({ company: true }));
    } else db.prepare('DELETE FROM system_state WHERE key = ?').run(STATE_KEY);
    if (before !== company) for (const listener of listeners) { try { listener(company, db); } catch { /* a listener looks again on its next round */ } }
    return company;
  }
  return { isCompany: read, setCompany: write };
}

// A change of the flag on any machine of this process (one in production; tests may have several databases).
function onTierChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let singleton = null;
const getDeviceTier = () => singleton || (singleton = createDeviceTier({ db: require('../db') }));

module.exports = { createDeviceTier, getDeviceTier, onTierChange, STATE_KEY, CAPABILITY };
