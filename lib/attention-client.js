// A small HTTP client for the T-Attention API (/api/attention), shared by the `t-attention` CLI
// (scripts/t-attention.js) and the listener plugins (plugins/listeners/*). Node built-ins only, no dependencies,
// so a hook can load it fast and without node_modules (see "T-Attention: CLI and Claude listener" in DESIGN.md).
//
// Config resolution: flags (--url / --token) > env TA_ATTENTION_URL / TA_ATTENTION_TOKEN >
// <data folder>/attention-client.json {url, token} (mode 600, written by `t-attention login`).
// The data folder is resolved like lib/data-home.js: TAGENT_HOME, then the old name T_AGENT_DATA_DIR, else ~/.tagent.
// lib/data-home.js itself is not required here because it loads dotenv and the database helpers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const CONFIG_FILE = 'attention-client.json';
const API_BASE = '/api/attention';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;

function expandHome(value, homedir) {
  return value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

function dataHome({ env = process.env, homedir = os.homedir } = {}) {
  for (const name of ['TAGENT_HOME', 'T_AGENT_DATA_DIR']) {
    const value = String(env[name] || '').trim();
    if (value) return path.resolve(expandHome(value, homedir));
  }
  return path.join(homedir(), '.tagent');
}

function configPath(options = {}) {
  return path.join(dataHome(options), CONFIG_FILE);
}

function readConfigFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Each of url and token is taken from the first layer that has it.
function resolveConfig({ flags = {}, env = process.env, homedir = os.homedir } = {}) {
  const file = configPath({ env, homedir });
  const stored = readConfigFile(file) || {};
  const pick = (flag, envName, key) => {
    if (flags[flag] !== undefined && String(flags[flag]).trim()) return { value: String(flags[flag]).trim(), from: 'flag' };
    if (String(env[envName] || '').trim()) return { value: String(env[envName]).trim(), from: 'env' };
    if (typeof stored[key] === 'string' && stored[key].trim()) return { value: stored[key].trim(), from: 'file' };
    return { value: '', from: null };
  };
  const url = pick('url', 'TA_ATTENTION_URL', 'url');
  const token = pick('token', 'TA_ATTENTION_TOKEN', 'token');
  return { url: url.value, token: token.value, urlFrom: url.from, tokenFrom: token.from, configPath: file };
}

function normalizeUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

// Writes the config file with mode 600 in a 700 folder (atomic rename). Returns the path.
function writeConfig({ url, token }, options = {}) {
  const file = configPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  return file;
}

class AttentionClientError extends Error {
  // kind: 'config' | 'auth' | 'not_found' | 'invalid' | 'conflict' | 'server' | 'network' | 'timeout'
  constructor(kind, message, { status = 0, code = '', body = null } = {}) {
    super(message);
    this.name = 'AttentionClientError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function kindForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'invalid';
  return 'server';
}

function createClient({ url, token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = normalizeUrl(url);
  if (!base) throw new AttentionClientError('config', url ? `The server URL is not a valid http(s) URL: ${url}` : 'No server URL is configured');
  if (!token) throw new AttentionClientError('config', 'No access token is configured');

  // One request. Resolves {status, body}; rejects with AttentionClientError for transport errors and status >= 400.
  function request(method, apiPath, { body, query, deadline } = {}) {
    const target = new URL(base + API_BASE + apiPath);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, String(value));
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const left = deadline ? Math.max(1, deadline - Date.now()) : timeoutMs;
    const wait = Math.min(timeoutMs, left);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
      const req = transport.request(target, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { req.destroy(); finish(reject, new AttentionClientError('server', 'The server response is too large')); return; }
          chunks.push(chunk);
        });
        res.on('error', error => finish(reject, new AttentionClientError('network', `Network error: ${error.message}`)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (text.trim()) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
          const status = res.statusCode;
          if (status >= 400) {
            const code = parsed && typeof parsed.error === 'string' ? parsed.error : '';
            const message = parsed && typeof parsed.message === 'string' && parsed.message
              ? parsed.message
              : `The server answered HTTP ${status}`;
            finish(reject, new AttentionClientError(kindForStatus(status), message, { status, code, body: parsed }));
            return;
          }
          if (text.trim() && parsed === null) {
            finish(reject, new AttentionClientError('server', `The server did not answer with JSON (HTTP ${status}); check the URL`, { status }));
            return;
          }
          finish(resolve, { status, body: parsed });
        });
      });
      const timer = setTimeout(() => {
        req.destroy();
        finish(reject, new AttentionClientError('timeout', `The server did not answer within ${Math.round(wait / 100) / 10} s`));
      }, wait);
      req.on('error', error => finish(reject, new AttentionClientError('network', `Cannot reach the server: ${error.code || error.message}`)));
      req.end(payload || undefined);
    });
  }

  const enc = encodeURIComponent;
  return {
    base,
    request,
    list: (query = {}, opts = {}) => request('GET', '', { query, ...opts }).then(r => (r.body && r.body.items) || []),
    get: (id, opts = {}) => request('GET', `/${enc(id)}`, opts).then(r => r.body),
    create: (body, opts = {}) => request('POST', '', { body, ...opts }).then(r => r.body),
    update: (id, body, opts = {}) => request('PATCH', `/${enc(id)}`, { body, ...opts }).then(r => r.body),
    upsertByRef: (ref, body, opts = {}) => request('PUT', `/by-ref/${enc(ref)}`, { body, ...opts })
      .then(r => ({ created: r.status === 201, item: r.body })),
    remove: (id, opts = {}) => request('DELETE', `/${enc(id)}`, opts).then(() => true),
    // There is no lookup by external_ref in the API: list (done items too) and match exactly.
    async findByRef(ref, { status, ...opts } = {}) {
      const items = await request('GET', '', { query: { include_done: 1, limit: 1000, status }, ...opts }).then(r => (r.body && r.body.items) || []);
      return items.find(item => item && item.external_ref === ref) || null;
    },
  };
}

module.exports = {
  API_BASE,
  CONFIG_FILE,
  DEFAULT_TIMEOUT_MS,
  AttentionClientError,
  configPath,
  createClient,
  dataHome,
  normalizeUrl,
  readConfigFile,
  resolveConfig,
  writeConfig,
};
