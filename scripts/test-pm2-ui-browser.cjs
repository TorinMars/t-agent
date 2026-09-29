// 真实浏览器验证“实用工具”页的 PM2 面板：真实路由 + 假的 pm2，页面标记/样式/脚本取自真实文件。
const { chromium } = require('playwright');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { createPm2Manager } = require('../services/pm2-manager');
const { createPm2Router } = require('../routes/pm2');

const SECRET = 'SUPER-SECRET-TOKEN-123';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-ui-'));
fs.mkdirSync(path.join(dir, 'home'));
fs.writeFileSync(path.join(dir, 'home', 'rpc.sock'), '');
const outLog = path.join(dir, 'app-out.log');
fs.writeFileSync(outLog, Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify([
  { name: 'app', pm_id: 0, pid: 111, monit: { cpu: 3, memory: 5242880 }, pm2_env: { status: 'online', pm_uptime: Date.now() - 3700000, restart_time: 2, pm_exec_path: '/srv/app.js', pm_out_log_path: outLog, env: { API_TOKEN: SECRET } } },
  { name: 'worker', pm_id: 1, pid: 0, monit: { cpu: 0, memory: 0 }, pm2_env: { status: 'stopped', restart_time: 0, pm_exec_path: '/srv/worker.js', env: { API_TOKEN: SECRET } } },
]));
fs.writeFileSync(path.join(dir, 'pm2'), `#!/usr/bin/env node
const fs = require('fs'); const dir = ${JSON.stringify(dir)};
const state = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8')); const [cmd, id] = process.argv.slice(2);
if (cmd === 'jlist') console.log(JSON.stringify(state));
else { const p = state.find(x => String(x.pm_id) === id); p.pm2_env.status = { start: 'online', restart: 'online', reload: 'online', stop: 'stopped' }[cmd]; if (cmd !== 'stop') p.pm2_env.pm_uptime = Date.now(); fs.writeFileSync(dir + '/state.json', JSON.stringify(state)); }
`, { mode: 0o755 });
process.env.PM2_HOME = path.join(dir, 'home');

const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const nav = index.match(/<nav class="header-tabs"[\s\S]*?<\/nav>/)[0];
const panel = index.match(/<section class="tools-panel"[\s\S]*?<\/section>/)[0];
const page = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><body><header class="header"><div class="header-left">${nav}</div></header>${panel}
<script>const API = { async get(u) { const r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }); if (!r.ok) throw new Error(await r.text()); return r.json(); },
async post(u, d) { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(await r.text()); return r.json(); } };</script>
<script src="/tools.js"></script>`;

function serve(manager) {
  const app = express();
  app.use(express.json());
  app.get('/', (req, res) => res.type('html').send(page));
  app.get('/style.css', (req, res) => res.type('css').sendFile(path.join(root, 'public/css/style.css')));
  app.get('/tools.js', (req, res) => res.type('js').sendFile(path.join(root, 'public/js/tools.js')));
  app.use('/api/pm2', createPm2Router({ manager, requireAuth: (req, res, next) => next() }));
  return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
}

(async () => {
  const env = { PM2_HOME: path.join(dir, 'home') };
  const running = await serve(createPm2Manager({ bin: path.join(dir, 'pm2'), env, selfPid: 999999 }));
  const selfServer = await serve(createPm2Manager({ bin: path.join(dir, 'pm2'), env, selfPid: 111 }));
  const missing = await serve(createPm2Manager({ dirs: [], home: dir }));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const open = async (server) => {
      const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
      page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.click('#tab-tools');
      return page;
    };

    const page = await open(running);
    await page.waitForFunction(() => document.querySelectorAll('#pm2-body tr').length === 2);
    const table = await page.textContent('#pm2-table');
    assert.match(table, /app/); assert.match(table, /online/); assert.match(table, /worker/); assert.match(table, /stopped/);
    assert.match(table, /5\.0 MB/); assert.match(table, /1 小时/);
    assert.ok(!(await page.content()).includes(SECRET), '页面里不能出现进程的环境变量');
    assert.equal(await page.locator('#pm2-body tr:nth-child(1)').getByRole('button', { name: '启动', exact: true }).count(), 0, '在线进程没有“启动”按钮');
    assert.equal(await page.locator('#pm2-body tr:nth-child(2)').getByRole('button', { name: '停止', exact: true }).count(), 0, '已停止进程没有“停止”按钮');
    await page.screenshot({ path: process.env.PM2_UI_SHOT || path.join(dir, 'pm2-ui.png') });

    await page.locator('#pm2-body tr:nth-child(1)').getByRole('button', { name: '日志' }).click();
    await page.waitForFunction(() => document.getElementById('pm2-log-text').textContent.includes('line 30'));
    assert.equal(await page.isVisible('#pm2-logs'), true);
    await page.selectOption('#pm2-logs-lines', '100');
    await page.click('#pm2-logs-close');
    assert.equal(await page.isVisible('#pm2-logs'), false);

    const dialogs = [];
    page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    await page.locator('#pm2-body tr:nth-child(1)').getByRole('button', { name: '停止', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#pm2-body tr:nth-child(1) .pm2-badge').textContent === 'stopped');
    assert.match(dialogs[0], /确定停止 app/);
    await page.locator('#pm2-body tr:nth-child(1)').getByRole('button', { name: '启动', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#pm2-body tr:nth-child(1) .pm2-badge').textContent === 'online');
    assert.equal(dialogs.length, 1, '启动不需要确认');
    assert.deepEqual(page.errors, []);

    const selfPage = await open(selfServer);
    await selfPage.waitForFunction(() => document.querySelectorAll('#pm2-body tr').length === 2);
    assert.match(await selfPage.textContent('#pm2-body tr:nth-child(1)'), /当前页面所在服务/);
    const selfDialogs = [];
    selfPage.on('dialog', async d => { selfDialogs.push(d.message()); await d.dismiss(); });
    await selfPage.locator('#pm2-body tr:nth-child(1)').getByRole('button', { name: '重启' }).click();
    await selfPage.waitForTimeout(400);
    assert.match(selfDialogs[0], /当前正在提供本页面/);
    assert.equal(await selfPage.textContent('#pm2-body tr:nth-child(1) .pm2-badge'), 'online', '取消确认后不执行');

    const none = await open(missing);
    await none.waitForFunction(() => document.getElementById('pm2-hint').textContent.includes('未检测到 PM2'));
    assert.equal(await none.isVisible('#pm2-table'), false);
    console.log('PM2 UI browser test passed');
  } finally {
    await browser.close();
    for (const s of [running, selfServer, missing]) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
