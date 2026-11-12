// The model behind "Settings for" at the top of the settings sheet (scripts/h5-shell/device-target.mjs): which linked devices can be chosen, which
// device a remembered choice still means, the URL a per-device part calls, and the label and note texts. The real sheet is
// scripts/test-h5-device-settings-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'device-target.mjs')).href);
const answer = {
  devices: [
    { id: 7, name: 'K01', online: true, supported: true },
    { id: 9, name: 'Old Mac', online: true, supported: false },
    { id: 11, name: 'Away', online: false, supported: null },
    { id: 12, name: 'Sleeping', online: false, supported: true },
    { id: 0, name: 'bad id' }, { id: 3 }, null, 'junk',
  ],
};

test('the answer is cleaned: bad entries are dropped and `supported` is true, false or null', async () => {
  const { normalizeDevices } = await load();
  assert.deepEqual(normalizeDevices(answer), [
    { id: 7, name: 'K01', online: true, supported: true },
    { id: 9, name: 'Old Mac', online: true, supported: false },
    { id: 11, name: 'Away', online: false, supported: null },
    { id: 12, name: 'Sleeping', online: false, supported: true },
  ]);
  assert.deepEqual(normalizeDevices(null), [], 'an older server (404) has no devices');
  assert.deepEqual(normalizeDevices({ devices: 'x' }), []);
});

test('the selector shows only when a linked device has the feature; an older or unknown one cannot be chosen', async () => {
  const { normalizeDevices, selectable, selectorShown } = await load();
  const devices = normalizeDevices(answer);
  assert.equal(selectorShown(devices), true);
  assert.deepEqual(devices.filter(selectable).map(device => device.name), ['K01', 'Sleeping'], 'an offline device that has it can be chosen');
  assert.equal(selectorShown(devices.filter(device => !device.supported)), false, 'only older devices: no selector');
  assert.equal(selectorShown([]), false, 'a single machine: no selector');
});

test('a remembered choice stays only while that device is still linked and has the feature; otherwise this device', async () => {
  const { normalizeDevices, pickDevice } = await load();
  const devices = normalizeDevices(answer);
  assert.equal(pickDevice('7', devices).name, 'K01');
  assert.equal(pickDevice(7, devices).name, 'K01');
  assert.equal(pickDevice('9', devices), null, 'an older device');
  assert.equal(pickDevice('11', devices), null, 'not known to have it');
  assert.equal(pickDevice('8', devices), null, 'the device went away');
  assert.equal(pickDevice(null, devices), null);
  assert.equal(pickDevice('', devices), null);
  assert.equal(pickDevice('7abc', devices), null);
  assert.equal(pickDevice('-7', devices), null);
});

test('one place decides the URL: this device keeps the page path, a linked one goes through /api/device-settings/<id>', async () => {
  const { devicePath } = await load();
  const k01 = { id: 7, name: 'K01' };
  assert.equal(devicePath(null, '/api/peer-fs/settings'), '/api/peer-fs/settings');
  assert.equal(devicePath(null, '/auth/me'), '/auth/me');
  assert.equal(devicePath(k01, '/api/peer-fs/settings'), '/api/device-settings/7/peer-fs/settings');
  assert.equal(devicePath(k01, '/api/agent-skills/tcli/install'), '/api/device-settings/7/agent-skills/tcli/install');
  assert.equal(devicePath(k01, '/api/rule-sync'), '/api/device-settings/7/rule-sync');
  assert.equal(devicePath(k01, '/auth/me'), '/api/device-settings/7/auth/me');
  assert.equal(devicePath(k01, '/auth/settings'), '/api/device-settings/7/auth/settings');
  assert.equal(devicePath(k01, '/apiary/x'), '/api/device-settings/7/apiary/x', 'only a whole /api segment is taken off');
});

test('option, label and note texts name the device', async () => {
  const { optionText, deviceScopeText, deviceScopeTitle, ownPageText } = await load();
  assert.equal(optionText(null), 'This device');
  assert.equal(optionText({ id: 7, name: 'K01', online: true, supported: true }), 'K01');
  assert.equal(optionText({ id: 12, name: 'Sleeping', online: false, supported: true }), 'Sleeping (Offline)');
  assert.equal(optionText({ id: 9, name: 'Old Mac', online: true, supported: false }), 'Old Mac (Update Old Mac first)');
  assert.equal(optionText({ id: 11, name: 'Away', online: false, supported: null }), 'Away (Offline)');
  const shout = text => text.toUpperCase();
  assert.equal(optionText(null, { t: shout }), 'THIS DEVICE', 'the words go through `t`');
  assert.equal(deviceScopeText('K01'), 'K01 only');
  assert.equal(deviceScopeText(''), 'This device only');
  assert.equal(deviceScopeTitle('K01'), 'Only K01 uses this. Changes here are saved on K01.');
  assert.equal(deviceScopeTitle(''), 'Only this device uses this');
  assert.equal(ownPageText('K01'), 'Open K01’s own page to change this');
});

test('the choice is remembered per viewer, and a storage that refuses or is missing is no error', async () => {
  const { readStored, writeStored, STORAGE_KEY } = await load();
  const map = new Map();
  const storage = { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  writeStored(storage, 7);
  assert.equal(map.get(STORAGE_KEY), '7');
  assert.equal(readStored(storage), '7');
  writeStored(storage, null);
  assert.equal(map.has(STORAGE_KEY), false, 'this device is no entry');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(readStored(broken), null);
  assert.doesNotThrow(() => writeStored(broken, 7));
  assert.equal(readStored(null), null);
  assert.doesNotThrow(() => writeStored(null, 7));
});

test('the Chinese texts exist for every template the model builds', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const root = path.join(__dirname, '..', 'public', 'js');
  const sandbox = { localStorage: { getItem: () => 'zh', setItem() {} }, document: undefined };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'), sandbox);
  for (const file of ['i18n-zh-server.js', 'i18n-zh-extra.js', 'i18n-zh-ui.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  const { I18n } = sandbox;
  for (const text of ['K01 only', 'Update K01 first', 'Only K01 uses this. Changes here are saved on K01.', 'Open K01’s own page to change this', 'Settings for', 'This device',
    'Parts marked “K01 only” are read and saved on K01. Shared parts are the same on every device.', 'DEVICE_SETTING_NOT_ALLOWED', 'DEVICE_SETTINGS_UNSUPPORTED', 'DEVICE_NOT_LINKED']) {
    assert.notEqual(I18n.t(text), text, `no translation for: ${text}`);
    assert.ok(I18n.t(text).includes('K01') || !text.includes('K01'), `the name stays: ${text}`);
  }
  for (const text of ['Local access only', 'Plan only', 'This page only', 'This device only']) assert.equal(I18n.t(text).includes('{'), false, text);
});
