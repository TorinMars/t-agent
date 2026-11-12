// "Agent sessions can use OSS with tcli" (on by default). One switch per Engine, in system_state:
//  - on: `tcli oss` in this Engine's terminals may list, read, write and delete objects of the bucket of "Image and file upload"
//    (the local relay /api/tcli/oss, routes/tcli.js), and a linked service may do the same through /v1/oss/files;
//  - off: both answer 403 OSS_AGENT_ACCESS_OFF. The browser upload of the page is not affected.
const KEY = 'oss_agent_access_v1';
const syncStore = require('./settings-sync-store');

function createOssAgentSettings({ db }) {
  function enabled() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(KEY);
    if (!row) return true;
    try {
      const stored = JSON.parse(row.value);
      return !(stored && stored.enabled === false);
    } catch { return true; }
  }
  function setEnabled(value) {
    if (typeof value !== 'boolean') {
      const error = new Error('VALIDATION_FAILED');
      error.statusCode = 400;
      throw error;
    }
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(KEY, JSON.stringify({ enabled: value }));
    syncStore.settingChanged(SYNC_GROUP);
    return { enabled: value };
  }
  return { enabled, setEnabled };
}

let shared = null;
function ossAgentSettings() {
  if (!shared) shared = createOssAgentSettings({ db: require('../db') });
  return shared;
}

// Settings sync across linked devices (services/settings-sync.js): { enabled } once the switch was set, else null (on by default).
const SYNC_GROUP = 'oss-agent-access';
function exportForSync({ db }) {
  const stored = syncStore.readState(db, KEY);
  return stored && typeof stored.enabled === 'boolean' ? { enabled: stored.enabled } : null;
}
function importFromSync({ db }, owner, value) {
  if (value !== null && !(syncStore.isPlainObject(value) && typeof value.enabled === 'boolean')) throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 });
  syncStore.writeState(db, KEY, value && { enabled: value.enabled });
}

module.exports = { SYNC_GROUP, exportForSync, importFromSync, createOssAgentSettings, ossAgentSettings, OSS_AGENT_ACCESS_KEY: KEY };
