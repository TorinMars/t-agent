const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 页面只能触发这四个动作；不能启动任意命令，也不能删除进程。
const ACTIONS = ['start', 'stop', 'restart', 'reload'];
const STREAMS = { out: 'pm_out_log_path', err: 'pm_err_log_path' };
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINES = 1000;

class Pm2Error extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// 服务由 LaunchAgent/systemd 启动时 PATH 很精简，所以额外查找常见的 Node/PM2 安装位置。
function candidateBinDirs(env = process.env, home = os.homedir()) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.local', 'node', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) dirs.push(path.join(nvm, version, 'bin'));
  } catch { /* 没有 nvm */ }
  return [...new Set(dirs)];
}

function findPm2(options = {}) {
  if (options.bin) return options.bin;
  if (process.env.T_AGENT_PM2_BIN) return process.env.T_AGENT_PM2_BIN;
  for (const dir of options.dirs || candidateBinDirs({ ...process.env, ...(options.env || {}) }, options.home)) {
    const candidate = path.join(dir, 'pm2');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* 继续找 */ }
  }
  return null;
}

// jlist 前面可能带有 "[PM2] ..." 之类的提示行：取第一个能完整解析成 JSON 数组的行首 "["。
function parseJlist(output) {
  const text = String(output || '');
  for (let index = text.indexOf('['); index !== -1; index = text.indexOf('[', index + 1)) {
    if (index > 0 && text[index - 1] !== '\n') continue;
    try {
      const parsed = JSON.parse(text.slice(index));
      if (Array.isArray(parsed)) return parsed;
    } catch { /* 继续向后找 */ }
  }
  throw new Pm2Error('PM2_BAD_OUTPUT', '无法解析 pm2 jlist 的输出', 502);
}

// 只挑选展示需要的字段。进程的 env、args 里可能有密钥，绝不返回。
function toSafeProcess(entry, selfPid) {
  const env = entry.pm2_env || {};
  const monit = entry.monit || {};
  return {
    id: entry.pm_id,
    name: entry.name,
    status: env.status || 'unknown',
    pid: entry.pid || 0,
    cpu: Number(monit.cpu) || 0,
    memory: Number(monit.memory) || 0,
    startedAt: env.status === 'online' && env.pm_uptime ? Number(env.pm_uptime) : null,
    restarts: Number(env.restart_time) || 0,
    unstableRestarts: Number(env.unstable_restarts) || 0,
    execMode: env.exec_mode || '',
    script: env.pm_exec_path || '',
    cwd: env.pm_cwd || '',
    createdAt: env.created_at || null,
    hasOutLog: Boolean(env.pm_out_log_path),
    hasErrLog: Boolean(env.pm_err_log_path),
    self: Boolean(selfPid) && entry.pid === selfPid,
  };
}

function tailFile(file, maxLines) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(handle);
    const length = Math.min(size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    let lines = buffer.toString('utf8').split('\n');
    if (size > length) lines = lines.slice(1); // 第一行可能被截断
    if (lines[lines.length - 1] === '') lines.pop();
    return { lines: lines.slice(-maxLines), truncated: size > length };
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [], truncated: false };
    throw new Pm2Error('PM2_LOG_UNREADABLE', '无法读取日志文件', 500);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function createPm2Manager(options = {}) {
  const exec = options.exec || execFile;
  const timeoutMs = options.timeoutMs || 15000;
  const pm2Home = () => process.env.PM2_HOME || path.join(options.home || os.homedir(), '.pm2');
  const selfPid = options.selfPid === undefined ? process.pid : options.selfPid;

  function run(bin, args) {
    const merged = { ...process.env, ...(options.env || {}) };
    const dirs = candidateBinDirs(merged, options.home);
    const env = { ...merged, PATH: [path.dirname(bin), ...dirs].join(path.delimiter) };
    return new Promise((resolve, reject) => {
      exec(bin, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env }, (error, stdout, stderr) => {
        if (error) {
          reject(new Pm2Error('PM2_COMMAND_FAILED', `pm2 ${args[0]} 执行失败：${String(stderr || error.message).trim().split('\n').pop()}`, 502));
        } else {
          resolve(String(stdout));
        }
      });
    });
  }

  function requireBin() {
    const bin = findPm2(options);
    if (!bin) throw new Pm2Error('PM2_NOT_INSTALLED', '未检测到 pm2，请先运行安装脚本', 404);
    return bin;
  }

  // 守护进程没在运行时，jlist 会顺带把它拉起来；这里先看 socket，避免查询产生副作用。
  function daemonRunning() {
    return options.assumeRunning || fs.existsSync(path.join(pm2Home(), 'rpc.sock')) || fs.existsSync(path.join(pm2Home(), 'pm2.pid'));
  }

  async function rawList(bin) {
    return parseJlist(await run(bin, ['jlist']));
  }

  async function status() {
    const bin = findPm2(options);
    if (!bin) return { installed: false, running: false, processes: [] };
    if (!daemonRunning()) return { installed: true, running: false, processes: [] };
    return { installed: true, running: true, processes: (await rawList(bin)).map(entry => toSafeProcess(entry, selfPid)) };
  }

  async function control(id, action) {
    if (!ACTIONS.includes(action)) throw new Pm2Error('PM2_BAD_ACTION', '不支持的操作', 400);
    if (!Number.isInteger(id) || id < 0) throw new Pm2Error('PM2_BAD_ID', '进程编号不合法', 400);
    const bin = requireBin();
    if (!daemonRunning()) throw new Pm2Error('PM2_NOT_RUNNING', 'PM2 守护进程没有运行', 409);
    const before = (await rawList(bin)).find(entry => entry.pm_id === id);
    if (!before) throw new Pm2Error('PM2_NOT_FOUND', '找不到这个进程', 404);
    await run(bin, [action, String(id)]);
    const after = (await rawList(bin)).find(entry => entry.pm_id === id);
    return after ? toSafeProcess(after, selfPid) : null;
  }

  async function logs(id, stream, lines) {
    const key = STREAMS[stream];
    if (!key) throw new Pm2Error('PM2_BAD_STREAM', 'stream 只能是 out 或 err', 400);
    if (!Number.isInteger(id) || id < 0) throw new Pm2Error('PM2_BAD_ID', '进程编号不合法', 400);
    const count = Math.min(Math.max(Number.parseInt(lines, 10) || 200, 1), MAX_LOG_LINES);
    const bin = requireBin();
    if (!daemonRunning()) throw new Pm2Error('PM2_NOT_RUNNING', 'PM2 守护进程没有运行', 409);
    const entry = (await rawList(bin)).find(item => item.pm_id === id);
    if (!entry) throw new Pm2Error('PM2_NOT_FOUND', '找不到这个进程', 404);
    // 日志路径只来自 pm2 自己的记录，永远不接受请求里传来的路径。
    const file = entry.pm2_env && entry.pm2_env[key];
    if (!file) return { stream, lines: [], truncated: false };
    return { stream, ...tailFile(file, count) };
  }

  return { status, control, logs };
}

module.exports = { createPm2Manager, Pm2Error, parseJlist, toSafeProcess, findPm2, ACTIONS, MAX_LOG_LINES };
