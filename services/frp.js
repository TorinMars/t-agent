const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { candidateBinDirs } = require('./pm2-manager');
const os = require('node:os');
const { decryptToken, encryptToken } = require('../lib/token-crypto');
const { installFrpc, platformTarget, FrpInstallError, FRP_VERSION } = require('./frp-install');

const STATE_KEY = 'frp_config';
const DEFAULT_PORT_MIN = 20000;
const DEFAULT_PORT_MAX = 60000;
const MAX_LOG_LINES = 200;
// If frpc exits with "port in use" within this time after starting, treat it as a random-port collision and retry with another port.
const PORT_RETRY_WINDOW_MS = 15_000;
const MAX_PORT_RETRIES = 3;
const PORT_CONFLICT = /port already used|port not allowed|port unavailable/i;
// TOML configuration is supported from frp 0.52.
const MIN_FRPC = [0, 52, 0];
const START_OK = /start proxy success/i;
const LOGIN_FAILED = /login to server failed|token in login doesn't match|authorization failed/i;

class FrpError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const isPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;

function parsePort(value, code, label) {
  const port = typeof value === 'string' && /^\d{1,5}$/.test(value.trim()) ? Number(value) : value;
  if (!isPort(port)) throw new FrpError(code, `${label} must be an integer between 1 and 65535`);
  return port;
}

function cleanText(value, code, label, { max = 253 } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new FrpError(code, `${label} has an invalid format`);
  const text = value.trim();
  if (text.length > max || /[\u0000-\u001f\u007f\s"'\\]/.test(text)) throw new FrpError(code, `${label} has an invalid format`);
  return text;
}

function randomPort(min, max, random = crypto.randomInt) {
  return random(min, max + 1);
}

function emptyConfig() {
  return {
    serverAddr: '', serverPort: 7000, tokenCipher: '', domain: '', localPort: 0,
    remotePort: 0, remotePortManual: false, portMin: DEFAULT_PORT_MIN, portMax: DEFAULT_PORT_MAX, autoStart: false,
  };
}

// frpc TOML configuration: strings are escaped as JSON (also valid for TOML basic strings).
function renderToml({ serverAddr, serverPort, token, proxyName, localIP, localPort, remotePort }) {
  const lines = [
    `serverAddr = ${JSON.stringify(serverAddr)}`,
    `serverPort = ${serverPort}`,
  ];
  if (token) lines.push('auth.method = "token"', `auth.token = ${JSON.stringify(token)}`);
  lines.push('', '[[proxies]]', `name = ${JSON.stringify(proxyName)}`, 'type = "tcp"',
    `localIP = ${JSON.stringify(localIP)}`, `localPort = ${localPort}`, `remotePort = ${remotePort}`, '');
  return lines.join('\n');
}

// Homebrew's frpc is sometimes not linked into PATH (or the service starts with a slim PATH), so look directly at the real locations under opt/ and Cellar/.
function homebrewDirs(env = process.env) {
  const prefixes = [...new Set([env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew', path.join(os.homedir(), '.linuxbrew')].filter(Boolean))];
  const dirs = [];
  for (const prefix of prefixes) {
    dirs.push(path.join(prefix, 'bin'));
    for (const formula of ['frpc', 'frp']) {
      dirs.push(path.join(prefix, 'opt', formula, 'bin'));
      try {
        const versions = fs.readdirSync(path.join(prefix, 'Cellar', formula)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions) dirs.push(path.join(prefix, 'Cellar', formula, version, 'bin'));
      } catch { /* this formula is not installed */ }
    }
  }
  return dirs;
}

function findFrpc(options = {}) {
  if (options.bin) return options.bin;
  if (process.env.T_AGENT_FRPC_BIN) return process.env.T_AGENT_FRPC_BIN;
  for (const dir of options.dirs || [...candidateBinDirs(), ...homebrewDirs()]) {
    const candidate = path.join(dir, 'frpc');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

const versionAtLeast = (version, min) => {
  for (let i = 0; i < 3; i += 1) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
};

// Run frpc --version (with a timeout). Returns { version, supported, error }.
function probeFrpc(file) {
  try {
    const output = execFileSync(file, ['--version'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
    if (!match) return { version: '', supported: true, error: 'Cannot determine the frpc version' };
    const parts = match.slice(1).map(Number);
    return { version: parts.join('.'), supported: versionAtLeast(parts, MIN_FRPC), error: '' };
  } catch {
    return { version: '', supported: true, error: 'frpc was found but cannot be run (it may be corrupted or not fully linked)' };
  }
}

function createFrpService({
  db, secret, dataDir, localPort, localHost = '127.0.0.1',
  bin, spawnProcess = spawn, random = crypto.randomInt, now = Date.now, installer = installFrpc,
}) {
  const binDir = path.join(dataDir, 'bin');
  const locate = () => bin || findFrpc({ dirs: [binDir, ...candidateBinDirs(), ...homebrewDirs()] });
  const probes = new Map();
  // Cache the --version result by path + modification time; "re-detect" clears the cache.
  function probe(file) {
    if (!file) return { version: '', supported: true, error: '' };
    let key = file;
    try { key = `${file}:${fs.statSync(file).mtimeMs}`; } catch { return { version: '', supported: true, error: 'frpc was found but cannot be run (it may be corrupted or not fully linked)' }; }
    if (!probes.has(key)) probes.set(key, probeFrpc(file));
    return probes.get(key);
  }
  let installing = false;
  let installError = '';
  const configFile = path.join(dataDir, 'frpc.toml');
  let child = null;
  let status = 'stopped'; // stopped | starting | running | failed
  let failure = '';
  let logs = [];
  let startedAt = null;
  let retries = 0;
  let stopping = false;

  const defaultLocalPort = localPort;
  const localIP = !localHost || localHost === '0.0.0.0' || localHost === '::' ? '127.0.0.1' : localHost;

  function load() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    if (!row) return emptyConfig();
    try { return { ...emptyConfig(), ...JSON.parse(row.value) }; } catch { return emptyConfig(); }
  }
  function save(config) {
    db.prepare(`INSERT INTO system_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify(config));
  }
  const effectiveLocalPort = config => config.localPort || defaultLocalPort;

  function publicConfig(config) {
    const host = config.domain || config.serverAddr;
    return {
      serverAddr: config.serverAddr,
      serverPort: config.serverPort,
      hasToken: Boolean(config.tokenCipher),
      domain: config.domain,
      localPort: config.localPort,
      effectiveLocalPort: effectiveLocalPort(config),
      remotePort: config.remotePort,
      remotePortManual: Boolean(config.remotePortManual),
      portMin: config.portMin,
      portMax: config.portMax,
      autoStart: config.autoStart,
      // frp's tcp tunnel is raw TCP: the domain must be resolved to the frps IP by the user, and HTTPS is terminated by the reverse proxy in front.
      publicAddress: host && config.remotePort ? `${host}:${config.remotePort}` : '',
    };
  }

  function view() {
    const frpc = locate();
    const info = probe(frpc);
    return {
      installed: Boolean(frpc),
      frpc: frpc ? { path: frpc, version: info.version, supported: info.supported, error: info.error } : null,
      installing,
      installError,
      status,
      error: failure,
      startedAt,
      logs: logs.slice(),
      config: publicConfig(load()),
      // Used by the page when it builds the "ask an Agent to install frpc / frps" prompts.
      install: { binDir, version: FRP_VERSION, target: platformTarget() },
    };
  }

  function pushLog(text) {
    for (const line of String(text).split(/\r?\n/)) {
      const clean = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
      if (clean) logs.push(clean);
    }
    if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
  }

  function update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FrpError('FRP_BODY_INVALID', 'Invalid request');
    const config = load();
    const next = { ...config };
    if ('serverAddr' in input) {
      const addr = cleanText(input.serverAddr, 'FRP_SERVER_ADDR_INVALID', 'Server address');
      if (addr && !net.isIP(addr) && !HOSTNAME.test(addr)) throw new FrpError('FRP_SERVER_ADDR_INVALID', 'The server address must be an IP or domain');
      next.serverAddr = addr;
    }
    if ('serverPort' in input) next.serverPort = parsePort(input.serverPort, 'FRP_SERVER_PORT_INVALID', 'Server port');
    if ('domain' in input) {
      const domain = cleanText(input.domain, 'FRP_DOMAIN_INVALID', 'Domain').toLowerCase();
      if (domain && (!HOSTNAME.test(domain) || net.isIP(domain))) throw new FrpError('FRP_DOMAIN_INVALID', 'Invalid domain format, e.g. app.example.com');
      next.domain = domain;
    }
    if ('localPort' in input) {
      const raw = input.localPort;
      next.localPort = raw === '' || raw === null || raw === 0 ? 0 : parsePort(raw, 'FRP_LOCAL_PORT_INVALID', 'Local port');
    }
    // token undefined means leave unchanged; empty string means clear.
    if (typeof input.token === 'string') {
      if (/[\u0000-\u001f\u007f]/.test(input.token) || input.token.length > 256) throw new FrpError('FRP_TOKEN_INVALID', 'Token contains disallowed characters');
      next.tokenCipher = input.token ? encryptToken(input.token, secret) : '';
    }
    if ('portMin' in input) next.portMin = parsePort(input.portMin, 'FRP_PORT_RANGE_INVALID', 'Random port range');
    if ('portMax' in input) next.portMax = parsePort(input.portMax, 'FRP_PORT_RANGE_INVALID', 'Random port range');
    if (next.portMin > next.portMax) throw new FrpError('FRP_PORT_RANGE_INVALID', 'The start of the random port range cannot be greater than the end');
    if ('autoStart' in input) next.autoStart = Boolean(input.autoStart);
    // Once a remote port is entered manually it is used as-is (it may be outside the random range); leave it empty or 0 to return to automatic random.
    if ('remotePort' in input) {
      const raw = input.remotePort;
      if (raw === '' || raw === null || raw === 0) { next.remotePortManual = false; next.remotePort = 0; }
      else { next.remotePort = parsePort(raw, 'FRP_REMOTE_PORT_INVALID', 'Remote port'); next.remotePortManual = true; }
    }
    // In automatic mode the remote port is generated randomly once, only when none exists or it falls outside the range, and then stays stable (the domain's reverse proxy must point at it).
    if (!next.remotePort || (!next.remotePortManual && (next.remotePort < next.portMin || next.remotePort > next.portMax))) {
      next.remotePort = randomPort(next.portMin, next.portMax, random);
    }
    save(next);
    return view();
  }

  function regeneratePort() {
    const config = load();
    config.remotePort = randomPort(config.portMin, config.portMax, random);
    config.remotePortManual = false;
    save(config);
    return config.remotePort;
  }

  function writeConfig(config) {
    fs.mkdirSync(dataDir, { recursive: true });
    const token = config.tokenCipher ? decryptToken(config.tokenCipher, secret) : '';
    const body = renderToml({
      serverAddr: config.serverAddr, serverPort: config.serverPort, token,
      proxyName: `t-agent-${crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8)}`,
      localIP, localPort: effectiveLocalPort(config), remotePort: config.remotePort,
    });
    // Contains the token: readable only by the current user, and the file is created before writing to avoid a brief window of wide permissions.
    fs.closeSync(fs.openSync(configFile, 'w', 0o600));
    fs.chmodSync(configFile, 0o600);
    fs.writeFileSync(configFile, body);
  }

  function launch() {
    const frpc = locate();
    if (frpc && !probe(frpc).supported) throw new FrpError('FRP_VERSION_UNSUPPORTED', `frpc ${probe(frpc).version} is too old; 0.52 or later is required (TOML configuration support). Please upgrade, for example brew upgrade frpc`, 412);
    if (!frpc) throw new FrpError('FRP_NOT_INSTALLED', 'frpc not found: click “Install frpc”, or install frp manually and set its path with T_AGENT_FRPC_BIN', 412);
    const config = load();
    if (!config.serverAddr) throw new FrpError('FRP_SERVER_REQUIRED', 'Enter the server IP or domain first', 412);
    writeConfig(config);
    const spawnedAt = now();
    status = 'starting';
    failure = '';
    startedAt = null;
    stopping = false;
    let proc;
    try {
      proc = spawnProcess(frpc, ['-c', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      status = 'failed';
      failure = 'Cannot start frpc';
      throw new FrpError('FRP_START_FAILED', failure, 500);
    }
    child = proc;
    const onOutput = chunk => {
      const text = String(chunk);
      pushLog(text);
      if (START_OK.test(text) && child === proc) { status = 'running'; startedAt = now(); retries = 0; }
      if (LOGIN_FAILED.test(text)) failure = 'Logging in to frps failed; check the server address, port and token';
    };
    proc.stdout && proc.stdout.on('data', onOutput);
    proc.stderr && proc.stderr.on('data', onOutput);
    proc.on('error', error => {
      if (child !== proc) return;
      child = null;
      status = 'failed';
      failure = `Cannot start frpc: ${error.code || error.message}`;
    });
    proc.on('exit', code => {
      if (child !== proc) return;
      child = null;
      if (stopping) { status = 'stopped'; return; }
      const tail = logs.slice(-10).join('\n');
      if (PORT_CONFLICT.test(tail) && !load().remotePortManual && now() - spawnedAt < PORT_RETRY_WINDOW_MS && retries < MAX_PORT_RETRIES) {
        retries += 1;
        const port = regeneratePort();
        pushLog(`[t-agent] remote port in use; retrying with ${port} (${retries}/${MAX_PORT_RETRIES})`);
        try { launch(); return; } catch (error) { failure = error.message; }
      }
      status = 'failed';
      failure = failure || (PORT_CONFLICT.test(tail) ? (load().remotePortManual ? 'The remote port is in use or not allowed by frps; choose another port' : 'The remote port is in use; regenerate the port') : `frpc exited (code ${code})`);
    });
  }

  function start() {
    if (child) throw new FrpError('FRP_ALREADY_RUNNING', 'The tunnel is already running', 409);
    retries = 0;
    logs = [];
    launch();
    return view();
  }

  function stop() {
    if (child) {
      stopping = true;
      const proc = child;
      try { proc.kill('SIGTERM'); } catch { /* already exited */ }
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already exited */ } }, 3000);
      if (timer.unref) timer.unref();
      child = null;
    }
    status = 'stopped';
    failure = '';
    startedAt = null;
    return view();
  }

  // A changed random port takes effect only after a restart.
  function regenerate() {
    const wasRunning = Boolean(child);
    if (wasRunning) stop();
    regeneratePort();
    if (wasRunning) { retries = 0; launch(); }
    return view();
  }

  // Download frpc to <dataDir>/bin. Runs asynchronously; the page polls view().installing / installError for the result.
  function install() {
    if (installing) throw new FrpError('FRP_INSTALL_RUNNING', 'Installing frpc', 409);
    if (locate()) throw new FrpError('FRP_ALREADY_INSTALLED', 'frpc is already installed', 409);
    installing = true;
    installError = '';
    installer({ binDir }).catch(error => {
      installError = error instanceof FrpInstallError ? error.message : 'Failed to install frpc';
      if (!(error instanceof FrpInstallError)) console.warn('[frp] install failed:', error && error.message);
    }).finally(() => { installing = false; });
    return view();
  }

  // Rescan where frpc is and re-read its version (after the user installs frpc outside the page and clicks "Re-detect").
  function detect() {
    probes.clear();
    return view();
  }

  function autoStart() {
    const config = load();
    if (!config.autoStart || !config.serverAddr || !locate()) return;
    try { launch(); } catch (error) { console.warn('[frp] auto start failed:', error.message); }
  }

  return { view, update, start, stop, regenerate, install, detect, autoStart, load };
}

module.exports = { createFrpService, FrpError, HOSTNAME, parsePort, cleanText, renderToml, findFrpc, homebrewDirs, probeFrpc, randomPort, DEFAULT_PORT_MIN, DEFAULT_PORT_MAX };
