// The browser side of service links (services/service-links.js). The /v1 side is in routes/engine-v1.js.
const express = require('express');
const requireAuth = require('../middleware/auth');
const { getServiceLinks } = require('../services/service-links');

const router = express.Router();
router.use(requireAuth);

const owner = req => req.session.user.login;
const sendError = (res, error) => res.status(error.statusCode || 400).json({ error: /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'LINK_JOIN_FAILED' });

router.post('/code', (req, res) => {
  res.status(201).json(getServiceLinks().createCode(owner(req)));
});

router.get('/', (req, res) => {
  res.json({ links: getServiceLinks().list(owner(req)), supported: true });
});

router.post('/join', async (req, res) => {
  const body = req.body || {};
  try {
    res.status(201).json(await getServiceLinks().join({ url: body.url, port: body.port, code: body.code, name: body.name, confirm: body.confirm, ownerId: owner(req) }));
  } catch (error) { sendError(res, error); }
});

router.delete('/:id', async (req, res) => {
  const service = getServiceLinks();
  if (!service.list(owner(req)).some(link => link.id === req.params.id)) return res.status(404).json({ error: 'LINK_NOT_FOUND' });
  try {
    await service.unlink(req.params.id);
    res.status(204).end();
  } catch (error) { sendError(res, error); }
});

module.exports = router;
