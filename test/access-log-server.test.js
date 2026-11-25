// The access log in the real server ("Access log" in docs/design/access-log.md): logins bind their session to the device that sent X-TA-Device,
// the first device is learned silently, a new one raises a T-Attention alert, the address behind the tunnel is the right-most X-Forwarded-For
// entry (TRUSTED_PROXY=on), five wrong codes raise an alert, and signing a device out ends its sessions (pages and terminals) until it logs in again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { totp } = require('../services/client-auth');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const D1 = 'computer11111';
const D2 = 'phone22222222';
const D3 = 'tablet3333333';
const LOGIN = '/torin/hide/login';

test('logins, alerts, the tunnel address and signing a device out, end to end', { timeout: 30000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-access-log-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'access-log-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', TRUSTED_PROXY: 'on' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 15000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (route, { cookie, body, method, device, ua = MAC, headers = {} } = {}) => {
    const response = await fetch(base + route, {
      method: method || (body ? 'POST' : 'GET'), redirect: 'manual',
      headers: { 'User-Agent': ua, 'X-Requested-With': 'XMLHttpRequest', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(device ? { 'X-TA-Device': device } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, cookie: (/(?:^|[,\s])(connect\.sid=[^;]+)/.exec(response.headers.get('set-cookie') || '') || [])[1] };
  };

  // Bind the authenticator on the computer: the first device, learned silently.
  const start = await call(`${LOGIN}/setup/start`, { body: {}, device: D1 });
  const confirm = await call(`${LOGIN}/setup/confirm`, { cookie: start.cookie, body: { code: totp(start.data.secret, Math.floor(Date.now() / 30000)) }, device: D1 });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
  const computer = confirm.cookie;
  const recovery = confirm.data.recovery_codes;
  let list = await call('/api/access/devices', { cookie: computer, device: D1 });
  assert.equal(list.status, 200);
  assert.equal(list.data.current_device, D1);
  assert.equal(list.data.can_sign_out, true);
  assert.deepEqual(list.data.devices.map(row => [row.id, row.name, row.confirmed]), [[D1, 'Mac · Chrome', true]]);
  const alerts = async () => (await call('/api/attention?include_done=1', { cookie: computer, device: D1 })).data.items.filter(item => item.source === 'access-log');
  assert.equal((await alerts()).length, 0);

  // The phone signs in through the tunnel (a loopback peer with the proxy's headers): a new device, one alert, its address the right-most entry.
  const phoneLogin = await call(`${LOGIN}/login`, { body: { code: recovery[0] }, device: D2, ua: IPHONE, headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.9' } });
  assert.equal(phoneLogin.status, 200, JSON.stringify(phoneLogin.data));
  const phone = phoneLogin.cookie;
  const [alert] = await alerts();
  assert.equal(alert.title, 'New device signed in: iPhone · Safari, IP 203.0.113.9. Was it you?');
  assert.equal(alert.status, 'waiting_user');
  list = await call('/api/access/devices', { cookie: computer, device: D1 });
  const phoneRow = list.data.devices.find(row => row.id === D2);
  assert.equal(phoneRow.last_ip, '203.0.113.9');
  assert.equal(phoneRow.confirmed, false);
  assert.equal(phoneRow.sessions, 1);
  // The phone's later requests need no header: its session names the device.
  assert.equal((await call('/api/access/devices', { cookie: phone })).data.current_device, D2);

  // Five wrong codes from one address: one alert.
  for (let i = 0; i < 5; i += 1) {
    const wrong = await call(`${LOGIN}/login`, { body: { code: '000000' }, device: D3, headers: { 'X-Forwarded-For': '198.51.100.66' } });
    assert.equal(wrong.status, 401);
  }
  assert.ok((await alerts()).some(item => item.title === '5 wrong codes from IP 198.51.100.66 in 10 minutes'));
  const events = await call('/api/access/events?limit=100', { cookie: computer, device: D1 });
  assert.equal(events.data.events.filter(row => row.kind === 'login_failed').length, 5);
  assert.ok(events.data.events.every(row => !/000000|secret/i.test(JSON.stringify(row))), 'no codes in the log');

  // A terminal of the phone opens while it is signed in.
  const socketStatus = cookie => new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?taskId=999999&terminalId=x&device=${D2}`, { origin: base, headers: { Cookie: cookie } });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (_, response) => { resolve(response.statusCode); response.resume(); });
    ws.on('error', () => {});
  });
  assert.equal(await socketStatus(phone), 101);

  // Sign the phone out from the computer; the computer cannot sign itself out.
  assert.equal((await call(`/api/access/devices/${D1}/revoke`, { cookie: computer, device: D1, body: {} })).data.error, 'ACCESS_CURRENT_DEVICE');
  const revoke = await call(`/api/access/devices/${D2}/revoke`, { cookie: computer, device: D1, body: {} });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.data));
  assert.equal(revoke.data.sessions_ended, 1);
  assert.equal((await call('/api/tasks', { cookie: phone })).status, 404, 'like an expired session: the login gate');
  assert.equal((await call(`${LOGIN}/status`, { cookie: phone })).data.authenticated, false);
  assert.equal(await socketStatus(phone), 404, 'its terminals are refused too');
  assert.equal((await call('/api/tasks', { cookie: computer, device: D1 })).status, 200, 'the computer stays signed in');

  // It logs in again with a code: welcome back.
  const back = await call(`${LOGIN}/login`, { body: { code: recovery[1] }, device: D2, ua: IPHONE, headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(back.status, 200);
  assert.equal((await call('/api/tasks', { cookie: back.cookie })).status, 200);
  list = await call('/api/access/devices', { cookie: computer, device: D1 });
  assert.equal(list.data.devices.find(row => row.id === D2).revoked_at, null);
  const kinds = (await call('/api/access/events?limit=100', { cookie: computer, device: D1 })).data.events.map(row => row.kind);
  for (const kind of ['login_ok', 'login_failed', 'new_device', 'revoked']) assert.ok(kinds.includes(kind), kind);

});

test('/v1/info lists access:log (routes/engine-v1.js)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'engine-v1.js'), 'utf8');
  assert.match(source, /'access:log'/);
});
