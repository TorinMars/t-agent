const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { candidateBinDirs } = require('./pm2-manager');
const { decryptToken, encryptToken } = require('../lib/token-crypto');

const STATE_KEY = 'frp_config';
const DEFAULT_PORT_MIN = 20000;
const DEFAULT_PORT_MAX = 60000;
const MAX_LOG_LINES = 200;
// frpc 启动后这段时间内因“端口被占用”退出，视为随机端口撞车，自动换端口重试。
const PORT_RETRY_WINDOW_MS = 15_000;
const MAX_PORT_RETRIES = 3;
const PORT_CONFLICT = /port already used|port not allowed|port unavailable/i;
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
  if (!isPort(port)) throw new FrpError(code, `${label}必须是 1-65535 的整数`);
  return port;
}

function cleanText(value, code, label, { max = 253 } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new FrpError(code, `${label}格式不正确`);
  const text = value.trim();
  if (text.length > max || /[\u0000-\u001f\u007f\s"'\\]/.test(text)) throw new FrpError(code, `${label}格式不正确`);
  return text;
}

function randomPort(min, max, random = crypto.randomInt) {
  return random(min, max + 1);
}

function emptyConfig() {
  return {
    serverAddr: '', serverPort: 7000, tokenCipher: '', domain: '', localPort: 0,
    remotePort: 0, portMin: DEFAULT_PORT_MIN, portMax: DEFAULT_PORT_MAX, autoStart: false,
  };
}

// frpc 的 TOML 配置：字符串用 JSON 转义（对 TOML 基本字符串同样合法）。
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

function findFrpc(options = {}) {
  if (options.bin) return options.bin;
  if (process.env.T_AGENT_FRPC_BIN) return process.env.T_AGENT_FRPC_BIN;
  for (const dir of options.dirs || candidateBinDirs()) {
    const candidate = path.join(dir, 'frpc');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* 继续找 */ }
  }
  return null;
}

function createFrpService({
  db, secret, dataDir, localPort, localHost = '127.0.0.1',
  bin, spawnProcess = spawn, random = crypto.randomInt, now = Date.now,
}) {
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
      portMin: config.portMin,
      portMax: config.portMax,
      autoStart: config.autoStart,
      // frp 的 tcp 隧道是原始 TCP：域名需要自己解析到 frps 的 IP，HTTPS 由前面的反向代理终结。
      publicAddress: host && config.remotePort ? `${host}:${config.remotePort}` : '',
    };
  }

  function view() {
    const frpc = bin || findFrpc();
    return {
      installed: Boolean(frpc),
      status,
      error: failure,
      startedAt,
      logs: logs.slice(),
      config: publicConfig(load()),
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
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FrpError('FRP_BODY_INVALID', '请求内容不正确');
    const config = load();
    const next = { ...config };
    if ('serverAddr' in input) {
      const addr = cleanText(input.serverAddr, 'FRP_SERVER_ADDR_INVALID', '服务器地址');
      if (addr && !net.isIP(addr) && !HOSTNAME.test(addr)) throw new FrpError('FRP_SERVER_ADDR_INVALID', '服务器地址必须是 IP 或域名');
      next.serverAddr = addr;
    }
    if ('serverPort' in input) next.serverPort = parsePort(input.serverPort, 'FRP_SERVER_PORT_INVALID', '服务器端口');
    if ('domain' in input) {
      const domain = cleanText(input.domain, 'FRP_DOMAIN_INVALID', '域名').toLowerCase();
      if (domain && (!HOSTNAME.test(domain) || net.isIP(domain))) throw new FrpError('FRP_DOMAIN_INVALID', '域名格式不正确，例如 app.example.com');
      next.domain = domain;
    }
    if ('localPort' in input) {
      const raw = input.localPort;
      next.localPort = raw === '' || raw === null || raw === 0 ? 0 : parsePort(raw, 'FRP_LOCAL_PORT_INVALID', '本地端口');
    }
    // token 为 undefined 表示不改；空字符串表示清除。
    if (typeof input.token === 'string') {
      if (/[\u0000-\u001f\u007f]/.test(input.token) || input.token.length > 256) throw new FrpError('FRP_TOKEN_INVALID', 'Token 含有不允许的字符');
      next.tokenCipher = input.token ? encryptToken(input.token, secret) : '';
    }
    if ('portMin' in input) next.portMin = parsePort(input.portMin, 'FRP_PORT_RANGE_INVALID', '随机端口范围');
    if ('portMax' in input) next.portMax = parsePort(input.portMax, 'FRP_PORT_RANGE_INVALID', '随机端口范围');
    if (next.portMin > next.portMax) throw new FrpError('FRP_PORT_RANGE_INVALID', '随机端口范围的起点不能大于终点');
    if ('autoStart' in input) next.autoStart = Boolean(input.autoStart);
    // 远程端口只在没有或已落在范围外时随机生成一次，之后保持稳定（域名的反向代理要指向它）。
    if (!next.remotePort || next.remotePort < next.portMin || next.remotePort > next.portMax) {
      next.remotePort = randomPort(next.portMin, next.portMax, random);
    }
    save(next);
    return view();
  }

  function regeneratePort() {
    const config = load();
    config.remotePort = randomPort(config.portMin, config.portMax, random);
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
    // 含 Token：只有当前用户可读，且先建文件再写入，避免短暂的宽权限窗口。
    fs.closeSync(fs.openSync(configFile, 'w', 0o600));
    fs.chmodSync(configFile, 0o600);
    fs.writeFileSync(configFile, body);
  }

  function launch() {
    const frpc = bin || findFrpc();
    if (!frpc) throw new FrpError('FRP_NOT_INSTALLED', '未找到 frpc：请先安装 frp（https://github.com/fatedier/frp/releases），或用环境变量 T_AGENT_FRPC_BIN 指定路径', 412);
    const config = load();
    if (!config.serverAddr) throw new FrpError('FRP_SERVER_REQUIRED', '请先填写服务器 IP 或域名', 412);
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
      failure = '无法启动 frpc';
      throw new FrpError('FRP_START_FAILED', failure, 500);
    }
    child = proc;
    const onOutput = chunk => {
      const text = String(chunk);
      pushLog(text);
      if (START_OK.test(text) && child === proc) { status = 'running'; startedAt = now(); retries = 0; }
      if (LOGIN_FAILED.test(text)) failure = '登录 frps 失败，请检查服务器地址、端口和 Token';
    };
    proc.stdout && proc.stdout.on('data', onOutput);
    proc.stderr && proc.stderr.on('data', onOutput);
    proc.on('error', error => {
      if (child !== proc) return;
      child = null;
      status = 'failed';
      failure = `无法启动 frpc：${error.code || error.message}`;
    });
    proc.on('exit', code => {
      if (child !== proc) return;
      child = null;
      if (stopping) { status = 'stopped'; return; }
      const tail = logs.slice(-10).join('\n');
      if (PORT_CONFLICT.test(tail) && now() - spawnedAt < PORT_RETRY_WINDOW_MS && retries < MAX_PORT_RETRIES) {
        retries += 1;
        const port = regeneratePort();
        pushLog(`[t-agent] 远程端口被占用，已换成 ${port} 重试（${retries}/${MAX_PORT_RETRIES}）`);
        try { launch(); return; } catch (error) { failure = error.message; }
      }
      status = 'failed';
      failure = failure || (PORT_CONFLICT.test(tail) ? '远程端口被占用，请重新生成端口' : `frpc 已退出（代码 ${code}）`);
    });
  }

  function start() {
    if (child) throw new FrpError('FRP_ALREADY_RUNNING', '隧道已经在运行', 409);
    retries = 0;
    logs = [];
    launch();
    return view();
  }

  function stop() {
    if (child) {
      stopping = true;
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

  // 随机端口改动后需要重启才会生效。
  function regenerate() {
    const wasRunning = Boolean(child);
    if (wasRunning) stop();
    regeneratePort();
    if (wasRunning) { retries = 0; launch(); }
    return view();
  }

  function autoStart() {
    const config = load();
    if (!config.autoStart || !config.serverAddr || !(bin || findFrpc())) return;
    try { launch(); } catch (error) { console.warn('[frp] auto start failed:', error.message); }
  }

  return { view, update, start, stop, regenerate, autoStart, load };
}

module.exports = { createFrpService, FrpError, renderToml, findFrpc, randomPort, DEFAULT_PORT_MIN, DEFAULT_PORT_MAX };
