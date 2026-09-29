const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createPm2Manager, parseJlist } = require('../services/pm2-manager');
const { createPm2Router } = require('../routes/pm2');

const SECRET = 'SUPER-SECRET-TOKEN-123';

// 假的 pm2：用 JSON 文件保存状态，记录每次调用，并可选地在 jlist 前打印提示行。
function fakePm2(t, { banner = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(path.join(dir, 'home', 'rpc.sock'), '');
  const outLog = path.join(dir, 'app-out.log');
  fs.writeFileSync(outLog, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const state = [
    { name: 'app', pm_id: 0, pid: 111, monit: { cpu: 3, memory: 2048 },
      pm2_env: { status: 'online', pm_uptime: 1700000000000, restart_time: 2, exec_mode: 'fork_mode', pm_exec_path: '/srv/app.js', pm_cwd: '/srv',
        pm_out_log_path: outLog, pm_err_log_path: path.join(dir, 'missing-err.log'), env: { API_TOKEN: SECRET }, args: ['--token', SECRET] } },
    { name: 'worker', pm_id: 1, pid: 0, monit: { cpu: 0, memory: 0 },
      pm2_env: { status: 'stopped', restart_time: 0, pm_exec_path: '/srv/worker.js', env: { API_TOKEN: SECRET } } },
  ];
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const bin = path.join(dir, 'pm2');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const dir = ${JSON.stringify(dir)};
const state = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
fs.appendFileSync(dir + '/calls.log', process.argv.slice(2).join(' ') + '\\n');
const [cmd, id] = process.argv.slice(2);
if (cmd === 'jlist') { ${banner ? "console.log('[PM2] Spawning PM2 daemon with pm2_home=/x');" : ''} console.log(JSON.stringify(state)); }
else {
  const proc = state.find(p => String(p.pm_id) === id);
  if (!proc) { console.error('process not found'); process.exit(1); }
  proc.pm2_env.status = { start: 'online', restart: 'online', reload: 'online', stop: 'stopped' }[cmd];
  proc.pm2_env.restart_time += cmd === 'restart' ? 1 : 0;
  fs.writeFileSync(dir + '/state.json', JSON.stringify(state));
}
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') : []);
  return { dir, bin, home: path.join(dir, 'home'), calls, manager: createPm2Manager({ bin, home: path.join(dir, 'home'), selfPid: 111, env: { PM2_HOME: path.join(dir, 'home') } }) };
}

test('状态只返回白名单字段，绝不返回进程的 env 和 args', async t => {
  const pm2 = fakePm2(t);
  process.env.PM2_HOME = pm2.home; t.after(() => { delete process.env.PM2_HOME; });
  const status = await pm2.manager.status();
  assert.equal(status.installed, true);
  assert.equal(status.running, true);
  assert.deepEqual(status.processes.map(p => [p.id, p.name, p.status, p.self]), [[0, 'app', 'online', true], [1, 'worker', 'stopped', false]]);
  assert.equal(status.processes[0].memory, 2048);
  assert.equal(status.processes[0].hasOutLog, true);
  assert.ok(!JSON.stringify(status).includes(SECRET));
});

test('jlist 前面有提示行也能解析；解析失败时给出明确错误', () => {
  assert.deepEqual(parseJlist('[PM2] Spawning PM2 daemon\n[PM2] PM2 Successfully daemonized\n[{"pm_id":0}]\n'), [{ pm_id: 0 }]);
  assert.deepEqual(parseJlist('[]'), []);
  assert.throws(() => parseJlist('not json'), /jlist/);
});

test('没有安装 pm2、守护进程没运行时不会调用 pm2，也不会拉起守护进程', async t => {
  const missing = createPm2Manager({ dirs: [], home: '/nonexistent-home' });
  assert.deepEqual(await missing.status(), { installed: false, running: false, processes: [] });
  await assert.rejects(missing.control(0, 'restart'), /未检测到 pm2/);

  const pm2 = fakePm2(t);
  fs.rmSync(path.join(pm2.home, 'rpc.sock'));
  process.env.PM2_HOME = pm2.home; t.after(() => { delete process.env.PM2_HOME; });
  const idle = createPm2Manager({ bin: pm2.bin, home: pm2.home });
  assert.deepEqual(await idle.status(), { installed: true, running: false, processes: [] });
  await assert.rejects(idle.control(0, 'restart'), /没有运行/);
  assert.deepEqual(pm2.calls(), []);
});

test('只允许 start/stop/restart/reload，先确认进程存在再执行', async t => {
  const pm2 = fakePm2(t, { banner: true });
  process.env.PM2_HOME = pm2.home; t.after(() => { delete process.env.PM2_HOME; });
  for (const action of ['delete', 'flush', 'kill', 'start; rm -rf /', '']) {
    await assert.rejects(pm2.manager.control(0, action), /不支持的操作/);
  }
  await assert.rejects(pm2.manager.control(NaN, 'restart'), /编号不合法/);
  await assert.rejects(pm2.manager.control(-1, 'restart'), /编号不合法/);
  await assert.rejects(pm2.manager.control(99, 'restart'), /找不到这个进程/);
  assert.ok(!pm2.calls().some(call => call.startsWith('restart') || call.startsWith('delete')), '校验失败时没有执行任何动作');

  assert.equal((await pm2.manager.control(1, 'start')).status, 'online');
  assert.equal((await pm2.manager.control(1, 'stop')).status, 'stopped');
  const restarted = await pm2.manager.control(0, 'restart');
  assert.equal(restarted.restarts, 3);
  assert.deepEqual(pm2.calls().filter(call => call !== 'jlist'), ['start 1', 'stop 1', 'restart 0']);
});

test('日志只从 pm2 记录的路径读取尾部，限制行数，缺失文件返回空', async t => {
  const pm2 = fakePm2(t);
  process.env.PM2_HOME = pm2.home; t.after(() => { delete process.env.PM2_HOME; });
  const tail = await pm2.manager.logs(0, 'out', '5');
  assert.deepEqual(tail.lines, ['line 46', 'line 47', 'line 48', 'line 49', 'line 50']);
  assert.equal((await pm2.manager.logs(0, 'out', '100000')).lines.length, 50);
  assert.deepEqual((await pm2.manager.logs(0, 'err', '10')).lines, []);
  assert.deepEqual((await pm2.manager.logs(1, 'out', '10')).lines, []);
  await assert.rejects(pm2.manager.logs(0, '../../etc/passwd', '10'), /stream/);
  await assert.rejects(pm2.manager.logs(42, 'out', '10'), /找不到/);
});

test('HTTP 接口要求来源和登录，返回不缓存且不泄漏密钥，错误码正确', async t => {
  const pm2 = fakePm2(t);
  process.env.PM2_HOME = pm2.home; t.after(() => { delete process.env.PM2_HOME; });
  const app = express();
  app.use(express.json());
  app.use('/api/pm2', createPm2Router({ manager: pm2.manager, requireAuth(req, res, next) {
    if (req.get('Authorization') !== 'test-session') return res.status(401).json({ error: 'AUTH_REQUIRED' });
    next();
  } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/pm2`;
  const headers = { Authorization: 'test-session', 'X-Requested-With': 'XMLHttpRequest' };

  for (const [method, url] of [['GET', '/status'], ['POST', '/0/restart'], ['GET', '/0/logs']]) {
    assert.equal((await fetch(base + url, { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } })).status, 401);
    assert.equal((await fetch(base + url, { method, headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  }
  const status = await fetch(base + '/status', { headers });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.ok(!(await status.text()).includes(SECRET));

  assert.equal((await fetch(base + '/0/delete', { method: 'POST', headers })).status, 400);
  assert.equal((await fetch(base + '/abc/restart', { method: 'POST', headers })).status, 400);
  assert.equal((await fetch(base + '/99/restart', { method: 'POST', headers })).status, 404);
  const done = await fetch(base + '/1/start', { method: 'POST', headers });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).process.status, 'online');
  const logs = await fetch(base + '/0/logs?stream=out&lines=3', { headers });
  assert.deepEqual((await logs.json()).lines, ['line 48', 'line 49', 'line 50']);
  assert.equal((await fetch(base + '/0/logs?stream=bad', { headers })).status, 400);
});
