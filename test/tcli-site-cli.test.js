// scripts/tcli.js `site` group (scripts/tcli-site.js), spawned as a terminal would run it, against the site relay on loopback (routes/browser-sites.js
// with an in-memory store): list, show, save (--file .json and .md), edit, search, rm --yes, the exit codes and the message outside a T-Agent terminal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { createBrowserSites } = require('../services/browser-sites');
const { createSiteRelayRouter } = require('../routes/browser-sites');

const CLI = path.resolve(__dirname, '../scripts/tcli.js');
const TOKEN = 'c'.repeat(64);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tcli-site-'));

const db = new Database(':memory:');
db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id TEXT)');
db.prepare("INSERT INTO tasks (id, user_id) VALUES (12, 'owner')").run();
let clock = 1000;
const service = createBrowserSites({ db, now: () => (clock += 1), deviceName: () => 'DevA', settingChanged: () => {} });
let base;
let server;

test.before(async () => {
  const app = express();
  app.use('/api/tcli', createSiteRelayRouter({ db, sites: () => service, verifyToken: (task, terminal, token) => task === 12 && terminal === 'term-a' && token === TOKEN }));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(work, { recursive: true, force: true }); });

function terminalEnv(overrides = {}) {
  return { PATH: process.env.PATH, HOME: work, TA_HOOK_URL: `${base}/hooks/terminal-activity?task=12&terminal=term-a`, TA_HOOK_TOKEN: TOKEN, ...overrides };
}
function run(args, { env = terminalEnv(), cwd = work } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd });
    const out = []; const err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('close', code => resolve({ code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }));
  });
}

test('outside a T-Agent terminal: exit 2 with one clear line', async () => {
  const result = await run(['site', 'list'], { env: { PATH: process.env.PATH, HOME: work } });
  assert.equal(result.code, 2);
  assert.match(result.err, /tcli works inside a T-Agent terminal/);
});

test('help: tcli site help and the site line in tcli help', async () => {
  const siteHelp = await run(['site', 'help']);
  assert.equal(siteHelp.code, 0);
  assert.match(siteHelp.out, /tcli site:/);
  assert.match(siteHelp.out, /save <site> --file/);
  const topHelp = await run(['help']);
  assert.match(topHelp.out, /site\s+what the model has learnt/);
});

test('save from a .json file, show, list, edit, search, rm', async () => {
  const jsonFile = path.join(work, 'github.json');
  fs.writeFileSync(jsonFile, JSON.stringify({ title: 'GitHub', summary: '# GitHub\nCode hosting', actions: [{ name: 'search repos', steps: ['open it'] }], apis: [{ name: 'repos', method: 'get', url: 'https://api.github.com/users/{u}/repos', auth: 'page cookies' }] }));

  const save = await run(['site', 'save', 'www.github.com', '--file', jsonFile]);
  assert.equal(save.code, 0);
  assert.match(save.out, /Saved github\.com \(v1\)/);

  const show = await run(['site', 'show', 'github.com']);
  assert.equal(show.code, 0);
  assert.match(show.out, /GitHub \(github\.com\)/);
  assert.match(show.out, /Actions/);
  assert.match(show.out, /search repos/);
  assert.match(show.out, /GET https:\/\/api\.github\.com/);

  const showJson = await run(['site', 'show', 'github.com', '--json']);
  assert.equal(JSON.parse(showJson.out).title, 'GitHub');

  const list = await run(['site', 'list']);
  assert.match(list.out, /github\.com/);
  assert.match(list.out, /1 action, 1 API/);

  const edit = await run(['site', 'edit', 'github.com', 'notes=Needs 2FA', 'title=GitHub.com']);
  assert.equal(edit.code, 0);
  assert.match(edit.out, /\(v2\)/);
  assert.match((await run(['site', 'show', 'github.com'])).out, /Needs 2FA/);

  const search = await run(['site', 'search', 'hosting']);
  assert.equal(search.code, 0);
  assert.match(search.out, /github\.com/);

  const rmNo = await run(['site', 'rm', 'github.com']);
  assert.equal(rmNo.code, 1, 'rm without --yes is a usage error');
  const rm = await run(['site', 'rm', 'github.com', '--yes']);
  assert.equal(rm.code, 0);
  assert.match(rm.out, /Removed github\.com/);
  assert.equal((await run(['site', 'show', 'github.com'])).code, 3, 'gone: exit 3 not found');
});

test('save from a .md file stores it as the summary', async () => {
  const mdFile = path.join(work, 'notes.md');
  fs.writeFileSync(mdFile, '# Example\nA demo site.');
  const save = await run(['site', 'save', 'example.com', '--file', mdFile]);
  assert.equal(save.code, 0);
  const show = await run(['site', 'show', 'example.com', '--json']);
  assert.equal(JSON.parse(show.out).summary, '# Example\nA demo site.');
});

test('a save that leaks a secret exits 1 with SITE_HAS_SECRET', async () => {
  const jsonFile = path.join(work, 'bad.json');
  fs.writeFileSync(jsonFile, JSON.stringify({ notes: 'token is NOTAREALKEY0000testfixture1234567890abcd' }));
  const save = await run(['site', 'save', 'evil.com', '--file', jsonFile]);
  assert.equal(save.code, 1);
  assert.match(save.err, /SITE_HAS_SECRET/);
});
