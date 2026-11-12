// "Linked sessions can read the files of linked engines" (on by default). One switch per Engine, in system_state:
//  - on: the Claude / Codex sessions this Engine starts get the read-only `t-agent-peers` MCP tools, and linked
//    engines may read this Engine's files through /v1/peer-fs (home folder only, sensitive files left out);
//  - off: neither.
// Shared by the peer-fs routes (services/peer-fs.js, routes/peer-fs.js) and the terminal launch (routes/terminal.js).
const KEY = 'peer_fs_v1';

function createPeerFsSettings({ db }) {
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
function peerFsSettings() {
  if (!shared) shared = createPeerFsSettings({ db: require('../db') });
  return shared;
}

module.exports = { createPeerFsSettings, peerFsSettings, PEER_FS_KEY: KEY };
