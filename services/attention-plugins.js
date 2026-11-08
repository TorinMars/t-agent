// T-Attention plugin overview: what GET /api/attention/plugins answers (see "T-Attention plugin overview" in DESIGN.md).
//   listeners  every plugins/listeners/<name>/manifest.json of kind 'listener' (a broken one with an `error`), and `local`: how the
//              listener is set up on the machine that runs this server, read as the terminal user (lib/terminal-user.js) when the
//              service runs as root and drops privileges, because that user runs `t-attention login`, `ta` and Claude Code; plus
//              the open items and the newest change it wrote (services/attention.js sourceStats). For claude also `hooksCurrent`
//              (every entry of this install is in ~/.claude/settings.json, unchanged; lib/listener-install.js checkClaudeHooks),
//              `autoTerminal` (T-Agent terminals get TA_ATTENTION_URL / TA_ATTENTION_TOKEN / TA_ATTENTION_HOOK, routes/terminal.js)
//              and `installable` (POST /api/attention/plugins/claude/install works for it).
//   notifiers  services/attention-notify.js overview(owner): loaded and skipped notifier plugins, setup state and per-status modes
// No secret is ever part of the answer: the token, the session string and the api_hash stay where they are.
//
// createListenerInstaller: the one-click install of the claude listener on this machine (A in "T-Attention: easy listener install").
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const local = require('../lib/attention-plugins-local');
const client = require('../lib/attention-client');
const listenerInstall = require('../lib/listener-install');
const { resolveTerminalUser, terminalEnvFor } = require('../lib/terminal-user');

const INSTALL_TOKEN_NAME = 'claude listener (this machine)';

// The user whose data folder and ~/.claude this machine's listeners use: { env, homedir, home, user, dataDir }.
function terminalMachine({ env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser({ env }) } = {}) {
  let user = null;
  try { user = terminalUser().user || null; } catch { user = null; }
  const where = user
    ? { env: terminalEnvFor(user, env), homedir: () => user.home, home: user.home, user }
    : { env, homedir, home: homedir(), user: null };
  return { ...where, dataDir: client.dataHome({ env: where.env, homedir: where.homedir }) };
}

// options: service (services/attention.js), notify (services/attention-notify.js; optional), listenersDir, env, homedir,
// terminalUser() -> { user } (default lib/terminal-user.js resolveTerminalUser), autoTerminal() -> boolean (terminals get the env).
function createPluginOverview({ service, notify = null, listenersDir = local.LISTENERS_DIR, env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser({ env }), autoTerminal = () => false } = {}) {
  if (!service) throw new Error('createPluginOverview needs the attention service');

  function listeners() {
    const where = terminalMachine({ env, homedir, terminalUser });
    return local.readListeners(listenersDir).map(listener => {
      const stats = (typeof service.sourceStats === 'function' && service.sourceStats(listener.name)) || { itemCount: 0, lastEventAt: null };
      const check = local.checkListener(listener.name, { dataDir: where.dataDir, home: where.home });
      const extra = {};
      if (listener.name === 'claude' && !listener.error) {
        extra.hooksCurrent = listenerInstall.checkClaudeHooks({ dataDir: where.dataDir, home: where.home }).current;
        extra.autoTerminal = Boolean(autoTerminal());
        extra.installable = true;
      }
      return { ...listener, local: { ...check, ...extra, lastEventAt: stats.lastEventAt, itemCount: stats.itemCount } };
    });
  }

  function overview(owner) {
    const who = owner || (notify && typeof notify.defaultOwner === 'function' ? notify.defaultOwner() : null);
    return { listeners: listeners(), notifiers: notify && typeof notify.overview === 'function' ? notify.overview(who) : [] };
  }

  return { overview, listeners };
}

function chownTo(file, user) {
  if (!user) return;
  try { fs.chownSync(file, user.uid, user.gid); } catch { /* not root */ }
}

// options: service, overview (createPluginOverview), localUrl() -> 'http://127.0.0.1:<port>' (null before the server listens), env,
// homedir, terminalUser, hookPath, rulesFile, checkRemote(url, token) -> Promise<boolean> (does a stored config for another server work).
function createListenerInstaller({ service, overview = null, localUrl = () => null, env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser({ env }), hookPath = listenerInstall.HOOK_PATH, rulesFile = listenerInstall.RULES_FILE, checkRemote = defaultCheckRemote } = {}) {
  if (!service) throw new Error('createListenerInstaller needs the attention service');

  const listenerEntry = () => (overview ? overview.listeners().find(listener => listener.name === 'claude') || null : null);

  // Keeps a stored config that works; else writes {url: this server's loopback address, token: a new token}. Returns 'kept' | 'written'.
  async function ensureClientConfig(where) {
    const file = path.join(where.dataDir, client.CONFIG_FILE);
    const stored = client.readConfigFile(file) || {};
    const ownUrl = localUrl();
    if (typeof stored.url === 'string' && stored.url.trim() && typeof stored.token === 'string' && stored.token.trim()) {
      const url = client.normalizeUrl(stored.url);
      if (url && ownUrl && url === client.normalizeUrl(ownUrl)) {
        if (service.verifyToken(stored.token.trim())) return 'kept';
      } else if (url && await checkRemote(url, stored.token.trim())) {
        return 'kept';
      }
    }
    if (!ownUrl) throw Object.assign(new Error('The server address is not known yet; try again in a moment'), { code: 'NOT_READY' });
    for (const token of service.listTokens()) if (token.name === INSTALL_TOKEN_NAME && !token.revoked_at) service.revokeToken(token.id);
    const created = service.createToken({ name: INSTALL_TOKEN_NAME });
    const missingDir = !fs.existsSync(where.dataDir);
    const written = client.writeConfig({ url: client.normalizeUrl(ownUrl), token: created.token }, { env: where.env, homedir: where.homedir });
    if (missingDir) chownTo(where.dataDir, where.user);
    chownTo(written, where.user);
    return 'written';
  }

  async function install() {
    const where = terminalMachine({ env, homedir, terminalUser });
    const owner = where.user ? { uid: where.user.uid, gid: where.user.gid } : null;
    // The hooks first: a ~/.claude/settings.json that cannot be merged stops the install before a token is made.
    const hooks = listenerInstall.installClaudeHooks({ dataDir: where.dataDir, home: where.home, hookPath, rulesFile, owner });
    const config = await ensureClientConfig(where);
    return {
      ok: true,
      client: config,
      settingsFile: hooks.settingsFile,
      changed: hooks.changed,
      added: hooks.added,
      updated: hooks.updated,
      backup: hooks.backup,
      hookPath: hooks.hookPath,
      user: where.user ? where.user.name : null,
      listener: listenerEntry(),
    };
  }

  function uninstall() {
    const where = terminalMachine({ env, homedir, terminalUser });
    const owner = where.user ? { uid: where.user.uid, gid: where.user.gid } : null;
    const result = listenerInstall.uninstallClaudeHooks({ dataDir: where.dataDir, home: where.home, owner });
    return { ok: true, settingsFile: result.settingsFile, changed: result.changed, removed: result.removed, pathRemoved: result.pathRemoved, tokensKept: true, listener: listenerEntry() };
  }

  return { install, uninstall };
}

async function defaultCheckRemote(url, token) {
  try {
    await client.createClient({ url, token, timeoutMs: 3000 }).list({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { createPluginOverview, createListenerInstaller, terminalMachine, INSTALL_TOKEN_NAME };
