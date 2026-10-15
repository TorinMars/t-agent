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
// ssh -v 的输出很吵，只保留和连接、认证、端口转发有关的行。
const KEEP_LINE = /remote forward|Authenticated|Permission denied|Warning|error|failed|refused|timed out|resolve hostname|Identity file|Host key|closed|disconnect|bind|forwarding/i;
// ssh -v 的无害提示：没设置 FIDO 安全密钥的 provider 环境变量时的说明，看起来像错误但不是。
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
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* 继续找 */ }
  }
  return null;
}

// 只用参数数组启动 ssh（不经 shell）。BatchMode 保证不会卡在密码提示上；私钥留空时完全交给 ssh 的默认逻辑。
// 连接复用必须关掉：用户的 ~/.ssh/config 常有 ControlMaster auto / ControlPersist，ssh 会把转发请求交给已有的共享连接后立刻退出
// （退出码 0，隧道其实不归本进程管），页面就会显示失败，而且停止按钮也关不掉那条转发。
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
  if (/Permission denied/i.test(line)) return '认证失败：请检查用户名、私钥，以及服务器是否允许该私钥登录（需要免密登录）';
  if (/Could not resolve hostname/i.test(line)) return '无法解析服务器地址';
  if (/Connection refused/i.test(line)) return 'SSH 连接被拒绝：请检查服务器地址和 SSH 端口';
  if (/timed out/i.test(line)) return '连接服务器超时';
  if (/Identity file .* not accessible|no such identity|Load key .*(No such file|invalid format|bad permissions)/i.test(line)) return '私钥文件不可用：请检查路径、格式和权限（应为 600）';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(line)) return '服务器的主机密钥与 known_hosts 里记录的不一致，已拒绝连接';
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
        // 默认只绑定服务器的 127.0.0.1，由服务器上的反向代理转发；勾选“绑定所有网卡”还需要 sshd 开启 GatewayPorts。
        serverAddress: config.remotePort ? `${config.bindAll ? '0.0.0.0' : '127.0.0.1'}:${config.remotePort}` : '',
      },
    };
  }

  function update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FrpError('SSH_BODY_INVALID', '请求内容不正确');
    const next = { ...load() };
    if ('host' in input) {
      const host = cleanText(input.host, 'SSH_HOST_INVALID', '服务器地址');
      if (host && !net.isIP(host) && !HOSTNAME.test(host)) throw new FrpError('SSH_HOST_INVALID', '服务器地址必须是 IP 或域名');
      next.host = host;
    }
    if ('sshPort' in input) next.sshPort = parsePort(input.sshPort, 'SSH_PORT_INVALID', 'SSH 端口');
    if ('username' in input) {
      const username = cleanText(input.username, 'SSH_USER_INVALID', '用户名', { max: 64 });
      if (username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(username)) throw new FrpError('SSH_USER_INVALID', '用户名格式不正确');
      next.username = username;
    }
    if ('keyPath' in input) {
      const raw = input.keyPath === null || input.keyPath === undefined ? '' : input.keyPath;
      if (typeof raw !== 'string' || raw.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw)) throw new FrpError('SSH_KEY_INVALID', '私钥路径格式不正确');
      const keyPath = raw.trim();
      if (keyPath && !(path.isAbsolute(keyPath) || keyPath === '~' || keyPath.startsWith('~/'))) throw new FrpError('SSH_KEY_INVALID', '私钥路径必须是绝对路径或以 ~/ 开头');
      next.keyPath = keyPath;
    }
    if ('remotePort' in input) {
      const raw = input.remotePort;
      if (raw === '' || raw === null || raw === 0) { next.remotePortManual = false; next.remotePort = 0; }
      else { next.remotePort = parsePort(raw, 'SSH_REMOTE_PORT_INVALID', '远程端口'); next.remotePortManual = true; }
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
    if (!bin) throw new FrpError('SSH_NOT_INSTALLED', '未找到 ssh 命令，请先安装 OpenSSH 客户端，或用环境变量 T_AGENT_SSH_BIN 指定路径', 412);
    const config = load();
    if (!config.host) throw new FrpError('SSH_HOST_REQUIRED', '请先填写服务器 IP 或域名', 412);
    if (!config.username) throw new FrpError('SSH_USER_REQUIRED', '请先填写用户名', 412);
    if (config.keyPath) {
      let isFile = false;
      try { isFile = fs.statSync(expandHome(config.keyPath)).isFile(); } catch { /* 不存在 */ }
      if (!isFile) throw new FrpError('SSH_KEY_NOT_FOUND', '找不到私钥文件，请检查路径；留空则使用 ssh 默认逻辑', 412);
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
      failure = '无法启动 ssh';
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
      failure = `无法启动 ssh：${error.code || error.message}`;
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
          pushLog(`remote port busy: 已换成 ${port} 重试（${portRetries}/${MAX_PORT_RETRIES}）`);
          try { launch(); return; } catch (error) { failure = error.message; }
        }
        failure = load().remotePortManual ? '服务器上的远程端口被占用，或 sshd 不允许绑定，请换一个端口' : '服务器上的远程端口被占用，请重新生成端口';
      }
      // 已经连通过的隧道意外断开（网络抖动、服务器重启）：稍后自动重连。
      if (reachedRunning && reconnects < MAX_RECONNECTS) {
        reconnects += 1;
        status = 'starting';
        failure = '';
        pushLog(`connection closed: ${RECONNECT_DELAY_MS / 1000} 秒后重连（${reconnects}/${MAX_RECONNECTS}）`);
        reconnectTimer = setTimer(() => {
          reconnectTimer = null;
          if (stopping || child) return;
          try { launch(); } catch (error) { status = 'failed'; failure = error.message; }
        }, RECONNECT_DELAY_MS);
        if (reconnectTimer && reconnectTimer.unref) reconnectTimer.unref();
        return;
      }
      status = 'failed';
      failure = failure || `ssh 已退出（代码 ${code}）`;
    });
  }

  function start() {
    if (child || reconnectTimer) throw new FrpError('SSH_ALREADY_RUNNING', '隧道已经在运行', 409);
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
      try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* 已退出 */ } }, 3000);
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
