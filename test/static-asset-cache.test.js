// Static files are never reused without asking the server: every one is served with `no-cache` (revalidate each time with its ETag), versioned or not.
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

test('scripts, styles, vendor files, icons and manifests are served with no-cache, versioned or not, and still gzipped', async t => {
  const get = await startServer(t);
  const versioned = await get('/js/h5.js?v=1.2.3', { 'Accept-Encoding': 'gzip' });
  assert.equal(versioned.status, 200);
  assert.equal(versioned.headers['cache-control'], 'no-cache', 'a version in the URL does not make it cacheable');
  assert.equal(versioned.headers['content-encoding'], 'gzip');
  assert.ok(versioned.body.length < fs.statSync(path.join(__dirname, '../public/js/h5.js')).size / 2, 'the gzipped body is much smaller');

  for (const route of ['/css/h5.css?v=1.2.3', '/css/h5.css', '/css/h5.css?v=../../x', '/js/voice-input.js', '/icons/icon-192.png', '/manifest-h5.json', '/sw.js']) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers['cache-control'], 'no-cache', route);
  }
  const vendor = 'marked/marked-15.0.12.min.js'; // a versioned name: it used to be cached for a year
  assert.ok(fs.existsSync(path.join(__dirname, '../public/vendor', vendor)), 'the vendor file exists');
  assert.equal((await get(`/vendor/${vendor}`)).headers['cache-control'], 'no-cache', 'vendor files used to be cached for a year');
});

test('an unchanged static file is answered with 304 and no body, and the page itself is still never stored', async t => {
  const get = await startServer(t);
  const first = await get('/js/h5.js');
  assert.ok(first.headers.etag, 'the file has an ETag to validate against');
  const again = await get('/js/h5.js', { 'If-None-Match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers['cache-control'], 'no-cache');
  const page = await get('/h5');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.body.toString(), /href="\/css\/h5\.css\?v=[\w.-]+"/, 'the page names its assets with the app version');
});
