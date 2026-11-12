'use strict';
// The T-Attention agent skill (see "T-Attention agent skill" in DESIGN.md): one SKILL.md (rules/skills/t-attention/SKILL.md) that teaches Claude Code and
// Codex how to report their work with the `t-attention` command. This module installs it on the machine that runs this server, for the user who runs the
// agents (the terminal user when the service runs as root and drops privileges, like the listener install in services/attention-plugins.js):
//   <claude>/skills/t-attention/SKILL.md   <claude> = $CLAUDE_CONFIG_DIR or ~/.claude
//   <codex>/skills/t-attention/SKILL.md    <codex>  = $CODEX_HOME or ~/.codex
// The one per-machine change is the CLI path: `${TA_ATTENTION_CLI:-t-attention}` becomes `${TA_ATTENTION_CLI:-<this checkout>/scripts/t-attention.js}`,
// so the command also works outside a T-Agent terminal, where TA_ATTENTION_CLI is not set (routes/terminal.js sets it in every T-Agent shell).
// A skill folder that the rules and skills sync owns (it carries .t-agent-sync.json, services/rule-sync.js) is never overwritten: it is reported.
// The old skill of the earlier tracker (`task-tracker`) can be moved into <data folder>/backups/task-tracker-<time>/; it is moved, never deleted.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveTerminalUser, terminalEnvFor } = require('../lib/terminal-user');

const SKILL_NAME = 't-attention';
const OLD_SKILL_NAME = 'task-tracker';
const SOURCE_FILE = path.resolve(__dirname, '..', 'rules', 'skills', SKILL_NAME, 'SKILL.md');
const CLI_PATH = path.resolve(__dirname, '..', 'scripts', 't-attention.js');
// The command as the skill writes it; the installer puts the absolute CLI path after `:-`.
const CLI_TOKEN = '${TA_ATTENTION_CLI:-t-attention}';
// The marker file of the rules and skills sync (services/rule-sync.js MARKER), named here so that loading this module never loads the sync.
const SYNC_MARKER = '.t-agent-sync.json';
const AGENTS = Object.freeze(['claude', 'codex']);

class AttentionSkillError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = 'AttentionSkillError'; this.code = code; this.statusCode = statusCode; }
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

// The skill text for this machine. A CLI path that cannot be written safely leaves the plain `t-attention` fallback (TA_ATTENTION_CLI or PATH).
function render(source, cliPath = CLI_PATH) {
  if (!cliPath || !SHELL_SAFE.test(cliPath)) return source;
  return source.split(CLI_TOKEN).join(`\${TA_ATTENTION_CLI:-${cliPath}}`);
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

// options: env, homedir, terminalUser() -> { user }, dataDir (the server's data folder; default lib/data-home.js), sourceFile, cliPath, now() -> Date.
function createAttentionSkill({ env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser({ env }), dataDir = null, sourceFile = SOURCE_FILE, cliPath = CLI_PATH, now = () => new Date() } = {}) {
  const dirs = () => agentDirs({ env, homedir, terminalUser });
  const backupRoot = () => path.join(dataDir || require('../lib/data-home').paths({ env }).root, 'backups');

  function wanted() {
    const source = readTextOrNull(sourceFile);
    if (source === null) throw new AttentionSkillError('ATTENTION_SKILL_SOURCE_MISSING', `The skill file of this install is missing: ${sourceFile}`, 500);
    return render(source, cliPath);
  }

  // One agent's install state. conflict: 'rule-sync' (the sync owns the folder), 'symlink' (the folder is a link), 'not-a-directory'.
  function inspect(root, content) {
    const dir = path.join(root, 'skills', SKILL_NAME);
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

  function status() {
    const content = wanted();
    const where = dirs();
    const out = {};
    for (const agent of AGENTS) out[agent] = inspect(where[agent], content);
    out.old_task_tracker = Object.fromEntries(AGENTS.map(agent => [agent, Boolean(lstatOrNull(oldDir(where[agent])))]));
    out.cli = { path: cliPath, found: Boolean(lstatOrNull(cliPath)) };
    out.user = where.user ? where.user.name : null;
    return out;
  }

  // Writes SKILL.md for both agents. Per agent: action 'installed' | 'updated' | 'unchanged' | 'refused' (with conflict). Other files in the folder stay.
  function install() {
    const content = wanted();
    const where = dirs();
    const results = {};
    for (const agent of AGENTS) {
      const before = inspect(where[agent], content);
      if (before.conflict) { results[agent] = { action: 'refused', path: before.path, conflict: before.conflict, sync_source: before.sync_source || null }; continue; }
      if (before.current) { results[agent] = { action: 'unchanged', path: before.path }; continue; }
      makeDirs(path.dirname(before.path), where.user);
      writeAtomic(before.path, content, where.user);
      results[agent] = { action: before.installed ? 'updated' : 'installed', path: before.path };
    }
    const refused = AGENTS.filter(agent => results[agent].action === 'refused');
    return { ok: refused.length === 0, results, status: status() };
  }

  // Moves <agent>/skills/task-tracker into <data folder>/backups/task-tracker-<time>/<agent>/task-tracker. Skipped per agent: 'missing', 'not-installed'
  // (the new skill is not in place there, so the agent would be left without one), 'rule-sync' (the sync owns it and would only bring it back).
  function removeOld() {
    const content = wanted();
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
      if (!inspect(where[agent], content).installed) { skipped.push({ agent, path: from, reason: 'not-installed' }); continue; }
      if (!stat.isSymbolicLink() && stat.isDirectory() && syncOwner(from)) { skipped.push({ agent, path: from, reason: 'rule-sync' }); continue; }
      const to = path.join(backup, agent, OLD_SKILL_NAME);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      moveTree(from, to);
      moved.push({ agent, from, to });
    }
    return { ok: true, moved, skipped, backup: moved.length ? backup : null, status: status() };
  }

  return { status, install, removeOld };
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

let shared = null;
function getAttentionSkill() {
  if (!shared) shared = createAttentionSkill();
  return shared;
}

module.exports = { createAttentionSkill, getAttentionSkill, render, agentDirs, AttentionSkillError, SKILL_NAME, OLD_SKILL_NAME, SOURCE_FILE, CLI_PATH, CLI_TOKEN, SYNC_MARKER, AGENTS };
