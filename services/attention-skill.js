'use strict';
// The first installer of the t-attention agent skill, kept for older pages (GET /api/attention/skill and its writes, routes/attention-skill.js). It is
// now one skill of the agent skills installer (services/agent-skills.js, "Agent skills" in DESIGN.md), which does the work; this module keeps the old
// answer shape: { claude, codex, old_task_tracker, cli, user } and install / remove-old results whose `status` has that shape too.
const path = require('node:path');
const os = require('node:os');
const { resolveTerminalUser } = require('../lib/terminal-user');
const skills = require('./agent-skills');

const SKILL_NAME = 't-attention';
const { OLD_SKILL_NAME, SYNC_MARKER, AGENTS, agentDirs, AgentSkillError } = skills;
const DEFINITION = skills.SKILLS.find(skill => skill.name === SKILL_NAME);
const SOURCE_FILE = DEFINITION.sourceFile;
const CLI_PATH = DEFINITION.cliPath;
const CLI_TOKEN = skills.ATTENTION_TOKEN;

// The skill text for this machine. A CLI path that cannot be written safely leaves the plain `t-attention` fallback (TA_ATTENTION_CLI or PATH).
const render = (source, cliPath = CLI_PATH) => skills.renderSkill(SKILL_NAME, source, cliPath);

// options: env, homedir, terminalUser() -> { user }, dataDir, sourceFile, cliPath, now() -> Date (see createAgentSkills).
function createAttentionSkill({ env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser({ env }), dataDir = null, sourceFile = SOURCE_FILE, cliPath = CLI_PATH, now = () => new Date() } = {}) {
  return fromAgentSkills(skills.createAgentSkills({ env, homedir, terminalUser, dataDir, now, skills: { [SKILL_NAME]: { sourceFile: path.resolve(sourceFile), cliPath } } }));
}

// The old view of an agent skills installer.
function fromAgentSkills(service) {
  const status = () => service.attentionStatus();
  const install = () => { const { ok, results } = service.installSkill(SKILL_NAME); return { ok, results, status: status() }; };
  const removeOld = () => ({ ...service.moveOld(), status: status() });
  return { status, install, removeOld };
}

let shared = null;
function getAttentionSkill() {
  if (!shared) shared = fromAgentSkills(skills.getAgentSkills());
  return shared;
}

const AttentionSkillError = AgentSkillError;

module.exports = { createAttentionSkill, getAttentionSkill, render, agentDirs, AttentionSkillError, SKILL_NAME, OLD_SKILL_NAME, SOURCE_FILE, CLI_PATH, CLI_TOKEN, SYNC_MARKER, AGENTS };
