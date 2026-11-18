const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileSync, normalizeSpec } = require('../services/file-sync');
const { encryptToken } = require('../lib/token-crypto');

// `writes` counts the rows written to system_state (the file-sync state).
function database(identity) {
  const values = new Map();
  const servers = new Map();
  const db = {
    servers,
    writes: 0,
    prepare(sql) {
      if (sql.includes('FROM system_state')) return { get: key => values.has(key) ? { value: values.get(key) } : undefined };
      if (sql.includes('INTO system_state')) return { run: (key, value) => { db.writes += 1; values.set(key, value); } };
      if (sql.includes('FROM remote_servers WHERE owner_id')) return { get: (owner, url) => [...servers.values()].find(row => row.owner_id === owner && row.base_url === url) };
      if (sql.includes('INSERT INTO remote_servers')) return { run: (owner, name, url, cipher) => { const id = servers.size + 1; servers.set(id, { id, owner_id: owner, name, base_url: url, token_cipher: cipher }); return { lastInsertRowid: id }; } };
      if (sql.includes('UPDATE remote_servers')) return { run: (cipher, id) => { servers.get(id).token_cipher = cipher; } };
      if (sql.includes('FROM remote_servers')) return { get: id => servers.get(Number(id)) };
      if (sql.includes('FROM engine_identity')) return { get: () => ({ value: identity }) };
      throw new Error(sql);
    },
  };
  return db;
}
// A slave may add ?if_none_match=<etag> to the manifest request; the transports of the older tests below answer the full manifest either way.
const isManifest = url => url.split('?')[0].endsWith('/manifest');

test('Home-directory and absolute paths are normalized, and path traversal is rejected', () => {
  assert.equal(normalizeSpec('home/.claude/settings.json'), '~/.claude/settings.json');
  assert.equal(normalizeSpec('\u7528\u6237\u76ee\u5f55/.claude/settings.json'), '~/.claude/settings.json', 'the prefix written by earlier versions still works');
  assert.equal(normalizeSpec('$HOME/.codex/config.toml'), '~/.codex/config.toml');
  assert.equal(normalizeSpec('/tmp/config.toml'), '/tmp/config.toml');
  assert.throws(() => normalizeSpec('~/../secret'), /SYNC_PATH_INVALID/);
  assert.throws(() => normalizeSpec('relative/path'), /SYNC_PATH_INVALID/);
});

test('Master node file list, first download, two-way updates and conflicts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aHome = path.join(root, 'a');
  const bHome = path.join(root, 'b');
  const cHome = path.join(root, 'c');
  fs.mkdirSync(path.join(aHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(bHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(aHome, '.claude/settings.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(bHome, '.claude/settings.json'), '{"old":true}\n');
  const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const aDb = database('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const bDb = database(childId);
  const cDb = database('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const master = new FileSync({ db: aDb, secret: 'secret', home: aHome, intervalMs: 0 });
  const remoteRequest = async (base, url, token, options = {}) => {
    assert.equal(token, 'token');
    if (isManifest(url)) return master.manifest();
    if (url.endsWith('/file')) return master.receive(options.body);
    if (url.endsWith('/heartbeat')) return options.method === 'DELETE'
      ? master.unregisterChild(options.body) : master.registerChild(options.body);
    throw new Error(url);
  };
  const child = new FileSync({ db: bDb, secret: 'secret', home: bHome, intervalMs: 0, remoteRequest });
  const sibling = new FileSync({ db: cDb, secret: 'secret', home: cHome, intervalMs: 0, remoteRequest });
  assert.equal(master.status().role, 'master');
  assert.deepEqual(master.status().files, []);
  master.setFiles(['~/.claude/settings.json']);
  await child.connect({ url: 'http://master', token: 'token' });
  await sibling.connect({ url: 'http://master', token: 'token' });
  assert.equal(master.status().children.length, 2);
  assert.ok(master.status().children.every(node => node.online));
  assert.equal(child.status().role, 'child');
  assert.equal(fs.readFileSync(path.join(bHome, '.claude/settings.json'), 'utf8'), '{"a":1}\n');
  assert.equal(fs.readFileSync(child.status().files[0].backup, 'utf8'), '{"old":true}\n');
  assert.throws(() => child.setFiles([]), /SYNC_NOT_MASTER/);

  fs.writeFileSync(path.join(bHome, '.claude/settings.json'), '{"b":2}\n');
  await child.tick();
  assert.equal(fs.readFileSync(path.join(aHome, '.claude/settings.json'), 'utf8'), '{"b":2}\n');
  assert.ok(master.status().children.find(node => node.id === childId).last_sync_at);
  await sibling.tick();
  assert.equal(fs.readFileSync(path.join(cHome, '.claude/settings.json'), 'utf8'), '{"b":2}\n');

  fs.writeFileSync(path.join(aHome, '.claude/settings.json'), '{"master":3}\n');
  await child.tick();
  assert.equal(fs.readFileSync(path.join(bHome, '.claude/settings.json'), 'utf8'), '{"master":3}\n');

  fs.writeFileSync(path.join(aHome, '.claude/settings.json'), '{"master":4}\n');
  fs.writeFileSync(path.join(bHome, '.claude/settings.json'), '{"child":4}\n');
  await child.tick();
  assert.match(child.status().error, /^SYNC_CONFLICT:/);
  assert.equal(fs.readFileSync(path.join(bHome, '.claude/settings.json'), 'utf8'), '{"child":4}\n');
  assert.equal(fs.readFileSync(path.join(aHome, '.claude/settings.json'), 'utf8'), '{"master":4}\n');
  await child.resolveConflict('~/.claude/settings.json');
  assert.equal(fs.readFileSync(path.join(bHome, '.claude/settings.json'), 'utf8'), '{"master":4}\n');
  assert.equal(fs.readFileSync(child.status().files[0].backup, 'utf8'), '{"child":4}\n');
  master.state.children[childId].lastSeenAt = new Date(Date.now() - 20_000).toISOString();
  assert.equal(master.status().children.find(node => node.id === childId).online, false);
  await sibling.disconnect();
  assert.equal(master.status().children.length, 1);
  await master.disconnect();
  master.setFiles(['~/.claude/settings.json']);
  fs.writeFileSync(path.join(bHome, '.claude/settings.json'), '{"stale":true}\n');
  await child.tick();
  assert.match(child.status().error, /^SYNC_CONFLICT:/);
  assert.equal(fs.readFileSync(path.join(aHome, '.claude/settings.json'), 'utf8'), '{"master":4}\n');
});

test('A child node maps Mac absolute paths to local paths, backs up the old file and can restore the default', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-map-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const masterHome = path.join(root, 'mac');
  const childHome = path.join(root, 'server');
  fs.mkdirSync(masterHome);
  fs.mkdirSync(childHome);
  const source = path.join(masterHome, 'config.toml');
  const target = path.join(childHome, '.codex', 'config.toml');
  fs.writeFileSync(source, 'model = "master"\n');
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, 'model = "local"\n');
  const master = new FileSync({ db: database('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), secret: 'secret', home: masterHome, intervalMs: 0 });
  master.setFiles([source]);
  const childDb = database('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const child = new FileSync({ db: childDb, secret: 'secret', home: childHome, intervalMs: 0, remoteRequest: async (_base, url, _token, options) => {
    if (isManifest(url)) return master.manifest();
    if (url.endsWith('/heartbeat')) return { registered: true };
    if (url.endsWith('/file')) return master.receive(options.body);
    throw new Error(url);
  } });
  await child.connect({ url: 'http://master', token: 'token' });
  assert.equal(child.status().files[0].default_path, source);
  assert.equal(child.status().files[0].path_override, null);
  assert.equal(child.status().files[0].local_path, source);
  child.setPath({ path: source, local_path: '~/.codex/config.toml' });
  assert.equal(child.status().files[0].local_path, target);
  assert.equal(child.status().files[0].path_override, '~/.codex/config.toml');
  await child.tick();
  assert.equal(fs.readFileSync(target, 'utf8'), 'model = "master"\n');
  assert.equal(fs.readFileSync(child.status().files[0].backup, 'utf8'), 'model = "local"\n');
  assert.ok(fs.existsSync(target + '.t-agent-file-sync-managed'));
  fs.writeFileSync(target, 'model = "child"\n');
  await child.tick();
  assert.equal(fs.readFileSync(source, 'utf8'), 'model = "child"\n');
  child.setPath({ path: source, local_path: child.status().files[0].default_path });
  assert.equal(child.status().files[0].path_override, null);
  assert.ok(!fs.existsSync(target + '.t-agent-file-sync-managed'));
  child.setPath({ path: source, local_path: '~/.codex/config.toml' });
  child.setPath({ path: source, local_path: '' });
  assert.equal(child.status().files[0].local_path, source);
});

test('On first connection, absolute paths that exist only on the master node are not created on the server', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-foreign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const foreign = path.join(root, 'mac', 'Users', 'name', '.codex', 'config.toml');
  const home = path.join(root, 'linux');
  fs.mkdirSync(home);
  const db = database('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const content = Buffer.from('model = "master"\n').toString('base64');
  const hash = require('node:crypto').createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex');
  const manifest = { generation: 'generation', files: [{ path: foreign, revision: 1, content, hash }] };
  const child = new FileSync({ db, secret: 'secret', home, intervalMs: 0, remoteRequest: async (_base, url) => {
    if (isManifest(url)) return manifest;
    return { registered: true };
  } });
  await child.connect({ url: 'http://master', token: 'token' });
  assert.equal(child.status().files[0].path_required, true);
  assert.equal(fs.existsSync(foreign), false);
  child.setPath({ path: foreign, local_path: '~/.codex/config.toml' });
  await child.tick();
  assert.equal(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), 'model = "master"\n');
});

test('One-step join of the master by sync pairing code: exchange for a sync token, store it in file sync’s own state, sync immediately, without borrowing an engine connection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-join-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aHome = path.join(root, 'a');
  const bHome = path.join(root, 'b');
  fs.mkdirSync(path.join(aHome, '.claude'), { recursive: true });
  fs.mkdirSync(bHome, { recursive: true });
  fs.writeFileSync(path.join(aHome, '.claude/settings.json'), '{"a":1}\n');
  const aDb = database('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const bDb = database('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const master = new FileSync({ db: aDb, secret: 'secret', home: aHome, intervalMs: 0 });
  const seen = [];
  const remoteRequest = async (base, url, token, options = {}) => {
    seen.push({ base, url, token, method: options.method });
    if (url === '/v1/file-sync/pair') { assert.equal(token, null); return master.exchangeSyncCode(options.body); }
    assert.ok(master.verifyToken(token), 'Sync endpoints use the file-sync token');
    if (isManifest(url)) return master.manifest();
    if (url.endsWith('/file')) return master.receive(options.body);
    if (url.endsWith('/heartbeat')) return options.method === 'DELETE' ? master.unregisterChild(options.body) : master.registerChild(options.body);
    throw new Error(url);
  };
  const child = new FileSync({ db: bDb, secret: 'secret', home: bHome, intervalMs: 0, remoteRequest });
  master.setFiles(['~/.claude/settings.json']);
  const code = master.createSyncCode();
  assert.match(code, /^TA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  await assert.rejects(child.join({ url: 'http://master:3000', code: 'wrong' }), /SYNC_PAIRING_CODE_INVALID/);
  await assert.rejects(child.join({ url: '', code }), /SYNC_MASTER_URL_INVALID/);
  assert.equal(seen.length, 0, 'A malformed value sends no request');

  const status = await child.join({ url: 'master.lan:3000/web', code: code.toLowerCase() });
  assert.equal(status.role, 'child');
  assert.equal(status.master_url, 'http://master.lan:3000');
  assert.equal(seen[0].base, 'http://master.lan:3000');
  assert.equal(fs.readFileSync(path.join(bHome, '.claude/settings.json'), 'utf8'), '{"a":1}\n');
  assert.equal(bDb.servers.size, 0, 'Nothing is written to engine connections (remote_servers)');
  assert.ok(!JSON.stringify(bDb.prepare('SELECT value FROM system_state').get('file_sync_v1')).includes(seen[1].token), 'The token is stored encrypted');
  await assert.rejects(new FileSync({ db: database('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), secret: 'secret', home: bHome, intervalMs: 0, remoteRequest }).join({ url: 'http://master.lan:3000', code }), /PAIRING_CODE_INVALID_OR_EXPIRED/, 'A pairing code can only be used once');

  await child.disconnect();
  assert.equal(master.verifyToken(seen[1].token), false, 'When disconnecting, the master revokes that token');
  await child.join({ url: 'http://master.lan:3000', code: master.createSyncCode() });
  assert.equal(child.status().role, 'child');
  assert.equal(bDb.servers.size, 0);
});

test('The master generates a connection string, an internal-network slave pastes it and connects out; the role can be switched or unlinked, and the string works only once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-invite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aHome = path.join(root, 'a');
  const bHome = path.join(root, 'b');
  fs.mkdirSync(path.join(aHome, '.claude'), { recursive: true });
  fs.mkdirSync(bHome, { recursive: true });
  fs.writeFileSync(path.join(aHome, '.claude/settings.json'), '{"a":1}\n');
  const aDb = database('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const bDb = database('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const master = new FileSync({ db: aDb, secret: 'secret', home: aHome, intervalMs: 0 });
  const sent = [];
  // Only the slave sends requests to the master; the master never connects to the slave.
  const slaveRequest = async (base, url, token, options = {}) => {
    sent.push({ base, url, token });
    if (url === '/v1/file-sync/pair') return master.exchangeSyncCode(options.body);
    if (isManifest(url)) return master.manifest();
    if (url.endsWith('/heartbeat')) return options.method === 'DELETE' ? master.unregisterChild(options.body) : master.registerChild(options.body);
    throw new Error(url);
  };
  const slave = new FileSync({ db: bDb, secret: 'secret', home: bHome, intervalMs: 0, remoteRequest: slaveRequest });
  master.setFiles(['~/.claude/settings.json']);

  await assert.rejects(slave.setRole('boss'), /SYNC_ROLE_INVALID/);
  await assert.rejects(slave.joinInvite('x'), /SYNC_NOT_CHILD/, 'A master cannot connect as a slave');
  const waiting = await slave.setRole('slave');
  assert.equal(waiting.role, 'child');
  assert.equal(waiting.master_id, null);
  assert.equal(waiting.master_url, null);
  await slave.tick();
  assert.equal(slave.status().error, null, 'Polling does not error before connecting');
  assert.throws(() => slave.createInvite('master.lan:3000'), /SYNC_NOT_MASTER/);

  assert.throws(() => master.createInvite(''), /SYNC_MASTER_URL_INVALID/);
  const invite = master.createInvite('master.lan:3000/web');
  assert.match(invite.connection_string, /^TAFS1:[A-Za-z0-9_-]+$/);
  assert.equal(invite.expires_in_seconds, 600);
  const decoded = JSON.parse(Buffer.from(invite.connection_string.slice(6), 'base64url').toString());
  assert.deepEqual({ v: decoded.v, u: decoded.u }, { v: 1, u: 'http://master.lan:3000' }, 'The string holds the normalized master address');
  assert.match(decoded.c, /^TA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  for (const bad of ['', 'TAFS1:', 'TAFS1:!!!', 'hello', `TAFS1:${Buffer.from('{"v":2}').toString('base64url')}`,
    `TAFS1:${Buffer.from(JSON.stringify({ v: 1, u: 'http://m', c: 'bad' })).toString('base64url')}`]) {
    await assert.rejects(slave.joinInvite(bad), /SYNC_CONNECTION_STRING_INVALID/, JSON.stringify(bad));
  }
  assert.equal(sent.length, 0, 'An incorrect string sends no request');

  // Pasting often brings line breaks or whitespace.
  const wrapped = invite.connection_string.replace(/(.{20})/g, '$1\n  ');
  const status = await slave.joinInvite(wrapped);
  assert.equal(status.role, 'child');
  assert.equal(status.master_url, 'http://master.lan:3000');
  assert.equal(sent[0].base, 'http://master.lan:3000');
  assert.equal(status.children.length, 0, 'A slave’s list has no child nodes');
  assert.equal(master.status().children.length, 1, 'After a slave connects it has registered with the master');
  assert.equal(fs.readFileSync(path.join(bHome, '.claude/settings.json'), 'utf8'), '{"a":1}\n');
  assert.equal(bDb.servers.size, 0, 'Nothing is written to engine connections (remote_servers)');
  assert.equal(slave.status().master_id, null, 'The engine connection id is no longer used');
  const second = new FileSync({ db: database('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), secret: 'secret', home: bHome, intervalMs: 0, remoteRequest: slaveRequest });
  await second.setRole('slave');
  await assert.rejects(second.joinInvite(invite.connection_string), /PAIRING_CODE_INVALID_OR_EXPIRED/, 'The string can be used only once');

  const issuedToken = Object.keys(master.state.tokens)[0];
  assert.equal(Object.keys(master.state.tokens).length, 1);
  assert.ok(issuedToken);
  const unpaired = await slave.unpair();
  assert.equal(Object.keys(master.state.tokens).length, 0, 'When unlinking, the master revokes that slave’s token');
  assert.equal(unpaired.role, 'child');
  assert.equal(unpaired.master_url, null);
  assert.equal(unpaired.files.length, 0);
  await assert.rejects(master.unpair(), /SYNC_NOT_CHILD/);
  await slave.joinInvite(master.createInvite('http://master.lan:3000').connection_string);
  assert.equal(slave.status().master_url, 'http://master.lan:3000', 'After unlinking, a new string can be used to reconnect');
  assert.equal((await slave.setRole('master')).role, 'master');
});

test('State saved by an old version has no mode: a node connected to a master is a slave, otherwise a master', () => {
  const key = 'file_sync_v1';
  const base = { files: [], versions: {}, observed: {}, backups: {}, error: null };
  const old = database('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  old.prepare('INSERT INTO system_state').run(key, JSON.stringify({ ...base, masterId: 5 }));
  old.servers.set(5, { id: 5, base_url: 'http://legacy-master:3000', token_cipher: encryptToken('legacy', 's') });
  const legacy = new FileSync({ db: old, secret: 's', intervalMs: 0 });
  assert.equal(legacy.status().role, 'child');
  assert.equal(legacy.status().master_url, 'http://legacy-master:3000', 'Connections made through remote_servers by old versions keep working');
  assert.equal(legacy.remote().token, 'legacy');
  assert.equal(new FileSync({ db: database('dddddddd-dddd-4ddd-8ddd-dddddddddddd'), secret: 's', intervalMs: 0 }).status().role, 'master');
});

// ---- A round with nothing new does no work (database writes, file reads and writes are counted) ----
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MARKER = '.t-agent-file-sync-managed';
const IDLE_TICKS = 20;

// Counts the file calls of the service under `root`. The test's own calls count too, so it resets the counters before a measured part.
function countFiles(t, root) {
  const counts = { read: 0, write: 0, rename: 0, utimes: 0 };
  for (const [name, key] of [['readFileSync', 'read'], ['writeFileSync', 'write'], ['renameSync', 'rename'], ['utimesSync', 'utimes']]) {
    const original = fs[name];
    t.mock.method(fs, name, (file, ...rest) => {
      if (String(file).startsWith(root)) counts[key] += 1;
      return original.call(fs, file, ...rest);
    });
  }
  counts.reset = () => { for (const key of ['read', 'write', 'rename', 'utimes']) counts[key] = 0; };
  counts.all = () => ({ read: counts.read, write: counts.write, rename: counts.rename, utimes: counts.utimes });
  return counts;
}
const NOTHING = { read: 0, write: 0, rename: 0, utimes: 0 };
// The service's clock: `skew` moves it ahead, which stands for "the files have been quiet for that long".
function testClock() {
  const clock = { skew: 0 };
  clock.now = () => Date.now() + clock.skew;
  clock.pass = ms => { clock.skew += ms; };
  return clock;
}
function logTo(lines) {
  return { warn: line => lines.push(`warn ${line}`), info: line => lines.push(`info ${line}`) };
}
// The slave's requests, answered by the master in the same process and copied as JSON like the wire. `legacy`: a master from before `if_none_match`
// (it ignores the parameter and its manifest has no etag), which is also what a new master sees from an old slave: requests without the parameter.
// `failure.code`, when set, makes every request fail with it.
function wireTo(master, { legacy = false } = {}) {
  const calls = [];
  const failure = { code: null };
  const request = async (_base, url, _token, options = {}) => {
    if (failure.code) throw Object.assign(new Error(failure.code), { statusCode: 502 });
    const target = new URL(url, 'http://master');
    const route = target.pathname.replace('/v1/file-sync', '');
    let answer;
    if (route === '/manifest') {
      answer = { ...master.manifest(legacy ? {} : Object.fromEntries(target.searchParams)) };
      if (legacy) delete answer.etag;
    } else if (route === '/file') answer = master.receive(options.body);
    else if (route === '/heartbeat') answer = options.method === 'DELETE' ? master.unregisterChild(options.body) : master.registerChild(options.body);
    else throw new Error(url);
    answer = JSON.parse(JSON.stringify(answer));
    calls.push({ method: options.method || 'GET', route, query: target.search, bytes: JSON.stringify(answer).length, answer });
    return answer;
  };
  return { request, calls, failure, manifests: () => calls.filter(call => call.route === '/manifest') };
}
// A master with two listed files and a slave connected to it, each with its own home and database, on one clock.
async function pairOfNodes(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-idle-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aHome = path.join(root, 'a');
  const bHome = path.join(root, 'b');
  fs.mkdirSync(aHome);
  fs.mkdirSync(bHome);
  fs.writeFileSync(path.join(aHome, 'one.json'), '{"one":1}\n');
  fs.writeFileSync(path.join(aHome, 'two.toml'), 'two = 2\n');
  const clock = testClock();
  const logs = [];
  const aDb = database(ID_A);
  const bDb = database(ID_B);
  const master = new FileSync({ db: aDb, secret: 'secret', home: aHome, intervalMs: 0, now: clock.now, log: logTo(logs) });
  master.setFiles(['~/one.json', '~/two.toml']);
  const wire = wireTo(master, options);
  const slave = new FileSync({ db: bDb, secret: 'secret', home: bHome, intervalMs: 0, now: clock.now, log: logTo(logs), remoteRequest: wire.request });
  await slave.connect({ url: 'http://master', token: 'token' });
  return { root, aHome, bHome, clock, logs, aDb, bDb, master, slave, wire };
}

test('A tick with nothing to do writes nothing: a master with an empty list, a slave that is not paired', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = database(ID_A);
  const logs = [];
  const node = new FileSync({ db, secret: 'secret', home: root, intervalMs: 0, log: logTo(logs) });
  assert.equal(db.writes, 1, 'a new state (its generation) is stored once, when the service is made');
  for (let i = 0; i < IDLE_TICKS; i += 1) await node.tick();
  assert.equal(db.writes, 1, 'a master with an empty list writes nothing in a tick');
  const restarted = new FileSync({ db, secret: 'secret', home: root, intervalMs: 0, log: logTo(logs) });
  assert.equal(restarted.state.generation, node.state.generation, 'the generation survives a restart');
  assert.equal(db.writes, 1, 'a restart finds the stored state and writes nothing');

  await node.setRole('slave');
  const afterRole = db.writes;
  for (let i = 0; i < IDLE_TICKS; i += 1) await node.tick();
  assert.equal(db.writes, afterRole, 'a slave that is not paired writes nothing in a tick');
  assert.equal(node.status().error, null);

  // An error left by an earlier round is cleared (and stored) once, also when there is nothing left to do.
  await node.setRole('master');
  fs.mkdirSync(path.join(root, 'folder'));
  assert.throws(() => node.setFiles(['~/folder']), /SYNC_FILE_INVALID/);
  await assert.rejects(node.tick(), /SYNC_FILE_INVALID/);
  assert.equal(node.state.error, 'SYNC_FILE_INVALID');
  node.setFiles([]);
  await node.tick();
  assert.equal(node.status().error, null);
  const cleared = db.writes;
  for (let i = 0; i < IDLE_TICKS; i += 1) await node.tick();
  assert.equal(db.writes, cleared);
  assert.deepEqual(logs, ['warn [file-sync] error: SYNC_FILE_INVALID', 'info [file-sync] working again (the error was: SYNC_FILE_INVALID)']);
});

test('An idle master reads no file and writes nothing; a changed file is still picked up', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-master-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const one = path.join(root, 'one.json');
  fs.writeFileSync(one, '{"one":1}\n');
  fs.writeFileSync(path.join(root, 'two.toml'), 'two = 2\n');
  const clock = testClock();
  const db = database(ID_A);
  const master = new FileSync({ db, secret: 'secret', home: root, intervalMs: 0, now: clock.now, log: logTo([]) });
  master.setFiles(['~/one.json', '~/two.toml']);
  const version = () => master.status().files[0].version;
  assert.equal(version(), 1);
  clock.pass(10_000);
  await master.tick(); // the first round after the quiet moment still reads: the files were last read right after they were written
  const counts = countFiles(t, root);
  const writes = db.writes;
  for (let i = 0; i < IDLE_TICKS; i += 1) await master.tick();
  assert.deepEqual(counts.all(), NOTHING, 'idle ticks only stat the files and their markers');
  assert.equal(db.writes, writes, 'idle ticks write nothing to the database');

  // A change of content is picked up at the next tick: one read, of the changed file only, and one write of the new revision.
  fs.writeFileSync(one, '{"one":2,"changed":true}\n');
  counts.reset();
  await master.tick();
  assert.equal(counts.read, 1);
  assert.equal(db.writes, writes + 1);
  assert.equal(version(), 3, 'the changed file got the next revision');
  assert.equal(master.manifest().files[0].revision, 3);
  assert.equal(Buffer.from(master.manifest().files[0].content, 'base64').toString(), '{"one":2,"changed":true}\n');

  // A file that goes away keeps its revision and has no content; when it is back with other content the revision goes up.
  fs.rmSync(one);
  await master.tick();
  assert.deepEqual(master.manifest().files[0], { path: '~/one.json', revision: 3 });
  fs.writeFileSync(one, 'back\n');
  await master.tick();
  assert.equal(version(), 4);
});

test('A file read a moment after it changed is read again at the next scan: its timestamps may not show a second change', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-racy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'one\n');
  // Every stat of the file answers the same from now on, like a file system with coarse timestamps: a second change of the same size leaves no trace.
  const frozen = fs.lstatSync(file);
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...rest) => (target === file ? frozen : lstat.call(fs, target, ...rest)));
  const clock = { at: Math.max(frozen.mtimeMs, frozen.ctimeMs) + 100 };
  const master = new FileSync({ db: database(ID_A), secret: 'secret', home: root, intervalMs: 0, now: () => clock.at, log: logTo([]) });
  master.setFiles(['~/a.txt']);
  const version = () => master.status().files[0].version;
  assert.equal(version(), 1);
  fs.writeFileSync(file, 'two\n');
  await master.tick();
  assert.equal(version(), 2, 'read again, because the first read came 100 ms after the change');
  clock.at += 10_000;
  await master.tick(); // read once more, now long after the change: from here the stat is trusted
  const counts = countFiles(t, root);
  for (let i = 0; i < 5; i += 1) await master.tick();
  assert.equal(counts.read, 0);
  assert.equal(version(), 2);
});

test('The time of the last check is kept in memory and stored at most once a minute', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-clock-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'one.json'), '{"one":1}\n');
  const clock = testClock();
  const db = database(ID_A);
  const master = new FileSync({ db, secret: 'secret', home: root, intervalMs: 0, now: clock.now, log: logTo([]) });
  master.setFiles(['~/one.json']);
  const writes = db.writes;
  const stored = () => JSON.parse(db.prepare('SELECT value FROM system_state').get('file_sync_v1').value).lastSyncAt;
  const times = new Set();
  for (let i = 0; i < 25; i += 1) { // 75 seconds of ticks, one every 3 seconds
    clock.pass(3000);
    await master.tick();
    times.add(master.status().last_sync_at);
  }
  assert.equal(times.size, 25, 'the API shows the time of every tick');
  assert.equal(db.writes, writes + 1, 'one write in 75 seconds');
  const behind = Date.parse(master.status().last_sync_at) - Date.parse(stored());
  assert.ok(behind >= 0 && behind < 60_000, `the stored time is less than a minute behind (${behind} ms)`);
});

test('Markers are written when missing or wrong, and only their time is renewed otherwise', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-marker-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'one.json');
  const marker = file + MARKER;
  fs.writeFileSync(file, '{"one":1}\n');
  const master = new FileSync({ db: database(ID_A), secret: 'secret', home: root, intervalMs: 0, log: logTo([]) });
  master.setFiles(['~/one.json']);
  assert.equal(fs.readFileSync(marker, 'utf8'), 't-agent-file-sync\n');
  const counts = countFiles(t, root);
  const markerWork = () => ({ write: counts.write, rename: counts.rename, utimes: counts.utimes });
  const inode = fs.lstatSync(marker).ino;
  for (let i = 0; i < IDLE_TICKS; i += 1) await master.tick();
  assert.deepEqual(markerWork(), { write: 0, rename: 0, utimes: 0 }, 'a fresh marker is left alone');
  assert.equal(fs.lstatSync(marker).ino, inode);

  // scripts/agent-sync.py trusts a marker for 60 seconds after its last change, so an older marker gets a new time, without being written again.
  const old = new Date(Date.now() - 30_000);
  fs.utimesSync(marker, old, old);
  counts.reset();
  await master.tick();
  assert.deepEqual(markerWork(), { write: 0, rename: 0, utimes: 1 });
  assert.ok(Date.now() - fs.lstatSync(marker).mtimeMs < 5000, 'the marker is fresh again');
  assert.equal(fs.lstatSync(marker).ino, inode, 'the same file');
  await master.tick();
  assert.equal(counts.utimes, 1, 'and it is left alone until it is old again');

  fs.rmSync(marker);
  counts.reset();
  await master.tick();
  assert.equal(fs.readFileSync(marker, 'utf8'), 't-agent-file-sync\n', 'a missing marker is written at the next tick');
  assert.deepEqual(markerWork(), { write: 1, rename: 1, utimes: 0 });

  for (const other of ['something else\n', 'x'.repeat('t-agent-file-sync\n'.length)]) {
    fs.writeFileSync(marker, other);
    // Another time than the one the service saw, also where two writes in one moment get the same timestamp.
    const moment = new Date(Date.now() - 2000);
    fs.utimesSync(marker, moment, moment);
    await master.tick();
    assert.equal(fs.readFileSync(marker, 'utf8'), 't-agent-file-sync\n', 'a marker with other content is written again');
  }
  master.setFiles([]);
  assert.equal(fs.existsSync(marker), false, 'a file taken off the list loses its marker');
});

test('An idle slave asks the master without downloading contents and neither side writes; changes on either side still travel', async t => {
  const { root, aHome, bHome, clock, logs, aDb, bDb, master, slave, wire } = await pairOfNodes(t);
  assert.equal(fs.readFileSync(path.join(bHome, 'one.json'), 'utf8'), '{"one":1}\n');
  assert.ok(fs.existsSync(path.join(bHome, 'one.json') + MARKER));
  clock.pass(10_000);
  await slave.tick(); // the first round after the quiet moment is a full one: it has no earlier round to compare with
  assert.equal(wire.manifests().at(-1).query, '');
  assert.ok(Array.isArray(wire.manifests().at(-1).answer.files));

  const counts = countFiles(t, root);
  const writes = { a: aDb.writes, b: bDb.writes };
  wire.calls.length = 0;
  for (let i = 0; i < IDLE_TICKS; i += 1) await slave.tick();
  assert.deepEqual(counts.all(), NOTHING, 'no file is read or written on either side');
  assert.deepEqual({ a: aDb.writes, b: bDb.writes }, writes, 'no database write on either side');
  assert.equal(wire.manifests().length, IDLE_TICKS);
  for (const call of wire.manifests()) {
    assert.match(call.query, /^\?if_none_match=[0-9a-f]{32}$/);
    assert.equal(call.answer.unchanged, true);
    assert.equal(call.answer.files, undefined, 'no contents travel');
    assert.ok(call.bytes < 300, `a small answer (${call.bytes} bytes)`);
  }
  assert.equal(wire.calls.filter(call => call.route === '/heartbeat').length, IDLE_TICKS, 'the slave still reports to the master in every round');
  assert.equal(master.status().children[0].online, true);
  assert.equal(slave.status().error, null);

  // The master's file changes: the same cheap question now gets the full manifest, and the slave takes the new content.
  fs.writeFileSync(path.join(aHome, 'one.json'), '{"one":2,"from":"master"}\n');
  await slave.tick();
  assert.match(wire.manifests().at(-1).query, /^\?if_none_match=/);
  assert.ok(Array.isArray(wire.manifests().at(-1).answer.files), 'a changed master answers with the contents');
  assert.equal(fs.readFileSync(path.join(bHome, 'one.json'), 'utf8'), '{"one":2,"from":"master"}\n');

  // The slave's copy changes: it is sent to the master at the next tick.
  fs.writeFileSync(path.join(bHome, 'two.toml'), 'two = "from the slave"\n');
  await slave.tick();
  assert.equal(fs.readFileSync(path.join(aHome, 'two.toml'), 'utf8'), 'two = "from the slave"\n');

  // And it goes quiet again after a few rounds.
  for (let i = 0; i < 3; i += 1) await slave.tick();
  counts.reset();
  wire.calls.length = 0;
  const quiet = { a: aDb.writes, b: bDb.writes };
  for (let i = 0; i < IDLE_TICKS; i += 1) await slave.tick();
  assert.ok(wire.manifests().every(call => call.answer.unchanged === true));
  assert.deepEqual(counts.all(), NOTHING);
  assert.deepEqual({ a: aDb.writes, b: bDb.writes }, quiet);

  // A conflict stays reported while nothing changes, is logged once and is not stored again and again.
  fs.writeFileSync(path.join(aHome, 'one.json'), '{"one":3,"side":"master, longer"}\n');
  fs.writeFileSync(path.join(bHome, 'one.json'), '{"one":3,"side":"slave"}\n');
  await slave.tick();
  assert.equal(slave.status().error, 'SYNC_CONFLICT:~/one.json');
  const conflict = bDb.writes;
  for (let i = 0; i < IDLE_TICKS; i += 1) await slave.tick();
  assert.equal(slave.status().error, 'SYNC_CONFLICT:~/one.json', 'still reported after rounds that found nothing new');
  assert.equal(bDb.writes, conflict);
  assert.equal(logs.filter(line => line.includes('SYNC_CONFLICT')).length, 1);
  assert.equal(fs.readFileSync(path.join(bHome, 'one.json'), 'utf8'), '{"one":3,"side":"slave"}\n', 'the local change is kept');
  await slave.resolveConflict('~/one.json');
  await slave.tick();
  assert.equal(slave.status().error, null);
  assert.equal(fs.readFileSync(path.join(bHome, 'one.json'), 'utf8'), '{"one":3,"side":"master, longer"}\n');
});

test('Old and new nodes still work together: requests without if_none_match and manifests without an etag', async t => {
  const { aHome, bHome, clock, master, slave, wire } = await pairOfNodes(t, { legacy: true });
  // What an old slave reads from a new master: the full manifest with the same fields as before.
  const manifest = master.manifest();
  assert.deepEqual(Object.keys(manifest.files[0]), ['path', 'revision', 'hash', 'content', 'size']);
  assert.equal(manifest.instance_id, ID_A);
  assert.equal(typeof manifest.generation, 'string');
  assert.ok(Array.isArray(master.manifest({ if_none_match: 'not-the-etag' }).files), 'an unknown etag gets the full manifest');
  assert.ok(Array.isArray(master.manifest({ if_none_match: ['a', 'b'] }).files), 'a parameter that is not one string is ignored');

  clock.pass(10_000);
  // Both directions, by hand (POST /run): every round asks for the full manifest.
  fs.writeFileSync(path.join(aHome, 'one.json'), '{"one":2,"from":"master"}\n');
  await slave.tick();
  assert.equal(fs.readFileSync(path.join(bHome, 'one.json'), 'utf8'), '{"one":2,"from":"master"}\n');
  fs.writeFileSync(path.join(bHome, 'two.toml'), 'two = "from the slave"\n');
  await slave.tick();
  assert.equal(fs.readFileSync(path.join(aHome, 'two.toml'), 'utf8'), 'two = "from the slave"\n');
  assert.ok(wire.calls.every(call => call.query === ''), 'no parameter is sent to a master that never announced an etag');
  assert.ok(wire.manifests().every(call => Array.isArray(call.answer.files)));

  // The timer: once the answers stopped changing, the full manifest is asked for every 15 seconds; the heartbeat stays in every round.
  const scheduled = async () => { clock.pass(3000); await slave.tick({ scheduled: true }); };
  for (let i = 0; i < 5; i += 1) await scheduled();
  wire.calls.length = 0;
  const lastCheck = slave.status().last_sync_at;
  await scheduled();
  assert.equal(wire.manifests().length, 0, 'an idle round does not download the manifest');
  assert.equal(slave.status().last_sync_at, lastCheck, 'and does not count as a check');
  wire.calls.length = 0;
  for (let i = 0; i < 10; i += 1) await scheduled(); // 30 seconds: two downloads, where the old code made ten (one more is allowed for a slow machine)
  assert.ok(wire.manifests().length >= 2 && wire.manifests().length <= 3, `${wire.manifests().length} manifests in 30 seconds`);
  assert.equal(wire.calls.filter(call => call.route === '/heartbeat').length, 10);

  // A local change does not wait for the 15 seconds.
  wire.calls.length = 0;
  fs.writeFileSync(path.join(bHome, 'one.json'), '{"one":3,"from":"the slave, at once"}\n');
  await scheduled();
  assert.equal(fs.readFileSync(path.join(aHome, 'one.json'), 'utf8'), '{"one":3,"from":"the slave, at once"}\n');
  // A change on the old master arrives within 15 seconds.
  for (let i = 0; i < 5; i += 1) await scheduled();
  fs.writeFileSync(path.join(aHome, 'two.toml'), 'two = "master again, later"\n');
  for (let i = 0; i < 5; i += 1) await scheduled();
  assert.equal(fs.readFileSync(path.join(bHome, 'two.toml'), 'utf8'), 'two = "master again, later"\n');
  // A round asked for by hand always asks.
  for (let i = 0; i < 5; i += 1) await scheduled();
  wire.calls.length = 0;
  await slave.tick();
  assert.equal(wire.manifests().length, 1);
});

test('A failing round is logged once and stored once, again when the error changes, and once when it is over', async t => {
  const { root, bDb, logs, slave, wire, clock } = await pairOfNodes(t);
  clock.pass(10_000);
  await slave.tick();
  logs.length = 0;
  let writes = bDb.writes;
  wire.failure.code = 'REMOTE_TIMEOUT';
  for (let i = 0; i < 5; i += 1) await assert.rejects(slave.tick(), /REMOTE_TIMEOUT/);
  assert.deepEqual(logs, ['warn [file-sync] error: REMOTE_TIMEOUT']);
  assert.equal(bDb.writes, writes + 1, 'the error is stored once');
  assert.equal(slave.status().error, 'REMOTE_TIMEOUT');

  wire.failure.code = 'REMOTE_HTTP_500';
  for (let i = 0; i < 5; i += 1) await assert.rejects(slave.tick(), /REMOTE_HTTP_500/);
  assert.deepEqual(logs.slice(1), ['warn [file-sync] error: REMOTE_HTTP_500']);
  assert.equal(bDb.writes, writes + 2);

  wire.failure.code = null;
  for (let i = 0; i < 5; i += 1) await slave.tick();
  assert.deepEqual(logs.slice(2), ['info [file-sync] working again (the error was: REMOTE_HTTP_500)']);
  assert.equal(bDb.writes, writes + 3, 'and cleared once');
  assert.equal(slave.status().error, null);

  // The same on a master: a listed path that became a folder.
  const home = path.join(root, 'm');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'one.json'), '{}\n');
  const db = database('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const lines = [];
  const master = new FileSync({ db, secret: 'secret', home, intervalMs: 0, log: logTo(lines) });
  master.setFiles(['~/one.json']);
  fs.rmSync(path.join(home, 'one.json'));
  fs.mkdirSync(path.join(home, 'one.json'));
  writes = db.writes;
  for (let i = 0; i < 5; i += 1) await assert.rejects(master.tick(), /SYNC_FILE_INVALID/);
  assert.deepEqual(lines, ['warn [file-sync] error: SYNC_FILE_INVALID']);
  assert.equal(db.writes, writes + 1);
});
