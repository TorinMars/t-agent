// The API of the T-Attention desktop window (macOS), mounted at /api/attention/widget. See "T-Attention desktop window (macOS)" in docs/design/attention-desktop-window.md.
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
//
// The window asks GET /tick every 5 s: the list, the notices, the live activity and the preferences in one answer, the list only when it is not
// the one the window has (`etag`). The list is kept between ticks, each part read again only when it may have changed or has reached its age
// ("The kept list" below): a tick in which nothing changed runs no query of the list and no remote request, apart from those ages. GET /items,
// /notices, /activity and /prefs answer as before, for a window older than /tick; GET /items reads every part again each time.
//
// POST /open-terminal (Open session): tells the open T-Agent page of this machine seen last to show a terminal in place and asks the browser extension
// to bring its tab to the front, instead of opening a new tab (see the route; services/page-channel.js).
//
// Scheduled and recurring tasks ("Scheduled and recurring tasks (window side)" in docs/design/attention-desktop-window.md): an item of an engine with
// schedules carries `schedule`, `then_action`, `next_at`, `schedule_state`, `runs`, `last_fired_at`, `last_done_at`, `schedule_text` as its owner
// sends them, and `then_target` (the session of a prompt, the task of a script, with a name read here for this machine). POST /items/:key/run-now
// (Send now, Run again), POST /schedule/preview ("Next: ...") and GET /targets (the sessions and tasks of an engine for the form) go to the owner.
const crypto = require('node:crypto');
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
// How long a part of the kept list is used before it is read again without a reason to (the reasons are in createAttentionWidgetRoutes).
const REMOTE_TTL_MS = 10 * 1000; // the items of a connected service
const ENGINES_TTL_MS = 30 * 1000; // which engines are listed, with their names and colours
const AGENTS_TTL_MS = 60 * 1000; // the agents of this machine's terminals
const PREFS_TTL_MS = 30 * 1000; // the window preferences
const TICK_WAIT_MS = 250; // how long a tick waits for a remote read that only its TTL asked for; a slower one is in the next tick
const AGENT_CHUNK = 500; // task ids in one query
const ETAG = /^[A-Za-z0-9_-]{1,64}$/;
const ENGINE_KEY = /^(?:local|remote:[1-9]\d{0,14})$/;
const ITEM_KEY = /^(local|remote:[1-9]\d{0,14}):([1-9]\d{0,14})$/;
const TAGENT_TASK = /^[1-9]\d{0,14}$/;
const TAGENT_TERMINAL = /^[a-zA-Z0-9_-]{1,64}$/;
// The agents whose terminals the window names and offers as targets (the kinds of routes/terminal.js).
const WINDOW_AGENTS = new Set(['claude', 'codex', 'opencode']);
const REPLY_MAX = 4000;
const ACTIVITY_LIMIT = 50;
const BRIDGE_WAIT_MS = 1500; // how long POST /open-terminal waits for the browser extension to bring the tab to the front
const BRIDGE_TIMEOUT_MS = 1000; // the time the extension is given for tabs.reveal
const ACTIVITY_ORDER = { running: 0, waiting: 1, done: 2 };
const TARGETS_LIMIT = 300; // sessions or tasks GET /targets lists
const TARGET_TASKS_READ = 40; // tasks of a connected service whose terminals GET /targets reads
const REPLY_NOTE = 'Replied from the desktop window';
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

// The page path that opens a terminal (public/js/h5.js, `?openTerminal=<engine>:<task id>:<terminal id>`); the parts are checked, so nothing needs escaping.
const openTerminalPath = (engine, taskId, terminalId) => `/?openTerminal=${engine}:${taskId}:${terminalId}`;

// The T-Agent terminal an item belongs to (context.tagent, set by services/attention.js tieToTerminal), or null. `info(taskId, terminalId)` ->
// { agent, live } reads this machine's terminals (routes/terminal.js terminalInfo); for a connected service there is none: agent null, live null (unknown).
function sessionOf(engine, item, info) {
  const tagent = item && item.context && item.context.tagent;
  if (!tagent || typeof tagent !== 'object') return null;
  const taskId = String(tagent.task_id ?? '');
  const terminalId = String(tagent.terminal_id ?? '');
  if (!TAGENT_TASK.test(taskId) || !TAGENT_TERMINAL.test(terminalId)) return null;
  let agent = null;
  let live = null;
  if (engine === 'local' && info) {
    let found = null;
    try { found = info(taskId, terminalId); } catch { found = null; }
    agent = found && WINDOW_AGENTS.has(found.agent) ? found.agent : null;
    live = Boolean(found && found.live);
  }
  return { engine, task_id: taskId, terminal_id: terminalId, agent, live, open_path: openTerminalPath(engine, taskId, terminalId) };
}

const hasOwn = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
// A JSON column as an object (the owner sends it parsed; a JSON string is read too), null for anything else.
function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
const textOrNull = value => (typeof value === 'string' && value ? value : null);
// What happens at the time: null (remind me), { kind: 'prompt', task_id, terminal_id, text } or { kind: 'script', task_id, script, timeout_min }.
function thenActionOf(value) {
  const then = jsonObject(value);
  if (!then) return null;
  const taskId = String(then.task_id ?? '');
  if (then.kind === 'prompt' && TAGENT_TASK.test(taskId) && TAGENT_TERMINAL.test(String(then.terminal_id ?? ''))) {
    return { kind: 'prompt', task_id: taskId, terminal_id: String(then.terminal_id), text: typeof then.text === 'string' ? then.text : '' };
  }
  if (then.kind === 'script' && TAGENT_TASK.test(taskId)) {
    const timeout = Number(then.timeout_min);
    return { kind: 'script', task_id: taskId, script: typeof then.script === 'string' ? then.script : '', timeout_min: Number.isInteger(timeout) && timeout > 0 ? timeout : 30 };
  }
  return null;
}
// The schedule fields of an item whose owner has schedules (its items carry `schedule`); none for an older owner, so the window shows no "When" for it.
// `then_target`: where a prompt goes ({ engine, task_id, terminal_id, open_path }) or the task a script runs in ({ engine, task_id }), with `name`
// filled in for this machine when the list is put together (null otherwise: not known here).
function scheduleFields(engine, item) {
  if (!hasOwn(item, 'schedule')) return {};
  const schedule = jsonObject(item.schedule);
  const then = thenActionOf(item.then_action);
  const runs = Number(item.runs);
  const exit = Number(item.last_exit);
  let target = null;
  if (then && then.kind === 'prompt') target = { engine, task_id: then.task_id, terminal_id: then.terminal_id, name: null, open_path: openTerminalPath(engine, then.task_id, then.terminal_id) };
  if (then && then.kind === 'script') target = { engine, task_id: then.task_id, name: null };
  return {
    schedule: schedule && (schedule.kind === 'once' || schedule.kind === 'repeat') ? schedule : null,
    then_action: then,
    next_at: textOrNull(item.next_at),
    schedule_state: item.schedule_state === 'waiting' || item.schedule_state === 'due' ? item.schedule_state : null,
    runs: Number.isInteger(runs) && runs > 0 ? runs : 0,
    last_fired_at: textOrNull(item.last_fired_at),
    last_done_at: textOrNull(item.last_done_at),
    schedule_text: textOrNull(item.schedule_text),
    // The exit code of the last script run, when the owner sends it (not part of the first contract; the window falls back to the reason).
    ...(Number.isInteger(exit) && hasOwn(item, 'last_exit') ? { last_exit: exit } : {}),
    then_target: target,
  };
}

// An item as the window reads it. `info`: see sessionOf.
function widgetItem(engine, item, info = null) {
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
    // As stored (services/attention.js linkUrl): http(s), or a page path of the T-Agent app ('/...'). The window checks it again before opening it.
    link_url: typeof item.link_url === 'string' && item.link_url ? item.link_url : null,
    link_label: typeof item.link_label === 'string' && item.link_label ? item.link_label : null,
    priority: item.priority ?? null,
    due_date: item.due_date ?? null,
    sort_order: typeof item.sort_order === 'number' ? item.sort_order : null,
    updated_at: item.updated_at ?? null,
    created_at: item.created_at ?? null,
    session: sessionOf(engine, item, info),
    ...scheduleFields(engine, item),
  };
}

const notSupported = () => { throw new WidgetError('SCHEDULES_UNSUPPORTED', 'This T-Agent has no scheduled tasks', 501); };
// This machine's T-Attention as an engine adapter: the same calls as the page's, as the person ('user').
// `runNow(id, options)` and `previewSchedule(schedule)`: the schedule calls of this machine (POST /api/attention/:id/run-now and
// /api/attention/schedule/preview, see createAttentionWidgetRoutes).
function localEngine(service, { runNow = notSupported, previewSchedule = notSupported } = {}) {
  const actor = { actor: 'user' };
  return {
    // The open items and the FINISHED_KEEP items finished last: only what the window keeps (services/attention.js list, recentFinished).
    list() { return service.list({ limit: LIST_LIMIT, recentFinished: FINISHED_KEEP }); },
    async get(id) { return service.get(id); },
    async create(body) { return service.create(body, { ...actor, defaultSource: 'user' }); },
    async update(id, body) { return service.update(id, body, actor); },
    async move(id, body) { service.move(id, body, actor); },
    async remove(id) { service.remove(id, actor); },
    async runNow(id) { return runNow(id, actor); },
    async preview(schedule) { return previewSchedule(schedule); },
  };
}

// A connected service's T-Attention through the proxy's helper. `kinds`: row id -> 'new' (its list answers `recent_finished`) or 'old' (it
// ignores the parameter), learnt from its answers and kept by the routes.
function remoteEngine(remote, row, { readTimeoutMs, kinds = new Map() }) {
  const call = (method, pathname, body, timeoutMs) => remote.call(row, { method, path: pathname, body, ...(timeoutMs ? { timeoutMs } : {}) });
  const list = answer => (answer && Array.isArray(answer.items) ? answer.items : []);
  const id = Number(row.id);
  return {
    // The open items and the FINISHED_KEEP items finished last, in one read (`recent_finished`; the answer names the number when the service
    // did it). A service older than the parameter ignores it and answers the open items alone; its finished items are then read as before
    // (status filter, up to LIST_LIMIT; the merge keeps the newest). While it is not known which one a service is, or for an older one, both
    // reads go out in parallel (the old cost); a service known to be new gets the one read. Every answer is looked at, so an upgrade or a
    // downgrade is noticed.
    async list() {
      const both = call('GET', `?limit=${LIST_LIMIT}&recent_finished=${FINISHED_KEEP}`, undefined, readTimeoutMs);
      const finished = () => call('GET', `?status=${[...FINISHED].join(',')}&limit=${LIST_LIMIT}`, undefined, readTimeoutMs);
      const whole = answer => Boolean(answer) && Number.isInteger(answer.recent_finished);
      if (kinds.get(id) === 'new') {
        const answer = await both;
        if (whole(answer)) return list(answer);
        kinds.set(id, 'old');
        return [...list(answer), ...list(await finished())];
      }
      const [answer, rest] = await Promise.all([both, finished()]);
      kinds.set(id, whole(answer) ? 'new' : 'old');
      return whole(answer) ? list(answer) : [...list(answer), ...list(rest)];
    },
    async get(id) {
      try { const found = await call('GET', `/${id}`); return found && found.item ? found.item : null; }
      catch (error) { if (error instanceof RemoteAttentionError && error.statusCode === 404) return null; throw error; }
    },
    async create(body) { return call('POST', '', body); },
    async update(id, body) { return call('PATCH', `/${id}`, body); },
    async move(id, body) { await call('POST', `/${id}/move`, body); },
    async remove(id) { await call('DELETE', `/${id}`); },
    async runNow(id) { return call('POST', `/${id}/run-now`, {}); },
    async preview(schedule) { return call('POST', '/schedule/preview', { schedule }); },
  };
}

// A linked engine whose items this one keeps a read copy of (services/attention-copy.js, docs/design/attention-copies.md): the window reads the copies (the
// same items as the page, also while that engine is offline), and its changes go to the engine itself while it answers; while it is offline the safe
// ones are queued here and the others refused, as on the page. `serverId`: the remote_servers row.
const cannotReach = error => !(error instanceof RemoteAttentionError) || error.statusCode >= 502 || /OFFLINE|CONNECTION|TIMEOUT/.test(String(error.message || ''));
function copyEngine(engine, serverId, copy) {
  const fromCopy = (method, itemId = null, sub = '', body) => {
    const answer = copy.offline({ serverId, method, itemId, sub, body });
    if (!answer) throw new RemoteAttentionError(502, { error: 'REMOTE_OFFLINE' });
    if (answer.status >= 400) throw new RemoteAttentionError(answer.status, answer.body);
    return answer.body;
  };
  const live = async (method, itemId, sub, body, run) => {
    if (!copy.peerOnline(serverId)) return fromCopy(method, itemId, sub, body);
    try {
      const result = await run();
      if (method !== 'GET') copy.nudge(serverId);
      return result;
    } catch (error) {
      if (cannotReach(error)) return fromCopy(method, itemId, sub, body);
      throw error;
    }
  };
  return {
    copy: true,
    list() { return fromCopy('GET').items; },
    async get(id) {
      try { return await live('GET', id, '', undefined, () => engine.get(id)).then(found => (found && found.item ? found.item : found)); }
      catch (error) { if (error instanceof RemoteAttentionError && error.statusCode === 404) return null; throw error; }
    },
    async create(body) { return live('POST', null, '', body, () => engine.create(body)); },
    async update(id, body) { return live('PATCH', id, '', body, () => engine.update(id, body)); },
    async move(id, body) { await live('POST', id, '/move', body, () => engine.move(id, body)); },
    async remove(id) { await live('DELETE', id, '', undefined, () => engine.remove(id)); },
    // Not safe while the owner is offline: the copies refuse it there (409), as on the page.
    async runNow(id) { return live('POST', id, '/run-now', {}, () => engine.runNow(id)); },
    // A question, not a change: only the owner answers it (never queued).
    async preview(schedule) { return engine.preview(schedule); },
  };
}

// Rejects a promise that takes longer than ms.
function within(promise, ms) {
  let timer;
  const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('REMOTE_TIMEOUT')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
// Resolves when the promise settles, or after ms.
function settledWithin(promise, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    const done = () => { clearTimeout(timer); resolve(); };
    promise.then(done, done);
  });
}

// What is kept of an engine's list between ticks: each item as the window reads it (its session without `agent` and `live`, which are filled in for
// this machine when the list is put together) with what the merge sorts by; not the notes, the context and the meta. An id counts once. Of the
// finished items only the FINISHED_KEEP newest by completed_at: the merged list keeps that many of all engines together, so no other can be in it.
function keptPart(engine, list) {
  const seen = new Set();
  const open = [];
  const finished = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !Number.isSafeInteger(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    const entry = { engine, id: item.id, order: Number(item.sort_order) || 0, out: widgetItem(engine, item, null) };
    if (!FINISHED.has(item.status)) open.push(entry);
    else finished.push({ ...entry, at: String(item.completed_at || item.updated_at || '') });
  }
  finished.sort((a, b) => b.at.localeCompare(a.at));
  // Whether the owner has schedules: its items carry the field (an older one sends none).
  const schedules = (Array.isArray(list) ? list : []).some(item => hasOwn(item, 'schedule'));
  return { open, finished: finished.slice(0, FINISHED_KEEP), schedules };
}
const sessionKey = session => `${session.task_id}:${session.terminal_id}`;

// GET /targets as the window reads it: at most TARGETS_LIMIT of each, every field checked.
function cleanTargets(answer) {
  const text = value => (typeof value === 'string' ? value.trim().slice(0, 200) : '');
  const sessions = (answer && Array.isArray(answer.sessions) ? answer.sessions : [])
    .filter(entry => entry && TAGENT_TASK.test(String(entry.task_id ?? '')) && TAGENT_TERMINAL.test(String(entry.terminal_id ?? '')))
    .slice(0, TARGETS_LIMIT)
    .map(entry => ({ task_id: String(entry.task_id), terminal_id: String(entry.terminal_id), name: text(entry.name), task_title: text(entry.task_title), agent: WINDOW_AGENTS.has(entry.agent) ? entry.agent : null }));
  const tasks = (answer && Array.isArray(answer.tasks) ? answer.tasks : [])
    .filter(entry => entry && TAGENT_TASK.test(String(entry.id ?? '')))
    .slice(0, TARGETS_LIMIT)
    .map(entry => ({ id: String(entry.id), title: text(entry.title) }));
  return { sessions, tasks };
}

// One task's terminals as the window lists them: the agent terminals (Claude, Codex, OpenCode), named as the task's terminal list names them.
const agentTerminals = (task, terminals) => (Array.isArray(terminals) ? terminals : [])
  .filter(row => row && WINDOW_AGENTS.has(row.agent))
  .map(row => ({ task_id: String(task.id), terminal_id: String(row.terminal_id), name: row.title || '', task_title: task.title || '', agent: row.agent }));

// This machine's tasks in use and their agent terminals (routes/terminal.js listTerminals, which names a terminal after its session).
function localTargetList(db) {
  const tasks = db.prepare('SELECT id, title FROM tasks WHERE archived_at IS NULL ORDER BY id DESC LIMIT ?').all(TARGETS_LIMIT);
  const withAgents = new Set(db.prepare("SELECT DISTINCT task_id FROM task_terminals WHERE agent IN ('claude', 'codex', 'opencode')").all().map(row => row.task_id));
  const { listTerminals } = require('./terminal');
  const sessions = [];
  for (const task of tasks) {
    if (!withAgents.has(task.id)) continue;
    try { sessions.push(...agentTerminals(task, listTerminals(task.id))); } catch { /* a task removed meanwhile */ }
  }
  return { sessions, tasks: tasks.map(task => ({ id: task.id, title: task.title })) };
}

// A connected service's tasks (GET /v1/tasks) and the agent terminals of its first TARGET_TASKS_READ tasks (GET /v1/tasks/:id/terminals, in parallel).
async function remoteTargetList(row, { timeoutMs }) {
  const { request } = require('../services/remote-client');
  const { decryptToken } = require('../lib/token-crypto');
  const token = decryptToken(row.token_cipher, require('../config').sessionSecret);
  const listed = await request(row.base_url, '/v1/tasks', token, { timeoutMs });
  const tasks = (Array.isArray(listed) ? listed : Array.isArray(listed && listed.tasks) ? listed.tasks : []).filter(task => task && Number.isSafeInteger(Number(task.id)) && !task.archived_at);
  const lists = await Promise.all(tasks.slice(0, TARGET_TASKS_READ).map(task => request(row.base_url, `/v1/tasks/${Number(task.id)}/terminals`, token, { timeoutMs })
    .then(terminals => agentTerminals(task, terminals), () => [])));
  return { sessions: lists.flat(), tasks: tasks.map(task => ({ id: task.id, title: task.title })) };
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
  notices = require('../services/widget-notices').defaultNotices(),
  // This machine's terminals (routes/terminal.js): what an item's terminal is, a reply typed into it, and the live activity of all of them.
  // terminalInfo answers one item (an action's answer); the list asks liveTerminals (the ids of a task's running shells, in memory) and reads
  // the agents of all its items in one query (see "The kept list").
  terminalInfo = (taskId, terminalId) => require('./terminal').terminalInfo(taskId, terminalId),
  liveTerminals = taskId => require('./terminal').liveTerminalIds(taskId),
  sendToTerminal = (taskId, terminalId, text) => require('./terminal').sendToTerminal(taskId, terminalId, text),
  liveActivity = () => require('./terminal').liveTerminalActivity(),
  now = () => new Date(),
  // Open session (POST /open-terminal): the open pages of this machine (services/page-channel.js) and the browser extension's bridge, which brings
  // the told page's tab to the front (services/browser-bridge.js, method tabs.reveal); bridgeWaitMs is how long the answer waits for it.
  pages = null,
  bridge = null,
  bridgeWaitMs = BRIDGE_WAIT_MS,
  // The read copies of linked engines (services/attention-copy.js), or null when they are off.
  copies = () => require('../services/attention-copy').sharedCopy(),
  remoteTtlMs = REMOTE_TTL_MS,
  enginesTtlMs = ENGINES_TTL_MS,
  agentsTtlMs = AGENTS_TTL_MS,
  prefsTtlMs = PREFS_TTL_MS,
  tickWaitMs = TICK_WAIT_MS,
  // Scheduled tasks on this machine (the server's part, services/attention-schedule.js and services/attention.js): run one now (Send now, Run
  // again) and preview a schedule ({ next, text, error? }). Before that part exists they answer 501 SCHEDULES_UNSUPPORTED.
  runNow = (id, options) => {
    if (typeof service.runNow !== 'function') notSupported();
    return service.runNow(id, options);
  },
  previewSchedule = schedule => {
    let schedules;
    try { schedules = require('../services/attention-schedule'); } catch { notSupported(); }
    return schedules.preview(schedule, Date.now(), { tz: schedules.systemZone() });
  },
  // Whether this machine has schedules (its "+" form shows "When" and "Then").
  localSchedules = () => { try { require.resolve('../services/attention-schedule'); return true; } catch { return false; } },
  // The sessions (agent terminals) and tasks of this machine, and of a connected service (its /v1/tasks and the terminals of its first tasks), for the
  // form's pop-ups: -> { sessions: [{ task_id, terminal_id, name, task_title, agent }], tasks: [{ id, title }] }.
  localTargets = () => localTargetList(db),
  remoteTargets = row => remoteTargetList(row, { timeoutMs: readTimeoutMs }),
} = {}) {
  if (!service) throw new Error('createAttentionWidgetRoutes needs the attention service');
  if (!launcher || !settings) throw new Error('createAttentionWidgetRoutes needs the launcher and the settings');

  const nowMs = () => now().getTime();
  const scheduleCalls = { runNow, previewSchedule };
  // An action's answer: one item, its terminal read with routes/terminal.js terminalInfo.
  const itemOut = (engine, item) => widgetItem(engine, item, engine === 'local' ? terminalInfo : null);
  const remoteKinds = new Map(); // see remoteEngine
  const rowsOf = login => db.prepare('SELECT * FROM remote_servers WHERE owner_id = ? AND enabled = 1 ORDER BY created_at ASC, id ASC').all(login);
  // The engine of a key: this machine, or an enabled row of this owner (hidden ones too: an item the window already has stays reachable).
  function engineOf(key) {
    if (key === 'local') return localEngine(service, scheduleCalls);
    const id = Number(String(key).slice('remote:'.length));
    const row = db.prepare('SELECT * FROM remote_servers WHERE id = ? AND owner_id = ? AND enabled = 1').get(id, owner());
    if (!row) throw new WidgetError('ENGINE_NOT_FOUND', 'This device is not connected', 404);
    return engineOfRow(row);
  }
  // A connected service's engine: its read copy when the copies cover it, else read live.
  function engineOfRow(row) {
    const engine = remoteEngine(remote, row, { readTimeoutMs, kinds: remoteKinds });
    const copy = copies();
    return copy && copy.covers(row.id) ? copyEngine(engine, Number(row.id), copy) : engine;
  }
  const localEntry = () => ({ key: 'local', name: localName(), local: true, color_index: tagColorIndex(localInstanceId()), engine: localEngine(service, scheduleCalls) });
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
      const engine = engineOfRow(row);
      const copied = engine.copy ? (copies().owners().find(entry => entry.engine === key) || null) : null;
      // A copied engine that is offline says since when its items are as shown (`as_of`).
      out.push({ key, name: row.name, local: false, color_index: tagColorIndex(instanceId), engine, ...(copied && !copied.online ? { offline: true, as_of: copied.as_of } : {}) });
    }
    // As on the page: when every device is hidden or none is left, this machine is shown.
    if (!out.length) out.push(localEntry());
    return out;
  }

  // The kept list. Each engine's part (keptPart, or the error of its read) is kept with the serial it was read at:
  //  - this machine's part is read again after a change on its change bus (service.onChange; a service without one is read every time);
  //  - a connected service's part when it is remoteTtlMs old, and at once after the window changed one of its items (touch);
  //  - the engines (rows, hidden devices, names, colours) every enginesTtlMs: a device added, removed or hidden shows within that time;
  //  - the agents of this machine's terminals (one query for all items) when the set of terminals or of live ones changes, else every
  //    agentsTtlMs. Whether a terminal's shell runs is asked of routes/terminal.js in memory on every tick (liveTerminals), so a terminal
  //    that starts or ends changes the list at once. A shell that is being closed counts as running until it has ended.
  // A tick waits for a read it needs (the first one, or one after a change) up to readTimeoutMs like GET /items, and for a read that only
  // the age asked for up to tickWaitMs: a slower one is answered by the next tick, which meanwhile gets the part as it was.
  const parts = new Map(); // engine key -> { serial, applied, startedAt, result: { part } | { error } | null, version, reading, readingSerial }
  const partOf = key => {
    if (!parts.has(key)) parts.set(key, { serial: 1, applied: 0, startedAt: 0, result: null, version: 0, reading: null, readingSerial: 0 });
    return parts.get(key);
  };
  const touch = key => { if (parts.has(key)) parts.get(key).serial += 1; };
  const localBus = typeof service.onChange === 'function';
  if (localBus) service.onChange(() => touch('local'));
  // A copied engine's part is read again after a change of its copies (their own bus), and every part when an owner went offline or came back.
  const copyBus = copies();
  if (copyBus) {
    copyBus.onChange(change => {
      if (change && change.kind === 'owners') { for (const key of parts.keys()) if (key !== 'local') touch(key); enginesKept = null; return; }
      if (change && change.item && typeof change.item.owner_engine === 'string') touch(change.item.owner_engine);
    });
  }
  const ttlOf = entry => (entry.local ? (localBus ? Infinity : 0) : entry.engine && entry.engine.copy ? Infinity : remoteTtlMs);
  // This machine's failed read is never kept (the next tick tries again, as GET /items did); a connected service's is, for its TTL.
  const fresh = (entry, part, at) => part.result !== null && !(entry.local && part.result.error) && part.applied === part.serial && at - part.startedAt < ttlOf(entry);

  function readPart(entry, part) {
    if (part.reading && part.readingSerial === part.serial) return part.reading;
    const serial = part.serial;
    const startedAt = nowMs();
    const reading = within(Promise.resolve().then(() => entry.engine.list()), readTimeoutMs)
      .then(list => ({ part: keptPart(entry.key, list) }), error => ({ error }))
      .then(result => {
        if (serial >= part.applied) Object.assign(part, { applied: serial, startedAt, result, version: part.version + 1 });
        if (part.reading === reading) part.reading = null;
      });
    part.reading = reading;
    part.readingSerial = serial;
    return reading;
  }
  // Reads what the engines need (force: everything, as GET /items does) and answers [{ entry, result }].
  async function settle(engines, force) {
    const at = nowMs();
    await Promise.all(engines.map(entry => {
      const part = partOf(entry.key);
      if (!force && fresh(entry, part, at)) return null;
      const reading = readPart(entry, part);
      const needed = force || part.result === null || part.applied !== part.serial;
      return needed ? reading : settledWithin(reading, tickWaitMs);
    }));
    return engines.map(entry => ({ entry, result: partOf(entry.key).result || { error: new Error('REMOTE_TIMEOUT') } }));
  }

  let enginesKept = null; // { at, list }
  function engines(force) {
    if (force || !enginesKept || nowMs() - enginesKept.at >= enginesTtlMs) enginesKept = { at: nowMs(), list: listedEngines() };
    return enginesKept.list;
  }

  // The agents of terminals: `${task_id}:${terminal_id}` -> 'claude' | 'codex' | 'opencode', one query for all task ids (in chunks of AGENT_CHUNK), as
  // routes/terminal.js terminalInfo reads them one by one (none for the 'default' terminal).
  // The names come with them: the terminal's title, else its task's (`then_target.name` of a prompt).
  function readAgents(sessions) {
    const agents = new Map();
    const names = new Map();
    const tasks = [...new Set(sessions.filter(session => session.terminal_id !== 'default').map(session => Number(session.task_id)))];
    for (let start = 0; start < tasks.length; start += AGENT_CHUNK) {
      const chunk = tasks.slice(start, start + AGENT_CHUNK);
      try {
        const rows = db.prepare(`SELECT task_id, terminal_id, agent, title, (SELECT title FROM tasks WHERE tasks.id = task_terminals.task_id) AS task_title FROM task_terminals WHERE task_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
        for (const row of rows) {
          if (WINDOW_AGENTS.has(row.agent)) agents.set(`${row.task_id}:${row.terminal_id}`, row.agent);
          const name = (typeof row.title === 'string' && row.title.trim()) || (typeof row.task_title === 'string' && row.task_title.trim()) || '';
          if (name) names.set(`${row.task_id}:${row.terminal_id}`, name);
        }
      } catch { /* no agents: none shown */ }
    }
    return { agents, names };
  }
  let agentsKept = { at: -Infinity, keys: null, live: null, agents: new Map(), names: new Map(), tasks: new Map() };
  // The titles of tasks (the tasks scripts run in), one query; none when no item has a script.
  function readTaskTitles(ids) {
    const titles = new Map();
    for (let start = 0; start < ids.length; start += AGENT_CHUNK) {
      const chunk = ids.slice(start, start + AGENT_CHUNK);
      try {
        for (const row of db.prepare(`SELECT id, title FROM tasks WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) titles.set(String(row.id), row.title || null);
      } catch { /* no names */ }
    }
    return titles;
  }
  // { live: Set of session keys whose shell runs, agents, stamp } for this machine's sessions among the items.
  function localSessions(outs, force) {
    const sessions = new Map();
    const targets = new Map(); // the sessions prompts go to, for their names
    const scriptTasks = new Set(); // the tasks scripts run in, for their names
    for (const out of outs) {
      if (out.engine !== 'local') continue;
      if (out.session) sessions.set(sessionKey(out.session), out.session);
      const target = out.then_target;
      if (target && target.terminal_id) targets.set(sessionKey(target), target);
      else if (target) scriptTasks.add(Number(target.task_id));
    }
    const live = new Set();
    for (const taskId of new Set([...sessions.values()].map(session => session.task_id))) {
      let ids = [];
      try { ids = liveTerminals(taskId) || []; } catch { ids = []; }
      for (const id of ids) if (sessions.has(`${taskId}:${id}`)) live.add(`${taskId}:${id}`);
    }
    const keys = [...new Set([...sessions.keys(), ...targets.keys()])].sort().join(',') + `|${[...scriptTasks].sort().join(',')}`;
    const running = [...live].sort().join(',');
    if (force || keys !== agentsKept.keys || running !== agentsKept.live || nowMs() - agentsKept.at >= agentsTtlMs) {
      const read = readAgents([...sessions.values(), ...targets.values()]);
      agentsKept = { at: nowMs(), keys, live: running, agents: read.agents, names: read.names, tasks: readTaskTitles([...scriptTasks]) };
    }
    return { live, agents: agentsKept.agents, names: agentsKept.names, tasks: agentsKept.tasks, stamp: `${agentsKept.at}|${running}` };
  }

  const unsupported = error => error instanceof RemoteAttentionError && error.statusCode === 501;
  let memo = null; // { key, list, etag }
  // The merged list: { list: { items, engines, failed }, etag }. force: every part read again (GET /items).
  async function keptList(force = false) {
    const listed = engines(force);
    let answers = await settle(listed, force);
    // As on the page: when no listed engine has T-Attention (this machine hidden, the others without it), this machine is shown.
    if (!answers.some(({ result }) => !unsupported(result.error)) && !listed.some(entry => entry.local)) answers = await settle([localEntry()], force);
    const shown = [];
    const failed = [];
    const open = [];
    let finished = [];
    for (const { entry, result } of answers) {
      if (result.error) {
        if (unsupported(result.error)) continue; // no T-Attention there: left out quietly
        if (entry.local) throw result.error;
        failed.push(entry.name);
        shown.push(entry);
        continue;
      }
      shown.push(entry);
      open.push(...result.part.open);
      finished.push(...result.part.finished);
    }
    // The FINISHED_KEEP finished last of all engines; then the page's order inside a group: the highest sort_order first, then the highest id.
    finished = finished.sort((a, b) => b.at.localeCompare(a.at)).slice(0, FINISHED_KEEP);
    const outs = [...open, ...finished].sort((a, b) => b.order - a.order || b.id - a.id).map(entry => entry.out);
    const sessions = localSessions(outs, force);
    // `schedules: true` for an engine with scheduled tasks (its form shows "When" and "Then"): this machine when it has them, a connected service when
    // its items carry them.
    const withSchedules = new Set(answers.filter(({ entry, result }) => (entry.local && localSchedules()) || (result.part && result.part.schedules)).map(({ entry }) => entry.key));
    const engineList = shown.map(({ key, name, local, color_index: color, offline, as_of: asOf }) => ({ key, name, local, color_index: color, ...(withSchedules.has(key) ? { schedules: true } : {}), ...(offline ? { offline: true, as_of: asOf || null } : {}) }));
    const key = JSON.stringify([engineList, failed, answers.map(({ entry }) => `${entry.key}:${partOf(entry.key).version}`), sessions.stamp]);
    if (!force && memo && memo.key === key) return memo;
    const items = outs.map(out => {
      if (out.engine !== 'local' || (!out.session && !out.then_target)) return out;
      const next = { ...out };
      if (out.session) {
        const at = sessionKey(out.session);
        next.session = { ...out.session, agent: sessions.agents.get(at) || null, live: sessions.live.has(at) };
      }
      if (out.then_target) {
        const name = out.then_target.terminal_id ? sessions.names.get(sessionKey(out.then_target)) : sessions.tasks.get(String(out.then_target.task_id));
        next.then_target = { ...out.then_target, name: name || null };
      }
      return next;
    });
    const list = { items, engines: engineList, failed };
    const etag = crypto.createHash('sha1').update(JSON.stringify(list)).digest('base64url').slice(0, 22);
    memo = { key, list, etag };
    return memo;
  }
  const listAnswer = ({ list }) => ({ ...list, host: os.hostname(), updated_at: now().toISOString() });

  const api = express.Router();
  const parseJson = express.json({ limit: '256kb' });

  // Every part read again, as before /tick (a window older than it polls this every 5 s).
  api.get('/items', handle(async (req, res) => res.json(listAnswer(await keptList(true)))));

  // A change the window makes: that engine's part is read again by the next tick, also when the change failed (the window asks again after a
  // refusal, and the item may have changed meanwhile).
  const changing = (engineKey, promise) => Promise.resolve(promise).finally(() => touch(engineKey));

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
    for (const field of ['status', 'notes', 'schedule', 'then_action']) if (body[field] !== undefined) create[field] = body[field];
    const parent = parentIdOf(body, body.engine);
    if (parent !== undefined) create.parent_id = parent;
    res.status(201).json(itemOut(body.engine, await changing(body.engine, engine.create(create))));
  }));

  api.patch('/items/:key', parseJson, handle(async (req, res) => {
    const key = keyOf(req);
    const body = { ...objectBody(req) };
    const parent = parentIdOf(body, key.engine);
    delete body.parent_key;
    delete body.parent_id;
    if (parent !== undefined) body.parent_id = parent;
    res.json(itemOut(key.engine, await changing(key.engine, engineOf(key.engine).update(key.id, body))));
  }));

  api.delete('/items/:key', handle(async (req, res) => {
    const key = keyOf(req);
    await changing(key.engine, engineOf(key.engine).remove(key.id));
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
    await changing(key.engine, engineOf(key.engine).move(key.id, move));
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
      res.json(await changing(key.engine, (async () => {
        const item = await engine.get(key.id);
        if (!item) throw new WidgetError('NOT_FOUND', 'Task not found', 404);
        if (item.status !== action.from) throw new WidgetError('WRONG_STATUS', action.message, 409);
        return itemOut(key.engine, await engine.update(key.id, action.body(req)));
      })()));
    }));
  }

  // A reply to the agent of an item, typed in the window: sent to the item's terminal on this machine (routes/terminal.js sendToTerminal: a bracketed
  // paste, then Enter on its own) and noted on the item. Only for this machine's items whose terminal runs now.
  api.post('/items/:key/reply', parseJson, handle(async (req, res) => {
    const key = keyOf(req);
    const body = objectBody(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > REPLY_MAX) throw invalid(`text must be 1 to ${REPLY_MAX} characters`);
    if (key.engine !== 'local') throw new WidgetError('REPLY_REMOTE', 'Replies go only to terminals on this machine', 409);
    const item = service.get(key.id);
    if (!item) throw new WidgetError('NOT_FOUND', 'Task not found', 404);
    const session = sessionOf('local', item, null);
    if (!session) throw new WidgetError('NO_SESSION', 'This task has no agent terminal', 409);
    if (!sendToTerminal(session.task_id, session.terminal_id, text)) throw new WidgetError('TERMINAL_NOT_RUNNING', "The agent's terminal is not running", 409);
    service.update(key.id, { activity: { kind: 'note', text: REPLY_NOTE } }, { actor: 'user' });
    res.json({ ok: true });
  }));

  // Send now (a prompt the busy session did not take) and Run again (a script that failed), or a reminder fired now: the owner's POST
  // /api/attention/:id/run-now (409 SESSION_BUSY while the session is busy; refused while a copied owner is offline). -> { ok: true }
  api.post('/items/:key/run-now', parseJson, handle(async (req, res) => {
    const key = keyOf(req);
    await changing(key.engine, engineOf(key.engine).runNow(key.id));
    res.json({ ok: true });
  }));

  // "Next: ..." of the form: the owner's POST /api/attention/schedule/preview (its time zone and rules). { engine, schedule } -> { next, text, error? }.
  api.post('/schedule/preview', parseJson, handle(async (req, res) => {
    const body = objectBody(req);
    if (typeof body.engine !== 'string' || !ENGINE_KEY.test(body.engine)) throw invalid("engine must be 'local' or 'remote:<id>'");
    if (!body.schedule || typeof body.schedule !== 'object' || Array.isArray(body.schedule)) throw invalid('schedule must be a JSON object');
    const answer = await within(Promise.resolve().then(() => engineOf(body.engine).preview(body.schedule)), readTimeoutMs);
    const next = answer && Array.isArray(answer.next) ? answer.next.filter(value => typeof value === 'string').slice(0, 3) : [];
    res.json({ next, text: answer && typeof answer.text === 'string' ? answer.text : null, ...(answer && typeof answer.error === 'string' ? { error: answer.error } : {}) });
  }));

  // The pop-ups of the form: the sessions a prompt can go to and the tasks a script can run in, of the item's engine. ?engine=<key>.
  api.get('/targets', handle(async (req, res) => {
    const key = typeof req.query.engine === 'string' ? req.query.engine : 'local';
    if (!ENGINE_KEY.test(key)) throw invalid("engine must be 'local' or 'remote:<id>'");
    let answer;
    if (key === 'local') answer = localTargets();
    else {
      const row = db.prepare('SELECT * FROM remote_servers WHERE id = ? AND owner_id = ? AND enabled = 1').get(Number(key.slice('remote:'.length)), owner());
      if (!row) throw new WidgetError('ENGINE_NOT_FOUND', 'This device is not connected', 404);
      try { answer = await within(Promise.resolve().then(() => remoteTargets(row)), readTimeoutMs); }
      catch (error) { if (error instanceof WidgetError || error instanceof RemoteAttentionError) throw error; throw new WidgetError('REMOTE_CONNECTION_FAILED', 'Could not reach this device', 502); }
    }
    res.json(cleanTargets(answer));
  }));

  // Open session without a new tab: tells the open T-Agent page of this machine seen last (services/page-channel.js; only top-level pages of this machine
  // register) to show this terminal in place, as its `?openTerminal=` link does, and asks the browser extension, when one is connected, to bring that
  // page's tab to the front. { engine, task_id, terminal_id } -> { delivered: 0 | 1, focused }. delivered 0: no page was told, the window opens the link.
  // focused: the extension brought the tab to the front (false without an extension, with an older one without tabs.reveal, or when it failed or was
  // slower than bridgeWaitMs; the window then brings the browser app forward itself).
  const pageChannel = () => pages || require('../services/page-channel').getPageChannel();
  const browserBridge = () => bridge || require('../services/browser-bridge').getBrowserBridge();
  async function revealTab(origin) {
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => browserBridge().command('tabs.reveal', { origin }, { timeoutMs: BRIDGE_TIMEOUT_MS })),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), bridgeWaitMs); }),
      ]);
      return Boolean(result && result.focused === true);
    } catch { return false; } finally { clearTimeout(timer); }
  }
  api.post('/open-terminal', parseJson, handle(async (req, res) => {
    const body = objectBody(req);
    if (typeof body.engine !== 'string' || !ENGINE_KEY.test(body.engine)) throw invalid("engine must be 'local' or 'remote:<id>'");
    const taskId = typeof body.task_id === 'number' && Number.isSafeInteger(body.task_id) ? String(body.task_id) : body.task_id;
    if (typeof taskId !== 'string' || !TAGENT_TASK.test(taskId)) throw invalid('task_id must be a task id');
    if (typeof body.terminal_id !== 'string' || !TAGENT_TERMINAL.test(body.terminal_id)) throw invalid('terminal_id must be a terminal id');
    const told = pageChannel().openTerminal({ engine: body.engine, task_id: taskId, terminal_id: body.terminal_id });
    const delivered = told && told.delivered === 1 ? 1 : 0;
    const focused = delivered === 1 && typeof told.origin === 'string' && told.origin ? await revealTab(told.origin) : false;
    res.json({ delivered, focused });
  }));

  // What the agents in this machine's terminals are doing: the live terminals that are not idle, running first, then waiting at a question, then done
  // (not acknowledged yet); within a state the newest change first. At most ACTIVITY_LIMIT.
  function activityAnswer() {
    const terminals = (liveActivity() || [])
      .filter(entry => entry && Object.prototype.hasOwnProperty.call(ACTIVITY_ORDER, entry.state) && TAGENT_TASK.test(String(entry.task_id)) && TAGENT_TERMINAL.test(String(entry.terminal_id)))
      .sort((a, b) => ACTIVITY_ORDER[a.state] - ACTIVITY_ORDER[b.state] || (Number(b.since) || 0) - (Number(a.since) || 0))
      .slice(0, ACTIVITY_LIMIT)
      .map(entry => ({
        engine: 'local',
        task_id: String(entry.task_id),
        task_title: typeof entry.task_title === 'string' ? entry.task_title : '',
        terminal_id: String(entry.terminal_id),
        title: typeof entry.title === 'string' ? entry.title : '',
        agent: WINDOW_AGENTS.has(entry.agent) ? entry.agent : null,
        state: entry.state,
        ...(entry.state === 'waiting' && (entry.waiting_kind === 'select' || entry.waiting_kind === 'accept') ? { waiting_kind: entry.waiting_kind } : {}),
        since: new Date(Number(entry.since) || 0).toISOString(),
        open_path: openTerminalPath('local', entry.task_id, entry.terminal_id),
      }));
    return { terminals, updated_at: now().toISOString() };
  }
  api.get('/activity', handle(async (req, res) => res.json(activityAnswer())));
  // In a tick, a failure of the terminals' activity is no activity (what the window shows after a failed GET /activity), not a failed tick.
  const tickActivity = () => {
    try { return activityAnswer(); } catch (error) {
      console.error(`T-Attention desktop window API: ${error && (error.stack || error.message)}`);
      return { terminals: [], updated_at: now().toISOString() };
    }
  };

  // The window's words in its language: { lang, strings: { English: shown } }. English, or a word without a translation, maps to itself.
  api.get('/strings', handle(async (req, res) => {
    const lang = settings.language();
    const words = lang === 'zh' ? dictionary() : null;
    const strings = {};
    for (const text of stringList()) strings[text] = words && typeof words[text] === 'string' ? words[text] : text;
    res.json({ lang, strings });
  }));

  // The bubbles of the window (services/widget-notices.js): { seq, notices } with the notices after `after` (a seq), oldest first; without `after`
  // the ones of the last 60 s.
  const afterOf = raw => {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw invalid('after must be a whole number of at least 0');
    return Number(raw);
  };
  api.get('/notices', handle(async (req, res) => res.json(notices.list({ after: afterOf(req.query.after) }))));

  // The window's preferences (the settings card's switches): { hotkeys, dim_when_idle, show_activity }. A window older than /tick reads them at
  // start and every 5 s. The tick keeps them for prefsTtlMs; the settings card's save (PUT /settings, here) drops that at once.
  api.get('/prefs', handle(async (req, res) => res.json(settings.prefs())));
  let prefsKept = null; // { at, prefs }
  const keptPrefs = () => {
    if (!prefsKept || nowMs() - prefsKept.at >= prefsTtlMs) prefsKept = { at: nowMs(), prefs: settings.prefs() };
    return prefsKept.prefs;
  };

  // The window's one request every 5 s: GET /tick?after=<notice seq>&items=<etag>[&activity=0] ->
  //   { etag, list: the answer of GET /items, or null when `items` is that etag; notices: the answer of GET /notices?after;
  //     activity: the answer of GET /activity, or null with activity=0; prefs: the answer of GET /prefs; updated_at }.
  // `etag` names the list's content (items, engines, failed). A value of `items` that is no etag counts as none: the list is sent.
  api.get('/tick', handle(async (req, res) => {
    const after = afterOf(req.query.after);
    const known = typeof req.query.items === 'string' && ETAG.test(req.query.items) ? req.query.items : null;
    const kept = await keptList(false);
    res.json({
      etag: kept.etag,
      list: kept.etag === known ? null : listAnswer(kept),
      notices: notices.list({ after }),
      activity: req.query.activity === '0' ? null : tickActivity(),
      prefs: keptPrefs(),
      updated_at: now().toISOString(),
    });
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
      prefsKept = null;
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

module.exports = { createAttentionWidgetRoutes, copyEngine, tagColorIndex, widgetItem, sessionOf, parseItemKey, createDictionary, readStringList, STRINGS_FILE };
