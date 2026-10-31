const express = require('express');
const db = require('../db');
const config = require('../config');
const requireAuth = require('../middleware/auth');
const { decryptToken, encryptToken } = require('../lib/token-crypto');
const { normalizeBaseUrl, request, assertRemoteTerminal } = require('../services/remote-client');
const { inspectRemoteAddress, persistRemoteServerEdit } = require('../services/remote-server-settings');
const remoteUpdates = require('../services/remote-engine-updates');
const { streamRemote } = require('../services/remote-stream');

const router = express.Router();
router.use(requireAuth);

const owner = req => req.session.user.login;
const safeError = error => (/^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'REMOTE_CONNECTION_FAILED');

function publicServer(row) {
  return {
    id: row.id, name: row.name, base_url: row.base_url, enabled: Boolean(row.enabled),
    status: row.status, remote_version: row.remote_version, last_checked_at: row.last_checked_at,
    last_error: row.last_error, created_at: row.created_at,
  };
}

function getServer(req) {
  return db.prepare('SELECT * FROM remote_servers WHERE id = ? AND owner_id = ?').get(req.params.id, owner(req));
}

async function checkServer(row) {
  const token = decryptToken(row.token_cipher, config.sessionSecret);
  try {
    const capabilities = await request(row.base_url, '/v1/info', token);
    db.prepare(`UPDATE remote_servers SET status = 'online', remote_version = ?, last_checked_at = CURRENT_TIMESTAMP,
      last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(capabilities.engine_version || capabilities.app_version || null, row.id);
    return capabilities;
  } catch (error) {
    const code = safeError(error);
    db.prepare(`UPDATE remote_servers SET status = ?, last_checked_at = CURRENT_TIMESTAMP, last_error = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(error.statusCode === 401 ? 'unauthorized' : 'offline', code, row.id);
    throw error;
  }
}

async function assertFilesSupported(row, token) {
  let info;
  try { info = await request(row.base_url, '/v1/info', token); }
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
  for (const key of ['path', 'offset', 'hidden']) {
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
  res.json(db.prepare('SELECT * FROM remote_servers WHERE owner_id = ? ORDER BY created_at ASC').all(owner(req)).map(publicServer));
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
    const capabilities = await request(baseUrl, '/v1/info', credential);
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
    const capabilities = await request(baseUrl, '/v1/info', token);
    const name = (typeof req.body.name === 'string' && req.body.name.trim()) || new URL(baseUrl).hostname;
    const result = db.prepare(`INSERT INTO remote_servers
      (owner_id, name, base_url, token_cipher, status, remote_version, last_checked_at)
      VALUES (?, ?, ?, ?, 'online', ?, CURRENT_TIMESTAMP)`).run(owner(req), name.slice(0, 80), baseUrl, encryptToken(token, config.sessionSecret), capabilities.engine_version || capabilities.app_version || null);
    res.status(201).json(publicServer(db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(result.lastInsertRowid)));
  } catch (error) {
    const code = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'REMOTE_ALREADY_EXISTS' : safeError(error);
    res.status(400).json({ error: code });
  }
});

router.post('/:id/test', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    const { baseUrl, capabilities } = await inspectRemoteAddress(row, req.body, config.sessionSecret);
    res.json({ success: true, base_url: baseUrl, capabilities });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

router.put('/:id', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    // When verifying a new address, reuse the encrypted saved Token; it is only persisted after the remote authenticates successfully.
    const { baseUrl, capabilities } = await inspectRemoteAddress(row, req.body, config.sessionSecret);
    persistRemoteServerEdit(db, row, owner(req), req.body, baseUrl, capabilities);
    res.json(publicServer(db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(row.id)));
  } catch (error) {
    const code = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'REMOTE_ALREADY_EXISTS' : safeError(error);
    res.status(400).json({ error: code });
  }
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM remote_servers WHERE id = ? AND owner_id = ?').run(req.params.id, owner(req));
  if (!result.changes) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  res.json({ success: true });
});

router.post('/:id/check', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try { await checkServer(row); res.json(publicServer(db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(row.id))); }
  catch (error) { res.status(502).json({ error: safeError(error), server: publicServer(db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(row.id)) }); }
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
router.get('/:id/info', forwardJson('GET', () => '/v1/info'));

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
router.post('/:id/tasks/:taskId/terminal/ack', forwardJson('POST', req => `${taskPath(req)}/terminal/ack`));

// Relative files referenced from documents (images etc.) and the document change event stream: not buffered, forwarded directly.
router.get('/:id/tasks/:taskId/file', (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  const query = new URLSearchParams();
  if (req.query.path !== undefined) query.set('path', String(req.query.path));
  streamRemote(req, res, target.row.base_url, target.token, `${taskPath(req)}/file?${query}`, { sandbox: true });
});

router.get('/:id/tasks/:taskId/document/:kind/watch', documentKindOk, (req, res) => {
  const target = remoteTarget(req, res);
  if (!target) return;
  streamRemote(req, res, target.row.base_url, target.token, `${taskPath(req)}/document/${req.params.kind}/watch`, { sse: true });
});

router.get('/:id/tasks', async (req, res) => {
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

router.get('/:id/tasks/:taskId/files/content', proxyFiles('GET', '/content'));
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

router.put('/:id/tasks/:taskId/document/:kind', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  if (!['technical', 'readme', 'agent'].includes(req.params.kind)) return res.status(400).json({ error: 'INVALID_DOCUMENT_KIND' });
  try {
    res.json(await request(row.base_url, `/v1/tasks/${encodeURIComponent(req.params.taskId)}/documents/${req.params.kind}`, decryptToken(row.token_cipher, config.sessionSecret), { method: 'PUT', body: req.body }));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

module.exports = router;
