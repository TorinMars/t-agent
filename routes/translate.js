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
  // One English word for the tap-to-translate option of the chat: { word, context } -> { word, base, phonetic, pos, meaning }.
  router.post('/word', async (req, res, next) => {
    try { res.json(await service.translateWord(owner(req), req.body)); }
    catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof TranslatorError) return res.status(error.statusCode).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The content is too large' });
    return res.status(500).json({ error: 'The translation service is temporarily unavailable' });
  });
  return router;
}
module.exports = { createTranslateRouter };
