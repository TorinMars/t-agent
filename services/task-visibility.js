// Which linked services may see which task of this service. See "Per-task visibility" under "Service links" in DESIGN.md.
// system_state holds { "<task id>": ["<denied link id>", ...] }. A task with no entry is visible to every link, which is what makes a new link allowed by default.
// It is read on every /v1 task request, so the map lives in memory; every write goes to the database first and then replaces the map. One server owns a data folder.
//
// This is not a security boundary against a linked peer, which has full admin here (/v1/fs, a shell of another task, /v1/tokens).
const { getServiceLinks } = require('./service-links');

const STATE_KEY = 'task_link_visibility_v1';
const MAX_DENIED = 200;
// What a hidden task id is replaced with. AUTOINCREMENT ids start at 1, so no row has it and the route's own "no such task" path gives the answer.
const MISSING_TASK_ID = -1;
const NOTHING_HIDDEN = () => false;

const fault = (code, statusCode) => Object.assign(new Error(code), { statusCode });

function createTaskVisibility({ db, serviceLinks }) {
  let map = null; // task id (number) -> Set of denied link ids
  const open = new Set(); // what a link has open now: { linkId, taskId (null: any task of the link), close }

  const serialize = value => JSON.stringify(Object.fromEntries([...value].map(([taskId, links]) => [taskId, [...links]])));

  function commit(next) {
    db.prepare(`INSERT INTO system_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, serialize(next));
    map = next;
  }

  // First use. A task or link that went away while the entry was kept (an older backup, a crash between two writes) is dropped here.
  function state() {
    if (map) return map;
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    const tasks = new Set(db.prepare('SELECT id FROM tasks').all().map(task => task.id));
    const links = new Set(serviceLinks.ids());
    const loaded = new Map();
    for (const [key, denied] of Object.entries(row ? JSON.parse(row.value) : {})) {
      const kept = denied.filter(id => links.has(id));
      if (tasks.has(Number(key)) && kept.length) loaded.set(Number(key), new Set(kept));
    }
    if (row && serialize(loaded) !== row.value) commit(loaded);
    else map = loaded;
    return map;
  }

  function closeOpen(linkId, taskId) {
    for (const entry of [...open]) {
      if (entry.linkId !== linkId || (entry.taskId !== null && entry.taskId !== taskId)) continue;
      open.delete(entry);
      try { entry.close(); } catch { /* one that fails must not keep the others open */ }
    }
  }

  const isDenied = (taskId, linkId) => {
    const links = state().get(Number(taskId));
    return Boolean(links && linkId && links.has(linkId));
  };
  const hiddenFrom = linkId => (linkId ? taskId => isDenied(taskId, linkId) : NOTHING_HIDDEN);

  // The task row a value from a request names, resolved by SQLite as the routes resolve it: a column of INTEGER affinity also matches '05', '5.0' and ' 5'.
  function taskIdOf(value) {
    try {
      const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(value);
      return row ? row.id : null;
    } catch { return null; } // a value that cannot be bound: the route refuses it itself
  }

  function setDenied(ownerId, taskId, denied) {
    const known = new Set(serviceLinks.list(ownerId).map(link => link.id));
    if (!Array.isArray(denied) || denied.length > MAX_DENIED || denied.some(id => typeof id !== 'string' || !known.has(id))) throw fault('INVALID_VISIBILITY', 400);
    const id = Number(taskId);
    const before = state().get(id) || new Set();
    const after = new Set(denied);
    const next = new Map(state());
    if (after.size) next.set(id, after);
    else next.delete(id);
    commit(next);
    // After the commit, so that a reconnect is already refused.
    for (const linkId of after) if (!before.has(linkId)) closeOpen(linkId, id);
  }

  function forgetTask(taskId) {
    const id = Number(taskId);
    if (!state().has(id)) return;
    const next = new Map(state());
    next.delete(id);
    commit(next);
  }

  function forgetLink(linkId) {
    if (![...state().values()].some(links => links.has(linkId))) return;
    const next = new Map();
    for (const [taskId, links] of state()) {
      const kept = new Set([...links].filter(id => id !== linkId));
      if (kept.size) next.set(taskId, kept);
    }
    commit(next);
  }

  // A removed link's id is never used again, so its entries are only clutter. Other changes of the link (presence, revoked) keep them.
  serviceLinks.onChange(id => { if (!serviceLinks.ids().includes(id)) forgetLink(id); });

  return {
    isDenied, hiddenFrom, taskIdOf, setDenied, forgetTask, forgetLink,
    // The one filter for lists: items of tasks this link may not see are left out. Without a link (any other token) the list is unchanged.
    visible(linkId, items, idOf = item => item) {
      if (!linkId) return items;
      return items.filter(item => !isDenied(idOf(item), linkId));
    },
    // How many tasks of each status this link may not see, for the group counts.
    hiddenStatusCounts(linkId) {
      const counts = new Map();
      for (const [taskId, links] of state()) {
        if (!linkId || !links.has(linkId)) continue;
        const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
        if (row) counts.set(row.status, (counts.get(row.status) || 0) + 1);
      }
      return counts;
    },
    // Registers something a link has open; `close` runs at the moment the link loses the task (taskId null: any task of the link). Returns the function that ends the tracking.
    track(linkId, taskId, close) {
      const entry = { linkId, taskId: taskId === null ? null : Number(taskId), close };
      open.add(entry);
      return () => open.delete(entry);
    },
    // For the page: never a token or an address. Oldest link first; a revoked link is gone from the list as it can no longer see anything.
    devices(ownerId, taskId) {
      return serviceLinks.list(ownerId)
        .filter(link => link.state !== 'revoked')
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .map(link => ({ link_id: link.id, name: link.name, online: link.online, allowed: !isDenied(taskId, link.id) }));
    },
  };
}

let singleton = null;
function getTaskVisibility() {
  if (!singleton) singleton = createTaskVisibility({ db: require('../db'), serviceLinks: getServiceLinks() });
  return singleton;
}

module.exports = { createTaskVisibility, getTaskVisibility, STATE_KEY, MAX_DENIED, MISSING_TASK_ID };
