// The pages rewrite their /js and /css URLs with ?v=<app version>; a versioned request is cached for a year, everything else keeps revalidating.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function startServer(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-asset-cache-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'asset-cache-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 8000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => { output += chunk; const m = output.match(/Server running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
  });
  return (route, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { Host: `127.0.0.1:${port}`, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('versioned scripts and styles are cached for a year and gzipped; unversioned ones revalidate', async t => {
  const get = await startServer(t);
  const versioned = await get('/js/h5.js?v=1.2.3', { 'Accept-Encoding': 'gzip' });
  assert.equal(versioned.status, 200);
  assert.equal(versioned.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(versioned.headers['content-encoding'], 'gzip');
  assert.ok(versioned.body.length < fs.statSync(path.join(__dirname, '../public/js/h5.js')).size / 2, 'the gzipped body is much smaller');

  assert.equal((await get('/css/h5.css?v=1.2.3')).headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal((await get('/css/h5.css')).headers['cache-control'], 'public, max-age=0', 'no version: keep revalidating');
  assert.equal((await get('/css/h5.css?v=../../x')).headers['cache-control'], 'public, max-age=0', 'only plain version strings count');
});

test('icons and the manifest are cached for a day, and the page itself is never stored', async t => {
  const get = await startServer(t);
  assert.equal((await get('/icons/icon-192.png')).headers['cache-control'], 'public, max-age=86400');
  assert.equal((await get('/manifest-h5.json')).headers['cache-control'], 'public, max-age=86400');
  const page = await get('/h5');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.body.toString(), /href="\/css\/h5\.css\?v=[\w.-]+"/, 'the page names its assets with the app version');
});
