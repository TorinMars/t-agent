const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { SCHEMA, TOOLS, AgentConfigError, createAgentConfig, createAgentConfigStore } = require('../services/agent-config');
const { request } = require('../services/remote-client');
const { decryptToken } = require('../lib/token-crypto');

const LOCAL = 'local';
const wrap = handler => async (req, res) => {
  try { res.json(await handler(req)); } catch (error) { sendError(res, error); }
};
function sendError(res, error) {
  if (error instanceof AgentConfigError) return res.status(error.statusCode).json({ error: error.code, message: error.userMessage });
  const code = /^[A-Z0-9_]+$/.test(error && error.message || '') ? error.message : 'AGENT_CONFIG_FAILED';
  if (code === 'AGENT_CONFIG_FAILED') console.error('[agent-config]', error && error.message);
  return res.status(error && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500).json({ error: code });
}

// Engine endpoint (/v1/agent-config): read and write this machine's Claude / Codex configuration.
function createEngineRouter({ service = createAgentConfig(), guard } = {}) {
  const router = express.Router();
  router.get('/', guard, wrap(() => ({ schema_version: 1, ...service.read() })));
  router.put('/', guard, wrap(req => service.apply(req.body && req.body.tool, req.body && req.body.values)));
  return router;
}

// Browser endpoint (/api/agent-config): manage global defaults and per-server overrides, and push them to this machine and remote Engines.
function createClientRouter({ db, sessionSecret, service = createAgentConfig(), requireAuth = require('../middleware/auth'), remoteRequest = request } = {}) {
  const store = createAgentConfigStore(db);
  const router = express.Router();
  router.use(clientOrigin, requireAuth);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const owner = req => req.session.user.login;
  const remotes = req => db.prepare('SELECT id, name, base_url, token_cipher, enabled FROM remote_servers WHERE owner_id = ? AND enabled = 1 ORDER BY created_at ASC').all(owner(req));
  const targets = req => [{ key: LOCAL, name: 'This machine', local: true }, ...remotes(req).map(row => ({ key: String(row.id), name: row.name, local: false, row }))];
  function target(req, key) {
    const found = targets(req).find(item => item.key === String(key));
    if (!found) throw new AgentConfigError('SERVER_NOT_FOUND', 'Server not found', 404);
    return found;
  }
  const remoteCall = (item, options = {}) => remoteRequest(item.row.base_url, '/v1/agent-config', decryptToken(item.row.token_cipher, sessionSecret), { timeoutMs: 15_000, ...options });
  const unsupported = error => (error.statusCode === 404 ? Object.assign(new Error('AGENT_CONFIG_UNSUPPORTED'), { statusCode: 501 }) : error);

  async function readCurrent(item) {
    if (item.local) return service.read();
    try { return await remoteCall(item); } catch (error) { throw unsupported(error); }
  }
  async function pushTo(item, state) {
    const result = { key: item.key, name: item.name, ok: true, tools: {} };
    for (const tool of TOOLS) {
      const values = store.effective(state, item.key, tool);
      if (!Object.values(values).some(value => value !== '')) { result.tools[tool] = { changed: [], skipped: true }; continue; }
      try {
        const done = item.local ? service.apply(tool, values) : await remoteCall(item, { method: 'PUT', body: { tool, values } });
        result.tools[tool] = { changed: done.changed || [], ...(done.override_error ? { override_error: done.override_error } : {}) };
      } catch (rawError) {
        const error = unsupported(rawError);
        result.ok = false;
        result.tools[tool] = { error: error.code || error.message, message: error.userMessage };
      }
    }
    return result;
  }

  router.get('/', wrap(req => {
    const state = store.get(owner(req));
    return {
      schema: SCHEMA, defaults: state.defaults, overrides: state.servers, status: state.status,
      servers: targets(req).map(({ key, name, local }) => ({ key, name, local })),
    };
  }));
  router.put('/defaults', wrap(req => {
    store.setDefaults(owner(req), req.body && req.body.tool, req.body && req.body.values);
    return { success: true };
  }));
  router.put('/servers/:key', wrap(req => {
    target(req, req.params.key);
    store.setOverride(owner(req), req.params.key, req.body && req.body.tool, req.body && req.body.values);
    return { success: true };
  }));
  router.get('/servers/:key/current', wrap(req => readCurrent(target(req, req.params.key))));
  router.post('/push', wrap(async req => {
    const wanted = Array.isArray(req.body && req.body.servers) ? req.body.servers.map(String) : null;
    const chosen = targets(req).filter(item => !wanted || wanted.includes(item.key));
    if (!chosen.length) throw new AgentConfigError('SERVER_NOT_FOUND', 'No servers to push to', 404);
    const state = store.get(owner(req));
    const results = await Promise.all(chosen.map(item => pushTo(item, state)));
    for (const result of results) {
      store.setStatus(owner(req), result.key, {
        at: new Date().toISOString(), ok: result.ok,
        error: result.ok ? null : Object.values(result.tools).map(item => item.message || item.error).find(Boolean) || 'PUSH_FAILED',
      });
    }
    return { results };
  }));
  return router;
}

module.exports = { createClientRouter, createEngineRouter };
