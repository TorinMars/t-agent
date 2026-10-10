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
