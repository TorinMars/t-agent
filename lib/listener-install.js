// Claude listener install on one machine, shared by the server (POST /api/attention/plugins/claude/install, services/attention-plugins.js)
// and the `t-attention login` / `pair` commands. Node built-ins only, like lib/attention-client.js (no dotenv, no database).
//
// installClaudeHooks({ dataDir, home, hookPath, rulesFile, owner })
//   1. writes <dataDir>/listeners/claude-hook.path: the absolute path of this install's plugins/listeners/claude/hook.js;
//   2. merges the listener hook entries of rules/claude/settings.json (the groups whose command reads listeners/claude-hook.path) into
//      <home>/.claude/settings.json: missing ones are added, an older version of one of them (another listener command with the same
//      matcher in the same event) is replaced in place, everything else is kept. A file that is not valid JSON is not touched (error
//      "~/.claude/settings.json is not valid JSON"); before the first change a copy is kept as <file>.t-agent.bak (like scripts/agent-sync.py);
//      the write is atomic and keeps the file mode.
//   Returns { hookPath, pathFile, settingsFile, changed, added, updated, backup, toolHooks: true }.
// uninstallClaudeHooks({ dataDir, home })  removes the groups made only of listener commands and the path file.
// checkClaudeHooks({ dataDir, home })      { hookPath, toolHooks, current } (current: every entry of this install is there, unchanged).
// owner: { uid, gid } (the terminal user when the service runs as root): new files and folders are given to that user.
const fs = require('node:fs');
const path = require('node:path');
const local = require('./attention-plugins-local');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, 'plugins', 'listeners', 'claude', 'hook.js');
const RULES_FILE = path.join(ROOT, 'rules', 'claude', 'settings.json');
const POINTER = 'listeners/claude-hook.path';
const PATH_FILE = 'claude-hook.path';

class ListenerInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ListenerInstallError';
    this.code = code;
  }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// JSON with sorted keys, so two groups compare equal whatever their key order.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const commandsOf = group => (isObject(group) && Array.isArray(group.hooks) ? group.hooks : []).map(hook => (isObject(hook) && typeof hook.command === 'string' ? hook.command : null));
const isListenerCommand = command => typeof command === 'string' && command.includes(POINTER);
// A group that carries a listener command (it may carry others too).
const hasListener = group => commandsOf(group).some(isListenerCommand);
// A group made only of listener commands: ours to replace or remove.
const onlyListener = group => { const commands = commandsOf(group); return commands.length > 0 && commands.every(isListenerCommand); };

// { Event: [group, ...] }: the listener groups of this install's rules file.
function listenerEntries(rulesFile = RULES_FILE) {
  const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
  const out = {};
  for (const [event, groups] of Object.entries(isObject(rules.hooks) ? rules.hooks : {})) {
    const mine = (Array.isArray(groups) ? groups : []).filter(hasListener);
    if (mine.length) out[event] = mine;
  }
  return out;
}

const settingsFileOf = home => path.join(home, '.claude', 'settings.json');

// The settings object, {} when the file is missing; throws for a file that cannot be read or is not a JSON object with an object `hooks`.
function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { settings: {}, exists: false, mode: null };
    throw new ListenerInstallError('SETTINGS_UNREADABLE', '~/.claude/settings.json cannot be read');
  }
  let settings;
  if (!text.trim()) settings = {};
  else {
    try { settings = JSON.parse(text); } catch { throw new ListenerInstallError('SETTINGS_INVALID', '~/.claude/settings.json is not valid JSON'); }
  }
  if (!isObject(settings)) throw new ListenerInstallError('SETTINGS_INVALID', '~/.claude/settings.json is not valid JSON');
  if (settings.hooks !== undefined && !isObject(settings.hooks)) throw new ListenerInstallError('SETTINGS_INVALID', '~/.claude/settings.json has a "hooks" value that is not an object');
  for (const groups of Object.values(settings.hooks || {})) {
    if (!Array.isArray(groups)) throw new ListenerInstallError('SETTINGS_INVALID', '~/.claude/settings.json has a hook event that is not a list');
  }
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* read just now */ }
  return { settings, exists: true, mode };
}

function chown(target, owner) {
  if (!owner || !Number.isInteger(owner.uid)) return;
  try { fs.chownSync(target, owner.uid, Number.isInteger(owner.gid) ? owner.gid : -1); } catch { /* not root: the file is ours already */ }
}

function ensureDir(dir, owner, mode = 0o700) {
  const missing = [];
  for (let at = path.resolve(dir); !fs.existsSync(at); at = path.dirname(at)) missing.unshift(at);
  fs.mkdirSync(dir, { recursive: true, mode });
  for (const created of missing) chown(created, owner);
}

function writeAtomic(file, text, mode, owner) {
  ensureDir(path.dirname(file), owner);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { mode });
    fs.chmodSync(temp, mode);
    chown(temp, owner);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* not written */ }
    throw error;
  }
}

function backupOnce(file, mode, owner) {
  const backup = `${file}.t-agent.bak`;
  if (fs.existsSync(backup)) return null;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, mode);
  chown(backup, owner);
  return backup;
}

// The merged settings and what changed: added groups and replaced older listener groups.
function mergeEntries(settings, entries) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  let added = 0;
  let updated = 0;
  for (const [event, wanted] of Object.entries(entries)) {
    const groups = [...(next.hooks[event] || [])];
    const wantedKeys = new Set(wanted.map(stable));
    for (const group of wanted) {
      if (groups.some(existing => stable(existing) === stable(group))) continue;
      const old = groups.findIndex(existing => onlyListener(existing) && !wantedKeys.has(stable(existing)) && (existing.matcher || '') === (group.matcher || ''));
      if (old !== -1) { groups[old] = group; updated += 1; } else { groups.push(group); added += 1; }
    }
    next.hooks[event] = groups;
  }
  return { next, added, updated };
}

function installClaudeHooks({ dataDir, home, hookPath = HOOK_PATH, rulesFile = RULES_FILE, owner = null } = {}) {
  if (!dataDir || !home) throw new Error('installClaudeHooks needs dataDir and home');
  const target = path.resolve(hookPath);
  if (!fs.existsSync(target)) throw new ListenerInstallError('HOOK_MISSING', 'The listener hook of this install is missing');
  const settingsFile = settingsFileOf(home);
  const entries = listenerEntries(rulesFile);
  // The settings are read first: a file that cannot be merged leaves everything as it was.
  const { settings, exists, mode } = readSettings(settingsFile);

  const pathFile = path.join(dataDir, 'listeners', PATH_FILE);
  let pointer = null;
  try { pointer = fs.readFileSync(pathFile, 'utf8').trim(); } catch { pointer = null; }
  if (pointer !== target) writeAtomic(pathFile, `${target}\n`, 0o600, owner);

  const { next, added, updated } = mergeEntries(settings, entries);
  let backup = null;
  const changed = added + updated > 0;
  if (changed) {
    if (exists) backup = backupOnce(settingsFile, mode, owner);
    writeAtomic(settingsFile, `${JSON.stringify(next, null, 2)}\n`, exists ? mode : 0o600, owner);
  }
  return { hookPath: target, pathFile, pathChanged: pointer !== target, settingsFile, changed, added, updated, backup, toolHooks: true };
}

function uninstallClaudeHooks({ dataDir, home, owner = null } = {}) {
  if (!dataDir || !home) throw new Error('uninstallClaudeHooks needs dataDir and home');
  const settingsFile = settingsFileOf(home);
  const { settings, exists, mode } = readSettings(settingsFile);
  let removed = 0;
  if (exists && settings.hooks) {
    const hooks = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const kept = groups.filter(group => !onlyListener(group));
      removed += groups.length - kept.length;
      if (kept.length || !groups.length) hooks[event] = kept;
    }
    if (removed) {
      const next = { ...settings };
      if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
      backupOnce(settingsFile, mode, owner);
      writeAtomic(settingsFile, `${JSON.stringify(next, null, 2)}\n`, mode, owner);
    }
  }
  const pathFile = path.join(dataDir, 'listeners', PATH_FILE);
  let pathRemoved = false;
  try { fs.unlinkSync(pathFile); pathRemoved = true; } catch { pathRemoved = false; }
  return { settingsFile, changed: removed > 0, removed, pathFile, pathRemoved };
}

function checkClaudeHooks({ dataDir, home, rulesFile = RULES_FILE } = {}) {
  const { hookPath, toolHooks } = local.checkListener('claude', { dataDir, home });
  let current = null;
  if (toolHooks === true) {
    try {
      const { settings } = readSettings(settingsFileOf(home));
      const { added, updated } = mergeEntries(settings, listenerEntries(rulesFile));
      current = added + updated === 0;
    } catch { current = null; }
  } else if (toolHooks === false) current = false;
  return { hookPath, toolHooks, current };
}

module.exports = { HOOK_PATH, RULES_FILE, ListenerInstallError, listenerEntries, installClaudeHooks, uninstallClaudeHooks, checkClaudeHooks };
