// routes/browser-ext.js mounted as server.js does: the pairing route (this machine only, extension or no Origin, CORS for the extension, one answer
// for every bad code), the page routes (list with the extension folder, pair code, rename, remove), and the tcli relay (no terminal headers or
// not this machine: passed on untouched; a wrong token: 403; commands through a fake extension; recordings list / summary / items / delete).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { bridgeServer, fakeExtension, memoryDb, ORIGIN } = require('./helpers/fake-browser-ext');
const { createBrowserRecordings } = require('../services/browser-recordings');
const { createBrowserPairRouter, createBrowserPageRouter, createBrowserRelayRouter, EXTENSION_DIR } = require('../routes/browser-ext');

const HOOK = { 'X-T-Agent-Task': '12', 'X-T-Agent-Terminal': 'term-a', 'X-T-Agent-Token': 'h'.repeat(64) };
const verifyToken = (task, terminal, token) => task === 12 && terminal === 'term-a' && token === HOOK['X-T-Agent-Token'];

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-routes-'));
  const recordings = createBrowserRecordings({ dir });
  const flags = { local: true };
  const app = express();
  const holder = {};
  const db = memoryDb();
  db.prepare("INSERT INTO tasks (id, user_id) VALUES (12, 'owner')").run();
  app.use('/api/browser-ext/pair', createBrowserPairRouter({ bridge: () => holder.bridge, isLocal: () => flags.local }));
  app.use('/api/tcli/browser', createBrowserRelayRouter({ bridge: () => holder.bridge, recordings: () => recordings, db, verifyToken, isLocal: () => flags.local }));
  app.use(express.json());
  app.use('/api/browser-ext', createBrowserPageRouter({ bridge: () => holder.bridge, localUrl: () => 'http://127.0.0.1:3000' }));
  app.use((req, res) => res.status(418).json({ error: 'PASSED_ON' }));
  const env = await bridgeServer({ app, db, bridgeOptions: { recordings } });
  holder.bridge = env.bridge;
  return { ...env, recordings, flags, dir };
}

const call = async (base, method, url, { headers = {}, body } = {}) => {
  const response = await fetch(`${base}${url}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: json, text, headers: response.headers };
};

test('pairing over HTTP: this machine only, a web Origin is refused, CORS for the extension, bad codes get PAIR_CODE_INVALID', async () => {
  const env = await setup();
  try {
    const { code } = env.bridge.createPairCode();
    env.flags.local = false;
    assert.equal((await call(env.base, 'POST', '/api/browser-ext/pair', { body: { code } })).status, 404);
    env.flags.local = true;
    const web = await call(env.base, 'POST', '/api/browser-ext/pair', { headers: { Origin: 'https://evil.test' }, body: { code } });
    assert.equal(web.status, 403);
    assert.equal(web.body.error, 'ORIGIN_NOT_ALLOWED');
    const preflight = await call(env.base, 'OPTIONS', '/api/browser-ext/pair', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal((await call(env.base, 'GET', '/api/browser-ext/pair', { headers: { Origin: ORIGIN } })).status, 405);
    const wrong = await call(env.base, 'POST', '/api/browser-ext/pair', { headers: { Origin: ORIGIN }, body: { code: 'AAAA2222' } });
    assert.deepEqual([wrong.status, wrong.body.error], [400, 'PAIR_CODE_INVALID']);
    assert.equal((await call(env.base, 'POST', '/api/browser-ext/pair', { headers: { Origin: ORIGIN }, body: 'nope' })).status, 400);
    const ok = await call(env.base, 'POST', '/api/browser-ext/pair', { headers: { Origin: ORIGIN }, body: { code, name: 'Chrome on macOS', version: '1.0.0', user_agent: 'UA' } });
    assert.equal(ok.status, 200);
    assert.match(ok.body.token, /^tab_/);
    assert.equal(ok.body.server_name, 'T01');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    const used = await call(env.base, 'POST', '/api/browser-ext/pair', { body: { code } });
    assert.deepEqual([used.status, used.body.error], [400, 'PAIR_CODE_INVALID'], 'used: the same answer');
  } finally { await env.close(); fs.rmSync(env.dir, { recursive: true, force: true }); }
});

test('page routes: list with the extension folder and server URL, a pair code, rename, remove', async () => {
  const env = await setup();
  try {
    const empty = await call(env.base, 'GET', '/api/browser-ext');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.browsers, []);
    assert.equal(empty.body.connected, false);
    assert.equal(empty.body.extension_dir, EXTENSION_DIR);
    assert.ok(path.isAbsolute(empty.body.extension_dir) && empty.body.extension_dir.endsWith(path.join('extensions', 'chrome')));
    assert.equal(typeof empty.body.extension_present, 'boolean');
    assert.equal(empty.body.server_url, 'http://127.0.0.1:3000');
    const made = await call(env.base, 'POST', '/api/browser-ext/pair-code');
    assert.match(made.body.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(made.body.expires_in_seconds, 300);
    const paired = env.bridge.pair({ code: made.body.code, name: 'Chrome' });
    const ext = await fakeExtension(env.wsUrl, paired.token);
    const listed = await call(env.base, 'GET', '/api/browser-ext');
    assert.deepEqual(listed.body.browsers.map(item => [item.name, item.online, item.active, item.version]), [['Chrome', true, true, '1.0.0']]);
    assert.ok(!JSON.stringify(listed.body).includes('token_hash'), 'no hash on the page');
    const renamed = await call(env.base, 'PATCH', `/api/browser-ext/${paired.browser_id}`, { body: { name: 'Work Chrome' } });
    assert.equal(renamed.body.name, 'Work Chrome');
    assert.equal((await call(env.base, 'PATCH', `/api/browser-ext/${paired.browser_id}`, { body: { name: '' } })).body.error, 'INVALID_NAME');
    assert.equal((await call(env.base, 'DELETE', '/api/browser-ext/br_nope')).status, 404);
    assert.equal((await call(env.base, 'DELETE', `/api/browser-ext/${paired.browser_id}`)).body.removed, true);
    assert.equal((await ext.closed).code, 4401);
  } finally { await env.close(); fs.rmSync(env.dir, { recursive: true, force: true }); }
});

test('relay auth: without terminal headers or from another machine the request is passed on; a wrong token is 403', async () => {
  const env = await setup();
  try {
    assert.equal((await call(env.base, 'GET', '/api/tcli/browser/status')).status, 418);
    const partial = await call(env.base, 'GET', '/api/tcli/browser/status', { headers: { 'X-T-Agent-Task': '12' } });
    assert.deepEqual([partial.status, partial.body.error], [401, 'TCLI_AUTH_REQUIRED']);
    const wrong = await call(env.base, 'GET', '/api/tcli/browser/status', { headers: { ...HOOK, 'X-T-Agent-Token': 'x'.repeat(64) } });
    assert.deepEqual([wrong.status, wrong.body.error], [403, 'TCLI_AUTH_INVALID']);
    const otherTask = await call(env.base, 'POST', '/api/tcli/browser/cmd', { headers: { ...HOOK, 'X-T-Agent-Task': '13' }, body: { method: 'tabs.list' } });
    assert.equal(otherTask.status, 403);
    env.flags.local = false;
    assert.equal((await call(env.base, 'GET', '/api/tcli/browser/status', { headers: HOOK })).status, 418, 'not from this machine: passed on to the gates');
    env.flags.local = true;
    const ok = await call(env.base, 'GET', '/api/tcli/browser/status', { headers: HOOK });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.connected, false);
    assert.equal((await call(env.base, 'GET', '/api/tcli/browser/nothing', { headers: HOOK })).body.error, 'UNKNOWN_ROUTE');
  } finally { await env.close(); fs.rmSync(env.dir, { recursive: true, force: true }); }
});

test('relay commands: not connected 503, the result, extension errors with their status, the allowlist, a recording tagged with the terminal', async () => {
  const env = await setup();
  try {
    const none = await call(env.base, 'POST', '/api/tcli/browser/cmd', { headers: HOOK, body: { method: 'tabs.list', params: {} } });
    assert.deepEqual([none.status, none.body.error], [503, 'BROWSER_NOT_CONNECTED']);
    const paired = env.bridge.pair({ code: env.bridge.createPairCode().code });
    const ext = await fakeExtension(env.wsUrl, paired.token, {
      handler(method, params) {
        if (method === 'tabs.list') return { tabs: [] };
        if (method === 'page.screenshot') return { data_base64: Buffer.from('png').toString('base64'), mime: 'image/png', width: 1, height: 1 };
        if (method === 'record.start') return { recording_id: 'rec_m1_abcd', tab_id: 2 };
        if (method === 'input.click') throw Object.assign(new Error('Stale ref'), { code: 'REF_NOT_FOUND' });
        return { params };
      },
    });
    const listed = await call(env.base, 'POST', '/api/tcli/browser/cmd', { headers: HOOK, body: { method: 'tabs.list' } });
    assert.deepEqual([listed.status, listed.body], [200, { tabs: [] }]);
    const shot = await call(env.base, 'POST', '/api/tcli/browser/cmd', { headers: HOOK, body: { method: 'page.screenshot', params: { tab_id: 2 } } });
    assert.equal(Buffer.from(shot.body.data_base64, 'base64').toString(), 'png');
    const stale = await call(env.base, 'POST', '/api/tcli/browser/cmd', { headers: HOOK, body: { method: 'input.click', params: { target: { ref: 'e3' } } } });
    assert.deepEqual([stale.status, stale.body], [404, { error: 'REF_NOT_FOUND', message: 'Stale ref' }]);
    const blocked = await call(env.base, 'POST', '/api/tcli/browser/cmd', { headers: HOOK, body: { method: 'chrome.debugger.attach' } });
    assert.deepEqual([blocked.status, blocked.body.error], [400, 'METHOD_NOT_ALLOWED']);
    assert.equal((await call(env.base, 'POST', '/api/tcli/browser/cmd', { headers: HOOK, body: { method: 'tabs.list', timeout_ms: 'soon' } })).status, 400);
    const started = await call(env.base, 'POST', '/api/tcli/browser/cmd', { headers: HOOK, body: { method: 'record.start', params: { tab_id: 2 } } });
    assert.equal(started.body.recording_id, 'rec_m1_abcd');
    ext.event('record.items', { recording_id: 'rec_m1_abcd', items: [{ seq: 1, kind: 'nav', tab_id: 2, url: 'https://a.test/?token=zz' }] });
    await new Promise(resolve => setTimeout(resolve, 50));
    const listing = await call(env.base, 'GET', '/api/tcli/browser/recordings', { headers: HOOK });
    assert.equal(listing.body.recordings.length, 1);
    const summary = await call(env.base, 'GET', '/api/tcli/browser/recordings/rec_m1_abcd', { headers: HOOK });
    assert.deepEqual([summary.body.task_id, summary.body.terminal_id, summary.body.items], [12, 'term-a', 1]);
    const items = await call(env.base, 'GET', '/api/tcli/browser/recordings/rec_m1_abcd/items', { headers: HOOK });
    assert.match(items.headers.get('content-type'), /ndjson/);
    assert.equal(JSON.parse(items.text.trim()).url, 'https://a.test/?token=<redacted:2>');
    assert.equal((await call(env.base, 'GET', '/api/tcli/browser/recordings/rec_none_0000', { headers: HOOK })).status, 404);
    assert.equal((await call(env.base, 'DELETE', '/api/tcli/browser/recordings/rec_m1_abcd', { headers: HOOK })).body.removed, true);
    assert.equal((await call(env.base, 'GET', '/api/tcli/browser/recordings/rec_m1_abcd/items', { headers: HOOK })).status, 404);
    ext.close();
  } finally { await env.close(); fs.rmSync(env.dir, { recursive: true, force: true }); }
});
