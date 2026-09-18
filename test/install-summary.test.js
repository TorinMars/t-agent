const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const appDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(appDir, 'install.sh'), 'utf8');
const summaryStart = source.indexOf('# Installation summary.');
assert.notEqual(summaryStart, -1);
const summary = source.slice(summaryStart);

function output(config, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-summary-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, config);
  try {
    return execFileSync('bash', ['-eu', '-c', summary], {
      encoding: 'utf8',
      env: { ...process.env, APP_DIR: appDir, ENV_FILE: envFile, MODE: 'client',
        SERVICE_STARTED: '1', SERVICE_HINT: 'service status', MANUAL_START: 'npm start',
        CREATED_ENGINE_TOKEN: '', ...overrides },
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('client summary ends with a browser URL using the default port', () => {
  assert.match(output(''), /请在浏览器打开：http:\/\/127\.0\.0\.1:3000\s*$/);
});
test('client summary parses quoted ports and configured hosts', () => {
  assert.match(output('PORT="13500" # custom\nHOST=192.168.1.8\n'), /请在浏览器打开：http:\/\/192\.168\.1\.8:13500/);
});
test('wildcard listeners use a reachable loopback URL and IPv6 is bracketed', () => {
  assert.match(output('HOST=0.0.0.0\nPORT=3101'), /http:\/\/127\.0\.0\.1:3101/);
  assert.match(output('HOST=::\n'), /http:\/\/\[::1\]:3000/);
  assert.match(output('HOST=::1\n'), /http:\/\/\[::1\]:3000/);
});
test('manual installation tells the user to start before browsing', () => {
  assert.match(output('', { SERVICE_STARTED: '0' }), /尚未启动.*\n启动命令：npm start[\s\S]*启动后.*请在浏览器打开/);
});
test('engine summary retains its connection address and token', () => {
  const text = output('PORT="3200"\n', { MODE: 'engine', CREATED_ENGINE_TOKEN: 'test-token' });
  assert.match(text, /http:\/\/<服务器IP>:3200/);
  assert.match(text, /test-token/);
  assert.doesNotMatch(text, /请在浏览器打开/);
});
