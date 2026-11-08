// T-Attention plugin overview: the checks of one machine, shared by the server (GET /api/attention/plugins, through
// services/attention-plugins.js) and the `t-attention plugins` command. Node built-ins only, like lib/attention-client.js.
//
// readListeners(dir)        every plugins/listeners/<name>/manifest.json; a broken one is listed with an `error`
// checkListener(name, opts) { hookPath, loggedIn, toolHooks } for one listener on this machine:
//   hookPath   <data folder>/listeners/<name>-hook.path exists and names an existing file (written by `t-attention login`)
//   loggedIn   <data folder>/attention-client.json has a url and a token (the token itself is never returned)
//   toolHooks  claude: <home>/.claude/settings.json has a hook command that reads listeners/claude-hook.path
//              (put there by scripts/agent-sync.py when `ta` starts); false when the file is missing, null when it
//              cannot be read or parsed, and null for listeners without a known tool config
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const client = require('./attention-client');

const LISTENERS_DIR = path.join(__dirname, '..', 'plugins', 'listeners');
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

const shortText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

function readListeners(dir = LISTENERS_DIR) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const base = { name: entry.name, version: null, description: null, entry: null, events: [], error: null };
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, entry.name, 'manifest.json'), 'utf8')); } catch (error) {
      found.push({ ...base, error: error.code === 'ENOENT' ? 'manifest.json is missing' : 'manifest.json is not valid JSON' });
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) { found.push({ ...base, error: 'manifest.json is not an object' }); continue; }
    if (manifest.kind !== 'listener') continue; // another kind of plugin in this folder
    const name = typeof manifest.name === 'string' && NAME.test(manifest.name) ? manifest.name : null;
    const listener = {
      name: name || entry.name,
      version: shortText(manifest.version, 40),
      description: shortText(manifest.description, 500),
      entry: shortText(manifest.entry, 200),
      events: Array.isArray(manifest.events) ? manifest.events.filter(event => typeof event === 'string').slice(0, 50) : [],
      error: null,
    };
    if (!name) listener.error = 'manifest.json has no valid name';
    else if (!listener.entry) listener.error = 'manifest.json has no entry';
    else if (!fs.existsSync(path.join(dir, entry.name, listener.entry))) listener.error = `the entry ${listener.entry} is missing`;
    found.push(listener);
  }
  return found;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// The hook commands in a Claude Code settings object (hooks.<Event>[].hooks[].command).
function hookCommands(settings) {
  const out = [];
  const hooks = settings && typeof settings === 'object' ? settings.hooks : null;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of (group && Array.isArray(group.hooks) ? group.hooks : [])) if (hook && typeof hook.command === 'string') out.push(hook.command);
    }
  }
  return out;
}

function claudeHooksSynced(home) {
  let text;
  try { text = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'); } catch (error) { return error.code === 'ENOENT' ? false : null; }
  let settings;
  try { settings = JSON.parse(text); } catch { return null; }
  return hookCommands(settings).some(command => command.includes('listeners/claude-hook.path'));
}

// options: dataDir (default: the data folder of env/homedir), home (the user whose tool config is read; default homedir()), env, homedir.
function checkListener(name, { env = process.env, homedir = os.homedir, dataDir, home } = {}) {
  const dir = dataDir || client.dataHome({ env, homedir });
  const userHome = home || homedir();
  let hookPath = false;
  if (NAME.test(String(name))) {
    try { hookPath = isFile(fs.readFileSync(path.join(dir, 'listeners', `${name}-hook.path`), 'utf8').trim()); } catch { hookPath = false; }
  }
  const stored = client.readConfigFile(path.join(dir, client.CONFIG_FILE)) || {};
  const loggedIn = typeof stored.url === 'string' && Boolean(stored.url.trim()) && typeof stored.token === 'string' && Boolean(stored.token.trim());
  const toolHooks = name === 'claude' ? claudeHooksSynced(userHome) : null;
  return { hookPath, loggedIn, toolHooks };
}

module.exports = { LISTENERS_DIR, readListeners, checkListener, hookCommands };
