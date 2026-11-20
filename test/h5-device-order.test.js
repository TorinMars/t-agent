// The one order of devices on every page (scripts/h5-shell/device-order.mjs, "Devices in one order" in docs/design/entry-symmetry.md): by name,
// numbers by value, any case, then by instance id; the page's own source key only last. The same devices seen from two engines (each names itself
// 'local' and the other 'remote:<n>') come out in the same order. Also the shared "Create on" key (public/js/page-state.js): an instance id on the
// server, this page's source key on each page, this machine's too.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-device-order-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'device-order.mjs')).href);
const T = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';

test('by name, numbers by value, any case; the order of the input does not matter', async () => {
  const { orderDevices } = await load();
  const names = list => orderDevices(list.map((name, index) => ({ key: `k${index}`, name }))).map(device => device.name);
  assert.deepEqual(names(['T01', 'K01']), ['K01', 'T01']);
  assert.deepEqual(names(['K01', 'T01']), ['K01', 'T01']);
  assert.deepEqual(names(['m10', 'M2', 'a']), ['a', 'M2', 'm10']);
  assert.deepEqual(names([' b', 'A']), ['A', ' b'], 'spaces around a name do not count');
  assert.deepEqual(orderDevices([]), []);
  assert.deepEqual(orderDevices(null), []);
});

test('the page of each engine lists the same devices in the same order, "this machine" has no place of its own', async () => {
  const { orderDevices } = await load();
  const fromT01 = [{ key: 'local', name: 'T01', instanceId: T }, { key: 'remote:7', name: 'K01', instanceId: K }, { key: 'remote:9', name: 'M05', instanceId: M }];
  const fromK01 = [{ key: 'local', name: 'K01', instanceId: K }, { key: 'remote:3', name: 'T01', instanceId: T }, { key: 'remote:4', name: 'M05', instanceId: M }];
  const ids = list => orderDevices(list).map(device => device.instanceId);
  assert.deepEqual(ids(fromT01), [K, M, T]);
  assert.deepEqual(ids(fromK01), [K, M, T]);
});

test('two devices with the same name: by instance id, so both pages agree; the source key only without one', async () => {
  const { orderDevices, compareDevices } = await load();
  const a = [{ key: 'local', name: 'Mac', instanceId: K }, { key: 'remote:2', name: 'mac', instanceId: T }];
  const b = [{ key: 'local', name: 'Mac', instanceId: T }, { key: 'remote:5', name: 'Mac', instanceId: K }];
  assert.deepEqual(orderDevices(a).map(device => device.instanceId), [T, K]);
  assert.deepEqual(orderDevices(b).map(device => device.instanceId), [T, K]);
  assert.ok(compareDevices({ name: 'X', key: 'local' }, { name: 'X', key: 'remote:1' }) < 0, 'no instance id: the key decides');
  assert.equal(compareDevices({ name: 'X', instanceId: T, key: 'a' }, { name: 'x', instanceId: T, key: 'a' }), 0);
});

test('a describe function maps other shapes (h5.js sources, Visible to rows)', async () => {
  const { orderDevices } = await load();
  const sources = [{ key: 'local', label: 'This machine', name: 'T01' }, { key: 'remote:7', label: 'K01' }];
  const named = orderDevices(sources, from => ({ name: from.key === 'local' ? from.name : from.label, key: from.key }));
  assert.deepEqual(named.map(from => from.key), ['remote:7', 'local']);
  const rows = [{ link_id: 'b', name: 'Zed' }, { link_id: 'a', name: 'Alpha' }];
  assert.deepEqual(orderDevices(rows, row => ({ name: row.name, key: row.link_id })).map(row => row.name), ['Alpha', 'Zed']);
});

test('"Create on" is shared by instance id, this machine\'s too, so no page reads "nothing chosen" as itself', () => {
  const { CODECS, MOVED } = require('../public/js/page-state.js');
  assert.ok(MOVED.includes('h5-create-on'));
  const codec = CODECS['h5-create-on'];
  const onT01 = [{ key: 'local', instanceId: T }, { key: 'remote:7', instanceId: K }];
  const onK01 = [{ key: 'local', instanceId: K }, { key: 'remote:3', instanceId: T }];
  const shared = codec.encode('local', onT01, undefined);
  assert.equal(shared, T, 'T01 chosen on the page of T01');
  assert.equal(codec.decode(shared, onK01), 'remote:3', 'is T01 on the page of K01');
  assert.equal(codec.decode(codec.encode('remote:7', onT01, undefined), onK01), 'local', 'K01 chosen on T01 is this machine on K01');
  assert.equal(codec.encode('remote:99', onT01, T), T, 'an unknown device keeps what was stored');
  assert.equal(codec.encode(null, onT01, T), null);
});
