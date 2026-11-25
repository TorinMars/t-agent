// The access log ("Access log" in docs/design/access-log.md): which devices use this server, from which address, and the sign-ins, so the person
// can spot use that is not theirs, get an alert in T-Attention and sign a device out. Kept on this machine only (tables access_devices,
// access_device_ips and access_events, schema 27); a company computer or another engine keeps its own. Only the switch "Alert me about new
// devices" is shared (settings sync group access-alerts).
//
// A device is the random id a browser sends in X-TA-Device (public/js/local-keys.js `ta-device-id`; `device` in the query of a terminal websocket).
// It is a label, never a credential: anyone can send any id. What signs a device out is its login sessions, which are tied to the id at login
// (`session.access` = { deviceId, boundAt }) and deleted by `revoke`.
//
// Not every request is written: a device's row is touched at most once per 10 minutes for the same address, and events are written only for the
// kinds below. Nothing of a request body, no token, code, terminal text or raw User-Agent is stored (the name is derived from it once).
const { clientAddress, isLoopback, networkOf, isLoopbackHost } = require('../lib/client-ip');
const { readState, writeState, isPlainObject, settingChanged } = require('./settings-sync-store');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RETENTION_DAYS = 90;
const TOUCH_MS = 10 * MINUTE;
const ALERT_GAP_MS = HOUR;
const FAILED_WINDOW_MS = 10 * MINUTE;
const FAILED_LIMIT = 5;
const MAX_IPS_PER_DEVICE = 50;
const KINDS = Object.freeze(['login_ok', 'login_failed', 'new_device', 'new_ip', 'revoked', 'blocked']);
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ALERTS_KEY = 'access_alerts_v1'; // { enabled } (settings sync group access-alerts), on by default
const ALERTS_GROUP = 'access-alerts';
const STATE_KEY = 'access_log_v1'; // { started_at }: when this machine's access log started (sessions signed in before it are learned silently)
const SOURCE = 'access-log';
const NAME_MAX = 60;

const fault = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });

// The device id of a request: the X-TA-Device header, or `device` in the query (a websocket cannot send headers). null when missing or malformed.
function deviceIdOf(req) {
  const header = req && req.headers && req.headers['x-ta-device'];
  let value = Array.isArray(header) ? header[0] : header;
  if (!value && req && req.url) {
    try { value = new URL(req.url, 'http://device.local').searchParams.get('device'); } catch { value = null; }
  }
  return typeof value === 'string' && DEVICE_ID.test(value) ? value : null;
}

// A one-line name from the User-Agent ("iPhone · Safari", "Mac · Chrome", "T-Agent Mac App"); the User-Agent itself is never kept.
function deviceName(userAgent) {
  const ua = String(userAgent || '').slice(0, 512);
  if (/T-AgentApp\//.test(ua)) return 'T-Agent Mac App';
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg(?:e|A|iOS)?\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /CriOS\/|Chrome\/|Chromium\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /^curl\//.test(ua) ? 'curl' : '';
  if (system && browser) return `${system} · ${browser}`;
  return system || browser || 'Unknown device';
}

const oneLine = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function createAccessLog({ db, now = Date.now, attention = () => null, mode = () => 'remote', trusted = () => false, endSession = () => {}, log = console } = {}) {
  const touched = new Map(); // `${device}|${ip}` → when the row was last written (the 10-minute throttle)
  const burstAlerts = new Map(); // ip → when the last "wrong codes" alert was raised

  const select = db.prepare('SELECT * FROM access_devices WHERE device_id = ?');
  const insertEvent = db.prepare('INSERT INTO access_events (at, device_id, ip, kind, detail) VALUES (?, ?, ?, ?, ?)');
  const selectRevoked = db.prepare('SELECT revoked_at FROM access_devices WHERE device_id = ?'); // read on every signed-in request

  function startedAt() {
    const stored = readState(db, STATE_KEY);
    if (isPlainObject(stored) && Number.isFinite(stored.started_at)) return stored.started_at;
    const at = now();
    writeState(db, STATE_KEY, { started_at: at });
    return at;
  }
  startedAt();

  function event(kind, { deviceId = '', ip = '', detail = '' } = {}) {
    if (!KINDS.includes(kind)) throw new Error(`unknown access event ${kind}`);
    return Number(insertEvent.run(now(), deviceId || '', ip || '', kind, oneLine(detail, 160)).lastInsertRowid);
  }

  // ---- The switch "Alert me about new devices" ----
  function alertsEnabled() {
    const stored = readState(db, ALERTS_KEY);
    return !(isPlainObject(stored) && stored.enabled === false);
  }
  function setAlertsEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw fault('ACCESS_SETTINGS_INVALID', 'access_alerts must be true or false.', 400);
    writeState(db, ALERTS_KEY, { enabled });
    settingChanged(ALERTS_GROUP);
    return enabled;
  }

  // ---- Alerts (T-Attention items) ----
  function raise(title, notes) {
    const service = attention();
    if (!service) return null;
    try {
      const item = service.create({ title: oneLine(title, 200), notes, status: 'waiting_user', source: SOURCE, attention_reason: 'Check whether this sign-in was you' }, { actor: SOURCE, defaultSource: SOURCE });
      return item ? item.id : null;
    } catch (error) {
      log.warn(`Access log: could not add the alert (${error.message})`);
      return null;
    }
  }
  const NOTES = 'If it was you, mark this task done, or press "It was me" in Settings → Account and access → Devices and sign-ins.\n'
    + 'If it was not, sign the device out there and replace the authenticator.';
  function alertDevice(row, title) {
    if (mode() !== 'remote' || !alertsEnabled()) return false;
    if (row.alerted_at && now() - row.alerted_at < ALERT_GAP_MS) return false;
    const id = raise(title, NOTES);
    db.prepare('UPDATE access_devices SET alerted_at = ?, attention_id = COALESCE(?, attention_id) WHERE device_id = ?').run(now(), id, row.device_id);
    return true;
  }

  // ---- Seeing a device ----
  // A request (or a login) of `deviceId` from `ip`. `carried`: a session signed in before the access log started, learned without an alert; `force`:
  // write even within the 10 minutes (a login). Returns what happened: { created, newIp, alerted } or { throttled: true }.
  function seen({ deviceId, ip, userAgent = '', carried = false, force = false }) {
    if (!deviceId || !DEVICE_ID.test(deviceId)) return { skipped: true };
    const address = ip || 'unknown';
    const key = `${deviceId}|${address}`;
    const at = now();
    if (!force && touched.has(key) && at - touched.get(key) < TOUCH_MS) return { throttled: true };
    touched.set(key, at);
    if (touched.size > 2000) touched.delete(touched.keys().next().value);
    const row = select.get(deviceId);
    if (!row) {
      const first = !db.prepare('SELECT 1 FROM access_devices LIMIT 1').get();
      const silent = first || carried || mode() !== 'remote';
      db.transaction(() => {
        db.prepare('INSERT INTO access_devices (device_id, name, first_seen, last_seen, last_ip, confirmed) VALUES (?, ?, ?, ?, ?, ?)')
          .run(deviceId, deviceName(userAgent), at, at, address, silent ? 1 : 0);
        db.prepare('INSERT OR IGNORE INTO access_device_ips (device_id, ip, first_seen, last_seen) VALUES (?, ?, ?, ?)').run(deviceId, address, at, at);
        event('new_device', { deviceId, ip: address, detail: first ? 'The first device: learned without an alert' : carried ? 'Signed in before the access log started: learned without an alert' : '' });
      })();
      const created = select.get(deviceId);
      const alerted = silent ? false : alertDevice(created, `New device signed in: ${created.name}, IP ${address}. Was it you?`);
      return { created: true, newIp: false, alerted };
    }
    const known = db.prepare('SELECT ip FROM access_device_ips WHERE device_id = ?').all(deviceId).map(entry => entry.ip);
    let alerted = false;
    const newIp = !known.includes(address);
    db.transaction(() => {
      if (newIp) {
        db.prepare('INSERT INTO access_device_ips (device_id, ip, first_seen, last_seen) VALUES (?, ?, ?, ?)').run(deviceId, address, at, at);
        event('new_ip', { deviceId, ip: address });
        // Only the newest addresses are kept per device.
        db.prepare(`DELETE FROM access_device_ips WHERE device_id = ? AND ip NOT IN (
          SELECT ip FROM access_device_ips WHERE device_id = ? ORDER BY last_seen DESC LIMIT ${MAX_IPS_PER_DEVICE})`).run(deviceId, deviceId);
      } else {
        db.prepare('UPDATE access_device_ips SET last_seen = ? WHERE device_id = ? AND ip = ?').run(at, deviceId, address);
      }
      db.prepare('UPDATE access_devices SET last_seen = ?, last_ip = ? WHERE device_id = ?').run(at, address, deviceId);
    })();
    // A far address: outside the /24 (IPv4) or /64 (IPv6) of every earlier address that is not a loopback one (a tunnel that did not pass the
    // address says nothing about where the device was).
    if (newIp && !isLoopback(address)) {
      const earlier = known.filter(value => !isLoopback(value) && value !== 'unknown');
      const network = networkOf(address);
      if (earlier.length && earlier.every(value => networkOf(value) !== network)) {
        alerted = alertDevice(row, `Known device signed in from a new address: ${row.custom_name || row.name}, IP ${address}. Was it you?`);
      }
    }
    return { created: false, newIp, alerted };
  }

  // Whether a session bound to `deviceId` at `boundAt` belongs to a device signed out after that.
  function isRevoked(deviceId, boundAt = 0) {
    if (!deviceId) return false;
    const row = selectRevoked.get(deviceId);
    return Boolean(row && row.revoked_at && row.revoked_at >= (Number(boundAt) || 0));
  }

  // ---- Requests (the middleware of server.js and the terminal websocket) ----
  // An authenticated request: binds an unbound session to the device it names, refuses a session of a signed-out device (its login is taken off
  // the session, so the gates treat it as logged out: 401 / the login page) and touches the device. Returns 'blocked', 'bound', 'seen' or 'none'.
  function onRequest(req, session) {
    if (!session) return 'none';
    const { ip } = clientAddress(req, { trusted });
    const userAgent = req.headers && req.headers['user-agent'];
    const bound = session.access && typeof session.access === 'object' && DEVICE_ID.test(String(session.access.deviceId || '')) ? session.access : null;
    if (bound && isRevoked(bound.deviceId, bound.boundAt)) return block(session, bound.deviceId, ip);
    if (bound) { seen({ deviceId: bound.deviceId, ip, userAgent }); return 'seen'; }
    const deviceId = deviceIdOf(req);
    if (!deviceId) return 'none';
    if (isRevoked(deviceId, 0)) return block(session, deviceId, ip);
    const authenticatedAt = session.clientAuth && Number(session.clientAuth.authenticatedAt);
    // Signed in before the access log started (or a hand-over, authenticatedAt 0): this device is not new to the person, it is only new to the log.
    const carried = !session.clientAuth || !authenticatedAt || authenticatedAt < startedAt();
    session.access = { deviceId, boundAt: now() };
    seen({ deviceId, ip, userAgent, carried, force: true });
    return 'bound';
  }
  function block(session, deviceId, ip) {
    delete session.clientAuth;
    delete session.access;
    const recent = db.prepare("SELECT 1 FROM access_events WHERE kind = 'blocked' AND device_id = ? AND at > ? LIMIT 1").get(deviceId, now() - HOUR);
    if (!recent) event('blocked', { deviceId, ip, detail: 'A signed-out device came back without logging in' });
    return 'blocked';
  }

  // ---- Logins (routes/auth.js) ----
  // A login with a code (or a hand-over): the session is bound to the device it came from; a device signed out earlier is welcome again.
  function loginOk(req, session, { detail = '' } = {}) {
    const { ip } = clientAddress(req, { trusted });
    const deviceId = deviceIdOf(req);
    if (deviceId) {
      session.access = { deviceId, boundAt: now() };
      db.prepare('UPDATE access_devices SET revoked_at = NULL WHERE device_id = ?').run(deviceId);
    }
    event('login_ok', { deviceId, ip, detail });
    if (deviceId) seen({ deviceId, ip, userAgent: req.headers && req.headers['user-agent'], force: true });
  }
  // A wrong code. Five from one address within 10 minutes raise one alert (at most one an hour per address). A refused attempt (too many tries) is
  // `blocked`.
  function loginFailed(req, { limited = false } = {}) {
    const { ip } = clientAddress(req, { trusted });
    const deviceId = deviceIdOf(req) || '';
    if (limited) { event('blocked', { deviceId, ip, detail: 'Too many attempts: the login was refused' }); return { alerted: false }; }
    event('login_failed', { deviceId, ip });
    const count = db.prepare("SELECT COUNT(*) AS n FROM access_events WHERE kind = 'login_failed' AND ip = ? AND at > ?").get(ip, now() - FAILED_WINDOW_MS).n;
    if (count < FAILED_LIMIT || !alertsEnabled() || mode() !== 'remote') return { alerted: false };
    const last = burstAlerts.get(ip);
    if (last && now() - last < ALERT_GAP_MS) return { alerted: false };
    burstAlerts.set(ip, now());
    if (burstAlerts.size > 500) burstAlerts.delete(burstAlerts.keys().next().value);
    raise(`${count} wrong codes from IP ${ip} in 10 minutes`, 'Someone keeps trying to sign in to T-Agent with wrong codes. If it was not you, keep the authenticator safe; after 10 tries an address is refused for 15 minutes.');
    return { alerted: true };
  }

  // ---- The Settings section (routes/access.js) ----
  function sessionCounts() {
    const counts = new Map();
    try {
      for (const row of db.prepare("SELECT json_extract(sess, '$.access.deviceId') AS device, COUNT(*) AS n FROM sessions WHERE expired > ? GROUP BY device").all(now())) {
        if (row.device) counts.set(row.device, row.n);
      }
    } catch { /* no sessions table (a test) */ }
    return counts;
  }
  function view(row, { current = null, counts = new Map() } = {}) {
    return {
      id: row.device_id, name: row.custom_name || row.name, derived_name: row.name, custom_name: row.custom_name || null,
      first_seen: row.first_seen, last_seen: row.last_seen, last_ip: row.last_ip,
      ips_seen_count: db.prepare('SELECT COUNT(*) AS n FROM access_device_ips WHERE device_id = ?').get(row.device_id).n,
      confirmed: Boolean(row.confirmed), revoked_at: row.revoked_at || null, current: row.device_id === current,
      sessions: counts.get(row.device_id) || 0, loopback: isLoopback(row.last_ip),
    };
  }
  function devices({ current = null } = {}) {
    const counts = sessionCounts();
    return db.prepare('SELECT * FROM access_devices ORDER BY last_seen DESC, device_id').all().map(row => view(row, { current, counts }));
  }
  function device(id, options) {
    const row = select.get(String(id || ''));
    if (!row) throw fault('ACCESS_DEVICE_NOT_FOUND', 'This device is not in the access log.', 404);
    return options === false ? row : view(row, options);
  }
  function events({ before = null, limit = 30 } = {}) {
    const size = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 30));
    const cursor = Number.parseInt(before, 10);
    const rows = db.prepare(`SELECT e.*, COALESCE(d.custom_name, d.name) AS device_name FROM access_events e LEFT JOIN access_devices d ON d.device_id = e.device_id
      ${Number.isSafeInteger(cursor) && cursor > 0 ? 'WHERE e.id < @cursor' : ''} ORDER BY e.id DESC LIMIT @limit`).all({ cursor, limit: size + 1 });
    return {
      events: rows.slice(0, size).map(row => ({ id: row.id, at: row.at, device_id: row.device_id || null, device_name: row.device_name || null, ip: row.ip, kind: row.kind, detail: row.detail })),
      more: rows.length > size,
    };
  }
  function rename(id, name) {
    device(id, false);
    if (name !== null && name !== undefined && typeof name !== 'string') throw fault('ACCESS_NAME_INVALID', 'A device name is one line of at most 60 characters.', 400);
    const text = typeof name === 'string' ? name.trim() : '';
    if (text.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(text)) throw fault('ACCESS_NAME_INVALID', 'A device name is one line of at most 60 characters.', 400);
    db.prepare('UPDATE access_devices SET custom_name = ? WHERE device_id = ?').run(text || null, String(id));
    return device(id);
  }
  // "It was me": the device is confirmed and its open alert is done.
  function confirm(id, options) {
    const row = device(id, false);
    db.prepare('UPDATE access_devices SET confirmed = 1, attention_id = NULL WHERE device_id = ?').run(row.device_id);
    if (row.attention_id) {
      const service = attention();
      try {
        const item = service && service.get(row.attention_id);
        if (item && item.status !== 'done') service.update(row.attention_id, { status: 'done', result: 'It was me' }, { actor: SOURCE });
      } catch { /* the alert was deleted */ }
    }
    return device(id, options);
  }
  // Sign out a device: its login sessions are deleted (their open websockets closed by `endSession`) and it must log in again with a code.
  function revoke(id, { current = null } = {}) {
    if (mode() !== 'remote') throw fault('ACCESS_NO_LOGIN', 'This service has no login in local access mode: devices are only logged, there is nothing to sign out.', 409);
    const row = device(id, false);
    if (row.device_id === current) throw fault('ACCESS_CURRENT_DEVICE', 'This is the device you are using. Use Log out instead.', 409);
    let sids = [];
    try { sids = db.prepare("SELECT sid FROM sessions WHERE json_extract(sess, '$.access.deviceId') = ?").pluck().all(row.device_id); } catch { sids = []; }
    db.transaction(() => {
      for (const sid of sids) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      db.prepare('UPDATE access_devices SET revoked_at = ? WHERE device_id = ?').run(now(), row.device_id);
      event('revoked', { deviceId: row.device_id, ip: row.last_ip, detail: `${sids.length} ${sids.length === 1 ? 'session' : 'sessions'} ended` });
    })();
    for (const sid of sids) { try { endSession(sid); } catch { /* the socket is gone */ } }
    return { device: device(id, { current }), sessions_ended: sids.length };
  }
  // Forget a device and its events. It is not signed out: if it visits again it is a new device.
  function forget(id, { current = null } = {}) {
    const row = device(id, false);
    if (row.device_id === current) throw fault('ACCESS_CURRENT_DEVICE', 'This is the device you are using. Use Log out instead.', 409);
    db.transaction(() => {
      db.prepare('DELETE FROM access_events WHERE device_id = ?').run(row.device_id);
      db.prepare('DELETE FROM access_device_ips WHERE device_id = ?').run(row.device_id);
      db.prepare('DELETE FROM access_devices WHERE device_id = ?').run(row.device_id);
    })();
    for (const key of [...touched.keys()]) if (key.startsWith(`${row.device_id}|`)) touched.delete(key);
    return true;
  }

  // The caption about the address of the request that reads the section: a tunnel whose proxy does not pass the address (a loopback peer, no
  // forwarding header, a Host that is not this machine's), or a proxy's address that is not used because no proxy is set up here.
  function ipNote(req) {
    const { via } = clientAddress(req, { trusted });
    if (via === 'untrusted') return 'untrusted_forward';
    if (via === 'loopback' && !isLoopbackHost(req.headers && req.headers.host)) return 'tunnel_no_forward';
    return null;
  }

  // A T-Attention alert marked done is "It was me".
  function watchAttention(service) {
    if (!service || typeof service.onChange !== 'function') return () => {};
    return service.onChange(change => {
      const item = change && change.item;
      if (!item || item.source !== SOURCE || item.status !== 'done') return;
      const row = db.prepare('SELECT device_id FROM access_devices WHERE attention_id = ?').get(item.id);
      if (row) db.prepare('UPDATE access_devices SET confirmed = 1, attention_id = NULL WHERE device_id = ?').run(row.device_id);
    });
  }

  // Events older than 90 days go, and so do addresses not seen since then (the device keeps its last address).
  function prune() {
    const before = now() - RETENTION_DAYS * DAY;
    const events = db.prepare('DELETE FROM access_events WHERE at < ?').run(before).changes;
    const ips = db.prepare('DELETE FROM access_device_ips WHERE last_seen < ?').run(before).changes;
    return { events, ips };
  }

  return {
    seen, onRequest, loginOk, loginFailed, isRevoked, devices, device, events, rename, confirm, revoke, forget, ipNote, prune, watchAttention,
    alertsEnabled, setAlertsEnabled, startedAt, mode,
  };
}

// Deletes old rows at start and once a day (an unref'd timer), like the usage data (services/ui-events.js startRetention).
function startRetention(service, { every = DAY } = {}) {
  const run = () => { try { service.prune(); } catch (error) { console.warn(`Access log: could not delete old rows (${error.message})`); } };
  run();
  const timer = setInterval(run, every);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

// The settings sync group access-alerts (services/settings-sync.js): { enabled } once set, else null (the default, on).
function exportForSync({ db }) {
  const stored = readState(db, ALERTS_KEY);
  return isPlainObject(stored) && typeof stored.enabled === 'boolean' ? { enabled: stored.enabled } : null;
}
function importFromSync({ db }, owner, value) {
  if (value !== null && !(isPlainObject(value) && typeof value.enabled === 'boolean')) throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 });
  writeState(db, ALERTS_KEY, value && { enabled: value.enabled });
}

let shared = null;
const setAccessLog = service => { shared = service; };
const getAccessLog = () => shared;

module.exports = {
  createAccessLog, startRetention, exportForSync, importFromSync, deviceIdOf, deviceName, setAccessLog, getAccessLog,
  KINDS, RETENTION_DAYS, TOUCH_MS, ALERT_GAP_MS, FAILED_LIMIT, FAILED_WINDOW_MS, ALERTS_KEY, ALERTS_GROUP, STATE_KEY, SOURCE, DEVICE_ID,
};
