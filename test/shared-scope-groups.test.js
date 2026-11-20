// The settings that moved from "this machine" to the settings sync ("scope-fixes", docs/design/server-state-keys.md): the agent config defaults
// (group agent-config), the T-Attention first-run guide's closed / "This page only" flags (attention-guide) and the switch "Update automatically
// when idle" (update-auto). Two engines with their own databases and their real adapters, joined by one fake link that carries the sealed requests
// of services/settings-sync.js. What must hold: a configured engine is never wiped when it first meets an unconfigured one, the per-machine parts of
// each row stay where they are, and the first sync after the update never turns automatic updates off (nor on) anywhere; only a choice made with
// this version travels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-shared-scope-groups-'));
test.after(() => fs.rmSync(process.env.T_AGENT_DATA_DIR, { recursive: true, force: true }));

const Database = require('better-sqlite3');
const { createSettingsSync, CAPABILITY, SCOPES } = require('../services/settings-sync');
const agentConfig = require('../services/agent-config');
const attentionGuide = require('../services/attention-guide');
const { createAutoUpdate } = require('../services/auto-update');

const OWNER = 'owner';
const LINK = '0b9a2f7c-1d2e-4f3a-8b4c-5d6e7f8a9b0c';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222'; // the greater id: it wins a tie of two values from before
const TOKEN_TO_B = `tae_${'a'.repeat(43)}`;
const TOKEN_TO_A = `tae_${'b'.repeat(43)}`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const GROUPS = ['agent-config', 'attention-guide', 'update-auto'];

function memoryDb() {
  const memory = new Database(':memory:');
  memory.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return memory;
}

// One engine: its database, its scheduler of automatic updates (as services/update-manager.js makes it) and its settings sync over the real adapters.
function engine(name, instanceId, { autoStore = null } = {}) {
  const db = memoryDb();
  const side = { name, instanceId, db, clock: { now: 1000 }, autoStore, kicks: 0, logs: [] };
  side.auto = createAutoUpdate({
    readStore: () => side.autoStore,
    writeStore: value => { side.autoStore = value; },
    updateState: () => ({ status: 'current' }),
    isApplying: () => false,
    apply: async () => ({}),
    log: (scope, message) => side.logs.push(message),
    supervisor: () => 'pm2',
    checksEnabled: true,
    checkIntervalMs: 60_000,
    now: () => side.clock.now,
    setIntervalFn: () => ({ unref() {} }),
  });
  side.store = agentConfig.createAgentConfigStore(db);
  side.guide = attentionGuide.createAttentionGuide({ db, now: () => new Date(side.clock.now) });
  const registry = [
    { key: 'agent-config', read: owner => agentConfig.exportForSync({ db }, owner), write: (owner, value) => agentConfig.importFromSync({ db }, owner, value) },
    { key: 'attention-guide', read: owner => attentionGuide.exportForSync({ db }, owner), write: (owner, value) => attentionGuide.importFromSync({ db }, owner, value) },
    // services/update-manager.js exportForSync / importFromSync, over this engine's own scheduler.
    { key: 'update-auto', read: () => side.auto.syncValue(), write: (owner, value) => side.auto.applySync(value) },
  ];
  side.registry = registry;
  return side;
}

function link(a, b) {
  const wire = [];
  const join = (side, other, peerName, token, ownHash) => {
    side.other = other;
    side.peer = { id: LINK, name: peerName, online: true, remoteServerId: 1, instanceId: null, baseUrl: `fake://${peerName}`, token };
    side.service = createSettingsSync({
      db: side.db, sessionSecret: `${side.name}-session-secret`, registry: side.registry, owner: () => OWNER,
      serviceLinks: { peers: () => [side.peer], onChange: () => () => {}, noteUnauthorized() {} },
      identity: () => ({ instance_id: side.instanceId, name: side.name }), issuedTokenHash: () => ownHash,
      request: (baseUrl, route, tokenUsed, opts = {}) => dispatch(side, route, opts),
      now: () => side.clock.now, log: { warn: message => side.logs.push(String(message)), info() {}, error() {} }, intervalMs: 0, debounceMs: 5,
    });
  };
  async function dispatch(from, route, opts) {
    const target = from.other;
    const method = opts.method || 'GET';
    const body = opts.body === undefined ? undefined : JSON.parse(JSON.stringify(opts.body));
    const keys = body && Array.isArray(body.keys) ? body.keys : [];
    wire.push({ from: from.name, method, path: route.split('?')[0], keys });
    const linkRecord = { id: LINK, revoked: false, peer_instance_id: from.instanceId };
    const url = new URL(route, 'http://peer');
    let answer;
    if (url.pathname === '/v1/info') answer = { capabilities: [CAPABILITY] };
    else if (method === 'GET') answer = target.service.engineDescribe(linkRecord, url.searchParams.get('public_key'));
    else if (method === 'POST') answer = target.service.enginePull(linkRecord, body);
    else answer = target.service.enginePush(linkRecord, body);
    const copy = JSON.parse(JSON.stringify(answer));
    if (method === 'PUT') wire[wire.length - 1].applied = copy.applied;
    return copy;
  }
  join(a, b, 'B', TOKEN_TO_B, sha(TOKEN_TO_A));
  join(b, a, 'A', TOKEN_TO_A, sha(TOKEN_TO_B));
  // What travelled for one group: pulled by one side, or pushed and applied.
  const moved = group => wire.filter(call => (call.method === 'POST' && call.keys.includes(group)) || (call.method === 'PUT' && (call.applied || []).includes(group)));
  return { wire, moved };
}

// The first start with this version: every group gets its metadata (a value from before counts as time 0).
const firstStart = (...sides) => { for (const side of sides) side.service.reconcile(); };
// A change through the save path the page uses, then the debounced round.
async function settle(...sides) {
  await new Promise(resolve => setTimeout(resolve, 40));
  for (const side of sides) await side.service.syncAll();
}

test('the three groups are shared groups of the settings sync', () => {
  for (const group of GROUPS) assert.equal(SCOPES[group], 'shared', group);
});

test('agent-config: the defaults of a configured engine reach an unconfigured one and are never wiped by it; the overrides stay on each machine', async () => {
  for (const starter of ['A', 'B']) {
    const a = engine('A', ID_A);
    const b = engine('B', ID_B);
    a.store.setDefaults(OWNER, 'claude', { model: 'opus', permission: 'plan' });
    a.store.setOverride(OWNER, '7', 'claude', { model: 'sonnet' });
    // B has a row of its own, but no defaults: an override and a push result for its own rows.
    b.store.setOverride(OWNER, '3', 'codex', { sandbox: 'read-only' });
    b.store.setStatus(OWNER, 'local', { at: '2026-11-01T00:00:00.000Z', ok: true, error: null });
    link(a, b);
    firstStart(a, b);
    assert.equal(a.service.meta()['agent-config'].updated_at, 0, 'a value from before counts as time 0');
    assert.equal(b.service.meta()['agent-config'].hash, null, 'an engine with only overrides has no shared value');
    await (starter === 'A' ? a : b).service.syncAll();
    assert.deepEqual(b.store.get(OWNER).defaults, { claude: { model: 'opus', permission: 'plan' }, codex: {} }, `${starter} starts: B takes the defaults`);
    assert.deepEqual(a.store.get(OWNER).defaults, { claude: { model: 'opus', permission: 'plan' }, codex: {} }, `${starter} starts: A keeps them`);
    assert.deepEqual(b.store.get(OWNER).servers, { 3: { codex: { sandbox: 'read-only' } } }, 'B keeps its own overrides');
    assert.equal(b.store.get(OWNER).status.local.ok, true, 'and its push results');
    assert.deepEqual(a.store.get(OWNER).servers, { 7: { claude: { model: 'sonnet' } } }, 'A\'s overrides never travel');
  }
});

test('agent-config: a later change wins both ways, and clearing the defaults clears them everywhere but keeps the overrides', async () => {
  const a = engine('A', ID_A);
  const b = engine('B', ID_B);
  const { moved } = link(a, b);
  firstStart(a, b);
  await a.service.syncAll();
  assert.equal(moved('agent-config').length, 0, 'two engines without defaults send nothing');

  b.store.setOverride(OWNER, '3', 'claude', { model: 'haiku' });
  b.clock.now = 5000;
  b.store.setDefaults(OWNER, 'codex', { model: 'gpt-x', sandbox: 'workspace-write' });
  await settle(b);
  assert.deepEqual(a.store.get(OWNER).defaults, { claude: {}, codex: { model: 'gpt-x', sandbox: 'workspace-write' } });

  a.clock.now = 9000;
  a.store.setDefaults(OWNER, 'codex', {});
  await settle(a);
  assert.deepEqual(b.store.get(OWNER).defaults, { claude: {}, codex: {} }, 'the clear travels as a tombstone');
  assert.deepEqual(b.store.get(OWNER).servers, { 3: { claude: { model: 'haiku' } } }, 'the overrides stay');
});

test('attention-guide: a closed guide stays closed on every engine; paired and tested stay on their machine; "Show setup guide" travels too', async () => {
  for (const starter of ['A', 'B']) {
    const a = engine('A', ID_A);
    const b = engine('B', ID_B);
    a.guide.save(OWNER, { dismissed: true, pageOnly: true });
    b.guide.save(OWNER, { paired: true, tested: true }); // B's guide was never closed, but steps were done there
    link(a, b);
    firstStart(a, b);
    await (starter === 'A' ? a : b).service.syncAll();
    assert.deepEqual({ ...b.guide.get(OWNER), updatedAt: null }, { dismissed: true, pageOnly: true, paired: true, tested: true, updatedAt: null }, `${starter} starts`);
    assert.deepEqual({ ...a.guide.get(OWNER), updatedAt: null }, { dismissed: true, pageOnly: true, paired: false, tested: false, updatedAt: null }, 'A keeps its own steps');
  }

  const a = engine('A', ID_A);
  const b = engine('B', ID_B);
  link(a, b);
  a.guide.save(OWNER, { dismissed: true });
  firstStart(a, b);
  await a.service.syncAll();
  assert.equal(b.guide.get(OWNER).dismissed, true);
  // "Show setup guide" on B: the guide comes back on A as well.
  b.clock.now = 7000;
  b.guide.save(OWNER, { dismissed: false });
  await settle(b);
  assert.equal(a.guide.get(OWNER).dismissed, false);
  // Only paired or tested: nothing to share, nothing is sent.
  const changes = a.service.meta()['attention-guide'];
  b.guide.save(OWNER, { tested: true });
  await settle(b);
  assert.deepEqual(a.service.meta()['attention-guide'], changes);
  assert.equal(a.guide.get(OWNER).tested, false);
});

test('update-auto: the first sync after the update changes no engine; a value from before never travels', async () => {
  const stored = enabled => JSON.stringify({ enabled, attempts: { '2.0.0': { count: 1 } }, last_auto_version: '2.1.0' });
  // Every mix of "on by default" (no row), on and off from before, with either side starting the round.
  for (const [before, label] of [[[null, stored(false)], 'A on by default, B off'], [[stored(false), null], 'A off, B on by default'], [[stored(true), stored(false)], 'A on, B off'], [[stored(false), stored(true)], 'A off, B on']]) {
    for (const starter of ['A', 'B']) {
      const a = engine('A', ID_A, { autoStore: before[0] });
      const b = engine('B', ID_B, { autoStore: before[1] });
      const was = [a.auto.publicState().enabled, b.auto.publicState().enabled];
      const { moved } = link(a, b);
      firstStart(a, b);
      await (starter === 'A' ? a : b).service.syncAll();
      await (starter === 'A' ? b : a).service.syncAll();
      assert.deepEqual([a.auto.publicState().enabled, b.auto.publicState().enabled], was, `${label}, ${starter} starts: nothing changed`);
      assert.equal(moved('update-auto').length, 0, `${label}: nothing travelled`);
    }
  }
});

test('update-auto: a switch set with this version reaches every engine, the newer choice wins, and the history stays on each machine', async () => {
  // B was turned off before the update, A is on by default. The person turns automatic updates off on A, after the update: B stays off, A off.
  // Then on, on B: both on.
  const a = engine('A', ID_A);
  const b = engine('B', ID_B, { autoStore: JSON.stringify({ enabled: false, attempts: { '2.0.0': { count: 2, last_at: 5 } } }) });
  link(a, b);
  firstStart(a, b);
  await a.service.syncAll();
  a.clock.now = 4000;
  a.auto.setEnabled(false); // what POST /api/system/auto-update does (update-manager also calls the save hook)
  a.service.noteLocalChange('update-auto');
  await settle(a);
  assert.equal(b.auto.publicState().enabled, false);
  assert.deepEqual(b.auto.syncValue(), { enabled: false }, 'B holds the shared value now');
  b.clock.now = 6000;
  b.auto.setEnabled(true);
  b.service.noteLocalChange('update-auto');
  await settle(b);
  assert.equal(a.auto.publicState().enabled, true, 'turned on again from B');
  assert.deepEqual(JSON.parse(b.autoStore).attempts, { '2.0.0': { count: 2, last_at: 5 } }, 'B keeps its own attempts');
  assert.equal(JSON.parse(a.autoStore).attempts, null, 'which never travel');
  assert.ok(a.logs.includes('Auto update turned on (from a linked device)'), 'the log says where the change came from');

});

test('update-auto: a new engine that never had the switch set takes the shared choice, whichever side starts', async () => {
  for (const starter of ['old', 'new']) {
    const home = engine('A', ID_B);
    const fresh = engine('C', ID_A); // the smaller id, and on by default
    link(home, fresh);
    firstStart(home);
    home.clock.now = 8000;
    home.auto.setEnabled(false);
    home.service.reconcile();
    firstStart(fresh);
    await (starter === 'old' ? home : fresh).service.syncAll();
    assert.equal(fresh.auto.publicState().enabled, false, `${starter} starts: the new engine is off too`);
    assert.equal(home.auto.publicState().enabled, false, 'and the engine that had it keeps it');
  }
});

test('update-auto: a value from a linked engine is checked; null only stops sharing the switch', () => {
  const a = engine('A', ID_A, { autoStore: JSON.stringify({ enabled: false }) });
  assert.equal(a.auto.syncValue(), null, 'a value from before is not shared');
  for (const bad of ['on', { enabled: 'yes' }, { enabled: true, attempts: {} }, []]) assert.throws(() => a.auto.applySync(bad), /INVALID_SYNC_VALUE/);
  assert.equal(a.auto.publicState().enabled, false, 'a refused value changes nothing');
  a.auto.applySync({ enabled: true });
  assert.equal(a.auto.publicState().enabled, true);
  assert.deepEqual(a.auto.syncValue(), { enabled: true });
  a.auto.applySync(null);
  assert.equal(a.auto.syncValue(), null, 'null only stops sharing it');
  assert.equal(a.auto.publicState().enabled, true, 'and keeps the switch as it is');
});
