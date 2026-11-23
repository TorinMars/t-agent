// The plan usage bars (docs/design/plan-usage.md): GET /api/agent-usage and POST /api/agent-usage/refresh with the page's login, and the same under
// /v1/agent-usage with an Engine token that can read tasks (routes/engine-v1.js). Both answer { engine: { instance_id, name }, agents: [usage] }.
const express = require('express');

function createAgentUsageRouter({ service = () => require('../services/agent-usage').getAgentUsage(), authenticate = require('../middleware/auth') } = {}) {
  const router = express.Router();
  router.use(authenticate);
  const usage = () => (typeof service === 'function' ? service() : service);
  const answer = run => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await run(usage())); }
    catch { res.status(500).json({ error: 'AGENT_USAGE_FAILED' }); }
  };
  router.get('/', answer(current => current.get()));
  router.post('/refresh', answer(current => current.refresh()));
  return router;
}

module.exports = { createAgentUsageRouter };
