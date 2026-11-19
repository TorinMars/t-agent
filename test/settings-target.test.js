// Which group and part of the settings sheet `ui.actions.openSettings(id)` opens (scripts/h5-shell/settings-target.mjs), including the group ids from
// before the sheet was tidied up. The real sheet is scripts/test-h5-settings-layout-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'settings-target.mjs')).href);

test('the new group ids open their group at the top', async () => {
  const { settingsTarget, SETTINGS_GROUPS } = await load();
  assert.deepEqual(SETTINGS_GROUPS, ['tasks-files', 'voice-translate', 'devices', 'attention', 'account', 'usage-data']);
  for (const group of SETTINGS_GROUPS) assert.deepEqual(settingsTarget(group), { group, section: '' });
});

test('the old group ids open the group and part that took their place', async () => {
  const { settingsTarget } = await load();
  const cases = {
    workdir: ['tasks-files', 'workdir'], oss: ['tasks-files', 'oss'],
    voice: ['voice-translate', 'voice'], translate: ['voice-translate', 'translate'],
    engines: ['devices', ''], 'service-links': ['devices', 'link'], 'rule-sync': ['devices', 'rule-sync'], remote: ['devices', 'remote'],
    access: ['account', 'access'], 'attention-skill': ['tasks-files', 'agent-skills'],
  };
  for (const [id, [group, section]] of Object.entries(cases)) assert.deepEqual(settingsTarget(id), { group, section }, id);
});

test('the parts of Devices that sit in Advanced are known, and unknown ids open nothing', async () => {
  const { settingsTarget, ADVANCED_SECTIONS } = await load();
  assert.deepEqual([...ADVANCED_SECTIONS].sort(), ['advanced', 'connect', 'remote']);
  for (const id of ['connect', 'advanced', 'link', 'peer-fs', 'authenticator']) assert.ok(settingsTarget(id), id);
  assert.deepEqual(settingsTarget('agent-skills'), { group: 'tasks-files', section: 'agent-skills' });
  assert.deepEqual(settingsTarget('browser-ext'), { group: 'tasks-files', section: 'browser-ext' });
  for (const id of ['', 'nothing', 'toString', '__proto__', null, undefined, 3, {}]) assert.equal(settingsTarget(id), null, String(id));
});

test('the group list of the Settings page has a title, a description and a phone summary for every group, translated', async () => {
  const { GROUPS, SETTINGS_GROUPS, groupInfo } = await load();
  assert.deepEqual(GROUPS.map(group => group.id), SETTINGS_GROUPS);
  assert.deepEqual(GROUPS.map(group => group.title), ['Tasks and files', 'Voice and translation', 'Devices', 'T-Attention', 'Account and access', 'Usage data']);
  const fs = require('node:fs');
  const zh = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n-zh-ui.js'), 'utf8');
  for (const group of GROUPS) {
    for (const key of ['title', 'description', 'summary']) {
      assert.equal(typeof group[key], 'string');
      assert.ok(group[key].length > 0 && group[key].length <= 100, `${group.id}.${key} is one short line`);
      if (group[key] !== 'T-Attention') assert.ok(zh.includes(`${JSON.stringify(group[key])}:`), `${group.id}.${key} has a Chinese entry`); // the product name stays
    }
    assert.equal(groupInfo(group.id), group);
  }
  assert.equal(groupInfo('nope'), null);
});
