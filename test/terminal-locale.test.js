const test = require('node:test');
const assert = require('node:assert/strict');
const { pickUtf8Locale, utf8LocaleEnv } = require('../lib/terminal-locale');

test('prefers C.UTF-8, then en_US, then any installed UTF-8 locale', () => {
  assert.equal(pickUtf8Locale({}, ['C', 'POSIX', 'en_US.UTF-8', 'C.UTF-8']), 'C.UTF-8');
  assert.equal(pickUtf8Locale({}, ['C', 'en_US.UTF-8', 'zh_CN.UTF-8']), 'en_US.UTF-8');
  assert.equal(pickUtf8Locale({}, ['C', 'de_DE.UTF-8']), 'de_DE.UTF-8');
});

test('matches locale names written as utf8 and keeps the installed spelling', () => {
  assert.equal(pickUtf8Locale({}, ['C', 'C.utf8']), 'C.utf8');
  assert.equal(pickUtf8Locale({}, ['en_US.utf8']), 'en_US.utf8');
});

test('keeps the inherited UTF-8 locale when it is installed, ignores it when it is not', () => {
  assert.equal(pickUtf8Locale({ LANG: 'zh_CN.UTF-8' }, ['C.UTF-8', 'zh_CN.UTF-8']), 'zh_CN.UTF-8');
  assert.equal(pickUtf8Locale({ LANG: 'zh_CN.UTF-8' }, ['C.UTF-8']), 'C.UTF-8');
  assert.equal(pickUtf8Locale({ LANG: 'C' }, ['C', 'en_US.UTF-8']), 'en_US.UTF-8');
});

test('falls back by platform when locales cannot be listed', () => {
  assert.equal(pickUtf8Locale({}, [], 'darwin'), 'en_US.UTF-8');
  assert.equal(pickUtf8Locale({}, [], 'linux'), 'C.UTF-8');
  assert.equal(pickUtf8Locale({ LANG: 'en_US.UTF-8' }, [], 'linux'), 'en_US.UTF-8');
});

test('sets LANG, LC_ALL and LC_CTYPE together so an inherited LC_ALL=C cannot win', () => {
  assert.deepEqual(utf8LocaleEnv({ LC_ALL: 'C' }, ['C', 'en_US.UTF-8'], 'linux'),
    { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' });
});
