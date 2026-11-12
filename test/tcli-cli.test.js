// scripts/tcli.js, spawned as a terminal would run it, against a relay on loopback (routes/tcli.js with a fake ali-oss client): every `oss`
// command, --json, the exit codes, the overwrite guard of get, rm --yes, and the message outside a T-Agent terminal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const express = require('express');
const { createOssImages } = require('../services/oss-images');
const { createOssFiles } = require('../services/oss-files');
const { createOssAgentSettings } = require('../services/oss-agent-settings');
const { createTcliRelayRouter } = require('../routes/tcli');
const { createFakeOss, memoryDb, CONFIG, SECRET } = require('./helpers/fake-oss');

const CLI = path.resolve(__dirname, '../scripts/tcli.js');
const TOKEN = 'c'.repeat(64);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tcli-cli-'));
const seen = [];

const db = memoryDb();
db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id TEXT)');
db.prepare("INSERT INTO tasks (id, user_id) VALUES (12, 'owner')").run();
const fake = createFakeOss();
const images = createOssImages({ db, sessionSecret: 'test-secret', createClient: options => fake.createClient(options) });
images.saveConfig('owner', CONFIG);
const settings = createOssAgentSettings({ db });
let base;
let server;

test.before(async () => {
  const app = express();
  app.use((req, res, next) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); next(); });
  app.use('/api/tcli', createTcliRelayRouter({
    db, files: () => createOssFiles({ images }), settings: () => settings, owner: () => 'owner', linked: () => null,
    verifyToken: (task, terminal, token) => task === 12 && terminal === 'term-a' && token === TOKEN,
  }));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
});

// Only what tcli reads: no TA_* of the terminal this test may itself run in.
function terminalEnv(overrides = {}) {
  return {
    PATH: process.env.PATH, HOME: work,
    TA_HOOK_URL: `${base}/hooks/terminal-activity?task=12&terminal=term-a`, TA_HOOK_TOKEN: TOKEN, ...overrides,
  };
}

function run(args, { env = terminalEnv(), cwd = work } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out), out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }));
  });
}

test('outside a T-Agent terminal: exit 2 with one clear line (also with --json)', async () => {
  for (const env of [{ PATH: process.env.PATH }, { PATH: process.env.PATH, TA_HOOK_URL: `${base}/hooks/terminal-activity?task=12&terminal=term-a` }, terminalEnv({ TA_HOOK_URL: 'not a url' }), terminalEnv({ TA_HOOK_URL: `${base}/hooks/terminal-activity` })]) {
    const result = await run(['oss', 'ls'], { env });
    assert.equal(result.code, 2);
    assert.match(result.err, /tcli works inside a T-Agent terminal/);
  }
  const json = await run(['oss', 'ls', '--json'], { env: { PATH: process.env.PATH } });
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.err).exit, 2);
});

test('help and usage errors', async () => {
  const help = await run(['help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /tcli <group> <command>/);
  assert.equal((await run(['--help'])).code, 0);
  const none = await run([], { env: { PATH: process.env.PATH } });
  assert.equal(none.code, 1);
  assert.match(none.err, /Usage: tcli/);
  const ossHelp = await run(['oss', 'help']);
  assert.equal(ossHelp.code, 0);
  assert.match(ossHelp.out, /rm <key\.\.\.> --yes/);
  // Phone-width help: no line over 50 columns.
  for (const line of `${help.out}\n${ossHelp.out}`.split('\n')) assert.ok(line.length <= 50, line);
  assert.equal((await run(['oss'])).code, 1);
  assert.equal((await run(['nope', 'x'])).code, 1);
  assert.equal((await run(['oss', 'explode'])).code, 1);
  const flag = await run(['oss', 'ls', '--bogus']);
  assert.equal(flag.code, 1);
  assert.match(flag.err, /Unknown option --bogus/);
  assert.equal((await run(['oss', 'stat'])).code, 1);
  assert.equal((await run(['oss', 'cp', 'only-one'])).code, 1);
});

test('put: default key is the file name, --prefix and --content-type, prints the key and URL; the terminal headers are sent', async () => {
  const file = path.join(work, 'report.pdf');
  fs.writeFileSync(file, '%PDF-1.7 test');
  seen.length = 0;
  const put = await run(['oss', 'put', 'report.pdf']);
  assert.equal(put.code, 0, put.err);
  const [first, url] = put.out.trim().split('\n');
  assert.equal(first, 'Uploaded report.pdf (13 B)');
  assert.match(url, /^https:\/\/tcli-bucket\.oss-cn-hangzhou\.aliyuncs\.com\/report\.pdf\?/);
  assert.equal(fake.objects.get('report.pdf').type, 'application/pdf', 'type from the name');
  const request = seen.find(entry => entry.method === 'PUT');
  assert.equal(request.headers['x-t-agent-task'], '12');
  assert.equal(request.headers['x-t-agent-terminal'], 'term-a');
  assert.equal(request.headers['x-t-agent-token'], TOKEN);
  assert.equal(request.headers['content-length'], '13');

  assert.equal((await run(['oss', 'put', file, 'docs/r.pdf', '--prefix', 'team/'])).out.split('\n')[0], 'Uploaded team/docs/r.pdf (13 B)');
  const typed = await run(['oss', 'put', file, 'x.bin', '--content-type', 'text/plain', '--json']);
  const answer = JSON.parse(typed.out);
  assert.equal(answer.key, 'x.bin');
  assert.equal(answer.content_type, 'text/plain');
  assert.equal(fake.objects.get('x.bin').type, 'text/plain');
  fs.writeFileSync(path.join(work, 'page.html'), '<script>1</script>');
  assert.equal(JSON.parse((await run(['oss', 'put', 'page.html', '--json'])).out).content_type, 'application/octet-stream');

  const missing = await run(['oss', 'put', 'nope.txt']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /does not exist/);
  assert.equal((await run(['oss', 'put', work])).code, 1, 'a folder is refused');
  assert.equal((await run(['oss', 'put', file, '/abs.pdf'])).code, 1, 'a 400 from the server');

  const big = crypto.randomBytes(1024 * 1024 + 5);
  fs.writeFileSync(path.join(work, 'big.bin'), big);
  assert.equal((await run(['oss', 'put', 'big.bin', 'bin/big.bin'])).code, 0);
  assert.deepEqual(fake.objects.get('bin/big.bin').body, big);
});

test('ls: one level, --recursive, --all over pages, --json; empty and truncated hints', async () => {
  for (let i = 0; i < 25; i += 1) fake.store(`many/item-${String(i).padStart(2, '0')}.txt`, Buffer.from('x'.repeat(i)));
  fake.store('many/sub/deep.txt', Buffer.from('deep'));
  const one = await run(['oss', 'ls', 'many/', '--max', '5']);
  assert.equal(one.code, 0);
  const lines = one.out.split('\n').filter(Boolean);
  assert.match(lines[0], /^\s+\d+ B {2}2026-11-12 08:30 {2}many\/item-00\.txt$/);
  assert.match(lines.at(-1), /^More: --all, or --marker many\/item-04\.txt$/);
  assert.ok(lines.every(line => line.length <= 80));

  const all = await run(['oss', 'ls', 'many/', '--all', '--max', '10', '--json']);
  const merged = JSON.parse(all.out);
  assert.equal(merged.objects.length, 25);
  assert.deepEqual(merged.prefixes, ['many/sub/']);
  assert.equal(merged.truncated, false);
  assert.equal(seen.filter(entry => entry.url.startsWith('/api/tcli/oss/list') && entry.url.includes('max=10')).length >= 3, true, 'followed the markers');

  const human = await run(['oss', 'ls', 'many/', '--all']);
  assert.match(human.out, /^ {5}dir {2}many\/sub\/$/m);
  const recursive = await run(['oss', 'ls', 'many/', '--recursive', '--json', '--max', '1000']);
  assert.ok(JSON.parse(recursive.out).objects.some(object => object.key === 'many/sub/deep.txt'));
  assert.ok(seen.some(entry => entry.url.includes('delimiter=&') || entry.url.endsWith('delimiter=')), 'recursive sends an empty delimiter');
  assert.equal((await run(['oss', 'ls', 'nothing-here/'])).out.trim(), 'Nothing under nothing-here/');
  assert.equal((await run(['oss', 'ls', '--max', 'many'])).code, 1);
});

test('stat: human and --json; a missing key exits 3', async () => {
  fake.store('s/one.txt', Buffer.from('hello'), { type: 'text/plain', meta: { by: 'agent' } });
  const stat = await run(['oss', 'stat', 's/one.txt']);
  assert.equal(stat.code, 0);
  assert.match(stat.out, /^s\/one\.txt\n {2}size {6}5 B \(5 bytes\)\n {2}type {6}text\/plain/);
  assert.match(stat.out, /meta by: agent/);
  assert.equal(JSON.parse((await run(['oss', 'stat', 's/one.txt', '--json'])).out).size, 5);
  const missing = await run(['oss', 'stat', 's/none.txt']);
  assert.equal(missing.code, 3);
  assert.match(missing.err, /The object does not exist \(NOT_FOUND\)/);
  const json = await run(['oss', 'stat', 's/none.txt', '--json']);
  assert.deepEqual(JSON.parse(json.err), { error: 'NOT_FOUND', message: 'The object does not exist', exit: 3 });
});

test('get: saves to ./<name>, refuses to overwrite without --force, -o file, -o - to stdout, missing exits 3', async () => {
  const body = crypto.randomBytes(300 * 1024);
  fake.store('g/blob.bin', body);
  const dir = fs.mkdtempSync(path.join(work, 'get-'));
  const first = await run(['oss', 'get', 'g/blob.bin'], { cwd: dir });
  assert.equal(first.code, 0, first.err);
  assert.match(first.out.trim(), /^Saved \/.*\/get-[^/]+\/blob\.bin \(300 KB\)$/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'blob.bin')), body);

  fs.writeFileSync(path.join(dir, 'blob.bin'), 'mine');
  const again = await run(['oss', 'get', 'g/blob.bin'], { cwd: dir });
  assert.equal(again.code, 1);
  assert.match(again.err, /exists; add --force/);
  assert.equal(fs.readFileSync(path.join(dir, 'blob.bin'), 'utf8'), 'mine', 'untouched');
  assert.equal((await run(['oss', 'get', 'g/blob.bin', '--force'], { cwd: dir })).code, 0);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'blob.bin')), body);

  const named = await run(['oss', 'get', 'g/blob.bin', '-o', 'copy.bin', '--json'], { cwd: dir });
  assert.equal(JSON.parse(named.out).size, body.length);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'copy.bin')), body);

  const piped = await run(['oss', 'get', 'g/blob.bin', '-o', '-'], { cwd: dir });
  assert.equal(piped.code, 0);
  assert.deepEqual(piped.stdout, body);

  const missing = await run(['oss', 'get', 'g/none.bin'], { cwd: dir });
  assert.equal(missing.code, 3);
  assert.equal(fs.existsSync(path.join(dir, 'none.bin')), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['blob.bin', 'copy.bin'], 'no partial file left behind');
  assert.equal((await run(['oss', 'get', 'g/'], { cwd: dir })).code, 1, 'a folder key needs -o');
});

test('cp, mv, rm (needs --yes), url', async () => {
  fake.store('m/a.txt', Buffer.from('A'), { type: 'text/plain' });
  const cp = await run(['oss', 'cp', 'm/a.txt', 'm/b.txt']);
  assert.equal(cp.out.trim(), 'Copied m/a.txt -> m/b.txt');
  const mv = await run(['oss', 'mv', 'm/b.txt', 'm/c.txt', '--json']);
  assert.equal(JSON.parse(mv.out).moved, true);
  assert.equal(fake.objects.has('m/b.txt'), false);
  assert.equal((await run(['oss', 'cp', 'm/none', 'm/x'])).code, 3);

  const noYes = await run(['oss', 'rm', 'm/a.txt', 'm/c.txt']);
  assert.equal(noYes.code, 1);
  assert.match(noYes.err, /rm needs --yes/);
  assert.equal(fake.objects.has('m/a.txt'), true);
  const rm = await run(['oss', 'rm', 'm/a.txt', 'm/c.txt', '--yes']);
  assert.equal(rm.code, 0);
  assert.equal(rm.out.trim(), 'Removed m/a.txt\nRemoved m/c.txt');
  fake.store('locked/keep', Buffer.from('k'));
  const partly = await run(['oss', 'rm', 'locked/keep', '--yes', '--json']);
  assert.equal(partly.code, 4, 'a key OSS did not delete is a failure');
  assert.deepEqual(JSON.parse(partly.out).failed, ['locked/keep']);

  const url = await run(['oss', 'url', 'm/a.txt', '--expires', '120']);
  assert.equal(url.code, 0);
  assert.match(url.out.trim(), /^https:\/\/\S+x-oss-expires=120\S*$/);
  assert.match(url.err, /^Valid until \d{4}-/);
  assert.equal(JSON.parse((await run(['oss', 'url', 'm/a.txt', '--json'])).out).method, 'GET');
  assert.equal((await run(['oss', 'url', 'm/a.txt', '--expires', '5'])).code, 1, 'a 400 from the server');
  assert.equal((await run(['oss', 'url', 'm/a.txt', '--expires', 'soon'])).code, 1);
});

test('exit codes: refused token and switch off 2, OSS failure 4, unreachable T-Agent 4; the secret is never printed', async () => {
  const refused = await run(['oss', 'ls'], { env: terminalEnv({ TA_HOOK_TOKEN: 'd'.repeat(64) }) });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /terminal token is not valid \(TCLI_AUTH_INVALID\)/);

  settings.setEnabled(false);
  const off = await run(['oss', 'ls']);
  assert.equal(off.code, 2);
  assert.match(off.err, /turned off on this engine \(OSS_AGENT_ACCESS_OFF\)/);
  settings.setEnabled(true);

  fake.failWith(Object.assign(new Error(`signature mismatch ${SECRET}`), { status: 403, code: 'SignatureDoesNotMatch' }));
  const failed = await run(['oss', 'ls']);
  assert.equal(failed.code, 4);
  assert.match(failed.err, /The OSS request failed \(SignatureDoesNotMatch\) \(OSS_REQUEST_FAILED\)/);
  assert.equal(failed.err.includes(SECRET), false);

  const down = await run(['oss', 'ls'], { env: terminalEnv({ TA_HOOK_URL: 'http://127.0.0.1:1/hooks/terminal-activity?task=12&terminal=term-a' }) });
  assert.equal(down.code, 4);
  assert.match(down.err, /Cannot reach T-Agent/);
});
