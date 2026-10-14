const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createTranslator, TranslatorError } = require('../services/translator');

function createTranslateRouter(options = {}) {
  const service = options.service || createTranslator({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  const router = express.Router();
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'), express.json({ limit: '64kb' }));
  const owner = req => req.session.user.login;
  router.get('/config', (req, res) => res.json(service.getConfig(owner(req))));
  router.put('/config', (req, res) => res.json(service.saveConfig(owner(req), req.body)));
  router.delete('/config', (req, res) => res.json(service.clearConfig(owner(req))));
  router.post('/', async (req, res, next) => {
    try { res.json(await service.translate(owner(req), req.body && req.body.text)); }
    catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof TranslatorError) return res.status(error.statusCode).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '内容过大' });
    return res.status(500).json({ error: '翻译服务暂时不可用' });
  });
  return router;
}
module.exports = { createTranslateRouter };
