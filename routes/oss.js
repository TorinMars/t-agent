const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createOssImages, OssImageError } = require('../services/oss-images');

function createOssRouter(options = {}) {
  const service = options.service || createOssImages({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  const router = express.Router();
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'));
  const owner = req => req.session.user.login;
  router.get('/config', (req, res) => res.json(service.getConfig(owner(req))));
  router.put('/config', (req, res) => res.json(service.saveConfig(owner(req), req.body)));
  router.delete('/config', (req, res) => res.json(service.clearConfig(owner(req))));
  // The browser uploads to OSS itself; this only signs what that upload may contain.
  router.post('/upload-policy', express.json({ limit: '2kb' }), async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await service.signUpload(owner(req), req.body)); }
    catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof OssImageError) return res.status(error.statusCode).json({ error: error.message });
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid upload request' });
    return res.status(500).json({ error: 'The OSS image service is temporarily unavailable' });
  });
  return router;
}
module.exports = { createOssRouter };
