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
      if (sql.includes('FROM remote_servers')) return { get: id => servers.get(Number(id)) };
      if (sql.includes('FROM engine_identity')) return { get: () => ({ value: identity }) };
      throw new Error(sql);
    },
  };
}

test('用户目录和绝对路径规范化，拒绝路径穿越', () => {
  assert.equal(normalizeSpec('用户目录/.claude/settings.json'), '~/.claude/settings.json');
  assert.equal(normalizeSpec('$HOME/.codex/config.toml'), '~/.codex/config.toml');
  assert.equal(normalizeSpec('/tmp/config.toml'), '/tmp/config.toml');
  assert.throws(() => normalizeSpec('~/../secret'), /SYNC_PATH_INVALID/);
  assert.throws(() => normalizeSpec('relative/path'), /SYNC_PATH_INVALID/);
});

test('主节点文件清单、首次下载、双向更新及冲突', async t => {
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
  bDb.servers.set(1, { id: 1, base_url: 'http://master', token_cipher: encryptToken('token', 'secret') });
  cDb.servers.set(1, { id: 1, base_url: 'http://master', token_cipher: encryptToken('token', 'secret') });
  assert.equal(master.status().role, 'master');
  assert.deepEqual(master.status().files, []);
  master.setFiles(['~/.claude/settings.json']);
  await child.connect(1);
  await sibling.connect(1);
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

test('子节点把 Mac 绝对路径映射到本机路径，备份旧文件并可恢复默认', async t => {
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
  childDb.servers.set(1, { id: 1, base_url: 'http://master', token_cipher: encryptToken('token', 'secret') });
  const child = new FileSync({ db: childDb, secret: 'secret', home: childHome, intervalMs: 0, remoteRequest: async (_base, url, _token, options) => {
    if (url.endsWith('/manifest')) return master.manifest();
    if (url.endsWith('/heartbeat')) return { registered: true };
    if (url.endsWith('/file')) return master.receive(options.body);
    throw new Error(url);
  } });
  await child.connect(1);
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

test('首次连接时不在服务器创建主节点独有的绝对路径', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-foreign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const foreign = path.join(root, 'mac', 'Users', 'name', '.codex', 'config.toml');
  const home = path.join(root, 'linux');
  fs.mkdirSync(home);
  const db = database('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  db.servers.set(1, { id: 1, base_url: 'http://master', token_cipher: encryptToken('token', 'secret') });
  const content = Buffer.from('model = "master"\n').toString('base64');
  const hash = require('node:crypto').createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex');
  const manifest = { generation: 'generation', files: [{ path: foreign, revision: 1, content, hash }] };
  const child = new FileSync({ db, secret: 'secret', home, intervalMs: 0, remoteRequest: async (_base, url) => {
    if (url.endsWith('/manifest')) return manifest;
    return { registered: true };
  } });
  await child.connect(1);
  assert.equal(child.status().files[0].path_required, true);
  assert.equal(fs.existsSync(foreign), false);
  child.setPath({ path: foreign, local_path: '~/.codex/config.toml' });
  await child.tick();
  assert.equal(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), 'model = "master"\n');
});
