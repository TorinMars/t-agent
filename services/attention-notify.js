// T-Attention notifiers: tells the user on another channel (Telegram first) when an attention item enters a status that needs them.
// It subscribes in-process to the onChange bus of services/attention.js and loads notifier plugins from plugins/notifiers/<name>/
// (manifest.json + index.js with { name, label, configFields, notify(), test() }).
// Rules and plugin settings are per user, encrypted in system_state (no schema change):
//   attention-notify:<owner>          the rules (statuses, modes, quiet hours, call delay, rate limits, public page address)
//   attention-notify:<plugin>:<owner> the plugin's own settings (for Telegram: the session string and api_hash; never sent to the browser)
// A notifier error never reaches the attention API: the bus handler returns at once and every delivery is caught and logged.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const STATUSES = ['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled'];
const MODES = ['message', 'call', 'off'];
const DEFAULT_STATUSES = ['waiting_user', 'failed', 'review'];
const DEDUPE_MS = 10 * 60 * 1000; // the same item + status is not sent again within 10 minutes
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RATE = { message: 20, call: 6 }; // per notifier per hour
const RECENT_MAX = 50;
const SECRET_KEY = /session|hash|token|secret|password|key/i;
const PLUGINS_DIR = path.join(__dirname, '..', 'plugins', 'notifiers');

class NotifyError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'NotifyError'; this.statusCode = statusCode; }
}

const defaultRules = () => ({
  statuses: [...DEFAULT_STATUSES],
  modes: {}, // { <notifier>: { <status>: 'message' | 'call' | 'off' } }; a missing entry is 'message'
  callDelayMinutes: 0, // a call is made only if the item is still in that status after this many minutes (0 = at once)
  quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: '' },
  rateLimit: { ...DEFAULT_RATE },
  publicUrl: '', // the page address used to make links absolute in messages
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function intIn(value, min, max, fallback, message) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new NotifyError(message);
  return number;
}
function validTimeZone(value) {
  if (!value) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value; } catch { throw new NotifyError('Unknown time zone'); }
}
function publicUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
    return url.href.replace(/\/+$/, '');
  } catch { throw new NotifyError('The page address must be an http(s) URL without credentials, query or fragment'); }
}

// Validates a rules body against the current rules; fields left out keep their saved value.
function normalizeRules(body, current, notifierNames) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NotifyError('Invalid notification rules');
  const next = { ...current, quietHours: { ...current.quietHours }, rateLimit: { ...current.rateLimit }, modes: { ...current.modes } };
  if (body.statuses !== undefined) {
    if (!Array.isArray(body.statuses) || body.statuses.some(status => !STATUSES.includes(status))) throw new NotifyError('Unknown status');
    next.statuses = STATUSES.filter(status => body.statuses.includes(status));
  }
  if (body.modes !== undefined) {
    if (!body.modes || typeof body.modes !== 'object') throw new NotifyError('Invalid modes');
    for (const [name, perStatus] of Object.entries(body.modes)) {
      if (!notifierNames.includes(name)) throw new NotifyError('Unknown notifier');
      if (!perStatus || typeof perStatus !== 'object') throw new NotifyError('Invalid modes');
      const clean = {};
      for (const [status, mode] of Object.entries(perStatus)) {
        if (!STATUSES.includes(status)) throw new NotifyError('Unknown status');
        if (!MODES.includes(mode)) throw new NotifyError('Unknown mode');
        clean[status] = mode;
      }
      next.modes[name] = clean;
    }
  }
  next.callDelayMinutes = intIn(body.callDelayMinutes, 0, 1440, current.callDelayMinutes, 'The delay before a call must be a whole number of minutes from 0 to 1440');
  if (body.quietHours !== undefined) {
    const quiet = body.quietHours || {};
    const start = quiet.start === undefined ? current.quietHours.start : String(quiet.start);
    const end = quiet.end === undefined ? current.quietHours.end : String(quiet.end);
    if (!HHMM.test(start) || !HHMM.test(end)) throw new NotifyError('Quiet hours must be times like 22:00');
    next.quietHours = { enabled: Boolean(quiet.enabled), start, end, timeZone: quiet.timeZone === undefined ? current.quietHours.timeZone : validTimeZone(String(quiet.timeZone || '')) };
  }
  if (body.rateLimit !== undefined) {
    const rate = body.rateLimit || {};
    next.rateLimit = { message: intIn(rate.message, 1, 200, current.rateLimit.message, 'The message limit must be a whole number from 1 to 200'), call: intIn(rate.call, 0, 60, current.rateLimit.call, 'The call limit must be a whole number from 0 to 60') };
  }
  if (body.publicUrl !== undefined) next.publicUrl = publicUrl(body.publicUrl);
  return next;
}

// Minutes since midnight in the given time zone (the server's own when empty).
function minutesOfDay(date, timeZone) {
  if (!timeZone) return date.getHours() * 60 + date.getMinutes();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = type => Number(parts.find(part => part.type === type).value);
  return get('hour') * 60 + get('minute');
}
function inQuietHours(quiet, date) {
  if (!quiet || !quiet.enabled) return false;
  const toMinutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  const now = minutesOfDay(date, quiet.timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end; // a range over midnight, e.g. 22:00-08:00
}

// The absolute page link for a message: an http(s) link as it is, a relative link under the public address, else the public address itself.
function absoluteLink(item, base) {
  const link = item && typeof item.link_url === 'string' ? item.link_url : '';
  if (/^https?:\/\//i.test(link)) return link;
  if (base && link.startsWith('/') && !link.startsWith('//')) return base + link;
  return base ? `${base}/` : '';
}

// Reads every plugins/notifiers/<name>/ that has a manifest of kind 'notifier' and an index.js with the interface.
// Returns { loaded: [{ plugin, manifest }], skipped: [{ name, version, description, error }] }; a broken plugin is skipped and logged,
// and kept in `skipped` so the plugin overview (GET /api/attention/plugins) can show why it is not running.
function scanNotifiers(dir = PLUGINS_DIR, log = defaultLog) {
  const loaded = [];
  const skipped = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { loaded, skipped }; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
      if (!manifest || manifest.kind !== 'notifier') continue;
      const plugin = require(path.join(folder, 'index.js'));
      if (!plugin || plugin.name !== manifest.name || typeof plugin.notify !== 'function' || typeof plugin.test !== 'function') throw new Error('it does not have the notifier interface');
      loaded.push({ plugin, manifest });
    } catch (error) {
      log('warn', `notifier plugin ${entry.name} skipped: ${error.message}`);
      const field = (key, max) => (manifest && typeof manifest[key] === 'string' ? manifest[key].slice(0, max) : null);
      skipped.push({ name: field('name', 64) || entry.name, version: field('version', 40), description: field('description', 500), error: String(error.message || 'error').slice(0, 300) });
    }
  }
  return { loaded, skipped };
}

function loadNotifiers(dir = PLUGINS_DIR, log = defaultLog) {
  return scanNotifiers(dir, log).loaded.map(entry => entry.plugin);
}

function defaultLog(level, message) {
  (level === 'error' || level === 'warn' ? console.warn : console.log)(`[attention-notify] ${message}`);
}

// options: db, sessionSecret, onChange (the bus of services/attention.js; optional), getItem(id) (the current item, so a delayed call carries what
// arrived after its status change, such as context.summary; optional), getOwner (the user for background events),
// notifiers (plugins; default: loaded from plugins/notifiers), skipped (with injected notifiers: broken ones for the overview),
// log(level, message), now(), timers { setTimeout, clearTimeout }.
function createAttentionNotify(options) {
  const { db, sessionSecret } = options;
  const log = options.log || defaultLog;
  const now = options.now || (() => Date.now());
  const timers = options.timers || { setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); if (handle.unref) handle.unref(); return handle; }, clearTimeout };
  const getOwner = options.getOwner || (() => require('./single-user').ensureSingleUser(db).login);
  // notifiers (injected plugins) skip the folder scan; then `skipped` may list broken ones for the overview.
  const scanned = options.notifiers ? null : scanNotifiers(options.pluginsDir, log);
  const notifiers = options.notifiers || scanned.loaded.map(entry => entry.plugin);
  const manifests = new Map(scanned ? scanned.loaded.map(entry => [entry.plugin.name, entry.manifest]) : []);
  const skipped = scanned ? scanned.skipped : (options.skipped || []);
  const byName = new Map(notifiers.map(plugin => [plugin.name, plugin]));

  // Encrypted per-user values in system_state.
  const readState = key => {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(decryptToken(row.value, sessionSecret)); } catch { return null; }
  };
  const writeState = (key, value) => db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, encryptToken(JSON.stringify(value), sessionSecret));
  const deleteState = key => db.prepare('DELETE FROM system_state WHERE key = ?').run(key);
  const rulesKey = owner => `attention-notify:${owner}`;
  const pluginKey = (name, owner) => `attention-notify:${name}:${owner}`;

  function getRules(owner) {
    const base = defaultRules();
    const stored = readState(rulesKey(owner));
    if (!stored) return base;
    return { ...base, ...stored, quietHours: { ...base.quietHours, ...stored.quietHours }, rateLimit: { ...base.rateLimit, ...stored.rateLimit }, modes: { ...stored.modes } };
  }
  function saveRules(owner, body) {
    const next = normalizeRules(body, getRules(owner), [...byName.keys()]);
    writeState(rulesKey(owner), next);
    return next;
  }
  const modeOf = (rules, name, status) => (rules.modes[name] && rules.modes[name][status]) || 'message';

  // The store a plugin gets for its own settings.
  const store = name => ({
    read: owner => readState(pluginKey(name, owner)) || {},
    write: (owner, value) => writeState(pluginKey(name, owner), value),
    clear: owner => deleteState(pluginKey(name, owner)),
  });

  // State in memory: the last sends (dedupe), the send times per notifier and kind (rate limit), the delayed calls and a short log for Settings.
  const sentAt = new Map(); // `${notifier}:${itemId}:${status}` -> time
  const windows = new Map(); // `${notifier}:${kind}` -> [times]
  const pending = new Map(); // itemId -> Map(key -> { handle, status })
  const recent = [];
  function remember(entry) {
    recent.unshift({ at: new Date(now()).toISOString(), ...entry });
    recent.length = Math.min(recent.length, RECENT_MAX);
    log(entry.outcome === 'error' ? 'warn' : 'info', `${entry.notifier} item ${entry.item_id} ${entry.status} ${entry.mode}: ${entry.outcome}${entry.detail ? ` (${entry.detail})` : ''}`);
  }
  function allow(name, kind, rules) {
    const key = `${name}:${kind}`;
    const list = (windows.get(key) || []).filter(at => now() - at < HOUR_MS);
    windows.set(key, list);
    if (list.length >= rules.rateLimit[kind]) return false;
    list.push(now());
    return true;
  }
  function cancel(itemId) {
    const map = pending.get(itemId);
    if (!map) return;
    for (const entry of map.values()) timers.clearTimeout(entry.handle);
    pending.delete(itemId);
  }

  const safeError = error => String((error && (error.errorMessage || error.message)) || error || 'error').slice(0, 300);

  // One delivery through one notifier. A failed or refused call falls back to a message.
  async function deliver({ plugin, owner, rules, item, previous, mode, reason }) {
    const base = { notifier: plugin.name, item_id: item.id, status: item.status, mode };
    const config = store(plugin.name).read(owner);
    if (typeof plugin.ready === 'function' && !plugin.ready(config)) return remember({ ...base, outcome: 'skipped', detail: 'not set up' });
    const link = absoluteLink(item, rules.publicUrl);
    const pluginLog = (level, message) => log(level, `${plugin.name}: ${message}`);
    const send = async (kind, why, extra = {}) => plugin.notify({ item, previous, reason: why, mode: kind, config, log: pluginLog, link, ...extra });
    const message = async (why, extra) => {
      if (!allow(plugin.name, 'message', rules)) return remember({ ...base, mode: 'message', outcome: 'rate_limited' });
      await send('message', why, extra);
      return remember({ ...base, mode: 'message', outcome: why === 'call_failed' ? 'fallback_sent' : 'sent' });
    };
    try {
      if (mode === 'message') return await message(reason);
      if (!allow(plugin.name, 'call', rules)) {
        remember({ ...base, outcome: 'rate_limited' });
        return await message('call_failed', { error: 'call limit reached' });
      }
      let result;
      try { result = await send('call', reason); } catch (error) { result = { fallback: 'message', error: safeError(error) }; }
      if (result && result.fallback === 'message') {
        remember({ ...base, outcome: 'call_failed', detail: result.error });
        return await message('call_failed', { error: result.error });
      }
      return remember({ ...base, outcome: (result && result.outcome) || 'called' });
    } catch (error) {
      return remember({ ...base, outcome: 'error', detail: safeError(error) });
    }
  }

  // Decides what to send for one change. Returns the promises of the deliveries started (tests wait for them).
  function handle(change) {
    const tasks = [];
    if (!change || !change.item) return tasks;
    const { kind, item, previous, event } = change;
    const statusChanged = !previous || previous.status !== item.status;
    // The item was handled or moved on: delayed calls for it are dropped (also when the user edits it in the page).
    if (kind === 'deleted' || statusChanged || (event && event.actor === 'user')) cancel(item.id);
    if (kind === 'deleted' || !statusChanged) return tasks;
    const owner = getOwner();
    const rules = getRules(owner);
    if (!rules.statuses.includes(item.status)) return tasks;
    const quiet = inQuietHours(rules.quietHours, new Date(now()));
    for (const plugin of notifiers) {
      const mode = modeOf(rules, plugin.name, item.status);
      if (mode === 'off') continue;
      const base = { notifier: plugin.name, item_id: item.id, status: item.status, mode };
      const key = `${plugin.name}:${item.id}:${item.status}`;
      if (sentAt.has(key) && now() - sentAt.get(key) < DEDUPE_MS) { remember({ ...base, outcome: 'duplicate' }); continue; }
      if (quiet) { remember({ ...base, outcome: 'quiet_hours' }); continue; }
      sentAt.set(key, now());
      if (mode === 'call' && rules.callDelayMinutes > 0) {
        const map = pending.get(item.id) || new Map();
        pending.set(item.id, map);
        const handleId = timers.setTimeout(() => {
          map.delete(key);
          if (!map.size) pending.delete(item.id);
          const latest = getRules(owner);
          if (inQuietHours(latest.quietHours, new Date(now()))) return remember({ ...base, outcome: 'quiet_hours' });
          let current = item;
          try { current = (typeof options.getItem === 'function' && options.getItem(item.id)) || item; } catch { current = item; }
          void deliver({ plugin, owner, rules: latest, item: current, previous, mode: 'call', reason: 'still' });
        }, rules.callDelayMinutes * 60 * 1000);
        map.set(key, { handle: handleId, status: item.status });
        remember({ ...base, outcome: 'call_scheduled', detail: `${rules.callDelayMinutes} min` });
        continue;
      }
      tasks.push(deliver({ plugin, owner, rules, item, previous, mode, reason: 'status' }));
    }
    return tasks;
  }

  // The bus callback: never throws and never waits, so the attention API is not slowed down or broken by a notifier.
  const listener = change => {
    try { for (const task of handle(change)) task.catch(error => log('warn', `delivery failed: ${safeError(error)}`)); }
    catch (error) { log('warn', `change not handled: ${safeError(error)}`); }
  };
  const unsubscribe = typeof options.onChange === 'function' ? options.onChange(listener) : null;

  // The notifier part of the plugin overview (GET /api/attention/plugins): every notifier with its manifest data, whether it loaded,
  // whether it is set up and a short summary from the optional plugin hook status(config, owner) (its `configured` and `summary`
  // fields; null when the plugin has no hook or does not give them), and the mode per notified status. Never a secret: a summary that
  // contains a stored secret (a setting named like session, hash, token, secret, password or key) is dropped.
  function overview(owner) {
    const rules = getRules(owner);
    const loaded = notifiers.map(plugin => {
      const manifest = manifests.get(plugin.name) || {};
      const pick = (key, max) => (typeof manifest[key] === 'string' ? manifest[key] : typeof plugin[key] === 'string' ? plugin[key] : null)?.slice(0, max) ?? null;
      let configured = null;
      let summary = null;
      let error = null;
      if (typeof plugin.status === 'function') {
        try {
          const config = store(plugin.name).read(owner);
          const state = plugin.status(config, owner) || {};
          if (typeof state.configured === 'boolean') configured = state.configured;
          if (typeof state.summary === 'string' && state.summary.trim()) {
            summary = state.summary.trim().slice(0, 300);
            const secrets = Object.entries(config).filter(([key, value]) => SECRET_KEY.test(key) && typeof value === 'string' && value.length >= 8).map(([, value]) => value);
            if (secrets.some(value => summary.includes(value))) summary = null;
          }
        } catch (failure) { error = `status failed: ${safeError(failure)}`; }
      }
      const statuses = {};
      for (const status of rules.statuses) statuses[status] = modeOf(rules, plugin.name, status);
      return { name: plugin.name, version: pick('version', 40), description: pick('description', 500), loaded: true, error, configured, summary, statuses };
    });
    const broken = skipped.filter(entry => !byName.has(entry.name)).map(entry => ({ ...entry, loaded: false, configured: null, summary: null, statuses: {} }));
    return [...loaded, ...broken];
  }

  // Browser API (session only, same origin): /api/attention-notify/...
  function createRouter(routerOptions = {}) {
    const router = express.Router();
    router.use(routerOptions.clientOrigin || require('../middleware/client-origin'), routerOptions.requireAuth || require('../middleware/auth'), express.json({ limit: '16kb' }));
    const owner = req => req.session.user.login;
    const view = who => ({
      rules: getRules(who),
      statuses: STATUSES,
      modes: MODES,
      subscribed: Boolean(unsubscribe),
      notifiers: notifiers.map(plugin => ({
        name: plugin.name, label: plugin.label || plugin.name, configFields: plugin.configFields || [],
        status: typeof plugin.status === 'function' ? plugin.status(store(plugin.name).read(who), who) : {},
      })),
      recent: recent.slice(0, 20),
    });
    router.get('/config', (req, res) => res.json(view(owner(req))));
    router.put('/config', (req, res) => { saveRules(owner(req), req.body); res.json(view(owner(req))); });
    // A plugin may add its own endpoints (for Telegram: the login steps) under /api/attention-notify/<name>/.
    for (const plugin of notifiers) {
      const sub = express.Router();
      if (typeof plugin.routes === 'function') plugin.routes(sub, { store: store(plugin.name), owner, NotifyError, log: (level, message) => log(level, `${plugin.name}: ${message}`) });
      sub.post('/test', async (req, res, next) => {
        try {
          const kind = req.body && req.body.kind === 'call' ? 'call' : 'message';
          const base = getRules(owner(req)).publicUrl;
          res.json(await plugin.test(store(plugin.name).read(owner(req)), { kind, link: base ? `${base}/` : '' }));
        } catch (error) { next(error); }
      });
      router.use(`/${plugin.name}`, sub);
    }
    router.use((error, req, res, next) => {
      if (res.headersSent) return next(error);
      if (error instanceof NotifyError || (error && error.name === 'NotifyError')) return res.status(error.statusCode || 400).json({ error: error.message });
      log('warn', `request failed: ${safeError(error)}`);
      return res.status(500).json({ error: 'Notifications are temporarily unavailable' });
    });
    return router;
  }

  return {
    handle, listener, createRouter, getRules, saveRules, notifiers, overview, defaultOwner: () => getOwner(),
    rules: owner => getRules(owner),
    recent: () => recent.slice(),
    pendingCount: () => [...pending.values()].reduce((sum, map) => sum + map.size, 0),
    stop() {
      if (unsubscribe) unsubscribe();
      for (const id of [...pending.keys()]) cancel(id);
      for (const plugin of notifiers) if (typeof plugin.close === 'function') { try { plugin.close(); } catch { /* closing is best effort */ } }
    },
  };
}

// The wire-up for server.js: subscribes to services/attention.js when it exists (a no-op subscription otherwise) and returns the service with its router.
function start(options) {
  let onChange = options.onChange;
  if (onChange === undefined) {
    try {
      const attention = require('./attention');
      onChange = typeof attention.onChange === 'function' ? attention.onChange.bind(attention) : null;
      if (options.getItem === undefined && typeof attention.defaultService === 'function') {
        const service = attention.defaultService();
        options = { ...options, getItem: id => service.get(id) };
      }
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' || !/Cannot find module '\.\/attention'/.test(String(error.message))) throw error;
      onChange = null;
    }
  }
  return createAttentionNotify({ ...options, onChange });
}

module.exports = { start, createAttentionNotify, loadNotifiers, scanNotifiers, normalizeRules, inQuietHours, absoluteLink, defaultRules, NotifyError, STATUSES, MODES, DEDUPE_MS };
