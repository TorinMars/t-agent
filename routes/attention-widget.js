// The API of the T-Attention desktop window (macOS), mounted at /api/attention/widget. See "T-Attention desktop window (macOS)" in DESIGN.md.
//
//  - `bearer`: every path except /settings. Taken only from this machine (a loopback peer and no X-Forwarded-For / Forwarded / X-Real-IP, the rule of
//    lib/terminal-relay-auth.js) with `Authorization: Bearer <TA_WIDGET_TOKEN>`, the token the launcher made for the window that runs now
//    (services/attention-widget.js). server.js mounts it before the attention Bearer router, the session and the gates; it answers every request it
//    takes itself (401 WIDGET_TOKEN_INVALID, JSON 404 for an unknown path) and never passes one on. A /settings request without an Authorization header
//    goes on to the browser session path; one with a Bearer header is refused.
//  - `settings`: GET / PUT /api/attention/widget/settings, the browser session (mounted after the /api gate, same-origin writes like every setting).
//
// One merged list of every engine the page's T-Attention one-list shows (attention-model.mjs attentionEngines): this machine, and each connected
// service that is enabled, not hidden in the task list (routes/task-list-prefs.js hiddenDevices) and has 'attention:remote'. Remotes are read in
// parallel through services/remote-attention.js (the helper of the /api/remote-servers/:id/attention proxy), each within readTimeoutMs; one that fails
// is named in `failed` and the others go on; one without T-Attention (501) is left out quietly, as on the page. Items are keyed
// '<engine>:<id>' with engine 'local' or 'remote:<row id>', since ids repeat between engines; every action goes to the item's own engine.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { AttentionError } = require('../services/attention');
const { RemoteAttentionError } = require('../services/remote-attention');
const { WidgetError } = require('../services/attention-widget');
const { fromThisMachine } = require('../lib/terminal-relay-auth');

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;
const SETTINGS_PATH = /^\/settings\/?$/i;
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const FINISHED_KEEP = 50;
const LIST_LIMIT = 1000;
const ENGINE_KEY = /^(?:local|remote:[1-9]\d{0,14})$/;
const ITEM_KEY = /^(local|remote:[1-9]\d{0,14}):([1-9]\d{0,14})$/;
const ROOT = path.join(__dirname, '..');
const STRINGS_FILE = path.join(ROOT, 'widgets', 'macos', 'strings.json');
// Later files win: the page's own UI words first.
const DICTIONARIES = ['i18n-zh-server.js', 'i18n-zh-extra.js', 'i18n-zh-ui.js'].map(name => path.join(ROOT, 'public', 'js', name));

// The device tag colour of the page (scripts/h5-shell/task-order.mjs tagColorIndex): FNV-1a of the instance id, one of 8; -1 without an id.
const TAG_COLOR_COUNT = 8;
function tagColorIndex(instanceId) {
  if (typeof instanceId !== 'string' || !instanceId) return -1;
  let hash = 0x811c9dc5;
  for (let index = 0; index < instanceId.length; index += 1) {
    hash ^= instanceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % TAG_COLOR_COUNT;
}

// The Chinese dictionaries of the page, read in a sandbox (they are browser scripts that call I18n.add). Read again when a file changes.
function createDictionary(files = DICTIONARIES) {
  let cached = null;
  let stamp = '';
  return () => {
    const next = files.map(file => { try { return `${file}:${fs.statSync(file).mtimeMs}`; } catch { return `${file}:-`; } }).join('|');
    if (cached && next === stamp) return cached;
    const words = Object.create(null);
    const sandbox = { I18n: { add: entries => { for (const [key, value] of Object.entries(entries || {})) if (typeof value === 'string') words[key] = value; } } };
    vm.createContext(sandbox);
    for (const file of files) {
      try { vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file, timeout: 2000 }); } catch { /* a missing or broken file adds nothing */ }
    }
    cached = words;
    stamp = next;
    return words;
  };
}

function readStringList(file = STRINGS_FILE) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? [...new Set(list.filter(entry => typeof entry === 'string' && entry))] : [];
  } catch { return []; }
}

const sendError = (res, status, code, message, extra = {}) => res.status(status).json({ error: code, message, ...extra });
// An error of an owner (this machine's AttentionError, a remote's RemoteAttentionError) as it came; anything else is logged and 500.
function sendFailure(res, error) {
  if (error instanceof AttentionError) {
    return sendError(res, error.statusCode, error.code, error.message, { ...(Array.isArray(error.children) ? { children: error.children } : {}), ...(error.id !== undefined ? { id: error.id } : {}) });
  }
  if (error instanceof RemoteAttentionError) return res.status(error.statusCode).json(error.body);
  if (error instanceof WidgetError) return sendError(res, error.statusCode, error.code, error.message);
  console.error(`T-Attention desktop window API: ${error && (error.stack || error.message)}`);
  return sendError(res, 500, 'INTERNAL_ERROR', 'The attention service failed');
}
const handle = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => sendFailure(res, error));
const invalid = message => new WidgetError('VALIDATION_FAILED', message, 400);

function parseItemKey(value) {
  const match = ITEM_KEY.exec(String(value || ''));
  return match ? { engine: match[1], id: Number(match[2]) } : null;
}

// An item as the window reads it.
function widgetItem(engine, item) {
  const pending = item.context && item.context.pending && typeof item.context.pending.text === 'string' && item.context.pending.text ? item.context.pending.text : null;
  const parent = Number.isSafeInteger(item.parent_id) ? item.parent_id : null;
  return {
    key: `${engine}:${item.id}`,
    engine,
    id: item.id,
    parent_key: parent === null ? null : `${engine}:${parent}`,
    title: item.title,
    status: item.status,
    custom_status: item.custom_status ?? null,
    result: item.result ?? null,
    attention_reason: item.attention_reason ?? null,
    pending,
    priority: item.priority ?? null,
    due_date: item.due_date ?? null,
    sort_order: typeof item.sort_order === 'number' ? item.sort_order : null,
    updated_at: item.updated_at ?? null,
    created_at: item.created_at ?? null,
  };
}

// This machine's T-Attention as an engine adapter: the same calls as the page's, as the person ('user').
function localEngine(service) {
  const actor = { actor: 'user' };
  return {
    async list() {
      return [...service.list({ limit: LIST_LIMIT }), ...service.list({ status: [...FINISHED].join(','), limit: LIST_LIMIT })];
    },
    async get(id) { return service.get(id); },
    async create(body) { return service.create(body, { ...actor, defaultSource: 'user' }); },
    async update(id, body) { return service.update(id, body, actor); },
    async move(id, body) { service.move(id, body, actor); },
    async remove(id) { service.remove(id, actor); },
  };
}

// A connected service's T-Attention through the proxy's helper.
function remoteEngine(remote, row, { readTimeoutMs }) {
  const call = (method, pathname, body, timeoutMs) => remote.call(row, { method, path: pathname, body, ...(timeoutMs ? { timeoutMs } : {}) });
  const list = answer => (answer && Array.isArray(answer.items) ? answer.items : []);
  return {
    async list() {
      const [open, finished] = await Promise.all([
        call('GET', `?limit=${LIST_LIMIT}`, undefined, readTimeoutMs),
        call('GET', `?status=${[...FINISHED].join(',')}&limit=${LIST_LIMIT}`, undefined, readTimeoutMs),
      ]);
      return [...list(open), ...list(finished)];
    },
    async get(id) {
      try { const found = await call('GET', `/${id}`); return found && found.item ? found.item : null; }
      catch (error) { if (error instanceof RemoteAttentionError && error.statusCode === 404) return null; throw error; }
    },
    async create(body) { return call('POST', '', body); },
    async update(id, body) { return call('PATCH', `/${id}`, body); },
    async move(id, body) { await call('POST', `/${id}/move`, body); },
    async remove(id) { await call('DELETE', `/${id}`); },
  };
}

// Rejects a promise that takes longer than ms.
function within(promise, ms) {
  let timer;
  const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('REMOTE_TIMEOUT')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function createAttentionWidgetRoutes({
  service,
  launcher,
  settings,
  db = require('../db'),
  remote = require('../services/remote-attention').getRemoteAttention(),
  owner = () => require('../services/single-user').ensureSingleUser().login,
  hiddenDevices = login => require('./task-list-prefs').hiddenDevices(db, login),
  localName = () => require('../services/engine-name').engineNameState(db).name,
  localInstanceId = () => require('../services/engine-identity').getEngineIdentity().engine_id,
  remoteInstanceId = row => require('./remote-servers').instanceIdOf(row),
  wantsChinese = require('../lib/static-assets').wantsChinese,
  isLocal = fromThisMachine,
  dictionary = createDictionary(),
  stringList = () => readStringList(),
  readTimeoutMs = 4000,
  settleMs = 1500,
  now = () => new Date(),
} = {}) {
  if (!service) throw new Error('createAttentionWidgetRoutes needs the attention service');
  if (!launcher || !settings) throw new Error('createAttentionWidgetRoutes needs the launcher and the settings');

  const rowsOf = login => db.prepare('SELECT * FROM remote_servers WHERE owner_id = ? AND enabled = 1 ORDER BY created_at ASC, id ASC').all(login);
  // The engine of a key: this machine, or an enabled row of this owner (hidden ones too: an item the window already has stays reachable).
  function engineOf(key) {
    if (key === 'local') return localEngine(service);
    const id = Number(String(key).slice('remote:'.length));
    const row = db.prepare('SELECT * FROM remote_servers WHERE id = ? AND owner_id = ? AND enabled = 1').get(id, owner());
    if (!row) throw new WidgetError('ENGINE_NOT_FOUND', 'This device is not connected', 404);
    return remoteEngine(remote, row, { readTimeoutMs });
  }
  const localEntry = () => ({ key: 'local', name: localName(), local: true, color_index: tagColorIndex(localInstanceId()), engine: localEngine(service) });
  // The engines of the merged list, in the page's order (this machine first): { key, name, local, color_index, engine }.
  function listedEngines() {
    const login = owner();
    const hidden = new Set(hiddenDevices(login));
    const out = [];
    if (!hidden.has('local')) out.push(localEntry());
    for (const row of rowsOf(login)) {
      const key = `remote:${row.id}`;
      if (hidden.has(key)) continue;
      let instanceId = null;
      try { instanceId = remoteInstanceId(row); } catch { /* no colour */ }
      out.push({ key, name: row.name, local: false, color_index: tagColorIndex(instanceId), engine: remoteEngine(remote, row, { readTimeoutMs }) });
    }
    // As on the page: when every device is hidden or none is left, this machine is shown.
    if (!out.length) out.push(localEntry());
    return out;
  }

  const api = express.Router();
  const parseJson = express.json({ limit: '256kb' });

  const readEngines = engines => Promise.all(engines.map(entry => within(Promise.resolve().then(() => entry.engine.list()), readTimeoutMs).then(items => ({ entry, items }), error => ({ entry, error }))));
  api.get('/items', handle(async (req, res) => {
    const engines = listedEngines();
    let answers = await readEngines(engines);
    // As on the page: when no listed engine has T-Attention (this machine hidden, the others without it), this machine is shown.
    const usable = answers.filter(({ error }) => !(error instanceof RemoteAttentionError && error.statusCode === 501));
    if (!usable.length && !engines.some(entry => entry.local)) answers = await readEngines([localEntry()]);
    const shown = [];
    const failed = [];
    let items = [];
    for (const { entry, items: list, error } of answers) {
      if (error) {
        if (error instanceof RemoteAttentionError && error.statusCode === 501) continue; // no T-Attention there: left out quietly
        if (entry.local) throw error;
        failed.push(entry.name);
        shown.push(entry);
        continue;
      }
      shown.push(entry);
      const seen = new Set();
      for (const item of list) {
        if (!item || !Number.isSafeInteger(item.id) || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push({ engine: entry.key, item });
      }
    }
    const finished = items.filter(({ item }) => FINISHED.has(item.status))
      .sort((a, b) => String(b.item.completed_at || b.item.updated_at || '').localeCompare(String(a.item.completed_at || a.item.updated_at || '')))
      .slice(0, FINISHED_KEEP);
    const keep = new Set(finished);
    items = items.filter(entry => !FINISHED.has(entry.item.status) || keep.has(entry));
    // The page's order inside a group: the highest sort_order first, then the highest id.
    items.sort((a, b) => (Number(b.item.sort_order) || 0) - (Number(a.item.sort_order) || 0) || b.item.id - a.item.id);
    res.json({
      items: items.map(({ engine, item }) => widgetItem(engine, item)),
      engines: shown.map(({ key, name, local, color_index: color }) => ({ key, name, local, color_index: color })),
      failed,
      host: os.hostname(),
      updated_at: now().toISOString(),
    });
  }));

  // parent_key (same engine, or null) -> parent_id. Undefined when the body does not name it.
  function parentIdOf(body, engine) {
    if (!Object.prototype.hasOwnProperty.call(body, 'parent_key')) return undefined;
    if (body.parent_key === null || body.parent_key === '') return null;
    const parent = parseItemKey(body.parent_key);
    if (!parent) throw invalid('parent_key must be an item key');
    if (parent.engine !== engine) throw invalid('Parent is on another device');
    return parent.id;
  }
  const objectBody = req => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw invalid('The request body must be a JSON object');
    return req.body;
  };
  const keyOf = req => {
    const key = parseItemKey(req.params.key);
    if (!key) throw new WidgetError('NOT_FOUND', 'Task not found', 404);
    return key;
  };

  api.post('/items', parseJson, handle(async (req, res) => {
    const body = objectBody(req);
    if (typeof body.engine !== 'string' || !ENGINE_KEY.test(body.engine)) throw invalid("engine must be 'local' or 'remote:<id>'");
    const engine = engineOf(body.engine);
    const create = { title: body.title };
    for (const field of ['status', 'notes']) if (body[field] !== undefined) create[field] = body[field];
    const parent = parentIdOf(body, body.engine);
    if (parent !== undefined) create.parent_id = parent;
    res.status(201).json(widgetItem(body.engine, await engine.create(create)));
  }));

  api.patch('/items/:key', parseJson, handle(async (req, res) => {
    const key = keyOf(req);
    const body = { ...objectBody(req) };
    const parent = parentIdOf(body, key.engine);
    delete body.parent_key;
    delete body.parent_id;
    if (parent !== undefined) body.parent_id = parent;
    res.json(widgetItem(key.engine, await engineOf(key.engine).update(key.id, body)));
  }));

  api.delete('/items/:key', handle(async (req, res) => {
    const key = keyOf(req);
    await engineOf(key.engine).remove(key.id);
    res.status(204).end();
  }));

  api.post('/items/:key/move', parseJson, handle(async (req, res) => {
    const key = keyOf(req);
    const body = objectBody(req);
    const move = {};
    for (const [field, target] of [['before_key', 'before'], ['after_key', 'after']]) {
      if (body[field] === undefined || body[field] === null || body[field] === '') continue;
      const other = parseItemKey(body[field]);
      if (!other) throw invalid(`${field} must be an item key`);
      if (other.engine !== key.engine) throw invalid('Target is on another device');
      move[target] = other.id;
    }
    if (body.position !== undefined) move.position = body.position;
    if (body.status !== undefined) move.status = body.status;
    await engineOf(key.engine).move(key.id, move);
    res.json({ ok: true });
  }));

  // The row buttons, with the page's semantics (Attention.jsx): only from their starting status.
  const ACTIONS = {
    confirm: { from: 'review', message: 'The task is not waiting for review', body: () => ({ status: 'done' }) },
    reject: {
      from: 'review', message: 'The task is not waiting for review',
      body: req => {
        const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
        return { status: 'working', attention_reason: null, activity: { kind: 'note', text: reason ? `Rejected: ${reason}` : 'Rejected' } };
      },
    },
    handled: { from: 'waiting_user', message: 'The task does not need you', body: () => ({ status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Handled' } }) },
  };
  for (const [name, action] of Object.entries(ACTIONS)) {
    api.post(`/items/:key/${name}`, parseJson, handle(async (req, res) => {
      const key = keyOf(req);
      const engine = engineOf(key.engine);
      const item = await engine.get(key.id);
      if (!item) throw new WidgetError('NOT_FOUND', 'Task not found', 404);
      if (item.status !== action.from) throw new WidgetError('WRONG_STATUS', action.message, 409);
      res.json(widgetItem(key.engine, await engine.update(key.id, action.body(req))));
    }));
  }

  // The window's words in its language: { lang, strings: { English: shown } }. English, or a word without a translation, maps to itself.
  api.get('/strings', handle(async (req, res) => {
    const lang = settings.language();
    const words = lang === 'zh' ? dictionary() : null;
    const strings = {};
    for (const text of stringList()) strings[text] = words && typeof words[text] === 'string' ? words[text] : text;
    res.json({ lang, strings });
  }));

  api.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  function bearer(req, res, next) {
    const header = req.get('authorization');
    if (SETTINGS_PATH.test(req.path)) {
      if (header === undefined) return next();
      res.set('Cache-Control', 'no-store');
      return sendError(res, 403, 'TOKEN_NOT_ALLOWED', 'The window settings are changed on the page');
    }
    res.set('Cache-Control', 'no-store');
    const match = header ? BEARER.exec(header) : null;
    if (!isLocal(req) || !match || !launcher.verifyToken(match[1])) return sendError(res, 401, 'WIDGET_TOKEN_INVALID', 'The window token is missing or wrong');
    return api(req, res, error => (error ? sendFailure(res, error) : sendError(res, 404, 'NOT_FOUND', 'Not found')));
  }

  // The settings card (AttentionWidgetSettings.jsx): the switch, the language and the status line. `peerSettings` is the same card for a linked
  // device's page (routes/device-settings.js, GET / PUT /v1/device-settings/attention/widget/settings): it never notes the page language, which is
  // the language of this machine's own page and not of a page somewhere else.
  const settingsRouterFor = ({ notePage }) => {
    const router = express.Router();
    const answer = async req => {
      if (notePage) settings.notePageLanguage(wantsChinese(req));
      return { ...settings.read(), ...(await launcher.status()) };
    };
    router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.get('/', handle(async (req, res) => res.json(await answer(req))));
    router.put('/', handle(async (req, res) => {
      const before = settings.read();
      const saved = settings.save(req.body);
      // Started or stopped at once; the answer waits a moment for a quick start (a build can take minutes: `building` says so meanwhile).
      if (saved.enabled !== before.enabled) {
        let timer;
        await Promise.race([launcher.setEnabled(saved.enabled), new Promise(resolve => { timer = setTimeout(resolve, settleMs); })]);
        clearTimeout(timer);
      }
      res.json(await answer(req));
    }));
    return router;
  };

  return { bearer, settings: settingsRouterFor({ notePage: true }), peerSettings: settingsRouterFor({ notePage: false }) };
}

module.exports = { createAttentionWidgetRoutes, tagColorIndex, widgetItem, parseItemKey, createDictionary, readStringList, STRINGS_FILE };
