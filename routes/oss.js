const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createOssImages, OssImageError, MAX_IMAGE_BYTES } = require('../services/oss-images');

function createOssRouter(options = {}) {
  const service = options.service || createOssImages({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  const router = express.Router();
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'));
  const owner = req => req.session.user.login;
  router.get('/config', (req, res) => res.json(service.getConfig(owner(req))));
  router.put('/config', (req, res) => res.json(service.saveConfig(owner(req), req.body)));
  router.delete('/config', (req, res) => res.json(service.clearConfig(owner(req))));
  router.post('/images', express.raw({ type: () => true, limit: MAX_IMAGE_BYTES, inflate: false }), async (req, res, next) => {
    try { res.json(await service.upload(owner(req), req.body, req.get('Content-Type'))); }
    catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '图片不能超过 10 MiB' });
    if (error instanceof OssImageError) return res.status(error.statusCode).json({ error: error.message });
    if (error.type === 'encoding.unsupported') return res.status(415).json({ error: '不支持压缩的图片请求' });
    return res.status(500).json({ error: 'OSS 图片服务暂时不可用' });
  });
  return router;
}
module.exports = { createOssRouter };
