// "Agent sessions can use OSS with tcli" (on by default). One switch per Engine, in system_state:
//  - on: `tcli oss` in this Engine's terminals may list, read, write and delete objects of the bucket of "Image and file upload"
//    (the local relay /api/tcli/oss, routes/tcli.js), and a linked service may do the same through /v1/oss/files;
//  - off: both answer 403 OSS_AGENT_ACCESS_OFF. The browser upload of the page is not affected.
const KEY = 'oss_agent_access_v1';

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
    return { enabled: value };
  }
  return { enabled, setEnabled };
}

let shared = null;
function ossAgentSettings() {
  if (!shared) shared = createOssAgentSettings({ db: require('../db') });
  return shared;
}

module.exports = { createOssAgentSettings, ossAgentSettings, OSS_AGENT_ACCESS_KEY: KEY };
