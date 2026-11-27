// The actions of extension 1.0.8 on the server and in tcli ("Actions: drag, upload, fill, check, dialogs" in docs/design/browser-extension.md):
// the bridge's new methods and the options that need a feature (an older extension gets "update it" / "reload it" and nothing reaches it), the
// upload file check (services/browser-upload.js), and `tcli browser drag | upload | fill | check | dialog`, `snapshot --filter / --diff`,
// `shot --zoom / --annotate` and `console --level / --pattern / --since` against the relay, the bridge and fake extensions (no real browser).
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
const { METHODS } = require('../services/browser-bridge');
const { checkUploadFiles, MAX_FILE_BYTES } = require('../services/browser-upload');

const CLI = path.resolve(__dirname, '../scripts/tcli.js');
const TOKEN = 'e'.repeat(64);
const NEW_METHODS = ['input.drag', 'input.upload', 'input.fill', 'input.check', 'page.dialog'];
const NEW_FEATURES = ['input.drag', 'input.upload', 'input.fill', 'input.check', 'page.dialog', 'shot.zoom', 'shot.annotate', 'snapshot.filter', 'snapshot.diff', 'snapshot.frames', 'snapshot.stable_refs', 'console.filter'];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-actions-')));
let env;
let ext;
let old;
let oldId;
let behaviour = {};

function handler(method, params) {
  if (behaviour[method]) return behaviour[method](params);
  switch (method) {
    case 'input.fill': return { fields: params.fields.map(f => (f.label === 'css:#missing' ? { target: f.label, ok: false, code: 'ELEMENT_NOT_FOUND', error: 'No matching element' } : { target: f.label, ok: true, kind: typeof f.value === 'boolean' ? 'checkbox' : 'text', ...(typeof f.value === 'boolean' ? { checked: f.value } : {}) })), filled: params.fields.filter(f => f.label !== 'css:#missing').length };
    case 'input.check': return { checked: params.checked, target: { ref: 'e4', tag: 'input', name: 'Agree' } };
    case 'input.drag': return { dragged: { from: { ref: 'e1' }, to: { x: 5, y: 6 } }, how: 'mouse' };
    case 'input.upload': return { uploaded: { ref: 'e9', tag: 'input' }, files: params.files.map(f => path.basename(f)) };
    case 'page.dialog': return params.action === 'status' ? { open: true, known: true, type: 'confirm', message: 'Delete all?' } : { handled: params.action === 'accept' ? 'accepted' : 'dismissed', known: true, type: 'confirm', message: 'Delete all?' };
    case 'page.snapshot': return { url: 'https://shop.test/', title: 'Shop', viewport: { width: 800, height: 600 }, truncated: false, diff: { base: true, added: [{ ref: 'e14', tag: 'button', role: 'button', name: 'Added' }], removed: [{ ref: 'e3', tag: 'a', role: 'link', name: 'Old link' }], changed: [{ ref: 'e5', tag: 'button', role: 'button', name: 'New label', was: { name: 'Old label' } }], same: 7 } };
    case 'page.screenshot': return { data_base64: PNG.toString('base64'), mime: 'image/png', width: 400, height: 200, ...(params.annotate ? { annotated: 12 } : {}) };
    case 'page.console': return { entries: [{ at: Date.UTC(2026, 10, 27, 1, 2, 3), level: 'warning', text: 'beta two' }] };
    default: return {};
  }
}

test.before(async () => {
  const db = memoryDb();
  db.prepare("INSERT INTO tasks (id, user_id) VALUES (21, 'owner')").run();
  const recordings = createBrowserRecordings({ dir: path.join(work, 'recordings') });
  const holder = {};
  const app = express();
  app.use('/api/tcli/browser', createBrowserRelayRouter({ bridge: () => holder.bridge, recordings: () => recordings, db, isLocal: () => true, verifyToken: (task, terminal, token) => task === 21 && terminal === 'term-a' && token === TOKEN }));
  env = await bridgeServer({ app, db, bridgeOptions: { recordings } });
  holder.bridge = env.bridge;
  const older = env.bridge.pair({ code: env.bridge.createPairCode().code, name: 'Old Chrome' });
  oldId = older.browser_id;
  // Extension 1.0.7: neither the new methods nor the new features.
  old = await fakeExtension(env.wsUrl, older.token, { handler, version: '1.0.7', methods: METHODS.filter(m => !NEW_METHODS.includes(m)), features: [...FEATURES, 'open.window', 'record.tabs'] });
  const { token } = env.bridge.pair({ code: env.bridge.createPairCode().code, name: 'New Chrome' });
  ext = await fakeExtension(env.wsUrl, token, { handler, version: '1.0.8', features: [...FEATURES, 'open.window', 'record.tabs', ...NEW_FEATURES] });
});
test.after(async () => {
  ext.close();
  old.close();
  await env.close();
  fs.rmSync(work, { recursive: true, force: true });
});
test.beforeEach(() => { behaviour = {}; ext.commands.length = 0; old.commands.length = 0; });

const terminalEnv = () => ({ PATH: process.env.PATH, HOME: work, TA_HOOK_URL: `${env.base}/hooks/terminal-activity?task=21&terminal=term-a`, TA_HOOK_TOKEN: TOKEN });
function run(args, { cwd = work } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'browser', ...args], { env: terminalEnv(), cwd });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('close', code => resolve({ code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }));
  });
}
const last = () => ext.commands.at(-1);

test('the bridge sends the new methods, and refuses them and their options for an older extension', async () => {
  for (const method of NEW_METHODS) assert.ok(METHODS.includes(method), method);
  for (const method of NEW_METHODS) {
    await assert.rejects(env.bridge.command(method, { browser_id: oldId }), error => error.code === 'UNKNOWN_METHOD' && error.message === `The connected extension (version 1.0.7) does not support ${method}; update it`, method);
  }
  for (const [method, params, flag] of [
    ['page.snapshot', { filter: 'interactive' }, 'snapshot --filter'], ['page.snapshot', { diff: true }, 'snapshot --diff'],
    ['page.screenshot', { zoom: { x: 0, y: 0, w: 1, h: 1 } }, 'shot --zoom'], ['page.screenshot', { target: { ref: 'e1' }, scale: 2 }, 'shot --scale'], ['page.screenshot', { annotate: true }, 'shot --annotate'],
    ['page.console', { pattern: 'x' }, 'console --pattern'], ['page.console', { levels: ['error'] }, 'console --level'],
  ]) {
    await assert.rejects(env.bridge.command(method, { browser_id: oldId, ...params }), error => error.code === 'UNKNOWN_METHOD' && error.message.includes(flag) && /reload it in chrome:\/\/extensions/.test(error.message), flag);
  }
  assert.equal(old.commands.length, 0, 'nothing reached the older extension');
  await env.bridge.command('page.snapshot', { browser_id: oldId });
  assert.equal(old.commands.length, 1, 'a plain snapshot still works there');
  await env.bridge.command('page.snapshot', { filter: 'interactive', diff: true });
  assert.deepEqual(last().params, { filter: 'interactive', diff: true }, 'the new extension gets them');
});

test('upload files: real files within the limits, never a credential', async () => {
  const home = path.join(work, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'notes.txt'), 'x');
  const good = path.join(work, 'report.pdf');
  fs.writeFileSync(good, 'pdf');
  const link = path.join(work, 'link.pdf');
  fs.symlinkSync(good, link);
  const sshLink = path.join(work, 'innocent.txt');
  fs.symlinkSync(path.join(home, '.ssh', 'notes.txt'), sshLink);
  assert.deepEqual(checkUploadFiles([good, link], { home }), [good, good], 'symlinks resolved');
  const refused = (files, pattern) => assert.throws(() => checkUploadFiles(files, { home }), pattern);
  refused([], /1 to 20/);
  refused(Array(21).fill(good), /1 to 20/);
  refused(['report.pdf'], /absolute/);
  refused([path.join(work, 'missing.txt')], /does not exist/);
  refused([work], /is not a file/);
  refused([path.join(home, '.ssh', 'notes.txt')], /credential/);
  refused([sshLink], /credential/, 'a link into ~/.ssh');
  for (const name of ['.env', '.env.local', 'id_ed25519', 'server.pem', 'credentials.json']) {
    const file = path.join(work, name);
    fs.writeFileSync(file, 'x');
    refused([file], /credential/);
  }
  const big = path.join(work, 'big.bin');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, MAX_FILE_BYTES + 1);
  refused([big], /larger than 100 MiB/);
  // Through the bridge: a refused file never reaches the extension.
  await assert.rejects(env.bridge.command('input.upload', { target: { ref: 'e9' }, files: [path.join(work, '.env')] }), error => error.code === 'BAD_PARAMS' && /credential/.test(error.message));
  assert.equal(ext.commands.length, 0);
  await env.bridge.command('input.upload', { target: { ref: 'e9' }, files: [link] });
  assert.deepEqual(last().params.files, [good], 'the extension gets the real path');
});

test('tcli browser fill, check, drag, upload and dialog', async () => {
  let r = await run(['fill', 'e3=Ann', 'css:input[name=email]=a@b.c', 'e7=true', 'css:#missing=x']);
  assert.equal(r.code, 1, 'a field failed');
  assert.deepEqual(last().params.fields, [
    { label: 'e3', target: { ref: 'e3' }, value: 'Ann' },
    { label: 'css:input[name=email]', target: { selector: 'input[name=email]' }, value: 'a@b.c' },
    { label: 'e7', target: { ref: 'e7' }, value: 'true' },
    { label: 'css:#missing', target: { selector: '#missing' }, value: 'x' },
  ]);
  assert.match(r.out, /^e3: ok \(text\)$/m);
  assert.match(r.out, /^css:#missing: failed: No matching element \(ELEMENT_NOT_FOUND\)$/m);
  assert.match(r.out, /Filled 3 of 4 fields/);
  r = await run(['fill', '--json', '{"e3":"Ann","e7":true,"e9":["a","b"]}']);
  assert.equal(r.code, 0);
  assert.deepEqual(last().params.fields.map(f => [f.label, f.value]), [['e3', 'Ann'], ['e7', true], ['e9', ['a', 'b']]]);
  assert.match(r.out, /^e7: ok \(checkbox, checked\)$/m, 'with --json fields the output stays text');
  r = await run(['fill', '--fields', '{"e3":"Ann"}', '--json']);
  assert.equal(JSON.parse(r.out).filled, 1);
  assert.equal((await run(['fill', 'nothing'])).code, 1);
  assert.equal((await run(['fill', '--json', '{"e3":{"a":1}}'])).code, 1);

  r = await run(['check', 'e4']);
  assert.deepEqual([r.code, r.out.trim(), last().params.checked], [0, 'Checked e4', true]);
  r = await run(['check', 'e4', '--off']);
  assert.deepEqual([r.out.trim(), last().params.checked], ['Unchecked e4', false]);

  r = await run(['drag', 'e1', '300,200', '--steps', '5']);
  assert.equal(r.code, 0);
  assert.deepEqual(last().params, { target: { ref: 'e1' }, to: { x: 300, y: 200 }, steps: 5 });
  assert.match(r.out, /Dragged e1 to 300,200 with the mouse/);
  await run(['drag', 'e1', 'css:#zone', '--html5']);
  assert.deepEqual([last().params.to, last().params.mode], [{ selector: '#zone' }, 'html5']);
  assert.equal((await run(['drag', 'e1'])).code, 1);
  assert.equal((await run(['drag', 'e1', 'e2', '--html5', '--mouse'])).code, 1);

  fs.writeFileSync(path.join(work, 'a.txt'), 'a');
  r = await run(['upload', 'e9', 'a.txt']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(last().params.files, [path.join(work, 'a.txt')], 'an absolute path from the working folder');
  assert.match(r.out, /Set 1 file on e9: a\.txt/);
  const before = ext.commands.length;
  assert.equal((await run(['upload', 'e9', 'missing.txt'])).code, 1);
  assert.equal((await run(['upload', 'e9', '.'])).code, 1);
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=1');
  r = await run(['upload', 'e9', '.env']);
  assert.equal(r.code, 1);
  assert.match(r.err, /credential/);
  assert.equal(ext.commands.length, before, 'refused files never reach the browser');

  r = await run(['dialog']);
  assert.deepEqual([r.code, last().params.action, r.out.trim()], [0, 'status', 'Open: confirm "Delete all?"']);
  r = await run(['dialog', 'accept', '--text', 'Ann']);
  assert.deepEqual([last().params.action, last().params.text, r.out.trim()], ['accept', 'Ann', 'Accepted the confirm "Delete all?"']);
  r = await run(['dialog', 'dismiss']);
  assert.equal(r.out.trim(), 'Dismissed the confirm "Delete all?"');
  behaviour['page.dialog'] = () => ({ open: true, known: false });
  assert.match((await run(['dialog', 'status'])).out, /The page is blocked, most likely by a dialog/);
  behaviour['page.dialog'] = () => ({ open: false, automatic: true });
  assert.match((await run(['dialog'])).out, /answered at once/);
  assert.equal((await run(['dialog', 'dismiss', '--text', 'x'])).code, 1);
  assert.equal((await run(['dialog', 'open'])).code, 1);
  behaviour['page.dialog'] = () => { throw Object.assign(new Error('No dialog is open on this tab'), { code: 'NO_DIALOG' }); };
  r = await run(['dialog', 'accept']);
  assert.equal(r.code, 1);
  assert.match(r.err, /No dialog is open on this tab \(NO_DIALOG\)/);

  r = await run(['drag', 'e1', 'e2', '--browser', oldId]);
  assert.equal(r.code, 1);
  assert.match(r.err, /does not support input\.drag; update it/, 'an older extension: update it');
});

test('tcli browser snapshot --filter / --diff, shot --zoom / --annotate, console --level / --pattern / --since', async () => {
  let r = await run(['snapshot', '--diff', '--filter', 'interactive']);
  assert.equal(r.code, 0);
  assert.deepEqual(last().params, { mode: 'outline', filter: 'interactive', diff: true });
  assert.match(r.out, /1 added, 1 removed, 1 changed, 7 the same/);
  assert.match(r.out, /^\+ e14 button "Added"$/m);
  assert.match(r.out, /^- e3 link "Old link"$/m);
  assert.match(r.out, /^~ e5 button "New label"  \(was name="Old label"\)$/m);
  behaviour['page.snapshot'] = () => ({ url: 'https://shop.test/', title: 'Shop', elements: [{ ref: 'e1', tag: 'button', role: 'button', name: 'In frame', frame: 1 }, { ref: 'e2', tag: 'button', role: 'button', name: 'Deep', shadow: true }], diff: { base: false } });
  r = await run(['snapshot', '--diff']);
  assert.match(r.out, /no earlier snapshot of this page/);
  assert.match(r.out, /^e1 button "In frame" \(in frame\)$/m);
  assert.match(r.out, /^e2 button "Deep" \(in shadow DOM\)$/m);
  assert.equal((await run(['snapshot', '--filter', 'links'])).code, 1);
  assert.equal((await run(['snapshot', '--text', '--diff'])).code, 1);

  r = await run(['shot', '--zoom', '10,20,200,100', '--scale', '3', '-o', 'z.png']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(last().params, { zoom: { x: 10, y: 20, w: 200, h: 100 }, scale: 3 });
  r = await run(['shot', '--annotate', '-o', 'a.png']);
  assert.deepEqual(last().params, { annotate: true });
  assert.match(r.out, /with 12 refs drawn/);
  for (const bad of [['--zoom', '1,2,3'], ['--zoom', '0,0,0,5'], ['--zoom', '0,0,5,5', '--full'], ['--scale', '2'], ['--zoom', '0,0,5,5', '--scale', '9']]) assert.equal((await run(['shot', ...bad, '-o', 'x.png'])).code, 1, bad.join(' '));

  const before = Date.now();
  r = await run(['console', '--level', 'warn,error', '--pattern', 'beta|gamma', '--since', '5000']);
  assert.equal(r.code, 0, r.err);
  const params = last().params;
  assert.deepEqual([params.levels, params.pattern], [['warn', 'error'], 'beta|gamma']);
  assert.ok(params.since >= before - 5000 - 50 && params.since <= Date.now() - 5000 + 50, 'a small --since is the last MS milliseconds');
  assert.match(r.out, /warning beta two/);
  await run(['console', '--since', '1764205323000']);
  assert.equal(last().params.since, 1764205323000, 'an epoch time is kept');
  await run(['console']);
  assert.deepEqual(last().params, {}, 'the default is as before');
  assert.equal((await run(['console', '--level', 'loud'])).code, 1);
  assert.equal((await run(['console', '--pattern', '('])).code, 1);
});
