const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createOssImages, OssImageError } = require('../services/oss-images');
const { getLinkedCapabilities, LinkedServiceError, UPLOAD_POLICY_TIMEOUT_MS } = require('../services/linked-capabilities');

// The one error mapping of these calls, also used where a linked service calls them (routes/linked-services.js).
function ossErrors(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof OssImageError) return res.status(error.statusCode).json({ error: error.message });
  if (error instanceof LinkedServiceError) return res.status(error.statusCode).json(error.body);
  if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid upload request' });
  return res.status(500).json({ error: 'The OSS upload service is temporarily unavailable' });
}

function createOssRouter(options = {}) {
  const service = options.service || createOssImages({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  // A test that hands in its own service runs without links unless it hands in `linked` too.
  const linked = options.linked || (options.service ? null : getLinkedCapabilities());
  const router = express.Router();
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'));
  const owner = req => req.session.user.login;
  router.get('/config', (req, res) => {
    const config = service.getConfig(owner(req));
    if (!linked) return res.json(config);
    res.json({ ...config, shared_from: service.isConfigured(owner(req)) ? null : linked.sharedFrom('oss') });
  });
  router.put('/config', (req, res) => res.json(service.saveConfig(owner(req), req.body)));
  router.delete('/config', (req, res) => res.json(service.clearConfig(owner(req))));
  // The browser uploads to OSS itself; this only signs what that upload may contain.
  router.post('/upload-policy', express.json({ limit: '4kb' }), async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const local = () => service.signUpload(owner(req), req.body);
      if (!linked) return res.json(await local());
      const { kind, type, size, name } = req.body || {};
      res.json(await linked.run('oss', {
        configured: () => service.isConfigured(owner(req)),
        local, route: '/oss/upload-policy', body: { kind, type, size, name }, timeoutMs: UPLOAD_POLICY_TIMEOUT_MS,
      }));
    } catch (error) { next(error); }
  });
  router.use(ossErrors);
  return router;
}
module.exports = { createOssRouter, ossErrors };
