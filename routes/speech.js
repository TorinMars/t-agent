const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createSpeech, SpeechError } = require('../services/speech');

function createSpeechRouter(options = {}) {
  const service = options.service || createSpeech({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  const router = express.Router();
  router.service = service;
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'), express.json({ limit: '16kb' }));
  const owner = req => req.session.user.login;
  router.get('/config', (req, res) => res.json(service.getConfig(owner(req))));
  router.put('/config', (req, res) => res.json(service.saveConfig(owner(req), req.body)));
  router.delete('/config', (req, res) => res.json(service.clearConfig(owner(req))));
  // A short-lived token for the browser's own WebSocket to the speech service; the audio never passes through this server.
  router.post('/token', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await service.createToken(owner(req))); }
    catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SpeechError) return res.status(error.statusCode).json({ error: error.message });
    return res.status(500).json({ error: 'Voice input is temporarily unavailable' });
  });
  return router;
}

module.exports = { createSpeechRouter };
