// The T-Attention agent skill installer (services/attention-skill.js), for the browser's settings: the normal login and same-origin writes, like every
// setting. Mounted in server.js at /api/attention/skill before the T-Attention router; an attention token (Bearer tatt_) never gets here, because the
// Bearer path of routes/attention.js answers every /api/attention* request it carries. See "T-Attention agent skill" in DESIGN.md.
//   GET  /                -> { claude: { installed, path, current, conflict }, codex: {...}, old_task_tracker: { claude, codex }, cli, user }
//   POST /install         -> { ok, results: { claude: { action, path, conflict? }, codex }, status }
//   POST /remove-old      -> { ok, moved: [{ agent, from, to }], skipped: [{ agent, path, reason }], backup, status }
const express = require('express');
const { AttentionSkillError } = require('../services/attention-skill');

const defaultService = () => require('../services/attention-skill').getAttentionSkill();

function sendError(res, error) {
  if (error instanceof AttentionSkillError) return res.status(error.statusCode).json({ error: error.code, message: error.message });
  console.error('[attention-skill]', error && error.message);
  return res.status(500).json({ error: 'ATTENTION_SKILL_FAILED', message: (error && error.message) || 'The skill could not be written' });
}
const handle = handler => async (req, res) => {
  try { res.json(await handler(req)); } catch (error) { sendError(res, error); }
};

function createAttentionSkillRouter({ getService = defaultService, requireAuth = require('../middleware/auth'), clientOrigin = require('../middleware/client-origin') } = {}) {
  const router = express.Router();
  router.use(clientOrigin, requireAuth);
  router.get('/', handle(() => getService().status()));
  router.post('/install', handle(() => getService().install()));
  router.post('/remove-old', handle(() => getService().removeOld()));
  return router;
}

module.exports = { createAttentionSkillRouter };
