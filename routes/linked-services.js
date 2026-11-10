// A linked service using this service's translation, voice input and OSS upload (services/linked-capabilities.js is the calling side). The calls spend someone's
// paid API accounts, so only a token issued for a service link gets in, however much authority another Engine token has. Local configuration only: a service
// that has none answers "not configured" and never asks a peer of its own, which is what stops loops and chains.
const express = require('express');
const { createTranslator } = require('../services/translator');
const { createSpeech } = require('../services/speech');
const { createOssImages } = require('../services/oss-images');
const { translateErrors } = require('./translate');
const { speechErrors } = require('./speech');
const { ossErrors } = require('./oss');

function defaults() {
  const db = require('../db');
  const { sessionSecret } = require('../config');
  return {
    translator: createTranslator({ db, sessionSecret }),
    speech: createSpeech({ db, sessionSecret }),
    oss: createOssImages({ db, sessionSecret }),
    serviceLinks: require('../services/service-links').getServiceLinks(),
    requireEngineAuth: require('../middleware/engine-auth'),
    // The account a browser session gets (middleware/auth.js), so the same stored configuration is read. Not the token's principal: an Engine token can
    // belong to config.engineOwnerId or to whatever the single user was called when the link was made.
    owner: () => require('../services/single-user').ensureSingleUser().login,
  };
}

function createLinkedServicesRouter(options = {}) {
  const { translator, speech, oss, serviceLinks, requireEngineAuth, owner } = { ...(options.translator ? {} : defaults()), ...options };
  const router = express.Router();

  const linkOnly = (req, res, next) => {
    const link = serviceLinks.linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    next();
  };
  // Before any body is read.
  router.use(requireEngineAuth(), linkOnly);

  const isOn = check => { try { return Boolean(check()); } catch { return false; } };
  router.get('/availability', (req, res) => {
    const id = owner();
    res.set('Cache-Control', 'no-store').json({
      translate: isOn(() => translator.isConfigured(id)),
      speech: isOn(() => speech.isConfigured(id)),
      oss: isOn(() => oss.isConfigured(id)),
    });
  });

  const post = (path, limit, errors, action) => router.post(path, express.json({ limit }), async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await action(owner(), req.body)); }
    catch (error) { next(error); }
  }, errors);

  post('/translate', '1mb', translateErrors, (id, body) => translator.translate(id, body && body.text));
  post('/translate/word', '1mb', translateErrors, (id, body) => translator.translateWord(id, body));
  post('/speech/token', '16kb', speechErrors, id => speech.createToken(id));
  post('/oss/upload-policy', '4kb', ossErrors, (id, body) => oss.signUpload(id, body));
  return router;
}

module.exports = { createLinkedServicesRouter };
