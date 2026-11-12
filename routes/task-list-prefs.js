const express = require('express');
const syncStore = require('../services/settings-sync-store');

// Which devices the task list leaves out ("Show in task list" in Settings "Engines"): GET -> { hidden: [sourceKey, ...] }, PUT { hidden: [...] } -> the same.
// Per service, so that the phone and the computer agree; display only: a hidden device stays connected, and its linked-service sharing keeps working.
// The value lives in `system_state` under one key, per owner; it is not `remote_servers.enabled`, and it may be set on a linked service, whose row is otherwise locked.
//
// Linked devices keep one list (services/settings-sync.js, group `task-list-devices`). A source key is machine-relative (`remote:7` here is another row
// on the peer), so the shared list is one of Engine instance ids: this device is its own instance id, a remote row the id its /v1/info reports or its link
// record holds. It is stored beside the keys, in `task_list_hidden_instances_v1` ({ "<login>": [instance id, ...] }), and kept whole, ids of devices
// this machine does not know included, so a list made elsewhere is not cut down here. The list a page gets is the keys of devices whose instance id is
// unknown (they stay on this device only) plus the devices the shared ids map to.

const STATE_KEY = 'task_list_hidden_devices_v1';
const INSTANCES_KEY = 'task_list_hidden_instances_v1';
const SYNC_GROUP = 'task-list-devices';
const MAX_HIDDEN = 200;
// `source.key` of the page (public/js/h5.js): 'local', or 'remote:<id of remote_servers>'.
const SOURCE_KEY = /^(?:local|remote:[1-9]\d*)$/;
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;

// Every device of this owner, in the keys the page uses.
const devicesOf = (db, login) => ['local', ...db.prepare('SELECT id FROM remote_servers WHERE owner_id = ?').all(login).map(row => `remote:${row.id}`)];
function readAll(db, key = STATE_KEY) {
  const value = syncStore.readState(db, key);
  return syncStore.isPlainObject(value) ? value : {};
}
const writeAll = (db, key, all) => syncStore.writeState(db, key, all);
const keysOf = value => (Array.isArray(value) ? value.filter(key => typeof key === 'string' && SOURCE_KEY.test(key)) : []);

// This Engine's own instance id (engine_identity), or null in a database without it.
function ownInstanceId(db) {
  try { const row = db.prepare("SELECT value FROM engine_identity WHERE key = 'instance_id'").get(); return row ? row.value : null; } catch { return null; }
}
// source key -> instance id, for the devices of this owner whose id is known (services/engine-name.js, then the link record of a service link).
function instanceMap(db, login) {
  const { remoteInstanceIds } = require('../services/engine-name');
  const reported = remoteInstanceIds(db);
  const links = (() => { const value = syncStore.readState(db, 'service_links_v1'); return value && Array.isArray(value.links) ? value.links : []; })();
  const map = new Map();
  const own = ownInstanceId(db);
  if (own) map.set('local', own);
  for (const key of devicesOf(db, login)) {
    if (key === 'local') continue;
    const id = Number(key.slice('remote:'.length));
    const link = links.find(entry => entry.remote_server_id === id);
    const instance = reported.get(id) || (link && link.peer_instance_id) || null;
    if (typeof instance === 'string' && INSTANCE_ID.test(instance)) map.set(key, instance);
  }
  return map;
}
// The shared list of this owner: what is stored, or (before the first save with this version) the ids of the stored keys.
function sharedIds(db, login, map = instanceMap(db, login)) {
  const stored = readAll(db, INSTANCES_KEY)[login];
  if (Array.isArray(stored)) return [...new Set(stored.filter(id => typeof id === 'string' && INSTANCE_ID.test(id)))].sort();
  return [...new Set(keysOf(readAll(db)[login]).map(key => map.get(key)).filter(Boolean))].sort();
}

// What is stored for an owner, without the devices that are gone. If that would hide everything (the last visible device was removed), nothing is hidden.
// Also read by the desktop window's merged T-Attention list (routes/attention-widget.js), which leaves out the same devices as the page.
function hiddenDevices(db, login) {
  const existing = devicesOf(db, login);
  const map = instanceMap(db, login);
  const ids = new Set(sharedIds(db, login, map));
  const local = keysOf(readAll(db)[login]).filter(key => !map.has(key)); // a device without a known instance id is kept here only
  const hidden = existing.filter(key => local.includes(key) || (map.has(key) && ids.has(map.get(key))));
  return existing.every(key => hidden.includes(key)) ? [] : hidden;
}

// A list the page saved: the keys of devices without a known instance id stay here, the others become the shared ids, together with the shared ids
// of devices this machine does not have.
function saveHidden(db, login, hidden) {
  const map = instanceMap(db, login);
  const mapped = new Set(map.values());
  const ids = [...new Set([...hidden.filter(key => map.has(key)).map(key => map.get(key)), ...sharedIds(db, login, map).filter(id => !mapped.has(id))])].sort();
  const all = readAll(db);
  all[login] = hidden.filter(key => !map.has(key));
  const instances = readAll(db, INSTANCES_KEY);
  instances[login] = ids;
  db.transaction(() => { writeAll(db, STATE_KEY, all); writeAll(db, INSTANCES_KEY, instances); })();
}

// Settings sync: the shared ids, sorted, or null when none is hidden.
function exportForSync({ db }, login) {
  const ids = sharedIds(db, login);
  return ids.length ? ids : null;
}
function importFromSync({ db }, login, value) {
  if (value !== null && !(Array.isArray(value) && value.length <= MAX_HIDDEN && value.every(id => typeof id === 'string' && INSTANCE_ID.test(id)))) {
    throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 });
  }
  const map = instanceMap(db, login);
  const all = readAll(db);
  all[login] = keysOf(all[login]).filter(key => !map.has(key));
  const instances = readAll(db, INSTANCES_KEY);
  instances[login] = [...new Set(value || [])].sort();
  db.transaction(() => { writeAll(db, STATE_KEY, all); writeAll(db, INSTANCES_KEY, instances); })();
}

function createTaskListPrefsRouter({ db = require('../db'), requireAuth = require('../middleware/auth') } = {}) {
  const router = express.Router();
  router.use(requireAuth);
  const owner = req => req.session.user.login;

  router.get('/', (req, res) => {
    res.json({ hidden: hiddenDevices(db, owner(req)) });
  });

  router.put('/', (req, res) => {
    const list = req.body && req.body.hidden;
    if (!Array.isArray(list) || list.length > MAX_HIDDEN || !list.every(key => typeof key === 'string' && SOURCE_KEY.test(key))) return res.status(400).json({ error: 'INVALID_HIDDEN_DEVICES' });
    const login = owner(req);
    const existing = devicesOf(db, login);
    const hidden = [...new Set(list)].filter(key => existing.includes(key)); // an entry of a device that was removed is dropped here
    if (existing.every(key => hidden.includes(key))) return res.status(400).json({ error: 'LAST_DEVICE_VISIBLE' });
    saveHidden(db, login, hidden);
    syncStore.settingChanged(SYNC_GROUP);
    res.json({ hidden });
  });
  return router;
}

module.exports = { createTaskListPrefsRouter, hiddenDevices, exportForSync, importFromSync, SYNC_GROUP, STATE_KEY, INSTANCES_KEY };
