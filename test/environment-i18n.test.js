const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'public', 'js');
// Names that read the same in both languages.
const SAME = new Set(['git', 'Shell', 'HTTPS', 'frpc', 'pm2', 'frpc X']);

function loadChinese() {
  const sandbox = { localStorage: { getItem: () => 'zh', setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-zh-ui.js', 'i18n-zh-server.js', 'i18n-zh-extra.js']) vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox);
  return sandbox.I18n;
}

// The texts the checks put in front of the person: the first argument of done(status, ...) and the name / description / fix / impact fields.
function userTexts(source) {
  const found = new Set();
  const take = (quote, body) => {
    // A text with a variable part is written with ${...}; at run time the variable is whatever it holds, so a placeholder stands for it.
    const sample = body.replace(/\$\{[^}]*\}/g, 'X');
    if (/[A-Za-z]{2}/.test(sample.replace(/X/g, ''))) found.add(sample);
  };
  for (const match of source.matchAll(/done\(\s*(?:'(?:ok|warn|fail|info)'|status|worst)\s*,\s*(['`])((?:\\.|(?!\1).)*)\1/g)) take(match[1], match[2]);
  for (const match of source.matchAll(/\b(?:name|description|fix|impact):\s*(['`])((?:\\.|(?!\1).)*)\1/g)) take(match[1], match[2]);
  return [...found].map(text => text.replace(/\\'/g, "'"));
}

test('every text of the environment checks has a Chinese translation', () => {
  const I18n = loadChinese();
  const texts = userTexts(fs.readFileSync(path.join(ROOT, 'services', 'environment-check.js'), 'utf8'));
  assert.ok(texts.length > 100, `found ${texts.length} texts to look at`);
  // Sentences the checks choose between with a condition, which the scan above does not see.
  texts.push('Claude Code starts and is logged in (Pro)', 'The clock is 300 seconds ahead of the servers', 'The clock is 300 seconds behind the servers', 'The Codex app server starts and is logged in with an API key');
  const missing = texts.filter(text => !SAME.has(text) && I18n.t(text) === text);
  assert.deepEqual(missing, [], 'add these to public/js/i18n-zh-server.js');
});

test('the texts of the environment page have a Chinese translation too', () => {
  const I18n = loadChinese();
  const source = fs.readFileSync(path.join(JS, 'environment-check.js'), 'utf8');
  const texts = [
    ...[...source.matchAll(/(?:WORD = \{|ICON = \{)[^}]*\}/g)].flatMap(match => [...match[0].matchAll(/'([A-Za-z ]+)'/g)].map(item => item[1])),
    'Affects:', 'What to do:', 'What will not work', 'What may not work', 'Everything checked works', 'The check could not be run', 'Checking…', 'Checking this machine…', 'Check again',
    '1 feature will not work', '3 features will not work', '1 feature needs attention', '2 features need attention', '1 will not work · 1 need attention · 2 fine',
    'Darwin 22.6.0 · Node v24.22.0 · x64 · user torin · checked 6:00:00 PM', 'This page checks the machine running the Client, not the remote engine Shanghai',
  ].filter(text => !/^[✕!✓–]$/.test(text));
  assert.deepEqual(texts.filter(text => I18n.t(text) === text), []);
});
