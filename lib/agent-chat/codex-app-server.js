// Minimal client of `codex app-server`: newline-delimited JSON-RPC over the stdio of a child process.
//
// The messages carry no "jsonrpc" field. Both sides send requests ({ id, method, params }), responses ({ id, result | error }) and
// notifications ({ method, params }); the Codex side asks the client for approvals and answers with server requests, so a client
// has to answer requests as well as make them.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STDERR_TAIL = 2000;
const CLIENT_INFO = { name: 't-agent', title: 'T-Agent', version: '1' };

const NOT_FOUND = 'The Codex CLI was not found. Install it, or set CODEX_PATH to the full path of `codex` in the Client\'s .env file and restart the Client';

const isExecutable = file => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
};

// Where `codex` may be when the service's own PATH does not have it (a service started by pm2, systemd or launchd has a short PATH, and
// the folders of npm, bun, volta and nvm are set up by the shell profile): the usual install folders of the user, newest nvm node first.
function searchDirs(env = process.env) {
  const home = env.HOME || os.homedir();
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  let versions = [];
  try { versions = fs.readdirSync(nvm).sort((x, y) => y.localeCompare(x, undefined, { numeric: true })).map(name => path.join(nvm, name, 'bin')); } catch { /* no nvm */ }
  const dirs = [
    ...String(env.PATH || '').split(path.delimiter),
    path.join(home, '.local', 'bin'), path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'),
    path.join(home, '.cargo', 'bin'), path.join(home, '.local', 'share', 'pnpm'), path.join(home, 'Library', 'pnpm'), ...versions,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin',
  ];
  return [...new Set(dirs.filter(Boolean))];
}

// The `codex` the person runs in the terminal, so the chat uses the same install, login and configuration. CODEX_PATH names it explicitly.
function executablePath(env = process.env) {
  if (env.CODEX_PATH && isExecutable(env.CODEX_PATH)) return env.CODEX_PATH;
  for (const dir of searchDirs(env)) {
    const file = path.join(dir, 'codex');
    if (isExecutable(file)) return file;
  }
  return null;
}

// What the person's own login shell resolves `codex` to: it has the PATH of their shell profile (nvm, bun, a custom prefix ...).
// The shell is asked as a login shell first, then as an interactive one (nvm is usually set up in .zshrc / .bashrc); it is given a few seconds.
function shellLookup(env) {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/sh';
  const ask = flags => new Promise(resolve => {
    execFile(shell, [flags, 'command -v codex'], { env, timeout: 4000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      const line = String(stdout || '').split('\n').map(entry => entry.trim()).filter(entry => path.isAbsolute(entry)).pop();
      resolve(line && isExecutable(line) ? line : null);
    });
  });
  return ask('-lc').then(found => found || ask('-ilc'));
}

// What the shell answered is kept while that file stays executable: asking a shell takes a moment and runs the person's profile.
let fromShell = null;
const forgetCodex = () => { fromShell = null; };
// executablePath(), and when that finds nothing the login shell's answer.
async function findCodex(env = process.env) {
  const direct = executablePath(env);
  if (direct) return direct;
  if (fromShell && isExecutable(fromShell)) return fromShell;
  fromShell = await shellLookup(env);
  return fromShell;
}

class AppServerClient {
  constructor({ command, args = ['app-server'], cwd, env = process.env, spawnProcess = spawn } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnProcess = spawnProcess;
    this.nextId = 1;
    this.pending = new Map(); // request id -> { resolve, reject, method }
    this.stderr = '';
    this.closed = false;
    this.onNotification = () => {};
    this.onRequest = async () => { throw new Error('Not supported'); };
    this.onExit = () => {};
  }

  // Starts the process and performs the initialize handshake.
  async start() {
    this.child = this.spawnProcess(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const failed = new Promise((_, reject) => this.child.once('error', reject));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL); });
    this.child.stdin.on('error', () => { /* the exit handler reports it */ });
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.receive(line);
      }
    });
    this.child.once('exit', (code, signal) => this.finish(new Error(this.exitMessage(code, signal))));
    this.child.once('error', error => this.finish(error));
    await Promise.race([
      this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }),
      failed,
    ]);
    this.notify('initialized');
  }

  exitMessage(code, signal) {
    const tail = this.stderr.trim().split('\n').pop();
    return `The Codex app server stopped (${signal || `exit ${code}`})${tail ? `: ${tail}` : ''}`;
  }

  send(message) {
    if (this.closed || !this.child || !this.child.stdin.writable) throw new Error('The Codex app server is not running');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      try { this.send({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.send(params === undefined ? { method } : { method, params }); }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) { void this.serve(message); return; }
    if (message.method) { this.onNotification(message.method, message.params || {}); return; }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(Object.assign(new Error(message.error.message || `${entry.method} failed`), { code: message.error.code }));
    else entry.resolve(message.result);
  }

  // A request from the Codex side: the handler's result is the response, an error becomes a JSON-RPC error.
  async serve(message) {
    let reply;
    try { reply = { id: message.id, result: await this.onRequest(message.method, message.params || {}) }; }
    catch (error) { reply = { id: message.id, error: { code: error.code || -32601, message: error.message || 'Not supported' } }; }
    try { this.send(reply); } catch { /* the process is gone */ }
  }

  finish(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.onExit(error);
  }

  close() {
    if (this.child && !this.child.killed && this.child.exitCode === null) this.child.kill();
    this.finish(new Error('The Codex app server was closed'));
  }
}

module.exports = { AppServerClient, executablePath, findCodex, forgetCodex, searchDirs, NOT_FOUND, CLIENT_INFO };
