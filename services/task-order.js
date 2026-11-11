// The shared task order: one list of task keys that every browser of this service and every linked service shows in the same order. See "Shared task
// order" in DESIGN.md.
//
// A key is `<instance id>:<task id>`, the instance id being the Engine's own identity (engine_identity `instance_id`), because a remote row's id differs
// between machines. Stored per owner in one system_state row, `task_order_v1`: { "<login>": { order: [key, ...], updated_at } }, `updated_at` in
// milliseconds. Keys of tasks this service cannot see stay in the list, so an order made elsewhere is not lost.
//
// Linked services keep the newest list (last writer wins on `updated_at`): a local change is pushed to every online peer at once, and a peer that comes
// online, and every peer every few minutes, is read and the newer list kept, ours being pushed when it is the newer one. A peer's PUT is never forwarded,
// so there is no loop.
const STATE_KEY = 'task_order_v1';
const MAX_KEYS = 5000;
const KEY = /^[A-Za-z0-9-]{1,64}:\d{1,12}$/;
const ROUTE = '/v1/task-order';
const PUSH_TIMEOUT_MS = 5000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const fault = (code, statusCode) => Object.assign(new Error(code), { statusCode });

// A list of valid keys, de-duplicated keeping the first. Throws 400 INVALID_TASK_ORDER.
function parseOrder(value) {
  if (!Array.isArray(value) || value.length > MAX_KEYS * 2) throw fault('INVALID_TASK_ORDER', 400);
  if (!value.every(key => typeof key === 'string' && KEY.test(key))) throw fault('INVALID_TASK_ORDER', 400);
  const order = [...new Set(value)];
  if (order.length > MAX_KEYS) throw fault('INVALID_TASK_ORDER', 400);
  return order;
}

// `primary` decides the order of its own keys. The keys of `previous` that it does not have are kept after the key that came before them in `previous`
// (at the start when none did), so a list made by someone who could not see every task leaves the others where they were. Over the cap, kept keys are
// dropped from the end, where the oldest tasks are.
function mergeOrder(primary, previous) {
  const present = new Set(primary);
  const after = new Map();
  let anchor = null;
  let carried = 0;
  for (const key of previous) {
    if (present.has(key)) { anchor = key; continue; }
    if (!after.has(anchor)) after.set(anchor, []);
    after.get(anchor).push(key);
    carried += 1;
  }
  const result = [...(after.get(null) || [])];
  for (const key of primary) result.push(key, ...(after.get(key) || []));
  let excess = result.length - MAX_KEYS;
  if (excess <= 0 || !carried) return result;
  for (let index = result.length - 1; index >= 0 && excess > 0; index -= 1) {
    if (!present.has(result[index])) { result.splice(index, 1); excess -= 1; }
  }
  return result;
}

function createTaskOrder({ db, serviceLinks = null, request = null, owner = () => null, now = Date.now, log = console, intervalMs = SYNC_INTERVAL_MS }) {
  let timer = null;
  let unsubscribe = null;
  const syncing = new Map(); // link id -> the sync running for it

  function readAll() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    try { const value = row ? JSON.parse(row.value) : {}; return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  }
  function get(login) {
    const stored = readAll()[login];
    if (!stored || !Array.isArray(stored.order)) return { order: [], updated_at: 0 };
    return { order: stored.order.filter(key => typeof key === 'string' && KEY.test(key)), updated_at: Number.isSafeInteger(stored.updated_at) ? stored.updated_at : 0 };
  }
  function save(login, value) {
    const all = readAll();
    all[login] = value;
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify(all));
    return value;
  }

  // A list from a peer, or a peer's answer. Stored only when it is newer than ours; the answer is what is stored either way.
  function accept(login, body) {
    const given = body && typeof body === 'object' ? body : {};
    const order = parseOrder(given.order);
    if (!Number.isSafeInteger(given.updated_at) || given.updated_at < 0) throw fault('INVALID_TASK_ORDER', 400);
    const current = get(login);
    if (given.updated_at <= current.updated_at) return current;
    return save(login, { order: mergeOrder(order, current.order), updated_at: given.updated_at });
  }

  const onlinePeers = () => {
    if (!serviceLinks || !request) return [];
    try { return serviceLinks.peers().filter(peer => peer.online); } catch { return []; }
  };

  // Our list to one peer. Its answer is its stored list, which we keep when it is the newer one. Never rejects.
  async function pushTo(peer, login, value) {
    try {
      const answer = await request(peer.baseUrl, ROUTE, peer.token, { method: 'PUT', body: value, timeoutMs: PUSH_TIMEOUT_MS });
      accept(login, answer);
    } catch (error) {
      if (error && error.statusCode === 401 && typeof serviceLinks.noteUnauthorized === 'function') {
        try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* the next call tries again */ }
      }
    }
  }

  // A change made here: stored now, sent to every online peer after the answer.
  function setLocal(login, list) {
    const order = parseOrder(list);
    const current = get(login);
    const value = save(login, { order: mergeOrder(order, current.order), updated_at: Math.max(now(), current.updated_at + 1) });
    const peers = onlinePeers();
    if (peers.length) setImmediate(() => { for (const peer of peers) pushTo(peer, login, value); });
    return value;
  }

  // Read one peer's list and keep the newer one; push ours when ours is newer. One at a time per link. Never rejects.
  function syncPeer(peer) {
    if (syncing.has(peer.id)) return syncing.get(peer.id);
    const work = (async () => {
      const login = owner();
      if (!login) return;
      let theirs;
      try { theirs = await request(peer.baseUrl, ROUTE, peer.token, { timeoutMs: PUSH_TIMEOUT_MS }); }
      catch { return; } // an older peer has no route; an offline one is tried again later
      let ours;
      try { ours = accept(login, theirs); } catch { return; }
      if (ours.updated_at > (Number.isSafeInteger(theirs && theirs.updated_at) ? theirs.updated_at : -1)) await pushTo(peer, login, ours);
    })().catch(error => log.error('[task-order] sync failed:', error && error.message)).finally(() => syncing.delete(peer.id));
    syncing.set(peer.id, work);
    return work;
  }

  const syncAll = () => Promise.all(onlinePeers().map(syncPeer));

  function start() {
    if (!serviceLinks || !request || unsubscribe) return;
    // A link that comes online (or changes in any way while online) is read at once.
    unsubscribe = serviceLinks.onChange(id => {
      const peer = onlinePeers().find(candidate => candidate.id === id);
      if (peer) syncPeer(peer);
    });
    if (intervalMs > 0) {
      timer = setInterval(syncAll, intervalMs);
      if (timer.unref) timer.unref();
    }
  }
  function stop() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { get, setLocal, accept, syncPeer, syncAll, start, stop };
}

let singleton = null;
function getTaskOrder() {
  if (singleton) return singleton;
  singleton = createTaskOrder({
    db: require('../db'),
    serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
    // The account a browser session gets (middleware/auth.js), as in routes/linked-services.js: a peer's token has no owner of its own here.
    owner: () => require('./single-user').ensureSingleUser().login,
  });
  return singleton;
}

module.exports = { createTaskOrder, getTaskOrder, parseOrder, mergeOrder, STATE_KEY, MAX_KEYS, KEY, PUSH_TIMEOUT_MS, SYNC_INTERVAL_MS };
