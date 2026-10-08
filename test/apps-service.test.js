const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAppsService, buildLinks, localIps } = require('../services/apps-service');
const { Pm2Error } = require('../services/pm2-manager');

const base = { scheme: 'http', path: '/', port: null, host: null, domain: null, url: null };

test('本机 IP：只取可对外访问的 IPv4，排除回环、链路本地和 IPv6', () => {
  const interfaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.8', internal: false }],
    utun: [{ family: 'IPv4', address: '169.254.9.9', internal: false }],
    en1: [{ family: 'IPv4', address: '192.168.1.8', internal: false }, { family: 'IPv4', address: '10.0.0.3', internal: false }],
  };
  assert.deepEqual(localIps(interfaces), ['192.168.1.8', '10.0.0.3']);
  assert.deepEqual(localIps({}), []);
});

test('本机 IP：排除 Docker/虚拟网卡，物理网卡优先于其他网卡', () => {
  const ip = address => [{ family: 'IPv4', address, internal: false }];
  const interfaces = {
    docker0: ip('172.17.0.1'), 'br-1a2b3c': ip('172.18.0.1'), veth9f: ip('172.19.0.1'), virbr0: ip('192.168.122.1'),
    tailscale0: ip('100.64.0.7'), eth0: ip('10.1.2.3'), wlan0: ip('10.1.2.4'),
  };
  assert.deepEqual(localIps(interfaces), ['10.1.2.3', '10.1.2.4', '100.64.0.7']);
  assert.deepEqual(localIps({ vmnet8: ip('172.16.5.1'), bridge100: ip('192.168.64.1'), utun3: ip('10.8.0.2') }), []);
});

test('访问地址：自定义地址 > 域名 > IP:端口，仅本机监听时只给 127.0.0.1', () => {
  const ips = ['192.168.1.8', '10.0.0.3'];
  // 只检测到端口：用第一个局域网 IP
  let links = buildLinks({ ...base }, [{ port: 3000, local_only: false }], ips);
  assert.equal(links.ip.url, 'http://192.168.1.8:3000/');
  assert.equal(links.primary, links.ip.url);
  assert.equal(links.domain, null);

  // 仅本机监听：不要给一个别人打不开的局域网地址
  links = buildLinks({ ...base }, [{ port: 5173, local_only: true }], ips);
  assert.equal(links.ip.url, 'http://127.0.0.1:5173/');
  assert.equal(links.ip.local_only, true);

  // 手填端口、IP、协议、路径优先；手填 IP 不再算“仅本机”
  links = buildLinks({ ...base, port: 8443, host: '10.9.9.9', scheme: 'https', path: '/admin' }, [{ port: 3000, local_only: true }], ips);
  assert.equal(links.ip.url, 'https://10.9.9.9:8443/admin');
  assert.equal(links.ip.local_only, false);

  // 域名：裸域名用协议字段，完整地址原样使用；没写路径时补上应用路径；域名优先于 IP
  assert.equal(buildLinks({ ...base, port: 80, domain: 'app.example.com', scheme: 'https' }, [], ips).primary, 'https://app.example.com');
  assert.equal(buildLinks({ ...base, domain: 'https://app.example.com/base', path: '/x' }, [], ips).domain.url, 'https://app.example.com/base');
  assert.equal(buildLinks({ ...base, domain: 'https://app.example.com', path: '/x' }, [], ips).domain.url, 'https://app.example.com/x');
  assert.equal(buildLinks({ ...base, domain: 'app.example.com:8443', scheme: 'https' }, [], ips).domain.url, 'https://app.example.com:8443');
  assert.equal(buildLinks({ ...base, port: 80, domain: 'a.example.com' }, [], ips).primary, 'http://a.example.com');

  // 自定义完整地址最优先
  links = buildLinks({ ...base, port: 80, domain: 'a.example.com', url: 'http://10.0.0.1:9000/dash' }, [], ips);
  assert.equal(links.primary, 'http://10.0.0.1:9000/dash');

  // 没有任何线索时没有链接；IPv6 地址要加方括号；没有任何局域网 IP 时退回 127.0.0.1
  assert.deepEqual(buildLinks({ ...base }, [], ips), { ip: null, domain: null, custom: null, primary: null });
  assert.equal(buildLinks({ ...base, port: 80, host: 'fd00::1' }, [], ips).ip.url, 'http://[fd00::1]:80/');
  assert.equal(buildLinks({ ...base, port: 80 }, [], []).ip.url, 'http://127.0.0.1:80/');
});

function setup(t, { processes, installed = true, running = true, pm2Error = null, ports = new Map() } = {}) {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  t.after(() => db.close());
  const pm2Manager = { status: async () => { if (pm2Error) throw pm2Error; return { installed, running, processes: processes || [] }; } };
  const detected = [];
  const portDetector = { detect: async pids => { detected.push(pids); return ports; } };
  const interfaces = () => ({ en0: [{ family: 'IPv4', address: '192.168.1.8', internal: false }] });
  return { db, service: createAppsService({ db, pm2Manager, portDetector, interfaces }), detected };
}
const proc = (id, name, pid, status = 'online') => ({ id, name, pid, status, cpu: 1, memory: 1024, restarts: 0, startedAt: Date.now(), self: false });

test('列表会自动登记 PM2 的全部进程，关联运行状态和检测到的端口，并生成访问地址', async t => {
  const { service, detected } = setup(t, {
    processes: [proc(0, 'web', 100), proc(1, 'worker', 0, 'stopped'), proc(2, 'dev', 200)],
    ports: new Map([[100, [{ port: 3000, local_only: false }]], [200, [{ port: 5173, local_only: true }]]]),
  });
  service.registry.create({ name: 'blog', port: 8080, domain: 'blog.example.com' });

  const result = await service.list();
  assert.deepEqual(result.apps.map(app => app.name), ['blog', 'dev', 'web', 'worker']);
  assert.deepEqual(detected, [[100, 200]], '只对在线且有 pid 的进程检测端口');
  assert.deepEqual(result.host_ips, ['192.168.1.8']);

  const web = result.apps.find(app => app.name === 'web');
  assert.equal(web.source, 'pm2');
  assert.equal(web.pm2.id, 0);
  assert.equal(web.pm2_state, 'online');
  assert.equal(web.effective_port, 3000);
  assert.equal(web.links.primary, 'http://192.168.1.8:3000/');
  assert.equal(result.apps.find(app => app.name === 'dev').links.primary, 'http://127.0.0.1:5173/');
  assert.equal(result.apps.find(app => app.name === 'worker').pm2_state, 'stopped');
  assert.equal(result.apps.find(app => app.name === 'worker').links.primary, null);

  const blog = result.apps.find(app => app.name === 'blog');
  assert.equal(blog.pm2, null);
  assert.equal(blog.pm2_state, 'unlinked');
  assert.equal(blog.links.primary, 'http://blog.example.com');
  assert.equal(result.hidden_count, 0);
  assert.equal(result.pm2.installed, true);
});

test('PM2 里消失的进程保留记录并标为 missing；PM2 不可用时不影响列表', async t => {
  const first = setup(t, { processes: [proc(0, 'web', 100)] });
  await first.service.list();
  const gone = createAppsService({ db: first.db, pm2Manager: { status: async () => ({ installed: true, running: true, processes: [] }) }, portDetector: { detect: async () => new Map() }, interfaces: () => ({}) });
  const afterGone = await gone.list();
  assert.equal(afterGone.apps.find(app => app.name === 'web').pm2_state, 'missing');

  const notInstalled = setup(t, { installed: false, running: false });
  notInstalled.service.registry.create({ name: 'manual-only', port: 80 });
  const listed = await notInstalled.service.list();
  assert.equal(listed.apps.length, 1);
  assert.equal(listed.pm2.installed, false);

  const broken = setup(t, { pm2Error: new Pm2Error('PM2_COMMAND_FAILED', 'boom', 502) });
  broken.service.registry.create({ name: 'x', pm2_name: 'x' });
  const result = await broken.service.list();
  assert.equal(result.pm2.error, 'PM2_COMMAND_FAILED');
  assert.equal(result.apps[0].pm2_state, 'unavailable');
});

test('删除仍在 PM2 里的自动登记服务只是隐藏，下次列表不会再出现；可以恢复', async t => {
  const { service } = setup(t, { processes: [proc(0, 'web', 100)] });
  const web = (await service.list()).apps[0];
  assert.deepEqual(await service.remove(web.id), { deleted: false, hidden: true });
  const after = await service.list();
  assert.equal(after.apps.length, 0, '同步不会把隐藏的服务登记回来');
  assert.equal(after.hidden_count, 1);
  service.registry.restoreHidden();
  assert.equal((await service.list()).apps.length, 1);

  const manual = service.registry.create({ name: 'manual', pm2_name: null });
  assert.deepEqual(await service.remove(manual.id), { deleted: true, hidden: false });
  await assert.rejects(service.remove(9999), error => error.code === 'APP_NOT_FOUND');
});
