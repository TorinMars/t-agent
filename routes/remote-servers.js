const express = require('express');
const db = require('../db');
const config = require('../config');
const requireAuth = require('../middleware/auth');
const { decryptToken, encryptToken } = require('../lib/token-crypto');
const { normalizeBaseUrl, request } = require('../services/remote-client');
const { inspectRemoteAddress, persistRemoteServerEdit } = require('../services/remote-server-settings');

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

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM remote_servers WHERE owner_id = ? ORDER BY created_at ASC').all(owner(req)).map(publicServer));
});

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
    // 验证新地址时沿用已加密保存的 Token；只有远端认证成功后才落库。
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

router.get('/:id/tasks', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try { res.json(await request(row.base_url, '/v1/tasks', decryptToken(row.token_cipher, config.sessionSecret))); }
  catch (error) { res.status(502).json({ error: safeError(error) }); }
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

router.patch('/:id/tasks/:taskId', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url, `/v1/tasks/${encodeURIComponent(req.params.taskId)}`, decryptToken(row.token_cipher, config.sessionSecret), { method: 'PATCH', body: req.body }));
  } catch (error) { res.status(error.statusCode || 502).json({ error: safeError(error) }); }
});

router.delete('/:id/tasks/:taskId', async (req, res) => {
  const row = getServer(req);
  if (!row) return res.status(404).json({ error: 'REMOTE_NOT_FOUND' });
  try {
    res.json(await request(row.base_url, `/v1/tasks/${encodeURIComponent(req.params.taskId)}`, decryptToken(row.token_cipher, config.sessionSecret), { method: 'DELETE' }));
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
