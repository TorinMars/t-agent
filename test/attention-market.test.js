// T-Attention plugin marketplace: services/attention-market.js, lib/plugin-store.js, the notifier hot reload in services/attention-notify.js,
// the /api/attention/market routes with the 'market' token scope, and the `t-attention plugins` marketplace commands.
// No network: plugins come from local bare git repositories in temp folders (file:// only with the test option allowFileUrls) and the
// index fetch is a stub. The real ~/.tagent and ~/.claude are never used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionService } = require('../services/attention');
const { createAttentionRoutes } = require('../routes/attention');
const { createPluginOverview } = require('../services/attention-plugins');
const notifyModule = require('../services/attention-notify');
const market = require('../services/attention-market');
const store = require('../lib/plugin-store');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 't-attention.js');
const SECRET = 'attention-market-test-secret-0123456789';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't-attention-market-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let count = 0;
const newDir = name => { const dir = path.join(tmp, `${name}-${count += 1}`); fs.mkdirSync(dir, { recursive: true }); return dir; };

// Git for the test repositories and for the market: no global or system config of this machine.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
delete GIT_ENV.TAGENT_HOME;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
  }
}

// A work repository plus a bare copy; commit(files, tag?) commits in the work repo and pushes to the bare one.
function makeRepo(files, { tag = null } = {}) {
  const base = newDir('repo');
  const work = path.join(base, 'work');
  const bare = path.join(base, 'plugin.git');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  writeFiles(work, files);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'first');
  if (tag) git(work, 'tag', tag);
  git(base, 'clone', '-q', '--bare', work, bare);
  git(work, 'remote', 'add', 'origin', bare);
  return {
    work, bare, url: `file://${bare}`,
    head: () => git(work, 'rev-parse', 'HEAD'),
    commit(more, { tag: next = null, message = 'change' } = {}) {
      writeFiles(work, more);
      git(work, 'add', '-A');
      git(work, 'commit', '-qm', message);
      if (next) git(work, 'tag', next);
      git(work, 'push', '-q', 'origin', 'main', ...(next ? [next] : []));
      return git(work, 'rev-parse', 'HEAD');
    },
  };
}

// A notifier plugin; requiring index.js writes a marker file, so the tests can see when its code ran.
const notifierFiles = (name, { version = '1.0.0', label = 'one', marker, extra = {} } = {}) => ({
  'manifest.json': { name, version, kind: 'notifier', description: `The ${name} notifier`, config: [{ key: 'room', label: 'Room', type: 'string', default: 'main' }] },
  'index.js': `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${label}\n`)});\nmodule.exports = { name: ${JSON.stringify(name)}, label: ${JSON.stringify(label)}, notify: async () => {}, test: async () => ({ ok: true, message: ${JSON.stringify(`test ${label}`)} }) };\n`,
  ...extra,
});
const listenerFiles = name => ({
  'manifest.json': { name, version: '0.1.0', kind: 'listener', description: `The ${name} listener`, entry: 'hook.js', events: ['Start', 'Stop'] },
  'hook.js': "const { spawn } = require('child_process');\n",
});

function makeDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  return db;
}

// A market with a notify service over an empty built-in notifier folder (no gramjs), the real built-in names (claude, telegram).
function setUp({ index = null, limits, now, fetchIndex, watchLinks = false, builtInNotifiers = null } = {}) {
  const dataDir = newDir('data');
  const db = makeDb();
  const pluginsDir = builtInNotifiers || newDir('builtin-notifiers');
  const notify = notifyModule.createAttentionNotify({ db, sessionSecret: SECRET, pluginsDir, getOwner: () => 'local', log: () => {}, extraFolders: () => store.userFolders(dataDir, 'notifier') });
  const calls = [];
  const service = market.createMarket({
    dataDir, notify, allowFileUrls: true, env: GIT_ENV, officialIndexUrl: 'https://index.example/marketplace.json', limits, now, watchLinks, watchDebounceMs: 50, log: () => {},
    fetchIndex: fetchIndex || (async url => { calls.push(url); if (!index) throw new Error('offline'); return typeof index === 'function' ? index(url) : index; }),
  });
  return { dataDir, db, notify, market: service, calls, pluginsDir };
}

const rejectsCode = async (promise, code) => {
  await assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
};
const throwsCode = (fn, code) => assert.throws(fn, error => { assert.equal(error.code, code, error.message); return true; });

test('source checks: https and git@ only (file:// only with the test option), no credentials, safe refs and subfolders', () => {
  assert.deepEqual(market.parseGitSpec('https://github.com/me/plugin.git#v1.2:plugins/x'), { url: 'https://github.com/me/plugin.git', ref: 'v1.2', path: 'plugins/x' });
  assert.deepEqual(market.parseGitSpec('git@github.com:me/plugin.git#main'), { url: 'git@github.com:me/plugin.git', ref: 'main', path: '' });
  assert.deepEqual(market.parseGitSpec('https://example.com/r.git#:sub'), { url: 'https://example.com/r.git', ref: null, path: 'sub' });
  for (const bad of ['http://example.com/r.git', 'file:///tmp/r.git', 'ssh://host/r.git', 'https://user:pw@example.com/r.git', '-uhttps://x', 'ext::sh -c id', '/abs/path', 'git@host:../x']) {
    assert.throws(() => market.checkUrl(bad), /Git URL|https|user name/, bad);
  }
  assert.equal(market.checkUrl('file:///tmp/r.git', { allowFileUrls: true }), 'file:///tmp/r.git');
  for (const bad of ['../x', '-main', 'a..b', 'x.lock', 'a b']) assert.throws(() => market.checkRef(bad), /ref/, bad);
  for (const bad of ['../x', 'a/../../b', '.git', 'a/.git', 'x\\y']) assert.throws(() => market.checkSubfolder(bad), /subfolder/, bad);
  assert.equal(market.checkSubfolder('/plugins/x/'), 'plugins/x');
});

test('prepare shows the preview without running any plugin code; install needs confirm, moves it into place and loads the notifier', async t => {
  const marker = path.join(newDir('marker'), 'ran.txt');
  const repo = makeRepo(notifierFiles('demo', { marker, extra: { 'package.json': { name: 'demo', dependencies: { leftpad: '1.0.0' } }, 'lib/net.js': "const https = require('node:https');\nfetch('https://x');\n" } }), { tag: 'v1' });
  const s = setUp();
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });

  const preview = await s.market.prepare({ source: `${repo.url}#v1` });
  assert.equal(preview.name, 'demo');
  assert.equal(preview.kind, 'notifier');
  assert.equal(preview.commit, repo.head());
  assert.equal(preview.shortCommit, repo.head().slice(0, 7));
  assert.deepEqual(preview.source, { type: 'git', index: null, url: repo.url, ref: 'v1', path: '', commit: repo.head() });
  assert.equal(preview.files.count, 4);
  assert.deepEqual(preview.files.list.map(file => file.path), ['index.js', 'lib/net.js', 'manifest.json', 'package.json']);
  assert.deepEqual(preview.config.map(field => field.key), ['room']);
  assert.equal(preview.hasPackageJson, true);
  assert.deepEqual(preview.dependencies, ['leftpad']);
  assert.match(preview.warnings[0], /needs dependencies; not supported/);
  assert.ok(preview.warnings.some(text => /network connections \(https, fetch\)/.test(text)), preview.warnings.join(' | '));
  assert.equal(preview.update, null);
  assert.equal(fs.existsSync(marker), false, 'nothing of the download was required');
  assert.equal(s.notify.has('demo'), false);
  assert.equal(fs.existsSync(path.join(store.kindDir(s.dataDir, 'notifier'), 'demo')), false, 'nothing is in place before the confirm');

  throwsCode(() => s.market.install({ prepareId: preview.prepareId }), 'CONFIRM_REQUIRED');
  throwsCode(() => s.market.install({ prepareId: 'nope', confirm: true }), 'NOT_FOUND');
  const done = s.market.install({ prepareId: preview.prepareId, confirm: true });
  assert.equal(done.ok, true);
  assert.equal(done.plugin.origin, 'git');
  assert.equal(done.plugin.source.commit, repo.head());
  const folder = path.join(store.kindDir(s.dataDir, 'notifier'), 'demo');
  assert.equal(done.plugin.folder, folder);
  const info = JSON.parse(fs.readFileSync(path.join(folder, '.install.json'), 'utf8'));
  assert.deepEqual(Object.keys(info).sort(), ['installedAt', 'kind', 'manifestHash', 'name', 'source', 'version']);
  assert.equal(info.source.commit, repo.head());
  assert.equal(fs.existsSync(path.join(folder, '.git')), false, 'no .git in the installed folder');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'one\n', 'loaded once, after the confirm');
  assert.equal(s.notify.has('demo'), true);
  const entry = s.notify.overview('local').find(item => item.name === 'demo');
  assert.equal(entry.origin, 'git');
  assert.equal(entry.dev, false);
  throwsCode(() => s.market.install({ prepareId: preview.prepareId, confirm: true }), 'NOT_FOUND');
  assert.equal(s.market.preparedCount(), 0);
  assert.deepEqual(fs.readdirSync(store.tmpDir(s.dataDir)), [], 'the temp folder is cleaned');
});

test('a prepared download expires after 10 minutes', async t => {
  let clock = Date.parse('2026-11-08T10:00:00Z');
  const repo = makeRepo(listenerFiles('watcher'));
  const s = setUp({ now: () => clock });
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });
  const preview = await s.market.prepare({ source: { url: repo.url } });
  assert.equal(preview.kind, 'listener');
  assert.deepEqual(preview.events, ['Start', 'Stop']);
  assert.ok(preview.warnings.some(text => /child_process/.test(text)));
  assert.equal(preview.expiresAt, '2026-11-08T10:10:00.000Z');
  clock += 10 * 60 * 1000 + 1;
  throwsCode(() => s.market.install({ prepareId: preview.prepareId, confirm: true }), 'PREPARE_EXPIRED');
  assert.equal(s.market.preparedCount(), 0);
});

test('update check, update preview with a diff summary, and an update keeps the config and the switch and reloads the new code', async t => {
  const marker = path.join(newDir('marker'), 'ran.txt');
  const repo = makeRepo(notifierFiles('pager', { marker }));
  const s = setUp();
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });
  s.market.install({ prepareId: (await s.market.prepare({ source: repo.url })).prepareId, confirm: true });
  s.notify.savePluginConfig('pager', 'local', { enabled: false, values: { room: 'ops' } });
  assert.deepEqual((await s.market.checkUpdates()).updates.map(item => [item.name, item.updateAvailable]), [['pager', false]]);

  const second = repo.commit(notifierFiles('pager', { version: '1.1.0', label: 'two', marker, extra: { 'README.md': 'new' } }));
  const { updates } = await s.market.checkUpdates();
  assert.equal(updates[0].updateAvailable, true);
  assert.equal(updates[0].latestCommit, second);
  assert.equal((await s.market.list()).installed.find(item => item.name === 'pager').updateAvailable, true);

  const preview = await s.market.prepare({ update: 'pager' });
  assert.equal(preview.commit, second);
  assert.deepEqual(preview.update.from.version, '1.0.0');
  assert.deepEqual(preview.update.to, { version: '1.1.0', commit: second });
  assert.equal(preview.update.filesChanged, 3, 'index.js and manifest.json changed, README.md added');
  s.market.install({ prepareId: preview.prepareId, confirm: true });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'one\ntwo\n', 'the new code is required again (the folder left the require cache)');
  assert.equal(s.notify.notifiers.find(plugin => plugin.name === 'pager').label, 'two');
  const config = s.notify.getPluginConfig('pager', 'local');
  assert.equal(config.enabled, false);
  assert.equal(config.values.room, 'ops');
  assert.equal((await s.market.checkUpdates()).updates[0].updateAvailable, false);
  await rejectsCode(s.market.prepare({ update: 'missing' }), 'NOT_FOUND');
});

test('remove keeps the settings unless purge; built-in plugins cannot be removed', async t => {
  const marker = path.join(newDir('marker'), 'ran.txt');
  const repo = makeRepo(notifierFiles('beeper', { marker }));
  const s = setUp();
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });
  const install = async () => s.market.install({ prepareId: (await s.market.prepare({ source: repo.url })).prepareId, confirm: true });
  await install();
  s.notify.savePluginConfig('beeper', 'local', { values: { room: 'kept' } });
  s.notify.saveRules('local', { modes: { beeper: { review: 'off' } } });
  const stateRows = () => s.db.prepare("SELECT key FROM system_state WHERE key LIKE '%beeper%'").all().map(row => row.key);
  assert.deepEqual(s.market.remove('beeper'), { ok: true, name: 'beeper', purged: false });
  assert.equal(fs.existsSync(path.join(store.kindDir(s.dataDir, 'notifier'), 'beeper')), false);
  assert.equal(s.notify.has('beeper'), false, 'the notifier stops at once');
  assert.deepEqual(stateRows(), ['attention-plugin:beeper:local']);
  await install();
  assert.equal(s.notify.getPluginConfig('beeper', 'local').values.room, 'kept', 'a reinstall finds the kept settings');
  assert.deepEqual(s.market.remove('beeper', { purge: true }), { ok: true, name: 'beeper', purged: true });
  assert.deepEqual(stateRows(), []);
  assert.equal(s.notify.getRules('local').modes.beeper, undefined);
  throwsCode(() => s.market.remove('beeper'), 'NOT_FOUND');
  throwsCode(() => s.market.remove('telegram'), 'BUILT_IN');
  throwsCode(() => s.market.remove('claude'), 'BUILT_IN');
});

test('link and unlink a local folder (dev): loaded from there, reload on demand and on file change', async t => {
  const marker = path.join(newDir('marker'), 'ran.txt');
  const folder = newDir('dev-plugin');
  writeFiles(folder, notifierFiles('devbell', { marker }));
  const s = setUp({ watchLinks: true });
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });
  throwsCode(() => s.market.link({ path: 'relative/path' }), 'INVALID_SOURCE');
  throwsCode(() => s.market.link({ path: path.join(folder, 'missing') }), 'INVALID_SOURCE');
  const linked = s.market.link({ path: folder });
  assert.equal(linked.plugin.origin, 'link');
  assert.equal(linked.plugin.dev, true);
  assert.equal(linked.plugin.folder, folder);
  assert.deepEqual(store.readLinks(s.dataDir).map(link => [link.name, link.kind, link.path]), [['devbell', 'notifier', folder]]);
  assert.equal(s.notify.has('devbell'), true);
  assert.deepEqual([s.notify.overview('local').find(item => item.name === 'devbell').origin, s.notify.overview('local').find(item => item.name === 'devbell').dev], ['link', true]);

  // fs.watch gets ready in the background (FSEvents on macOS, a walk of the folder on Linux), so a write right after link() can be missed: write again until it is seen.
  const deadline = Date.now() + 15000;
  for (let nextWrite = 0; s.notify.notifiers.find(plugin => plugin.name === 'devbell').label !== 'two' && Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 50))) {
    if (Date.now() < nextWrite) continue;
    writeFiles(folder, notifierFiles('devbell', { marker, label: 'two' }));
    nextWrite = Date.now() + 1000;
  }
  assert.equal(s.notify.notifiers.find(plugin => plugin.name === 'devbell').label, 'two', 'a change in the linked folder reloads it');

  writeFiles(folder, notifierFiles('devbell', { marker, label: 'three' }));
  assert.deepEqual(s.market.reload({ name: 'devbell' }), { ok: true });
  assert.equal(s.notify.notifiers.find(plugin => plugin.name === 'devbell').label, 'three');

  const repo = makeRepo(notifierFiles('devbell', { marker }));
  await rejectsCode(s.market.prepare({ source: repo.url }), 'NAME_TAKEN');
  assert.deepEqual(s.market.unlink('devbell'), { ok: true, name: 'devbell' });
  assert.equal(s.notify.has('devbell'), false);
  assert.equal(fs.existsSync(folder), true, 'unlink never deletes the folder');
  throwsCode(() => s.market.unlink('devbell'), 'NOT_FOUND');
  const relinked = s.market.link({ path: folder });
  assert.equal(relinked.plugin.name, 'devbell');
  assert.deepEqual(s.market.remove('devbell'), { ok: true, name: 'devbell', purged: false });
  assert.equal(fs.existsSync(folder), true, 'remove of a link only removes the link');
});

test('a user plugin can never shadow a built-in one', async t => {
  const s = setUp();
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });
  const marker = path.join(newDir('marker'), 'ran.txt');
  await rejectsCode(s.market.prepare({ source: makeRepo(notifierFiles('telegram', { marker })).url }), 'NAME_TAKEN');
  await rejectsCode(s.market.prepare({ source: makeRepo(listenerFiles('claude')).url }), 'NAME_TAKEN');
  const folder = newDir('dev');
  writeFiles(folder, notifierFiles('telegram', { marker }));
  throwsCode(() => s.market.link({ path: folder }), 'NAME_TAKEN');
  assert.equal(fs.existsSync(marker), false);

  // The loader refuses it too (a folder put there by hand), and the overview keeps the built-in listener.
  const builtIn = newDir('builtin');
  writeFiles(path.join(builtIn, 'bell'), notifierFiles('bell', { marker }));
  const user = path.join(store.kindDir(s.dataDir, 'notifier'), 'bell');
  writeFiles(user, { ...notifierFiles('bell', { marker, label: 'user' }), '.install.json': { source: { type: 'git' } } });
  const logs = [];
  const scanned = notifyModule.scanNotifiers(builtIn, (level, message) => logs.push(message), store.userFolders(s.dataDir, 'notifier'));
  assert.deepEqual(scanned.loaded.map(entry => [entry.plugin.name, entry.origin]), [['bell', 'builtin']]);
  assert.deepEqual(scanned.skipped.map(entry => [entry.name, entry.error, entry.origin]), [['bell', 'its name is a built-in plugin', 'git']]);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'one\n', 'the user copy was never required');

  const userListener = path.join(store.kindDir(s.dataDir, 'listener'), 'claude');
  writeFiles(userListener, { ...listenerFiles('claude'), '.install.json': { source: { type: 'git' } } });
  writeFiles(path.join(store.kindDir(s.dataDir, 'listener'), 'other'), { ...listenerFiles('other'), '.install.json': { source: { type: 'index' } } });
  const service = createAttentionService({ db: s.db });
  const overview = createPluginOverview({ service, userListeners: () => store.userFolders(s.dataDir, 'listener'), env: {}, homedir: () => newDir('home'), terminalUser: () => ({ user: null }) });
  const listeners = overview.listeners();
  assert.deepEqual(listeners.map(item => [item.name, item.origin, item.error]), [['claude', 'builtin', null], ['claude', 'git', 'its name is a built-in plugin'], ['other', 'index', null]]);
  assert.equal(listeners[0].local.installable, true);
  assert.equal(listeners[1].local.installable, undefined, 'the one-click install is for the built-in claude only');
});

test('path escapes and symlinks that leave the plugin are refused; a subfolder installs only that folder', async t => {
  const s = setUp();
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });
  const marker = path.join(newDir('marker'), 'ran.txt');
  const repo = makeRepo({ ...Object.fromEntries(Object.entries(notifierFiles('inner', { marker })).map(([name, value]) => [`plugins/inner/${name}`, value])), 'secret.txt': 'outside' });
  await rejectsCode(s.market.prepare({ source: { url: repo.url, path: '../x' } }), 'INVALID_SOURCE');
  await rejectsCode(s.market.prepare({ source: `${repo.url}#:plugins/missing` }), 'INVALID_PLUGIN');
  const sub = await s.market.prepare({ source: `${repo.url}#:plugins/inner` });
  assert.deepEqual(sub.files.list.map(file => file.path), ['index.js', 'manifest.json'], 'nothing outside the subfolder');
  assert.equal(sub.source.path, 'plugins/inner');

  const outside = makeRepo(notifierFiles('linky', { marker }));
  fs.symlinkSync('../secret.txt', path.join(outside.work, 'leak.txt'));
  fs.writeFileSync(path.join(outside.work, '..', 'secret.txt'), 'x');
  outside.commit({});
  await rejectsCode(s.market.prepare({ source: outside.url }), 'INVALID_PLUGIN');

  const absolute = makeRepo(notifierFiles('linky2', { marker }));
  fs.symlinkSync('/etc/passwd', path.join(absolute.work, 'passwd'));
  absolute.commit({});
  await assert.rejects(s.market.prepare({ source: absolute.url }), /points outside the plugin/);

  const folderLink = makeRepo({ ...Object.fromEntries(Object.entries(notifierFiles('real', { marker })).map(([name, value]) => [`real/${name}`, value])) });
  fs.symlinkSync('/tmp', path.join(folderLink.work, 'sub'));
  folderLink.commit({});
  await rejectsCode(s.market.prepare({ source: `${folderLink.url}#:sub` }), 'INVALID_PLUGIN');

  const inner = makeRepo(notifierFiles('okay', { marker, extra: { 'docs/a.md': 'a' } }));
  fs.symlinkSync('docs/a.md', path.join(inner.work, 'README.md'));
  inner.commit({});
  const preview = await s.market.prepare({ source: inner.url });
  s.market.install({ prepareId: preview.prepareId, confirm: true });
  assert.equal(fs.readlinkSync(path.join(store.kindDir(s.dataDir, 'notifier'), 'okay', 'README.md')), 'docs/a.md', 'a link inside the plugin is kept');
  assert.equal(fs.readdirSync(store.tmpDir(s.dataDir)).length, 1, 'only the subfolder preview that was never confirmed is left (until it expires)');
  s.market.stop();
  assert.deepEqual(fs.readdirSync(store.tmpDir(s.dataDir)), [], 'stop removes pending downloads');
});

test('size and file-count limits', async t => {
  const s = setUp({ limits: { maxBytes: 8 * 1024, maxFiles: 5 } });
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });
  const marker = path.join(newDir('marker'), 'ran.txt');
  await assert.rejects(s.market.prepare({ source: makeRepo(notifierFiles('big', { marker, extra: { 'blob.bin': Buffer.alloc(12 * 1024, 7) } })).url }), /larger than|download is larger/);
  const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, `${i}`]));
  await assert.rejects(s.market.prepare({ source: makeRepo(notifierFiles('many', { marker, extra: many })).url }), /more than 5 files/);
  assert.deepEqual(fs.readdirSync(store.tmpDir(s.dataDir)), [], 'a refused download is deleted');
});

test('bad manifests are refused with a reason', async t => {
  const s = setUp();
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });
  const cases = [
    [{ 'index.js': '' }, /manifest.json is missing/],
    [{ 'manifest.json': '{ nope' }, /not valid JSON/],
    [{ 'manifest.json': { name: 'Bad_Name', version: '1', kind: 'notifier', description: 'x' } }, /needs a name/],
    [{ 'manifest.json': { name: 'ok', kind: 'notifier', description: 'x' } }, /needs a version/],
    [{ 'manifest.json': { name: 'ok', version: '1', kind: 'theme', description: 'x' } }, /kind/],
    [{ 'manifest.json': { name: 'ok', version: '1', kind: 'notifier' } }, /description/],
    [{ 'manifest.json': { name: 'ok', version: '1', kind: 'notifier', description: 'x' } }, /needs index.js/],
    [{ 'manifest.json': { name: 'ok', version: '1', kind: 'notifier', description: 'x', config: [{ key: '1x', label: 'L', type: 'string' }] }, 'index.js': '' }, /key must be/],
    [{ 'manifest.json': { name: 'ok', version: '1', kind: 'listener', description: 'x', entry: '../hook.js' } }, /entry/],
    [{ 'manifest.json': { name: 'ok', version: '1', kind: 'listener', description: 'x', entry: 'hook.js' } }, /entry file/],
  ];
  for (const [files, message] of cases) await assert.rejects(s.market.prepare({ source: makeRepo(files).url }), message);
  await rejectsCode(s.market.prepare({ source: 'https://user:secret@example.com/x.git' }), 'INVALID_SOURCE');
  await rejectsCode(s.market.prepare({ source: { url: `file://${newDir('nothing')}` } }), 'GIT_FAILED');
  await rejectsCode(s.market.prepare({}), 'INVALID_SOURCE');
});

test('production refuses file:// sources before git runs', async t => {
  const dataDir = newDir('data');
  const service = market.createMarket({ dataDir, fetchIndex: async () => ({ plugins: [] }), log: () => {} });
  t.after(() => service.stop());
  const repo = makeRepo(listenerFiles('local'));
  await rejectsCode(service.prepare({ source: repo.url }), 'INVALID_SOURCE');
  await rejectsCode(service.prepare({ source: { url: repo.bare } }), 'INVALID_SOURCE');
  assert.equal(fs.existsSync(store.tmpDir(dataDir)), false, 'no download was started');
});

test('the index: cached for 10 minutes, the saved copy when a fetch fails, install by name, search and kind filter, built-in entries', async t => {
  let clock = Date.parse('2026-11-08T10:00:00Z');
  const marker = path.join(newDir('marker'), 'ran.txt');
  const repo = makeRepo(notifierFiles('chime', { marker }), { tag: 'v1' });
  let online = true;
  let calls = 0;
  const official = JSON.parse(fs.readFileSync(path.join(ROOT, 'marketplace.json'), 'utf8'));
  official.plugins.push({ name: 'chime', kind: 'notifier', description: 'Rings a chime', version: '1.0.0', repo: repo.url, ref: 'v1', author: 'Someone', tags: ['sound'] });
  official.plugins.push({ name: 'Bad Entry', kind: 'notifier', repo: repo.url });
  official.plugins.push({ name: 'evil', kind: 'notifier', repo: 'http://plain.example/x.git' });
  const s = setUp({ now: () => clock, fetchIndex: async () => { calls += 1; if (!online) throw new Error('offline'); return official; } });
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });

  const first = await s.market.list();
  assert.deepEqual(first.plugins.map(entry => [entry.name, entry.builtIn, entry.installed]), [['claude', true, true], ['telegram', true, true], ['chime', false, false]], 'invalid entries are left out');
  assert.deepEqual(first.sources, [{ url: 'https://index.example/marketplace.json', official: true, ok: true, stale: false, fetchedAt: '2026-11-08T10:00:00.000Z', error: null, count: 3 }]);
  await s.market.list({ q: 'chime' });
  assert.equal(calls, 1, 'cached');
  assert.deepEqual((await s.market.list({ q: 'SOUND' })).plugins.map(entry => entry.name), ['chime'], 'tags are searched, ignoring case');
  assert.deepEqual((await s.market.list({ kind: 'listener' })).plugins.map(entry => entry.name), ['claude']);
  assert.deepEqual((await s.market.list({ q: 'someone' })).plugins.map(entry => entry.name), ['chime'], 'the author is searched');
  await rejectsCode(s.market.prepare({ source: { name: 'telegram' } }), 'BUILT_IN');
  await rejectsCode(s.market.prepare({ source: { name: 'nothing' } }), 'NOT_FOUND');

  const preview = await s.market.prepare({ source: { name: 'chime' } });
  assert.deepEqual(preview.source, { type: 'index', index: 'https://index.example/marketplace.json', url: repo.url, ref: 'v1', path: '', commit: repo.head() });
  const installed = s.market.install({ prepareId: preview.prepareId, confirm: true });
  assert.equal(installed.plugin.origin, 'index');
  const listed = (await s.market.list()).plugins.find(entry => entry.name === 'chime');
  assert.deepEqual([listed.installed, listed.installedVersion, listed.origin, listed.updateAvailable], [true, '1.0.0', 'index', false]);

  clock += 11 * 60 * 1000;
  online = false;
  const stale = await s.market.list();
  assert.equal(calls, 2);
  assert.deepEqual(stale.plugins.map(entry => entry.name), ['claude', 'telegram', 'chime'], 'the saved copy is shown');
  assert.deepEqual([stale.sources[0].ok, stale.sources[0].stale, stale.sources[0].error, stale.sources[0].fetchedAt], [false, true, 'offline', '2026-11-08T10:00:00.000Z']);

  // A new market (a restart) reads the copy saved on disk when the index cannot be fetched.
  const again = market.createMarket({ dataDir: s.dataDir, allowFileUrls: true, env: GIT_ENV, officialIndexUrl: 'https://index.example/marketplace.json', log: () => {}, fetchIndex: async () => { throw new Error('down'); } });
  t.after(() => again.stop());
  const restarted = await again.list();
  assert.deepEqual(restarted.plugins.map(entry => entry.name), ['claude', 'telegram', 'chime']);
  assert.equal(restarted.sources[0].stale, true);

  // The index moves to a new tag: the listing says an update is there, and the update follows the index ref.
  clock += 11 * 60 * 1000;
  online = true;
  const newer = repo.commit(notifierFiles('chime', { version: '1.1.0', label: 'two', marker }), { tag: 'v2' });
  official.plugins.find(entry => entry.name === 'chime').ref = 'v2';
  official.plugins.find(entry => entry.name === 'chime').version = '1.1.0';
  assert.equal((await s.market.list()).plugins.find(entry => entry.name === 'chime').updateAvailable, true);
  const update = await s.market.prepare({ update: 'chime' });
  assert.deepEqual([update.source.ref, update.commit, update.update.to.version], ['v2', newer, '1.1.0']);

  // No index at all and nothing saved: a clear error.
  const offline = setUp();
  t.after(() => { offline.market.stop(); offline.notify.stop(); offline.db.close(); });
  await rejectsCode(offline.market.prepare({ source: { name: 'chime' } }), 'INDEX_UNAVAILABLE');
  assert.deepEqual((await offline.market.list()).sources.map(source => [source.ok, source.stale, source.error]), [[false, false, 'offline']]);
});

test('extra index sources: https only, saved in the data folder, merged after the official one (the first entry of a name wins)', async t => {
  const repo = makeRepo(listenerFiles('extra-one'));
  const indexes = {
    'https://index.example/marketplace.json': { plugins: [{ name: 'shared', kind: 'listener', description: 'official copy', repo: repo.url }] },
    'https://extra.example/index.json': { name: 'Extra', plugins: [{ name: 'shared', kind: 'listener', description: 'extra copy', repo: repo.url }, { name: 'extra-one', kind: 'listener', description: 'only here', repo: repo.url }] },
  };
  const s = setUp({ index: url => { if (!indexes[url]) throw new Error('unknown'); return indexes[url]; } });
  t.after(() => { s.market.stop(); s.notify.stop(); s.db.close(); });
  assert.deepEqual(s.market.getSources(), { official: 'https://index.example/marketplace.json', extra: [] });
  throwsCode(() => s.market.saveSources({ extra: ['http://extra.example/index.json'] }), 'INVALID_SOURCE');
  throwsCode(() => s.market.saveSources({ extra: ['https://u:p@extra.example/index.json'] }), 'INVALID_SOURCE');
  throwsCode(() => s.market.saveSources({ extra: Array.from({ length: 11 }, (_, i) => `https://e${i}.example/i.json`) }), 'INVALID_SOURCE');
  throwsCode(() => s.market.saveSources({}), 'INVALID_SOURCE');
  assert.deepEqual(s.market.saveSources({ extra: ['https://extra.example/index.json', 'https://extra.example/index.json', 'https://index.example/marketplace.json'] }), { official: 'https://index.example/marketplace.json', extra: ['https://extra.example/index.json'] });
  assert.deepEqual(store.readJson(path.join(store.storeRoot(s.dataDir), 'market.json')), { extra: ['https://extra.example/index.json'] });
  const listed = await s.market.list();
  assert.deepEqual(listed.plugins.map(entry => [entry.name, entry.description, entry.index]), [
    ['shared', 'official copy', 'https://index.example/marketplace.json'],
    ['extra-one', 'only here', 'https://extra.example/index.json'],
  ]);
  assert.deepEqual(listed.sources.map(source => [source.url, source.official, source.count]), [['https://index.example/marketplace.json', true, 1], ['https://extra.example/index.json', false, 2]]);
  const preview = await s.market.prepare({ source: { name: 'extra-one' } });
  assert.equal(preview.source.index, 'https://extra.example/index.json');
});

test('marketplace.json at the repository root lists the built-in plugins only', () => {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'marketplace.json'), 'utf8'));
  assert.deepEqual(index.plugins.map(entry => [entry.name, entry.kind, entry.builtIn]), [['claude', 'listener', true], ['telegram', 'notifier', true]]);
  const checked = market.checkIndex(index, 'https://x/marketplace.json');
  assert.equal(checked.plugins.length, 2);
  for (const entry of index.plugins) assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', `${entry.kind}s`, entry.name, 'manifest.json'), 'utf8')).name, entry.name);
});

// ---------- HTTP and CLI ----------
async function httpSetUp(t, options = {}) {
  const s = setUp(options);
  const service = createAttentionService({ db: s.db });
  const routes = createAttentionRoutes({ service, market: s.market });
  const app = express();
  app.use('/api/attention', routes.bearer);
  app.use(express.json());
  app.use('/api/attention', (req, res, next) => { req.session = { user: { login: 'local' } }; next(); }, routes.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { routes.closeStreams(); server.close(); s.market.stop(); s.notify.stop(); s.db.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { ...s, service, origin, base: `${origin}/api/attention` };
}

const call = async (url, { method = 'GET', body, token } = {}) => {
  const res = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('market routes: the browser session and tokens with "Can manage plugins" (200), other tokens and terminal tokens 403', async t => {
  const s = await httpSetUp(t, { index: { plugins: [] } });
  const created = await call(`${s.base}/tokens`, { method: 'POST', body: { name: 'plugins cli', market: true } });
  assert.equal(created.status, 201);
  assert.equal(created.body.market, true);
  assert.equal((await call(`${s.base}/tokens`, { method: 'POST', body: { name: 'bad', market: 'yes' } })).status, 400);
  const plain = s.service.createToken({ name: 'plain' });
  assert.equal(plain.market, false);
  assert.deepEqual((await call(`${s.base}/tokens`)).body.tokens.map(token => [token.name, token.market]), [['plain', false], ['plugins cli', true]]);
  const terminal = s.service.issueTerminalToken({ taskId: 1, terminalId: 'a' });

  assert.equal((await call(`${s.base}/market`)).status, 200, 'session');
  assert.equal((await call(`${s.base}/market`, { token: created.body.token })).status, 200, 'market token');
  for (const token of [plain.token, terminal.token]) {
    const denied = await call(`${s.base}/market`, { token });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'TOKEN_NOT_ALLOWED');
    assert.match(denied.body.message, /Can manage plugins/);
    assert.equal((await call(`${s.base}/market/prepare`, { method: 'POST', token, body: { source: 'https://example.com/x.git' } })).status, 403);
    assert.equal((await call(`${s.base}/market/plugins/x`, { method: 'DELETE', token })).status, 403);
  }
  assert.equal((await call(`${s.base}/plugins`, { token: plain.token })).status, 404, 'the other routes are unchanged (no overview configured)');
  assert.equal((await call(`${s.base}/market/nothing`)).status, 404);
  assert.deepEqual((await call(`${s.base}/market/prepare`, { method: 'POST', body: { source: 'http://example.com/x.git' } })).body.error, 'INVALID_SOURCE');
  assert.deepEqual((await call(`${s.base}/market/plugins/telegram`, { method: 'DELETE' })).body, { error: 'BUILT_IN', message: 'telegram is built in and cannot be removed' });
  assert.deepEqual((await call(`${s.base}/market/install`, { method: 'POST', body: { prepareId: 'x', confirm: true } })).status, 404);
  assert.deepEqual((await call(`${s.base}/market/sources`, { method: 'PUT', body: { extra: ['https://extra.example/i.json'] } })).body, { official: 'https://index.example/marketplace.json', extra: ['https://extra.example/i.json'] });

  const repo = makeRepo(listenerFiles('via-http'));
  const preview = await call(`${s.base}/market/prepare`, { method: 'POST', token: created.body.token, body: { source: { url: repo.url } } });
  assert.equal(preview.status, 200);
  assert.equal((await call(`${s.base}/market/install`, { method: 'POST', token: created.body.token, body: { prepareId: preview.body.prepareId } })).body.error, 'CONFIRM_REQUIRED');
  const done = await call(`${s.base}/market/install`, { method: 'POST', token: created.body.token, body: { prepareId: preview.body.prepareId, confirm: true } });
  assert.deepEqual([done.status, done.body.plugin.name, done.body.plugin.kind], [200, 'via-http', 'listener']);
  assert.deepEqual((await call(`${s.base}/market/updates`)).body.updates.map(item => [item.name, item.updateAvailable]), [['via-http', false]]);
  assert.deepEqual((await call(`${s.base}/market/plugins/via-http?purge=1`, { method: 'DELETE' })).body, { ok: true, name: 'via-http', purged: false });
});

function runCli(args, { env, input = '' } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: newDir('cli-home'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('CLI: plugins search, install (asks; --yes), update --yes, remove, link and unlink; a token without the permission exits 2', async t => {
  const marker = path.join(newDir('marker'), 'ran.txt');
  const repo = makeRepo(notifierFiles('cli-bell', { marker }), { tag: 'v1' });
  const index = { plugins: [{ name: 'claude', kind: 'listener', builtIn: true, description: 'Claude Code hooks' }, { name: 'cli-bell', kind: 'notifier', version: '1.0.0', description: 'A bell for the CLI test', repo: repo.url }] };
  const s = await httpSetUp(t, { index });
  const env = { TA_ATTENTION_URL: s.origin, TA_ATTENTION_TOKEN: s.service.createToken({ name: 'cli', market: true }).token };

  const search = await runCli(['plugins', 'search', 'bell'], { env });
  assert.equal(search.code, 0, search.stderr);
  assert.match(search.stdout, /^  cli-bell 1\.0\.0  notifier\n    A bell for the CLI test\n$/);
  const all = await runCli(['plugins', 'search', '--kind', 'listener'], { env });
  assert.match(all.stdout, /claude {2}listener · built in/);
  assert.equal((await runCli(['plugins', 'search', '--kind', 'theme'], { env })).code, 1);

  const no = await runCli(['plugins', 'install', 'cli-bell'], { env, input: 'n\n' });
  assert.equal(no.code, 0, no.stderr);
  assert.match(no.stdout, /cli-bell 1\.0\.0 \(notifier\)/);
  assert.match(no.stdout, new RegExp(`Commit:  ${repo.head().slice(0, 7)} \\(pinned\\)`));
  assert.match(no.stdout, /install only plugins you trust/);
  assert.match(no.stderr, /Install cli-bell at [0-9a-f]{7}\? \[y\/N\] Not installed\./);
  assert.equal(s.notify.has('cli-bell'), false);
  assert.equal(fs.existsSync(marker), false);

  const yes = await runCli(['plugins', 'install', 'cli-bell'], { env, input: 'y\n' });
  assert.equal(yes.code, 0, yes.stderr);
  assert.match(yes.stdout, /Installed cli-bell 1\.0\.0 \([0-9a-f]{7}\)/);
  assert.equal(s.notify.has('cli-bell'), true);

  assert.match((await runCli(['plugins', 'update'], { env })).stdout, /Everything is up to date\./);
  repo.commit(notifierFiles('cli-bell', { version: '1.2.0', label: 'two', marker }));
  const update = await runCli(['plugins', 'update', 'cli-bell', '--yes'], { env });
  assert.equal(update.code, 0, update.stderr);
  assert.match(update.stdout, /Update:  1\.0\.0 -> 1\.2\.0, 2 files changed/);
  assert.match(update.stdout, /Updated cli-bell 1\.2\.0/);
  assert.equal(s.notify.notifiers.find(plugin => plugin.name === 'cli-bell').label, 'two');
  assert.equal((await runCli(['plugins', 'update', 'missing'], { env })).code, 3);

  const removed = await runCli(['plugins', 'remove', 'cli-bell', '--purge'], { env });
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(removed.stdout, 'Removed cli-bell and its settings\n');
  assert.equal((await runCli(['plugins', 'remove', 'telegram'], { env })).code, 1);

  const gitInstall = await runCli(['plugins', 'install', `${repo.url}#v1`, '--yes', '--json'], { env });
  assert.equal(gitInstall.code, 0, gitInstall.stderr);
  const parsed = JSON.parse(gitInstall.stdout);
  assert.deepEqual([parsed.installed, parsed.plugin.source.type, parsed.plugin.source.ref, parsed.plugin.version], [true, 'git', 'v1', '1.0.0']);

  const folder = newDir('cli-dev');
  writeFiles(folder, notifierFiles('cli-dev', { marker }));
  const linked = await runCli(['plugins', 'link', folder], { env });
  assert.equal(linked.code, 0, linked.stderr);
  assert.equal(linked.stdout, `Linked cli-dev (notifier, dev) from ${folder}\n`);
  assert.equal(s.notify.has('cli-dev'), true);
  assert.equal((await runCli(['plugins', 'unlink', 'cli-dev'], { env })).stdout, 'Unlinked cli-dev\n');
  assert.equal(s.notify.has('cli-dev'), false);
  assert.equal((await runCli(['plugins', 'unlink', 'cli-dev'], { env })).code, 3);

  const plain = { TA_ATTENTION_URL: s.origin, TA_ATTENTION_TOKEN: s.service.createToken({ name: 'plain' }).token };
  const denied = await runCli(['plugins', 'search'], { env: plain });
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /cannot manage plugins; make a token with "Can manage plugins"/);
  assert.equal((await runCli(['plugins', 'nope'], { env })).code, 1);
  assert.equal((await runCli(['plugins', 'install'], { env })).code, 1);
});
