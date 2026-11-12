// The browser extension wired into the real server.js (temporary data folder, local-only mode): the page makes a code behind the login, the
// pairing route answers before the login gate, the socket upgrade takes an extension Origin and the token (welcome), a web Origin is refused,
// the page sees the browser online, Remove closes the socket with 4401, and the tcli relay refuses a wrong terminal token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { openSocket, fakeExtension, ORIGIN } = require('./helpers/fake-browser-ext');

async function startServer(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-browser-ext-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'browser-ext-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => { output += chunk; const m = output.match(/Server running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
  });
  const raw = (route, { method, body, cookie, headers = {} } = {}) => new Promise((resolve, reject) => {
    const all = { Host: `127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } : {}), ...headers };
    const request = http.request({ host: '127.0.0.1', port, path: route, method: method || (body !== undefined ? 'POST' : 'GET'), headers: all }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, json, cookie: (response.headers['set-cookie'] || []).map(item => item.split(';')[0]).find(item => !item.startsWith('t_agent_known=')) });
      });
    });
    request.on('error', reject);
    request.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
  return { port, raw, temp, output: () => output };
}

test('server.js: pairing, the socket, the page and the relay, wired as in production', { timeout: 40000 }, async t => {
  const { port, raw, output } = await startServer(t);
  const first = await raw('/api/browser-ext');
  assert.equal(first.status, 200, 'local-only mode trusts this machine');
  assert.deepEqual(first.json.browsers, []);
  assert.match(first.json.extension_dir, /extensions[\\/]chrome$/);
  assert.equal(first.json.server_url, `http://127.0.0.1:${port}`);
  const cookie = first.cookie;

  // The pairing route answers before the gates; a wrong code and a web Origin are refused.
  assert.equal((await raw('/api/browser-ext/pair', { body: { code: 'AAAA2222' }, headers: { Origin: ORIGIN } })).json.error, 'PAIR_CODE_INVALID');
  assert.equal((await raw('/api/browser-ext/pair', { body: { code: 'AAAA2222' }, headers: { Origin: 'https://evil.test' } })).status, 403);
  const code = await raw('/api/browser-ext/pair-code', { body: {}, cookie });
  assert.equal(code.status, 200);
  const paired = await raw('/api/browser-ext/pair', { body: { code: code.json.code, name: 'Chrome on Test', version: '1.0.0', user_agent: 'UA' }, headers: { Origin: ORIGIN } });
  assert.equal(paired.status, 200);
  assert.match(paired.json.token, /^tab_/);

  const wsUrl = `ws://127.0.0.1:${port}/api/browser-ext/ws`;
  assert.equal((await openSocket(wsUrl, { origin: 'http://127.0.0.1' })).status, 403);
  const ext = await fakeExtension(wsUrl, paired.json.token, { handler: method => (method === 'tabs.list' ? { tabs: [] } : {}) });
  assert.equal(ext.welcome.type, 'welcome');
  assert.equal(ext.welcome.browser_id, paired.json.browser_id);
  const online = await raw('/api/browser-ext', { cookie });
  assert.deepEqual(online.json.browsers.map(item => [item.name, item.online, item.active]), [['Chrome on Test', true, true]]);

  // The relay: a terminal header with a wrong token is refused, not passed to the page routes.
  const relay = await raw('/api/tcli/browser/status', { headers: { 'X-T-Agent-Task': '1', 'X-T-Agent-Terminal': 't', 'X-T-Agent-Token': 'x'.repeat(64) } });
  assert.deepEqual([relay.status, relay.json.error], [403, 'TCLI_AUTH_INVALID']);

  assert.equal((await raw(`/api/browser-ext/${paired.json.browser_id}`, { method: 'DELETE', cookie, headers: { 'X-Requested-With': 'XMLHttpRequest' } })).json.removed, true);
  assert.equal((await ext.closed).code, 4401);
  assert.ok(!output().includes(paired.json.token), 'the token is never logged');
  assert.match(output(), /Browser extension connected: Chrome on Test/);
});
