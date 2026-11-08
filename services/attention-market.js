// T-Attention plugin marketplace (see "Plugin marketplace" in DESIGN.md): find plugins in marketplace indexes, download one from Git into a
// temp folder, show what it contains, and only after an explicit confirm move it into <data folder>/plugins/<kind>s/<name>/ pinned to a commit.
//
// Security (plugins run code inside the server or inside the user's tools):
// - Nothing of a prepared download is required or run before the confirm; prepare only reads files (manifest.json, package.json, text).
// - Git runs with GIT_TERMINAL_PROMPT=0, ssh BatchMode, GIT_ALLOW_PROTOCOL (https and ssh only; file only with the test option allowFileUrls),
//   -c protocol.file.allow=never, core.hooksPath=/dev/null, no submodules, no tags, depth 1, LFS smudge off, a time limit and a size limit
//   on the clone folder while it runs.
// - URLs: https:// without user name or password, or git@host:path; refs and subfolders are checked (no "..", no option-like values).
// - The plugin folder: at most maxFiles files and maxBytes bytes, only files, folders and symlinks that stay inside it; nothing outside
//   the subfolder is copied; the copy (without .git) is moved into place with one rename.
// - Names: ^[a-z0-9][a-z0-9-]{0,40}$; a built-in name, or a name already linked or installed as another kind, is refused.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('../lib/plugin-store');
const { checkManifest } = require('./attention-notify');

const MiB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({ maxBytes: 20 * MiB, maxFiles: 2000, maxDepth: 20, cloneMs: 60000, lsRemoteMs: 20000, indexBytes: MiB, indexMs: 10000 });
const PREPARE_TTL_MS = 10 * 60 * 1000;
const INDEX_TTL_MS = 10 * 60 * 1000;
const MAX_EXTRA_SOURCES = 10;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA = /^[0-9a-f]{40}$/;
const SCP_URL = /^git@[A-Za-z0-9][A-Za-z0-9.-]{0,252}:[A-Za-z0-9][A-Za-z0-9._/~-]{0,300}$/;
const RISKY_MODULES = {
  child_process: 'Can run other programs (child_process)',
  net: 'Can open network connections', dgram: 'Can open network connections', tls: 'Can open network connections',
  http: 'Can open network connections', https: 'Can open network connections', http2: 'Can open network connections', dns: 'Can open network connections',
  worker_threads: 'Starts threads or runs code dynamically', vm: 'Starts threads or runs code dynamically', cluster: 'Starts threads or runs code dynamically',
};

class MarketError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = 'MarketError'; this.code = code; this.statusCode = statusCode; }
}
const invalidSource = message => new MarketError('INVALID_SOURCE', message, 400);
const invalidPlugin = message => new MarketError('INVALID_PLUGIN', message, 400);

// ---------- checks ----------
function checkUrl(value, { allowFileUrls = false } = {}) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url.length > 500 || url.startsWith('-') || /[\s\u0000-\u001f]/.test(url)) throw invalidSource('Give a Git URL (https:// or git@host:path)');
  if (SCP_URL.test(url)) {
    if (url.includes('..')) throw invalidSource('The Git URL is not valid');
    return url;
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw invalidSource('The Git URL must start with https:// or git@'); }
  if (parsed.protocol === 'file:' && allowFileUrls) return url;
  if (parsed.protocol !== 'https:') throw invalidSource('Only https:// and git@ Git URLs are allowed');
  if (parsed.username || parsed.password) throw invalidSource('The Git URL cannot contain a user name or password');
  if (!parsed.hostname || parsed.search || parsed.hash) throw invalidSource('The Git URL is not valid');
  return url;
}

function checkRef(value) {
  if (value === undefined || value === null || value === '') return null;
  const ref = String(value).trim();
  if (!REF.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('.lock') || ref.endsWith('/') || ref.includes('@{')) throw invalidSource('The ref must be a branch, tag or commit name');
  return ref;
}

function checkSubfolder(value) {
  if (value === undefined || value === null || value === '' || value === '.' || value === '/') return '';
  const text = String(value).trim().replace(/^\/+|\/+$/g, '');
  const parts = text.split('/');
  if (text.length > 200 || parts.length > 10 || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..' || part === '.git')) {
    throw invalidSource('The subfolder must be a relative path inside the repository');
  }
  return parts.join('/');
}

// "https://host/repo.git#ref:subfolder", "git@host:o/r.git#ref", "url#:subfolder" -> { url, ref, path }.
function parseGitSpec(text, options) {
  const raw = String(text || '').trim();
  const hash = raw.indexOf('#');
  const base = hash === -1 ? raw : raw.slice(0, hash);
  const fragment = hash === -1 ? '' : raw.slice(hash + 1);
  const colon = fragment.indexOf(':');
  const ref = colon === -1 ? fragment : fragment.slice(0, colon);
  const sub = colon === -1 ? '' : fragment.slice(colon + 1);
  return { url: checkUrl(base, options), ref: checkRef(ref), path: checkSubfolder(sub) };
}

const shortText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

// manifest.json of a download or a linked folder: required name, version, kind, description; notifier: index.js and a valid config schema;
// listener: an entry file inside the folder. Returns the clean summary for the preview.
function checkPluginManifest(folder) {
  const file = path.join(folder, 'manifest.json');
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw invalidPlugin('manifest.json is missing'); }
  if (!stat.isFile()) throw invalidPlugin('manifest.json must be a file');
  if (stat.size > 64 * 1024) throw invalidPlugin('manifest.json is too large');
  const text = fs.readFileSync(file, 'utf8');
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw invalidPlugin('manifest.json is not valid JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalidPlugin('manifest.json is not an object');
  if (typeof manifest.name !== 'string' || !store.NAME.test(manifest.name)) throw invalidPlugin('manifest.json needs a name of lowercase letters, digits and - (at most 41 characters)');
  if (typeof manifest.version !== 'string' || !manifest.version.trim() || manifest.version.length > 40) throw invalidPlugin('manifest.json needs a version');
  if (!store.KINDS.includes(manifest.kind)) throw invalidPlugin('manifest.json needs a kind: listener or notifier');
  if (typeof manifest.description !== 'string' || !manifest.description.trim() || manifest.description.length > 500) throw invalidPlugin('manifest.json needs a description (at most 500 characters)');
  const clean = { name: manifest.name, version: manifest.version.trim(), kind: manifest.kind, description: manifest.description.trim() };
  if (manifest.kind === 'notifier') {
    let checked;
    try { checked = checkManifest(manifest); } catch (error) { throw invalidPlugin(error.message); }
    if (!isFile(path.join(folder, 'index.js'))) throw invalidPlugin('a notifier needs index.js');
    clean.config = checked.config;
    clean.test = checked.test;
    clean.customUi = checked.customUi;
  } else {
    const entry = typeof manifest.entry === 'string' ? manifest.entry : '';
    let entryPath = '';
    try { entryPath = checkSubfolder(entry); } catch { throw invalidPlugin('the listener entry must be a file inside the plugin'); }
    if (!entryPath || !isFile(path.join(folder, entryPath))) throw invalidPlugin('a listener needs an entry file (manifest.json "entry")');
    clean.entry = entryPath;
    clean.events = Array.isArray(manifest.events) ? manifest.events.filter(event => typeof event === 'string').map(event => event.slice(0, 80)).slice(0, 50) : [];
  }
  return { manifest: clean, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

function isFile(file) {
  try { return fs.lstatSync(file).isFile(); } catch { return false; }
}

const inside = (root, target) => target === root || target.startsWith(root + path.sep);

// Walks a plugin folder: [{ path, size, type: 'file'|'dir'|'symlink', link? }]. Refuses links that leave it, other file types, too many
// files, too many bytes and too deep folders. .git is skipped.
function walkPlugin(root, limits) {
  const realRoot = fs.realpathSync(root);
  const out = [];
  let files = 0;
  let bytes = 0;
  const visit = (dir, rel, depth) => {
    if (depth > limits.maxDepth) throw invalidPlugin('the plugin folders are nested too deeply');
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (/[\u0000-\u001f\\]/.test(entry.name)) throw invalidPlugin('a file name has control characters or a backslash');
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(full);
        const target = path.resolve(path.dirname(full), link);
        let real = target;
        try { real = fs.realpathSync(target); } catch { /* a dangling link is checked by its text */ }
        if (path.isAbsolute(link) || !inside(path.resolve(root), target) || !inside(realRoot, real)) throw invalidPlugin(`${relPath} is a link that points outside the plugin`);
        files += 1;
        out.push({ path: relPath, size: 0, type: 'symlink', link });
      } else if (stat.isDirectory()) {
        out.push({ path: relPath, size: 0, type: 'dir' });
        visit(full, relPath, depth + 1);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        out.push({ path: relPath, size: stat.size, type: 'file', mode: stat.mode });
      } else {
        throw invalidPlugin(`${relPath} is not a regular file`);
      }
      if (files > limits.maxFiles) throw invalidPlugin(`the plugin has more than ${limits.maxFiles} files`);
      if (bytes > limits.maxBytes) throw invalidPlugin(`the plugin is larger than ${Math.round(limits.maxBytes / MiB)} MiB`);
    }
  };
  visit(root, '', 0);
  return { entries: out, files, bytes };
}

function copyPlugin(from, to, entries) {
  fs.mkdirSync(to, { recursive: true, mode: 0o755 });
  for (const entry of entries) {
    const target = path.join(to, ...entry.path.split('/'));
    if (entry.type === 'dir') fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    else if (entry.type === 'symlink') fs.symlinkSync(entry.link, target);
    else {
      fs.copyFileSync(path.join(from, ...entry.path.split('/')), target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, (entry.mode & 0o111) ? 0o755 : 0o644);
    }
  }
}

function fileHashes(root, entries) {
  const out = new Map();
  for (const entry of entries) {
    if (entry.type === 'dir' || entry.path === store.INSTALL_FILE) continue;
    const full = path.join(root, ...entry.path.split('/'));
    out.set(entry.path, entry.type === 'symlink' ? `link:${entry.link}` : crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
  return out;
}

// Names of risky built-in modules a plugin's code requires or imports (a simple search of the text, not a proof).
function riskyWarnings(root, entries) {
  const found = new Set();
  let usesFetch = false;
  let read = 0;
  const pattern = /(?:require\s*\(\s*|from\s+|import\s*\(\s*|import\s+)['"](?:node:)?([a-z_0-9]+)(?:\/[^'"]*)?['"]/g;
  for (const entry of entries) {
    if (entry.type !== 'file' || !/\.(?:c|m)?js$/.test(entry.path) || entry.path.split('/').includes('node_modules')) continue;
    if (read > 8 * MiB) break;
    const text = fs.readFileSync(path.join(root, ...entry.path.split('/')), 'utf8');
    read += text.length;
    for (const match of text.matchAll(pattern)) if (RISKY_MODULES[match[1]]) found.add(match[1]);
    if (/\bfetch\s*\(/.test(text)) usesFetch = true;
  }
  const warnings = new Map();
  for (const name of [...found].sort()) {
    const text = RISKY_MODULES[name];
    warnings.set(text, [...(warnings.get(text) || []), name]);
  }
  if (usesFetch) warnings.set(RISKY_MODULES.http, [...(warnings.get(RISKY_MODULES.http) || []), 'fetch']);
  return [...warnings.entries()].map(([text, names]) => (text.includes('(') ? text : `${text} (${names.join(', ')})`));
}

function packageInfo(root, entries) {
  if (!entries.some(entry => entry.path === 'package.json' && entry.type === 'file')) return { hasPackageJson: false, dependencies: [], warning: null };
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { pkg = null; }
  const names = new Set();
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (pkg && pkg[key] && typeof pkg[key] === 'object') for (const name of Object.keys(pkg[key])) names.add(String(name).slice(0, 100));
  }
  const vendored = entries.some(entry => entry.path === 'node_modules' && entry.type === 'dir');
  const dependencies = [...names].sort().slice(0, 100);
  const warning = dependencies.length && !vendored ? 'needs dependencies; not supported (plugins must have no dependencies or include them)' : null;
  return { hasPackageJson: true, dependencies, warning };
}

// ---------- index ----------
function checkIndex(data, url, options) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.plugins)) throw new Error('the index has no "plugins" list');
  const seen = new Set();
  const plugins = [];
  for (const raw of data.plugins.slice(0, 1000)) {
    try {
      if (!raw || typeof raw !== 'object' || !store.NAME.test(String(raw.name)) || !store.KINDS.includes(raw.kind) || seen.has(raw.name)) continue;
      const entry = {
        name: raw.name, kind: raw.kind, description: shortText(raw.description, 500) || '', version: shortText(raw.version, 40),
        repo: null, path: '', ref: null, homepage: null, author: shortText(raw.author, 100),
        tags: Array.isArray(raw.tags) ? raw.tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim().slice(0, 30)).slice(0, 10) : [],
        builtIn: raw.builtIn === true, index: url,
      };
      if (!entry.builtIn) {
        entry.repo = checkUrl(raw.repo, options);
        entry.path = checkSubfolder(raw.path);
        entry.ref = checkRef(raw.ref);
      }
      if (typeof raw.homepage === 'string') {
        try { const home = new URL(raw.homepage); if (home.protocol === 'https:' && !home.username && !home.password) entry.homepage = home.href; } catch { /* left out */ }
      }
      seen.add(entry.name);
      plugins.push(entry);
    } catch { /* an invalid entry is left out */ }
  }
  return { name: shortText(data.name, 100), plugins };
}

function defaultFetchIndex(url, { timeoutMs = DEFAULT_LIMITS.indexMs, maxBytes = DEFAULT_LIMITS.indexBytes } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { reject(new Error('not a URL')); return; }
    if (parsed.protocol !== 'https:') { reject(new Error('only https indexes are read')); return; }
    const req = require('node:https').get(parsed, { headers: { Accept: 'application/json', 'User-Agent': 'T-Agent' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { req.destroy(new Error('the index is too large')); return; } chunks.push(chunk); });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('the index is not valid JSON')); } });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

function checkSourceUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  let parsed;
  try { parsed = new URL(text); } catch { throw invalidSource('An index address must be an https:// URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || text.length > 500) throw invalidSource('An index address must be an https:// URL without user name or password');
  return parsed.href;
}

// ---------- git ----------
const CLEAN_GIT_ENV = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|NAMESPACE|CEILING_DIRECTORIES|EXEC_PATH|TEMPLATE_DIR|PROXY_COMMAND)$/;

function gitEnv(base, allowFileUrls) {
  const env = {};
  for (const [key, value] of Object.entries(base || {})) if (!CLEAN_GIT_ENV.test(key)) env[key] = value;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  env.GIT_LFS_SKIP_SMUDGE = '1';
  env.GIT_ALLOW_PROTOCOL = allowFileUrls ? 'https:ssh:file' : 'https:ssh';
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=20';
  return env;
}

function folderBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else { try { total += fs.lstatSync(full).size; } catch { /* gone */ } }
    }
  }
  return total;
}

function createGit({ git = 'git', env = process.env, allowFileUrls = false }) {
  const config = [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', `protocol.file.allow=${allowFileUrls ? 'always' : 'never'}`,
    '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'core.symlinks=true',
    '-c', 'init.defaultBranch=main', '-c', 'advice.detachedHead=false', '-c', 'credential.interactive=false',
  ];
  // Runs git; rejects with MarketError GIT_FAILED on a non-zero exit, the time limit, or when watchDir grows over maxBytes.
  function run(args, { timeoutMs, watchDir = null, maxBytes = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(git, [...config, ...args], { env: gitEnv(env, allowFileUrls), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let failure = null;
      const stop = reason => { if (!failure) { failure = reason; child.kill('SIGKILL'); } };
      child.stdout.on('data', chunk => { if (stdout.length < MiB) stdout += chunk; });
      child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
      const timer = setTimeout(() => stop(`git did not finish within ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
      const watcher = watchDir && maxBytes ? setInterval(() => { if (folderBytes(watchDir) > maxBytes) stop(`the download is larger than ${Math.round(maxBytes / MiB)} MiB`); }, 250) : null;
      child.on('error', error => stop(error.code === 'ENOENT' ? 'git is not installed' : error.message));
      child.on('close', code => {
        clearTimeout(timer);
        if (watcher) clearInterval(watcher);
        if (failure) return reject(new MarketError('GIT_FAILED', failure, 502));
        if (code !== 0) {
          const line = stderr.split('\n').map(text => text.trim()).filter(text => text && !/^hint:/i.test(text)).slice(-2).join(' ').slice(0, 300);
          return reject(new MarketError('GIT_FAILED', `git failed: ${line || `exit ${code}`}`, 502));
        }
        return resolve(stdout);
      });
    });
  }
  return { run };
}

// ---------- the service ----------
// options: dataDir (the data folder), builtInDir (the install's plugins/), notify (services/attention-notify.js: reload, purgePlugin),
// officialIndexUrl, fetchIndex(url) -> Promise<object>, git ('git'), env (for git), allowFileUrls (tests only: file:// repositories),
// limits, prepareTtlMs, indexTtlMs, watchLinks (fs.watch on linked folders), watchDebounceMs, now(), log(level, message).
function createMarket(options = {}) {
  const dataDir = options.dataDir;
  if (!dataDir) throw new Error('createMarket needs the data folder');
  const builtInDir = options.builtInDir || store.BUILTIN_DIR;
  const notify = options.notify || null;
  const officialIndexUrl = options.officialIndexUrl || null;
  const fetchIndex = options.fetchIndex || defaultFetchIndex;
  const allowFileUrls = options.allowFileUrls === true;
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const prepareTtlMs = options.prepareTtlMs || PREPARE_TTL_MS;
  const indexTtlMs = options.indexTtlMs || INDEX_TTL_MS;
  const now = options.now || Date.now;
  const log = options.log || ((level, message) => (level === 'warn' || level === 'error' ? console.warn : console.log)(`[attention-market] ${message}`));
  const git = createGit({ git: options.git, env: options.env || process.env, allowFileUrls });
  const urlOptions = { allowFileUrls };
  const root = store.storeRoot(dataDir);
  const tmpRoot = store.tmpDir(dataDir);
  const prepared = new Map(); // id -> { ... }
  const updateState = new Map(); // name -> { latestCommit, updateAvailable, checkedAt }
  const watchers = new Map(); // name -> { watcher, timer }

  // Leftovers of an earlier run (a prepare that was never confirmed, a crash during a replace).
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }

  const builtIns = () => store.builtInNames(builtInDir);
  const reloadNotifiers = changed => {
    if (!notify || typeof notify.reload !== 'function') return;
    try { notify.reload({ changed }); } catch (error) { log('warn', `notifier reload failed: ${error.message}`); }
  };

  // ---- index sources ----
  const marketFile = path.join(root, 'market.json');
  const cacheFile = path.join(root, 'index-cache.json');
  const readExtra = () => {
    const data = store.readJson(marketFile, {});
    return Array.isArray(data && data.extra) ? data.extra.filter(url => typeof url === 'string') : [];
  };
  function getSources() { return { official: officialIndexUrl, extra: readExtra() }; }
  function saveSources(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.extra)) throw invalidSource('Send { extra: [index URL] }');
    const extra = [];
    for (const value of body.extra) {
      const url = checkSourceUrl(value);
      if (url !== officialIndexUrl && !extra.includes(url)) extra.push(url);
    }
    if (extra.length > MAX_EXTRA_SOURCES) throw invalidSource(`At most ${MAX_EXTRA_SOURCES} extra indexes`);
    store.writeJson(marketFile, { extra });
    return getSources();
  }

  const indexCache = new Map(); // url -> { fetchedAt, data, error, checkedAt }
  const inFlight = new Map();
  const diskCache = () => { const data = store.readJson(cacheFile, {}); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; };
  async function readIndex(url, { fresh = false } = {}) {
    const cached = indexCache.get(url) || (diskCache()[url] ? { ...diskCache()[url], checkedAt: 0 } : null);
    if (cached && cached.data && !fresh && now() - (cached.checkedAt || 0) < indexTtlMs) return cached;
    if (inFlight.has(url)) return inFlight.get(url);
    const job = (async () => {
      try {
        const data = checkIndex(await fetchIndex(url), url, urlOptions);
        const entry = { fetchedAt: new Date(now()).toISOString(), checkedAt: now(), data, error: null };
        indexCache.set(url, entry);
        try { store.writeJson(cacheFile, { ...diskCache(), [url]: { fetchedAt: entry.fetchedAt, data } }); } catch { /* the cache is optional */ }
        return entry;
      } catch (error) {
        const message = String((error && error.message) || error).slice(0, 200);
        const entry = { fetchedAt: cached ? cached.fetchedAt : null, checkedAt: now(), data: cached ? cached.data : null, error: message };
        indexCache.set(url, entry);
        log('warn', `index ${url} not read: ${message}`);
        return entry;
      } finally { inFlight.delete(url); }
    })();
    inFlight.set(url, job);
    return job;
  }
  async function allIndexes() {
    const urls = [officialIndexUrl, ...readExtra()].filter(Boolean);
    const results = await Promise.all(urls.map(url => readIndex(url)));
    const entries = [];
    const names = new Set();
    const sources = urls.map((url, i) => {
      const result = results[i];
      const plugins = result.data ? result.data.plugins : [];
      for (const entry of plugins) if (!names.has(entry.name)) { names.add(entry.name); entries.push(entry); }
      return { url, official: url === officialIndexUrl, ok: !result.error, stale: Boolean(result.error && result.data), fetchedAt: result.fetchedAt, error: result.error, count: plugins.length };
    });
    return { entries, sources };
  }

  // ---- installed plugins ----
  const userPlugins = () => [...store.userFolders(dataDir, 'listener'), ...store.userFolders(dataDir, 'notifier')];
  const findUser = name => userPlugins().find(item => item.name === name) || null;
  function view(item) {
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(item.folder, 'manifest.json'), 'utf8')); } catch { manifest = null; }
    const source = item.install ? item.install.source || {} : { type: 'link', url: null, ref: null, path: item.folder, commit: null };
    const state = updateState.get(item.name);
    return {
      name: item.name, kind: item.kind, version: (manifest && shortText(manifest.version, 40)) || (item.install && item.install.version) || null,
      description: (manifest && shortText(manifest.description, 500)) || null, origin: item.origin, dev: item.dev, folder: item.folder,
      source: { type: source.type, index: source.index || null, url: source.url || null, ref: source.ref || null, path: source.path || '', commit: source.commit || null },
      installedAt: item.install ? item.install.installedAt || null : (item.link && item.link.linkedAt) || null,
      updateAvailable: Boolean(state && state.updateAvailable),
    };
  }

  // GET /market?q=&kind=
  async function list({ q, kind } = {}) {
    const { entries, sources } = await allIndexes();
    const installed = userPlugins().map(view);
    const byName = new Map(installed.map(item => [item.name, item]));
    const reserved = builtIns();
    const query = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 100) : '';
    const wanted = store.KINDS.includes(kind) ? kind : null;
    const plugins = entries
      .filter(entry => !wanted || entry.kind === wanted)
      .filter(entry => !query || [entry.name, entry.description, entry.author || '', ...entry.tags].some(text => String(text).toLowerCase().includes(query)))
      .map(entry => {
        const builtIn = entry.builtIn || reserved.has(entry.name);
        const mine = builtIn ? null : byName.get(entry.name) || null;
        const fromThisEntry = mine && mine.source.type === 'index';
        const indexMoved = fromThisEntry && ((entry.ref || null) !== (mine.source.ref || null) || (entry.version && mine.version && entry.version !== mine.version));
        return {
          ...entry, builtIn, installed: builtIn || Boolean(mine), installedVersion: mine ? mine.version : null,
          origin: builtIn ? 'builtin' : mine ? mine.origin : null, dev: Boolean(mine && mine.dev),
          updateAvailable: Boolean(mine && (mine.updateAvailable || indexMoved)),
        };
      });
    return { plugins, installed, sources };
  }

  // Where a source points: { type, index?, url, ref, path, entry? }.
  async function resolveSource(body) {
    if (body && typeof body.update === 'string') {
      const item = findUser(body.update);
      if (!item) throw new MarketError('NOT_FOUND', 'That plugin is not installed', 404);
      if (item.origin === 'link') throw invalidSource('A linked plugin is updated in its own folder');
      const old = item.install.source || {};
      if (old.type === 'index') {
        const { entries } = await allIndexes();
        const entry = entries.find(candidate => candidate.name === item.name && !candidate.builtIn);
        if (entry && entry.repo) return { type: 'index', index: entry.index, url: entry.repo, ref: entry.ref, path: entry.path, entry, updating: item };
      }
      return { type: old.type === 'index' ? 'index' : 'git', index: old.index || null, url: checkUrl(old.url, urlOptions), ref: checkRef(old.ref), path: checkSubfolder(old.path), updating: item };
    }
    const source = body ? body.source : undefined;
    if (typeof source === 'string') return { type: 'git', ...parseGitSpec(source, urlOptions) };
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw invalidSource('Send { source: { name } }, { source: { url, ref?, path? } } or { update: name }');
    if (typeof source.url === 'string' && source.url.trim()) {
      const spec = source.url.includes('#') && source.ref === undefined && source.path === undefined ? parseGitSpec(source.url, urlOptions) : { url: checkUrl(source.url, urlOptions), ref: checkRef(source.ref), path: checkSubfolder(source.path) };
      return { type: 'git', ...spec };
    }
    if (typeof source.name === 'string') {
      const { entries, sources } = await allIndexes();
      const entry = entries.find(candidate => candidate.name === source.name);
      if (!entry) {
        if (sources.length && sources.every(item => !item.ok && !item.stale)) throw new MarketError('INDEX_UNAVAILABLE', 'The marketplace index cannot be read right now', 502);
        throw new MarketError('NOT_FOUND', 'No plugin with that name in the marketplace', 404);
      }
      if (entry.builtIn || builtIns().has(entry.name)) throw new MarketError('BUILT_IN', `${entry.name} is built in; it is already installed`, 400);
      return { type: 'index', index: entry.index, url: entry.repo, ref: entry.ref, path: entry.path, entry };
    }
    throw invalidSource('Send { source: { name } }, { source: { url, ref?, path? } } or { update: name }');
  }

  // Name rules for a plugin that would be installed (or linked) as `name` of `kind`.
  function checkName(name, kind, { linking = false } = {}) {
    if (builtIns().has(name)) throw new MarketError('NAME_TAKEN', `${name} is the name of a built-in plugin`, 409);
    const existing = findUser(name);
    if (!existing) return null;
    if (existing.kind !== kind) throw new MarketError('NAME_TAKEN', `${name} is already installed as a ${existing.kind}`, 409);
    if (!linking && existing.origin === 'link') throw new MarketError('NAME_TAKEN', `${name} is linked from a local folder; unlink it first`, 409);
    if (linking && existing.origin !== 'link') throw new MarketError('NAME_TAKEN', `${name} is installed; remove it before linking a folder with that name`, 409);
    return existing;
  }

  function sweep() {
    for (const [id, entry] of prepared) {
      if (now() <= entry.expiresAt) continue;
      prepared.delete(id);
      fs.rm(entry.dir, { recursive: true, force: true }, () => {});
    }
  }

  // POST /market/prepare
  async function prepare(body) {
    sweep();
    const source = await resolveSource(body || {});
    fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'prep-'));
    const repo = path.join(dir, 'repo');
    const staging = path.join(dir, 'plugin');
    try {
      await git.run(['init', '-q', repo], { timeoutMs: limits.lsRemoteMs });
      await git.run(['-C', repo, 'fetch', '-q', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', source.url, source.ref || 'HEAD'], { timeoutMs: limits.cloneMs, watchDir: repo, maxBytes: limits.maxBytes * 2 });
      await git.run(['-C', repo, 'checkout', '-q', '--detach', 'FETCH_HEAD'], { timeoutMs: limits.cloneMs, watchDir: repo, maxBytes: limits.maxBytes * 3 });
      const commit = (await git.run(['-C', repo, 'rev-parse', 'HEAD'], { timeoutMs: limits.lsRemoteMs })).trim();
      if (!SHA.test(commit)) throw new MarketError('GIT_FAILED', 'git did not give a commit', 502);
      const pluginRoot = source.path ? path.join(repo, ...source.path.split('/')) : repo;
      let stat;
      try { stat = fs.lstatSync(pluginRoot); } catch { throw invalidPlugin(`the subfolder ${source.path} is not in the repository`); }
      if (!stat.isDirectory()) throw invalidPlugin(`the subfolder ${source.path} is not a folder`);
      if (!inside(fs.realpathSync(repo), fs.realpathSync(pluginRoot))) throw invalidPlugin('the subfolder points outside the repository');
      const walked = walkPlugin(pluginRoot, limits);
      copyPlugin(pluginRoot, staging, walked.entries);
      fs.rmSync(repo, { recursive: true, force: true });
      const { manifest, hash } = checkPluginManifest(staging);
      if (source.entry && (manifest.name !== source.entry.name || manifest.kind !== source.entry.kind)) {
        throw invalidPlugin(`the index lists ${source.entry.name} (${source.entry.kind}) but the download is ${manifest.name} (${manifest.kind})`);
      }
      if (source.updating && manifest.name !== source.updating.name) throw invalidPlugin(`the update is named ${manifest.name}, not ${source.updating.name}`);
      const existing = checkName(manifest.name, manifest.kind);
      const pkg = packageInfo(staging, walked.entries);
      const warnings = riskyWarnings(staging, walked.entries);
      if (pkg.warning) warnings.unshift(pkg.warning);
      if (manifest.kind === 'listener') warnings.push('A listener is only copied; the tool it watches must be set up to run it (see its README)');
      const hashes = fileHashes(staging, walked.entries);
      let update = null;
      if (existing) {
        let before = new Map();
        try { before = fileHashes(existing.folder, walkPlugin(existing.folder, { ...limits, maxFiles: Infinity, maxBytes: Infinity }).entries); } catch { before = new Map(); }
        let changed = 0;
        for (const [file, digest] of hashes) if (before.get(file) !== digest) changed += 1;
        for (const file of before.keys()) if (!hashes.has(file)) changed += 1;
        const old = view(existing);
        update = { from: { version: old.version, commit: old.source.commit }, to: { version: manifest.version, commit }, filesChanged: changed };
      }
      const id = crypto.randomBytes(16).toString('hex');
      const record = {
        type: source.type, index: source.index || null, url: source.url, ref: source.ref || null, path: source.path || '', commit,
      };
      const expiresAt = now() + prepareTtlMs;
      prepared.set(id, { id, dir, staging, name: manifest.name, kind: manifest.kind, version: manifest.version, source: record, manifestHash: hash, expiresAt });
      const timer = setTimeout(sweep, prepareTtlMs + 1000);
      if (timer.unref) timer.unref();
      const files = walked.entries.filter(entry => entry.type !== 'dir');
      return {
        prepareId: id, expiresAt: new Date(expiresAt).toISOString(), name: manifest.name, kind: manifest.kind, manifest,
        source: record, commit, shortCommit: commit.slice(0, 7),
        files: { count: walked.files, totalBytes: walked.bytes, list: files.slice(0, 50).map(entry => ({ path: entry.path, size: entry.size })) },
        events: manifest.events || [], config: manifest.config || [], hasPackageJson: pkg.hasPackageJson, dependencies: pkg.dependencies, warnings, update,
      };
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  // POST /market/install { prepareId, confirm: true }
  function install(body) {
    if (!body || typeof body !== 'object') throw new MarketError('CONFIRM_REQUIRED', 'Send { prepareId, confirm: true }', 400);
    const entry = typeof body.prepareId === 'string' ? prepared.get(body.prepareId) : null;
    if (!entry) throw new MarketError('NOT_FOUND', 'This download is not known (or was cleaned up); prepare it again', 404);
    if (now() > entry.expiresAt) {
      prepared.delete(entry.id);
      fs.rmSync(entry.dir, { recursive: true, force: true });
      throw new MarketError('PREPARE_EXPIRED', 'This download has expired; prepare it again', 410);
    }
    if (body.confirm !== true) throw new MarketError('CONFIRM_REQUIRED', 'Installing needs an explicit confirm (confirm: true)', 400);
    prepared.delete(entry.id);
    try {
      checkName(entry.name, entry.kind);
      const info = { name: entry.name, kind: entry.kind, version: entry.version, source: entry.source, installedAt: new Date(now()).toISOString(), manifestHash: entry.manifestHash };
      fs.writeFileSync(path.join(entry.staging, store.INSTALL_FILE), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
      const parent = store.kindDir(dataDir, entry.kind);
      fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
      const target = path.join(parent, entry.name);
      const old = path.join(entry.dir, 'old');
      let replaced = false;
      if (fs.existsSync(target)) { fs.renameSync(target, old); replaced = true; }
      try { fs.renameSync(entry.staging, target); } catch (error) {
        if (replaced) fs.renameSync(old, target);
        throw error;
      }
      updateState.delete(entry.name);
      if (entry.kind === 'notifier') reloadNotifiers([target]);
      log('info', `${replaced ? 'updated' : 'installed'} ${entry.kind} ${entry.name} ${entry.version} (${entry.source.url} ${entry.source.commit.slice(0, 7)})`);
      return { ok: true, plugin: view(store.userFolders(dataDir, entry.kind).find(item => item.name === entry.name)) };
    } finally {
      fs.rmSync(entry.dir, { recursive: true, force: true });
    }
  }

  // The current commit of a ref (ls-remote): a commit SHA stays itself; a tag prefers its peeled commit.
  async function remoteCommit(url, ref) {
    if (ref && SHA.test(ref)) return ref;
    const out = await git.run(['ls-remote', '--', url, ...(ref ? [ref, `${ref}^{}`] : ['HEAD'])], { timeoutMs: limits.lsRemoteMs });
    const lines = out.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2 && SHA.test(parts[0]));
    if (!ref) return (lines.find(parts => parts[1] === 'HEAD') || lines[0] || [])[0] || null;
    const pick = name => (lines.find(parts => parts[1] === name) || [])[0];
    return pick(`refs/tags/${ref}^{}`) || pick(`refs/heads/${ref}`) || pick(`refs/tags/${ref}`) || pick(ref) || (lines[0] || [])[0] || null;
  }

  // GET /market/updates
  async function checkUpdates() {
    const items = userPlugins().filter(item => item.origin !== 'link');
    let entries = [];
    if (items.some(item => item.origin === 'index')) entries = (await allIndexes()).entries;
    const updates = await Promise.all(items.map(async item => {
      const current = view(item);
      const old = item.install.source || {};
      const entry = old.type === 'index' ? entries.find(candidate => candidate.name === item.name && !candidate.builtIn && candidate.repo) : null;
      const url = entry ? entry.repo : old.url;
      const ref = entry ? entry.ref : old.ref;
      const base = { name: item.name, kind: item.kind, version: current.version, commit: current.source.commit, ref: ref || null, latestCommit: null, updateAvailable: false, error: null };
      try {
        checkUrl(url, urlOptions);
        const latest = await remoteCommit(url, checkRef(ref));
        const updateAvailable = Boolean(latest && latest !== current.source.commit);
        updateState.set(item.name, { latestCommit: latest, updateAvailable, checkedAt: now() });
        return { ...base, latestCommit: latest, updateAvailable };
      } catch (error) {
        return { ...base, error: String(error.message || error).slice(0, 300) };
      }
    }));
    return { updates };
  }

  // DELETE /market/plugins/:name[?purge=1]
  function remove(name, { purge = false } = {}) {
    if (typeof name !== 'string' || !store.NAME.test(name)) throw new MarketError('NOT_FOUND', 'That plugin is not installed', 404);
    if (builtIns().has(name)) throw new MarketError('BUILT_IN', `${name} is built in and cannot be removed`, 400);
    const item = findUser(name);
    if (!item) throw new MarketError('NOT_FOUND', 'That plugin is not installed', 404);
    if (item.origin === 'link') {
      unlink(name);
    } else {
      fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
      const trash = path.join(tmpRoot, `removed-${name}-${crypto.randomBytes(4).toString('hex')}`);
      fs.renameSync(item.folder, trash);
      fs.rmSync(trash, { recursive: true, force: true });
      if (item.kind === 'notifier') reloadNotifiers([item.folder]);
    }
    updateState.delete(name);
    let purged = false;
    if (purge && item.kind === 'notifier' && notify && typeof notify.purgePlugin === 'function') { notify.purgePlugin(name); purged = true; }
    log('info', `removed ${item.kind} ${name}${purged ? ' and its settings' : ''}`);
    return { ok: true, name, purged };
  }

  // ---- dev links ----
  function watchLink(link) {
    stopWatch(link.name);
    if (options.watchLinks === false || link.kind !== 'notifier') return;
    try {
      const watcher = fs.watch(link.path, { recursive: true }, () => {
        const state = watchers.get(link.name);
        if (!state) return;
        clearTimeout(state.timer);
        state.timer = setTimeout(() => reloadNotifiers([link.path]), options.watchDebounceMs || 300);
      });
      watcher.on('error', () => stopWatch(link.name));
      watchers.set(link.name, { watcher, timer: null });
    } catch (error) { log('warn', `cannot watch ${link.path}: ${error.message}`); }
  }
  function stopWatch(name) {
    const state = watchers.get(name);
    if (!state) return;
    clearTimeout(state.timer);
    try { state.watcher.close(); } catch { /* closed */ }
    watchers.delete(name);
  }

  // POST /market/link { path }
  function link(body) {
    const given = body && typeof body.path === 'string' ? body.path.trim() : '';
    if (!given || !path.isAbsolute(given)) throw invalidSource('Give the absolute path of a local plugin folder');
    let folder;
    try { folder = fs.realpathSync(given); } catch { throw invalidSource('That folder does not exist'); }
    if (!fs.statSync(folder).isDirectory()) throw invalidSource('That path is not a folder');
    const { manifest } = checkPluginManifest(folder);
    checkName(manifest.name, manifest.kind, { linking: true });
    const links = store.readLinks(dataDir).filter(item => item.name !== manifest.name);
    const entry = { name: manifest.name, kind: manifest.kind, path: folder, linkedAt: new Date(now()).toISOString() };
    store.writeLinks(dataDir, [...links, entry]);
    if (manifest.kind === 'notifier') reloadNotifiers([folder]);
    watchLink(entry);
    log('info', `linked ${manifest.kind} ${manifest.name} from ${folder}`);
    return { ok: true, plugin: view(store.userFolders(dataDir, manifest.kind).find(item => item.name === manifest.name)) };
  }

  // DELETE /market/link/:name
  function unlink(name) {
    const links = store.readLinks(dataDir);
    const found = links.find(item => item.name === name);
    if (!found) throw new MarketError('NOT_FOUND', 'No linked plugin has that name', 404);
    stopWatch(name);
    store.writeLinks(dataDir, links.filter(item => item.name !== name));
    if (found.kind === 'notifier') reloadNotifiers([found.path]);
    return { ok: true, name };
  }

  // POST /market/reload { name }
  function reload(body) {
    const name = body && typeof body.name === 'string' ? body.name : '';
    const item = findUser(name);
    if (!item) throw new MarketError('NOT_FOUND', 'That plugin is not installed or linked', 404);
    if (item.kind === 'notifier') reloadNotifiers([item.folder]);
    return { ok: true };
  }

  for (const entry of store.readLinks(dataDir)) watchLink(entry);

  function stop() {
    for (const name of [...watchers.keys()]) stopWatch(name);
    for (const entry of prepared.values()) fs.rmSync(entry.dir, { recursive: true, force: true });
    prepared.clear();
  }

  return { list, prepare, install, checkUpdates, remove, link, unlink, reload, getSources, saveSources, readIndex, stop, preparedCount: () => prepared.size };
}

module.exports = { createMarket, MarketError, parseGitSpec, checkUrl, checkRef, checkSubfolder, checkIndex, checkPluginManifest, walkPlugin, defaultFetchIndex, DEFAULT_LIMITS };
