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

// 假的 frpc：按 mode 打印 frp 的典型日志。conflict 模式在远程端口等于 FAIL_PORT 时报端口被占用。
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
  assert.fail('等待超时');
};

test('随机远程端口在范围内，生成一次后保持稳定', t => {
  const { service } = setup(t);
  const first = service.update({ serverAddr: '1.2.3.4', portMin: 30000, portMax: 30010 }).config.remotePort;
  assert.ok(first >= 30000 && first <= 30010);
  for (let i = 0; i < 5; i += 1) assert.equal(service.update({ domain: 'a.example.com' }).config.remotePort, first);
});

test('重新生成端口会换新值并保持在范围内', t => {
  let n = 0;
  const { service } = setup(t, { random: (min, max) => min + (n++ % (max - min + 1)) });
  const first = service.update({ serverAddr: '1.2.3.4', portMin: 40000, portMax: 40100 }).config.remotePort;
  const next = service.regenerate().config.remotePort;
  assert.notEqual(next, first);
  assert.ok(next >= 40000 && next <= 40100);
});

test('配置校验：非法服务器地址、端口、域名、范围都被拒绝', t => {
  const { service } = setup(t);
  for (const bad of [
    { serverAddr: 'a b' }, { serverAddr: 'x"y' }, { serverPort: 0 }, { serverPort: 70000 }, { serverPort: 'abc' },
    { domain: '1.2.3.4' }, { domain: 'bad_domain!' }, { localPort: 99999 }, { portMin: 5000, portMax: 4000 }, { token: 'a\nb' },
  ]) assert.throws(() => service.update(bad), e => e.code && e.code.startsWith('FRP_'), JSON.stringify(bad));
});

test('Token 加密保存，视图和数据库里都没有明文', t => {
  const { service, db } = setup(t);
  const view = service.update({ serverAddr: '1.2.3.4', token: TOKEN });
  assert.equal(view.config.hasToken, true);
  assert.ok(!JSON.stringify(view).includes(TOKEN));
  assert.ok(!db.prepare('SELECT value FROM system_state').get().value.includes(TOKEN));
  // 不传 token 保持不变；传空字符串清除
  assert.equal(service.update({ domain: 'a.example.com' }).config.hasToken, true);
  assert.equal(service.update({ token: '' }).config.hasToken, false);
});

test('渲染 TOML：正确转义，tcp 代理指向本地端口和随机远程端口', () => {
  const toml = renderToml({ serverAddr: '1.2.3.4', serverPort: 7000, token: 'a"b', proxyName: 'p', localIP: '127.0.0.1', localPort: 3000, remotePort: 28888 });
  assert.match(toml, /serverAddr = "1\.2\.3\.4"/);
  assert.match(toml, /auth\.token = "a\\"b"/);
  assert.match(toml, /type = "tcp"/);
  assert.match(toml, /localPort = 3000/);
  assert.match(toml, /remotePort = 28888/);
});

test('启动：写入 0600 配置，日志出现 start proxy success 后为运行中，停止后为已停止', async t => {
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

test('端口被占用时自动换端口重试', async t => {
  const ports = [25000, 26000];
  const { service } = setup(t, { mode: 'conflict', random: () => ports.shift() ?? 27000 });
  service.update({ serverAddr: '1.2.3.4' });
  assert.equal(service.view().config.remotePort, 25000);
  service.start();
  await until(() => service.view().status === 'running');
  assert.equal(service.view().config.remotePort, 26000);
  assert.ok(service.view().logs.some(line => line.includes('已换成 26000')));
});

test('登录 frps 失败时给出明确原因', async t => {
  const { service } = setup(t, { mode: 'login' });
  service.update({ serverAddr: '1.2.3.4' });
  service.start();
  await until(() => service.view().status === 'failed');
  assert.match(service.view().error, /登录 frps 失败/);
});

test('未填服务器地址时拒绝启动', t => {
  const { service } = setup(t);
  assert.throws(() => service.start(), e => e.code === 'FRP_SERVER_REQUIRED');
});

test('frpc 路径无效时标记失败而不是崩溃', async t => {
  const { db, dir } = setup(t);
  const service = createFrpService({ db, secret: SECRET, dataDir: dir, localPort: 3000, bin: path.join(dir, 'missing-frpc') });
  service.update({ serverAddr: '1.2.3.4' });
  service.start();
  await until(() => service.view().status === 'failed');
  assert.match(service.view().error, /无法启动 frpc/);
});

test('路由：需要登录，配置更新和状态不泄露 Token', async t => {
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

// ── frpc 安装 ──
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

test('安装 frpc：校验通过后只把可执行的 frpc 放进 binDir', async t => {
  const { download, urls } = releaseFixture(t);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-bin-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const result = await installFrpc({ binDir, platform: 'linux', arch: 'x64', base: 'https://mirror.test/frp/', download });
  assert.equal(result.path, path.join(binDir, 'frpc'));
  assert.equal(fs.statSync(result.path).mode & 0o111, 0o111);
  assert.deepEqual(fs.readdirSync(binDir), ['frpc']);
  assert.ok(urls.every(url => url.startsWith('https://mirror.test/frp/v0.61.1/')));
});

test('安装 frpc：校验和不符或平台不支持时拒绝，且不留下文件', async t => {
  const { download } = releaseFixture(t, { tamper: true });
  const binDir = path.join(os.tmpdir(), `frp-bin-${process.pid}-bad`);
  await assert.rejects(installFrpc({ binDir, platform: 'linux', arch: 'x64', download }), e => e.code === 'FRP_INSTALL_CHECKSUM_FAILED');
  assert.equal(fs.existsSync(binDir), false);
  await assert.rejects(installFrpc({ binDir, platform: 'win32', arch: 'x64', download }), e => e.code === 'FRP_INSTALL_UNSUPPORTED');
  await assert.rejects(installFrpc({ binDir, platform: 'linux', arch: 'x64', download: async () => { throw new Error('net'); } }), e => e.code === 'FRP_INSTALL_DOWNLOAD_FAILED');
});

test('服务：安装完成后识别到 frpc；失败时给出原因；重复安装被拒绝', async t => {
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
    if (fail) { const { FrpInstallError } = require('../services/frp-install'); throw new FrpInstallError('X', '下载 frp 失败'); }
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'frpc'), '#!/bin/sh\n', { mode: 0o755 });
  };
  const service = createFrpService({ db, secret: SECRET, dataDir: dir, localPort: 3000, installer });
  assert.equal(service.view().installed, false);
  service.install();
  assert.equal(service.view().installing, true);
  assert.throws(() => service.install(), e => e.code === 'FRP_INSTALL_RUNNING');
  await until(() => !service.view().installing);
  assert.equal(service.view().installError, '下载 frp 失败');
  fail = false;
  service.install();
  await until(() => service.view().installed && !service.view().installing);
  assert.equal(service.view().installError, '');
  assert.throws(() => service.install(), e => e.code === 'FRP_ALREADY_INSTALLED');
});

// ── 手动远程端口 ──
test('手动指定远程端口：固定使用，可在随机范围之外，改范围不会变；清空后恢复随机', t => {
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

test('手动端口被占用时不自动换端口，并提示换一个', async t => {
  const { service } = setup(t, { mode: 'conflict' });
  service.update({ serverAddr: '1.2.3.4', remotePort: 25000 });
  service.start();
  await until(() => service.view().status === 'failed');
  assert.equal(service.view().config.remotePort, 25000);
  assert.match(service.view().error, /换一个端口/);
});

// ── Agent 提示词 ──
const FrpPrompts = require('../public/js/frp-prompts.js');

test('frpc 提示词：带校验和、安装目录、版本和禁止项', () => {
  const text = FrpPrompts.frpc({ binDir: '/srv/t-agent/data/bin', version: '0.61.1', target: { os: 'linux', arch: 'amd64' } });
  assert.match(text, /frp_0\.61\.1_linux_amd64\.tar\.gz/);
  assert.match(text, /frp_sha256_checksums\.txt/);
  assert.match(text, /\/srv\/t-agent\/data\/bin\/frpc/);
  assert.match(text, /--version.*0\.61\.1/);
  assert.match(text, /不要使用 sudo/);
  assert.match(FrpPrompts.frpc({ binDir: '/x', version: '0.61.1', target: null }), /确认系统和架构/);
});

test('frps 提示词：带服务端口、Token 和放行范围；没有 Token 时让 Agent 随机生成', () => {
  const base = { version: '0.61.1', serverPort: 7001, portMin: 20000, portMax: 60000, remotePort: 28000 };
  const withToken = FrpPrompts.frps({ ...base, token: 'tok"en' });
  assert.match(withToken, /bindPort = 7001/);
  assert.match(withToken, /auth\.token = "tok\\"en"/);
  assert.match(withToken, /allowPorts = \[\{ start = 20000, end = 60000 \}\]/);
  assert.match(withToken, /TCP 7001/);
  assert.match(withToken, /TCP 20000-60000/);
  assert.match(withToken, /安全组/);
  const noToken = FrpPrompts.frps({ ...base, token: '' });
  assert.match(noToken, /随机生成的 32 位 Token/);
  const outside = FrpPrompts.frps({ ...base, token: '', remotePort: 8080 });
  assert.match(outside, /\{ single = 8080 \}/);
  assert.match(outside, /20000-60000 以及 8080/);
});
