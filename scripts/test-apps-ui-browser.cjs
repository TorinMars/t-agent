// Verify the "App list" page in a real browser: real routes/services/page scripts, fake PM2 and port detection.
const { chromium } = require('playwright');
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { createPm2Manager } = require('../services/pm2-manager');
const { createPm2Router } = require('../routes/pm2');
const { createAppsRouter } = require('../routes/apps');
const { createAppsService } = require('../services/apps-service');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-ui-'));
fs.mkdirSync(path.join(dir, 'home'));
fs.writeFileSync(path.join(dir, 'home', 'rpc.sock'), '');
const outLog = path.join(dir, 'web-out.log');
fs.writeFileSync(outLog, Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify([
  { name: 'web', pm_id: 0, pid: 111, monit: { cpu: 3, memory: 5242880 }, pm2_env: { status: 'online', pm_uptime: Date.now() - 3700000, restart_time: 2, pm_exec_path: '/srv/web.js', pm_out_log_path: outLog, env: { API_TOKEN: 'SECRET' } } },
  { name: 'worker', pm_id: 1, pid: 0, monit: { cpu: 0, memory: 0 }, pm2_env: { status: 'stopped', restart_time: 0, pm_exec_path: '/srv/worker.js' } },
]));
fs.writeFileSync(path.join(dir, 'pm2'), `#!/usr/bin/env node
const fs = require('fs'); const dir = ${JSON.stringify(dir)};
const state = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8')); const [cmd, id] = process.argv.slice(2);
if (cmd === 'jlist') console.log(JSON.stringify(state));
else { const p = state.find(x => String(x.pm_id) === id); p.pm2_env.status = { start: 'online', restart: 'online', reload: 'online', stop: 'stopped' }[cmd]; if (cmd === 'restart') p.pm2_env.restart_time += 1; fs.writeFileSync(dir + '/state.json', JSON.stringify(state)); }
`, { mode: 0o755 });
process.env.PM2_HOME = path.join(dir, 'home');

const db = new Database(':memory:');
db.exec(fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));
const pm2Manager = createPm2Manager({ bin: path.join(dir, 'pm2'), env: { PM2_HOME: path.join(dir, 'home') }, selfPid: 999999 });
const service = createAppsService({
  db, pm2Manager,
  portDetector: { detect: async pids => new Map(pids.map(pid => [pid, pid === 111 ? [{ port: 3000, local_only: false }, { port: 9229, local_only: true }] : []])) },
  interfaces: () => ({ en0: [{ family: 'IPv4', address: '192.168.1.8', internal: false }] }),
});
service.registry.create({ name: 'blog', description: 'Personal blog', domain: 'https://blog.example.com', port: 8080 });
service.registry.register({ name: 'billing-api', port: 7001, description: 'Self-registered' });

const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const nav = index.match(/<nav class="main-nav"[\s\S]*?<\/nav>/)[0];
const panel = index.match(/<section class="tools-panel"[\s\S]*?<\/section>/)[0];
const appsPanel = index.match(/<section class="apps-panel"[\s\S]*?<\/section>/)[0];
const agentPanel = index.match(/<section class="agent-config-panel"[\s\S]*?<\/section>/)[0];
const frpPanel = index.match(/<section class="frp-panel"[\s\S]*?<\/section>/)[0];
const fileSyncPanel = index.match(/<section class="file-sync-panel"[\s\S]*?<\/section>/)[0];
const modalHtml = '<div id="modal-overlay" style="display:none"><div id="modal"><div id="modal-title"></div><div id="modal-body"></div><div id="modal-footer" hidden></div></div></div>';
const tasksStub = `<script>const Tasks = (() => {
  const listeners = new Set();
  const sources = {
    local: { key: 'local', label: 'Default', local: true },
    'remote:7': { key: 'remote:7', label: 'Remote machine', local: false, id: 7, role: 'owner', caps: new Set(['pm2:manage', 'apps:manage']) },
    'remote:8': { key: 'remote:8', label: 'Old engine', local: false, id: 8, role: 'owner', caps: new Set(['pm2:manage']) },
  };
  let active = 'local';
  return { getActiveKey: () => active, getSource: key => sources[key], problemOf: () => null, onSourceChange: fn => listeners.add(fn),
    switchTo(key) { active = key; listeners.forEach(fn => fn()); } };
})();</script>`;
// Modal is equivalent to the one in app.js (only the parts used here are kept).
const modalStub = `<script>const Modal = {
  show(title, bodyHtml) { document.getElementById('modal-title').textContent = title; document.getElementById('modal-body').innerHTML = bodyHtml; document.getElementById('modal-overlay').style.display = 'flex'; },
  hide() { document.getElementById('modal-overlay').style.display = 'none'; document.getElementById('modal-body').innerHTML = ''; } };</script>`;
const apiStub = `<script>const call = async (method, u, d) => { const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: d === undefined ? undefined : JSON.stringify(d) }); if (!r.ok) throw new Error(await r.text()); return r.json(); };
const API = { get: u => call('GET', u), post: (u, d) => call('POST', u, d), put: (u, d) => call('PUT', u, d), delete: u => call('DELETE', u) };</script>`;
const page = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><body><header class="header"><div class="header-left"></div></header><div class="layout">${nav}${appsPanel}${agentPanel}${frpPanel}${fileSyncPanel}${panel}</div>${modalHtml}
${apiStub}${tasksStub}${modalStub}<script>const AgentConfig = { setActive() {} };const Frp = { setActive() {} };const FileSyncUI = { setEngine() {}, setActive() {} };</script><script src="/apps.js"></script><script src="/tools.js"></script>`;

function serve() {
  const app = express();
  app.use(express.json());
  app.get('/', (req, res) => res.type('html').send(page));
  app.get('/style.css', (req, res) => res.type('css').sendFile(path.join(root, 'public/css/style.css')));
  for (const name of ['tools', 'apps']) app.get(`/${name}.js`, (req, res) => res.type('js').sendFile(path.join(root, `public/js/${name}.js`)));
  const seen = [];
  const auth = (req, res, next) => next();
  const track = label => (req, res, next) => { seen.push(`${label} ${req.method} ${req.path}`); next(); };
  app.use('/api/apps', track('local-apps'), createAppsRouter({ service, requireAuth: auth }));
  app.use('/api/pm2', track('local-pm2'), createPm2Router({ manager: pm2Manager, requireAuth: auth }));
  // Remote engine 7 reaches the same services through the proxy; old engine 8 must not receive any app request.
  app.use('/api/remote-servers/7/apps', track('remote7-apps'), createAppsRouter({ service, requireAuth: auth }));
  app.use('/api/remote-servers/7/pm2', track('remote7-pm2'), createPm2Router({ manager: pm2Manager, requireAuth: auth }));
  app.use('/api/remote-servers/8', (req, res) => { seen.push(`remote8 ${req.method} ${req.path}`); res.status(404).end(); });
  return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => { server.seen = seen; resolve(server); }); });
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', async d => { page.lastDialog = d.message(); await d.accept(); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.click('#tab-apps');
    const row = name => page.locator(`#apps-body tr:has(.apps-name:has-text("${name}"))`);
    await page.waitForFunction(() => document.querySelectorAll('#apps-body tr').length === 4);

    // 1. List: PM2 auto-registered, manual, self-registered; ports and addresses
    assert.deepEqual(await page.locator('#apps-body .apps-name').evaluateAll(nodes => nodes.map(n => n.querySelector('a,strong').textContent)), ['billing-api', 'blog', 'web', 'worker']);
    const web = row('web');
    assert.match(await web.textContent(), /online/);
    assert.match(await web.textContent(), /5\.0 MB/);
    assert.match(await web.textContent(), /3000/);
    assert.match(await web.textContent(), /Also: 9229/);
    const webLink = web.locator('.apps-links a').first();
    assert.equal(await webLink.getAttribute('href'), 'http://192.168.1.8:3000/');
    assert.equal(await webLink.getAttribute('target'), '_blank');
    assert.match(await webLink.getAttribute('rel'), /noopener/);
    assert.match(await row('blog').textContent(), /Manual/);
    assert.match(await row('blog').textContent(), /Personal blog/);
    const blogLinks = await row('blog').locator('.apps-links a').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')));
    assert.deepEqual(blogLinks, ['https://blog.example.com', 'http://192.168.1.8:8080/'], 'Domain first, IP after');
    assert.match(await row('billing-api').textContent(), /Self-registered/);
    assert.match(await row('worker').textContent(), /stopped/);
    assert.equal(await row('blog').getByRole('button', { name: 'Restart', exact: true }).count(), 0, 'Apps not linked to PM2 have no PM2 buttons');
    assert.equal(await web.getByRole('button', { name: 'Stop', exact: true }).count(), 1);
    assert.equal(await row('worker').getByRole('button', { name: 'Start', exact: true }).count(), 1);
    assert.ok(!(await page.content()).includes('SECRET'), 'The page must not contain process environment variables');
    assert.match(await page.textContent('#apps-register-example'), /\/v1\/apps\/register/);
    await page.screenshot({ path: process.env.APPS_UI_SHOT || path.join(dir, 'apps-ui.png') });

    // 2. Add: validation errors stay in the form, and on success the app appears in the list
    await page.click('#apps-add');
    await page.fill('#app-f-name', 'docs');
    await page.fill('#app-f-port', '9000');
    await page.fill('#app-f-domain', 'docs.example.com');
    await page.fill('#app-f-url', 'javascript:alert(1)');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.querySelector('#modal-body .form-hint.error')?.textContent.length > 0);
    assert.match(await page.textContent('#modal-body .form-hint.error'), /http:\/\/ or https:\/\//);
    assert.equal(await page.isVisible('#modal-overlay'), true, 'The dialog stays open when validation fails');
    await page.fill('#app-f-url', '');
    await page.fill('#app-f-name', 'BLOG');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => /An app with this name already exists/.test(document.querySelector('#modal-body .form-hint.error')?.textContent || ''));
    await page.fill('#app-f-name', 'docs');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#apps-body tr').length === 5);
    assert.equal(await page.isVisible('#modal-overlay'), false);
    assert.deepEqual(await row('docs').locator('.apps-links a').evaluateAll(nodes => nodes.map(n => n.getAttribute('href'))), ['http://docs.example.com', 'http://192.168.1.8:9000/']);

    // 3. Edit: saved values are echoed; auto-detected values are only placeholders and are not persisted
    await row('docs').getByRole('button', { name: 'Edit' }).click();
    assert.equal(await page.inputValue('#app-f-port'), '9000');
    assert.equal(await page.inputValue('#app-f-domain'), 'docs.example.com');
    await page.fill('#app-f-port', '9100');
    await page.fill('#app-f-description', 'Docs site');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.querySelector('#apps-body')?.textContent.includes('Docs site'));
    assert.match(await row('docs').textContent(), /9100/);

    await web.getByRole('button', { name: 'Edit' }).click();
    assert.equal(await page.inputValue('#app-f-port'), '', 'The input is empty when no port was set manually');
    assert.equal(await page.getAttribute('#app-f-port', 'placeholder'), 'Auto: 3000', 'The effective port is shown as a placeholder');
    await page.fill('#app-f-domain', 'web.example.com');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.querySelector('#apps-body')?.textContent.includes('web.example.com'));
    const stored = (await (await fetch(`http://127.0.0.1:${server.address().port}/api/apps`)).json()).apps.find(app => app.name === 'web');
    assert.equal(stored.port, null, 'Saving does not turn the auto-detected port into a fixed value');
    assert.equal(stored.domain, 'web.example.com');
    assert.equal(stored.effective_port, 3000);

    // 4. PM2 actions: restart / stop (needs confirmation) / start
    await web.getByRole('button', { name: 'Restart', exact: true }).click();
    await page.waitForFunction(() => /3 restarts/.test(document.querySelector('#apps-body tr:has(.apps-name) ')?.parentElement.textContent));
    await web.getByRole('button', { name: 'Stop', exact: true }).click();
    assert.match(page.lastDialog, /Stop web/);
    await page.waitForFunction(() => [...document.querySelectorAll('#apps-body tr')].find(r => r.textContent.includes('web.example.com') || r.querySelector('.apps-name')?.textContent.startsWith('web'))?.querySelector('.pm2-badge')?.textContent === 'stopped');
    await row('web').getByRole('button', { name: 'Start', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#apps-body tr')].find(r => r.querySelector('.apps-name')?.textContent.startsWith('web'))?.querySelector('.pm2-badge')?.textContent === 'online');

    // 5. Logs
    await row('web').getByRole('button', { name: 'Logs' }).click();
    await page.waitForFunction(() => document.getElementById('apps-log-text')?.textContent.includes('line 30'));
    await page.getByRole('button', { name: 'Close' }).click();
    assert.equal(await page.isVisible('#modal-overlay'), false);

    // 6. Delete: manual apps are deleted directly; PM2 auto-registered ones still in PM2 are only hidden and can be restored
    await row('docs').getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#apps-body tr').length === 4);
    await row('worker').getByRole('button', { name: 'Delete' }).click();
    assert.match(page.lastDialog, /the PM2 process itself is not stopped or deleted/);
    await page.waitForFunction(() => document.querySelectorAll('#apps-body tr').length === 3);
    await page.waitForFunction(() => !document.getElementById('apps-restore').hidden);
    assert.match(await page.textContent('#apps-restore'), /Restore 1 hidden/);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#apps-body tr').count(), 3, 'A service hidden earlier does not come back after a refresh');
    await page.click('#apps-restore');
    await page.waitForFunction(() => document.querySelectorAll('#apps-body tr').length === 4 && document.getElementById('apps-restore').hidden);

    // 7. Injection protection: HTML in the name/description is treated as text only
    service.registry.register({ name: '<img src=x onerror="window.__xss=1">', description: '<script>window.__xss=2</script>', port: 5555 });
    await page.click('#apps-refresh');
    await page.waitForFunction(() => document.querySelectorAll('#apps-body tr').length === 5);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await page.textContent('#apps-body'), /<img src=x onerror=/);

    // 8. Follow the engine: a remote engine goes through the proxy address; an old engine without the app list shows only the reason and sends no request
    await page.evaluate(() => Tasks.switchTo('remote:7'));
    await page.waitForFunction(() => document.getElementById('apps-engine').textContent.includes('Remote machine'));
    await page.waitForFunction(() => document.querySelectorAll('#apps-body tr').length === 5);
    assert.ok(server.seen.some(item => item.startsWith('remote7-apps GET')));
    assert.match(await page.textContent('#apps-register-example'), /remote engine/);
    await row('web').getByRole('button', { name: 'Restart', exact: true }).click();
    await page.waitForFunction(() => /4 restarts/.test(document.getElementById('apps-body').textContent));
    assert.ok(server.seen.some(item => item.startsWith('remote7-pm2 POST')), 'PM2 actions also go through that engine’s PM2 proxy');

    await page.evaluate(() => Tasks.switchTo('remote:8'));
    await page.waitForFunction(() => document.getElementById('apps-hint').textContent.includes('too old to support the app list'));
    assert.equal(await page.isVisible('#apps-table'), false);
    assert.equal(await page.isDisabled('#apps-add'), true);
    await page.waitForTimeout(300);
    assert.deepEqual(server.seen.filter(item => item.startsWith('remote8')), [], 'An old engine does not receive app requests');
    await page.evaluate(() => Tasks.switchTo('local'));
    await page.waitForFunction(() => document.querySelectorAll('#apps-body tr').length === 5 && !document.getElementById('apps-add').disabled);

    // 9. Page switching: the app page closes when switching back to the tasks page, and the utilities page is unaffected
    await page.click('#tab-tools');
    assert.equal(await page.isHidden('#apps-panel'), true);
    assert.equal(await page.isVisible('#tools-panel'), true);
    await page.click('#tab-tasks');
    assert.equal(await page.evaluate(() => document.body.className.includes('apps-open') || document.body.className.includes('tools-open')), false);
    assert.deepEqual(errors, []);
    console.log('Apps UI browser test passed');
  } finally {
    await browser.close();
    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
