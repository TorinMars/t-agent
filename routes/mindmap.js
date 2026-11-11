// Mind maps HTTP API (see "Mind maps" in DESIGN.md). One router, mounted twice:
// - /api/mindmaps for the browser session, after the session, access and login gates and the same-origin rule for mutations;
// - /v1/mindmaps for other services (routes/engine-v1.js), with `authenticate` (an Engine token) as its first layer.
// Both use the same service instance, so writes of one map run one at a time whichever path they come in by.
//
// This router parses its own JSON bodies. server.js keeps the global parsers (32 MB, before the session) off both paths, so a body is read only after the
// gates (or the token check) have let the request through, and the limit here is the one that counts. The other routes keep the global parser and its limit.
// The Client's proxy for another service's maps (routes/remote-servers.js) uses the same parser, so it accepts and refuses exactly what this router does.
const express = require('express');
const { MindmapError, LIMITS } = require('../services/mindmap');

// The limit in the service is on the serialised `data`; this leaves room for the title, the revision and the JSON around them.
const BODY_LIMIT = LIMITS.dataBytes + 64 * 1024;

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

const sendInvalid = res => sendError(res, 400, 'INVALID_MINDMAP', 'The request is not a valid mind map');
const sendTooLarge = res => sendError(res, 413, 'MINDMAP_TOO_LARGE', 'The mind map is too large (limit: 8 MB)');
const sendNotFound = res => sendError(res, 404, 'MINDMAP_NOT_FOUND', 'Mind map not found');

// The JSON parser of a mind map write, with the answers of this API: 400 INVALID_MINDMAP and 413 MINDMAP_TOO_LARGE.
// req.is() is null without a body, so a POST with no body at all is allowed (both of its fields are optional).
function createMindmapBodyParser() {
  const json = express.json({ limit: BODY_LIMIT });
  return function parseMindmapBody(req, res, next) {
    if (req.is('application/json') === false) return sendInvalid(res);
    return json(req, res, error => {
      if (!error) return next();
      if (error.type === 'entity.too.large') return sendTooLarge(res);
      return sendInvalid(res);
    });
  };
}

// `service` is the mind map service, or `getService` a function that returns it (made on first use, for a router built when its module loads).
function createMindmapRouter({ service, getService, authenticate } = {}) {
  if (!service && !getService) throw new Error('createMindmapRouter needs the mind map service');
  const maps = () => service || getService();
  const router = express.Router();
  // Before any body is read.
  if (authenticate) router.use(authenticate);
  const parseBody = createMindmapBodyParser();

  const wrap = handler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof MindmapError) return sendError(res, error.statusCode, error.code, error.message, error.extra);
      // Only the kind of failure: an error message could carry a path or content.
      console.error(`Mind maps: storage failed (${error.code || error.name})`);
      return sendError(res, 500, 'MINDMAP_STORAGE_FAILED', 'The mind map storage failed');
    }
    return undefined;
  };

  router.get('/', wrap(async (req, res) => res.json({ maps: await maps().list() })));
  router.post('/', parseBody, wrap(async (req, res) => res.status(201).json(await maps().create(req.body))));
  router.get('/:id', wrap(async (req, res) => res.json(await maps().get(req.params.id))));
  router.put('/:id', parseBody, wrap(async (req, res) => res.json(await maps().update(req.params.id, req.body))));
  router.delete('/:id', wrap(async (req, res) => {
    await maps().remove(req.params.id);
    res.status(204).end();
  }));

  return router;
}

module.exports = { createMindmapRouter, createMindmapBodyParser, sendError, sendNotFound, sendTooLarge, BODY_LIMIT };
