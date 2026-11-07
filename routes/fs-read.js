// Preview of a file at any path (read only; services/fs-read.js): GET /content?path= (a text file, the answer shape of GET <task>/files/content plus
// `realPath`) and GET /image?path= (a PNG, JPEG, GIF or WebP image, the headers of GET <task>/files/image). Mounted as the local /api/fs (browser
// session) and the Engine /v1/fs (scope files:read). Errors are { error, message } with { path } for a folder.
const express = require('express');
const { createFsReader, errorBody } = require('../services/fs-read');
const { IMAGE_HEADERS } = require('../services/file-content');

function sendError(res, error) {
  const { status, body } = errorBody(error);
  res.status(status).json(body);
}

function createFsReadRouter({ reader = createFsReader() } = {}) {
  const router = express.Router();

  router.get('/content', async (req, res) => {
    try { res.json(await reader.readText(req.query.path)); }
    catch (error) { sendError(res, error); }
  });

  router.get('/image', async (req, res) => {
    let image;
    try { image = await reader.readImage(req.query.path); }
    catch (error) { sendError(res, error); return; }
    res.set({ 'Content-Type': image.type, 'Content-Length': String(image.data.length), ...IMAGE_HEADERS });
    res.end(image.data);
  });

  return router;
}

module.exports = { createFsReadRouter };
