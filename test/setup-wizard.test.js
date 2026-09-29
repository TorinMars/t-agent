const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const scriptsDir = path.join(__dirname, '../scripts');

function request(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: allHeaders }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function startWizard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-test-'));
  fs.copyFileSync(path.join(scriptsDir, 'setup-wizard.html'), path.join(dir, 'setup-wizard.html'));
  fs.writeFileSync(path.join(dir, 'install-claude-code.sh'), '#!/usr/bin/env bash\necho "dev args: $*"\n');
  fs.writeFileSync(path.join(dir, 'install-proxy.sh'),
    '#!/usr/bin/env bash\necho "url=${T_AGENT_PROXY_SUB_URL:-none} args: $*"\ncase "$*" in *--status*) sleep 1;; esac\n');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(python, [path.join(scriptsDir, 'setup-wizard.py'), '--scripts-dir', dir, '--port', String(port), '--no-browser'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/);
      if (match) resolve({ port: Number(match[1]), token: match[2] });
    });
    child.on('exit', code => reject(new Error(`wizard exited early (${code}): ${output}`)));
    setTimeout(() => reject(new Error('wizard did not start')), 10000);
  });
  const info = await ready;
  return { ...info, child, dir, output: () => output };
}

const json = (token, extra = {}) => ({ 'X-Wizard-Token': token, 'Content-Type': 'application/json', ...extra });

test('向导拒绝没有令牌、错误令牌和非本机 Host 的请求', { skip: !python }, async () => {
  const wizard = await startWizard();
  try {
    assert.equal((await request(wizard.port)).status, 403);
    assert.equal((await request(wizard.port, { url: '/?token=wrong' })).status, 403);
    const page = await request(wizard.port, { url: `/?token=${wizard.token}` });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(wizard.token) && !page.text.includes('__TOKEN__'));
    assert.equal((await request(wizard.port, { url: `/?token=${wizard.token}`, headers: { Host: 'evil.example.com' } })).status, 403);
    assert.equal((await request(wizard.port, { url: '/api/state' })).status, 403);
    assert.equal((await request(wizard.port, { url: '/api/state', headers: { 'X-Wizard-Token': wizard.token, Host: 'evil.example.com' } })).status, 403);
    const state = await request(wizard.port, { url: '/api/state', headers: { 'X-Wizard-Token': wizard.token } });
    assert.equal(state.status, 200);
    assert.ok(['macos', 'linux'].includes(state.json().platform));
    assert.ok(!wizard.output().includes('GET /'), '不写包含令牌的访问日志');
  } finally { wizard.child.kill(); }
});

test('向导只接受白名单参数，拒绝跨站和非 JSON 请求', { skip: !python }, async () => {
  const wizard = await startWizard();
  const post = (payload, headers = {}) => request(wizard.port, { method: 'POST', url: '/api/run', headers: json(wizard.token, headers), body: JSON.stringify(payload) });
  try {
    assert.equal((await post({ action: 'dev-env' }, { Origin: 'http://evil.example.com' })).status, 403);
    assert.equal((await request(wizard.port, { method: 'POST', url: '/api/run', headers: { 'X-Wizard-Token': wizard.token, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    const rejected = async (payload, message) => {
      const response = await post(payload);
      assert.equal(response.status, 400, response.text);
      assert.match(response.json().error, message);
    };
    await rejected({ action: 'rm -rf /' }, /未知操作/);
    await rejected({ action: 'dev-env', skip: ['claude; touch /tmp/x'] }, /skip 只支持/);
    await rejected({ action: 'proxy', port: '7890; id' }, /必须是数字/);
    await rejected({ action: 'proxy', port: '80' }, /1024-65535/);
    await rejected({ action: 'proxy', mode: 'install', subscription: 'ftp://x' }, /http:\/\/ 或 https:\/\//);
    await rejected({ action: 'proxy', mode: 'install', subscription: 'https://a.example/x y' }, /http:\/\/ 或 https:\/\//);
    assert.equal((await request(wizard.port, { method: 'POST', url: '/api/run', headers: json(wizard.token), body: 'not json' })).status, 400);
  } finally { wizard.child.kill(); }
});

test('订阅链接只通过环境变量传递，输出中被打码，运行中不能重复启动，可关闭', { skip: !python }, async () => {
  const wizard = await startWizard();
  const secret = 'https://sub.example.com/api/v1/client/subscribe?token=SUPERSECRET123';
  const post = (url, payload) => request(wizard.port, { method: 'POST', url, headers: json(wizard.token), body: JSON.stringify(payload) });
  const job = since => request(wizard.port, { url: `/api/job?since=${since}`, headers: { 'X-Wizard-Token': wizard.token } }).then(r => r.json());
  const waitDone = async () => { for (let i = 0; i < 50; i++) { const j = await job(0); if (j.done) return j; await new Promise(r => setTimeout(r, 100)); } throw new Error('job timeout'); };
  try {
    const first = await post('/api/run', { action: 'proxy', mode: 'install', subscription: secret, port: '17890' });
    assert.equal(first.status, 200, first.text);
    const done = await waitDone();
    const text = done.lines.join('\n');
    assert.equal(done.code, 0);
    assert.ok(!text.includes('SUPERSECRET123'), text);
    assert.match(text, /url=\*\*\*/);
    assert.match(text, /--reconfigure/);
    assert.match(text, /--port 17890/);
    assert.ok(!/SUPERSECRET123/.test(wizard.output()));

    assert.equal((await post('/api/run', { action: 'proxy', mode: 'status' })).status, 200);
    assert.equal((await post('/api/run', { action: 'dev-env' })).status, 409);
    await waitDone();

    assert.equal((await post('/api/run', { action: 'dev-env', skip: ['ssh'], check: true })).status, 200);
    const dev = await waitDone();
    assert.match(dev.lines.join('\n'), /dev args: --skip ssh --check/);

    assert.equal((await post('/api/shutdown', {})).status, 200);
    await new Promise(resolve => wizard.child.on('exit', resolve));
  } finally { wizard.child.kill(); }
});
