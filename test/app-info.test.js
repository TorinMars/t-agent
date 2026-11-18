// app.json for the T-Agent macOS app and GET /api/system/app-info (services/app-info.js, routes/system.js): the pure build of the
// object and its web addresses, the atomic 0600 write that happens only when something changed, the lookup of the installed app,
// and the route. Everything runs on a temporary data folder; nothing reads the real ~/.tagent or ~/Applications.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-app-info-'));
process.env.TAGENT_HOME = path.join(root, 'data');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const appInfo = require('../services/app-info');

const IFACES = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
  en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.20', family: 'IPv4', internal: false }],
  en1: [{ address: '10.0.0.5', family: 4, internal: false }],
  utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false }], // not RFC 1918: left out
  bridge0: [{ address: '172.20.0.1', family: 'IPv4', internal: false }, { address: '172.32.0.1', family: 'IPv4', internal: false }],
};

test('listenUrl: loopback for every interface and localhost, the address itself otherwise (IPv6 in brackets)', () => {
  assert.equal(appInfo.listenUrl({ host: '0.0.0.0', port: 3000 }), 'http://127.0.0.1:3000');
  assert.equal(appInfo.listenUrl({ host: '::', port: 3000 }), 'http://127.0.0.1:3000');
  assert.equal(appInfo.listenUrl({ host: '', port: 3000 }), 'http://127.0.0.1:3000');
  assert.equal(appInfo.listenUrl({ host: 'localhost', port: 3000 }), 'http://127.0.0.1:3000');
  assert.equal(appInfo.listenUrl({ host: '127.0.0.1', port: 3999 }), 'http://127.0.0.1:3999');
  assert.equal(appInfo.listenUrl({ host: '192.168.1.20', port: 3000 }), 'http://192.168.1.20:3000');
  assert.equal(appInfo.listenUrl({ host: '::1', port: 3000 }), 'http://[::1]:3000');
});

test('lanAddresses: the private IPv4s on every interface, only the one listened on, none on loopback', () => {
  const all = appInfo.lanAddresses({ host: '0.0.0.0', port: 3000, interfaces: IFACES });
  assert.deepEqual(all, [
    { kind: 'lan', label: 'Local network (en0)', url: 'http://192.168.1.20:3000' },
    { kind: 'lan', label: 'Local network (en1)', url: 'http://10.0.0.5:3000' },
    { kind: 'lan', label: 'Local network (bridge0)', url: 'http://172.20.0.1:3000' },
  ]);
  assert.deepEqual(appInfo.lanAddresses({ host: '::', port: 3000, interfaces: IFACES }), all);
  assert.deepEqual(appInfo.lanAddresses({ host: '10.0.0.5', port: 3000, interfaces: IFACES }).map(entry => entry.url), ['http://10.0.0.5:3000']);
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.deepEqual(appInfo.lanAddresses({ host, port: 3000, interfaces: IFACES }), []);
  assert.deepEqual(appInfo.lanAddresses({ host: '0.0.0.0', port: 3000, interfaces: undefined }), []);
  assert.equal(appInfo.privateIPv4('172.15.0.1'), false);
  assert.equal(appInfo.privateIPv4('192.169.0.1'), false);
  assert.equal(appInfo.privateIPv4('10.0.0'), false);
});

test('remoteAddresses: only running tunnels and a configured page address, never a URL with credentials, query or fragment', () => {
  const frp = { status: 'running', config: { serverAddr: '203.0.113.7', domain: '', remotePort: 23456, tokenCipher: 'secret-cipher' } };
  const ssh = { status: 'running', config: { host: 'jump.example.com', remotePort: 34567, bindAll: true, keyPath: '/Users/me/.ssh/id' } };
  assert.deepEqual(appInfo.remoteAddresses({ frp, ssh, publicUrl: 'https://agent.example.com/' }), [
    { kind: 'remote', label: 'Remote (frp)', url: 'http://203.0.113.7:23456' },
    { kind: 'remote', label: 'Remote (SSH tunnel)', url: 'http://jump.example.com:34567' },
    { kind: 'remote', label: 'Remote (public page address)', url: 'https://agent.example.com' },
  ]);
  // The frp domain (resolved to the frps server by the user) wins over the server address, as in its publicAddress.
  assert.equal(appInfo.remoteAddresses({ frp: { ...frp, config: { ...frp.config, domain: 'app.example.com' } } })[0].url, 'http://app.example.com:23456');
  assert.equal(appInfo.remoteAddresses({ frp: { ...frp, config: { ...frp.config, serverAddr: '2001:db8::1' } } })[0].url, 'http://[2001:db8::1]:23456');
  // Not running, not configured, or bound to the server's loopback: nothing.
  for (const status of ['stopped', 'starting', 'failed']) {
    assert.deepEqual(appInfo.remoteAddresses({ frp: { ...frp, status }, ssh: { ...ssh, status } }), []);
  }
  assert.deepEqual(appInfo.remoteAddresses({ frp: { status: 'running', config: { serverAddr: '', remotePort: 1 } } }), []);
  assert.deepEqual(appInfo.remoteAddresses({ frp: { status: 'running', config: { serverAddr: 'x.example.com', remotePort: 0 } } }), []);
  assert.deepEqual(appInfo.remoteAddresses({ ssh: { ...ssh, config: { ...ssh.config, bindAll: false } } }), []);
  for (const bad of ['https://user:pass@agent.example.com', 'https://agent.example.com/?token=abc', 'https://agent.example.com/#t=1', 'ftp://agent.example.com', 'javascript:alert(1)', 'not a url']) {
    assert.deepEqual(appInfo.remoteAddresses({ publicUrl: bad }), [], bad);
  }
  const text = JSON.stringify(appInfo.remoteAddresses({ frp, ssh }));
  assert.ok(!text.includes('secret-cipher') && !text.includes('.ssh'), 'no tunnel secret or key path is copied');
});

test('buildAddresses: this computer first, then the LAN and the remote ones, each URL once', () => {
  const remote = [{ kind: 'remote', label: 'Remote (frp)', url: 'http://203.0.113.7:23456' }, { kind: 'remote', label: 'Again', url: 'http://203.0.113.7:23456' }];
  assert.deepEqual(appInfo.buildAddresses({ host: '0.0.0.0', port: 3000, interfaces: { en0: IFACES.en0 }, remote }), [
    { kind: 'local', label: 'This computer', url: 'http://127.0.0.1:3000' },
    { kind: 'lan', label: 'Local network (en0)', url: 'http://192.168.1.20:3000' },
    { kind: 'remote', label: 'Remote (frp)', url: 'http://203.0.113.7:23456' },
  ]);
  // Listening on one LAN address: the app uses that address, and it is listed once.
  assert.deepEqual(appInfo.buildAddresses({ host: '192.168.1.20', port: 3000, interfaces: IFACES }), [
    { kind: 'local', label: 'This computer', url: 'http://192.168.1.20:3000' },
  ]);
  assert.deepEqual(appInfo.buildAddresses({ host: '127.0.0.1', port: 3000, interfaces: IFACES }).map(entry => entry.kind), ['local']);
});

test('pm2Name: the PM2 name (or id) only when PM2 runs the server', () => {
  assert.equal(appInfo.pm2Name({ name: 't-agent', pm_id: '3' }, 'pm2'), 't-agent');
  assert.equal(appInfo.pm2Name({ pm_id: '3' }, 'pm2'), '3');
  assert.equal(appInfo.pm2Name({ pm_id: 0 }, 'pm2'), '0');
  assert.equal(appInfo.pm2Name({ name: 't-agent', pm_id: '3' }, null), null, 'inherited from a terminal of a PM2 service');
  assert.equal(appInfo.pm2Name({ name: 't-agent' }, 'launchd'), null);
  assert.equal(appInfo.pm2Name({}, 'pm2'), null);
});

test('launchdLabel: the job label launchd sets, only when launchd runs the server', () => {
  assert.equal(appInfo.launchdLabel({ XPC_SERVICE_NAME: 'com.tagent.client' }, 'launchd'), 'com.tagent.client');
  assert.equal(appInfo.launchdLabel({ XPC_SERVICE_NAME: 'com.tagent.client' }, 'pm2'), null);
  assert.equal(appInfo.launchdLabel({ XPC_SERVICE_NAME: 'com.tagent.client' }, null), null, 'a Terminal window or a shell');
  for (const value of [undefined, '', '0', 'application.com.apple.Terminal.123']) assert.equal(appInfo.launchdLabel({ XPC_SERVICE_NAME: value }, 'launchd'), null);
  const info = appInfo.buildAppInfo({ host: '127.0.0.1', port: 1, pid: 1, installDir: '/x', supervisor: 'launchd', launchdLabel: 'com.tagent.client' });
  assert.equal(info.launchd_label, 'com.tagent.client');
});

test('buildAppInfo: every field of the contract', () => {
  const now = new Date('2026-11-18T10:00:00.000Z');
  const info = appInfo.buildAppInfo({ host: '0.0.0.0', port: 3000, version: '2.133.1', pid: 4242, installDir: '/opt/t-agent', supervisor: 'pm2', pm2Name: 't-agent', addresses: [], now });
  assert.deepEqual(info, {
    url: 'http://127.0.0.1:3000', version: '2.133.1', pid: 4242, install_dir: '/opt/t-agent', supervisor: 'pm2', pm2_name: 't-agent', launchd_label: null,
    updated_at: '2026-11-18T10:00:00.000Z', addresses: [],
  });
  const bare = appInfo.buildAppInfo({ host: '127.0.0.1', port: 1, pid: 1, installDir: '/x', now });
  assert.equal(bare.supervisor, null);
  assert.equal(bare.pm2_name, null);
  assert.equal(bare.version, null);
});

test('the publisher writes app.json atomically with mode 0600, again only when something changed, and every minute at most', t => {
  const dir = fs.mkdtempSync(path.join(root, 'publish-'));
  const file = path.join(dir, 'home', 'app.json');
  const world = { addresses: [{ kind: 'local', label: 'This computer', url: 'http://127.0.0.1:3000' }] };
  let clock = Date.parse('2026-11-18T10:00:00.000Z');
  const writes = [];
  const timers = [];
  const publisher = appInfo.createAppInfoPublisher({
    file,
    collect: () => ({ host: '127.0.0.1', port: 3000, version: '1.2.3', pid: 77, installDir: '/opt/t-agent', supervisor: null, addresses: world.addresses }),
    now: () => new Date(clock),
    write: (target, info) => { writes.push(info); appInfo.writeAppInfo(target, info); },
    schedule: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    cancel: () => {},
  });
  publisher.start();
  assert.equal(writes.length, 1);
  assert.deepEqual(timers.map(timer => timer.ms), [60000]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.url, 'http://127.0.0.1:3000');
  assert.equal(written.updated_at, '2026-11-18T10:00:00.000Z');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['app.json'], 'no temporary file is left');

  clock += 60000;
  timers[0].fn();
  assert.equal(writes.length, 1, 'nothing changed: no write');
  world.addresses = [...world.addresses, { kind: 'remote', label: 'Remote (frp)', url: 'http://203.0.113.7:23456' }];
  clock += 60000;
  publisher.refresh();
  assert.equal(writes.length, 2, 'a new address: written again');
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(again.addresses.length, 2);
  assert.equal(again.updated_at, '2026-11-18T10:02:00.000Z');
  assert.equal(publisher.current().addresses.length, 2);
  t.after(() => publisher.stop());
});

test('a failing write is logged once and does not throw; the next refresh tries again', () => {
  const warnings = [];
  let fail = true;
  let writes = 0;
  const publisher = appInfo.createAppInfoPublisher({
    file: path.join(root, 'never', 'app.json'),
    collect: () => ({ host: '127.0.0.1', port: 3000, pid: 1, installDir: '/x' }),
    write: () => { writes += 1; if (fail) throw new Error('read-only'); },
    schedule: () => null,
    warn: message => warnings.push(message),
  });
  publisher.start();
  publisher.refresh();
  assert.equal(warnings.length, 1);
  assert.equal(writes, 2);
  fail = false;
  publisher.refresh();
  assert.equal(writes, 3);
  assert.equal(publisher.current().url, 'http://127.0.0.1:3000');
});

test('the Mac app probe: ~/Applications first, then /Applications, its version against the server, cached for 30 s, null off macOS', async () => {
  const home = path.join(root, 'home');
  const present = new Set([path.join(home, 'Applications/T-Agent.app/Contents/Info.plist'), '/Applications/T-Agent.app/Contents/Info.plist']);
  let clock = 0;
  const reads = [];
  const versions = { [path.join(home, 'Applications/T-Agent.app/Contents/Info.plist')]: '2.133.1', '/Applications/T-Agent.app/Contents/Info.plist': '2.0.0' };
  const make = (extra = {}) => appInfo.createMacAppProbe({
    platform: 'darwin', homedir: () => home, exists: file => present.has(file), now: () => clock,
    readPlist: async file => { reads.push(file); return { CFBundleShortVersionString: versions[file], CFBundleIdentifier: 'local.t-agent.app' }; },
    serverVersion: () => '2.133.1', ...extra,
  });
  const probe = make();
  assert.deepEqual(await probe.probe(), { installed: true, path: path.join(home, 'Applications/T-Agent.app'), version: '2.133.1', matches_server: true });
  clock += 29000;
  await probe.probe();
  assert.equal(reads.length, 1, 'cached');
  clock += 2000;
  present.delete(path.join(home, 'Applications/T-Agent.app/Contents/Info.plist'));
  assert.deepEqual(await probe.probe(), { installed: true, path: '/Applications/T-Agent.app', version: '2.0.0', matches_server: false });
  assert.equal(reads.length, 2);
  present.clear();
  clock += 31000;
  assert.deepEqual(await probe.probe(), { installed: false, path: null, version: null, matches_server: false });
  const unreadable = appInfo.createMacAppProbe({ platform: 'darwin', homedir: () => home, exists: () => true, readPlist: async () => { throw new Error('bad plist'); }, serverVersion: () => '1' });
  assert.deepEqual(await unreadable.probe(), { installed: true, path: path.join(home, 'Applications/T-Agent.app'), version: null, matches_server: false });
  assert.equal(await make({ platform: 'linux' }).probe(), null);
});

test('readPlistWithPlutil reads a real Info.plist (macOS only)', { skip: process.platform !== 'darwin' }, async () => {
  const file = path.join(root, 'Info.plist');
  fs.writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>9.8.7</string></dict></plist>\n');
  assert.deepEqual(await appInfo.readPlistWithPlutil(file), { CFBundleShortVersionString: '9.8.7' });
});

// GET /api/system/app-info behind the same gates as the other /api/system routes; the database, update manager and auth are stubs.
function stub(name, exports) {
  const resolved = require.resolve(name);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

test('GET /api/system/app-info: the addresses of app.json, the installed app and the server, behind the login', async t => {
  const world = { loggedIn: true };
  stub('../services/update-manager', { readLocalManifest: () => ({ app_version: '2.133.1' }) });
  stub('../middleware/auth', (req, res, next) => (world.loggedIn ? next() : res.status(401).json({ error: 'AUTH_REQUIRED' })));
  stub('../db', { prepare: () => ({ get: () => null }) });
  stub('../services/engine-name', { engineNameState: () => ({ name: 'test' }) });
  const router = require('../routes/system');
  const app = express();
  app.use('/api', require('../middleware/client-origin'));
  app.use('/api/system', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/system/app-info`;
  const get = async () => { const response = await fetch(base); return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }; };

  const file = path.join(process.env.TAGENT_HOME, 'app.json');
  const addresses = [{ kind: 'local', label: 'This computer', url: 'http://127.0.0.1:3999' }];
  const publisher = appInfo.createAppInfoPublisher({
    file, schedule: () => null,
    collect: () => ({ host: '127.0.0.1', port: 3999, version: '2.133.1', pid: process.pid, installDir: '/opt/t-agent', addresses }),
  });
  publisher.start();
  appInfo.setSharedPublisher(publisher);
  t.after(() => appInfo.setSharedPublisher(null));
  let probes = 0;
  router.setMacAppProbe({ probe: async () => { probes += 1; return { installed: true, path: '/Users/me/Applications/T-Agent.app', version: '2.133.0', matches_server: false }; } });

  let answer = await get();
  assert.equal(answer.status, 200);
  assert.equal(answer.cache, 'no-store');
  assert.deepEqual(answer.body, {
    addresses,
    app: { installed: true, path: '/Users/me/Applications/T-Agent.app', version: '2.133.0', matches_server: false },
    server: { version: '2.133.1', install_dir: '/opt/t-agent' },
  });
  assert.equal(probes, 1);

  // A new address shows up on the next read, and app.json is rewritten with it.
  addresses.push({ kind: 'lan', label: 'Local network (en0)', url: 'http://192.168.1.20:3999' });
  answer = await get();
  assert.equal(answer.body.addresses.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).addresses.length, 2);

  // Not on macOS: app is null.
  router.setMacAppProbe(appInfo.createMacAppProbe({ platform: 'linux' }));
  assert.equal((await get()).body.app, null);

  world.loggedIn = false;
  assert.equal((await get()).status, 401);
});

// The real server writes app.json in its data folder once it listens (NODE_ENV=test keeps the desktop window off).
test('server.js writes <data home>/app.json at listen time: loopback URL, its pid, version and install folder, mode 0600', async t => {
  const { spawn } = require('node:child_process');
  const repo = path.resolve(__dirname, '..');
  const home = fs.mkdtempSync(path.join(root, 'server-'));
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'app-info-test-secret-'.repeat(3), TAGENT_HOME: home, TASKS_BASE_DIR: path.join(home, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local' };
  delete env.T_AGENT_DATA_DIR;
  delete env.T_AGENT_DB_PATH;
  const child = spawn(process.execPath, ['server.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); }); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 15000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => { output += chunk; const m = output.match(/Server running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
  });
  const file = path.join(home, 'app.json');
  const end = Date.now() + 5000;
  while (!fs.existsSync(file) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'VERSION.json'), 'utf8')).app_version;
  assert.equal(info.url, `http://127.0.0.1:${port}`);
  assert.equal(info.pid, child.pid);
  assert.equal(info.version, version);
  assert.equal(fs.realpathSync(info.install_dir), fs.realpathSync(repo));
  assert.equal(info.supervisor, null, 'started by hand, not by a process manager');
  assert.equal(info.pm2_name, null);
  assert.equal(info.launchd_label, null);
  assert.ok(!Number.isNaN(Date.parse(info.updated_at)));
  assert.deepEqual(info.addresses, [{ kind: 'local', label: 'This computer', url: `http://127.0.0.1:${port}` }]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!/secret/i.test(fs.readFileSync(file, 'utf8')), 'no secret in the file');
});
