// The routes of moving a task to another engine (services/task-move.js, docs/design/task-move.md).
//
// - The page (behind the login of /api/tasks, routes/tasks.js): GET /api/tasks/:id/move (what moving it would do: size, terminals, targets),
//   POST /api/tasks/:id/move { target, tier_ack } (start), GET /api/tasks/:id/move/progress, POST /api/tasks/:id/move/cancel.
// - The same four under /v1/tasks/:id/move for the page of a linked engine (its proxy, routes/remote-servers.js): link tokens only, and the
//   per-task visibility guard of /v1 has already turned a hidden task into a missing one.
// - Between the two engines, /v1/task-move (link tokens only; the move's task must be visible to the asking link): GET /capacity, POST /offer,
//   GET /:id, GET /:id/manifest, GET /:id/blob/:index (with Range), POST /:id/progress, /commit, /failed, /cancel.
const fs = require('fs');
const express = require('express');
const files = require('../lib/task-move-files');

const sendError = (res, error) => {
  const code = /^[A-Z0-9_]{1,64}$/.test((error && error.message) || '') ? error.message : 'MOVE_FAILED';
  if (!error || !error.statusCode) console.warn('[task-move] request failed:', error && error.message);
  res.status((error && error.statusCode) || 500).json({ error: code, ...(error && typeof error.reason === 'string' ? { reason: error.reason } : {}) });
};
const handle = (run, status = 200) => async (req, res) => {
  try { res.status(status).json(await run(req)); } catch (error) { sendError(res, error); }
};

// The page's four routes, on `router` (the /api/tasks router; `owner(req)` is the logged-in owner). `prefix` is '' there and '/tasks' under /v1.
function addPageRoutes(router, { service, owner, prefix = '', guard = [] }) {
  router.get(`${prefix}/:id/move`, ...guard, handle(req => service().preview(owner(req), req.params.id)));
  router.post(`${prefix}/:id/move`, ...guard, handle(req => service().start(owner(req), req.params.id, req.body || {}), 202));
  router.get(`${prefix}/:id/move/progress`, ...guard, handle(req => ({ move: service().progress(owner(req), req.params.id) })));
  router.post(`${prefix}/:id/move/cancel`, ...guard, handle(req => ({ move: service().cancel(owner(req), req.params.id) })));
}

// The same for a linked engine's page: a link token only (any other Engine token 403 LINKED_ONLY), the owner of this service.
function addEngineTaskRoutes(router, { service, authenticate, linkForToken, owner }) {
  const linked = (req, res, next) => {
    const link = linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    next();
  };
  addPageRoutes(router, { service, owner: () => owner(), prefix: '/tasks', guard: [authenticate, linked] });
}

// "bytes=a-b" of a file of `size` bytes: { start, end } or null (no header); throws for a range that is not inside the file.
function parseRange(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(header));
  if (!match) throw Object.assign(new Error('MOVE_BAD_RANGE'), { statusCode: 416 });
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || start > end || start >= size) throw Object.assign(new Error('MOVE_BAD_RANGE'), { statusCode: 416 });
  return { start, end };
}

// The routes between the engines, mounted at /v1/task-move. `authenticate` is requireEngineAuth(); the service checks that the token is a link's.
function createPeerRouter({ service, authenticate }) {
  const router = express.Router();
  router.use(authenticate);
  const token = req => req.engineAuth.tokenId;
  router.get('/capacity', (req, res) => {
    try { res.json(service().capacityFor(token(req))); } catch (error) { sendError(res, error); } // only a linked service learns the free space
  });
  router.post('/offer', async (req, res) => {
    try { res.status(202).json(await service().acceptOffer(token(req), req.body || {})); } catch (error) { sendError(res, error); }
  });
  router.get('/:moveId', (req, res) => {
    try { res.json(service().statusForPeer(token(req), req.params.moveId)); } catch (error) { sendError(res, error); }
  });
  router.get('/:moveId/manifest', (req, res) => {
    let file;
    try { file = service().manifestFile(token(req), req.params.moveId); } catch (error) { return sendError(res, error); }
    res.setHeader('Content-Type', 'application/json');
    const stream = fs.createReadStream(file);
    stream.on('error', () => { if (!res.headersSent) res.status(409).json({ error: 'MOVE_NOT_OPEN' }); else res.destroy(); });
    stream.pipe(res);
  });
  router.get('/:moveId/blob/:index', (req, res) => {
    let blob;
    let range;
    let fd;
    try {
      blob = service().blob(token(req), req.params.moveId, req.params.index);
      range = parseRange(req.headers.range, blob.size);
      fd = files.openChecked(blob.path, blob.size);
    } catch (error) { return sendError(res, error); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    if (!blob.size) { fs.closeSync(fd); res.setHeader('Content-Length', 0); return res.end(); }
    const start = range ? range.start : 0;
    const end = range ? range.end : blob.size - 1;
    res.status(range ? 206 : 200);
    res.setHeader('Content-Length', end - start + 1);
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${blob.size}`);
    const stream = fs.createReadStream(null, { fd, start, end, autoClose: true });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  for (const [route, method] of [['progress', 'noteProgress'], ['commit', 'commit'], ['failed', 'peerFailed'], ['cancel', 'cancelIncoming']]) {
    router.post(`/:moveId/${route}`, (req, res) => {
      try { res.json(service()[method](token(req), req.params.moveId, req.body || {})); } catch (error) { sendError(res, error); }
    });
  }
  return router;
}

module.exports = { addPageRoutes, addEngineTaskRoutes, createPeerRouter, parseRange };
