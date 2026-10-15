const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createSshTunnelService, buildArgs } = require('../services/ssh-tunnel');
const { createSshTunnelRouter } = require('../routes/ssh-tunnel');

// 假的 ssh：把收到的参数写进 args.log，再按 mode 输出 ssh -v 风格的日志。
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
  assert.fail('等待超时');
};
const BASE = { host: '1.2.3.4', username: 'deploy' };

test('参数：私钥为空走 ssh 默认逻辑（不带 -i），填写后使用指定私钥', () => {
  const config = { host: '1.2.3.4', sshPort: 2222, username: 'deploy', keyPath: '', remotePort: 28000, bindAll: false };
  const options = { localIP: '127.0.0.1', localPort: 3000 };
  const plain = buildArgs(config, options);
  assert.ok(!plain.includes('-i'));
  assert.ok(!plain.includes('IdentitiesOnly=yes'));
  assert.deepEqual(plain.slice(-3), ['-R', '28000:127.0.0.1:3000', 'deploy@1.2.3.4']);
  assert.equal(plain[plain.indexOf('-p') + 1], '2222');
  assert.ok(plain.includes('BatchMode=yes') && plain.includes('ExitOnForwardFailure=yes'));
  const keyed = buildArgs({ ...config, keyPath: '/home/me/.ssh/tunnel_key', bindAll: true }, options);
  assert.equal(keyed[keyed.indexOf('-i') + 1], '/home/me/.ssh/tunnel_key');
  assert.ok(keyed.includes('IdentitiesOnly=yes'));
  assert.ok(keyed.includes('0.0.0.0:28000:127.0.0.1:3000'));
});

test('配置校验：非法地址、用户名、端口、私钥路径被拒绝', t => {
  const { service } = setup(t);
  for (const bad of [
    { host: 'a b' }, { host: '-oProxyCommand=x' }, { username: '-oProxyCommand=x' }, { username: 'a b' }, { username: 'a@b' },
    { sshPort: 0 }, { sshPort: 70000 }, { remotePort: 'abc' }, { remotePort: 70000 }, { keyPath: 'relative/key' }, { keyPath: '/a\nb' },
  ]) assert.throws(() => service.update(bad), e => e.code && e.code.startsWith('SSH_'), JSON.stringify(bad));
});

test('远程端口：默认随机并保持稳定，可手动指定，清空恢复随机', t => {
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

test('启动：用指定私钥连接，日志出现 remote forward success 后为运行中；停止后为已停止', async t => {
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

test('私钥为空时不带 -i；填写了但文件不存在则拒绝启动', async t => {
  const { service, calls } = setup(t);
  service.update(BASE);
  service.start();
  await until(() => service.view().status === 'running');
  assert.ok(!calls()[0].includes('-i'));
  service.stop();
  service.update({ keyPath: '/definitely/not/here/key' });
  assert.throws(() => service.start(), e => e.code === 'SSH_KEY_NOT_FOUND');
});

test('缺少服务器或用户名时拒绝启动', t => {
  const { service } = setup(t);
  assert.throws(() => service.start(), e => e.code === 'SSH_HOST_REQUIRED');
  service.update({ host: '1.2.3.4' });
  assert.throws(() => service.start(), e => e.code === 'SSH_USER_REQUIRED');
});

test('认证失败：给出明确原因', async t => {
  const { service } = setup(t, { mode: 'denied' });
  service.update(BASE);
  service.start();
  await until(() => service.view().status === 'failed');
  assert.match(service.view().error, /认证失败/);
});

test('自动端口被占用时换端口重试；手动端口不换', async t => {
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
  assert.match(manual.service.view().error, /换一个端口/);
});

test('已连通的隧道意外断开后自动重连', async t => {
  const timers = [];
  const { service, calls } = setup(t, { mode: 'drop-once', setTimer: fn => { timers.push(fn); return { unref() {} }; } });
  service.update(BASE);
  service.start();
  await until(() => timers.length === 1);
  assert.equal(service.view().status, 'starting');
  timers.shift()();
  await until(() => service.view().status === 'running' && calls().length === 2);
});

test('路由：需要登录，状态里没有多余信息，非法输入返回错误码', async t => {
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

test('日志过滤：ssh -v 里关于 SSH_SK_PROVIDER 的无害提示不进日志，真实的转发信息保留', async t => {
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
