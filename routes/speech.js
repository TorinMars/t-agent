const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createSpeech, SpeechError } = require('../services/speech');
const { createSpeakerFilter } = require('../services/speaker-filter');

function createSpeechRouter(options = {}) {
  const service = options.service || createSpeech({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  const speaker = options.speakerService || (!options.service ? createSpeakerFilter({ db: require('../db'), sessionSecret: require('../config').sessionSecret }) : null);
  const router = express.Router();
  router.service = service;
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'), express.json({ limit: '3mb' }));
  const owner = req => req.session.user.login;
  router.get('/config', (req, res) => res.json(service.getConfig(owner(req))));
  router.put('/config', (req, res) => res.json(service.saveConfig(owner(req), req.body)));
  router.delete('/config', (req, res) => res.json(service.clearConfig(owner(req))));
  if (speaker) {
    router.get('/speaker/config', (req, res) => res.json(speaker.getConfig(owner(req))));
    router.put('/speaker/config', (req, res) => res.json(speaker.saveConfig(owner(req), req.body)));
    for (const [path, action] of [['/speaker/enroll', 'enroll'], ['/speaker/verify', 'verify']]) {
      router.post(path, async (req, res, next) => {
        try { res.json(await speaker[action](owner(req), req.body && req.body.audio)); }
        catch (error) { next(error); }
      });
    }
    router.delete('/speaker/config', async (req, res, next) => {
      try { res.json(await speaker.clearConfig(owner(req))); } catch (error) { next(error); }
    });
  }
  // A short-lived token for the browser's own WebSocket to the speech service; the audio never passes through this server.
  router.post('/token', async (req, res, next) => {
    try {
      const filtered = speaker && speaker.sessionConfig(owner(req));
      if (filtered && req.body?.speakerFilterVersion !== 1) throw new SpeechError('Refresh this page before using the speaker filter', 409);
      const grant = await service.createToken(owner(req));
      res.set('Cache-Control', 'no-store').json({ ...grant, ...(filtered ? { speakerFilter: true } : {}) });
    }
    catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The voice sample is too large' });
    if (error instanceof SpeechError) return res.status(error.statusCode).json({ error: error.message });
    return res.status(500).json({ error: 'Voice input is temporarily unavailable' });
  });
  return router;
}

module.exports = { createSpeechRouter };
