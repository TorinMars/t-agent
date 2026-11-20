const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-version-skew-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createVersionSkew, createNudgeReceiver, compare, signature, SHARED_CAPABILITIES, NUDGE_CAPABILITY, INFO_TTL_MS, NUDGE_GAP_MS, NUDGE_CHECK_GAP_MS,
} = require('../services/version-skew');

const NEW_CAPS = ['tasks:read', 'settings:sync', 'learn:sync', 'page-state:sync', 'task-order', NUDGE_CAPABILITY];
const OLD_CAPS = ['tasks:read', 'settings:sync', 'task-order'];

test('compare: the older engine lacks the shared capabilities a newer one lists; others are not counted', () => {
  const { newest, engines } = compare([
    { id: 'local', self: true, instance_id: 'K', name: 'K01', version: '2.145.0', capabilities: [...NEW_CAPS, 'pm2:manage'], shared: SHARED_CAPABILITIES },
    { id: 'l1', instance_id: 'T', name: 'T01', version: '2.141.2', capabilities: OLD_CAPS, shared: null },
  ]);
  assert.equal(newest, '2.145.0');
  assert.deepEqual(engines.map(engine => engine.name), ['K01', 'T01'], 'by name');
  const t01 = engines.find(engine => engine.name === 'T01');
  assert.equal(t01.older, true);
  assert.deepEqual(t01.missing, ['learn:sync', 'page-state:sync'], 'pm2:manage is not shared, so it does not count');
  const k01 = engines.find(engine => engine.name === 'K01');
  assert.equal(k01.older, false);
  assert.deepEqual(k01.missing, []);
  assert.equal(signature(engines), 'T@2.141.2');
});

test('compare: a newer engine names shared capabilities this one does not know; same version means no skew', () => {
  const { engines } = compare([
    { id: 'local', self: true, instance_id: 'T', name: 'T01', version: '2.141.2', capabilities: OLD_CAPS, shared: SHARED_CAPABILITIES },
    { id: 'l1', instance_id: 'K', name: 'K01', version: '2.150.0', capabilities: [...OLD_CAPS, 'future:sync', 'other:thing'], shared: ['future:sync', 'task-order'] },
  ]);
  assert.deepEqual(engines.find(engine => engine.self).missing, ['future:sync'], 'its own list, intersected with what it lists');
  const same = compare([
    { id: 'local', self: true, name: 'A', version: '2.141.2', capabilities: NEW_CAPS, shared: SHARED_CAPABILITIES },
    { id: 'l1', name: 'B', version: '2.141.2', capabilities: OLD_CAPS, shared: null },
  ]);
  assert.equal(signature(same.engines), null, 'a configuration difference at the same version is no version skew');
  assert.equal(same.engines.some(engine => engine.older), false);
  const bad = compare([{ id: 'local', self: true, name: 'A', version: 'nope', capabilities: [] }]);
  assert.deepEqual(bad.engines, [], 'an engine without a valid version is left out');
});

function harness({ peers, infos, mine = { instance_id: 'K', name: 'K01', version: '2.145.0', capabilities: NEW_CAPS } } = {}) {
  const box = { clock: 1_000_000, reads: [], nudges: [], listeners: [], timers: [], peers, infos, failNudge: false };
  box.skew = createVersionSkew({
    serviceLinks: {
      peers: () => box.peers,
      onChange(listener) { box.listeners.push(listener); return () => { box.listeners = box.listeners.filter(item => item !== listener); }; },
    },
    readInfo: async peer => {
      box.reads.push(peer.id);
      const info = box.infos[peer.id];
      if (!info) throw new Error('REMOTE_CONNECTION_FAILED');
      return info;
    },
    request: async (baseUrl, route, token, options) => {
      if (box.failNudge) throw new Error('REMOTE_TIMEOUT');
      box.nudges.push({ baseUrl, route, token, method: options.method });
      return { accepted: true };
    },
    local: () => mine,
    now: () => box.clock,
    log: { log() {}, warn() {} },
    schedule: (fn, ms) => { const timer = { fn, ms }; box.timers.push(timer); return timer; },
    cancel: timer => { box.timers = box.timers.filter(item => item !== timer); },
  });
  box.runTimers = async () => { const due = box.timers; box.timers = []; for (const timer of due) timer.fn(); await box.skew.refresh(); };
  return box;
}

const peer = (id, name, online = true) => ({ id, name, online, baseUrl: `tunnel://${id}`, token: `tok-${id}`, remoteServerId: 1, instanceId: name[0] });

test('view: online peers are read once per TTL; the flag answers from the cache and reads in the background', async () => {
  const box = harness({
    peers: [peer('l1', 'T01'), peer('l2', 'X01', false)],
    infos: { l1: { engine_id: 'T', engine_version: '2.141.2', capabilities: OLD_CAPS }, l2: { engine_version: '1.0.0', capabilities: [] } },
  });
  assert.equal(box.skew.flag(), null, 'nothing is known before the first read');
  await box.skew.refresh();
  assert.deepEqual(box.reads, ['l1'], 'an offline peer is not read');
  assert.equal(box.skew.flag(), 'T@2.141.2');
  const view = await box.skew.view();
  assert.deepEqual(view.engines.map(engine => [engine.name, engine.version, engine.older]), [['K01', '2.145.0', false], ['T01', '2.141.2', true]]);
  assert.equal(box.reads.length, 1, 'still fresh');
  box.clock += INFO_TTL_MS;
  await box.skew.view();
  assert.equal(box.reads.length, 2, 'read again after the TTL');
});

test('a link that changes is forgotten and read again a moment later; a peer that stops answering is not compared', async () => {
  const box = harness({ peers: [peer('l1', 'T01')], infos: { l1: { engine_id: 'T', engine_version: '2.141.2', capabilities: OLD_CAPS } } });
  box.skew.start();
  assert.equal(box.timers.length, 1, 'a first read is scheduled at start');
  await box.runTimers();
  assert.equal(box.skew.flag(), 'T@2.141.2');
  box.infos.l1 = { engine_id: 'T', engine_version: '2.145.0', capabilities: NEW_CAPS }; // T01 updated and its link came back
  box.listeners.forEach(listener => listener('l1'));
  assert.equal(box.skew.snapshot().engines.length, 1, 'forgotten at once');
  await box.runTimers();
  assert.equal(box.skew.flag(), null, 'the versions agree');
  box.infos.l1 = null;
  box.listeners.forEach(listener => listener('l1'));
  await box.runTimers();
  assert.equal(box.skew.snapshot().engines.length, 1);
  box.skew.stop();
  assert.equal(box.listeners.length, 0);
});

test('nudge: an older peer with the capability is asked once per version; one without it, or a newer one, is not', async () => {
  const box = harness({
    peers: [peer('l1', 'T01'), peer('l2', 'Old'), peer('l3', 'New')],
    infos: {
      l1: { engine_version: '2.145.0', capabilities: NEW_CAPS }, // the same version: nothing to follow
      l2: { engine_version: '2.100.0', capabilities: OLD_CAPS }, // older, and too old to be asked
      l3: { engine_version: '2.146.0', capabilities: NEW_CAPS }, // newer than this engine
    },
  });
  await box.skew.refresh();
  assert.deepEqual(box.nudges, []);
  box.infos.l1 = { engine_version: '2.144.0', capabilities: NEW_CAPS };
  box.clock += INFO_TTL_MS;
  await box.skew.refresh();
  assert.deepEqual(box.nudges, [{ baseUrl: 'tunnel://l1', route: '/v1/update/nudge', token: 'tok-l1', method: 'POST' }]);
  box.clock += INFO_TTL_MS;
  await box.skew.refresh();
  assert.equal(box.nudges.length, 1, 'not again for the same version');
  box.clock += NUDGE_GAP_MS;
  await box.skew.refresh();
  assert.equal(box.nudges.length, 2, 'again after the gap, when it still has not followed');
});

test('nudge: a failed nudge is tried again at the next read', async () => {
  const box = harness({ peers: [peer('l1', 'T01')], infos: { l1: { engine_version: '2.144.0', capabilities: NEW_CAPS } } });
  box.failNudge = true;
  await box.skew.refresh();
  assert.equal(box.nudges.length, 0);
  box.failNudge = false;
  await box.skew.refresh({ force: true });
  assert.equal(box.nudges.length, 1);
});

test('the receiving side: one forced check a minute, however many nudges', async () => {
  let clock = 0;
  let checks = 0;
  const receive = createNudgeReceiver({ check: async () => { checks += 1; }, now: () => clock });
  assert.deepEqual(receive(), { accepted: true, checking: true });
  assert.deepEqual(receive(), { accepted: true, checking: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 1);
  clock += NUDGE_CHECK_GAP_MS;
  assert.equal(receive().checking, true);
  const failing = createNudgeReceiver({ check: async () => { throw new Error('VERSION_REQUEST_TIMEOUT'); }, now: () => 0 });
  assert.equal(failing().accepted, true, 'a failed check is not the caller\'s problem');
  await new Promise(resolve => setImmediate(resolve));
});
