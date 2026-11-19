// Rebuilds and reinstalls an installed T-Agent.app after an update when its shell code changed.
// See "Automatic rebuild after an update" in docs/design/mac-app.md.
//
// At server start on macOS (the server restarts after every update) `start()` looks at ~/Applications/T-Agent.app (never /Applications). An app
// that is not installed stays not installed. When the bundle is this app (bundle id local.t-agent.app) and its Info.plist TAgentSourceHash differs
// from the hash of the current build inputs (lib/mac-app-source.js; a bundle without the key counts as different), it waits DELAY_MS, looks again,
// takes a lock file in the data folder and runs `nice -n 10 node scripts/build-mac-app.js --install --arch <host>` (TIMEOUT_MS at most). That script
// compiles, signs, self-tests and installs by copy and rename, so a failure leaves the installed app as it was. A failure is recorded with the hash
// it was for and is not tried again until a start finds another hash (no retry loop). A running app keeps its old binary; it is never killed, and
// the state says that a restart of the app is needed.
//
// state(): { state: 'idle'|'waiting'|'building'|'updated'|'failed'|'skipped', at, version, reason, restart_needed, log_tail? } for
// GET /api/system/app-info. The log tail and the reason name no folder outside the install and data folders (the home folder is "~", the temporary
// folder "<tmp>"). Never runs with NODE_ENV=test, TA_MAC_APP_AUTOBUILD=0, in CI, or in a server started by hand in a T-Agent terminal (no PM2), and
// not on other platforms. It never blocks the start and never throws.
const childProcess = require('node:child_process');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { INFO_KEY, macAppSourceHash } = require('../lib/mac-app-source');
const { readPlistWithPlutil } = require('./app-info');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_ID = 'local.t-agent.app';
const APP_NAME = 'T-Agent.app';
const STATE_FILE = 'mac-app-autobuild.json';
const LOCK_FILE = 'mac-app-autobuild.lock';
const DELAY_MS = 60 * 1000;
const TIMEOUT_MS = 10 * 60 * 1000;
const NICENESS = 10;
const OUTPUT_KEEP = 16 * 1024; // bytes of output kept while the build runs
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
const REASON_CHARS = 400;
const STATES = ['idle', 'waiting', 'building', 'updated', 'failed', 'skipped'];

// Why the automatic rebuild never runs in this process, or null. Another platform is not a reason here (it is simply idle).
function blockedReason(env) {
  if (env.NODE_ENV === 'test') return 'Off: the server runs in test mode';
  if (['0', 'false', 'off'].includes(String(env.TA_MAC_APP_AUTOBUILD || '').trim().toLowerCase())) return 'Off: TA_MAC_APP_AUTOBUILD=0';
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return 'Off: the server runs in CI';
  // The same rule as the T-Attention desktop window (services/attention-widget.js blockedReason): a server an agent started by hand in a T-Agent
  // terminal is a development copy; a server under PM2 is the real service.
  if ((env.TA_PEER_TASK || env.TA_HOOK_TOKEN) && env.pm_id === undefined) return 'Off: the server runs inside a T-Agent terminal';
  return null;
}

// process.arch -> the architecture of swiftc and lipo; null for one the app is not built for.
const hostArch = arch => (arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x86_64' : null);

const escapeRegExp = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Text that may be shown: the home folder as "~" and the temporary folders as "<tmp>", control characters removed.
function scrubber({ homedir, tmpdirs }) {
  const pairs = [...tmpdirs.filter(Boolean).map(dir => [dir, '<tmp>']), ...(homedir ? [[homedir, '~']] : [])]
    .filter(([dir]) => dir.length > 1).sort((a, b) => b[0].length - a[0].length);
  return text => {
    let value = String(text || '');
    for (const [dir, label] of pairs) value = value.replace(new RegExp(escapeRegExp(dir), 'g'), label);
    // eslint-disable-next-line no-control-regex
    return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  };
}

// The last lines of the build's output, at most TAIL_CHARS.
function tailOf(text) {
  const lines = String(text || '').split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-TAIL_LINES);
  const joined = lines.join('\n');
  return joined.length > TAIL_CHARS ? joined.slice(-TAIL_CHARS) : joined;
}

// The reason of a failed build: the first line the script printed on stderr (its BuildError), with the next one when it ends with ":"
// ("Could not build for arm64:" is followed by the compiler's error).
function reasonOf(stderr) {
  const lines = String(stderr || '').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  const first = lines[0].endsWith(':') && lines[1] ? `${lines[0]} ${lines[1]}` : lines[0];
  return first.length > REASON_CHARS ? `${first.slice(0, REASON_CHARS - 1)}…` : first;
}

function createMacAppAutobuild({
  dataDir,
  root = ROOT,
  platform = process.platform,
  env = process.env,
  arch = process.arch,
  homedir = () => env.TA_MAC_APP_HOME || os.homedir(),
  tmpdir = os.tmpdir,
  pid = process.pid,
  execPath = process.execPath,
  spawn = childProcess.spawn,
  execFile = childProcess.execFile,
  readPlist = readPlistWithPlutil,
  sourceHash = () => macAppSourceHash({ root }),
  fs = nodeFs,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  delayMs = DELAY_MS,
  timeoutMs = TIMEOUT_MS,
  isAlive = otherPid => { try { process.kill(otherPid, 0); return true; } catch (error) { return error.code === 'EPERM'; } },
  killGroup = (groupPid, signal) => process.kill(-groupPid, signal),
  log = message => console.warn(message),
} = {}) {
  if (!dataDir) throw new Error('createMacAppAutobuild needs the data folder');
  const supported = platform === 'darwin';
  const blocked = blockedReason(env);
  const stateFile = path.join(dataDir, STATE_FILE);
  const lockFile = path.join(dataDir, LOCK_FILE);
  const home = () => homedir();
  const bundle = () => path.join(home(), 'Applications', APP_NAME);
  const scrub = text => scrubber({ homedir: home(), tmpdirs: (() => { const dir = tmpdir(); let real = null; try { real = fs.realpathSync(dir); } catch { /* none */ } return [dir, real, `/private${dir}`]; })() })(text);
  let current = { state: 'idle', at: null, version: null, reason: blocked || null, restart_needed: false };
  let hash = null;
  let version = null;
  let timer = null;
  let child = null;
  let stopped = false;
  let running = null; // the promise of the build in progress
  let ownLock = false;

  const iso = () => new Date(now()).toISOString();
  function setState(next, { persist = false } = {}) {
    current = { state: next.state, at: iso(), version: next.version === undefined ? version : next.version, reason: next.reason || null, restart_needed: Boolean(next.restart_needed), ...(next.log_tail ? { log_tail: next.log_tail } : {}) };
    if (persist) {
      try {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const temp = `${stateFile}.${pid}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify({ ...current, hash }, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temp, stateFile);
      } catch (error) { log(`[mac-app] could not save ${STATE_FILE}: ${error.message}`); }
    }
    return current;
  }
  function readRecord() {
    try { const value = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return value && typeof value === 'object' ? value : null; } catch { return null; }
  }
  function readVersion() {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'VERSION.json'), 'utf8')).app_version || null; } catch { return null; }
  }

  // The installed app: null when ~/Applications/T-Agent.app is not there, else { ours, hash }.
  async function installed() {
    const plist = path.join(bundle(), 'Contents', 'Info.plist');
    if (!fs.existsSync(plist)) return null;
    let info = null;
    try { info = await readPlist(plist); } catch { info = null; }
    const ours = Boolean(info && info.CFBundleIdentifier === BUNDLE_ID);
    const value = info && typeof info[INFO_KEY] === 'string' ? info[INFO_KEY] : null;
    return { ours, hash: value };
  }

  // What the installed app needs: 'none' (not installed, current, or not ours: a reason), or 'build'.
  async function decide() {
    const app = await installed();
    if (!app) return { action: 'none', state: 'idle', reason: 'Not installed in ~/Applications' };
    if (!app.ours) return { action: 'none', state: 'skipped', reason: `~/Applications/${APP_NAME} is not this app` };
    if (app.hash === hash) return { action: 'none', state: 'idle', reason: null };
    return { action: 'build' };
  }

  function takeLock() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(lockFile, 'wx', 0o600);
        try { fs.writeSync(fd, JSON.stringify({ pid, at: iso() })); } finally { fs.closeSync(fd); }
        ownLock = true;
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { holder = null; }
        const age = holder && holder.at ? now() - Date.parse(holder.at) : Infinity;
        const live = holder && Number.isInteger(holder.pid) && holder.pid !== pid && isAlive(holder.pid);
        // A lock of a process that is gone, or older than a build can take, is stale.
        if (live && age < timeoutMs + 60 * 1000) return false;
        try { fs.rmSync(lockFile, { force: true }); } catch { /* taken again below */ }
      }
    }
    return false;
  }
  function releaseLock() {
    if (!ownLock) return;
    ownLock = false;
    try {
      const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (holder && holder.pid === pid) fs.rmSync(lockFile, { force: true });
    } catch { /* already gone */ }
  }

  // Whether the installed app's executable runs now (its processes keep the old binary after the bundle was replaced).
  const appRunning = () => new Promise(resolve => {
    const exe = path.join(bundle(), 'Contents', 'MacOS', 'T-Agent');
    try {
      execFile('/usr/bin/pgrep', ['-f', `^${escapeRegExp(exe)}( |$)`], { timeout: 5000 }, (error, stdout) => resolve(!error && String(stdout || '').trim() !== ''));
    } catch { resolve(false); }
  });

  // The environment of the build: what the tools need, nothing else (no tokens of the server).
  function childEnv() {
    const keep = {};
    for (const name of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'DEVELOPER_DIR', 'TA_MAC_APP_HOME']) if (env[name]) keep[name] = env[name];
    keep.PATH = [env.PATH, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
    return keep;
  }

  function runBuild(buildArch) {
    return new Promise(resolve => {
      let output = '';
      let stderr = '';
      let timedOut = false;
      let finished = false;
      let killTimer = null;
      const finish = (code, signal, error) => {
        if (finished) return;
        finished = true;
        if (killTimer) cancel(killTimer);
        child = null;
        resolve({ code, signal, error, timedOut, output, stderr });
      };
      let started;
      try {
        started = spawn('/usr/bin/nice', ['-n', String(NICENESS), execPath, path.join(root, 'scripts', 'build-mac-app.js'), '--install', '--arch', buildArch], {
          cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true,
        });
      } catch (error) { finish(null, null, error); return; }
      child = started;
      const keep = (text, chunk) => (text + chunk).slice(-OUTPUT_KEEP);
      if (started.stdout) started.stdout.on('data', chunk => { output = keep(output, chunk); });
      if (started.stderr) started.stderr.on('data', chunk => { output = keep(output, chunk); stderr = keep(stderr, chunk); });
      killTimer = schedule(() => {
        timedOut = true;
        try { killGroup(started.pid, 'SIGKILL'); } catch { try { started.kill('SIGKILL'); } catch { /* gone */ } }
      }, timeoutMs);
      if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();
      started.on('error', error => finish(null, null, error));
      started.on('close', (code, signal) => finish(code, signal, null));
    });
  }

  async function build() {
    if (stopped) return current;
    const decision = await decide();
    if (decision.action !== 'build') return setState(decision);
    const buildArch = hostArch(arch);
    if (!buildArch) return setState({ state: 'skipped', reason: `No build for the architecture ${arch}` });
    let locked;
    try { locked = takeLock(); } catch (error) { return setState({ state: 'skipped', reason: scrub(`Could not take the build lock: ${error.message}`) }); }
    if (!locked) return setState({ state: 'skipped', reason: 'Another T-Agent server is rebuilding the app' });
    if (stopped) { releaseLock(); return current; }
    setState({ state: 'building' }, { persist: true });
    log(`[mac-app] rebuilding ${APP_NAME} ${version || ''} for ${buildArch}: its shell code changed`);
    let result;
    try { result = await runBuild(buildArch); } finally { releaseLock(); }
    if (stopped) return current;
    const logTail = scrub(tailOf(result.output));
    if (result.error || result.code !== 0 || result.timedOut) {
      const reason = result.timedOut ? `The build took longer than ${Math.round(timeoutMs / 60000)} minutes`
        : result.error ? `The build could not start: ${result.error.message}`
          : (reasonOf(result.stderr) || (result.signal ? `The build stopped (${result.signal})` : `The build exited with code ${result.code}`));
      log(`[mac-app] could not rebuild ${APP_NAME}: ${scrub(reason)}`);
      return setState({ state: 'failed', reason: scrub(reason), log_tail: logTail }, { persist: true });
    }
    const after = await installed();
    if (!after || after.hash !== hash) {
      return setState({ state: 'failed', reason: 'The build finished, but the installed app does not carry the new source hash', log_tail: logTail }, { persist: true });
    }
    const restartNeeded = await appRunning();
    log(`[mac-app] ${APP_NAME} updated to ${version}${restartNeeded ? '; the running app uses it after it is quit and opened again' : ''}`);
    return setState({ state: 'updated', restart_needed: restartNeeded, log_tail: logTail }, { persist: true });
  }

  // After the server listens. Resolves the state once the first look is done; the build itself runs DELAY_MS later.
  async function start() {
    if (!supported) return null;
    if (blocked || stopped || timer || running) return current;
    try {
      version = readVersion();
      hash = sourceHash();
      if (!hash) return setState({ state: 'idle', reason: 'The app source is missing from this install' });
      const decision = await decide();
      if (decision.action !== 'build') return setState(decision);
      // A failure for this same source is not tried again; a start with another hash tries once more.
      const record = readRecord();
      if (record && record.state === 'failed' && record.hash === hash) {
        current = { state: 'failed', at: record.at || null, version: record.version || version, reason: record.reason || null, restart_needed: false, ...(record.log_tail ? { log_tail: String(record.log_tail) } : {}) };
        return current;
      }
      setState({ state: 'waiting' });
      timer = schedule(() => {
        timer = null;
        running = build().catch(error => setState({ state: 'failed', reason: scrub(error.message) }, { persist: true })).finally(() => { running = null; });
      }, delayMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return current;
    } catch (error) {
      log(`[mac-app] automatic rebuild check failed: ${error.message}`);
      return setState({ state: 'skipped', reason: scrub(error.message) });
    }
  }

  // At the server's shutdown (synchronous): a waiting build is dropped, a running one is ended (the install is atomic, so the app stays as it was).
  function stop() {
    stopped = true;
    if (timer) { cancel(timer); timer = null; }
    if (child) {
      const build = child;
      child = null;
      try { killGroup(build.pid, 'SIGTERM'); } catch { try { build.kill('SIGTERM'); } catch { /* gone */ } }
    }
    releaseLock();
    if (current.state === 'waiting' || current.state === 'building') current = { ...current, state: 'skipped', reason: 'The server stopped first' };
  }

  const state = () => (supported ? { ...current } : null);
  // The hash of the current source (read once; also when the rebuild is off, for the "Up to date" line of the Settings card).
  const currentHash = () => {
    if (!supported) return null;
    if (hash === null) { try { hash = sourceHash(); } catch { hash = null; } }
    return hash;
  };
  return { start, stop, state, currentHash, idle: () => running || Promise.resolve(current), paths: { stateFile, lockFile } };
}

let shared = null;
const setShared = instance => { shared = instance; };
const sharedAutobuild = () => shared;

module.exports = { createMacAppAutobuild, blockedReason, hostArch, scrubber, tailOf, reasonOf, setShared, sharedAutobuild, STATES, DELAY_MS, TIMEOUT_MS, STATE_FILE, LOCK_FILE, NICENESS };
