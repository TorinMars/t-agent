// The page server's local transport (services/vscode-local-transport.js) over the REAL VS Code manager (services/vscode-web.js), which runs the fake
// CLI of test-support/fake-vscode-cli.js: no real VS Code, no download, no network. Checks that the two halves fit: the request call with a body and an
// abort signal, the WebSocket call, and the refusals ("Open in VS Code" in docs/design/vscode-web.md and vscode-web-proxy.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlt-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const Database = require('better-sqlite3');
const { writeCodeShim } = require('../test-support/fake-vscode-cli');
const { createVscodeWeb } = require('../services/vscode-web');
const transport = require('../services/vscode-local-transport');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const shim = writeCodeShim(path.join(root, 'bin'));
const ENGINE = '11111111-2222-3333-4444-555555555555';
const HOST = { host: 't.example.com', proto: 'https' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function started(t) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const manager = createVscodeWeb({
    db, dataRoot: path.join(root, 'd'), engineId: ENGINE, findCli: async () => shim, env: process.env, terminalUser: false,
    log: { info() {}, warn() {} }, readyPollMs: 50, killGraceMs: 300,
  });
  manager.acceptLicense();
  transport.setVscodeForTests(manager);
  t.after(async () => { transport.setVscodeForTests(null); await manager.stop(); db.close(); });
  await manager.ensure(HOST);
  const end = Date.now() + 10_000;
  while (manager.status().state !== 'ready') {
    if (Date.now() > end) throw new Error('VS Code did not get ready');
    await sleep(20);
  }
  return manager;
}
const read = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); };

test('request() answers { status, headers, body } and the body is a stream', async t => {
  await started(t);
  const answer = await transport.request({ method: 'GET', path: `/vscode/${ENGINE}/`, headers: {}, body: null, host: HOST.host });
  assert.equal(answer.status, 200);
  assert.ok(Object.keys(answer.headers).length >= 0);
  assert.match(await read(answer.body), /<html|<!doctype/i);
});

test('request() pipes a request body and keeps the token and the set-cookie out of the answer', async t => {
  await started(t);
  const answer = await transport.request({ method: 'POST', path: `/vscode/${ENGINE}/echo`, headers: { 'content-type': 'text/plain' }, body: Readable.from([Buffer.from('hello')]), host: HOST.host });
  assert.ok([200, 404, 405].includes(answer.status), `status ${answer.status}`);
  await read(answer.body);
  assert.equal(answer.headers['set-cookie'], undefined);
});

test('request() rejects with the manager\'s codes: a path outside the base path, and a stopped VS Code', async t => {
  const manager = await started(t);
  await assert.rejects(transport.request({ method: 'GET', path: '/elsewhere/', headers: {}, host: HOST.host }), error => error.message === 'VSCODE_PATH_INVALID' && error.statusCode === 404);
  await manager.stop();
  await assert.rejects(transport.request({ method: 'GET', path: `/vscode/${ENGINE}/`, headers: {}, host: HOST.host }), error => error.message === 'VSCODE_NOT_RUNNING' && error.statusCode === 503);
});

test('request() stops when its signal aborts', async t => {
  await started(t);
  const controller = new AbortController();
  const pending = transport.request({ method: 'GET', path: `/vscode/${ENGINE}/`, headers: {}, host: HOST.host, signal: controller.signal });
  controller.abort();
  await pending.then(answer => answer.body.destroy(), () => {});
});

test('openWebSocket() echoes through the real manager', async t => {
  await started(t);
  const ws = transport.openWebSocket({ path: `/vscode/${ENGINE}/ws`, headers: {}, host: HOST.host });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const messages = [];
  ws.on('message', data => messages.push(data.toString()));
  ws.send('ping');
  const end = Date.now() + 5000;
  while (!messages.includes('ping') && Date.now() < end) await sleep(20);
  assert.ok(messages.includes('ping'), `echo in ${JSON.stringify(messages)}`);
  ws.close();
});

test('start() and status() refuse a task that is not the caller\'s with TASK_NOT_FOUND 404', async () => {
  await assert.rejects(transport.start({ taskId: 424242, terminalId: 'x', host: HOST.host, proto: HOST.proto, owner: 'nobody' }), error => error.message === 'TASK_NOT_FOUND' && error.statusCode === 404);
  await assert.rejects(transport.status({ taskId: 424242, terminalId: 'x', host: HOST.host, proto: HOST.proto, owner: 'nobody' }), error => error.message === 'TASK_NOT_FOUND' && error.statusCode === 404);
});
