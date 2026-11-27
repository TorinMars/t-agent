// "Open in VS Code": the one `code serve-web` process of this engine and the proxy to it. See docs/design/vscode-web.md.
//
// One process per engine serves any folder (`?folder=`). It listens on a Unix socket in <dataHome>/vscode/run (a loopback port when the CLI has no
// --socket-path), protected by a connection token that is made fresh at each start and never leaves this module: status() never shows it, the
// output kept for errors has it redacted, and request() / upgrade() / openWebSocket() add it as the `vscode-tkn` cookie themselves. The routes of
// the engine (routes/vscode-web-engine.js) and the page server's local transport both go through those three functions.
//
// States: stopped -> starting -> ready | error. ensure() starts the process (after the switch, the CLI and the one-time license confirmation are
// checked), the readiness poll moves it to ready, an exit or a failed start to error, stop() / the idle timer / the switch to stopped.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CAPABILITY = 'vscode:web';
// Settings of this engine (lib/server-state-keys.js, docs/design/server-state-keys.md): whether VS Code may run here, its idle minutes, and the
// one-time confirmation of the VS Code Server license.
const ENABLED_KEY = 'vscode_web_enabled';
const IDLE_KEY = 'vscode_web_idle_minutes';
const LICENSE_KEY = 'vscode_license_accepted';
const DEFAULT_IDLE_MINUTES = 30;
const MAX_IDLE_MINUTES = 24 * 60;

const ERRORS = Object.freeze({
  NOT_INSTALLED: 'VSCODE_NOT_INSTALLED',
  UNSUPPORTED: 'VSCODE_SERVE_WEB_UNSUPPORTED',
  DISABLED: 'VSCODE_DISABLED',
  LICENSE: 'VSCODE_LICENSE_REQUIRED',
  DOWNLOAD: 'VSCODE_DOWNLOAD_FAILED',
  START: 'VSCODE_START_FAILED',
  NOT_RUNNING: 'VSCODE_NOT_RUNNING',
});

// The public host the browser sees (X-Forwarded-Host) and its scheme.
const HOST_PATTERN = /^[A-Za-z0-9.\-[\]:]{1,255}$/;
const validHost = host => typeof host === 'string' && HOST_PATTERN.test(host);
const validProto = proto => proto === 'http' || proto === 'https';

// Request headers that reach VS Code; everything else (cookies of the page, authorization, accept-encoding, forwarded headers) is dropped. No
// accept-encoding: the body must be uncompressed because a service link tunnel drops content-encoding; the page server compresses for the browser.
const REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-range', 'if-none-match', 'if-modified-since',
  'cache-control', 'pragma', 'user-agent', 'x-requested-with'];
const UPGRADE_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'user-agent', 'accept-language'];
// Response headers that never leave: VS Code's own token cookie, the service worker scope (it could claim the whole page origin) and hop-by-hop ones.
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'service-worker-allowed', 'connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate',
  'proxy-connection', 'upgrade', 'trailer', 'te']);

const OUTPUT_LIMIT = 2048;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_TTL_MS = 5 * 60_000;
const PROBE_MISS_TTL_MS = 30_000;
const READY_TIMEOUT_MS = 5 * 60_000; // the first start downloads the server (about 60 to 100 MB)
const READY_POLL_MS = 500;
const KILL_GRACE_MS = 3000;
const IDLE_CHECK_MS = 30_000;
const SOCKET_PATH_MAX = 100; // sun_path is 104 bytes on macOS, 108 on Linux

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });

// The folders of VS Code under the data home. Ownership follows the user VS Code runs as.
function prepareDir(dir, user, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* not ours to change */ }
  if (user) { try { fs.chownSync(dir, user.uid, user.gid); } catch { /* left as it is */ } }
}

function canEnterAll(dir, user, userCanEnter) {
  let current = path.resolve(dir);
  while (true) {
    if (fs.existsSync(current) && !userCanEnter(current, user)) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

// Takes the token (and any tkn= query) out of a text before it is kept or logged.
function redactor(token) {
  return text => {
    let out = String(text || '');
    if (token) out = out.split(token).join('<redacted>');
    return out.replace(/([?&]tkn=)[^&\s"']+/g, '$1<redacted>').replace(/(vscode-tkn=)[^;\s"']+/g, '$1<redacted>');
  };
}

// A Location header without the token and, when it points at VS Code's own address, as a path of the page.
function cleanLocation(value) {
  const text = String(value || '');
  let url;
  try { url = new URL(text, 'http://vscode.internal'); } catch { return ''; }
  url.searchParams.delete('tkn');
  const internal = url.host === 'vscode.internal' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(url.host);
  if (internal) return `${url.pathname}${url.search}${url.hash}`;
  return url.toString();
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower) || value === undefined) continue;
    out[lower] = lower === 'location' ? cleanLocation(value) : value;
  }
  return out;
}

function pick(headers, names) {
  const out = {};
  for (const name of names) {
    const value = headers && headers[name];
    if (typeof value === 'string' && value && !/[\r\n]/.test(value)) out[name] = value;
  }
  return out;
}

function createVscodeWeb({
  db = null,
  dataRoot = null,
  engineId = null,
  findCli = null,
  env = process.env,
  terminalUser = null,
  log = console,
  spawnImpl = spawn,
  execFileImpl = execFile,
  readyTimeoutMs = READY_TIMEOUT_MS,
  readyPollMs = READY_POLL_MS,
  killGraceMs = KILL_GRACE_MS,
  idleCheckMs = IDLE_CHECK_MS,
  idleMs = null, // tests: overrides the idle minutes setting
  probeTtlMs = PROBE_TTL_MS,
} = {}) {
  const database = () => db || require('../db');
  const root = () => dataRoot || require('../lib/data-home').paths().root;
  const instanceId = () => {
    const id = typeof engineId === 'function' ? engineId() : engineId || require('./engine-identity').getEngineIdentity().engine_id;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(id || ''))) throw fault('ENGINE_ID_INVALID', 500);
    return String(id);
  };
  const basePath = () => `/vscode/${instanceId()}`;
  const findProgram = findCli || (() => {
    const finder = require('../lib/find-program').makeFinder('code', { envVar: 'VSCODE_CLI_PATH' });
    const macApps = ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      path.join(env.HOME || os.homedir(), 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code')];
    return async () => (await finder.find(env)) || macApps.find(file => require('../lib/find-program').isExecutable(file)) || null;
  })();
  const runAs = () => {
    if (terminalUser !== null) return terminalUser || null;
    return require('../lib/terminal-user').resolveTerminalUser().user;
  };

  // ---- Settings ----
  const readSettings = () => {
    const rows = database().prepare('SELECT key, value FROM system_state WHERE key IN (?, ?, ?)').all(ENABLED_KEY, IDLE_KEY, LICENSE_KEY);
    const value = name => {
      const row = rows.find(entry => entry.key === name);
      try { return row ? JSON.parse(row.value) : null; } catch { return null; }
    };
    const enabled = value(ENABLED_KEY);
    const idle = value(IDLE_KEY);
    const license = value(LICENSE_KEY);
    return {
      enabled: !(enabled && enabled.enabled === false),
      idle_minutes: idle && Number.isInteger(idle.minutes) && idle.minutes >= 1 && idle.minutes <= MAX_IDLE_MINUTES ? idle.minutes : DEFAULT_IDLE_MINUTES,
      license_accepted: Boolean(license && license.accepted === true),
    };
  };
  async function setSettings(input = {}) {
    const body = input && typeof input === 'object' ? input : {};
    const hasEnabled = Object.hasOwn(body, 'enabled');
    const hasIdle = Object.hasOwn(body, 'idle_minutes');
    if ((hasEnabled && typeof body.enabled !== 'boolean')
      || (hasIdle && !(Number.isInteger(body.idle_minutes) && body.idle_minutes >= 1 && body.idle_minutes <= MAX_IDLE_MINUTES))) {
      throw fault('INVALID_VSCODE_SETTINGS');
    }
    if (hasEnabled) {
      database().prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(ENABLED_KEY, JSON.stringify({ enabled: body.enabled }));
    }
    if (hasIdle) {
      database().prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(IDLE_KEY, JSON.stringify({ minutes: body.idle_minutes }));
    }
    if (hasEnabled && body.enabled === false) await stop();
    return readSettings();
  }
  function acceptLicense() {
    database().prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(LICENSE_KEY, JSON.stringify({ accepted: true, at: new Date().toISOString() }));
    return { accepted: true };
  }

  // ---- The CLI ----
  let probeCache = null; // { at, ttl, result }
  async function probe({ force = false } = {}) {
    if (!force && probeCache && Date.now() - probeCache.at < probeCache.ttl) return probeCache.result;
    const cli = await findProgram();
    let result;
    if (!cli) result = { installed: false, error: ERRORS.NOT_INSTALLED };
    else {
      const help = await new Promise(resolve => {
        execFileImpl(cli, ['serve-web', '--help'], { env: childEnv(), timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true },
          (error, stdout, stderr) => resolve({ ok: !error, text: `${stdout || ''}\n${stderr || ''}` }));
      });
      const has = option => help.text.includes(option);
      if (!help.ok || !has('--server-base-path') || !has('--connection-token-file')) result = { installed: true, cli, error: ERRORS.UNSUPPORTED };
      else {
        result = {
          installed: true, cli,
          flags: { socketPath: has('--socket-path'), cliDataDir: has('--cli-data-dir'), serverDataDir: has('--server-data-dir'), telemetry: has('--disable-telemetry') },
        };
      }
    }
    probeCache = { at: Date.now(), ttl: result.error === ERRORS.NOT_INSTALLED ? PROBE_MISS_TTL_MS : probeTtlMs, result };
    return result;
  }

  function childEnv(user = null) {
    const base = { ...env };
    delete base.SESSION_SECRET;
    delete base.VSCODE_IPC_HOOK_CLI; // a CLI started inside another VS Code would talk to that one
    const out = user ? require('../lib/terminal-user').terminalEnvFor(user, base) : base;
    return out;
  }

  // ---- The process ----
  let state = 'stopped';
  let error = null;
  let detail = '';
  let child = null; // { proc, token, target: { socketPath } | { host, port }, files: [...], redact, output, exited }
  let lastActivity = Date.now();
  let active = 0; // open WebSockets and requests in flight
  let idleTimer = null;
  const protoByHost = new Map(); // the scheme the page server named for each public host (POST ...vscode { host, proto })
  const stopListeners = new Set();
  const sockets = new Set(); // raw upgraded sockets and WebSockets, closed on stop

  const touch = () => { lastActivity = Date.now(); };
  const onStop = callback => { stopListeners.add(callback); return () => stopListeners.delete(callback); };

  function setError(code, text) {
    state = 'error';
    error = code;
    detail = text || '';
  }

  function status() {
    const out = { state, base_path: basePath(), engine_id: instanceId() };
    if (state === 'error') Object.assign(out, { error, detail });
    return out;
  }

  // What stops a start before the process: the switch, the CLI and the license. Null when a start may go ahead.
  async function preflight() {
    const settings = readSettings();
    if (!settings.enabled) return { error: ERRORS.DISABLED };
    const cli = await probe();
    if (cli.error) return { error: cli.error };
    if (!settings.license_accepted) return { error: ERRORS.LICENSE };
    return { cli };
  }

  // The status a page reads before it starts anything: for a stopped process, what a start would answer first.
  async function check() {
    if (state !== 'stopped') return status();
    const blocked = await preflight();
    if (blocked.error) return { state: 'error', error: blocked.error, detail: '', base_path: basePath(), engine_id: instanceId() };
    return status();
  }

  // Kept by this service (not the terminal user) in the data home, also when VS Code's own folders are in the terminal user's home.
  function pidFile() { return path.join(root(), 'vscode', 'serve-web.pid'); }

  // A process left by an earlier T-Agent that ended without its exit handler (a crash, SIGKILL): ended when it is still ours.
  function endOrphan() {
    let recorded;
    try { recorded = JSON.parse(fs.readFileSync(pidFile(), 'utf8')); } catch { return; }
    try { fs.rmSync(pidFile(), { force: true }); } catch { /* gone */ }
    const pid = Number(recorded && recorded.pid);
    if (!Number.isInteger(pid) || pid <= 1 || (child && child.proc.pid === pid)) return;
    try {
      const command = require('child_process').execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
      if (command.includes('serve-web') && command.includes(recorded.marker)) process.kill(-pid, 'SIGKILL');
    } catch { /* not running, or not ours */ }
  }

  async function startProcess(cli, { host, proto }) {
    const user = runAs();
    let home = path.join(root(), 'vscode');
    if (user && !canEnterAll(home, user, require('../lib/terminal-user').userCanEnter)) {
      // The service runs as root with a data home the terminal user cannot enter (/root/.tagent): the same layout in that user's home.
      home = path.join(user.home, '.tagent', 'vscode');
      log.warn && log.warn(`[vscode] ${user.name} cannot enter the data folder; VS Code keeps its data in ${home}`);
    }
    prepareDir(home, user);
    const run = path.join(home, 'run');
    prepareDir(run, user);
    for (const name of ['server', 'cli']) prepareDir(path.join(home, name), user);
    endOrphan();
    for (const entry of fs.readdirSync(run)) if (/\.(sock|token)$/.test(entry)) { try { fs.rmSync(path.join(run, entry), { force: true }); } catch { /* in use */ } }

    const id = crypto.randomBytes(4).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenFile = path.join(run, `${id}.token`);
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    if (user) { try { fs.chownSync(tokenFile, user.uid, user.gid); } catch { /* left as it is */ } }
    const socketPath = path.join(run, `${id}.sock`);
    const useSocket = cli.flags.socketPath && socketPath.length <= SOCKET_PATH_MAX;
    const args = ['serve-web', '--accept-server-license-terms', '--connection-token-file', tokenFile, '--server-base-path', basePath()];
    if (cli.flags.serverDataDir) args.push('--server-data-dir', path.join(home, 'server'));
    if (cli.flags.cliDataDir) args.push('--cli-data-dir', path.join(home, 'cli'));
    if (cli.flags.telemetry) args.push('--disable-telemetry');
    if (useSocket) args.push('--socket-path', socketPath);
    else args.push('--host', '127.0.0.1', '--port', '0');

    const redact = redactor(token);
    const proc = spawnImpl(cli.cli, args, {
      cwd: user ? user.home : (env.HOME || os.homedir()),
      env: childEnv(user),
      detached: true, // its own process group, so stop() ends the server it starts too
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(user ? { uid: user.uid, gid: user.gid } : {}),
    });
    const current = { proc, token, target: useSocket ? { socketPath } : null, files: [tokenFile, socketPath], redact, output: '', exited: false, portWaiters: [] };
    child = current;
    try {
      fs.mkdirSync(path.dirname(pidFile()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(pidFile(), JSON.stringify({ pid: proc.pid, marker: basePath() }), { mode: 0o600 });
    } catch { /* best effort */ }
    const keep = chunk => {
      current.output = (current.output + redact(chunk.toString('utf8'))).slice(-OUTPUT_LIMIT);
    };
    proc.stderr.on('data', keep);
    proc.stdout.on('data', chunk => {
      keep(chunk);
      if (!current.target) {
        const found = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(chunk.toString('utf8'));
        if (found) {
          current.target = { host: '127.0.0.1', port: Number(found[1]) };
          current.portWaiters.splice(0).forEach(resolve => resolve());
        }
      }
    });
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      current.exited = true;
      current.portWaiters.splice(0).forEach(resolve => resolve());
      cleanupFiles(current);
      if (child !== current) return;
      child = null;
      if (state === 'starting' || state === 'ready') { // a stop or a failed start already set the state
        const text = current.output.trim() || `exited with ${signal || `code ${code}`}`;
        setError(/download|fetch|network|ENOTFOUND|getaddrinfo/i.test(text) ? ERRORS.DOWNLOAD : ERRORS.START, text);
        log.warn && log.warn(`[vscode] serve-web exited (${signal || `code ${code}`})`);
      }
      closeSockets();
      emitStop();
    };
    proc.on('exit', finish);
    // A process that could not be started at all (no such file, a uid it may not use) never exits.
    proc.on('error', err => { keep(Buffer.from(`\n${err.message}\n`)); if (proc.pid === undefined) finish(null, null); });
    log.info && log.info(`[vscode] starting serve-web (${useSocket ? 'unix socket' : 'loopback port'})`);
    await waitReady(current, { host, proto });
  }

  function cleanupFiles(current) {
    for (const file of current.files) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } }
    try {
      const recorded = JSON.parse(fs.readFileSync(pidFile(), 'utf8'));
      if (recorded.pid === current.proc.pid) fs.rmSync(pidFile(), { force: true });
    } catch { /* none */ }
  }

  function emitStop() {
    for (const callback of [...stopListeners]) { try { callback(); } catch { /* one listener must not stop the others */ } }
  }

  function closeSockets() {
    for (const socket of [...sockets]) {
      try { if (typeof socket.terminate === 'function') socket.terminate(); else socket.destroy(); } catch { /* gone */ }
    }
    sockets.clear();
  }

  // Polls GET <base>/ with the token until it answers 200; the first request can take minutes while the CLI downloads the server.
  async function waitReady(current, { host, proto }) {
    const deadline = Date.now() + readyTimeoutMs;
    while (!current.target && !current.exited && Date.now() < deadline) {
      await new Promise(resolve => { current.portWaiters.push(resolve); setTimeout(resolve, readyPollMs); });
    }
    while (!current.exited && child === current && Date.now() < deadline) {
      const code = await new Promise(resolve => {
        const req = http.request({
          ...current.target, method: 'GET', path: `${basePath()}/`, agent: false,
          headers: { cookie: `vscode-tkn=${current.token}`, 'x-forwarded-host': host || 'localhost', 'x-forwarded-proto': proto || 'http' },
        }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', () => resolve(0)); });
        req.on('error', () => resolve(0));
        req.setTimeout(Math.max(1000, deadline - Date.now()), () => req.destroy());
        req.end();
      });
      if (child !== current || current.exited) return;
      if (code === 200) {
        state = 'ready';
        error = null;
        detail = '';
        touch();
        log.info && log.info('[vscode] serve-web is ready');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, readyPollMs));
    }
    if (child === current && !current.exited) {
      const text = current.output.trim() || 'VS Code did not answer in time';
      setError(/download|fetch|network/i.test(text) ? ERRORS.DOWNLOAD : ERRORS.START, text);
      killProcess(current);
    }
  }

  function killProcess(current, signal = 'SIGTERM') {
    if (!current || current.exited || current.proc.pid === undefined) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      current.proc.once('exit', done);
      const kill = sig => { try { process.kill(-current.proc.pid, sig); } catch { try { current.proc.kill(sig); } catch { /* gone */ } } };
      kill(signal);
      const timer = setTimeout(() => kill('SIGKILL'), killGraceMs);
      if (timer.unref) timer.unref();
    });
  }

  // Starts VS Code when it is not running and answers the status at once (the page polls status()). `host` / `proto`: the page server's public
  // host as the browser sees it, remembered for X-Forwarded-Proto. What stops a start (the switch, the CLI, the license) is answered as an error
  // without changing the state, so the next call checks again.
  let preflighting = null;
  async function ensure({ host, proto } = {}) {
    if (!validHost(host) || !validProto(proto)) throw fault('INVALID_VSCODE_HOST');
    protoByHost.set(host.toLowerCase(), proto);
    if (protoByHost.size > 32) protoByHost.delete(protoByHost.keys().next().value);
    touch();
    if (state === 'ready' || state === 'starting') return status();
    if (!preflighting) {
      preflighting = (async () => {
        try {
          const blocked = await preflight();
          if (state === 'ready' || state === 'starting') return null;
          if (blocked.error) return blocked.error;
          state = 'starting';
          error = null;
          detail = '';
          startIdleTimer();
          startProcess(blocked.cli, { host, proto }).catch(err => {
            if (state === 'starting') setError(ERRORS.START, redactor(child && child.token)(err.message));
            if (child) killProcess(child);
          });
          return null;
        } finally {
          preflighting = null;
        }
      })();
    }
    const blockedBy = await preflighting;
    if (blockedBy) return { state: 'error', error: blockedBy, detail: '', base_path: basePath(), engine_id: instanceId() };
    return status();
  }

  async function stop() {
    const current = child;
    state = 'stopped';
    error = null;
    detail = '';
    stopIdleTimer();
    if (current) {
      log.info && log.info('[vscode] stopping serve-web');
      await killProcess(current);
    }
    return { state: 'stopped' };
  }

  // Synchronous, for process.on('exit'): ends the process group at once.
  function shutdown() {
    stopIdleTimer();
    const current = child;
    state = 'stopped';
    if (!current || current.exited) return;
    try { process.kill(-current.proc.pid, 'SIGKILL'); } catch { try { current.proc.kill('SIGKILL'); } catch { /* gone */ } }
    cleanupFiles(current);
  }

  function startIdleTimer() {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (state !== 'ready' || active > 0) return;
      const limit = idleMs !== null ? idleMs : readSettings().idle_minutes * 60_000;
      if (Date.now() - lastActivity >= limit) {
        log.info && log.info('[vscode] stopping serve-web after the idle time');
        stop();
      }
    }, idleCheckMs);
    if (idleTimer.unref) idleTimer.unref();
  }
  function stopIdleTimer() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  }

  // Where the process listens, without the token (diagnostics and tests). Null while not running.
  function socketTarget() {
    return child && child.target ? { ...child.target } : null;
  }

  function running() {
    if (state !== 'ready' || !child || !child.target) throw fault(ERRORS.NOT_RUNNING, 503);
    return child;
  }

  function checkPath(target) {
    const value = String(target || '');
    const question = value.indexOf('?');
    const pathname = question < 0 ? value : value.slice(0, question);
    const base = basePath();
    if (pathname !== base && !pathname.startsWith(`${base}/`)) throw fault('VSCODE_PATH_INVALID', 404);
    if (/[\x00-\x20\x7f\\#]/.test(value)) throw fault('VSCODE_PATH_INVALID', 404);
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw fault('VSCODE_PATH_INVALID', 404); }
    if (decoded.split('/').some(part => part === '.' || part === '..')) throw fault('VSCODE_PATH_INVALID', 404);
    return pathname === base ? `${base}/${question < 0 ? '' : value.slice(question)}` : value;
  }

  function forwardHeaders(current, headers, host, names) {
    const publicHost = validHost(host) ? host : 'localhost';
    const proto = protoByHost.get(publicHost.toLowerCase()) || 'https';
    return {
      ...pick(headers, names),
      cookie: `vscode-tkn=${current.token}`,
      'x-forwarded-host': publicHost,
      'x-forwarded-proto': proto,
      origin: `${proto}://${publicHost}`,
    };
  }

  // One HTTP request to VS Code, shaped like http.request: `path` is the full browser path (`/vscode/<engine id>/...` with its query), `headers`
  // the incoming request's headers (filtered here), `host` the public host. onResponse gets the response with its headers already filtered.
  // Throws VSCODE_NOT_RUNNING (503) when VS Code is not ready and VSCODE_PATH_INVALID (404) for a path outside the base path.
  function request({ method = 'GET', path: target, headers = {}, host } = {}, onResponse) {
    const current = running();
    const pathWithQuery = checkPath(target);
    const outgoing = forwardHeaders(current, headers, host, REQUEST_HEADERS);
    if (method !== 'GET' && method !== 'HEAD' && !outgoing['content-length'] && headers['transfer-encoding']) outgoing['transfer-encoding'] = 'chunked';
    active += 1;
    touch();
    let released = false;
    const release = () => { if (!released) { released = true; active -= 1; touch(); } };
    const req = http.request({ ...current.target, method, path: pathWithQuery, headers: outgoing, agent: false }, res => {
      const filtered = filterResponseHeaders(res.headers);
      res.headers = filtered;
      res.rawHeaders = Object.entries(filtered).flatMap(([name, value]) => (Array.isArray(value) ? value.flatMap(item => [name, item]) : [name, String(value)]));
      res.on('data', touch);
      res.on('close', release);
      res.on('end', release);
      if (onResponse) onResponse(res);
    });
    req.on('error', release);
    req.on('close', () => { if (!req.res) release(); });
    return req;
  }

  // A WebSocket upgrade, passed through as raw bytes: `req`, `socket` and `head` of the server's 'upgrade' event (the engine's, or the page
  // server's for a local engine after its own check), `path` the full browser path. Answers 503 / 404 itself when it cannot go ahead.
  function upgrade(req, socket, head, { path: target, host } = {}) {
    const refuse = (status, text) => {
      if (!socket.destroyed) { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); }
    };
    let current;
    let pathWithQuery;
    try { current = running(); pathWithQuery = checkPath(target); } catch (err) { return refuse(err.statusCode === 404 ? 404 : 503, err.statusCode === 404 ? 'Not Found' : 'Service Unavailable'); }
    const outgoing = { ...forwardHeaders(current, req.headers, host, UPGRADE_HEADERS), connection: 'Upgrade', upgrade: 'websocket' };
    const upstream = http.request({ ...current.target, method: 'GET', path: pathWithQuery, headers: outgoing, agent: false });
    upstream.on('upgrade', (res, upSocket, upHead) => {
      if (socket.destroyed) { upSocket.destroy(); return; }
      const lines = [`HTTP/1.1 101 ${res.statusMessage || 'Switching Protocols'}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const lower = res.rawHeaders[i].toLowerCase();
        if (lower === 'set-cookie' || lower === 'service-worker-allowed') continue;
        if (/[\r\n]/.test(res.rawHeaders[i + 1])) continue;
        lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      active += 1;
      touch();
      sockets.add(socket);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        active -= 1;
        sockets.delete(socket);
        touch();
        socket.destroy();
        upSocket.destroy();
      };
      socket.on('data', touch);
      upSocket.on('data', touch);
      socket.on('error', close);
      upSocket.on('error', close);
      socket.on('close', close);
      upSocket.on('close', close);
      socket.pipe(upSocket);
      upSocket.pipe(socket);
    });
    upstream.on('response', res => {
      res.resume();
      refuse(res.statusCode || 502, 'Upgrade Refused');
    });
    upstream.on('error', () => refuse(502, 'Bad Gateway'));
    socket.on('error', () => upstream.destroy());
    upstream.end();
    return undefined;
  }

  // A WebSocket client to VS Code (the `ws` package), for a transport that relays messages instead of bytes. `headers`: the browser's upgrade
  // headers (only sec-websocket-protocol and the like are kept). Throws like request().
  function openWebSocket({ path: target, headers = {}, host, ...options } = {}) {
    const WebSocket = require('ws');
    const current = running();
    const pathWithQuery = checkPath(target);
    const outgoing = forwardHeaders(current, headers, host, ['user-agent', 'accept-language']);
    const protocols = String(headers['sec-websocket-protocol'] || '').split(',').map(item => item.trim()).filter(Boolean);
    const url = current.target.socketPath ? `ws+unix://${current.target.socketPath}:${pathWithQuery}` : `ws://127.0.0.1:${current.target.port}${pathWithQuery}`;
    const ws = new WebSocket(url, protocols, { perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10_000, ...options, headers: outgoing });
    active += 1;
    touch();
    sockets.add(ws);
    ws.on('message', touch);
    ws.once('close', () => { active -= 1; sockets.delete(ws); touch(); });
    ws.on('error', () => {});
    return ws;
  }

  return {
    CAPABILITY, ERRORS,
    probe, check, ensure, status, stop, shutdown, socketTarget, touch, onStop,
    request, upgrade, openWebSocket,
    settings: readSettings, setSettings, acceptLicense,
    basePath, validHost, validProto,
  };
}

let shared = null;
function getVscodeWeb() {
  if (!shared) shared = createVscodeWeb();
  return shared;
}
// For process.on('exit') in server.js: does nothing when VS Code was never used.
function shutdownShared() {
  if (shared) shared.shutdown();
}

module.exports = {
  CAPABILITY, ERRORS, ENABLED_KEY, IDLE_KEY, LICENSE_KEY, DEFAULT_IDLE_MINUTES, HOST_PATTERN,
  createVscodeWeb, getVscodeWeb, shutdownShared, cleanLocation, filterResponseHeaders, redactor,
};
