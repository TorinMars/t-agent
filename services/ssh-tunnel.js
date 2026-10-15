const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { candidateBinDirs } = require('./pm2-manager');
const { FrpError, HOSTNAME, parsePort, cleanText } = require('./frp');

const STATE_KEY = 'ssh_tunnel_config';
const PORT_MIN = 20000;
const PORT_MAX = 60000;
const MAX_LOG_LINES = 200;
const MAX_PORT_RETRIES = 3;
const PORT_RETRY_WINDOW_MS = 15_000;
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECTS = 5;
// ssh -v output is noisy; keep only the lines related to connection, authentication and port forwarding.
const KEEP_LINE = /remote forward|Authenticated|Permission denied|Warning|error|failed|refused|timed out|resolve hostname|Identity file|Host key|closed|disconnect|bind|forwarding/i;
// A harmless ssh -v message: the note printed when the FIDO security key provider variable is not set; it looks like an error but is not.
const NOISE = /SSH_SK_PROVIDER|Authenticator provider/i;
const FORWARD_OK = /remote forward success/i;
const FORWARD_FAILED = /remote port forwarding failed|forwarding failed for listen port|Error: remote port forwarding failed/i;

function emptyConfig() {
  return { host: '', sshPort: 22, username: '', keyPath: '', remotePort: 0, remotePortManual: false, bindAll: false, autoStart: false };
}

function expandHome(file) {
  return file === '~' ? os.homedir() : file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
}

function findSsh() {
  if (process.env.T_AGENT_SSH_BIN) return process.env.T_AGENT_SSH_BIN;
  for (const dir of [...candidateBinDirs(), '/usr/bin']) {
    const candidate = path.join(dir, 'ssh');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

// Start ssh with an argument array only (no shell). BatchMode guarantees it never hangs on a password prompt; when the private key is empty ssh's default lookup is used entirely.
// Connection multiplexing must be off: the user's ~/.ssh/config often has ControlMaster auto / ControlPersist, and ssh would hand the forward request to an existing shared connection and exit right away
// (exit code 0, the tunnel is then not owned by this process), so the page would show a failure and the stop button could not close that forward either.
function buildArgs(config, { localIP, localPort }) {
  const bind = config.bindAll ? '0.0.0.0:' : '';
  const args = [
    '-N', '-T', '-v',
    '-o', 'BatchMode=yes',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'ControlPersist=no',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(config.sshPort),
  ];
  if (config.keyPath) args.push('-i', expandHome(config.keyPath), '-o', 'IdentitiesOnly=yes');
  args.push('-R', `${bind}${config.remotePort}:${localIP}:${localPort}`, `${config.username}@${config.host}`);
  return args;
}

function explain(line) {
  if (/Permission denied/i.test(line)) return 'Authentication failed: check the username, the private key, and whether the server accepts that key (passwordless login is required)';
  if (/Could not resolve hostname/i.test(line)) return 'Cannot resolve the server address';
  if (/Connection refused/i.test(line)) return 'SSH connection refused: check the server address and SSH port';
  if (/timed out/i.test(line)) return 'Connecting to the server timed out';
  if (/Identity file .* not accessible|no such identity|Load key .*(No such file|invalid format|bad permissions)/i.test(line)) return 'The private key file is unusable: check the path, format and permissions (should be 600)';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(line)) return 'The server host key does not match the one recorded in known_hosts; connection refused';
  return '';
}

function createSshTunnelService({
  db, localPort, localHost = '127.0.0.1', ssh, spawnProcess = spawn,
  random = crypto.randomInt, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const localIP = !localHost || localHost === '0.0.0.0' || localHost === '::' ? '127.0.0.1' : localHost;
  const locate = () => ssh || findSsh();
  let child = null;
  let status = 'stopped'; // stopped | starting | running | failed
  let failure = '';
  let logs = [];
  let startedAt = null;
  let portRetries = 0;
  let reconnects = 0;
  let stopping = false;
  let reconnectTimer = null;

  function load() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    if (!row) return emptyConfig();
    try { return { ...emptyConfig(), ...JSON.parse(row.value) }; } catch { return emptyConfig(); }
  }
  function save(config) {
    db.prepare(`INSERT INTO system_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify(config));
  }
  const randomPort = () => random(PORT_MIN, PORT_MAX + 1);

  function view() {
    const config = load();
    return {
      installed: Boolean(locate()),
      status,
      error: failure,
      startedAt,
      logs: logs.slice(),
      config: {
        host: config.host, sshPort: config.sshPort, username: config.username, keyPath: config.keyPath,
        remotePort: config.remotePort, remotePortManual: Boolean(config.remotePortManual),
        bindAll: Boolean(config.bindAll), autoStart: Boolean(config.autoStart), effectiveLocalPort: localPort,
        // By default only bind 127.0.0.1 on the server and let a reverse proxy there forward; ticking "bind all interfaces" also needs GatewayPorts enabled in sshd.
        serverAddress: config.remotePort ? `${config.bindAll ? '0.0.0.0' : '127.0.0.1'}:${config.remotePort}` : '',
      },
    };
  }

  function update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FrpError('SSH_BODY_INVALID', 'Invalid request');
    const next = { ...load() };
    if ('host' in input) {
      const host = cleanText(input.host, 'SSH_HOST_INVALID', 'Server address');
      if (host && !net.isIP(host) && !HOSTNAME.test(host)) throw new FrpError('SSH_HOST_INVALID', 'The server address must be an IP or domain');
      next.host = host;
    }
    if ('sshPort' in input) next.sshPort = parsePort(input.sshPort, 'SSH_PORT_INVALID', 'SSH port');
    if ('username' in input) {
      const username = cleanText(input.username, 'SSH_USER_INVALID', 'Username', { max: 64 });
      if (username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(username)) throw new FrpError('SSH_USER_INVALID', 'Invalid username format');
      next.username = username;
    }
    if ('keyPath' in input) {
      const raw = input.keyPath === null || input.keyPath === undefined ? '' : input.keyPath;
      if (typeof raw !== 'string' || raw.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw)) throw new FrpError('SSH_KEY_INVALID', 'Invalid private key path format');
      const keyPath = raw.trim();
      if (keyPath && !(path.isAbsolute(keyPath) || keyPath === '~' || keyPath.startsWith('~/'))) throw new FrpError('SSH_KEY_INVALID', 'The private key path must be absolute or start with ~/');
      next.keyPath = keyPath;
    }
    if ('remotePort' in input) {
      const raw = input.remotePort;
      if (raw === '' || raw === null || raw === 0) { next.remotePortManual = false; next.remotePort = 0; }
      else { next.remotePort = parsePort(raw, 'SSH_REMOTE_PORT_INVALID', 'Remote port'); next.remotePortManual = true; }
    }
    if ('bindAll' in input) next.bindAll = Boolean(input.bindAll);
    if ('autoStart' in input) next.autoStart = Boolean(input.autoStart);
    if (!next.remotePort) next.remotePort = randomPort();
    save(next);
    return view();
  }

  function regeneratePort() {
    const config = load();
    config.remotePort = randomPort();
    config.remotePortManual = false;
    save(config);
    return config.remotePort;
  }

  function pushLog(text) {
    for (const line of String(text).split(/\r?\n/)) {
      const clean = line.replace(/^debug\d:\s*/, '').trim();
      if (clean && KEEP_LINE.test(clean) && !NOISE.test(clean)) logs.push(clean);
    }
    if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
  }

  function launch() {
    const bin = locate();
    if (!bin) throw new FrpError('SSH_NOT_INSTALLED', 'ssh command not found: install the OpenSSH client, or set its path with T_AGENT_SSH_BIN', 412);
    const config = load();
    if (!config.host) throw new FrpError('SSH_HOST_REQUIRED', 'Enter the server IP or domain first', 412);
    if (!config.username) throw new FrpError('SSH_USER_REQUIRED', 'Enter a username first', 412);
    if (config.keyPath) {
      let isFile = false;
      try { isFile = fs.statSync(expandHome(config.keyPath)).isFile(); } catch { /* does not exist */ }
      if (!isFile) throw new FrpError('SSH_KEY_NOT_FOUND', 'Private key file not found. Check the path; leave empty to use ssh defaults', 412);
    }
    const spawnedAt = now();
    status = 'starting';
    failure = '';
    startedAt = null;
    stopping = false;
    let proc;
    try {
      proc = spawnProcess(bin, buildArgs(config, { localIP, localPort }), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      status = 'failed';
      failure = 'Cannot start ssh';
      throw new FrpError('SSH_START_FAILED', failure, 500);
    }
    child = proc;
    let reachedRunning = false;
    const onOutput = chunk => {
      const text = String(chunk);
      pushLog(text);
      for (const line of text.split(/\r?\n/)) {
        const reason = explain(line);
        if (reason && !failure) failure = reason;
      }
      if (FORWARD_OK.test(text) && child === proc) {
        status = 'running'; startedAt = now(); portRetries = 0; reconnects = 0; reachedRunning = true; failure = '';
      }
    };
    proc.stdout && proc.stdout.on('data', onOutput);
    proc.stderr && proc.stderr.on('data', onOutput);
    proc.on('error', error => {
      if (child !== proc) return;
      child = null;
      status = 'failed';
      failure = `Cannot start ssh: ${error.code || error.message}`;
    });
    proc.on('exit', code => {
      if (child !== proc) return;
      child = null;
      if (stopping) { status = 'stopped'; return; }
      const tail = logs.slice(-10).join('\n');
      if (FORWARD_FAILED.test(tail)) {
        if (!load().remotePortManual && now() - spawnedAt < PORT_RETRY_WINDOW_MS && portRetries < MAX_PORT_RETRIES) {
          portRetries += 1;
          const port = regeneratePort();
          pushLog(`remote port busy: retrying with ${port} (${portRetries}/${MAX_PORT_RETRIES})`);
          try { launch(); return; } catch (error) { failure = error.message; }
        }
        failure = load().remotePortManual ? 'The remote port on the server is in use, or sshd does not allow binding it; choose another port' : 'The remote port on the server is in use; regenerate the port';
      }
      // A tunnel that had connected dropped unexpectedly (network blip, server restart): reconnect automatically later.
      if (reachedRunning && reconnects < MAX_RECONNECTS) {
        reconnects += 1;
        status = 'starting';
        failure = '';
        pushLog(`connection closed: reconnecting in ${RECONNECT_DELAY_MS / 1000} s (${reconnects}/${MAX_RECONNECTS})`);
        reconnectTimer = setTimer(() => {
          reconnectTimer = null;
          if (stopping || child) return;
          try { launch(); } catch (error) { status = 'failed'; failure = error.message; }
        }, RECONNECT_DELAY_MS);
        if (reconnectTimer && reconnectTimer.unref) reconnectTimer.unref();
        return;
      }
      status = 'failed';
      failure = failure || `ssh exited (code ${code})`;
    });
  }

  function start() {
    if (child || reconnectTimer) throw new FrpError('SSH_ALREADY_RUNNING', 'The tunnel is already running', 409);
    portRetries = 0;
    reconnects = 0;
    logs = [];
    launch();
    return view();
  }

  function stop() {
    stopping = true;
    if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
    if (child) {
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

  function regenerate() {
    const wasActive = Boolean(child || reconnectTimer);
    if (wasActive) stop();
    regeneratePort();
    if (wasActive) { portRetries = 0; reconnects = 0; launch(); }
    return view();
  }

  function autoStart() {
    const config = load();
    if (!config.autoStart || !config.host || !config.username || !locate()) return;
    try { launch(); } catch (error) { console.warn('[ssh-tunnel] auto start failed:', error.message); }
  }

  return { view, update, start, stop, regenerate, autoStart, load };
}

module.exports = { createSshTunnelService, buildArgs, findSsh, expandHome };
