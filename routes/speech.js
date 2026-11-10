const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createSpeech, SpeechError, TIMEOUT_MS } = require('../services/speech');
const { getLinkedCapabilities, LinkedServiceError, TIMEOUT_MARGIN_MS } = require('../services/linked-capabilities');

// The one error mapping of these calls, also used where a linked service calls them (routes/linked-services.js).
function speechErrors(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof SpeechError) return res.status(error.statusCode).json({ error: error.message });
  if (error instanceof LinkedServiceError) return res.status(error.statusCode).json(error.body);
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The content is too large' });
  return res.status(500).json({ error: 'Voice input is temporarily unavailable' });
}

function createSpeechRouter(options = {}) {
  const service = options.service || createSpeech({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  // A test that hands in its own service runs without links unless it hands in `linked` too.
  const linked = options.linked || (options.service ? null : getLinkedCapabilities());
  const router = express.Router();
  router.service = service;
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'), express.json({ limit: '16kb' }));
  const owner = req => req.session.user.login;
  router.get('/config', (req, res) => {
    const config = service.getConfig(owner(req));
    if (!linked) return res.json(config);
    res.json({ ...config, shared_from: service.isConfigured(owner(req)) ? null : linked.sharedFrom('speech') });
  });
  router.put('/config', (req, res) => res.json(service.saveConfig(owner(req), req.body)));
  router.delete('/config', (req, res) => res.json(service.clearConfig(owner(req))));
  // A short-lived token for the browser's own WebSocket to the speech service; the audio never passes through this server.
  router.post('/token', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const local = () => service.createToken(owner(req));
      if (!linked) return res.json(await local());
      // The peer's own call to the speech service may take TIMEOUT_MS; waiting less would call a slow answer "offline".
      res.json(await linked.run('speech', {
        configured: () => service.isConfigured(owner(req)),
        local, route: '/speech/token', body: {}, timeoutMs: TIMEOUT_MS + TIMEOUT_MARGIN_MS,
      }));
    } catch (error) { next(error); }
  });
  router.use(speechErrors);
  return router;
}

module.exports = { createSpeechRouter, speechErrors };
