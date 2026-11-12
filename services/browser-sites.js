'use strict';
// The site capability library (browser feature, shared contract v1 section 8): what the model has learnt about each website, so capabilities build
// up over time. A model explores a site with `tcli browser`, discovers its requests and actions with `tcli browser net` / `record`, then writes or
// updates one entry per host here with `tcli site` (services are authored content, not parsed from recordings in v1). The entries sync to linked
// devices (scope "shared", last-writer-wins per site with tombstones) through services/settings-sync.js, so every device shares one library. See
// "Site library" in DESIGN.md.
//
// Storage: system_state rows, one per site (no schema bump, like the browser pairing list the core branch keeps in system_state). The key is
// `browser_site_v1:<host>`; the host is lowercased and has no leading `www.`. Deleting a site removes its row and records a tombstone in the single
// row `browser_sites_tombstones_v1` ({ host: { updated_at, updated_by } }), so the deletion also travels to linked devices. Each entry carries its own
// sync clock (updated_at in ms, updated_by the device name, version), so the sync can merge per site even though it exchanges the whole set.
//
// Secrets never reach storage: redactEntry() runs over every saved entry, and a value that still looks like a token is refused (SITE_HAS_SECRET).
// Redaction and the secret scan live in lib/browser-site-secret, built on the canonical lib/browser-redact the recordings and tcli browser share.
const { redactEntry, hasResidualSecret, residualSecretPath } = require('../lib/browser-site-secret');

const ROW_PREFIX = 'browser_site_v1:';
const TOMBSTONES_KEY = 'browser_sites_tombstones_v1';

// Size limits (contract section 8 fixes the summary; the rest keeps one entry small enough to sync as part of the shared set).
const LIMITS = Object.freeze({
  summaryBytes: 256 * 1024,   // Markdown summary
  titleChars: 200,
  notesBytes: 64 * 1024,
  pages: 200,
  actions: 300,
  apis: 300,
  sources: 500,
  stepsPerAction: 200,
  paramsPerApi: 100,
  stringField: 4096,          // a short field such as pattern, purpose, action name, api name, url, method
  entryBytes: 1024 * 1024,    // the whole entry serialised
  tombstoneMaxAgeMs: 180 * 24 * 60 * 60 * 1000, // old tombstones are pruned on export so the set does not grow forever
});

class BrowserSiteError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = 'BrowserSiteError'; this.code = code; this.statusCode = statusCode; }
}

const byteLength = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');

// ---- Host normalisation ----
const HOST = /^(?=.{1,253}$)(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

// A host like github.com: lowercased, a URL reduced to its hostname, a leading www. and a trailing dot dropped, a port removed. Throws INVALID_SITE.
function normalizeHost(input) {
  if (typeof input !== 'string') throw new BrowserSiteError('INVALID_SITE', 'A site host is required');
  let host = input.trim().toLowerCase();
  if (!host) throw new BrowserSiteError('INVALID_SITE', 'A site host is required');
  if (host.includes('://')) {
    try { host = new URL(host).hostname; } catch { throw new BrowserSiteError('INVALID_SITE', `Not a site host: ${input}`); }
  } else {
    host = host.split('/')[0];
    // Strip a port, but keep an IPv6 literal (which also uses colons) intact.
    if (!host.includes('[') && host.split(':').length === 2) host = host.split(':')[0];
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 literal
  if (!host) throw new BrowserSiteError('INVALID_SITE', `Not a site host: ${input}`);
  const ok = HOST.test(host) || IPV4.test(host) || host.includes(':') /* IPv6 */;
  if (!ok) throw new BrowserSiteError('INVALID_SITE', `Not a site host: ${input}`);
  return host;
}

// ---- Validation of the authored shape ----
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function str(value, field, { max = LIMITS.stringField, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BrowserSiteError('INVALID_SITE', `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new BrowserSiteError('INVALID_SITE', `${field} must be text`);
  if (byteLength(value) > max) throw new BrowserSiteError('SITE_TOO_LARGE', `${field} is too large (over ${max} bytes)`);
  return value;
}

function arr(value, field, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BrowserSiteError('INVALID_SITE', `${field} must be a list`);
  if (value.length > max) throw new BrowserSiteError('SITE_TOO_LARGE', `${field} has too many items (over ${max})`);
  return value;
}

// Builds the canonical, validated entry from an author's object. Unknown top-level keys are dropped. The sync clock fields are set by the caller.
function buildEntry(host, input) {
  if (!isObject(input)) throw new BrowserSiteError('INVALID_SITE', 'The entry must be an object');
  const entry = { site: host };
  const title = str(input.title, 'title', { max: LIMITS.titleChars * 4 });
  if (title !== undefined) {
    if ([...title].length > LIMITS.titleChars) throw new BrowserSiteError('SITE_TOO_LARGE', `title is too long (over ${LIMITS.titleChars} characters)`);
    entry.title = title;
  }
  const summary = str(input.summary, 'summary', { max: LIMITS.summaryBytes });
  if (summary !== undefined) entry.summary = summary;

  entry.pages = arr(input.pages, 'pages', LIMITS.pages).map((page, i) => {
    if (!isObject(page)) throw new BrowserSiteError('INVALID_SITE', `pages[${i}] must be an object`);
    const out = {};
    const pattern = str(page.pattern, `pages[${i}].pattern`, { required: true });
    out.pattern = pattern;
    const purpose = str(page.purpose, `pages[${i}].purpose`);
    if (purpose !== undefined) out.purpose = purpose;
    return out;
  });

  entry.actions = arr(input.actions, 'actions', LIMITS.actions).map((action, i) => {
    if (!isObject(action)) throw new BrowserSiteError('INVALID_SITE', `actions[${i}] must be an object`);
    const out = { name: str(action.name, `actions[${i}].name`, { required: true }) };
    const description = str(action.description, `actions[${i}].description`);
    if (description !== undefined) out.description = description;
    out.steps = arr(action.steps, `actions[${i}].steps`, LIMITS.stepsPerAction).map((step, j) => {
      const value = str(step, `actions[${i}].steps[${j}]`, { required: true });
      return value;
    });
    if (action.selectors !== undefined && action.selectors !== null) {
      if (!isObject(action.selectors)) throw new BrowserSiteError('INVALID_SITE', `actions[${i}].selectors must be an object`);
      const selectors = {};
      for (const [name, value] of Object.entries(action.selectors)) selectors[str(name, `actions[${i}].selectors key`, { required: true })] = str(value, `actions[${i}].selectors.${name}`, { required: true });
      out.selectors = selectors;
    }
    return out;
  });

  entry.apis = arr(input.apis, 'apis', LIMITS.apis).map((api, i) => {
    if (!isObject(api)) throw new BrowserSiteError('INVALID_SITE', `apis[${i}] must be an object`);
    const out = { name: str(api.name, `apis[${i}].name`, { required: true }) };
    const method = str(api.method, `apis[${i}].method`);
    if (method !== undefined) out.method = method.toUpperCase();
    const url = str(api.url, `apis[${i}].url`);
    if (url !== undefined) out.url = url;
    const description = str(api.description, `apis[${i}].description`);
    if (description !== undefined) out.description = description;
    const auth = str(api.auth, `apis[${i}].auth`);
    if (auth !== undefined) out.auth = auth;
    out.params = arr(api.params, `apis[${i}].params`, LIMITS.paramsPerApi).map((param, j) => {
      if (typeof param === 'string') return str(param, `apis[${i}].params[${j}]`);
      if (!isObject(param)) throw new BrowserSiteError('INVALID_SITE', `apis[${i}].params[${j}] must be text or an object`);
      const p = { name: str(param.name, `apis[${i}].params[${j}].name`, { required: true }) };
      const pDesc = str(param.description, `apis[${i}].params[${j}].description`);
      if (pDesc !== undefined) p.description = pDesc;
      if (param.required !== undefined) p.required = Boolean(param.required);
      return p;
    });
    const requestExample = str(api.request_example, `apis[${i}].request_example`, { max: LIMITS.notesBytes });
    if (requestExample !== undefined) out.request_example = requestExample;
    const responseShape = str(api.response_shape, `apis[${i}].response_shape`, { max: LIMITS.notesBytes });
    if (responseShape !== undefined) out.response_shape = responseShape;
    return out;
  });

  const notes = str(input.notes, 'notes', { max: LIMITS.notesBytes });
  if (notes !== undefined) entry.notes = notes;

  entry.sources = arr(input.sources, 'sources', LIMITS.sources).map((source, i) => {
    if (!isObject(source)) throw new BrowserSiteError('INVALID_SITE', `sources[${i}] must be an object`);
    const out = {};
    const recordingId = str(source.recording_id, `sources[${i}].recording_id`);
    if (recordingId !== undefined) out.recording_id = recordingId;
    if (source.at !== undefined && source.at !== null) {
      const at = Number(source.at);
      if (!Number.isFinite(at)) throw new BrowserSiteError('INVALID_SITE', `sources[${i}].at must be a time`);
      out.at = at;
    }
    return out;
  });

  if (byteLength(entry) > LIMITS.entryBytes) throw new BrowserSiteError('SITE_TOO_LARGE', `The whole entry is too large (over ${LIMITS.entryBytes} bytes)`);
  return entry;
}

// ---- Per-site last-writer-wins ----
// a beats b. Both { updated_at, updated_by }. Later time wins; a tie goes to the greater device name, as in settings-sync.
function newer(a, b) {
  const aAt = Number(a && a.updated_at) || 0;
  const bAt = Number(b && b.updated_at) || 0;
  if (aAt !== bAt) return aAt > bAt;
  return String((a && a.updated_by) || '') > String((b && b.updated_by) || '');
}

function createBrowserSites({
  db = require('../db'),
  now = Date.now,
  // The name that stamps updated_by (this device's engine name). Kept short.
  deviceName = () => { try { return require('./engine-identity').getEngineIdentity().name || 'this device'; } catch { return 'this device'; } },
  // Called after a local change so settings-sync starts a round (importFromSync must not call it, or sync would loop).
  settingChanged = group => { try { require('./settings-sync-store').settingChanged(group); } catch { /* sync not loaded in a test */ } },
} = {}) {
  const rowKey = host => `${ROW_PREFIX}${host}`;

  function readRow(host) {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(rowKey(host));
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }
  function writeRow(host, entry) {
    const text = JSON.stringify(entry);
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(rowKey(host), text);
  }
  const deleteRow = host => { db.prepare('DELETE FROM system_state WHERE key = ?').run(rowKey(host)); };

  function readTombstones() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(TOMBSTONES_KEY);
    if (!row) return {};
    try { const value = JSON.parse(row.value); return isObject(value) ? value : {}; } catch { return {}; }
  }
  function writeTombstones(map) {
    const entries = Object.entries(map).filter(([, meta]) => isObject(meta) && Number.isFinite(Number(meta.updated_at)));
    if (!entries.length) { db.prepare('DELETE FROM system_state WHERE key = ?').run(TOMBSTONES_KEY); return; }
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(TOMBSTONES_KEY, JSON.stringify(Object.fromEntries(entries)));
  }

  function allHosts() {
    return db.prepare('SELECT key FROM system_state WHERE key LIKE ?').all(`${ROW_PREFIX}%`).map(row => row.key.slice(ROW_PREFIX.length));
  }

  // ---- Reads ----
  function get(site) {
    const host = normalizeHost(site);
    const entry = readRow(host);
    return entry && !entry.deleted ? entry : null;
  }

  const SUMMARY_EXCERPT = 280;
  function summaryOf(entry) {
    const text = typeof entry.summary === 'string' ? entry.summary.replace(/\s+/g, ' ').trim() : '';
    return text.length > SUMMARY_EXCERPT ? `${text.slice(0, SUMMARY_EXCERPT)}…` : text;
  }
  function listItem(entry) {
    return {
      site: entry.site,
      title: entry.title || entry.site,
      summary: summaryOf(entry),
      pages: Array.isArray(entry.pages) ? entry.pages.length : 0,
      actions: Array.isArray(entry.actions) ? entry.actions.length : 0,
      apis: Array.isArray(entry.apis) ? entry.apis.length : 0,
      updated_at: entry.updated_at || 0,
      updated_by: entry.updated_by || null,
      version: entry.version || 1,
    };
  }

  function list({ query } = {}) {
    const items = allHosts().map(host => readRow(host)).filter(entry => entry && !entry.deleted).map(listItem);
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const filtered = q ? items.filter(item => item.site.includes(q) || (item.title && item.title.toLowerCase().includes(q)) || (item.summary && item.summary.toLowerCase().includes(q))) : items;
    return filtered.sort((a, b) => a.site.localeCompare(b.site));
  }

  // Full-text over the host, title, summary, action names / descriptions / steps and api names / urls / descriptions. Returns { site, title, matches }.
  function search(text) {
    const needle = typeof text === 'string' ? text.trim().toLowerCase() : '';
    if (!needle) throw new BrowserSiteError('INVALID_SEARCH', 'A search text is required');
    const results = [];
    for (const host of allHosts()) {
      const entry = readRow(host);
      if (!entry || entry.deleted) continue;
      const matches = [];
      const consider = (where, value) => {
        if (typeof value === 'string' && value.toLowerCase().includes(needle)) {
          const at = value.toLowerCase().indexOf(needle);
          const start = Math.max(0, at - 40);
          const snippet = `${start > 0 ? '…' : ''}${value.slice(start, at + needle.length + 40).replace(/\s+/g, ' ').trim()}${at + needle.length + 40 < value.length ? '…' : ''}`;
          matches.push({ where, snippet });
        }
      };
      consider('site', entry.site);
      consider('title', entry.title);
      consider('summary', entry.summary);
      for (const action of entry.actions || []) {
        consider(`action:${action.name}`, action.name);
        consider(`action:${action.name}`, action.description);
        for (const step of action.steps || []) consider(`action:${action.name}`, step);
      }
      for (const api of entry.apis || []) {
        consider(`api:${api.name}`, api.name);
        consider(`api:${api.name}`, api.url);
        consider(`api:${api.name}`, api.description);
      }
      consider('notes', entry.notes);
      if (matches.length) results.push({ site: entry.site, title: entry.title || entry.site, matches: matches.slice(0, 8) });
    }
    return results.sort((a, b) => a.site.localeCompare(b.site));
  }

  // ---- Writes ----
  // Stamps the sync clock. updated_at never goes backwards for a host, so an edit on the same millisecond still wins over the stored one.
  function stamp(host, entry, by) {
    const previous = readRow(host);
    const previousAt = previous && !previous.deleted ? Number(previous.updated_at) || 0 : 0;
    const previousTomb = readTombstones()[host];
    const floor = Math.max(previousAt, previousTomb ? Number(previousTomb.updated_at) || 0 : 0);
    const at = Math.max(now(), floor + 1);
    return { ...entry, updated_at: at, updated_by: by, version: (previous && Number(previous.version) ? Number(previous.version) : 0) + 1 };
  }

  // Redacts, then refuses if a value still looks like a token.
  function guard(entry) {
    const redacted = redactEntry(entry);
    if (hasResidualSecret(redacted)) {
      throw new BrowserSiteError('SITE_HAS_SECRET', `The entry still holds a value that looks like a secret (${residualSecretPath(redacted)}); redact it before saving`);
    }
    return redacted;
  }

  // Saves a whole entry (the model's `tcli site save`). Replaces any existing one and clears a tombstone for the host.
  function save(site, input, { by = deviceName() } = {}) {
    const host = normalizeHost(site);
    const built = buildEntry(host, input);
    const redacted = guard(built);
    const stamped = stamp(host, redacted, by);
    writeRow(host, stamped);
    const tombstones = readTombstones();
    if (tombstones[host]) { delete tombstones[host]; writeTombstones(tombstones); }
    settingChanged('browser-sites');
    return stamped;
  }

  // Merges changes into an existing entry (the model's `tcli site edit`). `changes` is a partial entry; a field set to null is cleared. Without an
  // existing entry it starts from an empty one (edit can create).
  function edit(site, changes, { by = deviceName() } = {}) {
    const host = normalizeHost(site);
    if (!isObject(changes)) throw new BrowserSiteError('INVALID_SITE', 'The changes must be an object');
    const current = readRow(host);
    const base = current && !current.deleted ? current : {};
    const merged = { ...base };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    delete merged.updated_at; delete merged.updated_by; delete merged.version; delete merged.deleted;
    return save(host, merged, { by });
  }

  // Deletes a site: removes the row and records a tombstone so the deletion syncs.
  function remove(site, { by = deviceName() } = {}) {
    const host = normalizeHost(site);
    const current = readRow(host);
    const existed = Boolean(current && !current.deleted);
    const tombstones = readTombstones();
    const floor = Math.max(current ? Number(current.updated_at) || 0 : 0, tombstones[host] ? Number(tombstones[host].updated_at) || 0 : 0);
    deleteRow(host);
    tombstones[host] = { updated_at: Math.max(now(), floor + 1), updated_by: by };
    writeTombstones(tombstones);
    settingChanged('browser-sites');
    return { removed: existed, site: host };
  }

  // ---- Settings sync adapters (registry entry 'browser-sites', scope 'shared') ----
  // The whole shared set: every live entry and the tombstones. The sync hashes this value; per-site merge happens on import, so two devices that each
  // edit a different site keep both. Old tombstones are pruned so the set does not grow without bound.
  function exportForSync() {
    const sites = {};
    for (const host of allHosts()) {
      const entry = readRow(host);
      if (entry && !entry.deleted) sites[host] = entry;
    }
    const tombstones = {};
    const cutoff = now() - LIMITS.tombstoneMaxAgeMs;
    let pruned = false;
    const stored = readTombstones();
    for (const [host, meta] of Object.entries(stored)) {
      const at = Number(meta && meta.updated_at) || 0;
      if (sites[host] || at < cutoff) { pruned = true; continue; } // a live entry shadows a tombstone; an old tombstone is dropped
      tombstones[host] = { updated_at: at, updated_by: meta.updated_by || null };
    }
    if (pruned) writeTombstones(tombstones);
    if (!Object.keys(sites).length && !Object.keys(tombstones).length) return null;
    return { sites, tombstones };
  }

  // Applies a peer's set: per host, the newer of (local live, local tombstone, incoming live, incoming tombstone) wins. Never calls settingChanged
  // (the sync forwards applied values itself). Returns true when anything changed, so settings-sync's hash moves and the merge travels on.
  function importFromSync(value) {
    if (value === null || value === undefined) return false; // a peer that never had the feature: nothing to do
    if (!isObject(value)) throw new BrowserSiteError('INVALID_SITE', 'The synced value must be an object', 400);
    const incomingSites = isObject(value.sites) ? value.sites : {};
    const incomingTombs = isObject(value.tombstones) ? value.tombstones : {};
    const tombstones = readTombstones();
    let changed = false;

    const localVersion = host => {
      const entry = readRow(host);
      if (entry && !entry.deleted) return { kind: 'live', meta: entry };
      if (tombstones[host]) return { kind: 'tomb', meta: tombstones[host] };
      return { kind: 'none', meta: { updated_at: 0, updated_by: '' } };
    };

    for (const [rawHost, incoming] of Object.entries(incomingSites)) {
      if (!isObject(incoming)) continue;
      let host;
      try { host = normalizeHost(rawHost); } catch { continue; }
      // Trust a peer's redaction but run ours again; a peer that still leaked a token is dropped, not stored.
      const redacted = redactEntry(incoming);
      if (hasResidualSecret(redacted)) continue;
      const local = localVersion(host);
      if (newer({ updated_at: redacted.updated_at, updated_by: redacted.updated_by }, local.meta)) {
        writeRow(host, { ...redacted, site: host });
        if (tombstones[host]) delete tombstones[host];
        changed = true;
      }
    }
    for (const [rawHost, meta] of Object.entries(incomingTombs)) {
      if (!isObject(meta)) continue;
      let host;
      try { host = normalizeHost(rawHost); } catch { continue; }
      const local = localVersion(host);
      if (newer(meta, local.meta)) {
        deleteRow(host);
        tombstones[host] = { updated_at: Number(meta.updated_at) || 0, updated_by: meta.updated_by || null };
        changed = true;
      }
    }
    if (changed) writeTombstones(tombstones);
    return changed;
  }

  return {
    list, get, save, edit, remove, search,
    exportForSync, importFromSync,
    normalizeHost, buildEntry,
    LIMITS,
  };
}

let shared = null;
function getBrowserSites() {
  if (!shared) shared = createBrowserSites();
  return shared;
}

// A service bound to a given db (for settings-sync, which passes its own db, and for tests). Cached per db so repeated calls reuse one service.
const byDb = new WeakMap();
function sitesFor(db) {
  if (!db) return getBrowserSites();
  let service = byDb.get(db);
  if (!service) { service = createBrowserSites({ db }); byDb.set(db, service); }
  return service;
}

// The settings-sync registry adapters (services/settings-sync.js uses `module().exportForSync(deps, owner)` / `importFromSync(deps, owner, value)`).
// They carry no raw secrets, so the value crosses a link as it is. The value is the whole shared set, merged per site on import (last-writer-wins with
// tombstones): a null from a peer that never had the feature is a no-op, never a wipe (deletions travel as tombstones inside the value).
const exportForSync = (deps, owner) => sitesFor(deps && deps.db).exportForSync(owner);
const importFromSync = (deps, owner, value) => sitesFor(deps && deps.db).importFromSync(value);

module.exports = { createBrowserSites, getBrowserSites, sitesFor, exportForSync, importFromSync, BrowserSiteError, normalizeHost, LIMITS, ROW_PREFIX, TOMBSTONES_KEY };
