const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createFrpService, renderToml } = require('../services/frp');
const { createFrpRouter } = require('../routes/frp');

const SECRET = 'session-secret';
const TOKEN = 'frps-super-token';

// A fake frpc: prints typical frp logs depending on mode. The conflict mode reports "port in use" when the remote port equals FAIL_PORT.
function fakeFrpc(dir, mode = 'ok') {
  const bin = path.join(dir, 'frpc');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const cfg = fs.readFileSync(process.argv[3], 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'configs.log'))}, cfg + '\\n---\\n');
const port = Number(/remotePort = (\\d+)/.exec(cfg)[1]);
if (${JSON.stringify(mode)} === 'conflict' && port === 25000) { console.error('[W] [proxy/manager.go] proxy tcp start error: port already used'); process.exit(1); }
if (${JSON.stringify(mode)} === 'login') { console.error('login to server failed: token in login doesn\\'t match token from configuration'); process.exit(1); }
console.log('[I] login to server success');
console.log('[I] [t-agent] start proxy success');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return bin;
}

function setup(t, { mode = 'ok', random } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-test-'));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const service = createFrpService({ db, secret: SECRET, dataDir: dir, localPort: 3000, bin: fakeFrpc(dir, mode), random });
  t.after(() => { service.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, service };
}
const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Wait timed out');
};

test('The random remote port is within range and stays stable once generated', t => {
  const { service } = setup(t);
  const first = service.update({ serverAddr: '1.2.3.4', portMin: 30000, portMax: 30010 }).config.remotePort;
  assert.ok(first >= 30000 && first <= 30010);
  for (let i = 0; i < 5; i += 1) assert.equal(service.update({ domain: 'a.example.com' }).config.remotePort, first);
});

test('Regenerating the port gives a new value that stays within range', t => {
  let n = 0;
  const { service } = setup(t, { random: (min, max) => min + (n++ % (max - min + 1)) });
  const first = service.update({ serverAddr: '1.2.3.4', portMin: 40000, portMax: 40100 }).config.remotePort;
  const next = service.regenerate().config.remotePort;
  assert.notEqual(next, first);
  assert.ok(next >= 40000 && next <= 40100);
});

test('Config validation: invalid server address, port, domain and range are all rejected', t => {
  const { service } = setup(t);
  for (const bad of [
    { serverAddr: 'a b' }, { serverAddr: 'x"y' }, { serverPort: 0 }, { serverPort: 70000 }, { serverPort: 'abc' },
    { domain: '1.2.3.4' }, { domain: 'bad_domain!' }, { localPort: 99999 }, { portMin: 5000, portMax: 4000 }, { token: 'a\nb' },
  ]) assert.throws(() => service.update(bad), e => e.code && e.code.startsWith('FRP_'), JSON.stringify(bad));
});

test('The token is stored encrypted; there is no plaintext in the view or the database', t => {
  const { service, db } = setup(t);
  const view = service.update({ serverAddr: '1.2.3.4', token: TOKEN });
  assert.equal(view.config.hasToken, true);
  assert.ok(!JSON.stringify(view).includes(TOKEN));
  assert.ok(!db.prepare('SELECT value FROM system_state').get().value.includes(TOKEN));
  // A token that is not passed stays unchanged; an empty string clears it
  assert.equal(service.update({ domain: 'a.example.com' }).config.hasToken, true);
  assert.equal(service.update({ token: '' }).config.hasToken, false);
});

test('Render TOML: correct escaping, the tcp proxy points at the local port and the random remote port', () => {
  const toml = renderToml({ serverAddr: '1.2.3.4', serverPort: 7000, token: 'a"b', proxyName: 'p', localIP: '127.0.0.1', localPort: 3000, remotePort: 28888 });
  assert.match(toml, /serverAddr = "1\.2\.3\.4"/);
  assert.match(toml, /auth\.token = "a\\"b"/);
  assert.match(toml, /type = "tcp"/);
  assert.match(toml, /localPort = 3000/);
  assert.match(toml, /remotePort = 28888/);
});

test('Start: writes a 0600 config, running once the log shows start proxy success, stopped after stopping', async t => {
  const { service, dir } = setup(t);
  service.update({ serverAddr: '1.2.3.4', serverPort: 7100, token: TOKEN, domain: 'app.example.com' });
  service.start();
  await until(() => service.view().status === 'running');
  const file = path.join(dir, 'frpc.toml');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const toml = fs.readFileSync(file, 'utf8');
  assert.match(toml, /serverPort = 7100/);
  assert.match(toml, /localPort = 3000/);
  const view = service.view();
  assert.equal(view.config.publicAddress, `app.example.com:${view.config.remotePort}`);
  assert.ok(!JSON.stringify(view).includes(TOKEN));
  assert.throws(() => service.start(), e => e.code === 'FRP_ALREADY_RUNNING');
  service.stop();
  assert.equal(service.view().status, 'stopped');
});

test('When the port is taken it retries with another port automatically', async t => {
  const ports = [25000, 26000];
  const { service } = setup(t, { mode: 'conflict', random: () => ports.shift() ?? 27000 });
  service.update({ serverAddr: '1.2.3.4' });
  assert.equal(service.view().config.remotePort, 25000);
  service.start();
  await until(() => service.view().status === 'running');
  assert.equal(service.view().config.remotePort, 26000);
  assert.ok(service.view().logs.some(line => line.includes('retrying with 26000')));
});

test('A clear reason is given when logging in to frps fails', async t => {
  const { service } = setup(t, { mode: 'login' });
  service.update({ serverAddr: '1.2.3.4' });
  service.start();
  await until(() => service.view().status === 'failed');
  assert.match(service.view().error, /Logging in to frps failed/);
});

test('Starting is refused when no server address is filled in', t => {
  const { service } = setup(t);
  assert.throws(() => service.start(), e => e.code === 'FRP_SERVER_REQUIRED');
});

test('An invalid frpc path marks failure instead of crashing', async t => {
  const { db, dir } = setup(t);
  const service = createFrpService({ db, secret: SECRET, dataDir: dir, localPort: 3000, bin: path.join(dir, 'missing-frpc') });
  service.update({ serverAddr: '1.2.3.4' });
  service.start();
  await until(() => service.view().status === 'failed');
  assert.match(service.view().error, /Cannot start frpc/);
});

test('Routes: login required, config updates and status do not leak the Token', async t => {
  const { service } = setup(t);
  const app = express();
  app.use(express.json());
  app.use('/api/frp', createFrpRouter({ service, requireAuth: (req, res, next) => (req.get('x-test-auth') ? next() : res.status(401).json({ error: 'NO' })) }));
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/frp`;
  const headers = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', 'x-test-auth': '1' };
  assert.equal((await fetch(base, { headers: { 'x-requested-with': 'XMLHttpRequest' } })).status, 401);
  const saved = await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ serverAddr: '1.2.3.4', token: TOKEN }) });
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes(TOKEN));
  const bad = await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ serverPort: 0 }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'FRP_SERVER_PORT_INVALID');
});

// ── frpc install ──
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { installFrpc } = require('../services/frp-install');

function releaseFixture(t, { tamper = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = 'frp_0.61.1_linux_amd64';
  fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, name, 'frpc'), '#!/bin/sh\necho frpc\n');
  fs.writeFileSync(path.join(dir, name, 'frps'), 'x');
  execFileSync('tar', ['-czf', path.join(dir, `${name}.tar.gz`), '-C', dir, name]);
  const archive = fs.readFileSync(path.join(dir, `${name}.tar.gz`));
  const sum = crypto.createHash('sha256').update(tamper ? Buffer.from('other') : archive).digest('hex');
  const urls = [];
  const download = async url => {
    urls.push(url);
    if (url.endsWith('frp_sha256_checksums.txt')) return `${sum}  ${name}.tar.gz\n`;
    return archive;
  };
  return { download, urls };
}

test('Install frpc: after verification only the executable frpc is put into binDir', async t => {
  const { download, urls } = releaseFixture(t);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-bin-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const result = await installFrpc({ binDir, platform: 'linux', arch: 'x64', base: 'https://mirror.test/frp/', download });
  assert.equal(result.path, path.join(binDir, 'frpc'));
  assert.equal(fs.statSync(result.path).mode & 0o111, 0o111);
  assert.deepEqual(fs.readdirSync(binDir), ['frpc']);
  assert.ok(urls.every(url => url.startsWith('https://mirror.test/frp/v0.61.1/')));
});

test('Install frpc: refused when the checksum mismatches or the platform is unsupported, leaving no files behind', async t => {
  const { download } = releaseFixture(t, { tamper: true });
  const binDir = path.join(os.tmpdir(), `frp-bin-${process.pid}-bad`);
  await assert.rejects(installFrpc({ binDir, platform: 'linux', arch: 'x64', download }), e => e.code === 'FRP_INSTALL_CHECKSUM_FAILED');
  assert.equal(fs.existsSync(binDir), false);
  await assert.rejects(installFrpc({ binDir, platform: 'win32', arch: 'x64', download }), e => e.code === 'FRP_INSTALL_UNSUPPORTED');
  await assert.rejects(installFrpc({ binDir, platform: 'linux', arch: 'x64', download: async () => { throw new Error('net'); } }), e => e.code === 'FRP_INSTALL_DOWNLOAD_FAILED');
});

test('Service: frpc is detected after installation; a reason is given on failure; installing twice is refused', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-svc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  t.after(() => db.close());
  const original = process.env.T_AGENT_FRPC_BIN;
  process.env.T_AGENT_FRPC_BIN = '';
  t.after(() => { if (original === undefined) delete process.env.T_AGENT_FRPC_BIN; else process.env.T_AGENT_FRPC_BIN = original; });
  let fail = true;
  const installer = async ({ binDir }) => {
    if (fail) { const { FrpInstallError } = require('../services/frp-install'); throw new FrpInstallError('X', 'Downloading frp failed'); }
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'frpc'), '#!/bin/sh\n', { mode: 0o755 });
  };
  const service = createFrpService({ db, secret: SECRET, dataDir: dir, localPort: 3000, installer });
  assert.equal(service.view().installed, false);
  service.install();
  assert.equal(service.view().installing, true);
  assert.throws(() => service.install(), e => e.code === 'FRP_INSTALL_RUNNING');
  await until(() => !service.view().installing);
  assert.equal(service.view().installError, 'Downloading frp failed');
  fail = false;
  service.install();
  await until(() => service.view().installed && !service.view().installing);
  assert.equal(service.view().installError, '');
  assert.throws(() => service.install(), e => e.code === 'FRP_ALREADY_INSTALLED');
});

// ── Manual remote port ──
test('Manual remote port: used as-is, can be outside the random range, a range change does not alter it; clearing it restores random', t => {
  const { service } = setup(t);
  service.update({ serverAddr: '1.2.3.4', portMin: 30000, portMax: 30010 });
  const manual = service.update({ remotePort: '8080' }).config;
  assert.equal(manual.remotePort, 8080);
  assert.equal(manual.remotePortManual, true);
  assert.equal(service.update({ portMin: 31000, portMax: 31010, domain: 'a.example.com' }).config.remotePort, 8080);
  assert.equal(service.update({ autoStart: true }).config.remotePortManual, true);
  const auto = service.update({ remotePort: '' }).config;
  assert.equal(auto.remotePortManual, false);
  assert.ok(auto.remotePort >= 31000 && auto.remotePort <= 31010);
  service.update({ remotePort: 9000 });
  assert.equal(service.regenerate().config.remotePortManual, false);
  for (const bad of ['abc', 0.5, 70000, -1, '1e3']) assert.throws(() => service.update({ remotePort: bad }), e => e.code === 'FRP_REMOTE_PORT_INVALID', String(bad));
});

test('A manual port that is taken is not changed automatically, and a hint to choose another is shown', async t => {
  const { service } = setup(t, { mode: 'conflict' });
  service.update({ serverAddr: '1.2.3.4', remotePort: 25000 });
  service.start();
  await until(() => service.view().status === 'failed');
  assert.equal(service.view().config.remotePort, 25000);
  assert.match(service.view().error, /choose another port/);
});

// ── Agent prompts ──
const FrpPrompts = require('../public/js/frp-prompts.js');

test('frpc prompt: carries checksum, install directory, version and prohibitions', () => {
  const text = FrpPrompts.frpc({ binDir: '/srv/t-agent/data/bin', version: '0.61.1', target: { os: 'linux', arch: 'amd64' } });
  assert.match(text, /frp_0\.61\.1_linux_amd64\.tar\.gz/);
  assert.match(text, /frp_sha256_checksums\.txt/);
  assert.match(text, /\/srv\/t-agent\/data\/bin\/frpc/);
  assert.match(text, /--version.*0\.61\.1/);
  assert.match(text, /do not use sudo/);
  assert.match(FrpPrompts.frpc({ binDir: '/x', version: '0.61.1', target: null }), /confirm the system and architecture/);
});

test('frps prompt: carries server port, Token and allowed range; without a Token the Agent is told to generate one at random', () => {
  const base = { version: '0.61.1', serverPort: 7001, portMin: 20000, portMax: 60000, remotePort: 28000 };
  const withToken = FrpPrompts.frps({ ...base, token: 'tok"en' });
  assert.match(withToken, /bindPort = 7001/);
  assert.match(withToken, /auth\.token = "tok\\"en"/);
  assert.match(withToken, /allowPorts = \[\{ start = 20000, end = 60000 \}\]/);
  assert.match(withToken, /TCP 7001/);
  assert.match(withToken, /TCP 20000-60000/);
  assert.match(withToken, /security group/);
  const noToken = FrpPrompts.frps({ ...base, token: '' });
  assert.match(noToken, /random 32-character token/);
  const outside = FrpPrompts.frps({ ...base, token: '', remotePort: 8080 });
  assert.match(outside, /\{ single = 8080 \}/);
  assert.match(outside, /20000-60000 and 8080/);
});

// ── frpc detection ──
const { findFrpc, homebrewDirs } = require('../services/frp');

function fakeBrew(t, { version = '0.71.0', linked = true } = {}) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-brew-'));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));
  const keg = path.join(prefix, 'Cellar', 'frpc', version, 'bin');
  fs.mkdirSync(keg, { recursive: true });
  const real = path.join(keg, 'frpc');
  fs.writeFileSync(real, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(prefix, 'opt'), { recursive: true });
  fs.symlinkSync(path.join('..', 'Cellar', 'frpc', version), path.join(prefix, 'opt', 'frpc'));
  if (linked) { fs.mkdirSync(path.join(prefix, 'bin')); fs.symlinkSync(real, path.join(prefix, 'bin', 'frpc')); }
  return { prefix, real };
}

test('Homebrew: even when not linked into PATH, it can be found from opt/ and Cellar/ Finds frpc (takes the newest version)', t => {
  const { prefix } = fakeBrew(t, { linked: false });
  const old = path.join(prefix, 'Cellar', 'frpc', '0.9.0', 'bin');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'frpc'), '#!/bin/sh\n', { mode: 0o755 });
  const dirs = homebrewDirs({ HOMEBREW_PREFIX: prefix });
  const found = findFrpc({ dirs });
  assert.ok(found.startsWith(path.join(prefix, 'opt', 'frpc', 'bin')), found);
  fs.rmSync(path.join(prefix, 'opt', 'frpc'));
  assert.equal(findFrpc({ dirs }), path.join(prefix, 'Cellar', 'frpc', '0.71.0', 'bin', 'frpc'));
});

test('An empty Homebrew keg (no frpc executable) is not counted as installed', t => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-brew-empty-'));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));
  fs.mkdirSync(path.join(prefix, 'Cellar', 'frpc', '0.71.0', 'bin'), { recursive: true });
  assert.equal(findFrpc({ dirs: homebrewDirs({ HOMEBREW_PREFIX: prefix }).filter(dir => dir.startsWith(prefix)) }), null);
});

test('Version probe: shows the version; below 0.52 refuses to start; re-detect reads a newly installed frpc', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-detect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  t.after(() => db.close());
  const binFile = path.join(dir, 'frpc');
  const write = version => fs.writeFileSync(binFile, `#!/bin/sh\necho "frpc version ${version}"\n`, { mode: 0o755 });
  const service = createFrpService({ db, secret: SECRET, dataDir: dir, localPort: 3000, bin: binFile });
  write('0.71.0');
  assert.equal(service.view().frpc.version, '0.71.0');
  assert.equal(service.view().frpc.error, '');
  write('0.51.3');
  assert.equal(service.detect().frpc.version, '0.51.3');
  assert.equal(service.view().frpc.supported, false);
  service.update({ serverAddr: '1.2.3.4' });
  assert.throws(() => service.start(), e => e.code === 'FRP_VERSION_UNSUPPORTED');
  write('0.71.0');
  const view = service.detect();
  assert.equal(view.frpc.version, '0.71.0');
  assert.equal(view.frpc.supported, true);
});
