// `tcli browser ...` (scripts/tcli.js with scripts/tcli-browser.js), spawned as a terminal runs it, against the relay (routes/browser-ext.js), the
// bridge and a fake extension (no real browser): parsing (targets, flags, short options), the params sent, the readable output, --json, the
// screenshot file, record items to a file and with filters, record requests (also against an older T-Agent without the filters), the slim status
// and --verbose, exit codes, and the message outside a T-Agent terminal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { bridgeServer, fakeExtension, memoryDb, FEATURES } = require('./helpers/fake-browser-ext');
const { createBrowserRecordings } = require('../services/browser-recordings');
const { createBrowserRelayRouter } = require('../routes/browser-ext');

const CLI = path.resolve(__dirname, '../scripts/tcli.js');
const TOKEN = 'd'.repeat(64);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tcli-browser-'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let env;
let ext;
let behaviour = {};
let olderServer = false; // the relay answers like a T-Agent from before the recording filters

const ELEMENTS = [
  { ref: 'e1', tag: 'a', role: 'link', name: 'Docs', href: 'https://shop.test/docs', rect: { x: 0, y: 0, w: 10, h: 10 }, in_viewport: true },
  { ref: 'e2', tag: 'input', role: 'textbox', name: 'Search', type: 'text', value: 'shoes', rect: { x: 0, y: 20, w: 10, h: 10 }, in_viewport: true },
  { ref: 'e3', tag: 'button', role: 'button', name: 'Sign in', disabled: true, rect: { x: 0, y: 900, w: 10, h: 10 }, in_viewport: false },
];

function handler(method, params) {
  if (behaviour[method]) return behaviour[method](params);
  switch (method) {
    case 'tabs.list': return { tabs: [{ tab_id: 11, window_id: 1, url: 'https://shop.test/', title: 'Shop', active: true, how: 'group', capturing: true, recording_id: null }, { tab_id: 12, window_id: 1, url: 'https://mail.test/', title: 'Mail', active: false, how: 'handed', capturing: false, recording_id: 'rec_a_b' }] };
    case 'tabs.open': return { tab: { tab_id: 13, url: params.url, title: '' } };
    case 'tabs.navigate': return { tab: { tab_id: params.tab_id || 11, url: params.url || 'https://shop.test/', title: 'Shop' } };
    case 'page.snapshot': return params.mode === 'text' ? { url: 'https://shop.test/', title: 'Shop', text: 'Hello shop', truncated: false } : { url: 'https://shop.test/', title: 'Shop', viewport: { w: 1280, h: 800 }, elements: ELEMENTS, truncated: true };
    case 'input.click': return { clicked: { ref: params.target.ref, tag: 'button', name: 'Sign in' } };
    case 'page.eval': return { value: { n: 2 }, type: 'object', truncated: false };
    case 'page.wait': return { matched: 'selector' };
    case 'page.screenshot': return { data_base64: PNG.toString('base64'), mime: 'image/png', width: 1280, height: 800 };
    case 'net.list': return { requests: [{ req_id: 'r7', at: 1, method: 'GET', url: 'https://api.shop.test/v1/cart?token=abc', type: 'XHR', status: 200, mime: 'application/json', size: 2048, duration_ms: 31, from_cache: false }] };
    case 'net.get': return { req_id: 'r7', method: 'GET', url: 'https://api.shop.test/v1/cart', type: 'XHR', status: 200, request: { headers: { Cookie: params.raw ? 'sid=real' : '<redacted:8>' } }, response: { headers: { 'Content-Type': 'application/json' }, mime: 'application/json', body: '{"items":[1]}', size: 13 }, timing: {} };
    case 'page.fetch': return { status: 201, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', truncated: false };
    case 'record.start': return { recording_id: 'rec_kz9_abcd', tab_id: 11 };
    case 'record.stop': return { recording_id: 'rec_kz9_abcd', items: 1, duration_ms: 4000 };
    default: return {};
  }
}

test.before(async () => {
  const db = memoryDb();
  db.prepare("INSERT INTO tasks (id, user_id) VALUES (21, 'owner')").run();
  const recordings = createBrowserRecordings({ dir: path.join(work, 'recordings') });
  const holder = {};
  const app = express();
  app.use('/api/tcli/browser/recordings', (req, res, next) => {
    if (!olderServer) return next();
    if (/\/requests$/.test(req.path)) return res.status(404).json({ error: 'UNKNOWN_ROUTE', message: 'tcli browser has no such route; update tcli or T-Agent' });
    req.url = req.url.split('?')[0];
    req.query = {};
    return next();
  });
  app.use('/api/tcli/browser', createBrowserRelayRouter({ bridge: () => holder.bridge, recordings: () => recordings, db, isLocal: () => true, verifyToken: (task, terminal, token) => task === 21 && terminal === 'term-b' && token === TOKEN }));
  env = await bridgeServer({ app, db, bridgeOptions: { recordings } });
  holder.bridge = env.bridge;
  const { token } = env.bridge.pair({ code: env.bridge.createPairCode().code, name: 'Work Chrome' });
  ext = await fakeExtension(env.wsUrl, token, { handler, features: FEATURES });
});
test.after(async () => {
  ext.close();
  await env.close();
  fs.rmSync(work, { recursive: true, force: true });
});
test.beforeEach(() => { behaviour = {}; ext.commands.length = 0; });

const terminalEnv = (overrides = {}) => ({ PATH: process.env.PATH, HOME: work, TA_HOOK_URL: `${env.base}/hooks/terminal-activity?task=21&terminal=term-b`, TA_HOOK_TOKEN: TOKEN, ...overrides });
function run(args, { envVars = terminalEnv(), cwd = work } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'browser', ...args], { env: envVars, cwd });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out), out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }));
  });
}
const last = () => ext.commands.at(-1);

test('help, usage errors and outside a terminal', async () => {
  const help = await run(['help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /snapshot/);
  assert.match(help.out, /<target> is e12/);
  assert.equal((await run([])).code, 1);
  const unknown = await run(['fly']);
  assert.deepEqual([unknown.code, /Unknown command "browser fly"/.test(unknown.err)], [1, true]);
  const badTarget = await run(['click', 'button']);
  assert.equal(badTarget.code, 1);
  assert.match(badTarget.err, /is not a target/);
  assert.equal((await run(['snapshot', '--bogus'])).code, 1);
  assert.equal((await run(['net'])).code, 1);
  assert.equal((await run(['record', 'rm', 'rec_a_b'])).code, 1, 'rm needs --yes');
  const outside = await run(['tabs'], { envVars: { PATH: process.env.PATH } });
  assert.equal(outside.code, 2);
  assert.match(outside.err, /tcli works inside a T-Agent terminal/);
  assert.equal(ext.commands.length, 0, 'nothing reached the browser');
});

test('status, tabs, open, go, back, close', async () => {
  const status = await run(['status']);
  assert.equal(status.code, 0);
  assert.match(status.out, /^Connected: Work Chrome \(br_[0-9a-f]{12}\) · extension 1\.0\.0 · Chrome/);
  assert.match(status.out, /connected since \d{4}-\d\d-\d\d \d\d:\d\d · paired /);
  assert.doesNotMatch(status.out, /Methods:/);
  const slim = JSON.parse((await run(['status', '--json'])).out);
  assert.equal(slim.connected, true);
  assert.equal(typeof slim.method_count, 'number');
  assert.equal(slim.methods, undefined, 'the method names only with --verbose');
  assert.deepEqual(Object.keys(slim.browsers[0]).sort(), ['active', 'browser', 'browser_id', 'connected_at', 'last_seen_at', 'methods', 'name', 'online', 'paired_at', 'recent_event_count', 'version']);
  assert.equal(slim.browsers[0].name, 'Work Chrome');
  assert.equal(slim.browsers[0].recent_events, undefined);
  const full = JSON.parse((await run(['status', '--json', '--verbose'])).out);
  assert.ok(Array.isArray(full.methods) && full.methods.includes('tabs.list'));
  assert.ok(Array.isArray(full.browsers[0].recent_events));
  assert.equal(slim.method_count, full.methods.length);
  assert.ok((await run(['status', '--json'])).out.length < (await run(['status', '--json', '--verbose'])).out.length);
  assert.match((await run(['status', '--verbose'])).out, /\nMethods: .*tabs\.list/);
  const tabs = await run(['tabs']);
  assert.match(tabs.out, /11\* \[group, net\] Shop  https:\/\/shop\.test\//);
  assert.match(tabs.out, /12  \[handed, rec rec_a_b\] Mail/);
  const json = await run(['tabs', '--json']);
  assert.equal(JSON.parse(json.out).tabs.length, 2);
  assert.match((await run(['open', 'https://shop.test/new', '--active'])).out, /^Opened tab 13: https:\/\/shop\.test\/new/);
  assert.deepEqual(last().params, { url: 'https://shop.test/new', active: true });
  await run(['go', '12', 'https://mail.test/inbox']);
  assert.deepEqual(last().params, { tab_id: 12, url: 'https://mail.test/inbox', wait: 'load' });
  await run(['go', 'https://shop.test/a', '--no-wait', '--tab', '11']);
  assert.deepEqual(last().params, { tab_id: 11, url: 'https://shop.test/a', wait: 'none' });
  await run(['back']);
  assert.deepEqual([last().method, last().params], ['tabs.navigate', { action: 'back', wait: 'load' }]);
  behaviour['tabs.close'] = () => ({ released: true });
  assert.match((await run(['close', '12'])).out, /Released the tab/);
  assert.deepEqual(last().params, { tab_id: 12 });
});

test('snapshot outline and text, click by ref, type, press, eval, wait', async () => {
  const outline = await run(['snapshot']);
  assert.equal(outline.code, 0);
  const lines = outline.out.trim().split('\n');
  assert.equal(lines[0], 'Shop  https://shop.test/');
  assert.equal(lines[1], '3 elements · viewport 1280x800');
  assert.equal(lines[2], 'e1 link "Docs" -> https://shop.test/docs');
  assert.equal(lines[3], 'e2 textbox "Search" type=text value="shoes"');
  assert.equal(lines[4], 'e3 button "Sign in" [disabled] (off screen)');
  assert.match(lines[5], /cut at the size limit/);
  assert.deepEqual(last().params, { mode: 'outline' });
  assert.match((await run(['snapshot', '--text', '--selector', 'main', '--tab', '11'])).out, /Hello shop/);
  assert.deepEqual(last().params, { tab_id: 11, mode: 'text', selector: 'main' });

  assert.equal((await run(['click', 'e3'])).out.trim(), 'Clicked e3 button "Sign in"');
  await run(['click', 'css:#buy > .btn', '--right', '--modifiers', 'Shift,Meta']);
  assert.deepEqual(last().params, { target: { selector: '#buy > .btn' }, button: 'right', modifiers: ['Shift', 'Meta'] });
  await run(['click', 'text:Sign in', '--double']);
  assert.deepEqual(last().params, { target: { text: 'Sign in' }, count: 2 });
  await run(['click', '100,200.5']);
  assert.deepEqual(last().params.target, { x: 100, y: 200.5 });
  assert.match((await run(['type', 'e2', 'red shoes', '--clear', '--submit'])).out, /Typed 9 characters into e2 and submitted/);
  assert.deepEqual(last().params, { target: { ref: 'e2' }, text: 'red shoes', clear: true, submit: true });
  assert.equal((await run(['press', 'Enter'])).out.trim(), 'Pressed Enter');
  const evaled = await run(['eval', 'document.title']);
  assert.deepEqual(JSON.parse(evaled.out), { n: 2 });
  fs.writeFileSync(path.join(work, 'snippet.js'), 'return 1 + 1;');
  await run(['eval', '--file', 'snippet.js', '--no-await']);
  assert.deepEqual(last().params, { expression: 'return 1 + 1;', await_promise: false });
  assert.equal((await run(['wait', '--selector', '#done', '--timeout', '5000'])).out.trim(), 'Matched: selector');
  assert.deepEqual(last().params, { selector: '#done', timeout_ms: 5000 });
  assert.equal((await run(['wait'])).code, 1);
});

test('shot writes the file (and -o - writes the bytes to stdout); console', async () => {
  const shot = await run(['shot', '-o', 'page.png']);
  assert.equal(shot.code, 0);
  assert.match(shot.out, /Saved .*page\.png \(1280x800, 7 B\)/);
  assert.deepEqual(fs.readFileSync(path.join(work, 'page.png')), PNG);
  assert.equal((await run(['shot', '-o', 'page.png'])).code, 1, 'no overwrite without --force');
  const json = JSON.parse((await run(['shot', '-o', 'page.png', '--force', '--json', '--full'])).out);
  assert.equal(json.data_base64, undefined, 'the image is in the file, not in the JSON');
  assert.equal(json.size, PNG.length);
  assert.deepEqual(last().params, { full_page: true });
  assert.deepEqual((await run(['shot', '-o', '-'])).stdout, PNG);
  behaviour['page.console'] = () => ({ entries: [{ at: Date.parse('2026-11-12T08:00:01.250Z'), level: 'error', text: 'Uncaught TypeError: x' }] });
  assert.equal((await run(['console'])).out.trim(), '08:00:01.250 error Uncaught TypeError: x');
});

test('net list / get (raw warns), fetch with -X -H -d, errors with exit codes', async () => {
  const list = await run(['net', 'list', '--type', 'XHR,Fetch', '--filter', '/v1/']);
  assert.match(list.out, /^r7\s+GET\s+200 XHR\s+2\.0 KB\s+31ms {2}https:\/\/api\.shop\.test\/v1\/cart\?token=<redacted:3>/, 'redacted again by the server');
  assert.deepEqual(last().params, { url_includes: '/v1/', types: ['XHR', 'Fetch'] });
  const get = await run(['net', 'get', 'r7']);
  assert.match(get.out, /Cookie: <redacted:8>/);
  assert.match(get.out, /Response body:\n\{"items":\[1\]\}/);
  const raw = await run(['net', 'get', 'r7', '--raw', '--body-out', 'body.json']);
  assert.match(raw.err, /--raw shows real cookies/);
  assert.match(raw.out, /Cookie: sid=real/);
  assert.equal(fs.readFileSync(path.join(work, 'body.json'), 'utf8'), '{"items":[1]}');
  await run(['net', 'start', '--filter', 'api', '--no-bodies']);
  assert.deepEqual(last().params, { bodies: false, filter: { url_includes: 'api' } });
  const fetched = await run(['fetch', '/api/cart', '-X', 'put', '-H', 'X-Thing: 1', '-H', 'Accept: application/json', '-d', '{"a":1}']);
  assert.match(fetched.out, /^Status 201/);
  assert.deepEqual(last().params, { url: '/api/cart', method: 'PUT', headers: { 'X-Thing': '1', Accept: 'application/json' }, body: '{"a":1}' });
  await run(['fetch', '/api/x', '-d', 'q=1']);
  assert.equal(last().params.method, 'POST', '-d alone means POST');

  behaviour['input.click'] = () => { throw Object.assign(new Error('Tab 9 is not a T-Agent tab'), { code: 'TAB_NOT_ALLOWED' }); };
  const refused = await run(['click', 'e1', '--tab', '9']);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /Tab 9 is not a T-Agent tab \(TAB_NOT_ALLOWED\)/);
  const refusedJson = await run(['click', 'e1', '--json']);
  assert.equal(JSON.parse(refusedJson.err).error, 'TAB_NOT_ALLOWED');
  behaviour['page.query'] = () => { throw Object.assign(new Error('Stale ref'), { code: 'REF_NOT_FOUND' }); };
  assert.equal((await run(['query', 'button'])).code, 3);
});

test('open --record and the record filters: params, checks, output, the filters in record show', async () => {
  const help = await run(['help']);
  assert.match(help.out, /--record/);
  assert.match(help.out, /--types T/);
  assert.match(help.out, /--max-body N/);
  behaviour['tabs.open'] = params => ({ tab: { tab_id: 14, url: params.url, title: '' }, ...(params.record ? { recording_id: 'rec_kzo_abcd' } : {}) });
  const opened = await run(['open', 'https://shop.test/new', '--record', '--types', 'xhr,FETCH', '--max-body', '1000']);
  assert.equal(opened.code, 0, opened.err);
  assert.match(opened.out, /^Opened tab 14: https:\/\/shop\.test\/new\nRecording rec_kzo_abcd from the first load/);
  assert.deepEqual(last().params, { url: 'https://shop.test/new', record: { types: ['XHR', 'Fetch'], max_body_bytes: 1000 } });
  await run(['open', 'https://shop.test/plain', '--record']);
  assert.deepEqual(last().params, { url: 'https://shop.test/plain', record: {} });
  const count = ext.commands.length;
  const without = await run(['open', 'https://shop.test/new', '--types', 'XHR']);
  assert.equal(without.code, 1);
  assert.match(without.err, /need --record/);

  behaviour['record.start'] = () => ({ recording_id: 'rec_kzf_abcd', tab_id: 11, url: 'https://shop.test/', options: { network: true, dom: true, bodies: true, types: ['document', 'xhr'], drop_other_types: true, max_body_bytes: 0 } });
  assert.equal((await run(['record', 'start', '--types', 'Document,xhr', '--drop-other-types', '--max-body', '0'])).code, 0);
  assert.deepEqual(last().params, { types: ['Document', 'XHR'], drop_other_types: true, max_body_bytes: 0 });
  await run(['record', 'start', '--type', 'XHR']);
  assert.deepEqual(last().params, { types: ['XHR'] }, '--type is the same as --types');
  const bogus = await run(['record', 'start', '--types', 'XHR,bogus']);
  assert.equal(bogus.code, 1);
  assert.match(bogus.err, /"bogus" is not a resource type/);
  assert.equal((await run(['record', 'start', '--drop-other-types'])).code, 1);
  assert.equal((await run(['record', 'start', '--max-body', '-5'])).code, 1);
  assert.equal(ext.commands.length, count + 2, 'refused options never reach the browser');
  assert.match((await run(['record', 'show', 'rec_kzf_abcd'])).out, /filters {3}only document,xhr · bodies cut at /);
});

test('record start / stop / list / show / items / rm', async () => {
  assert.match((await run(['record', 'start', '--no-dom'])).out, /^Recording rec_kz9_abcd/);
  assert.deepEqual(last().params, { dom: false });
  ext.event('record.items', { recording_id: 'rec_kz9_abcd', items: [{ seq: 1, at: 1, kind: 'click', tab_id: 11, url: 'https://shop.test/', target: { tag: 'button', name: 'Buy' } }] });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.match((await run(['record', 'stop'])).out, /^Stopped rec_kz9_abcd: 1 items in 4 s/);
  const listed = await run(['record', 'list']);
  assert.match(listed.out, /^rec_kz9_abcd .* stopped\s+1 items/);
  const shown = await run(['record', 'show', 'rec_kz9_abcd']);
  assert.match(shown.out, /items {5}1/);
  assert.match(shown.out, /task {6}21 \(terminal term-b\)/, 'tagged with the terminal that started it');
  assert.match(shown.out, /kinds {5}click 1/);
  const items = await run(['record', 'items', 'rec_kz9_abcd']);
  assert.equal(JSON.parse(items.out.trim()).target.name, 'Buy');
  const saved = await run(['record', 'items', 'rec_kz9_abcd', '-o', 'rec.jsonl']);
  assert.match(saved.out, /^Saved .*rec\.jsonl/);
  assert.equal(fs.readFileSync(path.join(work, 'rec.jsonl'), 'utf8'), items.out);
  assert.equal((await run(['record', 'show', 'rec_none_0000'])).code, 3);
  assert.match((await run(['record', 'rm', 'rec_kz9_abcd', '--yes'])).out, /^Removed rec_kz9_abcd/);
  assert.equal((await run(['record', 'items', 'rec_kz9_abcd'])).code, 3);
});

test('record items filters and record requests, the same against an older T-Agent', async () => {
  ext.event('record.items', { recording_id: 'rec_rd_abcd', items: [
    { seq: 1, at: 1000, kind: 'nav', tab_id: 11, url: 'https://shop.test/' },
    { seq: 2, at: 1001, kind: 'request', tab_id: 11, req_id: 'r1', method: 'POST', url: 'https://shop.test/api/cart', type: 'Fetch', status: 0 },
    { seq: 3, at: 1002, kind: 'request', tab_id: 11, req_id: 'r2', method: 'GET', url: 'https://cdn.shop.test/app.js', type: 'Script', status: 0 },
    { seq: 4, at: 1003, kind: 'click', tab_id: 11, url: 'https://shop.test/', source: 'agent', target: { tag: 'button', name: 'Buy' } },
    { seq: 5, at: 1031, kind: 'response', tab_id: 11, req_id: 'r1', method: 'POST', url: 'https://shop.test/api/cart', type: 'Fetch', status: 201,
      request: { headers: { 'Content-Type': 'application/json' }, post_data: '{"sku":7}' }, response: { headers: { 'content-type': 'application/json' }, mime: 'application/json', size: 11, body: '{"ok":true}' }, timing: { started_at: 1001, finished_at: 1031 } },
    { seq: 6, at: 1040, kind: 'response', tab_id: 11, req_id: 'r2', url: 'https://cdn.shop.test/app.js', type: 'Script', status: 200, response: { body: 'code()' } },
    { seq: 7, at: 1050, kind: 'request', tab_id: 11, req_id: 'r3', method: 'GET', url: 'https://shop.test/api/stock', type: 'XHR', status: 0 },
    { seq: 8, at: 1060, kind: 'response', tab_id: 11, req_id: 'r4', method: 'GET', url: 'https://shop.test/api/me', type: 'XHR', status: 403, response: {} },
  ] });
  await new Promise(resolve => setTimeout(resolve, 50));
  const seqs = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).seq);
  const reads = async () => ({
    net: seqs((await run(['record', 'items', 'rec_rd_abcd', '--kind', 'net', '--type', 'fetch'])).out),
    agent: seqs((await run(['record', 'items', 'rec_rd_abcd', '--source', 'agent'])).out),
    errors: seqs((await run(['record', 'items', 'rec_rd_abcd', '--url', '/\\/api\\//', '--status', '4xx,201'])).out),
    page: seqs((await run(['record', 'items', 'rec_rd_abcd', '--kind', 'request,response', '--offset', '1', '--limit', '2'])).out),
    requests: (await run(['record', 'requests', 'rec_rd_abcd', '--json'])).out,
    human: (await run(['record', 'requests', 'rec_rd_abcd'])).out,
  });
  const now = await reads();
  assert.deepEqual([now.net, now.agent, now.errors, now.page], [[2, 5], [4], [5, 8], [3, 5]]);
  const entries = now.requests.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(entries.map(entry => [entry.req_id, entry.status, entry.missing || '']), [['r1', 201, ''], ['r3', null, 'response'], ['r4', 403, 'request']]);
  assert.deepEqual([entries[0].request.post_data, entries[0].response.body, entries[0].duration_ms], ['{"sku":7}', '{"ok":true}', 30]);
  const human = now.human.trim().split('\n');
  assert.match(human[0], /^r1\s+POST\s+201 Fetch\s+11 B\s+30ms body 9 B {2}https:\/\/shop\.test\/api\/cart$/);
  assert.match(human[1], /^r3\s+GET\s+\.\.\. XHR .*\(no response\) {2}https:\/\/shop\.test\/api\/stock$/);
  assert.match(human[2], /^r4 .* 403 .*\(request not recorded\)/);
  assert.equal(human[3], '(1 static files left out: --all keeps them)');
  assert.match(human[4], /--json or -o file\.jsonl/);

  olderServer = true;
  try { assert.deepEqual(await reads(), now, 'tcli filters and merges itself when T-Agent cannot'); } finally { olderServer = false; }

  const all = (await run(['record', 'requests', 'rec_rd_abcd', '--all', '--json'])).out.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(all.map(entry => entry.req_id), ['r1', 'r2', 'r3', 'r4']);
  const scripts = (await run(['record', 'requests', 'rec_rd_abcd', '--type', 'script'])).out;
  assert.match(scripts, /^r2 .*app\.js\n/);
  assert.doesNotMatch(scripts, /left out/);
  const saved = await run(['record', 'requests', 'rec_rd_abcd', '--status', '2xx', '-o', 'req.jsonl']);
  assert.match(saved.out, /^Saved .*req\.jsonl \(1 requests, /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'req.jsonl'), 'utf8')).req_id, 'r1');
  assert.equal((await run(['record', 'requests', 'rec_rd_abcd', '-o', 'req.jsonl'])).code, 1, 'no overwrite without --force');
  const filteredFile = await run(['record', 'items', 'rec_rd_abcd', '--kind', 'click', '-o', 'clicks.jsonl', '--json']);
  assert.equal(path.basename(JSON.parse(filteredFile.out).file), 'clicks.jsonl');
  assert.deepEqual(seqs(fs.readFileSync(path.join(work, 'clicks.jsonl'), 'utf8')), [4]);
  assert.match((await run(['record', 'requests', 'rec_rd_abcd', '--url', 'nothing-here'])).out, /^No requests match/);
  const bad = await run(['record', 'items', 'rec_rd_abcd', '--status', '6xx']);
  assert.deepEqual([bad.code, /--status takes codes like 200, 4xx/.test(bad.err)], [1, true]);
  assert.equal((await run(['record', 'items', 'rec_rd_abcd', '--source', 'robot'])).code, 1);
  assert.equal((await run(['record', 'requests', 'rec_none_0000'])).code, 3);
  assert.match((await run(['help'])).out, /record requests <id>/);
});

test('open --keep, dialogs on stderr, the help on focus and closing, an older extension in status', async () => {
  const help = await run(['help']);
  assert.match(help.out, /--keep +keep it open after your/);
  assert.match(help.out, /T-Agent's own window/);
  assert.match(help.out, /close by themselves 2 minutes after/);
  assert.match(help.out, /the tab need\s+not be active/);
  const kept = await run(['open', 'https://shop.test/keep', '--keep']);
  assert.equal(kept.code, 0);
  assert.deepEqual(last().params, { url: 'https://shop.test/keep', keep: true });
  assert.match(kept.out, /^Opened tab 13: https:\/\/shop\.test\/keep\nIt stays open after your turn: tell the person/);
  assert.deepEqual(ext.commands.filter(cmd => cmd.method === 'tabs.open').length, 1);
  behaviour['input.click'] = () => ({ clicked: { ref: 'e1', tag: 'button', name: 'Delete' }, dialogs: [{ at: 1, type: 'confirm', message: 'Delete\nall?', url: 'https://shop.test/', handled: 'dismissed' }] });
  const click = await run(['click', 'e1']);
  assert.equal(click.code, 0);
  assert.equal(click.out, 'Clicked e1 button "Delete"\n');
  assert.equal(click.err, 'dialog: confirm "Delete all?" (dismissed)\n');
  assert.equal(JSON.parse((await run(['click', 'e1', '--json'])).out).dialogs[0].type, 'confirm');
  behaviour['tabs.list'] = () => ({ tabs: [{ tab_id: 13, url: 'https://shop.test/keep', title: 'Keep', active: false, how: 'group', keep: true }] });
  assert.match((await run(['tabs'])).out, /13  \[group, keep\] Keep/);
  const status = await run(['status']);
  assert.match(status.out, new RegExp(`T-Agent has extension ${require('../extensions/chrome/manifest.json').version.replace(/\./g, '\\.')}: .*reload it once in chrome://extensions if it stays at 1\\.0\\.0`));
});

test('status when nothing is connected: exit 4 and how to pair', async () => {
  ext.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const status = await run(['status']);
  assert.equal(status.code, 4);
  assert.match(status.out, /No browser is connected/);
  assert.match(status.out, /Work Chrome \(br_[0-9a-f]{12}\): offline/);
  const tabs = await run(['tabs']);
  assert.equal(tabs.code, 4);
  assert.match(tabs.err, /BROWSER_NOT_CONNECTED/);
});
