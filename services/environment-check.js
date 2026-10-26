// Checks the machine the Client runs on and says which features will have problems.
//
// The report is grouped by feature: { features: [{ id, name, description, status, checks: [{ id, name, status, detail, fix, impact }] }] }.
// A check is ok, warn (works, but something is off), fail (the feature will not work) or info (nothing wrong; not set up or not applicable);
// the status of a feature is its worst check. `impact` says what stops working, `fix` what to do. Every check is bounded in time and a check
// that throws is a failed check, never a failed report. What the report holds is safe to show: no secrets, no account names.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { makeFinder } = require('../lib/find-program');

const ORDER = { info: 0, ok: 1, warn: 2, fail: 3 };
const CHECK_TIMEOUT_MS = 15000;
const NETWORK_TIMEOUT_S = 6;
const CLOCK_SKEW_LIMIT_S = 30;
const MIN_SECRET_LENGTH = 32;
const GB = 1024 ** 3;

const defaultFinders = {
  claude: makeFinder('claude', { envVar: 'CLAUDE_PATH', extraDirs: [path.join('.claude', 'local')] }),
  git: makeFinder('git'),
  pm2: makeFinder('pm2'),
};

// ── helpers that talk to the machine (all replaceable in tests) ──
function run(file, args, { timeout = 5000, env = process.env } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, env, encoding: 'utf8', maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), code: error && error.code });
    });
  });
}

// Answers { ok, status, headers, error } for a request made like the agents make theirs: with curl, which follows the proxy variables of the
// Client (a proxy that is only set in the terminal of the person is not seen by the Client); without curl, with fetch.
async function request(url, { method = 'HEAD', headers = {}, timeoutSeconds = NETWORK_TIMEOUT_S } = {}) {
  const args = ['-sS', '-i', '-m', String(timeoutSeconds), '-o', '-', '-X', method];
  if (method === 'HEAD') args.splice(1, 0, '-I'); // curl needs -I to avoid waiting for a body that never comes
  for (const [name, value] of Object.entries(headers)) args.push('-H', `${name}: ${value}`);
  args.push(url);
  const result = await run('curl', args, { timeout: (timeoutSeconds + 2) * 1000 });
  if (result.code === 'ENOENT') return fetchRequest(url, { method, headers, timeoutSeconds });
  const blocks = result.stdout.split(/\r?\n\r?\n/).filter(block => /^HTTP\//.test(block));
  if (!blocks.length) return { ok: false, error: (result.stderr || '').replace(/^curl: \(\d+\)\s*/, '').trim() || 'No answer' };
  const lines = blocks[blocks.length - 1].split(/\r?\n/);
  const status = Number((/^HTTP\/\S+\s+(\d+)/.exec(lines[0]) || [])[1]);
  const answer = {};
  for (const line of lines.slice(1)) { const at = line.indexOf(':'); if (at > 0) answer[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim(); }
  return { ok: true, status, headers: answer };
}

async function fetchRequest(url, { method, headers, timeoutSeconds }) {
  try {
    const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutSeconds * 1000) });
    return { ok: true, status: response.status, headers: Object.fromEntries(response.headers.entries()) };
  } catch (error) { return { ok: false, error: (error.cause && error.cause.code) || error.message }; }
}

// Whether a folder can be written, without creating it: when it does not exist yet the nearest folder above it that does is looked at, because
// that is the one the Client would create it in.
function writable(dir, fsApi = fs) {
  let current = dir;
  while (!fsApi.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  try { fsApi.accessSync(current, fs.constants.W_OK); return true; } catch { return false; }
}

const first = text => String(text || '').split('\n').map(line => line.trim()).find(Boolean) || '';
const short = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const hostOf = value => { try { const url = new URL(value); return `${url.hostname}${url.port ? `:${url.port}` : ''}`; } catch { return ''; } };

function createEnvironmentCheck(deps = {}) {
  const env = deps.env || process.env;
  const projectRoot = deps.projectRoot || path.resolve(__dirname, '..');
  const get = (name, load) => (deps[name] !== undefined ? deps[name] : load());
  const ask = deps.request || request;
  const exec = deps.run || run;
  const finders = deps.finders || defaultFinders;
  const timeout = deps.checkTimeoutMs || CHECK_TIMEOUT_MS;

  const done = (status, detail, extra = {}) => ({ status, detail, ...extra });

  // A program the person types in a terminal: found by the finder (PATH, usual folders, the login shell), and its version.
  async function program(finder, name, versionArgs = ['--version']) {
    const file = await finder.find(env);
    if (!file) return null;
    const version = first((await exec(file, versionArgs, { env })).stdout);
    return { file, version };
  }

  // ── the checks, by feature ──
  const features = [
    {
      id: 'terminal', name: 'Terminals', description: 'Task terminals, and the Claude / Codex sessions started in them',
      checks: [
        {
          id: 'pty', name: 'Terminal engine (node-pty)', run: async () => {
            try { await get('verifyNodePty', () => require('../lib/node-pty-runtime').verifyNodePty)(projectRoot); return done('ok', 'A terminal starts'); }
            catch (error) {
              return done('fail', `A terminal cannot start: ${short(error.message)}`, { fix: 'Run `npm rebuild node-pty` in the Client folder and restart the Client', impact: 'Terminals cannot open' });
            }
          },
        },
        {
          id: 'shell', name: 'Shell', run: async () => {
            const shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find(candidate => (deps.exists || fs.existsSync)(candidate));
            return shell ? done('ok', shell) : done('fail', 'No shell was found (/bin/zsh, /bin/bash or /bin/sh)', { impact: 'Terminals cannot open', fix: 'Install a shell such as bash' });
          },
        },
        {
          id: 'user', name: 'Terminal user', run: async () => {
            const { resolveTerminalUser } = get('terminalUser', () => require('../lib/terminal-user'));
            const resolved = resolveTerminalUser({ env });
            if (resolved.user) return done('ok', `Terminals run as ${resolved.user.name}`);
            if (resolved.reason === 'missing-explicit' || resolved.reason === 'missing-default') {
              return done('warn', `Terminals run as root because the user ${resolved.name} does not exist`, {
                fix: 'Create that user, or set TERMINAL_USER= in .env to choose another one, then restart the Client', impact: 'Claude Code refuses its mode without permission prompts when it runs as root',
              });
            }
            return done('ok', 'Terminals run as the user of the Client');
          },
        },
        {
          id: 'tasks-dir', name: 'Task folder', run: async () => {
            const dir = deps.tasksDir || env.TASKS_BASE_DIR || path.join(projectRoot, 'data', 'tasks');
            return writable(dir)
              ? done('ok', dir)
              : done('fail', `The folder ${dir} cannot be written`, { fix: 'Fix the permissions of that folder, or choose another working directory in Settings', impact: 'New tasks cannot be created' });
          },
        },
      ],
    },
    {
      id: 'claude-terminal', name: 'Claude Code in terminals', description: 'Claude sessions started from a task terminal',
      checks: [{
        id: 'cli', name: 'The claude command', run: async () => {
          const found = await program(finders.claude, 'claude');
          if (!found) {
            return done('fail', 'The claude command was not found', {
              fix: 'Install Claude Code (Utilities → install script), or set CLAUDE_PATH in .env to its full path, then restart the Client', impact: 'Claude sessions in terminals cannot start',
            });
          }
          return done('ok', found.version ? `${found.file} (${found.version})` : found.file);
        },
      }],
    },
    {
      id: 'claude-chat', name: 'Claude agent chat', description: 'The Claude conversation view',
      checks: [{
        id: 'engine', name: 'Claude Code engine and account', run: async () => {
          try {
            const probe = await get('claudeProbe', () => require('../lib/agent-chat/claude').probe)();
            const account = probe.account || {};
            if (!account.email && !account.subscriptionType && !account.apiKeySource && !account.tokenSource) {
              return done('warn', 'Claude Code starts, but no Claude account was found', { fix: 'Run `claude` once in a terminal and log in', impact: 'Claude replies in the chat fail with an authentication error' });
            }
            return done('ok', account.subscriptionType ? `Claude Code starts and is logged in (${account.subscriptionType})` : 'Claude Code starts and is logged in');
          } catch (error) {
            return done('fail', `Claude Code cannot start: ${short(error.message)}`, { fix: 'Reinstall the Client dependencies (`npm ci`) and restart the Client', impact: 'The Claude chat view cannot start' });
          }
        },
      }],
    },
    {
      id: 'codex-terminal', name: 'Codex in terminals', description: 'Codex sessions started from a task terminal',
      checks: [{
        id: 'cli', name: 'The codex command', run: async () => {
          const { findCodex } = get('codexModule', () => require('../lib/agent-chat/codex-app-server'));
          const file = await findCodex(env);
          if (!file) return done('fail', 'The codex command was not found', { fix: 'Install Codex, or set CODEX_PATH in .env to its full path, then restart the Client', impact: 'Codex sessions in terminals cannot start' });
          const version = first((await exec(file, ['--version'], { env })).stdout);
          return done('ok', version ? `${file} (${version})` : file);
        },
      }],
    },
    {
      id: 'codex-chat', name: 'Codex agent chat', description: 'The Codex conversation view',
      checks: [{
        id: 'engine', name: 'Codex app server and account', run: async () => {
          const mod = get('codexModule', () => require('../lib/agent-chat/codex-app-server'));
          const file = await mod.findCodex(env);
          if (!file) return done('fail', 'The codex command was not found', { fix: 'Install Codex, or set CODEX_PATH in .env to its full path, then restart the Client', impact: 'The Codex chat view cannot start' });
          const client = new mod.AppServerClient({ command: file, cwd: os.homedir(), env });
          try {
            await client.start();
            const answer = await client.request('account/read', { refreshToken: false });
            if (!answer || !answer.account) return done('warn', 'The Codex app server starts, but Codex is not logged in', { fix: 'Run `codex login` in a terminal', impact: 'Codex replies in the chat fail with an authentication error' });
            const kind = { chatgpt: 'ChatGPT', apiKey: 'an API key', amazonBedrock: 'Amazon Bedrock' }[answer.account.type] || 'an account';
            return done('ok', `The Codex app server starts and is logged in with ${kind}`);
          } catch (error) {
            return done('fail', `The Codex app server cannot start: ${short(error.message)}`, { fix: 'Update Codex: the chat needs a version that has `codex app-server`', impact: 'The Codex chat view cannot start' });
          } finally { client.close(); }
        },
      }],
    },
    {
      id: 'network', name: 'Network', description: 'What the agents and the updater need to reach',
      checks: [
        { id: 'anthropic', name: 'Claude servers (api.anthropic.com)', impact: 'Claude sessions and the Claude chat cannot work', url: 'https://api.anthropic.com' },
        { id: 'openai', name: 'Codex servers (chatgpt.com)', impact: 'Codex sessions and the Codex chat cannot work', url: 'https://chatgpt.com' },
        { id: 'github', name: 'GitHub (updates)', impact: 'The update check and updates cannot work', url: 'https://github.com', more: ['https://raw.githubusercontent.com'] },
      ].map(entry => ({
        id: entry.id, name: entry.name, run: async () => {
          const urls = [entry.url, ...(entry.more || [])];
          const answers = await Promise.all(urls.map(url => ask(url)));
          const failed = answers.map((answer, index) => ({ answer, host: hostOf(urls[index]) })).filter(item => !item.answer.ok);
          if (failed.length) {
            return done('fail', `${failed.map(item => item.host).join(', ')} cannot be reached: ${short(failed[0].answer.error)}`, {
              fix: 'Check the network of this machine. If it needs a proxy, set https_proxy (and http_proxy) in the environment the Client is started with: a proxy set only in your own terminal is not seen by the Client', impact: entry.impact,
            });
          }
          return done('ok', urls.map(hostOf).join(', '), { dates: answers.map(answer => answer.headers && answer.headers.date).filter(Boolean) });
        },
      })).concat([
        {
          id: 'proxy', name: 'Proxy settings', run: async () => {
            const names = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'].filter(name => env[name]);
            if (!names.length) return done('info', 'No proxy variables are set for the Client');
            const host = hostOf(env[names[0]].replace(/^socks5h?:\/\//, 'http://')) || 'set';
            return done('ok', `${names[0].toLowerCase()} points to ${host}`);
          },
        },
        {
          id: 'clock', name: 'System clock', run: async ctx => {
            const dates = (ctx.dates || []).map(value => Date.parse(value)).filter(Number.isFinite);
            if (!dates.length) return done('info', 'The clock could not be compared with a server');
            const skew = Math.round((Date.now() - dates[0]) / 1000);
            if (Math.abs(skew) <= CLOCK_SKEW_LIMIT_S) return done('ok', `Within ${CLOCK_SKEW_LIMIT_S} seconds of the servers`);
            return done('warn', skew > 0 ? `The clock is ${Math.abs(skew)} seconds ahead of the servers` : `The clock is ${Math.abs(skew)} seconds behind the servers`, { fix: 'Turn on automatic date and time on this machine', impact: 'Authenticator codes may be rejected at login' });
          },
        },
      ]),
    },
    {
      id: 'updates', name: 'Updates', description: 'Checking for and installing new versions',
      checks: [{
        id: 'git', name: 'git', run: async () => {
          const found = await program(finders.git, 'git');
          return found ? done('ok', found.version || found.file) : done('warn', 'git was not found', { fix: 'Install git', impact: 'Updates through git cannot run' });
        },
      }],
    },
    {
      id: 'oss', name: 'Image upload (Alibaba Cloud OSS)', description: 'Pasting images into a terminal',
      checks: [
        {
          id: 'config', name: 'Settings', run: async ctx => {
            const config = ctx.oss;
            if (!config || !config.enabled) return done('info', 'Not set up. It is only needed to paste images into terminals');
            return done('ok', `Bucket ${config.bucket} in ${config.region}`);
          },
        },
        {
          id: 'bucket', name: 'Bucket reachable', run: async ctx => {
            if (!ctx.oss || !ctx.oss.enabled) return done('info', 'Not set up');
            const host = `${ctx.oss.bucket}.${ctx.oss.region}.aliyuncs.com`;
            const answer = await ask(`https://${host}`);
            return answer.ok ? done('ok', host) : done('fail', `${host} cannot be reached: ${short(answer.error)}`, { fix: 'Check the bucket name, the region and the network of this machine', impact: 'Pasted images cannot be uploaded' });
          },
        },
        {
          id: 'cors', name: 'CORS rule for this page', run: async ctx => {
            if (!ctx.oss || !ctx.oss.enabled) return done('info', 'Not set up');
            const origin = ctx.origin;
            if (!origin) return done('info', 'The address of this page is not known');
            const answer = await ask(`https://${ctx.oss.bucket}.${ctx.oss.region}.aliyuncs.com/`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
            if (!answer.ok) return done('info', 'The bucket could not be asked');
            const allowed = answer.headers && answer.headers['access-control-allow-origin'];
            if (answer.status < 300 && (allowed === '*' || allowed === origin)) return done('ok', `The bucket allows uploads from ${origin}`);
            return done('fail', `The bucket does not allow uploads from ${origin}`, {
              fix: `In the OSS console add a CORS rule: allowed origin ${origin}, allowed method POST, allowed headers *`, impact: 'The browser blocks pasted-image uploads from this page',
            });
          },
        },
      ],
    },
    {
      id: 'access', name: 'Login and remote access', description: 'Signing in from other devices',
      checks: [
        {
          id: 'secret', name: 'Session key (SESSION_SECRET)', run: async () => {
            const secret = deps.sessionSecret !== undefined ? deps.sessionSecret : require('../config').sessionSecret;
            if (!secret || secret === 'dev-secret-change-me' || secret.length < MIN_SECRET_LENGTH) {
              return done('fail', `SESSION_SECRET is missing, the default one, or shorter than ${MIN_SECRET_LENGTH} characters`, { fix: `Set a random SESSION_SECRET of at least ${MIN_SECRET_LENGTH} characters in .env and restart the Client`, impact: 'The authenticator cannot be bound, and saved credentials are not protected' });
            }
            return done('ok', 'Set and long enough');
          },
        },
        {
          id: 'authenticator', name: 'Authenticator', run: async ctx => {
            const auth = ctx.clientAuth;
            if (!auth) return done('info', 'Not available');
            const mode = auth.accessMode();
            if (mode === 'local') return done('info', 'Local access only: no sign-in is needed');
            if (mode === 'unset') return done('info', 'The access mode has not been chosen yet');
            return auth.status({}).bound ? done('ok', 'An authenticator is bound') : done('warn', 'No authenticator is bound yet', { fix: 'Run `node scripts/client-auth-setup.js` on this machine', impact: 'Nobody can sign in from another device' });
          },
        },
        {
          id: 'transport', name: 'HTTPS', run: async ctx => {
            const mode = ctx.clientAuth ? ctx.clientAuth.accessMode() : 'unset';
            const insecure = ctx.origin && ctx.origin.startsWith('http://') && !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(hostOf(ctx.origin));
            if (mode !== 'remote' || !insecure) return done('ok', ctx.origin && ctx.origin.startsWith('https://') ? 'This page is served over HTTPS' : 'Nothing to fix');
            return done('warn', 'This page is opened over plain HTTP from another address', { fix: 'Put the Client behind HTTPS (see the Nginx section of the README), or set CLIENT_ALLOW_HTTP=true for a trusted network', impact: 'Sign-in from other devices is refused unless HTTPS is used' });
          },
        },
      ],
    },
    {
      id: 'tunnel', name: 'Public tunnel (frpc)', description: 'Reaching the Client from the internet',
      checks: [{
        id: 'frpc', name: 'frpc', run: async ctx => {
          const { findFrpc, probeFrpc } = get('frp', () => require('./frp'));
          const file = findFrpc();
          if (!file) return ctx.frpConfigured ? done('fail', 'frpc was not found although the tunnel is set up', { fix: 'Install frpc again from the Page enhancement tab', impact: 'The public tunnel cannot start' }) : done('info', 'Not installed. It is only needed for the public tunnel');
          const probe = probeFrpc(file);
          if (probe.error) return done(ctx.frpConfigured ? 'fail' : 'warn', probe.error, { fix: 'Install frpc again from the Page enhancement tab', impact: 'The public tunnel cannot start' });
          if (!probe.supported) return done('warn', `frpc ${probe.version} is too old`, { fix: 'Install frpc again from the Page enhancement tab', impact: 'The public tunnel may not start' });
          return done('ok', `frpc ${probe.version}`);
        },
      }],
    },
    {
      id: 'apps', name: 'App list (PM2)', description: 'Starting, stopping and reading the logs of services',
      checks: [{
        id: 'pm2', name: 'pm2', run: async () => {
          const found = await program(finders.pm2, 'pm2');
          return found ? done('ok', found.version || found.file) : done('warn', 'pm2 was not found', { fix: 'Install it with `npm install -g pm2`', impact: 'The PM2 actions of the app list (start, stop, restart, logs) are unavailable' });
        },
      }],
    },
    {
      id: 'storage', name: 'Storage', description: 'The database, terminal history and task files',
      checks: [{
        id: 'disk', name: 'Data folder', run: async () => {
          const dir = deps.dataDir || env.T_AGENT_DATA_DIR || path.join(projectRoot, 'data');
          if (!writable(dir)) return done('fail', `The folder ${dir} cannot be written`, { fix: 'Fix the permissions of that folder', impact: 'The database and the terminal history cannot be saved' });
          let free;
          try {
            let existing = dir;
            while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
            const stat = (deps.statfs || fs.statfsSync)(existing);
            free = Number(stat.bavail) * Number(stat.bsize);
          } catch { return done('ok', dir); }
          const text = `${(free / GB).toFixed(1)} GB free`;
          if (free < 0.1 * GB) return done('fail', `Only ${text} on the disk of the data folder`, { fix: 'Free some disk space', impact: 'The database and the terminal history cannot be saved' });
          if (free < GB) return done('warn', `Only ${text} on the disk of the data folder`, { fix: 'Free some disk space', impact: 'Saving may fail soon' });
          return done('ok', `${dir} (${text})`);
        },
      }],
    },
  ];

  const bounded = (promise, ms) => new Promise(resolve => {
    const timer = setTimeout(() => resolve(done('warn', 'The check did not finish in time', { fix: 'Check again' })), ms);
    promise.then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); resolve(done('fail', `The check failed: ${short(error && error.message)}`)); });
  });

  // Runs every check (in parallel); `context`: { origin, oss, clientAuth, frpConfigured } of this request.
  async function runAll(context = {}) {
    const network = features.find(feature => feature.id === 'network');
    const results = new Map();
    // The clock is compared with what the network checks saw, so those run first.
    const pending = [];
    for (const feature of features) {
      for (const check of feature.checks) {
        if (check.id === 'clock' && feature === network) continue;
        pending.push(bounded(Promise.resolve().then(() => check.run(context)), timeout).then(result => results.set(check, result)));
      }
    }
    await Promise.all(pending);
    const dates = network.checks.flatMap(check => (results.get(check) || {}).dates || []);
    const clock = network.checks.find(check => check.id === 'clock');
    results.set(clock, await bounded(Promise.resolve().then(() => clock.run({ ...context, dates })), timeout));
    return features.map(feature => {
      const checks = feature.checks.map(check => {
        const { dates: ignored, ...result } = results.get(check);
        return { id: check.id, name: check.name, ...result };
      });
      const status = checks.reduce((worst, check) => (ORDER[check.status] > ORDER[worst] ? check.status : worst), 'info');
      return { id: feature.id, name: feature.name, description: feature.description, status, checks };
    });
  }

  return {
    async run(context = {}) {
      const list = await runAll(context);
      const count = status => list.filter(feature => feature.status === status).length;
      return {
        checked_at: Date.now(),
        machine: { platform: `${os.type()} ${os.release()}`, arch: process.arch, node: process.version, user: os.userInfo().username },
        summary: { ok: count('ok') + count('info'), warn: count('warn'), fail: count('fail') },
        features: list,
      };
    },
  };
}

module.exports = { createEnvironmentCheck, request, writable, ORDER };
