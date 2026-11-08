// The pure logic of the plugin marketplace in Settings → T-Attention → Plugins → Marketplace (PluginMarket.jsx, MarketDialogs.jsx): the list
// entries with their badges and actions, the search and kind filter, the Git URL and index source checks, and the install preview with its
// expiry. Data comes from the market API (GET /api/attention/market, POST …/market/prepare; see "Plugin marketplace" in DESIGN.md). No DOM, no
// requests, so test/market-model.test.js runs it in Node. `t` is passed in; the labels below are English keys of public/js/i18n-zh-ui.js.

const plain = text => text;
const str = value => (typeof value === 'string' ? value : '');
const list = value => (Array.isArray(value) ? value : []);

// A prepared install is good for 10 minutes on the server (the clone in the temporary folder is then removed).
export const PREPARE_TTL_MS = 10 * 60 * 1000;
// How long the search box waits after the last key before it asks the server.
export const SEARCH_DEBOUNCE_MS = 300;
// The server keeps at most this many extra index URLs.
export const MAX_SOURCES = 10;

export const KINDS = [
  { key: '', label: 'All' },
  { key: 'listener', label: 'Listeners' },
  { key: 'notifier', label: 'Notifiers' },
];
export const KIND_LABELS = { listener: 'Listener', notifier: 'Notifier' };

// The source of an installed plugin ({ type: 'index'|'git'|'link', url, ref, commit }), or null.
function sourceOf(value) {
  if (!value || typeof value !== 'object') return null;
  return { type: str(value.type), url: str(value.url), ref: str(value.ref), commit: str(value.commit), index: str(value.index) };
}

// One entry of the listing, made safe to draw. The server merges the index entry with the installed state (`installed`, `installedVersion`,
// `origin`: 'builtin'|'index'|'git'|'link', `dev`, `updateAvailable`). `version` is the index version; `installedVersion` the one in place.
export function normalizeEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const installedObject = entry.installed && typeof entry.installed === 'object' ? entry.installed : null;
  const source = sourceOf(entry.source || (installedObject && installedObject.source));
  const update = entry.updateAvailable;
  const origin = str(entry.origin) || (source ? source.type : '');
  return {
    name: str(entry.name) || '?',
    kind: entry.kind === 'listener' || entry.kind === 'notifier' ? entry.kind : '',
    description: str(entry.description),
    version: str(entry.version),
    installedVersion: str(entry.installedVersion) || str(installedObject && installedObject.version),
    author: typeof entry.author === 'string' ? entry.author : str(entry.author && entry.author.name),
    tags: list(entry.tags).filter(tag => typeof tag === 'string' && tag),
    homepage: /^https?:\/\//.test(str(entry.homepage)) ? entry.homepage : '',
    repo: str(entry.repo),
    builtIn: entry.builtIn === true || origin === 'builtin',
    origin,
    installed: Boolean(entry.installed) || entry.builtIn === true || origin === 'builtin',
    updateAvailable: Boolean(update),
    latestVersion: str(update && typeof update === 'object' ? update.version : '') || str(entry.latestVersion),
    source,
    dev: entry.dev === true || origin === 'link',
    inIndex: entry.inIndex !== false,
  };
}

// An installed user plugin of the answer's `installed` list ({ name, kind, version, description, origin, dev, source, updateAvailable }) as a
// listing entry: in place, with no index entry of its own.
export function installedEntry(raw) {
  const plugin = raw && typeof raw === 'object' ? raw : {};
  return normalizeEntry({ ...plugin, installed: true, installedVersion: plugin.version, inIndex: false });
}

// The answer of GET /api/attention/market: { plugins: [index entries], installed: [user plugins], sources: [{ url, official, ok, stale, error }] }.
// A user plugin that no index lists (installed from a Git URL, or linked) is added after the index entries, so it can be updated and removed.
// `q` and `kind` filter those added ones the same way the server filters the index entries.
export function normalizeMarket(data, filter = {}) {
  const plugins = list(data && (data.plugins || data.entries)).filter(entry => entry && typeof entry === 'object').map(normalizeEntry);
  const listed = new Set(plugins.map(entry => entry.name));
  const extra = list(data && data.installed).filter(entry => entry && typeof entry === 'object' && typeof entry.name === 'string' && !listed.has(entry.name)).map(installedEntry);
  plugins.push(...filterEntries(extra, filter));
  const sources = list(data && data.sources).map(source => (typeof source === 'string' ? { url: source } : source))
    .filter(source => source && typeof source.url === 'string')
    .map(source => ({ url: source.url, official: source.official === true, ok: source.ok !== false, error: str(source.error), stale: source.stale === true }));
  const errors = list(data && data.errors).map(error => (typeof error === 'string' ? error : str(error && (error.message || error.error)))).filter(Boolean);
  for (const source of sources) if (!source.ok && source.error) errors.push(`${source.url}: ${source.error}`);
  return { plugins, sources, errors: [...new Set(errors)] };
}

// The answer of GET /api/attention/market/sources: { official, extra: [url] }.
export function normalizeSources(data) {
  return { official: str(data && data.official), extra: list(data && data.extra).filter(url => typeof url === 'string' && url) };
}

// The search and the kind filter, on the page as well (the server filters too; this keeps the list right while a request is on its way).
// Every word of the query must be found in the name, description, author or a tag.
export function filterEntries(entries, { q = '', kind = '' } = {}) {
  const words = str(q).toLowerCase().split(/\s+/).filter(Boolean);
  return list(entries).filter(entry => {
    if (kind && entry.kind !== kind) return false;
    if (!words.length) return true;
    const text = [entry.name, entry.description, entry.author, ...(entry.tags || [])].join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  });
}

// The answer of GET /api/attention/market/updates ({ updates: [{ name, updateAvailable, error }] }, a `git ls-remote` per index or Git install)
// laid over the listing: an entry it reports as updatable gets the Update action even if the listing was read before the check.
export function applyUpdates(entries, data) {
  const found = new Map(list(data && data.updates).filter(update => update && typeof update.name === 'string').map(update => [update.name, update]));
  return list(entries).map(entry => {
    const update = found.get(entry.name);
    return update && update.updateAvailable === true && entry.installed && !entry.builtIn ? { ...entry, updateAvailable: true } : entry;
  });
}

// "2 updates available", "Everything is up to date", plus the plugins whose check failed.
export function updatesSummary(data, { t = plain } = {}) {
  const updates = list(data && data.updates).filter(update => update && typeof update.name === 'string');
  const count = updates.filter(update => update.updateAvailable === true).length;
  const failed = updates.filter(update => update.error).map(update => update.name);
  const head = count ? `${count} ${count === 1 ? t('update available') : t('updates available')}` : t('Everything is up to date');
  return failed.length ? `${head}. ${t('Could not check:')} ${failed.join(', ')}` : head;
}

// The query string of the listing request.
export function marketQuery({ q = '', kind = '' } = {}) {
  const params = new URLSearchParams();
  if (str(q).trim()) params.set('q', q.trim());
  if (kind) params.set('kind', kind);
  const text = params.toString();
  return text ? `?${text}` : '';
}

// The badges of a card: { key, label, tone }.
export function entryBadges(entry) {
  if (!entry) return [];
  const badges = [];
  if (entry.builtIn) badges.push({ key: 'builtIn', label: 'Built-in', tone: 'default' });
  else if (entry.installed) badges.push({ key: 'installed', label: 'Installed', tone: 'success' });
  if (entry.updateAvailable && !entry.builtIn) badges.push({ key: 'update', label: 'Update available', tone: 'warning' });
  if (entry.dev) badges.push({ key: 'dev', label: 'Dev', tone: 'primary' });
  return badges;
}

// What a card offers: Install (not installed, in the index), Update (an index or Git install with a newer commit), Remove (any user plugin).
// Built-in plugins have none: they come with T-Agent.
export function entryActions(entry) {
  if (!entry || entry.builtIn) return { install: false, update: false, remove: false };
  return {
    install: !entry.installed && entry.inIndex && Boolean(entry.name),
    update: entry.installed && entry.updateAvailable && !entry.dev,
    remove: entry.installed,
  };
}

// "1.0.0 → 1.1.0" on a card with an update, else the version in place (or the index version when not installed).
export function versionText(entry) {
  if (!entry) return '';
  const now = entry.installedVersion || (entry.installed ? entry.version : '');
  const next = entry.latestVersion || (entry.installedVersion && entry.version !== entry.installedVersion ? entry.version : '');
  if (entry.updateAvailable && now && next && now !== next) return `${now} → ${next}`;
  return now || entry.version;
}

// A Git address the server can clone: https://host/path or git@host:path, then optionally #ref and :subfolder, as the server reads it
// ("https://host/repo.git#v1.2:plugins/x"; without a ref, "https://host/repo.git:plugins/x"). Returns { url, repo, subfolder, ref } or
// { error } (an English message key). The typed text is sent as it is; this check only catches mistakes early.
export function parseGitSource(text) {
  const input = str(text).trim();
  if (!input) return { error: 'Enter a Git URL' };
  if (/\s/.test(input)) return { error: 'A Git URL has no spaces' };
  let head;
  let rest;
  let match = input.match(/^(https:\/\/[^/:@#]+(?::\d+)?)(\/.*)$/);
  if (match) { head = match[1]; rest = match[2]; }
  else {
    match = input.match(/^(git@[A-Za-z0-9.-]+:)(.+)$/);
    if (!match) return { error: 'Use an https:// or git@ address' };
    head = match[1]; rest = match[2];
  }
  const hash = rest.indexOf('#');
  let repoPath = hash >= 0 ? rest.slice(0, hash) : rest;
  const tail = hash >= 0 ? rest.slice(hash + 1) : '';
  let ref = '';
  let subfolder = '';
  let hasSub = false;
  if (hash >= 0) {
    const colon = tail.indexOf(':');
    ref = colon >= 0 ? tail.slice(0, colon) : tail;
    if (colon >= 0) { hasSub = true; subfolder = tail.slice(colon + 1); }
    if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return { error: 'The #ref is not a valid tag, branch or commit' };
  } else {
    const colon = repoPath.indexOf(':');
    if (colon >= 0) { hasSub = true; subfolder = repoPath.slice(colon + 1); repoPath = repoPath.slice(0, colon); }
  }
  subfolder = subfolder.replace(/^\/+|\/+$/g, '');
  if (!/[A-Za-z0-9]/.test(repoPath.replace(/^\/+/, ''))) return { error: 'The address has no repository path' };
  if (hasSub && (!subfolder || subfolder.split('/').some(part => part === '..' || part === '.' || !part))) return { error: 'The :subfolder is not valid' };
  return { url: input, repo: head + repoPath, subfolder, ref };
}

// An extra index URL: https only, with a host.
export function sourceProblem(text, existing = []) {
  const input = str(text).trim();
  if (!input) return 'Enter an index URL';
  let url;
  try { url = new URL(input); } catch { return 'This is not a valid URL'; }
  if (url.protocol !== 'https:') return 'Index URLs must start with https://';
  if (!url.hostname) return 'This is not a valid URL';
  if (list(existing).some(entry => str(entry).trim() === input)) return 'This index is already in the list';
  if (list(existing).length >= MAX_SOURCES) return 'At most 10 extra indexes';
  return '';
}

// The body of POST /api/attention/market/prepare: an index entry by name, a Git address as typed (the server reads #ref and :subfolder),
// or the update of an installed plugin.
export function prepareBody(request) {
  if (!request) return null;
  if (request.mode === 'update') return { update: request.name };
  if (request.mode === 'git') return { source: str(request.url).trim() };
  return { source: { name: request.name } };
}

// The remove request: a linked plugin only loses its link (DELETE /market/link/:name); another user plugin is deleted, and with `purge` its
// stored settings too.
const DELETE = 'DELETE';
export function removeRequest(entry, { purge = false } = {}) {
  const name = encodeURIComponent(entry.name);
  if (entry.dev) return { method: DELETE, path: `/market/link/${name}` };
  return { method: DELETE, path: `/market/plugins/${name}${purge ? '?purge=1' : ''}` };
}

// "12 KB", "1.5 MB".
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 104.857)) / 10} MB`;
}

export const shortSha = commit => (typeof commit === 'string' && /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : str(commit));

// The answer of POST /api/attention/market/prepare, flattened for the confirmation dialog. `receivedAt` is when the page got it; the server's
// `expiresAt` wins when it sent one.
export function previewModel(preview, { receivedAt = Date.now() } = {}) {
  const p = preview && typeof preview === 'object' ? preview : {};
  const manifest = p.manifest && typeof p.manifest === 'object' ? p.manifest : {};
  const files = p.files && typeof p.files === 'object' ? p.files : {};
  const source = p.source && typeof p.source === 'object' ? p.source : {};
  const update = p.update && typeof p.update === 'object' ? p.update : (p.diff && typeof p.diff === 'object' ? p.diff : null);
  const configFields = list(p.config || p.configSchema || manifest.config).filter(field => field && typeof field === 'object' && field.key)
    .map(field => ({ key: str(field.key), label: str(field.label) || str(field.key), type: str(field.type), required: field.required === true }));
  const dependencies = Array.isArray(p.dependencies) ? p.dependencies.map(String) : Object.keys(p.dependencies && typeof p.dependencies === 'object' ? p.dependencies : {});
  const warnings = list(p.warnings).map(warning => (typeof warning === 'string' ? warning : str(warning && (warning.message || warning.text)))).filter(Boolean);
  const dependencyWarning = dependencies.length > 0 && !warnings.some(warning => /dependenc/i.test(warning));
  const expiresAt = Date.parse(str(p.expiresAt));
  const side = value => (value && typeof value === 'object' ? str(value.version) : str(value));
  const fromVersion = side(update && update.from) || str(update && update.fromVersion) || str(p.previousVersion);
  return {
    prepareId: str(p.prepareId),
    name: str(manifest.name) || str(p.name),
    version: str(manifest.version),
    description: str(manifest.description),
    kind: str(p.kind) || str(manifest.kind),
    events: list(p.events || manifest.events).map(String),
    sourceUrl: str(source.url) || str(p.url) || str(p.repo),
    index: str(source.index),
    ref: str(source.ref) || str(p.ref),
    subfolder: str(source.path) || str(source.subfolder),
    commit: str(p.commit),
    shortCommit: str(p.shortCommit) || shortSha(str(p.commit)),
    fileCount: Number.isFinite(Number(files.count)) ? Number(files.count) : list(files.list).length,
    totalSize: [files.totalBytes, files.totalSize, files.size].map(Number).find(Number.isFinite) ?? null,
    fileList: list(files.list).map(entry => (typeof entry === 'string' ? entry : str(entry && entry.path))).filter(Boolean),
    configFields,
    hasPackageJson: p.hasPackageJson === true,
    dependencies,
    dependencyWarning,
    warnings,
    update: update ? { fromVersion, toVersion: side(update.to) || str(update.toVersion) || str(manifest.version), filesChanged: Number.isFinite(Number(update.filesChanged)) ? Number(update.filesChanged) : null } : null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : receivedAt + PREPARE_TTL_MS,
  };
}

// True once the prepared install is too old to be installed (the server would refuse it).
export const previewExpired = (model, now = Date.now()) => !model || now >= model.expiresAt;

// An install error that means the prepare is gone: it must be prepared again.
export const isExpiredError = error => {
  const code = str(error && error.message);
  return code === 'PREPARE_EXPIRED' || (code === 'NOT_FOUND' && Boolean(error && error.data && /prepar/i.test(str(error.data.message))));
};

// "Listener · events: stop, notification" for the preview's "What it can do" line.
export function capabilityText(model, { t = plain } = {}) {
  if (!model) return '';
  const parts = [model.kind ? t(KIND_LABELS[model.kind] || model.kind) : ''];
  if (model.events.length) parts.push(`${t('Events:')} ${model.events.join(', ')}`);
  return parts.filter(Boolean).join(' · ');
}

// "3 files, 12 KB".
export function filesText(model, { t = plain } = {}) {
  if (!model) return '';
  const count = `${model.fileCount} ${model.fileCount === 1 ? t('file') : t('files')}`;
  const size = model.totalSize === null ? '' : formatBytes(model.totalSize);
  return size ? `${count}, ${size}` : count;
}
