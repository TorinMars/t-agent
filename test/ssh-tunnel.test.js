const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createSshTunnelService, buildArgs } = require('../services/ssh-tunnel');
const { createSshTunnelRouter } = require('../routes/ssh-tunnel');

// A fake ssh: writes the arguments it receives to args.log, then prints ssh -v style logs depending on mode.
function fakeSsh(dir, mode = 'ok') {
  const bin = path.join(dir, 'ssh');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'args.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = ${JSON.stringify(mode)};
const spec = process.argv[process.argv.indexOf('-R') + 1];
const port = Number(spec.split(':').slice(-3)[0]);
if (mode === 'denied') { console.error('user@host: Permission denied (publickey).'); process.exit(255); }
if (mode === 'busy' && port === 25000) { console.error('Error: remote port forwarding failed for listen port ' + port); process.exit(255); }
if (mode === 'drop-once' && !fs.existsSync(${JSON.stringify(path.join(dir, 'dropped'))})) {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'dropped'))}, '1');
  console.error('debug1: remote forward success for: listen ' + port + ', connect 127.0.0.1:3000');
  setTimeout(() => process.exit(255), 50);
} else {
  console.error('debug1: Authenticated to host ([1.2.3.4]:22).');
  console.error('debug1: remote forward success for: listen ' + port + ', connect 127.0.0.1:3000');
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });
  return bin;
}

function setup(t, { mode = 'ok', random, setTimer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-tunnel-'));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const service = createSshTunnelService({ db, localPort: 3000, ssh: fakeSsh(dir, mode), random, setTimer });
  t.after(() => { service.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const calls = () => fs.readFileSync(path.join(dir, 'args.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { dir, service, calls };
}
const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Wait timed out');
};
const BASE = { host: '1.2.3.4', username: 'deploy' };

test('Arguments: an empty private key follows ssh’s default lookup (no -i), and a given key is used', () => {
  const config = { host: '1.2.3.4', sshPort: 2222, username: 'deploy', keyPath: '', remotePort: 28000, bindAll: false };
  const options = { localIP: '127.0.0.1', localPort: 3000 };
  const plain = buildArgs(config, options);
  assert.ok(!plain.includes('-i'));
  assert.ok(!plain.includes('IdentitiesOnly=yes'));
  assert.deepEqual(plain.slice(-3), ['-R', '28000:127.0.0.1:3000', 'deploy@1.2.3.4']);
  assert.equal(plain[plain.indexOf('-p') + 1], '2222');
  assert.ok(plain.includes('BatchMode=yes') && plain.includes('ExitOnForwardFailure=yes'));
  // The shared connection from the user's ssh config must not be reused (ControlMaster auto makes ssh hand over the forward request and exit at once).
  for (const option of ['ControlMaster=no', 'ControlPath=none', 'ControlPersist=no']) assert.ok(plain.includes(option), option);
  const keyed = buildArgs({ ...config, keyPath: '/home/me/.ssh/tunnel_key', bindAll: true }, options);
  assert.equal(keyed[keyed.indexOf('-i') + 1], '/home/me/.ssh/tunnel_key');
  assert.ok(keyed.includes('IdentitiesOnly=yes'));
  assert.ok(keyed.includes('0.0.0.0:28000:127.0.0.1:3000'));
});

test('Config validation: invalid address, username, port and private key path are rejected', t => {
  const { service } = setup(t);
  for (const bad of [
    { host: 'a b' }, { host: '-oProxyCommand=x' }, { username: '-oProxyCommand=x' }, { username: 'a b' }, { username: 'a@b' },
    { sshPort: 0 }, { sshPort: 70000 }, { remotePort: 'abc' }, { remotePort: 70000 }, { keyPath: 'relative/key' }, { keyPath: '/a\nb' },
  ]) assert.throws(() => service.update(bad), e => e.code && e.code.startsWith('SSH_'), JSON.stringify(bad));
});

test('Remote port: random and stable by default, can be set manually, clearing it restores random', t => {
  const { service } = setup(t);
  const first = service.update(BASE).config.remotePort;
  assert.ok(first >= 20000 && first <= 60000);
  assert.equal(service.update({ username: 'other' }).config.remotePort, first);
  const manual = service.update({ remotePort: '8080' }).config;
  assert.equal(manual.remotePort, 8080);
  assert.equal(manual.remotePortManual, true);
  assert.equal(service.update({ remotePort: '' }).config.remotePortManual, false);
  service.update({ remotePort: 9000 });
  assert.equal(service.regenerate().config.remotePortManual, false);
});

test('Start: connects with the given private key, running once the log shows remote forward success, stopped after stopping', async t => {
  const { service, dir, calls } = setup(t);
  const key = path.join(dir, 'id_test');
  fs.writeFileSync(key, 'KEY');
  service.update({ ...BASE, keyPath: key, remotePort: 28123 });
  service.start();
  await until(() => service.view().status === 'running');
  const args = calls()[0];
  assert.equal(args[args.indexOf('-i') + 1], key);
  assert.equal(args[args.indexOf('-R') + 1], '28123:127.0.0.1:3000');
  assert.equal(args[args.length - 1], 'deploy@1.2.3.4');
  assert.equal(service.view().config.serverAddress, '127.0.0.1:28123');
  assert.throws(() => service.start(), e => e.code === 'SSH_ALREADY_RUNNING');
  service.stop();
  assert.equal(service.view().status, 'stopped');
});

test('An empty private key sends no -i; one that is filled in but whose file does not exist refuses to start', async t => {
  const { service, calls } = setup(t);
  service.update(BASE);
  service.start();
  await until(() => service.view().status === 'running');
  assert.ok(!calls()[0].includes('-i'));
  service.stop();
  service.update({ keyPath: '/definitely/not/here/key' });
  assert.throws(() => service.start(), e => e.code === 'SSH_KEY_NOT_FOUND');
});

test('Starting is refused when the server or username is missing', t => {
  const { service } = setup(t);
  assert.throws(() => service.start(), e => e.code === 'SSH_HOST_REQUIRED');
  service.update({ host: '1.2.3.4' });
  assert.throws(() => service.start(), e => e.code === 'SSH_USER_REQUIRED');
});

test('Authentication failure: a clear reason is given', async t => {
  const { service } = setup(t, { mode: 'denied' });
  service.update(BASE);
  service.start();
  await until(() => service.view().status === 'failed');
  assert.match(service.view().error, /Authentication failed/);
});

test('A taken automatic port retries with another port; a manual port does not', async t => {
  const ports = [25000, 26000];
  const auto = setup(t, { mode: 'busy', random: () => ports.shift() ?? 27000 });
  auto.service.update(BASE);
  assert.equal(auto.service.view().config.remotePort, 25000);
  auto.service.start();
  await until(() => auto.service.view().status === 'running');
  assert.equal(auto.service.view().config.remotePort, 26000);

  const manual = setup(t, { mode: 'busy' });
  manual.service.update({ ...BASE, remotePort: 25000 });
  manual.service.start();
  await until(() => manual.service.view().status === 'failed');
  assert.equal(manual.service.view().config.remotePort, 25000);
  assert.match(manual.service.view().error, /choose another port/);
});

test('A tunnel that had connected reconnects automatically after dropping unexpectedly', async t => {
  const timers = [];
  const { service, calls } = setup(t, { mode: 'drop-once', setTimer: fn => { timers.push(fn); return { unref() {} }; } });
  service.update(BASE);
  service.start();
  await until(() => timers.length === 1);
  assert.equal(service.view().status, 'starting');
  timers.shift()();
  await until(() => service.view().status === 'running' && calls().length === 2);
});

test('Routes: login required, no extra information in the status, invalid input returns an error code', async t => {
  const { service } = setup(t);
  const app = express();
  app.use(express.json());
  app.use('/api/ssh-tunnel', createSshTunnelRouter({ service, requireAuth: (req, res, next) => (req.get('x-test-auth') ? next() : res.status(401).json({ error: 'NO' })) }));
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ssh-tunnel`;
  const headers = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', 'x-test-auth': '1' };
  assert.equal((await fetch(base, { headers: { 'x-requested-with': 'XMLHttpRequest' } })).status, 401);
  const saved = await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify(BASE) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).config.username, 'deploy');
  const bad = await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ sshPort: 0 }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'SSH_PORT_INVALID');
});

test('Log filtering: the harmless SSH_SK_PROVIDER message in ssh -v stays out of the log while real forwarding information is kept', async t => {
  const { dir, service } = setup(t);
  fs.writeFileSync(path.join(dir, 'ssh'), `#!/usr/bin/env node
console.error('debug1: Authenticator provider $SSH_SK_PROVIDER did not resolve; disabling');
console.error('debug1: Requesting forwarding of remote forward 0.0.0.0:48346 -> 127.0.0.1:13500');
console.error('debug1: remote forward success for: listen 48346, connect 127.0.0.1:13500');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  service.update(BASE);
  service.start();
  await until(() => service.view().status === 'running');
  const logs = service.view().logs.join('\n');
  assert.ok(!/SSH_SK_PROVIDER/.test(logs));
  assert.match(logs, /Requesting forwarding of remote forward 0\.0\.0\.0:48346/);
  assert.match(logs, /remote forward success/);
});
