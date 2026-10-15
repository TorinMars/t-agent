const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileSync, normalizeSpec } = require('../services/file-sync');
const { encryptToken } = require('../lib/token-crypto');

function database(identity) {
  const values = new Map();
  const servers = new Map();
  return {
    servers,
    prepare(sql) {
      if (sql.includes('FROM system_state')) return { get: key => values.has(key) ? { value: values.get(key) } : undefined };
      if (sql.includes('INTO system_state')) return { run: (key, value) => values.set(key, value) };
      if (sql.includes('FROM remote_servers WHERE owner_id')) return { get: (owner, url) => [...servers.values()].find(row => row.owner_id === owner && row.base_url === url) };
      if (sql.includes('INSERT INTO remote_servers')) return { run: (owner, name, url, cipher) => { const id = servers.size + 1; servers.set(id, { id, owner_id: owner, name, base_url: url, token_cipher: cipher }); return { lastInsertRowid: id }; } };
      if (sql.includes('UPDATE remote_servers')) return { run: (cipher, id) => { servers.get(id).token_cipher = cipher; } };
      if (sql.includes('FROM remote_servers')) return { get: id => servers.get(Number(id)) };
      if (sql.includes('FROM engine_identity')) return { get: () => ({ value: identity }) };
      throw new Error(sql);
    },
  };
}

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
    if (url.endsWith('/manifest')) return master.manifest();
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
    if (url.endsWith('/manifest')) return master.manifest();
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
    if (url.endsWith('/manifest')) return manifest;
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
    if (url.endsWith('/manifest')) return master.manifest();
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
    if (url.endsWith('/manifest')) return master.manifest();
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
