// The model behind the tabs at the top of the settings sheet (scripts/h5-shell/settings-tabs.mjs): which part is in which tab, which group has anything
// in a tab, the tab a part opened from code needs, the tab entries, the remembered choice and when a scope pill says nothing new. The real sheet is
// scripts/test-h5-settings-tabs-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', file)).href);
const DEVICES = [
  { id: 7, name: 'K01', online: true, supported: true },
  { id: 9, name: 'Old Mac', online: true, supported: false },
  { id: 11, name: 'Away', online: false, supported: null },
  { id: 12, name: 'Sleeping', online: false, supported: true },
];

test('each tab holds exactly its parts: Shared the shared ones and Telegram, a device tab the per-device ones', async () => {
  const { PARTS, partShown } = await load('settings-tabs.mjs');
  const inTab = scope => Object.keys(PARTS).filter(id => partShown(id, scope));
  assert.deepEqual(inTab('shared'), ['oss', 'browser-sites', 'voice', 'translate', 'settings-sync', 'task-list-devices', 'notifier-plugins', 'telegram', 'notify-rules', 'widget-language', 'attention-summary']);
  assert.deepEqual(inTab('device'), ['workdir', 'agent-skills', 'browser-ext', 'engine-name', 'link', 'peer-fs', 'rule-sync', 'advanced', 'connect', 'remote', 'attention-guide', 'reminders', 'listeners', 'plugin-market', 'widget-enabled', 'attention-skill', 'cli-tokens', 'access', 'authenticator']);
  assert.equal(inTab(null).length, Object.keys(PARTS).length, 'without tabs every part is drawn');
  assert.equal(partShown('something-new', 'shared'), true, 'an unknown part is never lost');
});

test('a group with nothing in a tab is hidden there', async () => {
  const { groupShown } = await load('settings-tabs.mjs');
  const { SETTINGS_GROUPS } = await load('settings-target.mjs');
  assert.deepEqual(SETTINGS_GROUPS.filter(group => groupShown(group, 'shared')), ['tasks-files', 'voice-translate', 'devices', 'attention']);
  assert.deepEqual(SETTINGS_GROUPS.filter(group => groupShown(group, 'device')), ['tasks-files', 'devices', 'attention', 'account']);
  assert.deepEqual(SETTINGS_GROUPS.filter(group => groupShown(group, null)), SETTINGS_GROUPS);
});

test('opening a part from code moves to the tab that holds it; a group stays on the current tab when it can', async () => {
  const { tabForTarget, PARTS } = await load('settings-tabs.mjs');
  const { settingsTarget } = await load('settings-target.mjs');
  // Every part id and alias of settings-target.mjs has a tab.
  for (const id of ['workdir', 'oss', 'agent-skills', 'browser-ext', 'voice', 'translate', 'link', 'peer-fs', 'rule-sync', 'advanced', 'connect', 'remote', 'access', 'authenticator', 'service-links', 'attention-skill']) {
    const target = settingsTarget(id);
    assert.ok(Object.hasOwn(PARTS, target.section), `${id} has a part`);
  }
  const at = (id, current) => tabForTarget(settingsTarget(id), current);
  assert.equal(at('workdir', 'shared'), 'local');
  assert.equal(at('workdir', '7'), 'local', 'a per-device part opens on this device, whichever device was shown');
  assert.equal(at('oss', 'local'), 'shared');
  assert.equal(at('translate', '7'), 'shared');
  assert.equal(at('service-links', 'shared'), 'local');
  assert.equal(at('attention', '7'), '7', 'T-Attention has parts in every tab');
  assert.equal(at('attention', 'shared'), 'shared');
  assert.equal(at('account', 'shared'), 'local', 'Account has nothing shared');
  assert.equal(at('voice-translate', 'local'), 'shared', 'Voice and translation has nothing per device');
  assert.equal(at('devices', '7'), '7');
  assert.equal(at('workdir', null), null, 'without tabs nothing moves');
  assert.equal(tabForTarget(null, 'local'), 'local');
});

test('the remembered tab is kept while it means something, else Shared; a device that went away is forgotten', async () => {
  const { resolveTab } = await load('settings-tabs.mjs');
  assert.deepEqual(resolveTab(null, DEVICES), { tab: 'shared', forget: false }, 'Shared by default');
  assert.deepEqual(resolveTab('shared', DEVICES), { tab: 'shared', forget: false });
  assert.deepEqual(resolveTab('local', DEVICES), { tab: 'local', forget: false });
  assert.deepEqual(resolveTab('7', DEVICES), { tab: '7', forget: false });
  assert.deepEqual(resolveTab('12', DEVICES), { tab: '12', forget: false }, 'offline but with the feature: can be chosen');
  assert.deepEqual(resolveTab('9', DEVICES), { tab: 'shared', forget: false }, 'too old now: Shared, remembered for later');
  assert.deepEqual(resolveTab('11', DEVICES), { tab: 'shared', forget: false });
  assert.deepEqual(resolveTab('8', DEVICES), { tab: 'shared', forget: true }, 'no longer linked');
  for (const junk of ['', '7abc', '-7', '0', 'x']) assert.equal(resolveTab(junk, DEVICES).tab, 'shared', junk);
});

test('the tab entries: Shared, this device under its name, then each linked device with the reason when it cannot be chosen', async () => {
  const { tabEntries, deviceOfTab, tabHint } = await load('settings-tabs.mjs');
  const entries = tabEntries(DEVICES, { localName: 'T01' });
  assert.deepEqual(entries.map(entry => [entry.value, entry.label, entry.note, entry.disabled]), [
    ['shared', 'Shared', '', false], ['local', 'T01', 'This device', false], ['7', 'K01', '', false],
    ['9', 'Old Mac', 'Update Old Mac first', true], ['11', 'Away', 'Offline', true], ['12', 'Sleeping', 'Offline', false],
  ]);
  assert.equal(entries[3].title, 'Old Mac is too old to be changed from here. Update Old Mac first.');
  assert.equal(entries[5].title, 'Sleeping is offline. Its settings can be read and saved again once it is back online.');
  assert.deepEqual(tabEntries([], {}).map(entry => [entry.label, entry.note]), [['Shared', ''], ['This device', '']], 'an older server has no name');
  const shout = text => text.toUpperCase();
  assert.equal(tabEntries([], { t: shout })[0].label, 'SHARED', 'the words go through `t`');
  assert.equal(deviceOfTab('7', DEVICES).name, 'K01');
  assert.equal(deviceOfTab('9', DEVICES), null);
  assert.equal(deviceOfTab('shared', DEVICES), null);
  assert.equal(tabHint('shared', DEVICES), 'Changes here are copied to every linked device');
  assert.equal(tabHint('local', DEVICES), 'Only this device uses these settings');
  assert.equal(tabHint('7', DEVICES), 'These settings are read and saved on K01');
  assert.equal(tabHint('12', DEVICES), 'Sleeping is offline. Its settings can be read and saved again once it is back online.');
  assert.equal(tabHint(null, DEVICES), '');
});

test('a pill is left out only where it repeats the tab', async () => {
  const { labelRedundant, tabScope } = await load('settings-tabs.mjs');
  assert.equal(tabScope('shared'), 'shared');
  assert.equal(tabScope('local'), 'device');
  assert.equal(tabScope('7'), 'device');
  assert.equal(tabScope(null), null);
  assert.equal(labelRedundant({ scope: 'shared', tabScope: 'shared' }), true);
  assert.equal(labelRedundant({ scope: 'telegram', tabScope: 'shared' }), false, 'who sends Telegram is news');
  assert.equal(labelRedundant({ scope: 'device', tabScope: 'shared', follow: false }), false, 'the browser-local voice switch keeps its pill');
  assert.equal(labelRedundant({ scope: 'device', tabScope: 'device' }), true);
  assert.equal(labelRedundant({ scope: 'device', tabScope: 'device', remote: true }), true, '"K01 only" in the K01 tab');
  assert.equal(labelRedundant({ scope: 'device', tabScope: 'device', follow: false, remote: true }), false, '"This device only" in the K01 tab');
  assert.equal(labelRedundant({ scope: 'shared', tabScope: null }), false, 'without tabs every pill stays');
});

test('the choice is remembered per viewer; the old "Settings for" choice is read once; a storage that refuses is no error', async () => {
  const { readTab, writeTab, TAB_KEY } = await load('settings-tabs.mjs');
  const map = new Map();
  const storage = { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  assert.equal(readTab(storage), null);
  map.set('t-agent.settings-device', '7');
  assert.equal(readTab(storage), '7', 'the device chosen before the tabs');
  writeTab(storage, 'local');
  assert.equal(map.get(TAB_KEY), 'local');
  assert.equal(map.has('t-agent.settings-device'), false, 'the old entry is dropped');
  assert.equal(readTab(storage), 'local');
  writeTab(storage, null);
  assert.equal(map.has(TAB_KEY), false);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(readTab(broken), null);
  assert.doesNotThrow(() => writeTab(broken, '7'));
  assert.equal(readTab(null), null);
  assert.doesNotThrow(() => writeTab(null, '7'));
});

test('the Chinese texts exist for every text the tabs show', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const root = path.join(__dirname, '..', 'public', 'js');
  const sandbox = { localStorage: { getItem: () => 'zh', setItem() {} }, document: undefined };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'), sandbox);
  for (const file of ['i18n-zh-server.js', 'i18n-zh-extra.js', 'i18n-zh-ui.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  const { I18n } = sandbox;
  for (const text of ['Shared', 'This device', 'Settings for', 'Offline', 'Update K01 first', 'Changes here are copied to every linked device', 'Only this device uses these settings',
    'These settings are read and saved on K01', 'K01 is offline. Its settings can be read and saved again once it is back online.',
    'K01 is too old to be changed from here. Update K01 first.', 'Show K01 in task list', 'Which devices the task list shows. One choice for all linked devices.']) {
    assert.notEqual(I18n.t(text), text, `no translation for: ${text}`);
    assert.ok(I18n.t(text).includes('K01') || !text.includes('K01'), `the name stays: ${text}`);
  }
  assert.equal(I18n.t('Shared'), '\u5171\u4eab');
  assert.equal(I18n.t('This device'), '\u672c\u673a');
});
