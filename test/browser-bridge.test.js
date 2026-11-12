// services/browser-bridge.js with a fake extension (test/helpers/fake-browser-ext.js), no real browser: pairing codes (format, single use, expiry,
// wrong code), the stored hash, the socket's Origin and this-machine checks, hello (bad and revoked token 4401, protocol 4426, no hello 4400),
// a newer socket replacing the old one (4409), ping / pong and the silence timeout (4408), commands (round trip, timeout, not connected, the
// method allowlist, a method the extension lacks, error codes, a disconnect while waiting, choosing a browser), recordings tagged with the task,
// and the second redaction of net answers unless raw.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bridgeServer, openSocket, fakeExtension, waitFor, SILENT } = require('./helpers/fake-browser-ext');
const { createBrowserRecordings } = require('../services/browser-recordings');
const { PAIR_ALPHABET, CLOSE } = require('../services/browser-bridge');

const pairOnce = (bridge, name = 'Chrome on Mac') => bridge.pair({ code: bridge.createPairCode().code, name, version: '1.0.0', user_agent: 'UA' });

test('pairing: an 8 character code, single use, wrong and expired codes give one answer, only the hash is stored', async () => {
  let clock = 1_000_000;
  const { bridge, db, close } = await bridgeServer({ bridgeOptions: { now: () => clock } });
  try {
    const made = bridge.createPairCode();
    assert.match(made.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(PAIR_ALPHABET.length, 32);
    assert.equal(made.expires_in_seconds, 300);
    assert.throws(() => bridge.pair({ code: 'WRONG234' }), error => error.code === 'PAIR_CODE_INVALID' && error.status === 400);
    assert.throws(() => bridge.pair({}), { code: 'PAIR_CODE_INVALID' });
    // A wrong try does not use the code up; lower case and spaces are fine.
    const paired = bridge.pair({ code: `${made.code.slice(0, 4).toLowerCase()} ${made.code.slice(4)}`, name: 'Chrome on Mac', version: '1.0.0', user_agent: 'UA' });
    assert.match(paired.token, /^tab_[A-Za-z0-9_-]{43}$/);
    assert.match(paired.browser_id, /^br_[0-9a-f]{12}$/);
    assert.equal(paired.server_name, 'T01');
    assert.throws(() => bridge.pair({ code: made.code }), { code: 'PAIR_CODE_INVALID' }, 'single use');

    const stored = db.prepare("SELECT value FROM system_state WHERE key = 'browser_ext_v1'").get().value;
    assert.ok(!stored.includes(paired.token) && !stored.includes(paired.token.slice(4)), 'the token itself is never stored');
    const [entry] = JSON.parse(stored);
    assert.deepEqual(Object.keys(entry).sort(), ['browser_id', 'created_at', 'last_seen_at', 'name', 'token_hash', 'user_agent', 'version']);
    assert.match(entry.token_hash, /^[0-9a-f]{64}$/);

    const late = bridge.createPairCode();
    clock += 5 * 60_000 + 1;
    assert.throws(() => bridge.pair({ code: late.code }), { code: 'PAIR_CODE_INVALID' }, 'expired');
    const first = bridge.createPairCode();
    const second = bridge.createPairCode();
    if (first.code !== second.code) assert.throws(() => bridge.pair({ code: first.code }), { code: 'PAIR_CODE_INVALID' }, 'a newer code replaces the older one');
    assert.equal(bridge.pair({ code: second.code, name: '' }).server_name, 'T01');
    assert.equal(bridge.list().find(item => item.browser_id !== paired.browser_id).name, 'Chrome', 'an empty name gets the default');
  } finally { await close(); }
});

test('the socket: this machine and an extension Origin only', async () => {
  let local = true;
  const { bridge, wsUrl, close } = await bridgeServer({ bridgeOptions: { isLocal: () => local } });
  try {
    assert.equal((await openSocket(wsUrl, { origin: null })).status, 403);
    assert.equal((await openSocket(wsUrl, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await openSocket(wsUrl, { origin: 'http://127.0.0.1:3000' })).status, 403);
    local = false;
    assert.equal((await openSocket(wsUrl)).status, 404);
    local = true;
    const { token } = pairOnce(bridge);
    const ext = await fakeExtension(wsUrl, token);
    assert.equal(ext.welcome.type, 'welcome');
    assert.equal(ext.welcome.protocol, 1);
    assert.equal(ext.welcome.server_name, 'T01');
    ext.close();
  } finally { await close(); }
});

test('hello: a bad token 4401, another protocol 4426, nothing or something else first 4400; Remove closes the socket with 4401', async () => {
  const { bridge, wsUrl, close } = await bridgeServer({ bridgeOptions: { helloTimeoutMs: 150 } });
  try {
    const bad = await fakeExtension(wsUrl, 'tab_not-a-real-token');
    assert.equal((await bad.closed).code, CLOSE.UNAUTHORIZED);
    const { token, browser_id: browserId } = pairOnce(bridge);
    const old = await fakeExtension(wsUrl, token, { protocol: 2 });
    assert.equal((await old.closed).code, 4426);
    const silent = await openSocket(wsUrl);
    assert.equal((await silent.closed).code, 4400, 'no hello within the time');
    const wrong = await openSocket(wsUrl);
    wrong.ws.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await wrong.closed).code, 4400);
    const notJson = await openSocket(wsUrl);
    notJson.ws.send('hello?');
    assert.equal((await notJson.closed).code, 4400);

    const ext = await fakeExtension(wsUrl, token);
    assert.equal(ext.welcome.browser_id, browserId);
    assert.equal(bridge.status().connected, true);
    bridge.remove(browserId);
    assert.equal((await ext.closed).code, 4401, 'revoked');
    const again = await fakeExtension(wsUrl, token);
    assert.equal((await again.closed).code, 4401, 'the revoked token no longer works');
    assert.throws(() => bridge.remove(browserId), { code: 'BROWSER_NOT_FOUND' });
  } finally { await close(); }
});

test('a newer socket of the same browser replaces the old one (4409); pings get pongs; a silent socket is closed (4408)', async () => {
  const { bridge, wsUrl, close } = await bridgeServer({ bridgeOptions: { silenceMs: 250 } });
  try {
    const { token, browser_id: browserId } = pairOnce(bridge);
    const first = await fakeExtension(wsUrl, token);
    const second = await fakeExtension(wsUrl, token);
    assert.equal((await first.closed).code, CLOSE.REPLACED);
    assert.equal(bridge.list().find(item => item.browser_id === browserId).online, true, 'the newer socket stays');
    second.send({ type: 'ping' });
    await waitFor(() => second.messages.some(message => message.type === 'pong'));
    // Pings keep it open past the silence limit.
    for (let i = 0; i < 4; i += 1) { await new Promise(resolve => setTimeout(resolve, 100)); second.send({ type: 'ping' }); }
    assert.equal(second.ws.readyState, 1);
    assert.equal((await second.closed).code, CLOSE.SILENT);
    assert.equal(bridge.status().connected, false);
    assert.ok(bridge.list()[0].last_seen_at, 'last seen is kept');
  } finally { await close(); }
});

test('commands: round trip, error codes, allowlist, unsupported method, timeout, not connected, disconnect while waiting', async () => {
  const { bridge, wsUrl, close } = await bridgeServer({ bridgeOptions: { graceMs: 50 } });
  try {
    await assert.rejects(bridge.command('tabs.list'), error => error.code === 'BROWSER_NOT_CONNECTED' && error.status === 503);
    const { token } = pairOnce(bridge);
    const ext = await fakeExtension(wsUrl, token, {
      methods: ['tabs.list', 'page.snapshot', 'page.wait', 'input.click', 'net.get'],
      handler(method, params) {
        if (method === 'tabs.list') return { tabs: [{ tab_id: 5, url: 'https://a.test/', title: 'A', active: true, how: 'group', capturing: false, recording_id: null }] };
        if (method === 'input.click') throw Object.assign(new Error('Tab 9 is not a T-Agent tab'), { code: 'TAB_NOT_ALLOWED' });
        if (method === 'page.wait') return SILENT;
        if (method === 'page.snapshot') return { echo: params };
        return {};
      },
    });
    const listed = await bridge.command('tabs.list', {});
    assert.equal(listed.tabs[0].tab_id, 5);
    const cmd = ext.commands[0];
    assert.match(cmd.id, /^c_\d+$/);
    assert.equal(cmd.type, 'cmd');
    assert.equal(cmd.timeout_ms, 30000);
    assert.deepEqual((await bridge.command('page.snapshot', { tab_id: 5, mode: 'text' })).echo, { tab_id: 5, mode: 'text' });

    await assert.rejects(bridge.command('input.click', { target: { ref: 'e1' } }), error => error.code === 'TAB_NOT_ALLOWED' && error.status === 403 && /not a T-Agent tab/.test(error.message));
    await assert.rejects(bridge.command('chrome.cookies.getAll', {}), error => error.code === 'METHOD_NOT_ALLOWED' && error.status === 400);
    await assert.rejects(bridge.command('__proto__', {}), { code: 'METHOD_NOT_ALLOWED' });
    await assert.rejects(bridge.command('page.eval', { expression: '1' }), error => error.code === 'UNKNOWN_METHOD' && /does not support page\.eval/.test(error.message));
    await assert.rejects(bridge.command('tabs.list', 'x'), { code: 'BAD_PARAMS' });
    assert.equal(ext.commands.length, 3, 'refused commands never reach the extension');

    const started = Date.now();
    await assert.rejects(bridge.command('page.wait', { selector: '#x' }, { timeoutMs: 1000 }), error => error.code === 'BROWSER_TIMEOUT' && error.status === 504);
    assert.ok(Date.now() - started >= 1000);
    assert.equal(ext.commands.at(-1).timeout_ms, 1000);
    // page.wait gets at least its own wait plus 5 s.
    const waiting = bridge.command('page.wait', { selector: '#x', timeout_ms: 40000 });
    waiting.catch(() => {}); // awaited below
    await waitFor(() => ext.commands.length === 5);
    assert.equal(ext.commands.at(-1).timeout_ms, 45000);
    ext.close();
    await assert.rejects(waiting, error => error.code === 'BROWSER_NOT_CONNECTED');
  } finally { await close(); }
});

test('several browsers: commands go to the one that connected last, or to params.browser_id', async () => {
  const { bridge, wsUrl, close } = await bridgeServer();
  try {
    const a = pairOnce(bridge, 'Work');
    const b = pairOnce(bridge, 'Home');
    const extA = await fakeExtension(wsUrl, a.token, { handler: () => ({ who: 'a' }) });
    const extB = await fakeExtension(wsUrl, b.token, { handler: () => ({ who: 'b' }) });
    assert.equal((await bridge.command('tabs.list')).who, 'b');
    assert.equal((await bridge.command('tabs.list', { browser_id: a.browser_id })).who, 'a');
    assert.equal('browser_id' in extA.commands[0].params, false, 'browser_id is not sent on');
    await assert.rejects(bridge.command('tabs.list', { browser_id: 'br_000000000000' }), { code: 'BROWSER_NOT_CONNECTED' });
    const status = bridge.status();
    assert.equal(status.active_browser_id, b.browser_id);
    assert.deepEqual(status.browsers.map(item => [item.name, item.online, item.active]), [['Work', true, false], ['Home', true, true]]);
    assert.equal(status.browsers[1].browser.name, 'Chrome');
    extB.close();
    await waitFor(() => bridge.status().active_browser_id === a.browser_id);
    assert.equal((await bridge.command('tabs.list')).who, 'a');
    assert.deepEqual(bridge.rename(a.browser_id, '  Laptop  ').name, 'Laptop');
    assert.throws(() => bridge.rename(a.browser_id, 'two\nlines'), { code: 'INVALID_NAME' });
    assert.throws(() => bridge.rename(a.browser_id, 'x'.repeat(61)), { code: 'INVALID_NAME' });
    assert.throws(() => bridge.rename('br_nope', 'n'), { code: 'BROWSER_NOT_FOUND' });
    extA.close();
  } finally { await close(); }
});

test('recordings: record.start tags the task and terminal, record.items are appended redacted, record.stopped closes; tab events are kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-bridge-rec-'));
  const recordings = createBrowserRecordings({ dir });
  const { bridge, wsUrl, close } = await bridgeServer({ bridgeOptions: { recordings } });
  try {
    const { token, browser_id: browserId } = pairOnce(bridge);
    const ext = await fakeExtension(wsUrl, token, {
      handler(method) {
        if (method === 'record.start') return { recording_id: 'rec_kz1abc_x7q2', tab_id: 7, url: 'https://shop.test/cart?session=s1' };
        if (method === 'record.stop') return { recording_id: 'rec_kz1abc_x7q2', items: 2, duration_ms: 900 };
        return {};
      },
    });
    const started = await bridge.command('record.start', { tab_id: 7 }, { context: { task_id: 12, terminal_id: 'term-a' } });
    assert.equal(started.recording_id, 'rec_kz1abc_x7q2');
    let summary = recordings.get('rec_kz1abc_x7q2');
    assert.deepEqual([summary.task_id, summary.terminal_id, summary.tab_id, summary.browser_id], [12, 'term-a', 7, browserId]);
    assert.deepEqual(summary.origins, ['https://shop.test']);

    ext.event('record.items', { recording_id: 'rec_kz1abc_x7q2', items: [
      { seq: 1, at: 1, kind: 'nav', tab_id: 7, url: 'https://shop.test/login?next=/', from: '', to: 'https://shop.test/login?token=abc' },
      { seq: 2, at: 2, kind: 'request', tab_id: 7, url: 'https://api.shop.test/v1/me', method: 'GET', request: { headers: { Authorization: 'Bearer sekret-123' } }, response: { mime: 'application/json', body: '{"name":"Ann","api_key":"k-1"}' } },
    ] });
    ext.event('tab.handed', { tab_id: 9, url: 'https://mail.test/?auth=zz', title: 'Mail' });
    await waitFor(() => recordings.get('rec_kz1abc_x7q2').items === 2);
    const text = fs.readFileSync(path.join(dir, 'rec_kz1abc_x7q2.jsonl'), 'utf8');
    assert.ok(!text.includes('sekret-123') && !text.includes('k-1') && !text.includes('token=abc'), 'redacted on this side too');
    assert.match(text, /"Authorization":"<redacted:17>"/);
    await waitFor(() => bridge.list()[0].recent_events.length === 1);
    assert.deepEqual(bridge.list()[0].recent_events[0].url, 'https://mail.test/?auth=<redacted:2>');

    await bridge.command('record.stop', { recording_id: 'rec_kz1abc_x7q2' });
    summary = recordings.get('rec_kz1abc_x7q2');
    assert.ok(summary.stopped_at);
    assert.equal(summary.stop_reason, 'stopped');
    assert.deepEqual(summary.kinds, { nav: 1, request: 1 });
    assert.deepEqual(summary.origins, ['https://shop.test', 'https://api.shop.test']);

    // A recording the extension stops by itself (the tab was closed).
    ext.event('record.items', { recording_id: 'rec_kz1abd_aaaa', items: [{ seq: 1, kind: 'click', tab_id: 3, url: 'https://b.test/' }] });
    ext.event('record.stopped', { recording_id: 'rec_kz1abd_aaaa', reason: 'tab closed' });
    await waitFor(() => { try { return recordings.get('rec_kz1abd_aaaa').stopped_at; } catch { return null; } });
    assert.equal(recordings.get('rec_kz1abd_aaaa').stop_reason, 'tab closed');
    assert.equal(recordings.get('rec_kz1abd_aaaa').task_id, null, 'started before this server knew it: no task');
    ext.close();
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('net.get, net.list and page.fetch answers are redacted again unless raw: true; other answers are left alone', async () => {
  const { bridge, wsUrl, close } = await bridgeServer();
  try {
    const { token } = pairOnce(bridge);
    const leaky = { req_id: 'r1', url: 'https://a.test/x?token=t1', request: { headers: { Cookie: 'sid=1' } }, response: { headers: {}, mime: 'application/json', body: '{"password":"pw"}' } };
    const ext = await fakeExtension(wsUrl, token, { handler: method => (method === 'page.eval' ? { value: { token: 'kept' }, type: 'object' } : leaky) });
    const safe = await bridge.command('net.get', { req_id: 'r1' });
    assert.equal(safe.url, 'https://a.test/x?token=<redacted:2>');
    assert.equal(safe.request.headers.Cookie, '<redacted:5>');
    assert.equal(safe.response.body, '{"password":"<redacted:2>"}');
    const raw = await bridge.command('net.get', { req_id: 'r1', raw: true });
    assert.equal(raw.request.headers.Cookie, 'sid=1');
    assert.equal((await bridge.command('page.fetch', { url: '/x' })).request.headers.Cookie, '<redacted:5>');
    assert.deepEqual((await bridge.command('page.eval', { expression: 'x' })).value, { token: 'kept' }, 'page.eval is the caller\'s own code');
    ext.close();
  } finally { await close(); }
});
