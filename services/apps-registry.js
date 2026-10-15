// App registry: stores "which services exist and how to reach them". PM2 run status and port detection are merged in apps-service.js; this file only handles data and validation.
class AppsError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const FIELDS = ['name', 'port', 'host', 'domain', 'scheme', 'path', 'url', 'description', 'pm2_name'];
const hasControl = value => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function text(value, field, { max, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new AppsError('APP_FIELD_REQUIRED', `${field} cannot be empty`);
    return null;
  }
  if (typeof value !== 'string') throw new AppsError('APP_FIELD_INVALID', `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new AppsError('APP_FIELD_REQUIRED', `${field} cannot be empty`);
    return null;
  }
  if (trimmed.length > max) throw new AppsError('APP_FIELD_TOO_LONG', `${field} cannot exceed ${max} characters`);
  if (hasControl(trimmed)) throw new AppsError('APP_FIELD_INVALID', `${field} contains disallowed control characters`);
  return trimmed;
}

// Only http/https without credentials are accepted: these addresses become clickable links in the UI.
function httpUrl(value, field) {
  const raw = text(value, field, { max: 500 });
  if (raw === null) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new AppsError('APP_URL_INVALID', `${field} is not a valid address`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || /\s/.test(raw)) {
    throw new AppsError('APP_URL_INVALID', `${field} only supports http:// or https:// addresses without credentials`);
  }
  return raw;
}

function port(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : (/^\d{1,5}$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new AppsError('APP_PORT_INVALID', 'Port must be an integer between 1 and 65535');
  return number;
}

function host(value) {
  const raw = text(value, 'IP', { max: 255 });
  if (raw === null) return null;
  if (!/^[A-Za-z0-9.:-]+$/.test(raw)) throw new AppsError('APP_HOST_INVALID', 'An IP may only contain letters, digits, dots, colons and hyphens (no brackets for IPv6)');
  return raw;
}

// A domain may be a bare domain (app.example.com or app.example.com:8443) or a full http(s):// address.
function domain(value) {
  const raw = text(value, 'Domain', { max: 255 });
  if (raw === null) return null;
  if (/^https?:\/\//i.test(raw)) return httpUrl(raw, 'Domain');
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(raw)) throw new AppsError('APP_DOMAIN_INVALID', 'Invalid domain format, e.g. app.example.com or https://app.example.com');
  return raw;
}

function scheme(value) {
  if (value === undefined || value === null || value === '') return 'http';
  if (value !== 'http' && value !== 'https') throw new AppsError('APP_SCHEME_INVALID', 'Protocol must be http or https');
  return value;
}

function pathField(value) {
  if (value === undefined || value === null || value === '') return '/';
  const raw = text(value, 'Path', { max: 300 });
  if (raw === null) return '/';
  if (!raw.startsWith('/') || /\s/.test(raw)) throw new AppsError('APP_PATH_INVALID', 'Path must start with / and contain no whitespace');
  return raw;
}

function normalize(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppsError('APP_BODY_INVALID', 'The request body must be a JSON object');
  const out = {};
  const has = field => Object.prototype.hasOwnProperty.call(input, field);
  if (!partial || has('name')) out.name = text(input.name, 'Name', { max: 64, required: true });
  if (!partial || has('port')) out.port = port(input.port);
  if (!partial || has('host')) out.host = host(input.host);
  if (!partial || has('domain')) out.domain = domain(input.domain);
  if (!partial || has('scheme')) out.scheme = scheme(input.scheme);
  if (!partial || has('path')) out.path = pathField(input.path);
  if (!partial || has('url')) out.url = httpUrl(input.url, 'Address');
  if (!partial || has('description')) out.description = text(input.description, 'Description', { max: 500 });
  if (!partial || has('pm2_name')) out.pm2_name = text(input.pm2_name, 'PM2 process name', { max: 128 });
  return out;
}

function createAppsRegistry({ db }) {
  const row = id => db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
  const byName = name => db.prepare('SELECT * FROM apps WHERE name = ?').get(name);
  const byPm2 = name => db.prepare('SELECT * FROM apps WHERE pm2_name = ?').get(name);
  const clean = app => (app ? { ...app, hidden: Boolean(app.hidden) } : null);

  function write(sql, params) {
    try { return db.prepare(sql).run(...params); }
    catch (error) {
      if (/UNIQUE constraint failed: apps\.name/.test(error.message)) throw new AppsError('APP_NAME_TAKEN', 'An app with this name already exists', 409);
      if (/UNIQUE constraint failed: apps\.pm2_name/.test(error.message)) throw new AppsError('APP_PM2_LINKED', 'This PM2 process is already linked to another app', 409);
      throw error;
    }
  }

  function insert(values, source) {
    const result = write(
      `INSERT INTO apps (name, source, pm2_name, port, host, domain, scheme, path, url, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [values.name, source, values.pm2_name, values.port, values.host, values.domain, values.scheme, values.path, values.url, values.description],
    );
    return row(result.lastInsertRowid);
  }

  function applyUpdate(id, values) {
    const columns = Object.keys(values);
    if (!columns.length) return row(id);
    write(`UPDATE apps SET ${columns.map(column => `${column} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...columns.map(column => values[column]), id]);
    return row(id);
  }

  return {
    AppsError,
    list: ({ includeHidden = false } = {}) => db.prepare(`SELECT * FROM apps ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY name COLLATE NOCASE`).all().map(clean),
    hiddenCount: () => db.prepare('SELECT COUNT(*) AS count FROM apps WHERE hidden = 1').get().count,
    get: id => clean(row(id)),

    create(input) {
      return clean(insert(normalize(input), 'manual'));
    },

    update(id, input) {
      const current = row(id);
      if (!current) throw new AppsError('APP_NOT_FOUND', 'App not found', 404);
      const values = normalize(input, { partial: true });
      // A hidden app that gets edited counts as "needed again" and is shown again.
      if (current.hidden) values.hidden = 0;
      return clean(applyUpdate(id, values));
    },

    // Auto-registered PM2 service: only hidden while still in PM2 (otherwise the next sync would register it again); deleted outright when it is no longer in PM2 or was registered manually/through the API.
    remove(id, { pm2Present = false } = {}) {
      const current = row(id);
      if (!current) throw new AppsError('APP_NOT_FOUND', 'App not found', 404);
      if (current.source === 'pm2' && current.pm2_name && pm2Present) {
        db.prepare('UPDATE apps SET hidden = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        return { deleted: false, hidden: true };
      }
      db.prepare('DELETE FROM apps WHERE id = ?').run(id);
      return { deleted: true, hidden: false };
    },

    restoreHidden() {
      return db.prepare('UPDATE apps SET hidden = 0, updated_at = CURRENT_TIMESTAMP WHERE hidden = 1').run().changes;
    },

    // Program self-registration: idempotent update by PM2 process name (preferred if present) or app name; restarting never creates duplicate records.
    register(input) {
      const values = normalize(input);
      const existing = (values.pm2_name && byPm2(values.pm2_name)) || byName(values.name);
      if (!existing) return { app: clean(insert(values, 'api')), created: true };
      const update = { ...values };
      // Optional fields that are not passed keep their value, so a program that only reports a port does not wipe a hand-entered domain.
      for (const field of FIELDS) {
        if (field !== 'name' && !Object.prototype.hasOwnProperty.call(input, field)) delete update[field];
      }
      if (existing.hidden) update.hidden = 0;
      if (update.name === existing.name) delete update.name;
      return { app: clean(applyUpdate(existing.id, update)), created: false };
    },

    // Auto-register PM2 processes: leave alone if already linked; link an unlinked app of the same name; otherwise create one. Hidden ones are not registered again.
    ensurePm2(name) {
      if (byPm2(name)) return null;
      const sameName = byName(name);
      if (sameName && !sameName.pm2_name) {
        applyUpdate(sameName.id, { pm2_name: name });
        return clean(row(sameName.id));
      }
      if (sameName) return null;
      return clean(insert({ name, port: null, host: null, domain: null, scheme: 'http', path: '/', url: null, description: null, pm2_name: name }, 'pm2'));
    },
  };
}

module.exports = { createAppsRegistry, AppsError, normalize };
