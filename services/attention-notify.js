// T-Attention notifiers: tells the user on another channel (Telegram first) when an attention item enters a status that needs them, unless
// the item's T-Agent session is open on a screen right now (onScreen: the terminal's foreground presence, routes/terminal.js).
// It subscribes in-process to the onChange bus of services/attention.js and loads notifier plugins from plugins/notifiers/<name>/
// (manifest.json + index.js with { name, label, configFields, notify(), test() }).
// Rules and plugin settings are per user, encrypted in system_state (no schema change):
//   attention-notify:<owner>          the rules (statuses, modes, quiet hours, call delay, rate limits, public page address)
//   attention-notify:<plugin>:<owner> the plugin's own settings (for Telegram: the session string and api_hash; never sent to the browser)
//   attention-plugin:<plugin>:<owner> the manifest settings: { enabled, values } (the "config" schema of manifest.json; secrets never sent back)
// A notifier error never reaches the attention API: the bus handler returns at once and every delivery is caught and logged.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { encryptToken, decryptToken } = require('../lib/token-crypto');
const syncStore = require('./settings-sync-store');

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

// ---- Manifest-driven plugin settings (manifest "config", "test", "customUi") ----
// A notifier's manifest may describe its simple settings; the server validates them, stores them per user (encrypted, with the enable switch) and
// the page draws a form from the schema. See "Plugin settings from the manifest" in DESIGN.md and plugins/README.md.
const CONFIG_TYPES = ['string', 'secret', 'number', 'boolean', 'select'];
const CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const CONFIG_MAX_FIELDS = 30;
const STRING_MAX = 2000;
const SECRET_MAX = 4096;

// Checks manifest.config and returns a clean copy; throws an Error with the reason (the plugin is then skipped at load).
function validateConfigSchema(config) {
  if (config === undefined || config === null) return [];
  if (!Array.isArray(config)) throw new Error('config must be a list');
  if (config.length > CONFIG_MAX_FIELDS) throw new Error(`config has more than ${CONFIG_MAX_FIELDS} fields`);
  const seen = new Set();
  const optionalText = (field, name, max) => {
    if (field[name] === undefined) return undefined;
    if (typeof field[name] !== 'string' || field[name].length > max) throw new Error(`config field ${field.key}: ${name} must be text of at most ${max} characters`);
    return field[name];
  };
  return config.map((field, index) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw new Error(`config field ${index + 1} is not an object`);
    if (typeof field.key !== 'string' || !CONFIG_KEY.test(field.key)) throw new Error(`config field ${index + 1}: key must be letters, digits or _ and start with a letter`);
    if (seen.has(field.key)) throw new Error(`config field ${field.key} is listed twice`);
    seen.add(field.key);
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 120) throw new Error(`config field ${field.key}: label is missing`);
    if (!CONFIG_TYPES.includes(field.type)) throw new Error(`config field ${field.key}: type must be one of ${CONFIG_TYPES.join(', ')}`);
    const clean = { key: field.key, label: field.label.trim(), type: field.type, required: field.required === true };
    if (field.required !== undefined && typeof field.required !== 'boolean') throw new Error(`config field ${field.key}: required must be true or false`);
    for (const name of ['help', 'placeholder']) { const value = optionalText(field, name, 300); if (value !== undefined) clean[name] = value; }
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || !field.options.length || field.options.length > 50) throw new Error(`config field ${field.key}: options must be a list of 1 to 50 choices`);
      clean.options = field.options.map(option => {
        const value = typeof option === 'string' ? option : option && option.value;
        const label = typeof option === 'string' ? option : option && option.label;
        if (typeof value !== 'string' || !value || value.length > 100 || typeof label !== 'string' || !label || label.length > 120) throw new Error(`config field ${field.key}: every option needs a value and a label`);
        return { value, label };
      });
      if (new Set(clean.options.map(option => option.value)).size !== clean.options.length) throw new Error(`config field ${field.key}: an option value is listed twice`);
    } else if (field.options !== undefined) throw new Error(`config field ${field.key}: only a select has options`);
    if (field.type === 'number') {
      for (const name of ['min', 'max']) {
        if (field[name] === undefined) continue;
        if (typeof field[name] !== 'number' || !Number.isFinite(field[name])) throw new Error(`config field ${field.key}: ${name} must be a number`);
        clean[name] = field[name];
      }
      if (clean.min !== undefined && clean.max !== undefined && clean.min > clean.max) throw new Error(`config field ${field.key}: min is above max`);
      if (field.integer !== undefined && typeof field.integer !== 'boolean') throw new Error(`config field ${field.key}: integer must be true or false`);
      if (field.integer) clean.integer = true;
    } else if (field.min !== undefined || field.max !== undefined || field.integer !== undefined) throw new Error(`config field ${field.key}: only a number has min, max or integer`);
    if (field.default !== undefined) {
      if (field.type === 'secret') throw new Error(`config field ${field.key}: a secret cannot have a default`);
      try { clean.default = checkValue(clean, field.default); } catch (error) { throw new Error(`config field ${field.key}: the default is not valid (${error.message})`); }
      if (clean.default === undefined) delete clean.default;
    }
    return clean;
  });
}

// One value against its field: the clean value, or undefined for "no value" (an empty string or null). Throws NotifyError with a message for the page.
function checkValue(field, value) {
  if (value === undefined || value === null || value === '') return undefined;
  const label = field.label;
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') throw new NotifyError(`${label} must be text`);
      const text = value.trim();
      if (text.length > STRING_MAX) throw new NotifyError(`${label} is too long`);
      return text || undefined;
    }
    case 'secret':
      if (typeof value !== 'string') throw new NotifyError(`${label} must be text`);
      if (value.length > SECRET_MAX) throw new NotifyError(`${label} is too long`);
      return value;
    case 'number': {
      const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
      const range = field.min !== undefined && field.max !== undefined ? ` from ${field.min} to ${field.max}` : field.min !== undefined ? ` of at least ${field.min}` : field.max !== undefined ? ` of at most ${field.max}` : '';
      const bad = !Number.isFinite(number) || (field.integer && !Number.isInteger(number)) || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max);
      if (bad) throw new NotifyError(`${label} must be a ${field.integer ? 'whole number' : 'number'}${range}`);
      return number;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new NotifyError(`${label} must be on or off`);
      return value;
    case 'select':
      if (typeof value !== 'string' || !field.options.some(option => option.value === value)) throw new NotifyError(`${label}: choose one of the listed values`);
      return value;
    default: throw new NotifyError('Unknown setting type');
  }
}

// The values a save leaves: fields left out keep their value; an empty secret (or { set: true }, as the page got it) keeps the saved one, and
// null clears it; an empty other field goes back to its default. Unknown keys and a missing required value are refused.
function normalizeConfigValues(schema, body, current = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NotifyError('Invalid settings');
  const byKey = new Map(schema.map(field => [field.key, field]));
  for (const key of Object.keys(body)) if (!byKey.has(key)) throw new NotifyError(`Unknown setting: ${String(key).slice(0, 40)}`);
  const next = {};
  for (const field of schema) {
    const has = Object.prototype.hasOwnProperty.call(body, field.key);
    const raw = body[field.key];
    let value;
    if (!has) value = current[field.key];
    else if (field.type === 'secret' && (raw === '' || raw === undefined || (raw && typeof raw === 'object' && raw.set === true))) value = current[field.key];
    else value = checkValue(field, raw);
    if (value !== undefined) next[field.key] = value;
  }
  for (const field of schema) {
    if (field.required && next[field.key] === undefined && field.default === undefined) throw new NotifyError(`${field.label} is required`);
  }
  return next;
}

// What a plugin gets: the stored value, else the default.
function effectiveValues(schema, stored = {}) {
  const out = {};
  for (const field of schema) {
    if (stored[field.key] !== undefined) out[field.key] = stored[field.key];
    else if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}
// What the browser gets: secrets only as { set } (never the value), the rest with defaults filled in.
function publicValues(schema, stored = {}) {
  const out = effectiveValues(schema, stored);
  for (const field of schema) if (field.type === 'secret') out[field.key] = { set: typeof stored[field.key] === 'string' && stored[field.key] !== '' };
  return out;
}
// Every required field has a value (a plugin without the status hook is "configured" by this).
const requiredSet = (schema, stored = {}) => schema.every(field => !field.required || stored[field.key] !== undefined || field.default !== undefined);
// Removes stored secrets from a text that goes to the browser (a test or error message).
function scrubSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[hidden]');
  return out;
}

// Reads every plugins/notifiers/<name>/ that has a manifest of kind 'notifier' and an index.js with the interface.
// Returns { loaded: [{ plugin, manifest, folder, origin, dev }], skipped: [{ name, version, description, error, origin, dev }] }; a broken plugin
// is skipped and logged, and kept in `skipped` so the plugin overview (GET /api/attention/plugins) can show why it is not running.
// extra: user plugin folders [{ folder, origin, dev }] (lib/plugin-store.js userFolders), read after the built-in ones; one whose name is
// a built-in (or an earlier) notifier is skipped, so a user plugin never shadows a built-in.
function scanNotifiers(dir = PLUGINS_DIR, log = defaultLog, extra = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  const folders = entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({ folder: path.join(dir, entry.name), origin: 'builtin', dev: false }));
  return scanNotifierFolders([...folders, ...(Array.isArray(extra) ? extra : [])], log, builtInNamesOf(dir));
}

function builtInNamesOf(dir) {
  const names = new Set();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return names; }
  for (const entry of entries) if (entry.isDirectory()) names.add(entry.name);
  return names;
}

function scanNotifierFolders(folders, log = defaultLog, reserved = new Set()) {
  const loaded = [];
  const skipped = [];
  const taken = new Set();
  for (const { folder, origin = 'builtin', dev = false } of folders) {
    const label = path.basename(folder);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
      if (!manifest || manifest.kind !== 'notifier') continue;
      if (origin !== 'builtin' && (reserved.has(manifest.name) || reserved.has(label))) throw new Error('its name is a built-in plugin');
      if (taken.has(manifest.name)) throw new Error('another notifier has the same name');
      const checked = checkManifest(manifest);
      const plugin = require(path.join(folder, 'index.js'));
      if (!plugin || plugin.name !== manifest.name || typeof plugin.notify !== 'function' || typeof plugin.test !== 'function') throw new Error('it does not have the notifier interface');
      taken.add(manifest.name);
      loaded.push({ plugin, manifest: checked, folder, origin, dev });
    } catch (error) {
      log('warn', `notifier plugin ${label} skipped: ${error.message}`);
      const field = (key, max) => (manifest && typeof manifest[key] === 'string' ? manifest[key].slice(0, max) : null);
      skipped.push({ name: field('name', 64) || label, version: field('version', 40), description: field('description', 500), error: String(error.message || 'error').slice(0, 300), origin, dev });
    }
  }
  return { loaded, skipped };
}

// Drops every cached module of one plugin folder (and nothing else), so the next require reads the files again.
function dropRequireCache(folder) {
  const roots = new Set([path.resolve(folder)]);
  try { roots.add(fs.realpathSync(folder)); } catch { /* the folder is gone */ }
  let dropped = 0;
  for (const key of Object.keys(require.cache)) {
    for (const root of roots) {
      if (key === root || key.startsWith(root + path.sep)) { delete require.cache[key]; dropped += 1; break; }
    }
  }
  return dropped;
}

// The settings part of a notifier manifest: `config` validated (an invalid schema skips the plugin), `test` (default true: every notifier has
// test()) and `customUi` (the name of a section the page draws itself, above the generic form).
function checkManifest(manifest) {
  let config;
  try { config = validateConfigSchema(manifest.config); } catch (error) { throw new Error(`invalid config in manifest.json: ${error.message}`); }
  if (manifest.test !== undefined && typeof manifest.test !== 'boolean') throw new Error('invalid manifest.json: test must be true or false');
  if (manifest.customUi !== undefined && manifest.customUi !== null && (typeof manifest.customUi !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(manifest.customUi))) throw new Error('invalid manifest.json: customUi must be a short name');
  return { ...manifest, config, test: manifest.test !== false, customUi: manifest.customUi || null };
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
// log(level, message), now(), timers { setTimeout, clearTimeout }, isForeground(taskId, terminalId) (true while a page of this engine shows that
// T-Agent terminal in the foreground: routes/terminal.js isTerminalForeground; default: never), host (this machine's name, default os.hostname()).
function createAttentionNotify(options) {
  const { db, sessionSecret } = options;
  const log = options.log || defaultLog;
  const now = options.now || (() => Date.now());
  const timers = options.timers || { setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); if (handle.unref) handle.unref(); return handle; }, clearTimeout };
  const getOwner = options.getOwner || (() => require('./single-user').ensureSingleUser(db).login);
  const isForeground = typeof options.isForeground === 'function' ? options.isForeground : () => false;
  const host = options.host === undefined ? require('os').hostname() : options.host;
  // The session of an item is open on a screen: its context names a T-Agent terminal (context.tagent, written by the Claude listener or tied by a
  // terminal token) of THIS engine (no context.host, or this machine's name) and that terminal is in the foreground now. Then nothing is sent.
  function onScreen(item) {
    const context = item && item.context;
    const tagent = context && context.tagent;
    if (!tagent || !tagent.task_id || !tagent.terminal_id) return false;
    if (context.host && host && context.host !== host) return false; // a session of another machine
    try { return isForeground(String(tagent.task_id), String(tagent.terminal_id)) === true; } catch { return false; }
  }
  // notifiers (injected plugins) skip the folder scan; then `skipped` may list broken ones for the overview. extraFolders() gives the user
  // plugin folders (lib/plugin-store.js), read again on every reload().
  const extraFolders = typeof options.extraFolders === 'function' ? options.extraFolders : () => [];
  const scan = () => scanNotifiers(options.pluginsDir, log, extraFolders());
  let scanned = options.notifiers ? null : scan();
  // Kept as the same objects across reloads (the array is exported as `notifiers`).
  const notifiers = options.notifiers ? [...options.notifiers] : scanned.loaded.map(entry => entry.plugin);
  const manifests = new Map();
  const origins = new Map(); // name -> { origin, dev, folder }
  const byName = new Map();
  let skipped = [];
  function index() {
    manifests.clear(); origins.clear(); byName.clear();
    if (scanned) {
      for (const entry of scanned.loaded) { manifests.set(entry.plugin.name, entry.manifest); origins.set(entry.plugin.name, { origin: entry.origin, dev: entry.dev, folder: entry.folder }); }
    } else {
      for (const plugin of notifiers) { manifests.set(plugin.name, checkManifest((options.manifests && options.manifests[plugin.name]) || {})); origins.set(plugin.name, { origin: 'builtin', dev: false, folder: null }); }
    }
    for (const plugin of notifiers) byName.set(plugin.name, plugin);
    skipped = scanned ? scanned.skipped : (options.skipped || []);
  }
  index();
  const schemaOf = name => (manifests.get(name) || {}).config || [];

  // Reads the plugin folders again (after an install, update, remove or a change in a linked folder). changed: folders whose files changed;
  // only their modules leave the require cache, and their old plugin objects (and those of plugins that are gone) get close().
  function reload({ changed = [] } = {}) {
    if (!scanned) return { loaded: notifiers.map(plugin => plugin.name) };
    const changedRoots = new Set();
    for (const folder of changed) {
      changedRoots.add(path.resolve(folder));
      try { changedRoots.add(fs.realpathSync(folder)); } catch { /* removed */ }
    }
    const inside = folder => [...changedRoots].some(root => folder === root || folder.startsWith(root + path.sep));
    const previous = scanned.loaded;
    for (const folder of changed) dropRequireCache(folder);
    for (const entry of previous) {
      const real = (() => { try { return fs.realpathSync(entry.folder); } catch { return path.resolve(entry.folder); } })();
      if (inside(path.resolve(entry.folder)) || inside(real)) dropRequireCache(entry.folder);
    }
    scanned = scan();
    const next = new Set(scanned.loaded.map(entry => entry.plugin));
    for (const entry of previous) {
      if (next.has(entry.plugin) || typeof entry.plugin.close !== 'function') continue;
      try { entry.plugin.close(); } catch { /* closing is best effort */ }
    }
    notifiers.length = 0;
    notifiers.push(...scanned.loaded.map(entry => entry.plugin));
    index();
    log('info', `notifiers reloaded: ${notifiers.map(plugin => plugin.name).join(', ') || 'none'}`);
    return { loaded: notifiers.map(plugin => plugin.name) };
  }

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
  const settingsKey = (name, owner) => `attention-plugin:${name}:${owner}`;

  function getRules(owner) {
    const base = defaultRules();
    const stored = readState(rulesKey(owner));
    if (!stored) return base;
    return { ...base, ...stored, quietHours: { ...base.quietHours, ...stored.quietHours }, rateLimit: { ...base.rateLimit, ...stored.rateLimit }, modes: { ...stored.modes } };
  }
  function saveRules(owner, body) {
    const next = normalizeRules(body, getRules(owner), [...byName.keys()]);
    writeState(rulesKey(owner), next);
    syncStore.settingChanged(SYNC_RULES);
    return next;
  }
  const modeOf = (rules, name, status) => (rules.modes[name] && rules.modes[name][status]) || 'message';

  // The manifest settings of one plugin for one user: { enabled, values } in attention-plugin:<name>:<owner> (encrypted as a whole, so the
  // secrets too). The first read moves the values of schema keys the plugin kept in its own store (attention-notify:<name>:<owner>, for
  // Telegram the ring time `callSeconds`) into it, so existing settings keep working without being entered again.
  function readSettings(name, owner) {
    const stored = readState(settingsKey(name, owner));
    if (stored && typeof stored === 'object') return { enabled: stored.enabled !== false, values: stored.values && typeof stored.values === 'object' ? stored.values : {} };
    const schema = schemaOf(name);
    const own = readState(pluginKey(name, owner));
    const values = {};
    if (own && schema.length) {
      for (const field of schema) {
        if (own[field.key] === undefined) continue;
        try { const value = checkValue(field, own[field.key]); if (value !== undefined) values[field.key] = value; } catch { /* a value the schema refuses is dropped */ }
      }
    }
    const moved = own && schema.some(field => own[field.key] !== undefined);
    if (moved) {
      const rest = { ...own };
      for (const field of schema) delete rest[field.key];
      writeState(settingsKey(name, owner), { enabled: true, values });
      writeState(pluginKey(name, owner), rest);
      log('info', `${name}: moved ${Object.keys(values).length} setting(s) of ${owner} to the manifest settings`);
    }
    return { enabled: true, values };
  }
  const writeSettings = (name, owner, settings) => {
    writeState(settingsKey(name, owner), { enabled: settings.enabled !== false, values: settings.values || {} });
    if (name !== UNSYNCED_PLUGIN) syncStore.settingChanged(SYNC_PLUGINS);
  };
  const isEnabled = (name, owner) => readSettings(name, owner).enabled;

  // The store a plugin gets for its own settings. A read gives its own values plus the manifest settings (with defaults); a write of a
  // schema key goes to the manifest settings (only when it differs from what the plugin read), the rest to its own store; clear() forgets
  // only its own store (the manifest settings and the switch stay).
  const store = name => ({
    read: owner => ({ ...(readState(pluginKey(name, owner)) || {}), ...effectiveValues(schemaOf(name), readSettings(name, owner).values) }),
    write: (owner, value) => {
      const schema = schemaOf(name);
      const rest = { ...(value || {}) };
      if (schema.length) {
        const settings = readSettings(name, owner);
        const shown = effectiveValues(schema, settings.values);
        const values = { ...settings.values };
        let changed = false;
        for (const field of schema) {
          if (!Object.prototype.hasOwnProperty.call(rest, field.key)) continue;
          const next = rest[field.key];
          delete rest[field.key];
          if (next === shown[field.key]) continue;
          if (next === undefined || next === null || next === '') delete values[field.key]; else values[field.key] = next;
          changed = true;
        }
        if (changed) writeSettings(name, owner, { ...settings, values });
      }
      writeState(pluginKey(name, owner), rest);
    },
    clear: owner => deleteState(pluginKey(name, owner)),
  });
  // Every stored secret of a plugin (manifest secrets and own values named like a secret), to keep them out of what the browser gets.
  function secretsOf(name, owner) {
    const own = readState(pluginKey(name, owner)) || {};
    const { values } = readSettings(name, owner);
    return [
      ...schemaOf(name).filter(field => field.type === 'secret').map(field => values[field.key]),
      ...Object.entries(own).filter(([key, value]) => SECRET_KEY.test(key) && typeof value === 'string').map(([, value]) => value),
    ].filter(value => typeof value === 'string' && value);
  }

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
    const values = effectiveValues(schemaOf(plugin.name), readSettings(plugin.name, owner).values);
    const send = async (kind, why, extra = {}) => plugin.notify({ item, previous, reason: why, mode: kind, config, values, log: pluginLog, link, ...extra });
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
    const foreground = onScreen(item);
    for (const plugin of notifiers) {
      const mode = modeOf(rules, plugin.name, item.status);
      if (mode === 'off') continue;
      if (!isEnabled(plugin.name, owner)) continue; // a plugin switched off gets nothing
      const base = { notifier: plugin.name, item_id: item.id, status: item.status, mode };
      const key = `${plugin.name}:${item.id}:${item.status}`;
      if (sentAt.has(key) && now() - sentAt.get(key) < DEDUPE_MS) { remember({ ...base, outcome: 'duplicate' }); continue; }
      if (foreground) { remember({ ...base, outcome: 'foreground', detail: 'the session is open on screen' }); continue; } // not marked as sent
      if (quiet) { remember({ ...base, outcome: 'quiet_hours' }); continue; }
      sentAt.set(key, now());
      if (mode === 'call' && rules.callDelayMinutes > 0) {
        const map = pending.get(item.id) || new Map();
        pending.set(item.id, map);
        const handleId = timers.setTimeout(() => {
          map.delete(key);
          if (!map.size) pending.delete(item.id);
          const latest = getRules(owner);
          if (byName.get(plugin.name) !== plugin) return undefined; // removed or replaced (reloaded) while the call waited
          if (!isEnabled(plugin.name, owner)) return undefined; // switched off while the call waited
          if (inQuietHours(latest.quietHours, new Date(now()))) return remember({ ...base, outcome: 'quiet_hours' });
          let current = item;
          try { current = (typeof options.getItem === 'function' && options.getItem(item.id)) || item; } catch { current = item; }
          if (onScreen(current)) return remember({ ...base, outcome: 'foreground', detail: 'the session is open on screen' }); // checked again when the call is due
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
            const secrets = secretsOf(plugin.name, owner).filter(value => value.length >= 8);
            if (secrets.some(value => summary.includes(value))) summary = null;
          }
        } catch (failure) { error = `status failed: ${safeError(failure)}`; }
      }
      const schema = schemaOf(plugin.name);
      const settings = readSettings(plugin.name, owner);
      if (configured === null && schema.some(field => field.required)) configured = requiredSet(schema, settings.values);
      const statuses = {};
      for (const status of rules.statuses) statuses[status] = modeOf(rules, plugin.name, status);
      const where = origins.get(plugin.name) || { origin: 'builtin', dev: false };
      return {
        name: plugin.name, version: pick('version', 40), description: pick('description', 500), loaded: true, error, enabled: settings.enabled, configured, summary, statuses,
        settings: schema.length > 0, test: manifest.test !== false, customUi: manifest.customUi || null, origin: where.origin, dev: Boolean(where.dev),
      };
    });
    const broken = skipped.filter(entry => !byName.has(entry.name)).map(entry => ({ ...entry, loaded: false, enabled: null, configured: null, summary: null, statuses: {}, settings: false, test: false, customUi: null, origin: entry.origin || 'builtin', dev: Boolean(entry.dev) }));
    return [...loaded, ...broken];
  }

  // Forgets every stored setting of one plugin for every user (its own store and the manifest settings, also its modes in the rules).
  function purgePlugin(name) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new NotifyError('Unknown notifier', 404);
    const removed = db.prepare("DELETE FROM system_state WHERE key LIKE ? OR key LIKE ?").run(`attention-notify:${name}:%`, `attention-plugin:${name}:%`).changes;
    for (const row of db.prepare("SELECT key FROM system_state WHERE key LIKE 'attention-notify:%'").all()) {
      const owner = row.key.slice('attention-notify:'.length);
      if (owner.includes(':')) continue;
      const rules = readState(row.key);
      if (rules && rules.modes && rules.modes[name]) { delete rules.modes[name]; writeState(row.key, rules); }
    }
    syncStore.settingChanged(SYNC_RULES);
    syncStore.settingChanged(SYNC_PLUGINS);
    return removed;
  }

  // ---- Manifest settings API (GET/PUT /api/attention/plugins/:name/config, POST /api/attention/plugins/:name/test) ----
  const pluginNamed = name => {
    const plugin = typeof name === 'string' ? byName.get(name) : null;
    if (!plugin) throw new NotifyError('Unknown notifier', 404);
    return plugin;
  };
  // { name, enabled, values, schema, test, customUi }; a secret is { set: true | false }, never its value.
  function getPluginConfig(name, owner) {
    const plugin = pluginNamed(name);
    const manifest = manifests.get(plugin.name) || {};
    const schema = schemaOf(plugin.name);
    const settings = readSettings(plugin.name, owner);
    return { name: plugin.name, enabled: settings.enabled, values: publicValues(schema, settings.values), schema, test: manifest.test !== false, customUi: manifest.customUi || null };
  }
  // body { enabled?, values? }: fields left out keep their value (see normalizeConfigValues).
  function savePluginConfig(name, owner, body) {
    const plugin = pluginNamed(name);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NotifyError('Invalid settings');
    for (const key of Object.keys(body)) if (!['enabled', 'values'].includes(key)) throw new NotifyError(`Unknown field: ${String(key).slice(0, 40)}`);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new NotifyError('enabled must be true or false');
    const settings = readSettings(plugin.name, owner);
    const values = body.values === undefined ? settings.values : normalizeConfigValues(schemaOf(plugin.name), body.values, settings.values);
    writeSettings(plugin.name, owner, { enabled: body.enabled === undefined ? settings.enabled : body.enabled, values });
    return getPluginConfig(plugin.name, owner);
  }
  // Runs the plugin's test(config, { kind: 'message', link, values, owner, log }) and answers { ok, message }. A failure is an answer too
  // (ok: false); the message never holds a stored secret.
  async function testPlugin(name, owner) {
    const plugin = pluginNamed(name);
    const manifest = manifests.get(plugin.name) || {};
    if (manifest.test === false) throw new NotifyError('This plugin has no test', 400);
    const settings = readSettings(plugin.name, owner);
    if (!settings.enabled) return { ok: false, message: 'The plugin is turned off' };
    const config = store(plugin.name).read(owner);
    const secrets = secretsOf(plugin.name, owner);
    const clean = text => scrubSecrets(String(text).slice(0, 300), secrets);
    if (typeof plugin.ready === 'function' && !plugin.ready(config)) return { ok: false, message: 'The plugin is not set up yet' };
    const base = getRules(owner).publicUrl;
    const values = effectiveValues(schemaOf(plugin.name), settings.values);
    try {
      const result = await plugin.test(config, { kind: 'message', link: base ? `${base}/` : '', values, owner, log: (level, message) => log(level, `${plugin.name}: ${message}`) });
      const ok = !(result && result.ok === false);
      const message = result && typeof result.message === 'string' && result.message.trim() ? clean(result.message.trim()) : (ok ? 'Test sent' : 'Test failed');
      log(ok ? 'info' : 'warn', `${plugin.name}: test ${ok ? 'sent' : 'failed'}`);
      return { ok, message };
    } catch (error) {
      const message = clean(safeError(error));
      log('warn', `${plugin.name}: test failed: ${message}`);
      return { ok: false, message };
    }
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
    // A plugin may add its own endpoints (for Telegram: the login steps) under /api/attention-notify/<name>/. The sub-router of a plugin is
    // made on its first request and looked up by name on every request, so a reloaded or removed plugin is served by its current object.
    const subs = new WeakMap();
    const subFor = plugin => {
      if (subs.has(plugin)) return subs.get(plugin);
      const sub = express.Router();
      if (typeof plugin.routes === 'function') plugin.routes(sub, { store: store(plugin.name), owner, NotifyError, log: (level, message) => log(level, `${plugin.name}: ${message}`) });
      sub.post('/test', async (req, res, next) => {
        try {
          const kind = req.body && req.body.kind === 'call' ? 'call' : 'message';
          const base = getRules(owner(req)).publicUrl;
          res.json(await plugin.test(store(plugin.name).read(owner(req)), { kind, link: base ? `${base}/` : '' }));
        } catch (error) { next(error); }
      });
      subs.set(plugin, sub);
      return sub;
    };
    router.use('/:plugin', (req, res, next) => {
      const plugin = byName.get(req.params.plugin);
      return plugin ? subFor(plugin)(req, res, next) : next();
    });
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
    getPluginConfig, savePluginConfig, testPlugin, isEnabled, reload, purgePlugin,
    has: name => byName.has(name),
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

// ---- Settings sync across linked devices (services/settings-sync.js) ----
// Two groups: the rules (attention-notify:<owner>, as stored), and the manifest settings with the switch of every notifier plugin except Telegram
// ({ <plugin>: { enabled, values } } from attention-plugin:<plugin>:<owner>, secrets included; the sync sends them encrypted). A plugin's own store
// (attention-notify:<plugin>:<owner>) holds its runtime state and is never synced, and Telegram keeps all of its settings per device.
const SYNC_RULES = 'notify-rules';
const SYNC_PLUGINS = 'notifier-plugins';
const UNSYNCED_PLUGIN = 'telegram';
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const exportRulesForSync = ({ db, sessionSecret }, owner) => syncStore.readState(db, `attention-notify:${owner}`, sessionSecret);
const importRulesFromSync = ({ db, sessionSecret }, owner, value) => syncStore.writeState(db, `attention-notify:${owner}`, syncStore.objectOrNull(value), sessionSecret);
// The plugins whose manifest settings are stored for this owner, Telegram left out.
function storedPluginNames(db, owner) {
  const suffix = `:${owner}`;
  return db.prepare("SELECT key FROM system_state WHERE key LIKE 'attention-plugin:%'").all().map(row => row.key)
    .filter(key => key.endsWith(suffix)).map(key => key.slice('attention-plugin:'.length, key.length - suffix.length))
    .filter(name => PLUGIN_NAME.test(name) && name !== UNSYNCED_PLUGIN).sort();
}
function exportPluginsForSync({ db, sessionSecret }, owner) {
  const plugins = {};
  for (const name of storedPluginNames(db, owner)) {
    const stored = syncStore.readState(db, `attention-plugin:${name}:${owner}`, sessionSecret);
    if (syncStore.isPlainObject(stored)) plugins[name] = { enabled: stored.enabled !== false, values: syncStore.isPlainObject(stored.values) ? stored.values : {} };
  }
  return Object.keys(plugins).length ? plugins : null;
}
function importPluginsFromSync({ db, sessionSecret }, owner, value) {
  const given = syncStore.objectOrNull(value) || {};
  const invalid = () => Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 });
  for (const [name, settings] of Object.entries(given)) {
    if (!PLUGIN_NAME.test(name) || !syncStore.isPlainObject(settings) || typeof settings.enabled !== 'boolean' || !syncStore.isPlainObject(settings.values)) throw invalid();
  }
  db.transaction(() => {
    for (const name of storedPluginNames(db, owner)) if (!Object.hasOwn(given, name)) syncStore.writeState(db, `attention-plugin:${name}:${owner}`, null);
    for (const [name, settings] of Object.entries(given)) {
      if (name === UNSYNCED_PLUGIN) continue;
      syncStore.writeState(db, `attention-plugin:${name}:${owner}`, { enabled: settings.enabled, values: settings.values }, sessionSecret);
    }
  })();
}

module.exports = {
  SYNC_RULES, SYNC_PLUGINS, exportRulesForSync, importRulesFromSync, exportPluginsForSync, importPluginsFromSync,
  start, createAttentionNotify, loadNotifiers, scanNotifiers, scanNotifierFolders, dropRequireCache, normalizeRules,
  validateConfigSchema, normalizeConfigValues, effectiveValues, publicValues, scrubSecrets, checkManifest, CONFIG_TYPES, inQuietHours, absoluteLink, defaultRules, NotifyError, STATUSES, MODES, DEDUPE_MS,
};
