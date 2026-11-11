const express = require('express');
const db = require('../db');
const config = require('../config');
const requireAuth = require('../middleware/auth');
const { decryptToken, encryptToken } = require('../lib/token-crypto');
const { normalizeBaseUrl, request, assertRemoteTerminal } = require('../services/remote-client');
const { inspectRemoteAddress, persistRemoteServerEdit } = require('../services/remote-server-settings');
const remoteUpdates = require('../services/remote-engine-updates');
const { streamRemote } = require('../services/remote-stream');
const { getServiceLinks } = require('../services/service-links');
const { isMindmapId, LIMITS: MINDMAP_LIMITS } = require('../services/mindmap');
const { createMindmapBodyParser, sendNotFound: sendMindmapNotFound, sendTooLarge: sendMindmapTooLarge, BODY_LIMIT: MINDMAP_BODY_LIMIT } = require('./mindmap');
const { getRemoteInfo, readRemoteInfo } = require('../services/remote-info');
const engineNames = require('../services/engine-name');

const router = express.Router();
router.use(requireAuth);

const owner = req => req.session.user.login;
const safeError = error => (/^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'REMOTE_CONNECTION_FAILED');

// `name_source` is 'engine' when the name is the one the Engine keeps itself (services/engine-name.js), 'local' when it was typed here.
// Every row can be renamed (PUT /:id/name), linked rows too.
function publicServer(row, named = engineNames.engineNamedIds(db)) {
  return {
    id: row.id, name: row.name, base_url: row.base_url, enabled: Boolean(row.enabled),
    status: row.status, remote_version: row.remote_version, last_checked_at: row.last_checked_at,
    last_error: row.last_error, created_at: row.created_at,
    name_source: engineNames.nameSource(row.id, named), can_rename: true,
  };
}

const serverById = id => db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(id);
// Every /v1/info read of a saved row goes through services/remote-info.js, which keeps the row's name in step with the Engine's.
const readInfo = (row, token = decryptToken(row.token_cipher, config.sessionSecret)) => readRemoteInfo({ baseUrl: row.base_url, token, serverId: row.id });

function getServer(req) {
  return db.prepare('SELECT * FROM remote_servers WHERE id = ? AND owner_id = ?').get(req.params.id, owner(req));
}

async function checkServer(row) {
  const token = decryptToken(row.token_cipher, config.sessionSecret);
  try {
    const capabilities = await readInfo(row, token);
    db.prepare(`UPDATE remote_servers SET status = 'online', remote_version = ?, last_checked_at = CURRENT_TIMESTAMP,
      last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(capabilities.engine_version || capabilities.app_version || null, row.id);
    return capabilities;
  } catch (error) {
    const code = safeError(error);
    db.prepare(`UPDATE remote_servers SET status = ?, last_checked_at = CURRENT_TIMESTAMP, last_error = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(error.statusCode === 401 ? 'unauthorized' : 'offline', code, row.id);
    if (error.statusCode === 401) getServiceLinks().noteUnauthorized(row.id);
    throw error;
  }
}

async function assertFilesSupported(row, token) {
  let info;
  try { info = await readInfo(row, token); }
  catch (error) {
    if (error.statusCode === 404) throw Object.assign(new Error('FILES_UNSUPPORTED'), { statusCode: 501 });
    throw error;
  }
  if (!info || !Array.isArray(info.capabilities) || !info.capabilities.includes('files:read')) {
    throw Object.assign(new Error('FILES_UNSUPPORTED'), { statusCode: 501 });
  }
}

function remoteFilesPath(req, suffix = '') {
  const query = new URLSearchParams();
  for (const key of ['path', 'offset', 'hidden', 'terminal']) {
    if (req.query[key] !== undefined) query.set(key, String(req.query[key]));
  }
  const search = query.toString();
  return `/v1/tasks/${encodeURIComponent(req.params.taskId)}/files${suffix}${search ? `?${search}` : ''}`;
}

function proxyFiles(method, suffix = '') {
  return async (req, res) => {
    const row = getServer(req);
    if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
    const token = decryptToken(row.token_cipher, config.sessionSecret);
    try {
      await assertFilesSupported(row, token);
      const result = await request(row.base_url, remoteFilesPath(req, suffix), token, {
        method,
        maxBytes: 32 * 1024 * 1024,
        ...(method === 'GET' ? {} : { body: req.body || {} }),
      });
      res.status(method === 'POST' ? 201 : 200).json(result);
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: safeError(error) });
    }
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM remote_servers WHERE owner_id = ? ORDER BY created_at ASC').all(owner(req));
  const named = engineNames.engineNamedIds(db);
  res.json(rows.map(row => publicServer(row, named)));
  // After the answer: names of rows not read in the last minute are refreshed for the next read.
  getRemoteInfo().refreshStale(rows, row => ({ baseUrl: row.base_url, token: decryptToken(row.token_cipher, config.sessionSecret) }));
});

// File-sync service on the current remote node. The path is fixed so arbitrary addresses are never forwarded to.
router.all('/:id/file-sync', (req, res) => proxyFileSync(req, res, ''));
router.all('/:id/file-sync/:action', (req, res) => proxyFileSync(req, res, req.params.action));
async function proxyFileSync(req, res, action) {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  if (action && !['run', 'files', 'path', 'disconnect', 'role', 'unpair', 'invite', 'join', 'resolve'].includes(action)) return res.status(404).json({ error: 'SYNC_ROUTE_NOT_FOUND' });
  try {
    const result = await request(row.base_url, `/v1/file-sync${action ? `/${action}` : ''}`, decryptToken(row.token_cipher, config.sessionSecret), {
      method: req.method,
      ...(req.method === 'GET' ? {} : { body: req.body || {} }),
      maxBytes: 8 * 1024 * 1024,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: safeError(error) });
  }
}

router.post('/test', async (req, res) => {
  try {
    const baseUrl = normalizeBaseUrl(req.body.url, req.body.port);
    const credential = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (!credential) return res.status(400).json({ error: 'TOKEN_REQUIRED' });
    if (/^TA-/i.test(credential)) {
      const health = await request(baseUrl, '/v1/health', null);
      return res.json({ success: true, base_url: baseUrl, pairing_code: true, engine: health });
    }
    const capabilities = await readRemoteInfo({ baseUrl, token: credential });
    res.json({ success: true, base_url: baseUrl, capabilities });
  } catch (error) { res.status(400).json({ error: safeError(error) }); }
});

router.post('/', async (req, res) => {
  try {
    const baseUrl = normalizeBaseUrl(req.body.url, req.body.port);
    const credential = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (!credential) return res.status(400).json({ error: 'TOKEN_REQUIRED' });
    let token = credential;
    if (/^TA-/i.test(credential)) {
      const paired = await request(baseUrl, '/v1/pair', null, {
        method: 'POST',
        body: { code: credential, client_name: `T-Agent Client (${owner(req)})` },
      });
      token = paired.access_token;
    }
    const capabilities = await readRemoteInfo({ baseUrl, token });
    // An Engine that keeps its own name is saved under it; the form's name is for one that does not.
    const name = engineNames.reportedName(capabilities) || (typeof req.body.name === 'string' && req.body.name.trim()) || new URL(baseUrl).hostname;
    const result = db.prepare(`INSERT INTO remote_servers
      (owner_id, name, base_url, token_cipher, status, remote_version, last_checked_at)
      VALUES (?, ?, ?, ?, 'online', ?, CURRENT_TIMESTAMP)`).run(owner(req), name.slice(0, 80), baseUrl, encryptToken(token, config.sessionSecret), capabilities.engine_version || capabilities.app_version || null);
    getServiceLinks().syncEngineInfo(result.lastInsertRowid, capabilities);
    res.status(201).json(publicServer(serverById(result.lastInsertRowid)));
  } catch (error) {
    const code = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'REMOTE_ALREADY_EXISTS' : safeError(error);
    res.status(400).json({ error: code });
  }
});

// The address and credential of a linked peer belong to the link: only unlinking and joining again can change them.
function refuseLinked(req, res, next) {
  if (getServiceLinks().linkForServer(req.params.id)) return res.status(409).json({ error: 'LINK_MANAGED' });
  next();
}

router.post('/:id/test', refuseLinked, async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    const { baseUrl, capabilities } = await inspectRemoteAddress(row, req.body, config.sessionSecret);
    res.json({ success: true, base_url: baseUrl, capabilities });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

router.put('/:id', refuseLinked, async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    // When verifying a new address, reuse the encrypted saved Token; it is only persisted after the remote authenticates successfully.
    const { baseUrl, capabilities } = await inspectRemoteAddress(row, req.body, config.sessionSecret);
    persistRemoteServerEdit(db, row, owner(req), req.body, baseUrl, capabilities);
    // The saved address is now this row's Engine, so its name source follows the answer (inspectRemoteAddress synced only an unchanged address).
    getServiceLinks().syncEngineInfo(row.id, capabilities);
    res.json(publicServer(serverById(row.id)));
  } catch (error) {
    const code = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'REMOTE_ALREADY_EXISTS' : safeError(error);
    res.status(400).json({ error: code });
  }
});

// Rename a remote Engine. One with the capability `engine-name` is renamed there (PUT /v1/engine-name), and the row takes the name it answers; for
// one without it only this row is renamed. Allowed on linked rows: the name is not part of what a link manages (refuseLinked is not used here).
router.put('/:id/name', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  let name;
  try { name = engineNames.nameFromBody(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const token = decryptToken(row.token_cipher, config.sessionSecret);
  let info;
  try { info = await readInfo(row, token); }
  catch (error) { return res.status(error.statusCode || 502).json({ error: safeError(error) }); }
  if (engineNames.hasCapability(info)) {
    let answer;
    try { answer = await request(row.base_url, '/v1/engine-name', token, { method: 'PUT', body: { name } }); }
    catch (error) { return res.status(error.statusCode || 502).json({ error: safeError(error) }); }
    // The answer is synced like an info read, so a name the Engine answers that does not pass the rules here leaves the row as it was.
    getServiceLinks().syncEngineInfo(row.id, { capabilities: info.capabilities, name: answer && answer.name });
  } else {
    // Nothing to reset to: an Engine without the capability has no default name to report.
    if (name === null) return res.status(400).json({ error: 'INVALID_ENGINE_NAME' });
    db.prepare('UPDATE remote_servers SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, row.id);
  }
  res.json(publicServer(serverById(row.id)));
});

router.delete('/:id', async (req, res) => {
  const row = getServer(req);
  const link = row && getServiceLinks().linkForServer(row.id);
  if (link) {
    try { await getServiceLinks().unlink(link.id); }
    catch (error) { return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'LINK_UNLINK_FAILED' }); }
    return res.json({ success: true });
  }
  const result = db.prepare('DELETE FROM remote_servers WHERE id = ? AND owner_id = ?').run(req.params.id, owner(req));
  if (!result.changes) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  res.json({ success: true });
});

router.post('/:id/check', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try { await checkServer(row); res.json(publicServer(serverById(row.id))); }
  catch (error) { res.status(502).json({ error: safeError(error), server: publicServer(serverById(row.id)) }); }
});

router.get('/:id/update-status', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    const status = await remoteUpdates.getStatus(row, config.sessionSecret);
    remoteUpdates.syncServerVersion(db, row.id, status);
    res.json(status);
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: safeError(error) });
  }
});

router.post('/:id/check-update', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    const status = await remoteUpdates.check(row, config.sessionSecret);
    remoteUpdates.syncServerVersion(db, row.id, status);
    res.json(status);
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: safeError(error) });
  }
});

router.post('/:id/apply-update', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.status(202).json(await remoteUpdates.apply(row, config.sessionSecret));
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: safeError(error) });
  }
});

// ── PM2: manage processes on the machine of this Engine, passed through to the Engine's /v1/pm2 (owner Token only) ──
async function proxyPm2(req, res, pathname, options) {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url, pathname, decryptToken(row.token_cipher, config.sessionSecret), options));
  } catch (error) {
    // An old Engine has no /v1/pm2: a missing route returns a generic 404, which must be told apart from "PM2 not installed" (PM2_NOT_INSTALLED).
    if (error.message === 'REMOTE_HTTP_404') return res.status(501).json({ error: 'PM2_UNSUPPORTED' });
    res.status(error.statusCode || 502).json({ error: safeError(error) });
  }
}

router.get('/:id/pm2/status', (req, res) => proxyPm2(req, res, '/v1/pm2/status'));
router.get('/:id/pm2/:pid/logs', (req, res) => {
  const query = new URLSearchParams();
  for (const key of ['stream', 'lines']) {
    if (req.query[key] !== undefined) query.set(key, String(req.query[key]));
  }
  proxyPm2(req, res, `/v1/pm2/${encodeURIComponent(req.params.pid)}/logs?${query}`);
});
router.post('/:id/pm2/:pid/:action', (req, res) => (
  proxyPm2(req, res, `/v1/pm2/${encodeURIComponent(req.params.pid)}/${encodeURIComponent(req.params.action)}`, { method: 'POST', body: {} })
));

// ── App list: passed through to the Engine's /v1/apps (owner Token only) ──
async function proxyApps(req, res, pathname, options) {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url, pathname, decryptToken(row.token_cipher, config.sessionSecret), options));
  } catch (error) {
    // An old Engine has no /v1/apps: a missing route returns a generic 404, which is told apart from "app not found" (APP_NOT_FOUND).
    if (error.message === 'REMOTE_HTTP_404') return res.status(501).json({ error: 'APPS_UNSUPPORTED' });
    res.status(error.statusCode || 502).json({ error: safeError(error) });
  }
}

const appPath = req => `/v1/apps/${encodeURIComponent(req.params.appId)}`;
router.get('/:id/apps', (req, res) => proxyApps(req, res, '/v1/apps'));
router.post('/:id/apps', (req, res) => proxyApps(req, res, '/v1/apps', { method: 'POST', body: req.body || {} }));
router.post('/:id/apps/restore-hidden', (req, res) => proxyApps(req, res, '/v1/apps/restore-hidden', { method: 'POST', body: {} }));
router.put('/:id/apps/:appId', (req, res) => proxyApps(req, res, appPath(req), { method: 'PUT', body: req.body || {} }));
router.delete('/:id/apps/:appId', (req, res) => proxyApps(req, res, appPath(req), { method: 'DELETE' }));

// ── Passthrough endpoints aligned with the local /api/tasks: an Engine's capabilities match the Client's ──
// Returns { row, token }; if the connection is not found the 404 has already been sent.
function remoteTarget(req, res) {
  const row = getServer(req);
  if (!row) { res.status(404).json({ error: 'REMOTE_NOT_FOUND' }); return null; }
  return { row, token: decryptToken(row.token_cipher, config.sessionSecret) };
}

// Forward the JSON request to the Engine unchanged; upstream is built from validated path parameters.
function forwardJson(method, upstream, { success = 200 } = {}) {
  return async (req, res) => {
    const target = remoteTarget(req, res);
    if (!target) return;
    try {
      const body = ['GET', 'DELETE'].includes(method) ? undefined : (req.body ?? {});
      const result = await request(target.row.base_url, upstream(req), target.token, { method, ...(body === undefined ? {} : { body }) });
      res.status(success).json(result);
    } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
  };
}

const taskPath = req => `/v1/tasks/${encodeURIComponent(req.params.taskId)}`;
const documentKindOk = (req, res, next) => (['technical', 'readme', 'agent'].includes(req.params.kind)
  ? next() : res.status(400).json({ error: 'INVALID_DOCUMENT_KIND' }));

// Capabilities and role of the connection, which the frontend uses to enable/disable features (capabilities missing from an old Engine are disabled).
router.get('/:id/info', async (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  try { res.json(await readInfo(target.row, target.token)); }
  catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

// "reorder" and "validate-path" must be registered before /:id/tasks/:taskId.
router.put('/:id/tasks/reorder', forwardJson('PUT', () => '/v1/tasks/reorder'));
router.post('/:id/tasks/validate-path', forwardJson('POST', () => '/v1/tasks/validate-path'));

router.post('/:id/tasks/:taskId/document/:kind', documentKindOk,
  forwardJson('POST', req => `${taskPath(req)}/document/${req.params.kind}`, { success: 201 }));

router.post('/:id/tasks/:taskId/todos', forwardJson('POST', req => `${taskPath(req)}/todos`, { success: 201 }));
router.put('/:id/tasks/:taskId/todos/:todoId', forwardJson('PUT', req => `${taskPath(req)}/todos/${encodeURIComponent(req.params.todoId)}`));
router.delete('/:id/tasks/:taskId/todos/:todoId', forwardJson('DELETE', req => `${taskPath(req)}/todos/${encodeURIComponent(req.params.todoId)}`));

// Chat requests execute on the selected Engine; credentials never reach the browser.
const chatPath = req => `${taskPath(req)}/agent`;
const conversationPath = req => `${chatPath(req)}/conversations/${encodeURIComponent(req.params.cid)}`;
for (const [method, suffix, upstream] of [
  ['get', '/conversations', req => `${chatPath(req)}/conversations`],
  ['post', '/conversations', req => `${chatPath(req)}/conversations`],
  ['get', '/sessions', req => `${chatPath(req)}/sessions?${new URLSearchParams({ agent: req.query.agent || '' })}`],
  ['get', '/conversations/:cid', conversationPath],
  ['patch', '/conversations/:cid', conversationPath],
  ['delete', '/conversations/:cid', conversationPath],
  ['get', '/conversations/:cid/models', req => `${conversationPath(req)}/models`],
  ['post', '/conversations/:cid/messages', req => `${conversationPath(req)}/messages`],
  ['post', '/conversations/:cid/interrupt', req => `${conversationPath(req)}/interrupt`],
  ['post', '/conversations/:cid/fork', req => `${conversationPath(req)}/fork`],
  ['post', '/conversations/:cid/queue', req => `${conversationPath(req)}/queue`],
  ['post', '/conversations/:cid/queue/add', req => `${conversationPath(req)}/queue/add`],
  ['post', '/conversations/:cid/queue/:eid/remove', req => `${conversationPath(req)}/queue/${encodeURIComponent(req.params.eid)}/remove`],
  ['post', '/conversations/:cid/queue/:eid/edit', req => `${conversationPath(req)}/queue/${encodeURIComponent(req.params.eid)}/edit`],
  ['post', '/conversations/:cid/queue/:eid/send', req => `${conversationPath(req)}/queue/${encodeURIComponent(req.params.eid)}/send`],
  ['post', '/conversations/:cid/permissions/:rid', req => `${conversationPath(req)}/permissions/${encodeURIComponent(req.params.rid)}`],
]) {
  router[method](`/:id/tasks/:taskId/agent${suffix}`, forwardJson(method.toUpperCase(), upstream));
}
router.get('/:id/tasks/:taskId/agent/conversations/:cid/events', (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  const query = new URLSearchParams({ after: String(req.query.after || '0') });
  streamRemote(req, res, target.row.base_url, target.token, `${conversationPath(req)}/events?${query}`, { sse: true });
});

// Workspace tools (import unmanaged directories, clean up code directories): return 501 when an old Engine lacks these endpoints.
async function proxyWorkspace(req, res, pathname, method = 'GET', success = 200) {
  const target = remoteTarget(req, res);
  if (!target) return;
  try {
    const options = method === 'GET' ? { method } : { method, body: req.body ?? {} };
    res.status(success).json(await request(target.row.base_url, pathname, target.token, options));
  } catch (error) {
    if (error.message === 'REMOTE_HTTP_404') return res.status(501).json({ error: 'WORKSPACE_UNSUPPORTED' });
    res.status(error.statusCode || 502).json({ error: safeError(error) });
  }
}
router.get('/:id/workspace/unmanaged', (req, res) => proxyWorkspace(req, res, '/v1/workspace/unmanaged'));
router.post('/:id/workspace/import', (req, res) => proxyWorkspace(req, res, '/v1/workspace/import', 'POST', 201));
router.get('/:id/workspace/cleanup', (req, res) => proxyWorkspace(req, res, '/v1/workspace/cleanup'));
router.post('/:id/workspace/cleanup', (req, res) => proxyWorkspace(req, res, '/v1/workspace/cleanup', 'POST'));
router.post('/:id/workspace/restore', (req, res) => proxyWorkspace(req, res, '/v1/workspace/restore', 'POST'));

router.get('/:id/terminal-activity', forwardJson('GET', () => '/v1/terminal-activity'));
router.get('/:id/terminal-subagents', forwardJson('GET', () => '/v1/terminal-subagents'));
// Piped unbuffered; an Engine older than the stream answers 404, which reaches the page as is (it then polls).
router.get('/:id/terminal-activity/stream', (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  streamRemote(req, res, target.row.base_url, target.token, '/v1/terminal-activity/stream', { sse: true });
});
router.post('/:id/tasks/:taskId/terminal/ack', forwardJson('POST', req => `${taskPath(req)}/terminal/ack`));

// Relative files referenced from documents (images etc.) and the document change event stream: not buffered, forwarded directly.
router.get('/:id/tasks/:taskId/file', (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  const query = new URLSearchParams();
  if (req.query.terminal !== undefined) query.set('terminal', String(req.query.terminal));
  if (req.query.path !== undefined) query.set('path', String(req.query.path));
  streamRemote(req, res, target.row.base_url, target.token, `${taskPath(req)}/file?${query}`, { sandbox: true });
});

router.get('/:id/tasks/:taskId/document/:kind/watch', documentKindOk, (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  streamRemote(req, res, target.row.base_url, target.token, `${taskPath(req)}/document/${req.params.kind}/watch`, { sse: true });
});

// Archive and restore, on an Engine that advertises 'tasks:archive'. The capability is checked first: an older Engine has no archive routes and it would
// ignore `?archived=1` and answer its whole list as if every task were archived.
async function proxyArchive(req, res, upstream, options) {
  const target = remoteTarget(req, res);
  if (!target) return;
  const supported = await remoteHas(target, res, 'tasks:archive');
  if (supported === null) return;
  if (!supported) return res.status(501).json({ error: 'ARCHIVE_UNSUPPORTED' });
  try { res.json(await request(target.row.base_url, upstream, target.token, options)); }
  catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
}

for (const action of ['archive', 'restore']) {
  router.post(`/:id/tasks/:taskId/${action}`, (req, res) => proxyArchive(req, res, `${taskPath(req)}/${action}`, { method: 'POST', body: {} }));
}

router.get('/:id/tasks', async (req, res) => {
  if (req.query.archived === '1') return proxyArchive(req, res, '/v1/tasks?archived=1');
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try { res.json(await request(row.base_url, '/v1/tasks', decryptToken(row.token_cipher, config.sessionSecret))); }
  catch (error) { res.status(502).json({ error: safeError(error) }); }
});

router.get('/:id/task-groups', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try { res.json(await request(row.base_url, '/v1/task-groups', decryptToken(row.token_cipher, config.sessionSecret))); }
  catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.post('/:id/task-groups', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    const group = await request(row.base_url, '/v1/task-groups', decryptToken(row.token_cipher, config.sessionSecret), { method: 'POST', body: req.body });
    res.status(201).json(group);
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.put('/:id/task-groups/:groupId', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url, `/v1/task-groups/${encodeURIComponent(req.params.groupId)}`, decryptToken(row.token_cipher, config.sessionSecret), { method: 'PUT', body: req.body }));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.delete('/:id/task-groups/:groupId', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url, `/v1/task-groups/${encodeURIComponent(req.params.groupId)}`, decryptToken(row.token_cipher, config.sessionSecret), { method: 'DELETE' }));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.get('/:id/tasks/:taskId/document/:kind', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  if (!['technical', 'readme', 'agent'].includes(req.params.kind)) return res.status(400).json({ error: 'INVALID_DOCUMENT_KIND' });
  try {
    const text = await request(row.base_url, `/v1/tasks/${encodeURIComponent(req.params.taskId)}/documents/${req.params.kind}`, decryptToken(row.token_cipher, config.sessionSecret), { expectText: true });
    res.type('text/plain').send(text);
  } catch (error) { res.status(error.statusCode === 404 ? 404 : 502).json({ error: safeError(error) }); }
});

// Whether the Engine advertises a capability in /v1/info; false (after sending the error) when /v1/info cannot be read.
async function remoteHas(target, res, capability) {
  let info;
  try { info = await readInfo(target.row, target.token); }
  catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); return null; }
  return Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(capability));
}

// A file at any path on the Engine (read only), piped unbuffered with the Engine's status and error body. An Engine without the capability
// 'fs:read-any' answers 501 FS_READ_UNSUPPORTED here. Remote answers keep `Content-Security-Policy: sandbox`, as every remote file.
for (const kind of ['content', 'image']) {
  router.get(`/:id/fs/${kind}`, async (req, res) => {
    const target = remoteTarget(req, res);
    if (!target) return;
    const supported = await remoteHas(target, res, 'fs:read-any');
    if (supported === null) return;
    if (!supported) return res.status(501).json({ error: 'FS_READ_UNSUPPORTED' });
    const query = new URLSearchParams();
    if (typeof req.query.path === 'string') query.set('path', req.query.path);
    streamRemote(req, res, target.row.base_url, target.token, `/v1/fs/${kind}?${query}`, { sandbox: true });
  });
}

// A PDF, audio or video file (task file or any path), streamed with the Range header passed both ways. An Engine without the capability
// 'files:raw' answers 501 RAW_UNSUPPORTED. The sandbox is kept for everything except an application/pdf answer (services/remote-stream.js).
router.get('/:id/fs/raw', async (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  const supported = await remoteHas(target, res, 'files:raw');
  if (supported === null) return;
  if (!supported) return res.status(501).json({ error: 'RAW_UNSUPPORTED' });
  const query = new URLSearchParams();
  if (typeof req.query.path === 'string') query.set('path', req.query.path);
  streamRemote(req, res, target.row.base_url, target.token, `/v1/fs/raw?${query}`, { sandbox: true, raw: true });
});
router.get('/:id/tasks/:taskId/files/raw', async (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  const supported = await remoteHas(target, res, 'files:raw');
  if (supported === null) return;
  if (!supported) return res.status(501).json({ error: 'RAW_UNSUPPORTED' });
  const query = new URLSearchParams();
  for (const key of ['path', 'terminal']) if (req.query[key] !== undefined) query.set(key, String(req.query[key]));
  streamRemote(req, res, target.row.base_url, target.token, `${taskPath(req)}/files/raw?${query}`, { sandbox: true, raw: true });
});

router.get('/:id/tasks/:taskId/files/content', proxyFiles('GET', '/content'));
// An image of the working directory, not buffered: the Engine checks the path and the type (an older Engine answers 404, the page shows the alt text).
router.get('/:id/tasks/:taskId/files/image', (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  const query = new URLSearchParams();
  for (const key of ['path', 'terminal']) if (req.query[key] !== undefined) query.set(key, String(req.query[key]));
  streamRemote(req, res, target.row.base_url, target.token, `${taskPath(req)}/files/image?${query}`, { sandbox: true });
});
router.put('/:id/tasks/:taskId/files/content', proxyFiles('PUT', '/content'));
router.get('/:id/tasks/:taskId/files', proxyFiles('GET'));
router.post('/:id/tasks/:taskId/files', proxyFiles('POST'));
router.patch('/:id/tasks/:taskId/files', proxyFiles('PATCH'));
router.delete('/:id/tasks/:taskId/files', proxyFiles('DELETE'));

router.get('/:id/tasks/:taskId/todos', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try { res.json(await request(row.base_url, `/v1/tasks/${encodeURIComponent(req.params.taskId)}/todos`, decryptToken(row.token_cipher, config.sessionSecret))); }
  catch (error) { res.status(error.statusCode === 404 ? 404 : 502).json({ error: safeError(error) }); }
});

router.post('/:id/tasks', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    const task = await request(row.base_url, '/v1/tasks', decryptToken(row.token_cipher, config.sessionSecret), { method: 'POST', body: req.body });
    res.status(201).json(task);
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

// Only the agent kind and session id are forwarded when a terminal is created.
const terminalOptions = body => {
  const out = {};
  if (body && typeof body.agent === 'string') out.agent = body.agent;
  if (body && typeof body.session_id === 'string') out.session_id = body.session_id;
  if (body && typeof body.title === 'string') out.title = body.title;
  return out;
};

router.get('/:id/tasks/:taskId/agent-sessions', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url,
      `/v1/tasks/${encodeURIComponent(req.params.taskId)}/agent-sessions?agent=${encodeURIComponent(req.query.agent || '')}`,
      decryptToken(row.token_cipher, config.sessionSecret)));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

for (const method of ['get', 'post']) {
  router[method]('/:id/tasks/:taskId/terminals', async (req, res) => {
    const row = getServer(req);
    if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
    try {
      const result = await request(row.base_url,
        `/v1/tasks/${encodeURIComponent(req.params.taskId)}/terminals`,
        decryptToken(row.token_cipher, config.sessionSecret),
        { method: method.toUpperCase(), ...(method === 'post' ? { body: terminalOptions(req.body) } : {}) });
      res.status(method === 'post' ? 201 : 200).json(result);
    } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
  });
}

router.patch('/:id/tasks/:taskId/terminals/:terminalId', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url,
      `/v1/tasks/${encodeURIComponent(req.params.taskId)}/terminals/${encodeURIComponent(req.params.terminalId)}`,
      decryptToken(row.token_cipher, config.sessionSecret),
      { method: 'PATCH', body: { title: req.body && req.body.title } }));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.get('/:id/tasks/:taskId/terminals/:terminalId/cwd', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url,
      `/v1/tasks/${encodeURIComponent(req.params.taskId)}/terminals/${encodeURIComponent(req.params.terminalId)}/cwd`,
      decryptToken(row.token_cipher, config.sessionSecret)));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.post('/:id/tasks/:taskId/terminal/control', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    await assertRemoteTerminal(row.base_url, decryptToken(row.token_cipher, config.sessionSecret), req.params.taskId, req.body && req.body.terminal_id);
    res.json(await request(
      row.base_url,
      `/v1/terminal-sessions/${encodeURIComponent(req.params.taskId)}/control`,
      decryptToken(row.token_cipher, config.sessionSecret),
      { method: 'POST', body: req.body },
    ));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.patch('/:id/tasks/:taskId', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url, `/v1/tasks/${encodeURIComponent(req.params.taskId)}`, decryptToken(row.token_cipher, config.sessionSecret), { method: 'PATCH', body: req.body }));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.put('/:id/tasks/:taskId', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url, `/v1/tasks/${encodeURIComponent(req.params.taskId)}`, decryptToken(row.token_cipher, config.sessionSecret), { method: 'PUT', body: req.body }));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.delete('/:id/tasks/:taskId', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url, `/v1/tasks/${encodeURIComponent(req.params.taskId)}${req.query.delete_directory === '1' ? '?delete_directory=1' : ''}`, decryptToken(row.token_cipher, config.sessionSecret), { method: 'DELETE' }));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

// ── Mind maps of a connected service: the same API as /api/mindmaps, forwarded to its /v1/mindmaps. The map stays on that service; nothing is copied here. ──
// The body is parsed by the mind map parser itself (server.js keeps the global parser off this path) and the size of `data` is checked against the same
// limit, so the proxy accepts what the owning service accepts and answers 400 / 413 the same way before anything is forwarded. A bad map id is "not found"
// here, as it is there, without a request.
// An Engine without the capability 'mindmaps' answers 501 MINDMAPS_UNSUPPORTED; an offline one 502 with the code `request` gives (REMOTE_OFFLINE through a
// tunnel, REMOTE_CONNECTION_FAILED or REMOTE_TIMEOUT otherwise). An error of the owning service keeps its status, code, message and current_revision.
const parseMindmapBody = createMindmapBodyParser();
// A full map answer is its data (at most 8 MiB serialised) and a few fields; the list is at most 2000 short summaries.
const MINDMAP_MAX_BYTES = MINDMAP_BODY_LIMIT + 1024 * 1024;
// An idle limit, not a total one (http and the tunnel both restart it on progress): room for an 8 MB map over a slow link and a slow disk on the far side.
const MINDMAP_TIMEOUT_MS = 60_000;

function checkMindmapId(req, res, next) {
  return isMindmapId(req.params.mapId) ? next() : sendMindmapNotFound(res);
}

// The service's own limit on the serialised `data`, checked here too, so that a map over 8 MiB is refused before it is forwarded. Anything else about the
// body (its shape, the title, the revision) is left to the owning service, which answers it as /api/mindmaps does.
function checkMindmapSize(req, res, next) {
  const data = req.body && typeof req.body === 'object' ? req.body.data : undefined;
  if (data && typeof data === 'object') {
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(data), 'utf8'); } catch { bytes = 0; }
    if (bytes > MINDMAP_LIMITS.dataBytes) return sendMindmapTooLarge(res);
  }
  return next();
}

function proxyMindmaps(method, upstream, { success = 200 } = {}) {
  return async (req, res) => {
    const target = remoteTarget(req, res);
    if (!target) return;
    const supported = await remoteHas(target, res, 'mindmaps');
    if (supported === null) return;
    if (!supported) return res.status(501).json({ error: 'MINDMAPS_UNSUPPORTED' });
    try {
      const result = await request(target.row.base_url, upstream(req), target.token, {
        method,
        ...(['POST', 'PUT'].includes(method) ? { body: req.body ?? {} } : {}),
        // DELETE answers 204 with no body.
        ...(method === 'DELETE' ? { expectText: true } : {}),
        maxBytes: MINDMAP_MAX_BYTES,
        timeoutMs: MINDMAP_TIMEOUT_MS,
      });
      if (method === 'DELETE') return res.status(204).end();
      res.status(success).json(result);
    } catch (error) {
      const peer = error.peerBody || {};
      res.status(error.statusCode || 502).json({
        error: safeError(error),
        ...(typeof peer.message === 'string' ? { message: peer.message } : {}),
        ...(Number.isSafeInteger(peer.current_revision) ? { current_revision: peer.current_revision } : {}),
      });
    }
  };
}

const mindmapPath = req => `/v1/mindmaps/${encodeURIComponent(req.params.mapId)}`;
router.get('/:id/mindmaps', proxyMindmaps('GET', () => '/v1/mindmaps'));
router.post('/:id/mindmaps', parseMindmapBody, checkMindmapSize, proxyMindmaps('POST', () => '/v1/mindmaps', { success: 201 }));
router.get('/:id/mindmaps/:mapId', checkMindmapId, proxyMindmaps('GET', mindmapPath));
router.put('/:id/mindmaps/:mapId', checkMindmapId, parseMindmapBody, checkMindmapSize, proxyMindmaps('PUT', mindmapPath));
router.delete('/:id/mindmaps/:mapId', checkMindmapId, proxyMindmaps('DELETE', mindmapPath));

router.put('/:id/tasks/:taskId/document/:kind', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  if (!['technical', 'readme', 'agent'].includes(req.params.kind)) return res.status(400).json({ error: 'INVALID_DOCUMENT_KIND' });
  try {
    res.json(await request(row.base_url, `/v1/tasks/${encodeURIComponent(req.params.taskId)}/documents/${req.params.kind}`, decryptToken(row.token_cipher, config.sessionSecret), { method: 'PUT', body: req.body }));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

module.exports = router;
