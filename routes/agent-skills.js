// The agent skills installer (services/agent-skills.js), for the browser's settings: the normal login and same-origin writes, like every setting.
// Mounted in server.js at /api/agent-skills. See "Agent skills" in DESIGN.md.
//   GET  /                        -> { skills: [{ name, description, claude: { installed, path, current, conflict }, codex, cli }], old_task_tracker, user }
//   POST /:name/install           -> { ok, name, results: { claude: { action, path, conflict? }, codex }, status }   (status = the GET answer)
//   POST /t-attention/remove-old  -> { ok, moved: [{ agent, from, to }], skipped: [{ agent, path, reason }], backup, status }
// An unknown skill name is 404 AGENT_SKILL_UNKNOWN. The first installer's routes (/api/attention/skill, routes/attention-skill.js) stay for older pages.
const express = require('express');
const { AgentSkillError } = require('../services/agent-skills');

const defaultService = () => require('../services/agent-skills').getAgentSkills();

function sendError(res, error) {
  if (error instanceof AgentSkillError) return res.status(error.statusCode).json({ error: error.code, message: error.message });
  console.error('[agent-skills]', error && error.message);
  return res.status(500).json({ error: 'AGENT_SKILL_FAILED', message: (error && error.message) || 'The skill could not be written' });
}
const handle = handler => async (req, res) => {
  try { res.json(await handler(req)); } catch (error) { sendError(res, error); }
};

function createAgentSkillsRouter({ getService = defaultService, requireAuth = require('../middleware/auth'), clientOrigin = require('../middleware/client-origin') } = {}) {
  const router = express.Router();
  router.use(clientOrigin, requireAuth);
  router.get('/', handle(() => getService().list()));
  router.post('/t-attention/remove-old', handle(() => getService().removeOld()));
  router.post('/:name/install', handle(req => getService().install(req.params.name)));
  return router;
}

module.exports = { createAgentSkillsRouter };
