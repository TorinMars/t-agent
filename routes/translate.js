const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createTranslator, TranslatorError, needsProvider, translationTimeoutMs, TIMEOUT_MS } = require('../services/translator');
const { getLinkedCapabilities, LinkedServiceError, TIMEOUT_MARGIN_MS, TRANSLATION_MAX_BYTES } = require('../services/linked-capabilities');

// The one error mapping of these calls, also used where a linked service calls them (routes/linked-services.js).
function translateErrors(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof TranslatorError) return res.status(error.statusCode).json({ error: error.message });
  if (error instanceof LinkedServiceError) return res.status(error.statusCode).json(error.body);
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The content is too large' });
  return res.status(500).json({ error: 'The translation service is temporarily unavailable' });
}

function createTranslateRouter(options = {}) {
  const service = options.service || createTranslator({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  // A test that hands in its own service runs without links unless it hands in `linked` too.
  const linked = options.linked || (options.service ? null : getLinkedCapabilities());
  const router = express.Router();
  // 1 MB: room for the longest text the translator accepts (MAX_INPUT_CHARS of Chinese, JSON-escaped).
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'), express.json({ limit: '1mb' }));
  const owner = req => req.session.user.login;
  router.get('/config', (req, res) => {
    const config = service.getConfig(owner(req));
    if (!linked) return res.json(config);
    res.json({ ...config, shared_from: service.isConfigured(owner(req)) ? null : linked.sharedFrom('translate') });
  });
  router.put('/config', (req, res) => res.json(service.saveConfig(owner(req), req.body)));
  router.delete('/config', (req, res) => res.json(service.clearConfig(owner(req))));
  router.post('/', async (req, res, next) => {
    try {
      const text = req.body && req.body.text;
      const local = () => service.translate(owner(req), text);
      if (!linked) return res.json(await local());
      res.json(await linked.run('translate', {
        // Text that costs no provider call is answered here as it always was, even when the linked service is away.
        configured: () => service.isConfigured(owner(req)) || !needsProvider(text),
        local, route: '/translate', body: { text },
        timeoutMs: translationTimeoutMs(text) + TIMEOUT_MARGIN_MS, maxBytes: TRANSLATION_MAX_BYTES,
      }));
    } catch (error) { next(error); }
  });
  // One English word for the tap-to-translate option of the chat: { word, context } -> { word, base, phonetic, pos, meaning }.
  router.post('/word', async (req, res, next) => {
    try {
      const local = () => service.translateWord(owner(req), req.body);
      if (!linked) return res.json(await local());
      const { word, context } = req.body || {};
      res.json(await linked.run('translate', {
        configured: () => service.isConfigured(owner(req)),
        local, route: '/translate/word', body: { word, context }, timeoutMs: TIMEOUT_MS + TIMEOUT_MARGIN_MS,
      }));
    } catch (error) { next(error); }
  });
  router.use(translateErrors);
  return router;
}
module.exports = { createTranslateRouter, translateErrors };
