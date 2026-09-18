// Opt-in Docker smoke test. Uses only isolated fixtures, never the user's Codex data.
// Run: node scripts/verify-docker-client.cjs [client-image]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync, spawn } = require('node:child_process');
const { totp } = require('../services/client-auth');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'client-docker-smoke-')));
const project = `t-agent-check-${process.pid}`;
const proxy = `${project}-proxy`;
const image = process.argv[2] || 't-agent-client:verification';
const env = { ...process.env, T_AGENT_CLIENT_IMAGE: image, T_AGENT_CLIENT_STORAGE_DIR: dir, T_AGENT_CLIENT_PORT: '0' };
const composeArgs = ['compose', '-p', project, '--env-file', 'docker/client.env.example', '-f', 'compose.client.yml'];
const docker = (...args) => execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const compose = (...args) => docker(...composeArgs, ...args);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function healthy() {
  for (let i = 0; i < 40; i++) {
    try { if (compose('exec', '-T', 'client', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1);console.log('ready')}).catch(()=>process.exit(1))").includes('ready')) return; } catch {}
    await delay(500);
  }
  throw new Error('Client did not become ready');
}
let port;
function request(route, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: route, method: body ? 'POST' : 'GET', rejectUnauthorized: false,
      headers: { Host: 'agent.example.com', Origin: 'https://agent.example.com', 'X-Requested-With': 'XMLHttpRequest', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
(async () => {
  try {
    fs.mkdirSync(path.join(dir, 'host-codex'));
    fs.writeFileSync(path.join(dir, 'host-codex', 'auth.json'), '{"fixture":"credential-file"}');
    fs.writeFileSync(path.join(dir, 'host-codex', 'config.toml'), '# fixture');
    execFileSync('bash', ['scripts/docker-client-copy-codex.sh', path.join(dir, 'codex'), path.join(dir, 'host-codex')], { cwd: root });
    compose('up', '-d', '--pull', 'never', '--no-build', 'client');
    await healthy();
    assert.match(compose('exec', '-T', 'client', 'codex', '--version'), /codex/);
    const secret = fs.readFileSync(path.join(dir, 'data', 'client-session-secret'), 'utf8');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=agent.example.com'], { stdio: 'ignore' });
    const nginx = fs.readFileSync(path.join(root, 'docker/client.nginx.conf.example'), 'utf8')
      .replaceAll('/etc/letsencrypt/live/agent.example.com/fullchain.pem', '/fixtures/cert.pem')
      .replaceAll('/etc/letsencrypt/live/agent.example.com/privkey.pem', '/fixtures/key.pem')
      .replace('http://127.0.0.1:3000', 'http://client:3000');
    fs.writeFileSync(path.join(dir, 'nginx.conf'), nginx);
    docker('run', '-d', '--name', proxy, '--network', `${project}_default`, '-p', '127.0.0.1::443', '-v', `${dir}:/fixtures:ro`, '-v', `${dir}/nginx.conf:/etc/nginx/conf.d/default.conf:ro`, 'nginx:alpine');
    port = Number(docker('port', proxy, '443/tcp').split(':').at(-1));
    for (let i = 0; ; i++) { try { await request('/health'); break; } catch (error) { if (i > 30) throw error; await delay(500); } }
    assert.equal((await request('/auth/setup/start', { body: {} })).status, 403);
    let setupSecret;
    await new Promise((resolve, reject) => {
      const child = spawn('docker', [...composeArgs, 'exec', '-T', 'client', 'node', 'scripts/client-auth-setup.js'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Enrollment timed out')); }, 15000);
      child.stdout.on('data', chunk => {
        output += chunk.toString(); const match = output.match(/手动添加密钥：([A-Z2-7]+)/);
        if (match && !setupSecret) { setupSecret = match[1]; child.stdin.write(totp(setupSecret, Math.floor(Date.now() / 30000)) + '\n'); }
      });
      child.stderr.on('data', () => {});
      child.once('error', reject);
      child.once('close', code => { clearTimeout(timer); if (code === 0 && output.includes('绑定完成')) resolve(); else reject(new Error(`Enrollment failed (${code})`)); });
    });
    const login = await request('/auth/login', { body: { code: totp(setupSecret, Math.floor(Date.now() / 30000) + 1) } });
    assert.equal(login.status, 200);
    const setCookie = login.headers['set-cookie'][0]; assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(';')[0];
    const created = await request('/api/tasks', { cookie, body: { title: 'Docker persistence fixture' } });
    assert.equal(created.status, 201);
    const task = JSON.parse(created.text);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/terminal/ws?taskId=${task.id}`, { rejectUnauthorized: false, origin: 'https://agent.example.com', headers: { Host: 'agent.example.com', Cookie: cookie } });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('PTY output timed out')); }, 10000);
      ws.on('error', reject);
      ws.on('message', data => { if (data.toString().includes('Docker-persistence-fixture')) { clearTimeout(timer); ws.close(); resolve(); } });
    });
    compose('exec', '-T', 'client', 'node', '-e', "require('fs').writeFileSync('/root/.codex/container-session-marker','persisted')");
    compose('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'client');
    await healthy();
    // Nginx resolves upstream on startup; restart it after the Client address changes.
    docker('restart', proxy);
    port = Number(docker('port', proxy, '443/tcp').split(':').at(-1));
    for (let i = 0; ; i++) { try { const r = await request('/health'); if (r.status !== 200) throw new Error('Proxy not ready'); break; } catch (error) { if (i > 30) throw error; await delay(500); } }
    assert.equal(fs.readFileSync(path.join(dir, 'data', 'client-session-secret'), 'utf8'), secret);
    assert.equal(compose('exec', '-T', 'client', 'cat', '/root/.codex/auth.json'), '{"fixture":"credential-file"}');
    assert.equal(compose('exec', '-T', 'client', 'cat', '/root/.codex/container-session-marker'), 'persisted');
    assert.equal(fs.existsSync(path.join(dir, 'host-codex', 'container-session-marker')), false);
    const tasks = await request('/api/tasks', { cookie });
    assert.equal(tasks.status, 200);
    assert.ok(JSON.parse(tasks.text).some(item => item.id === task.id));
    assert.equal(JSON.parse((await request('/auth/status')).text).bound, true);
    console.log('PASS: Docker Client, Codex binary, HTTPS login, WSS/PTY, preserved session/DB/key/Codex copy across recreation.');
  } finally {
    try { docker('rm', '-f', proxy); } catch {}
    try { compose('down', '--volumes'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
