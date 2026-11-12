// `tcli browser ...` (scripts/tcli.js with scripts/tcli-browser.js), spawned as a terminal runs it, against the relay (routes/browser-ext.js), the
// bridge and a fake extension (no real browser): parsing (targets, flags, short options), the params sent, the readable output, --json, the
// screenshot file, record items to a file, exit codes, and the message outside a T-Agent terminal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { bridgeServer, fakeExtension, memoryDb } = require('./helpers/fake-browser-ext');
const { createBrowserRecordings } = require('../services/browser-recordings');
const { createBrowserRelayRouter } = require('../routes/browser-ext');

const CLI = path.resolve(__dirname, '../scripts/tcli.js');
const TOKEN = 'd'.repeat(64);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tcli-browser-'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let env;
let ext;
let behaviour = {};

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
  app.use('/api/tcli/browser', createBrowserRelayRouter({ bridge: () => holder.bridge, recordings: () => recordings, db, isLocal: () => true, verifyToken: (task, terminal, token) => task === 21 && terminal === 'term-b' && token === TOKEN }));
  env = await bridgeServer({ app, db, bridgeOptions: { recordings } });
  holder.bridge = env.bridge;
  const { token } = env.bridge.pair({ code: env.bridge.createPairCode().code, name: 'Work Chrome' });
  ext = await fakeExtension(env.wsUrl, token, { handler });
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
