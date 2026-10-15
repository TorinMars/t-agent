const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The page can only trigger these four actions; it cannot start arbitrary commands or delete processes.
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

// When the service is started by LaunchAgent/systemd the PATH is slim, so also look in the common Node/PM2 install locations.
function candidateBinDirs(env = process.env, home = os.homedir()) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.local', 'node', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) dirs.push(path.join(nvm, version, 'bin'));
  } catch { /* no nvm */ }
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
    } catch { /* keep looking */ }
  }
  return null;
}

// jlist output may be preceded by hint lines such as "[PM2] ...": take the first line-start "[" that parses completely into a JSON array.
function parseJlist(output) {
  const text = String(output || '');
  for (let index = text.indexOf('['); index !== -1; index = text.indexOf('[', index + 1)) {
    if (index > 0 && text[index - 1] !== '\n') continue;
    try {
      const parsed = JSON.parse(text.slice(index));
      if (Array.isArray(parsed)) return parsed;
    } catch { /* keep looking further on */ }
  }
  throw new Pm2Error('PM2_BAD_OUTPUT', 'Cannot parse the pm2 jlist output', 502);
}

// Pick only the fields needed for display. A process's env and args may contain secrets, so they are never returned.
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
    if (size > length) lines = lines.slice(1); // the first line may be truncated
    if (lines[lines.length - 1] === '') lines.pop();
    return { lines: lines.slice(-maxLines), truncated: size > length };
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [], truncated: false };
    throw new Pm2Error('PM2_LOG_UNREADABLE', 'Cannot read the log file', 500);
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
          reject(new Pm2Error('PM2_COMMAND_FAILED', `pm2 ${args[0]} failed: ${String(stderr || error.message).trim().split('\n').pop()}`, 502));
        } else {
          resolve(String(stdout));
        }
      });
    });
  }

  function requireBin() {
    const bin = findPm2(options);
    if (!bin) throw new Pm2Error('PM2_NOT_INSTALLED', 'pm2 not detected; run the install script first', 404);
    return bin;
  }

  // When the daemon is not running, jlist starts it as a side effect; check the socket first so a query has no side effects.
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
    if (!ACTIONS.includes(action)) throw new Pm2Error('PM2_BAD_ACTION', 'Unsupported action', 400);
    if (!Number.isInteger(id) || id < 0) throw new Pm2Error('PM2_BAD_ID', 'Invalid process id', 400);
    const bin = requireBin();
    if (!daemonRunning()) throw new Pm2Error('PM2_NOT_RUNNING', 'The PM2 daemon is not running', 409);
    const before = (await rawList(bin)).find(entry => entry.pm_id === id);
    if (!before) throw new Pm2Error('PM2_NOT_FOUND', 'Process not found', 404);
    await run(bin, [action, String(id)]);
    const after = (await rawList(bin)).find(entry => entry.pm_id === id);
    return after ? toSafeProcess(after, selfPid) : null;
  }

  async function logs(id, stream, lines) {
    const key = STREAMS[stream];
    if (!key) throw new Pm2Error('PM2_BAD_STREAM', 'stream must be out or err', 400);
    if (!Number.isInteger(id) || id < 0) throw new Pm2Error('PM2_BAD_ID', 'Invalid process id', 400);
    const count = Math.min(Math.max(Number.parseInt(lines, 10) || 200, 1), MAX_LOG_LINES);
    const bin = requireBin();
    if (!daemonRunning()) throw new Pm2Error('PM2_NOT_RUNNING', 'The PM2 daemon is not running', 409);
    const entry = (await rawList(bin)).find(item => item.pm_id === id);
    if (!entry) throw new Pm2Error('PM2_NOT_FOUND', 'Process not found', 404);
    // The log path only comes from pm2's own records and is never accepted from the request.
    const file = entry.pm2_env && entry.pm2_env[key];
    if (!file) return { stream, lines: [], truncated: false };
    return { stream, ...tailFile(file, count) };
  }

  return { status, control, logs };
}

module.exports = { createPm2Manager, Pm2Error, parseJlist, toSafeProcess, findPm2, candidateBinDirs, ACTIONS, MAX_LOG_LINES };
