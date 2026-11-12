'use strict';
// The agent skills that come with T-Agent (see "Agent skills" in DESIGN.md): one SKILL.md each under rules/skills/<name>/, the same file for Claude Code
// and Codex. This module installs them on the machine that runs this server, for the user who runs the agents (the terminal user when the service runs
// as root and drops privileges, like the listener install in services/attention-plugins.js):
//   <claude>/skills/<name>/SKILL.md   <claude> = $CLAUDE_CONFIG_DIR or ~/.claude
//   <codex>/skills/<name>/SKILL.md    <codex>  = $CODEX_HOME or ~/.codex
// The skills:
//   t-attention  report work to T-Attention. Per machine: `${TA_ATTENTION_CLI:-t-attention}` becomes `${TA_ATTENTION_CLI:-<checkout>/scripts/t-attention.js}`.
//   tcli         manage files in the OSS bucket of "Image and file upload". Per machine: `${TA_TCLI:+node} "${TA_TCLI:-tcli}"` becomes
//                `node "${TA_TCLI:-<checkout>/scripts/tcli.js}"`.
// Both commands also work outside a T-Agent terminal that way, where the variable is not set (routes/terminal.js sets it in every T-Agent shell).
// A skill folder that the rules and skills sync owns (it carries .t-agent-sync.json, services/rule-sync.js) is never overwritten: it is reported, and so
// is a symlinked folder or a file at that name. The old skill of the earlier tracker (`task-tracker`) can be moved into
// <data folder>/backups/task-tracker-<time>/ once t-attention is in place; it is moved, never deleted.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveTerminalUser, terminalEnvFor } = require('../lib/terminal-user');

const ROOT = path.resolve(__dirname, '..');
const OLD_SKILL_NAME = 'task-tracker';
// The marker file of the rules and skills sync (services/rule-sync.js MARKER), named here so that loading this module never loads the sync.
const SYNC_MARKER = '.t-agent-sync.json';
const AGENTS = Object.freeze(['claude', 'codex']);

class AgentSkillError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = 'AgentSkillError'; this.code = code; this.statusCode = statusCode; }
}

const isMissing = error => error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) { if (isMissing(error)) return null; throw error; }
}
function readTextOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (isMissing(error) || error.code === 'EISDIR') return null; throw error; }
}

// A path that can stand inside "..." in a POSIX shell without changing meaning: no quote, no expansion, no `}` that would end ${...}.
const SHELL_SAFE = /^[^"$`\\}\n\r\0]+$/;
const safePath = cliPath => Boolean(cliPath) && SHELL_SAFE.test(cliPath);

// The command as each skill writes it (`token`), and what the installer puts in its place for a CLI at `cliPath` (`replace`). A CLI path that cannot be
// written safely leaves the token as it is: the variable inside a T-Agent terminal, else the command on PATH.
const ATTENTION_TOKEN = '${TA_ATTENTION_CLI:-t-attention}';
// With TA_TCLI set this runs `node "$TA_TCLI"` (the script need not be executable); without it, `tcli` from PATH. The installed copy always runs node.
const TCLI_TOKEN = '${TA_TCLI:+node} "${TA_TCLI:-tcli}"';
const SKILLS = Object.freeze([
  Object.freeze({
    name: 't-attention',
    description: 'Teaches Claude Code and Codex to register their work and their sub-agents in T-Attention, to ask you when they need you, and to wait for your confirmation of finished work.',
    sourceFile: path.join(ROOT, 'rules', 'skills', 't-attention', 'SKILL.md'),
    cliPath: path.join(ROOT, 'scripts', 't-attention.js'),
    token: ATTENTION_TOKEN,
    replace: cliPath => `\${TA_ATTENTION_CLI:-${cliPath}}`,
  }),
  Object.freeze({
    name: 'tcli',
    description: 'Teaches Claude Code and Codex to list, upload, download, copy, move and delete files in the bucket of "Image and file upload" with the tcli command.',
    sourceFile: path.join(ROOT, 'rules', 'skills', 'tcli', 'SKILL.md'),
    cliPath: path.join(ROOT, 'scripts', 'tcli.js'),
    token: TCLI_TOKEN,
    replace: cliPath => `node "\${TA_TCLI:-${cliPath}}"`,
  }),
  Object.freeze({
    name: 'browser',
    description: 'Teaches Claude Code and Codex to drive the user’s browser with tcli browser, learn how a site works, and build up a reusable site entry with tcli site (the site capability library).',
    sourceFile: path.join(ROOT, 'rules', 'skills', 'browser', 'SKILL.md'),
    cliPath: path.join(ROOT, 'scripts', 'tcli.js'),
    token: TCLI_TOKEN,
    replace: cliPath => `node "\${TA_TCLI:-${cliPath}}"`,
  }),
]);
const SKILL_NAMES = Object.freeze(SKILLS.map(skill => skill.name));
const findSkill = name => SKILLS.find(skill => skill.name === name) || null;

// The skill text for this machine.
function renderSkill(name, source, cliPath) {
  const skill = findSkill(name);
  if (!skill || !safePath(cliPath)) return source;
  return source.split(skill.token).join(skill.replace(cliPath));
}

// The agent config folders of the user who runs the agents: { claude, codex, user }.
function agentDirs({ env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser({ env }) } = {}) {
  let user = null;
  try { user = terminalUser().user || null; } catch { user = null; }
  const where = user ? { env: terminalEnvFor(user, env), home: user.home } : { env, home: homedir() };
  const absolute = value => (value && path.isAbsolute(value) ? path.resolve(value) : null);
  return {
    claude: absolute(where.env.CLAUDE_CONFIG_DIR) || path.join(where.home, '.claude'),
    codex: absolute(where.env.CODEX_HOME) || path.join(where.home, '.codex'),
    user,
  };
}

// The rules and skills sync's marker in a skill folder, if any: { source } (the name of the service that shared it, when the marker says).
function syncOwner(dir) {
  const stat = lstatOrNull(path.join(dir, SYNC_MARKER));
  if (!stat) return null;
  let source = null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, SYNC_MARKER), 'utf8'));
    if (value && value.source && typeof value.source.name === 'string') source = value.source.name;
  } catch { /* an unreadable marker still means the sync owns the folder */ }
  return { source };
}

function chownTo(file, user) {
  if (!user) return;
  try { fs.chownSync(file, user.uid, user.gid); } catch { /* not root */ }
}

// mkdir -p with mode 0755, handing every folder it made to the agents' user.
function makeDirs(dir, user) {
  const missing = [];
  for (let at = dir; !lstatOrNull(at); at = path.dirname(at)) {
    missing.unshift(at);
    if (path.dirname(at) === at) break;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const made of missing) { try { fs.chmodSync(made, 0o755); } catch { /* kept */ } chownTo(made, user); }
}

// Write to a temporary file next to the target, then rename it over the target: a reader sees the old or the new content, never half of it.
function writeAtomic(file, data, user) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, data, { mode: 0o644, flag: 'wx' });
    fs.chmodSync(temp, 0o644);
    chownTo(temp, user);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing was written */ }
    throw error;
  }
}

// rename, or across file systems a copy that keeps links as links followed by removing the original: a move either way.
function moveTree(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// options: env, homedir, terminalUser() -> { user }, dataDir (the server's data folder; default lib/data-home.js), now() -> Date, and
// skills: { <name>: { sourceFile, cliPath } } to read another source file or write another CLI path for a skill (tests).
function createAgentSkills({ env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser({ env }), dataDir = null, skills = {}, now = () => new Date() } = {}) {
  const dirs = () => agentDirs({ env, homedir, terminalUser });
  const backupRoot = () => path.join(dataDir || require('../lib/data-home').paths({ env }).root, 'backups');
  const settingsOf = name => {
    const skill = findSkill(name);
    if (!skill) throw new AgentSkillError('AGENT_SKILL_UNKNOWN', `No such agent skill: ${name}`, 404);
    const own = (skills && skills[name]) || {};
    return { ...skill, sourceFile: own.sourceFile || skill.sourceFile, cliPath: own.cliPath === undefined ? skill.cliPath : own.cliPath };
  };

  function wanted(name) {
    const skill = settingsOf(name);
    const source = readTextOrNull(skill.sourceFile);
    if (source === null) throw new AgentSkillError('AGENT_SKILL_SOURCE_MISSING', `The skill file of this install is missing: ${skill.sourceFile}`, 500);
    return renderSkill(name, source, skill.cliPath);
  }

  // One agent's install state. conflict: 'rule-sync' (the sync owns the folder), 'symlink' (the folder is a link), 'not-a-directory'.
  function inspect(root, name, content) {
    const dir = path.join(root, 'skills', name);
    const file = path.join(dir, 'SKILL.md');
    const stat = lstatOrNull(dir);
    const state = { installed: false, path: file, current: false, conflict: null };
    if (!stat) return state;
    if (stat.isSymbolicLink()) state.conflict = 'symlink';
    else if (!stat.isDirectory()) return { ...state, conflict: 'not-a-directory' };
    const text = readTextOrNull(file);
    state.installed = text !== null;
    state.current = text !== null && text === content;
    if (!state.conflict) {
      const owner = syncOwner(dir);
      if (owner) { state.conflict = 'rule-sync'; state.sync_source = owner.source; }
    }
    return state;
  }

  const oldDir = root => path.join(root, 'skills', OLD_SKILL_NAME);
  const oldTaskTracker = where => Object.fromEntries(AGENTS.map(agent => [agent, Boolean(lstatOrNull(oldDir(where[agent])))]));

  // One skill: { name, description, claude, codex, cli: { path, found } }.
  function skillStatus(name, where = dirs()) {
    const skill = settingsOf(name);
    const content = wanted(name);
    const out = { name, description: skill.description };
    for (const agent of AGENTS) out[agent] = inspect(where[agent], name, content);
    out.cli = { path: skill.cliPath, found: Boolean(skill.cliPath && lstatOrNull(skill.cliPath)) };
    return out;
  }

  // Every skill: { skills: [...], old_task_tracker: { claude, codex }, user }. A skill whose source file is missing (a broken install) is listed with
  // `error` (the message) and never current, so the others can still be installed.
  function broken(name, where, error) {
    const skill = settingsOf(name);
    const out = { name, description: skill.description, error: error.message };
    for (const agent of AGENTS) out[agent] = inspect(where[agent], name, null);
    out.cli = { path: skill.cliPath, found: Boolean(skill.cliPath && lstatOrNull(skill.cliPath)) };
    return out;
  }
  function list() {
    const where = dirs();
    const one = name => {
      try { return skillStatus(name, where); } catch (error) { if (error instanceof AgentSkillError) return broken(name, where, error); throw error; }
    };
    return { skills: SKILL_NAMES.map(one), old_task_tracker: oldTaskTracker(where), user: where.user ? where.user.name : null };
  }

  // Writes one skill's SKILL.md for both agents. Per agent: action 'installed' | 'updated' | 'unchanged' | 'refused' (with conflict). Other files stay.
  function installSkill(name) {
    const content = wanted(name);
    const where = dirs();
    const results = {};
    for (const agent of AGENTS) {
      const before = inspect(where[agent], name, content);
      if (before.conflict) { results[agent] = { action: 'refused', path: before.path, conflict: before.conflict, sync_source: before.sync_source || null }; continue; }
      if (before.current) { results[agent] = { action: 'unchanged', path: before.path }; continue; }
      makeDirs(path.dirname(before.path), where.user);
      writeAtomic(before.path, content, where.user);
      results[agent] = { action: before.installed ? 'updated' : 'installed', path: before.path };
    }
    return { ok: AGENTS.every(agent => results[agent].action !== 'refused'), name, results };
  }
  const install = name => ({ ...installSkill(name), status: list() });

  // Moves <agent>/skills/task-tracker into <data folder>/backups/task-tracker-<time>/<agent>/task-tracker. Skipped per agent: 'missing', 'not-installed'
  // (t-attention is not in place there, so the agent would be left without one), 'rule-sync' (the sync owns it and would only bring it back).
  function moveOld() {
    const content = wanted('t-attention');
    const where = dirs();
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    let backup = path.join(backupRoot(), `task-tracker-${stamp}`);
    for (let n = 2; lstatOrNull(backup); n += 1) backup = path.join(backupRoot(), `task-tracker-${stamp}-${n}`);
    const moved = [];
    const skipped = [];
    for (const agent of AGENTS) {
      const from = oldDir(where[agent]);
      const stat = lstatOrNull(from);
      if (!stat) { skipped.push({ agent, path: from, reason: 'missing' }); continue; }
      if (!inspect(where[agent], 't-attention', content).installed) { skipped.push({ agent, path: from, reason: 'not-installed' }); continue; }
      if (!stat.isSymbolicLink() && stat.isDirectory() && syncOwner(from)) { skipped.push({ agent, path: from, reason: 'rule-sync' }); continue; }
      const to = path.join(backup, agent, OLD_SKILL_NAME);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      moveTree(from, to);
      moved.push({ agent, from, to });
    }
    return { ok: true, moved, skipped, backup: moved.length ? backup : null };
  }
  const removeOld = () => ({ ...moveOld(), status: list() });

  // The shape of the first installer (GET /api/attention/skill and its writes), for t-attention only: { claude, codex, old_task_tracker, cli, user }.
  function attentionStatus() {
    const where = dirs();
    const { claude, codex, cli } = skillStatus('t-attention', where);
    return { claude, codex, old_task_tracker: oldTaskTracker(where), cli, user: where.user ? where.user.name : null };
  }

  return { list, skillStatus, install, installSkill, removeOld, moveOld, attentionStatus };
}

let shared = null;
function getAgentSkills() {
  if (!shared) shared = createAgentSkills();
  return shared;
}

module.exports = {
  createAgentSkills, getAgentSkills, renderSkill, agentDirs, AgentSkillError, SKILLS, SKILL_NAMES, ATTENTION_TOKEN, TCLI_TOKEN, OLD_SKILL_NAME, SYNC_MARKER, AGENTS,
};
