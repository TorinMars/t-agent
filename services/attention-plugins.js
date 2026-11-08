// T-Attention plugin overview: what GET /api/attention/plugins answers (see "T-Attention plugin overview" in DESIGN.md).
//   listeners  every plugins/listeners/<name>/manifest.json of kind 'listener' (a broken one with an `error`), and `local`: how the
//              listener is set up on the machine that runs this server, read as the terminal user (lib/terminal-user.js) when the
//              service runs as root and drops privileges, because that user runs `t-attention login`, `ta` and Claude Code; plus
//              the open items and the newest change it wrote (services/attention.js sourceStats)
//   notifiers  services/attention-notify.js overview(owner): loaded and skipped notifier plugins, setup state and per-status modes
// No secret is ever part of the answer: the token, the session string and the api_hash stay where they are.
const os = require('node:os');
const local = require('../lib/attention-plugins-local');
const client = require('../lib/attention-client');
const { resolveTerminalUser, terminalEnvFor } = require('../lib/terminal-user');

// options: service (services/attention.js), notify (services/attention-notify.js; optional), listenersDir, env, homedir,
// terminalUser() -> { user } (default lib/terminal-user.js resolveTerminalUser).
function createPluginOverview({ service, notify = null, listenersDir = local.LISTENERS_DIR, env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser({ env }) } = {}) {
  if (!service) throw new Error('createPluginOverview needs the attention service');

  // The user whose data folder and ~/.claude this machine's listeners use.
  function machine() {
    let user = null;
    try { user = terminalUser().user || null; } catch { user = null; }
    if (!user) return { env, homedir, home: homedir() };
    const userEnv = terminalEnvFor(user, env);
    return { env: userEnv, homedir: () => user.home, home: user.home };
  }

  function listeners() {
    const where = machine();
    const dataDir = client.dataHome({ env: where.env, homedir: where.homedir });
    return local.readListeners(listenersDir).map(listener => {
      const stats = (typeof service.sourceStats === 'function' && service.sourceStats(listener.name)) || { itemCount: 0, lastEventAt: null };
      const check = local.checkListener(listener.name, { dataDir, home: where.home });
      return { ...listener, local: { ...check, lastEventAt: stats.lastEventAt, itemCount: stats.itemCount } };
    });
  }

  function overview(owner) {
    const who = owner || (notify && typeof notify.defaultOwner === 'function' ? notify.defaultOwner() : null);
    return { listeners: listeners(), notifiers: notify && typeof notify.overview === 'function' ? notify.overview(who) : [] };
  }

  return { overview };
}

module.exports = { createPluginOverview };
