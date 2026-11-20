// What this engine last saw of each linked engine's task list (the answer of GET /api/remote-servers/:id/tasks that passed through it), so the page
// keeps listing that engine's tasks, dimmed and with their last known names, while it is offline, also after a reload ("Tasks of an offline engine"
// in docs/design/failover-and-one-login.md). Only what a row shows is kept: the task id, its name, its group (`status`) and its order in the group.
// Not a replication: no documents, sessions, files or activity, and nothing can be opened or changed from it.
//
// system_state `linked_last_tasks_v1` = { <remote_servers id>: { at, tasks: [{ id, title, status, sort_order }] } }. Written only when a list differs
// from the one kept (a poll that changes nothing writes nothing), rows of servers that are gone are dropped at the next write.
const STATE_KEY = 'linked_last_tasks_v1';
const MAX_TASKS = 500;

function createLinkedLastTasks({ db, now = Date.now }) {
  const lastWritten = new Map(); // server id -> the JSON of the tasks last kept (this process)
  function read() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    if (!row) return {};
    try { const value = JSON.parse(row.value); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  }
  const compact = list => (Array.isArray(list) ? list : []).filter(item => item && (typeof item.id === 'number' || typeof item.id === 'string')).slice(0, MAX_TASKS).map(item => ({
    id: item.id,
    title: typeof item.title === 'string' ? item.title.slice(0, 200) : String(item.id),
    status: typeof item.status === 'string' ? item.status.slice(0, 64) : null,
    sort_order: Number.isFinite(item.sort_order) ? item.sort_order : null,
  }));

  function remember(serverId, list) {
    const id = String(serverId);
    const tasks = compact(list);
    const text = JSON.stringify(tasks);
    if (lastWritten.get(id) === text) return false;
    const all = read();
    if (all[id] && JSON.stringify(all[id].tasks) === text) { lastWritten.set(id, text); return false; }
    all[id] = { at: new Date(now()).toISOString(), tasks };
    const servers = new Set(db.prepare('SELECT id FROM remote_servers').all().map(row => String(row.id)));
    for (const key of Object.keys(all)) if (!servers.has(key)) delete all[key];
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify(all));
    lastWritten.set(id, text);
    return true;
  }

  // { at, tasks } or null.
  function lastKnown(serverId) {
    const entry = read()[String(serverId)];
    return entry && Array.isArray(entry.tasks) ? { at: entry.at || null, tasks: compact(entry.tasks) } : null;
  }

  return { remember, lastKnown };
}

let singleton = null;
const getLinkedLastTasks = () => singleton || (singleton = createLinkedLastTasks({ db: require('../db') }));

module.exports = { createLinkedLastTasks, getLinkedLastTasks, STATE_KEY };
