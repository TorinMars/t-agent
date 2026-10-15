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
// frpc 启动后这段时间内因“端口被占用”退出，视为随机端口撞车，自动换端口重试。
const PORT_RETRY_WINDOW_MS = 15_000;
const MAX_PORT_RETRIES = 3;
const PORT_CONFLICT = /port already used|port not allowed|port unavailable/i;
// TOML 配置从 frp 0.52 开始支持。
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
    remotePort: 0, remotePortManual: false, portMin: DEFAULT_PORT_MIN, portMax: DEFAULT_PORT_MAX, autoStart: false,
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

// Homebrew 的 frpc 有时没有链接进 PATH（或服务以精简的 PATH 启动），所以直接找 opt/ 和 Cellar/ 下的真实位置。
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
      } catch { /* 没装这个 formula */ }
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
    } catch { /* 继续找 */ }
  }
  return null;
}

const versionAtLeast = (version, min) => {
  for (let i = 0; i < 3; i += 1) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
};

// 运行 frpc --version（带超时）。返回 { version, supported, error }。
function probeFrpc(file) {
  try {
    const output = execFileSync(file, ['--version'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
    if (!match) return { version: '', supported: true, error: '无法识别 frpc 的版本号' };
    const parts = match.slice(1).map(Number);
    return { version: parts.join('.'), supported: versionAtLeast(parts, MIN_FRPC), error: '' };
  } catch {
    return { version: '', supported: true, error: '找到了 frpc，但无法运行它（可能已损坏或未链接完整）' };
  }
}

function createFrpService({
  db, secret, dataDir, localPort, localHost = '127.0.0.1',
  bin, spawnProcess = spawn, random = crypto.randomInt, now = Date.now, installer = installFrpc,
}) {
  const binDir = path.join(dataDir, 'bin');
  const locate = () => bin || findFrpc({ dirs: [binDir, ...candidateBinDirs(), ...homebrewDirs()] });
  const probes = new Map();
  // 以路径 + 修改时间缓存 --version 的结果；“重新检测”会清空缓存。
  function probe(file) {
    if (!file) return { version: '', supported: true, error: '' };
    let key = file;
    try { key = `${file}:${fs.statSync(file).mtimeMs}`; } catch { return { version: '', supported: true, error: '找到了 frpc，但无法运行它（可能已损坏或未链接完整）' }; }
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
      // frp 的 tcp 隧道是原始 TCP：域名需要自己解析到 frps 的 IP，HTTPS 由前面的反向代理终结。
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
      // 页面生成“让 Agent 安装 frpc / frps”的提示词时用到。
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
    // 手动填写远程端口后固定使用它（可以在随机范围之外）；留空或 0 恢复自动随机。
    if ('remotePort' in input) {
      const raw = input.remotePort;
      if (raw === '' || raw === null || raw === 0) { next.remotePortManual = false; next.remotePort = 0; }
      else { next.remotePort = parsePort(raw, 'FRP_REMOTE_PORT_INVALID', '远程端口'); next.remotePortManual = true; }
    }
    // 自动模式下，远程端口只在没有或已落在范围外时随机生成一次，之后保持稳定（域名的反向代理要指向它）。
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
    // 含 Token：只有当前用户可读，且先建文件再写入，避免短暂的宽权限窗口。
    fs.closeSync(fs.openSync(configFile, 'w', 0o600));
    fs.chmodSync(configFile, 0o600);
    fs.writeFileSync(configFile, body);
  }

  function launch() {
    const frpc = locate();
    if (frpc && !probe(frpc).supported) throw new FrpError('FRP_VERSION_UNSUPPORTED', `frpc ${probe(frpc).version} 版本过旧，需要 0.52 及以上（支持 TOML 配置）。请升级，例如 brew upgrade frpc`, 412);
    if (!frpc) throw new FrpError('FRP_NOT_INSTALLED', '未找到 frpc：请点击“安装 frpc”，或手动安装 frp 后用环境变量 T_AGENT_FRPC_BIN 指定路径', 412);
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
      if (PORT_CONFLICT.test(tail) && !load().remotePortManual && now() - spawnedAt < PORT_RETRY_WINDOW_MS && retries < MAX_PORT_RETRIES) {
        retries += 1;
        const port = regeneratePort();
        pushLog(`[t-agent] 远程端口被占用，已换成 ${port} 重试（${retries}/${MAX_PORT_RETRIES}）`);
        try { launch(); return; } catch (error) { failure = error.message; }
      }
      status = 'failed';
      failure = failure || (PORT_CONFLICT.test(tail) ? (load().remotePortManual ? '远程端口被占用或不被 frps 允许，请换一个端口' : '远程端口被占用，请重新生成端口') : `frpc 已退出（代码 ${code}）`);
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

  // 下载 frpc 到 <dataDir>/bin。异步执行，页面轮询 view().installing / installError 获取结果。
  function install() {
    if (installing) throw new FrpError('FRP_INSTALL_RUNNING', '正在安装 frpc', 409);
    if (locate()) throw new FrpError('FRP_ALREADY_INSTALLED', '已经安装了 frpc', 409);
    installing = true;
    installError = '';
    installer({ binDir }).catch(error => {
      installError = error instanceof FrpInstallError ? error.message : '安装 frpc 失败';
      if (!(error instanceof FrpInstallError)) console.warn('[frp] install failed:', error && error.message);
    }).finally(() => { installing = false; });
    return view();
  }

  // 重新扫描 frpc 的位置并重新读取版本（用户在页面外装好 frpc 后点“重新检测”）。
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

module.exports = { createFrpService, FrpError, renderToml, findFrpc, homebrewDirs, probeFrpc, randomPort, DEFAULT_PORT_MIN, DEFAULT_PORT_MAX };
