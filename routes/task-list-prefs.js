const express = require('express');

// Which devices the task list leaves out ("Show in task list" in Settings "Engines"): GET -> { hidden: [sourceKey, ...] }, PUT { hidden: [...] } -> the same.
// Per service, so that the phone and the computer agree; display only: a hidden device stays connected, and its linked-service sharing keeps working.
// The value lives in `system_state` under one key, per owner; it is not `remote_servers.enabled`, and it may be set on a linked service, whose row is otherwise locked.

const STATE_KEY = 'task_list_hidden_devices_v1';
const MAX_HIDDEN = 200;
// `source.key` of the page (public/js/h5.js): 'local', or 'remote:<id of remote_servers>'.
const SOURCE_KEY = /^(?:local|remote:[1-9]\d*)$/;

// Every device of this owner, in the keys the page uses.
const devicesOf = (db, login) => ['local', ...db.prepare('SELECT id FROM remote_servers WHERE owner_id = ?').all(login).map(row => `remote:${row.id}`)];
function readAll(db) {
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
  try { const value = row ? JSON.parse(row.value) : {}; return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
// What is stored for an owner, without the devices that are gone. If that would hide everything (the last visible device was removed), nothing is hidden.
// Also read by the desktop window's merged T-Attention list (routes/attention-widget.js), which leaves out the same devices as the page.
function hiddenDevices(db, login) {
  const existing = devicesOf(db, login);
  const stored = readAll(db)[login];
  const hidden = (Array.isArray(stored) ? stored : []).filter(key => typeof key === 'string' && existing.includes(key));
  return existing.every(key => hidden.includes(key)) ? [] : hidden;
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
    const all = readAll(db);
    all[login] = hidden;
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify(all));
    res.json({ hidden });
  });
  return router;
}

module.exports = { createTaskListPrefsRouter, hiddenDevices, STATE_KEY };
