// services/mac-app-autobuild.js and lib/mac-app-source.js: the automatic rebuild of an installed T-Agent.app after an update ("Automatic rebuild
// after an update" in docs/design/mac-app.md). Everything outside is injected: the platform, the environment, the home folder (a temporary
// folder, never the real ~/Applications), spawn (a fake child, so no build runs), execFile (pgrep), the Info.plist reader, the timers and the
// clock. The data folder is a temporary folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { macAppSourceHash, hashInputs, sourceInputs } = require('../lib/mac-app-source');
const autobuild = require('../services/mac-app-autobuild');

const ROOT = path.join(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-mac-autobuild-')));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
const folder = name => { const dir = path.join(temp, `${name}-${counter += 1}`); fs.mkdirSync(dir, { recursive: true }); return dir; };

// A copy of the build inputs of the real install folder.
function sourceRoot() {
  const root = folder('root');
  fs.mkdirSync(path.join(root, 'apps', 'macos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'mac-app'), { recursive: true });
  for (const name of ['main.swift', 'A.swift', 'B.swift']) fs.writeFileSync(path.join(root, 'apps', 'macos', name), `// ${name}\n`);
  fs.writeFileSync(path.join(root, 'apps', 'macos', 'README.md'), 'not a build input');
  fs.writeFileSync(path.join(root, 'scripts', 'build-mac-app.js'), '// build\n');
  fs.writeFileSync(path.join(root, 'scripts', 'mac-app', 'make-icon.swift'), '// icon\n');
  fs.writeFileSync(path.join(root, 'VERSION.json'), JSON.stringify({ app_version: '3.2.1' }));
  return root;
}

test('the source hash is stable and changes with any build input, but not with other files or the folder', () => {
  const root = sourceRoot();
  const first = macAppSourceHash({ root });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(macAppSourceHash({ root }), first, 'stable');
  const other = sourceRoot();
  assert.equal(macAppSourceHash({ root: other }), first, 'the same files in another folder give the same hash');
  fs.writeFileSync(path.join(root, 'apps', 'macos', 'README.md'), 'changed');
  fs.utimesSync(path.join(root, 'apps', 'macos', 'A.swift'), new Date(0), new Date(0));
  assert.equal(macAppSourceHash({ root }), first, 'README and time stamps are not inputs');
  const seen = new Set([first]);
  fs.writeFileSync(path.join(root, 'apps', 'macos', 'C.swift'), '');
  const withC = macAppSourceHash({ root });
  fs.rmSync(path.join(root, 'apps', 'macos', 'C.swift'));
  assert.notEqual(withC, first, 'a file added');
  assert.equal(macAppSourceHash({ root }), first, 'and removed again');
  seen.add(withC);
  for (const change of [
    () => fs.appendFileSync(path.join(root, 'apps', 'macos', 'A.swift'), 'x'),
    () => fs.renameSync(path.join(root, 'apps', 'macos', 'B.swift'), path.join(root, 'apps', 'macos', 'E.swift')),
    () => fs.appendFileSync(path.join(root, 'scripts', 'build-mac-app.js'), 'x'),
    () => fs.appendFileSync(path.join(root, 'scripts', 'mac-app', 'make-icon.swift'), 'x'),
  ]) {
    change();
    const next = macAppSourceHash({ root });
    assert.ok(!seen.has(next), 'a new hash for every change');
    seen.add(next);
  }
  // Moving bytes from one file to the next is a change too (the lengths are part of the hash).
  const a = sourceRoot();
  const b = sourceRoot();
  fs.writeFileSync(path.join(a, 'apps', 'macos', 'A.swift'), 'xy'); fs.writeFileSync(path.join(a, 'apps', 'macos', 'B.swift'), 'z');
  fs.writeFileSync(path.join(b, 'apps', 'macos', 'A.swift'), 'x'); fs.writeFileSync(path.join(b, 'apps', 'macos', 'B.swift'), 'yz');
  assert.notEqual(macAppSourceHash({ root: a }), macAppSourceHash({ root: b }));
  // The order: Swift files by name, then the build script, then the icon tool.
  assert.deepEqual(sourceInputs({ sources: ['/x/main.swift', '/x/A.swift'], buildScript: '/b.js', iconSource: '/i.swift' }).map(entry => entry.label),
    ['apps/macos/A.swift', 'apps/macos/main.swift', 'scripts/build-mac-app.js', 'scripts/mac-app/make-icon.swift']);
  // No main.swift, or an input that cannot be read: no hash.
  fs.rmSync(path.join(a, 'apps', 'macos', 'main.swift'));
  assert.equal(macAppSourceHash({ root: a }), null);
  fs.rmSync(path.join(b, 'scripts', 'build-mac-app.js'));
  assert.equal(macAppSourceHash({ root: b }), null);
  assert.throws(() => hashInputs({ sources: [], buildScript: '/missing', iconSource: '/missing' }));
  // The real install folder has a hash.
  assert.match(macAppSourceHash({ root: ROOT }), /^[0-9a-f]{64}$/);
});

// A world: the source, a home with or without an installed app, a data folder, a fake spawn and timers.
function world({ installedHash = 'old', bundleId = 'local.t-agent.app', installed = true, env = { PM2_HOME: '/x', pm_id: '3' }, platform = 'darwin', arch = 'arm64', running = true, dataDir = null, root = null } = {}) {
  const w = { root: root || sourceRoot(), home: folder('home'), dataDir: dataDir || folder('data'), spawns: [], timers: [], logs: [], kills: [], pgrep: [], clock: Date.parse('2026-11-19T10:00:00Z') };
  w.hash = macAppSourceHash({ root: w.root });
  w.bundle = path.join(w.home, 'Applications', 'T-Agent.app');
  w.plist = path.join(w.bundle, 'Contents', 'Info.plist');
  w.install = info => { fs.mkdirSync(path.dirname(w.plist), { recursive: true }); fs.writeFileSync(w.plist, JSON.stringify(info)); };
  if (installed) w.install({ CFBundleIdentifier: bundleId, CFBundleShortVersionString: '3.2.0', ...(installedHash ? { TAgentSourceHash: installedHash === 'same' ? w.hash : installedHash } : {}) });
  w.spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 5000 + w.spawns.length;
    child.kill = signal => w.kills.push(['child', signal]);
    w.spawns.push({ file, args, options, child });
    return child;
  };
  w.service = autobuild.createMacAppAutobuild({
    dataDir: w.dataDir, root: w.root, platform, env, arch, homedir: () => w.home, pid: 4242, execPath: '/usr/local/bin/node',
    spawn: w.spawn,
    execFile: (file, args, options, done) => { w.pgrep.push([file, ...args]); setImmediate(() => (running ? done(null, '777\n', '') : done(Object.assign(new Error('none'), { code: 1 }), '', ''))); },
    readPlist: async file => JSON.parse(fs.readFileSync(file, 'utf8')),
    now: () => w.clock,
    schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false }; w.timers.push(timer); return timer; },
    cancel: timer => { if (timer) timer.cancelled = true; },
    isAlive: otherPid => otherPid === 9999,
    killGroup: (pid, signal) => w.kills.push([pid, signal]),
    log: line => w.logs.push(line),
  });
  // Fires the pending wait (the 60 s delay) and returns the build promise.
  w.fireDelay = () => {
    const timer = w.timers.find(item => item.ms === autobuild.DELAY_MS && !item.cancelled && !item.fired);
    assert.ok(timer, 'a pending delay');
    timer.fired = true;
    timer.fn();
    return w.service.idle();
  };
  w.untilSpawned = async (count = 1) => { for (let i = 0; i < 100 && w.spawns.length < count; i += 1) await new Promise(resolve => setImmediate(resolve)); assert.equal(w.spawns.length, count); return w.spawns[count - 1]; };
  return w;
}

test('not installed in ~/Applications: nothing happens (an app is never installed by this)', async () => {
  const w = world({ installed: false });
  // An app in /Applications does not count either: only <home>/Applications is looked at.
  const state = await w.service.start();
  assert.equal(state.state, 'idle');
  assert.equal(w.timers.length, 0);
  assert.equal(w.spawns.length, 0);
  assert.ok(!fs.existsSync(path.join(w.home, 'Applications', 'T-Agent.app')));
});

test('the installed app has the current source hash: nothing happens', async () => {
  const w = world({ installedHash: 'same' });
  assert.equal((await w.service.start()).state, 'idle');
  assert.equal(w.timers.length, 0);
  assert.equal(w.spawns.length, 0);
});

test('another app at ~/Applications/T-Agent.app is left alone', async () => {
  const w = world({ bundleId: 'com.example.other' });
  const state = await w.service.start();
  assert.equal(state.state, 'skipped');
  assert.match(state.reason, /is not this app/);
  assert.equal(w.timers.length, 0);
  assert.equal(w.spawns.length, 0);
});

test('a different hash: one build with --install and the host architecture after the delay, at low priority; updated, the running app is left running', async () => {
  const w = world({ env: { pm_id: '3', PATH: '/opt/homebrew/bin', HOME: '/Users/me', TA_HOOK_URL: 'http://x', SESSION_SECRET: 'secret' } });
  const waiting = await w.service.start();
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.version, '3.2.1');
  assert.equal(w.spawns.length, 0, 'nothing runs before the delay');
  assert.equal(w.timers[0].ms, 60 * 1000);
  const done = w.fireDelay();
  const { file, args, options, child } = await w.untilSpawned();
  assert.equal(file, '/usr/bin/nice');
  assert.deepEqual(args, ['-n', '10', '/usr/local/bin/node', path.join(w.root, 'scripts', 'build-mac-app.js'), '--install', '--arch', 'arm64']);
  assert.equal(options.cwd, w.root);
  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'PATH'], 'no token or secret of the server reaches the build');
  assert.equal(w.service.state().state, 'building');
  const lock = JSON.parse(fs.readFileSync(path.join(w.dataDir, autobuild.LOCK_FILE), 'utf8'));
  assert.equal(lock.pid, 4242);
  assert.ok(w.timers.some(timer => timer.ms === 10 * 60 * 1000), 'a 10 minute timeout');
  // The script installs (here: the new Info.plist) and exits 0.
  child.stdout.emit('data', `Building T-Agent.app 3.2.1 for arm64\nInstalled ${w.bundle}. Open it with: open ${w.bundle}\n`);
  w.install({ CFBundleIdentifier: 'local.t-agent.app', CFBundleShortVersionString: '3.2.1', TAgentSourceHash: w.hash });
  child.emit('close', 0, null);
  const state = await done;
  assert.equal(state.state, 'updated');
  assert.equal(state.version, '3.2.1');
  assert.equal(state.restart_needed, true, 'the app runs its old binary until it is opened again');
  assert.deepEqual(w.pgrep[0].slice(0, 2), ['/usr/bin/pgrep', '-f']);
  assert.equal(w.kills.length, 0, 'the running app is never killed');
  assert.ok(!fs.existsSync(path.join(w.dataDir, autobuild.LOCK_FILE)), 'the lock is released');
  assert.ok(!state.log_tail.includes(w.home), 'the log tail shows the home folder as ~');
  assert.match(state.log_tail, /Installed ~\/Applications\/T-Agent\.app/);
  const record = JSON.parse(fs.readFileSync(path.join(w.dataDir, autobuild.STATE_FILE), 'utf8'));
  assert.equal(record.state, 'updated');
  assert.equal(record.hash, w.hash);
  assert.equal((fs.statSync(path.join(w.dataDir, autobuild.STATE_FILE)).mode & 0o777), 0o600);
  assert.equal(w.spawns.length, 1, 'one build');
});

test('an app built before this change (no TAgentSourceHash) is rebuilt once; Intel builds x86_64; an app that is not running needs no restart', async () => {
  const w = world({ installedHash: null, arch: 'x64', running: false });
  assert.equal((await w.service.start()).state, 'waiting');
  const done = w.fireDelay();
  const { args, child } = await w.untilSpawned();
  assert.deepEqual(args.slice(-2), ['--arch', 'x86_64']);
  w.install({ CFBundleIdentifier: 'local.t-agent.app', TAgentSourceHash: w.hash });
  child.emit('close', 0, null);
  const state = await done;
  assert.equal(state.state, 'updated');
  assert.equal(state.restart_needed, false);
  // The next start finds the same hash: nothing more.
  const again = world({ installedHash: 'same', dataDir: w.dataDir, root: w.root });
  assert.equal((await again.service.start()).state, 'idle');
  assert.equal(again.timers.length, 0);
});

test('the lock: a build held by another live server is skipped; a stale lock is taken over; two services never build at once', async () => {
  const held = world();
  fs.writeFileSync(path.join(held.dataDir, autobuild.LOCK_FILE), JSON.stringify({ pid: 9999, at: new Date(held.clock).toISOString() }));
  await held.service.start();
  const state = await held.fireDelay();
  assert.equal(state.state, 'skipped');
  assert.equal(state.reason, 'Another T-Agent server is rebuilding the app');
  assert.equal(held.spawns.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(held.dataDir, autobuild.LOCK_FILE), 'utf8')).pid, 9999, 'the other lock is kept');

  const stale = world();
  fs.writeFileSync(path.join(stale.dataDir, autobuild.LOCK_FILE), JSON.stringify({ pid: 1234, at: new Date(stale.clock).toISOString() }));
  await stale.service.start();
  const done = stale.fireDelay();
  const { child } = await stale.untilSpawned();
  // A second service on the same data folder while the first builds.
  const second = world({ dataDir: stale.dataDir, root: stale.root });
  second.service = autobuild.createMacAppAutobuild({
    dataDir: stale.dataDir, root: stale.root, platform: 'darwin', env: { pm_id: '1' }, arch: 'arm64', homedir: () => stale.home, pid: 4343,
    now: () => stale.clock, // the lock's age is read on the same fake clock that wrote it (with the real clock the lock looked stale after 10:11Z)
    spawn: second.spawn, execFile: () => {}, readPlist: async file => JSON.parse(fs.readFileSync(file, 'utf8')),
    schedule: (fn, ms) => { const timer = { fn, ms }; second.timers.push(timer); return timer; }, cancel: () => {},
    isAlive: otherPid => otherPid === 4242, log: () => {},
  });
  assert.equal((await second.service.start()).state, 'waiting');
  second.timers[0].fn();
  assert.equal((await second.service.idle()).state, 'skipped');
  assert.equal(second.spawns.length, 0, 'the second service does not build');
  child.emit('close', 1, null);
  await done;
  assert.ok(!fs.existsSync(path.join(stale.dataDir, autobuild.LOCK_FILE)));
});

test('a failed build is recorded with its reason and not tried again for the same source; another source tries once more', async () => {
  const w = world();
  await w.service.start();
  const done = w.fireDelay();
  const { child } = await w.untilSpawned();
  child.stdout.emit('data', `Building T-Agent.app 3.2.1 for arm64 from 3 Swift file(s) in ${path.join(os.tmpdir(), 'ta-mac-app-x')}\n`);
  child.stderr.emit('data', 'swiftc was not found. Install the Xcode command line tools: xcode-select --install\n');
  child.emit('close', 1, null);
  const state = await done;
  assert.equal(state.state, 'failed');
  assert.equal(state.reason, 'swiftc was not found. Install the Xcode command line tools: xcode-select --install');
  assert.match(state.log_tail, /<tmp>\/ta-mac-app-x/);
  assert.ok(!state.log_tail.includes(os.tmpdir()));
  assert.equal(w.spawns.length, 1);
  assert.equal(w.timers.filter(timer => timer.ms === autobuild.DELAY_MS).length, 1, 'no retry in the same run');
  assert.equal(JSON.parse(fs.readFileSync(w.plist, 'utf8')).TAgentSourceHash, 'old', 'the installed app is untouched');

  // The next start with the same source: the failure is shown, nothing is built.
  const next = world({ dataDir: w.dataDir, root: w.root });
  const shown = await next.service.start();
  assert.equal(shown.state, 'failed');
  assert.equal(shown.reason, state.reason);
  assert.equal(next.timers.length, 0);
  // A compile error: the first line and the compiler's line.
  fs.appendFileSync(path.join(w.root, 'apps', 'macos', 'A.swift'), '// new\n');
  const changed = world({ dataDir: w.dataDir, root: w.root });
  assert.equal((await changed.service.start()).state, 'waiting', 'a new source hash tries again');
  const again = changed.fireDelay();
  const build = await changed.untilSpawned();
  build.child.stderr.emit('data', 'Could not build for arm64:\nA.swift:1:1: error: cannot find foo in scope\n');
  build.child.emit('close', 1, null);
  assert.equal((await again).reason, 'Could not build for arm64: A.swift:1:1: error: cannot find foo in scope');
});

test('a build that exits 0 but did not install the new hash is a failure; a timeout ends the build', async () => {
  const w = world();
  await w.service.start();
  let done = w.fireDelay();
  let { child } = await w.untilSpawned();
  child.emit('close', 0, null);
  assert.equal((await done).state, 'failed');

  const slow = world();
  await slow.service.start();
  done = slow.fireDelay();
  ({ child } = await slow.untilSpawned());
  slow.timers.find(timer => timer.ms === autobuild.TIMEOUT_MS).fn();
  assert.deepEqual(slow.kills, [[child.pid, 'SIGKILL']], 'the whole process group is ended');
  child.emit('close', null, 'SIGKILL');
  const state = await done;
  assert.equal(state.state, 'failed');
  assert.equal(state.reason, 'The build took longer than 10 minutes');
});

test('the server stops: a waiting build never starts, a running one is ended and the lock released', async () => {
  const waiting = world();
  await waiting.service.start();
  waiting.service.stop();
  assert.ok(waiting.timers[0].cancelled);
  assert.equal(waiting.service.state().state, 'skipped');

  const building = world();
  await building.service.start();
  building.fireDelay();
  const { child } = await building.untilSpawned();
  building.service.stop();
  assert.deepEqual(building.kills, [[child.pid, 'SIGTERM']]);
  assert.ok(!fs.existsSync(path.join(building.dataDir, autobuild.LOCK_FILE)));
});

test('off switches: test mode, TA_MAC_APP_AUTOBUILD=0, CI, a T-Agent terminal without PM2; and other platforms', async () => {
  for (const [env, reason] of [
    [{ NODE_ENV: 'test' }, 'Off: the server runs in test mode'],
    [{ TA_MAC_APP_AUTOBUILD: '0' }, 'Off: TA_MAC_APP_AUTOBUILD=0'],
    [{ CI: 'true' }, 'Off: the server runs in CI'],
    [{ TA_PEER_TASK: '7' }, 'Off: the server runs inside a T-Agent terminal'],
    [{ TA_HOOK_TOKEN: 'x' }, 'Off: the server runs inside a T-Agent terminal'],
  ]) {
    assert.equal(autobuild.blockedReason(env), reason);
    const w = world({ env });
    const state = await w.service.start();
    assert.equal(state.state, 'idle');
    assert.equal(state.reason, reason);
    assert.equal(w.timers.length, 0);
    assert.equal(w.spawns.length, 0);
  }
  for (const env of [{ CI: 'false' }, { CI: '0' }, { TA_PEER_TASK: '7', pm_id: '2' }, { TA_MAC_APP_AUTOBUILD: '1' }]) assert.equal(autobuild.blockedReason(env), null);
  const linux = world({ platform: 'linux' });
  assert.equal(await linux.service.start(), linux.service.state());
  assert.equal(linux.service.state(), null);
  assert.equal(linux.service.currentHash(), null);
  assert.equal(linux.timers.length, 0);
  assert.equal(autobuild.hostArch('arm64'), 'arm64');
  assert.equal(autobuild.hostArch('x64'), 'x86_64');
  assert.equal(autobuild.hostArch('ia32'), null);
});

test('server.js starts it after listen and stops it at exit; the build script is the one --install runs', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /createMacAppAutobuild\(\{ dataDir: dataHome\.paths\(\)\.root \}\)/);
  assert.match(server, /void macAppRebuild\.start\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(server, /macAppRebuild\.stop\(\);/);
  assert.ok(server.indexOf('void macAppRebuild.start()') > server.indexOf('server.listen('), 'started after listen');
});
