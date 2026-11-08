// T-Attention HTTP API, mounted at /api/attention (see "T-Attention" in DESIGN.md).
//
// Two ways in:
//  - the browser session: `router`, mounted after the /api session check (middleware/auth.js) and the same-origin rule for mutations
//    (middleware/client-origin.js), like every other browser API;
//  - `Authorization: Bearer tatt_...` (the CLI and listener plugins): `bearer`, mounted in server.js before the session, the access gate and
//    the login gate. It answers every Bearer request to /api/attention* itself and never passes one on, so a token reaches this router and nothing
//    else: not the token endpoints (/api/attention/tokens*, browser session only), no other /api route and no page. No cookie is read or set, there is
//    no same-origin check (a token is not sent by a browser on its own), failed attempts are rate limited per address, and every failure is 401 JSON.
const os = require('node:os');
const express = require('express');
const { AttentionError } = require('../services/attention');

const TOKEN_PATH = /^\/tokens(?:\/|$)/i;
const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

// Sliding count per key inside a window; used for failed token attempts (per address) and for requests per token.
function createCounter({ windowMs, max, now = Date.now }) {
  const hits = new Map();
  function prune(key, at) {
    const list = (hits.get(key) || []).filter(time => at - time < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  }
  return {
    limited(key) { return prune(key, now()).length >= max; },
    add(key) { const at = now(); const list = prune(key, at); list.push(at); hits.set(key, list); },
    retryAfter(key) { const list = prune(key, now()); return list.length ? Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) : 1; },
  };
}

function createAttentionRoutes({ service, summary = null, plugins = null, heartbeatMs = 25000, failedAuth = { windowMs: 15 * 60 * 1000, max: 20 }, tokenRequests = { windowMs: 60 * 1000, max: 600 }, now = Date.now } = {}) {
  if (!service) throw new Error('createAttentionRoutes needs the attention service');
  const failures = createCounter({ ...failedAuth, now });
  const perToken = createCounter({ ...tokenRequests, now });
  const streams = new Set();
  const router = express.Router();

  // Who acts: 'user' for the browser; for a token the body's source when it sends one, else the token's name.
  function actor(req) {
    const auth = req.attentionAuth;
    if (!auth || auth.kind !== 'token') return 'user';
    const source = req.body && typeof req.body.source === 'string' && req.body.source.trim();
    return source || auth.name;
  }
  // A token that creates an item without a source is a command-line caller, not the person in the browser (used on create only).
  const defaultSource = req => (req.attentionAuth.kind === 'token' ? 'cli' : 'user');
  const wrap = handler => (req, res) => {
    try { return handler(req, res); } catch (error) {
      if (error instanceof AttentionError) return sendError(res, error.statusCode, error.code, error.message, error.id !== undefined ? { id: error.id } : {});
      console.error(`T-Attention API: ${error.stack || error.message}`);
      return sendError(res, 500, 'INTERNAL_ERROR', 'The attention service failed');
    }
  };
  const sessionOnly = (req, res, next) => (req.attentionAuth && req.attentionAuth.kind === 'session' ? next() : sendError(res, 403, 'TOKEN_NOT_ALLOWED', 'An attention token cannot manage tokens; use the browser'));
  const idOf = value => (/^\d{1,15}$/.test(String(value)) ? Number(value) : null);

  router.use((req, res, next) => {
    if (!req.attentionAuth) req.attentionAuth = { kind: 'session' };
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Tokens: the browser session only.
  router.get('/tokens', sessionOnly, wrap((req, res) => res.json({ tokens: service.listTokens() })));
  router.post('/tokens', sessionOnly, wrap((req, res) => res.status(201).json(service.createToken({ name: req.body && req.body.name }))));
  router.delete('/tokens/:id', sessionOnly, wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Token not found');
    service.revokeToken(id);
    for (const stream of streams) if (stream.tokenId === id) stream.close();
    return res.status(204).end();
  }));
  router.all(/^\/tokens(?:\/.*)?$/i, (req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  // AI summary (services/attention-summary.js): the browser session only.
  const owner = req => req.session.user.login;
  const needSummary = (req, res, next) => (summary ? next() : sendError(res, 404, 'NOT_FOUND', 'Not found'));
  router.get('/settings/summary', sessionOnly, needSummary, wrap((req, res) => res.json(summary.getSettings(owner(req)))));
  router.put('/settings/summary', sessionOnly, needSummary, wrap((req, res) => res.json(summary.saveSettings(owner(req), req.body))));
  router.all(/^\/settings(?:\/.*)?$/i, sessionOnly, (req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));
  // Starts a new summary in the background: 202 { started } (false while one already runs for the item); the result arrives as a change event.
  router.post('/:id/summarize', sessionOnly, needSummary, wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    const { started } = summary.summarize(owner(req), id);
    return res.status(202).json({ started });
  }));

  // Plugin overview (services/attention-plugins.js): the browser session and tokens. A token has no user, so the notifier part is the
  // single user's (the owner of background events).
  router.get('/plugins', wrap((req, res) => {
    if (!plugins) return sendError(res, 404, 'NOT_FOUND', 'Not found');
    const who = req.attentionAuth.kind === 'session' && req.session && req.session.user ? req.session.user.login : undefined;
    return res.json(plugins.overview(who));
  }));

  // Server-sent events: `event: change` with { kind, item, previous, event } for every change, a comment line every heartbeatMs.
  // A token's stream ends when the token is revoked.
  router.get('/stream', (req, res) => {
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n: connected\n\n');
    const tokenId = req.attentionAuth.kind === 'token' ? req.attentionAuth.id : null;
    let closed = false;
    const stream = {
      tokenId,
      close() {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(timer);
        streams.delete(stream);
        res.end();
      },
    };
    const unsubscribe = service.onChange(change => {
      if (!closed) res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
    });
    const timer = setInterval(() => {
      if (tokenId !== null && !service.tokenActive(tokenId)) return stream.close();
      res.write(': heartbeat\n\n');
    }, heartbeatMs);
    if (timer.unref) timer.unref();
    streams.add(stream);
    req.on('close', () => stream.close());
  });

  router.get('/', wrap((req, res) => {
    const includeDone = ['1', 'true', 'yes'].includes(String(req.query.include_done || '').toLowerCase());
    // `host`: this machine's name, as the Claude listener writes it into context.host (os.hostname()). The page opens the files of a context only
    // when they are on this machine.
    res.json({ items: service.list({ status: req.query.status, q: req.query.q, limit: req.query.limit, includeDone }), host: os.hostname() });
  }));

  router.post('/', wrap((req, res) => res.status(201).json(service.create(req.body, { actor: actor(req), defaultSource: defaultSource(req) }))));

  router.get('/by-ref/:ref', wrap((req, res) => {
    const found = service.detailByRef(req.params.ref);
    if (!found) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(found);
  }));

  router.put('/by-ref/:ref', wrap((req, res) => {
    const { created, item } = service.upsertByRef(req.params.ref, req.body, { actor: actor(req), defaultSource: defaultSource(req) });
    res.status(created ? 201 : 200).json(item);
  }));

  router.get('/:id', wrap((req, res) => {
    const id = idOf(req.params.id);
    const found = id === null ? null : service.detail(id);
    if (!found) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(found);
  }));

  router.patch('/:id', wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(service.update(id, req.body, { actor: actor(req) }));
  }));

  router.delete('/:id', wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    service.remove(id, { actor: actor(req) });
    return res.status(204).end();
  }));

  router.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  const parseJson = express.json({ limit: '256kb' });

  // Bearer requests to /api/attention*. Requests without an Authorization: Bearer header go on to the session path unchanged.
  function bearer(req, res, next) {
    const header = req.get('authorization');
    if (!header || !/^Bearer(?:[ \t]|$)/i.test(header)) return next();
    res.set('Cache-Control', 'no-store');
    let decoded;
    try { decoded = decodeURIComponent(req.path); } catch { return sendError(res, 404, 'NOT_FOUND', 'Not found'); }
    const key = `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
    if (failures.limited(key)) {
      res.set('Retry-After', String(failures.retryAfter(key)));
      return sendError(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many failed token attempts; try again later');
    }
    const match = BEARER.exec(header);
    const auth = match ? service.verifyToken(match[1]) : null;
    if (!auth) {
      failures.add(key);
      return sendError(res, 401, 'TOKEN_INVALID', 'The attention token is missing, wrong or revoked');
    }
    if (TOKEN_PATH.test(req.path) || TOKEN_PATH.test(decoded)) return sendError(res, 403, 'TOKEN_NOT_ALLOWED', 'An attention token cannot manage tokens; use the browser');
    const tokenKey = `token:${auth.id}`;
    if (perToken.limited(tokenKey)) {
      res.set('Retry-After', String(perToken.retryAfter(tokenKey)));
      return sendError(res, 429, 'RATE_LIMITED', 'Too many requests with this token; try again later');
    }
    perToken.add(tokenKey);
    req.attentionAuth = { kind: 'token', id: auth.id, name: auth.name };
    // Ends here in every case: an unmatched address is a JSON 404, never the session path, the gates or the pages.
    const done = error => {
      if (error) return sendError(res, error.status === 413 ? 413 : 400, error.status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON', error.status === 413 ? 'The request body is too large' : 'The request body is not valid JSON');
      return sendError(res, 404, 'NOT_FOUND', 'Not found');
    };
    parseJson(req, res, error => (error ? done(error) : router(req, res, done)));
  }

  function closeStreams() { for (const stream of [...streams]) stream.close(); }

  return { router, bearer, closeStreams };
}

module.exports = { createAttentionRoutes, createCounter };
