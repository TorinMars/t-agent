const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const { totp } = require('../services/client-auth');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-switcher-browser-'));
const children = [];
const proxies = [];
let browser;
let browserContext;
let inspectedPage;

async function startClient(name, hubOrigin) {
  const data = path.join(temp, name);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'production', SESSION_SECRET: 'browser-embedding-secret-'.repeat(3), T_AGENT_DATA_DIR: data, T_AGENT_DB_PATH: path.join(data, 'db.sqlite'), TASKS_BASE_DIR: path.join(data, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', CLIENT_FRAME_ORIGINS: hubOrigin, CLIENT_SESSION_COOKIE_NAME: `browser-${name}.sid` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  const start = await fetch(`${base}/auth/setup/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: '{}' });
  const setup = await start.json();
  const confirm = await fetch(`${base}/auth/setup/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: start.headers.get('set-cookie').split(';')[0] }, body: JSON.stringify({ code: totp(setup.secret, Math.floor(Date.now() / 30000)) }) });
  assert.equal(confirm.status, 200);
  return { base, secret: setup.secret };
}

async function startProxy(tls) {
  const backend = { base: null };
  const server = https.createServer(tls, (req, res) => {
    if (process.env.DEBUG_CLIENT_SWITCHER) console.log('Proxy:', req.method, req.headers.host, req.url);
    const proxy = http.request(backend.base + req.url, { method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on('error', () => { if (!res.destroyed) { res.writeHead(502); res.end(); } });
    res.on('close', () => proxy.destroy());
    req.pipe(proxy);
  });
  if (process.env.DEBUG_CLIENT_SWITCHER) server.on('tlsClientError', error => console.log('TLS:', error.message));
  proxies.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { backend, port: server.address().port };
}

(async () => {
  const keyFile = path.join(temp, 'test-key.pem');
  const certFile = path.join(temp, 'test-cert.pem');
  const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', keyFile, '-out', certFile], { encoding: 'utf8', timeout: 10000 });
  assert.equal(cert.status, 0, cert.stderr);
  const tls = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  const firstProxy = await startProxy(tls);
  const secondProxy = await startProxy(tls);
  const hubOrigin = `https://localhost:${firstProxy.port}`;
  const firstOrigin = `https://127.0.0.1:${firstProxy.port}`;
  const secondOrigin = `https://127.0.0.1:${secondProxy.port}`;
  const first = await startClient('one', hubOrigin);
  const second = await startClient('two', hubOrigin);
  firstProxy.backend.base = first.base;
  secondProxy.backend.base = second.base;
  browser = await chromium.launch({ headless: process.env.HEADFUL !== 'true', args: ['--no-proxy-server'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', ignoreHTTPSErrors: true });
  browserContext = context;
  // Real HTTPS proxies preserve browser Cookie, Fetch Metadata and Origin headers.
  // 第三方库已自托管在 /vendor，不再需要拦截 CDN。
  const page = await context.newPage();
  inspectedPage = page;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.DEBUG_CLIENT_SWITCHER) page.on('console', message => console.log(message.type(), message.text()));
  await page.goto(`${hubOrigin}/clients`);
  await page.waitForFunction(() => document.getElementById('client-status').textContent === '需要登录');
  async function add(name, address) {
    await page.click('#add-client');
    await page.fill('#client-name', name);
    await page.fill('#client-url', address);
    await page.click('#client-save');
  }
  await add('开发 Client', firstOrigin);
  await page.waitForFunction(() => document.getElementById('client-status').textContent === '需要登录');
  const login = await context.newPage();
  await login.goto(`${firstOrigin}/auth/login`);
  const loginStatus = await login.evaluate(async code => {
    const response = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ code }) });
    return response.status;
  }, totp(first.secret, Math.floor(Date.now() / 30000) + 1));
  assert.equal(loginStatus, 200);
  const cookie = (await context.cookies(firstOrigin)).find(cookie => cookie.name === 'browser-one.sid');
  assert.equal(cookie.sameSite, 'None');
  assert.equal(cookie.secure, true);
  await login.close();
  await page.click('#client-reload');
  await page.waitForFunction(() => document.getElementById('client-status').textContent === '页面已载入');
  const firstFrame = page.frames().find(frame => frame.url() === `${firstOrigin}/web`);
  await firstFrame.waitForSelector('#btn-settings');
  // A real form in the Client remains open and keeps unsaved input on switching.
  await firstFrame.click('#btn-settings');
  await firstFrame.fill('#settings-work-dir', '/unsaved-workspace');
  assert.equal(await firstFrame.evaluate(async () => (await fetch('/api/tasks')).status), 200);
  await add('运维 Client', secondOrigin);
  await page.waitForFunction(() => document.getElementById('client-status').textContent === '需要登录');
  const secondLogin = await context.newPage();
  await secondLogin.goto(`${secondOrigin}/auth/login`);
  assert.equal(await secondLogin.evaluate(async code => {
    const response = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ code }) });
    return response.status;
  }, totp(second.secret, Math.floor(Date.now() / 30000) + 1)), 200);
  await secondLogin.close();
  await page.click('#client-reload');
  await page.waitForFunction(() => document.getElementById('client-status').textContent === '页面已载入');
  const secondFrame = page.frames().find(frame => frame.url() === `${secondOrigin}/web`);
  assert.equal(await secondFrame.evaluate(async () => (await fetch('/api/tasks')).status), 200);
  assert.equal(await firstFrame.evaluate(async () => (await fetch('/api/tasks')).status), 200, 'login on another port keeps the first Client authenticated');
  await page.getByRole('button', { name: '开发 Client', exact: true }).click();
  assert.equal(page.frames().find(frame => frame.url() === `${firstOrigin}/web`), firstFrame);
  assert.equal(await firstFrame.inputValue('#settings-work-dir'), '/unsaved-workspace');
  await firstFrame.click('#settings-cancel');
  await firstFrame.waitForFunction(() => document.getElementById('modal-overlay').style.display === 'none', null, { timeout: 5000 });
  await page.screenshot({ path: '/private/tmp/t-agent-client-switcher.png' });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('client-status').textContent === '页面已载入');
  assert.equal(await page.locator('.client-tab').count(), 3);
  assert.equal(await page.locator('iframe').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.click('#add-client');
  await page.fill('#client-name', '手机上的 Client');
  await page.fill('#client-url', 'https://mobile.client.test');
  assert.equal(await page.locator('#client-save').isVisible(), true);
  await page.screenshot({ path: '/private/tmp/t-agent-client-switcher-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('Cross-site HTTPS login, same-host port isolation, Client API access, preserved forms, lazy restoration and mobile layout passed.');
})().catch(async error => {
  console.error(error);
  if (inspectedPage && !inspectedPage.isClosed()) {
    console.log('Frames:', inspectedPage.frames().map(frame => frame.url()));
    if (await inspectedPage.locator('#client-status').count()) console.log('Page status:', await inspectedPage.locator('#client-status').textContent());
    await inspectedPage.screenshot({ path: '/private/tmp/t-agent-client-switcher-failure.png' });
  }
  process.exitCode = 1;
}).finally(async () => {
  if (browserContext) await browserContext.unrouteAll({ behavior: 'ignoreErrors' });
  if (browser) await browser.close();
  for (const server of proxies) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  for (const child of children) {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
