// Mind maps HTTP API, mounted at /api/mindmaps after the session, access and login gates and the same-origin rule for mutations (see "Mind maps" in DESIGN.md).
//
// This router parses its own JSON bodies. server.js keeps the global parsers (32 MB, before the session) off this path, so a body is read only after the
// gates have let the request through, and the limit here is the one that counts. The other routes keep the global parser and its limit.
const express = require('express');
const { MindmapError, LIMITS } = require('../services/mindmap');

// The limit in the service is on the serialised `data`; this leaves room for the title, the revision and the JSON around them.
const BODY_LIMIT = LIMITS.dataBytes + 64 * 1024;

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

const sendInvalid = res => sendError(res, 400, 'INVALID_MINDMAP', 'The request is not a valid mind map');

function createMindmapRouter({ service }) {
  if (!service) throw new Error('createMindmapRouter needs the mind map service');
  const router = express.Router();
  const json = express.json({ limit: BODY_LIMIT });

  // req.is() is null without a body, so a POST with no body at all is allowed (both of its fields are optional).
  function parseBody(req, res, next) {
    if (req.is('application/json') === false) return sendInvalid(res);
    return json(req, res, error => {
      if (!error) return next();
      if (error.type === 'entity.too.large') return sendError(res, 413, 'MINDMAP_TOO_LARGE', 'The mind map is too large (limit: 8 MB)');
      return sendInvalid(res);
    });
  }

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

  router.get('/', wrap(async (req, res) => res.json({ maps: await service.list() })));
  router.post('/', parseBody, wrap(async (req, res) => res.status(201).json(await service.create(req.body))));
  router.get('/:id', wrap(async (req, res) => res.json(await service.get(req.params.id))));
  router.put('/:id', parseBody, wrap(async (req, res) => res.json(await service.update(req.params.id, req.body))));
  router.delete('/:id', wrap(async (req, res) => {
    await service.remove(req.params.id);
    res.status(204).end();
  }));

  return router;
}

module.exports = { createMindmapRouter, BODY_LIMIT };
