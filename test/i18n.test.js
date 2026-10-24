const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'public', 'js');
const HAN = /[\u4e00-\u9fff]/;
const DICTIONARIES = ['i18n-zh-ui.js', 'i18n-zh-server.js', 'i18n-zh-extra.js'];

// Load the engine and the Chinese dictionaries in a sandbox without a DOM; stored is the language saved in localStorage.
function load(stored = null) {
  const sandbox = { localStorage: { getItem: () => stored, setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', ...DICTIONARIES]) vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox);
  return sandbox.I18n;
}

test('defaults to English and only switches to Chinese when stored', () => {
  assert.equal(load().get(), 'en');
  assert.equal(load('fr').get(), 'en');
  assert.equal(load('zh').get(), 'zh');
});

test('English mode leaves every string untouched', () => {
  assert.equal(load().t('Save'), 'Save');
  assert.equal(load('en').t('Saved README.md'), 'Saved README.md');
});

test('Chinese mode translates exact strings and keeps surrounding whitespace', () => {
  const I18n = load('zh');
  assert.equal(I18n.t('Save'), '保存');
  assert.equal(I18n.t('\n  Cancel '), '\n  取消 ');
  assert.equal(I18n.t('already translated 123'), 'already translated 123');
  assert.equal(I18n.t(42), 42);
});

test('placeholders keep the variable part and translate it when it is itself known', () => {
  const I18n = load('zh');
  assert.equal(I18n.t('Saved README.md'), '已保存 README.md');
  assert.equal(I18n.t('Stop api?'), '确定停止 api？');
  assert.equal(I18n.t('Update failed: Connection timed out'), `${I18n.t('Update failed')}：${I18n.t('Connection timed out')}`);
  assert.ok(HAN.test(I18n.t('Update failed: Connection timed out')));
});

test('a prefix piece followed by a runtime message is translated, and the message is kept', () => {
  const I18n = load('zh');
  assert.equal(I18n.t('Could not save the document: boom'), '保存文档失败：boom');
});

test('templates with almost no fixed text only match numbers', () => {
  const I18n = load('zh');
  assert.equal(I18n.t('5s'), '5 秒');
  assert.equal(I18n.t('docs'), 'docs', 'an unrelated word ending in s must not be read as a duration');
  assert.equal(I18n.t('Delete task “Write docs”? The task record and its to-dos will be deleted.').includes('Write docs'), true);
});

test('segments joined with a middle dot are translated one by one', () => {
  const I18n = load('zh');
  assert.equal(I18n.t('Default engine · Unknown version'), `${I18n.t('Default engine')} · ${I18n.t('Unknown version')}`);
});

test('unknown text is shown unchanged rather than dropped', () => {
  assert.equal(load('zh').t('A sentence that is not in the dictionary'), 'A sentence that is not in the dictionary');
});

for (const page of ['index.html', 'h5.html', 'login.html', path.join('tools', 'kwai-url-parser.html')]) {
  test(`${page}: every static label has a Chinese translation`, () => {
    const I18n = load('zh');
    const { document } = parseHTML(fs.readFileSync(path.join(ROOT, 'public', page), 'utf8'));
    // Names of keys, products, files and commands are the same in both languages.
    const SAME = /^(T-Agent|Tasks|Claude Code|Codex|Esc|Tab|Ctrl|Shift|Alt|Enter|Backspace|Command ⌘|Option ⌥|Option \+ ↑|Arrow(Left|Right|Up|Down)|\ud83d[\udcd8\udd16].*|root|Torin.s Tasks|https?:\/\/.*|app\.example\.com|frps Token|TAFS1:.*|.*\.md|[a-z_]+)$/;
    const missing = [];
    const check = text => {
      const value = text.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]{3}/.test(value) && !SAME.test(value) && I18n.t(value) === value) missing.push(value);
    };
    const walk = node => {
      if (node.nodeType === 3) { if (!['SCRIPT', 'STYLE', 'CODE'].includes(node.parentNode.nodeName)) check(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      for (const name of ['title', 'placeholder', 'aria-label', 'data-tip', 'alt']) if (node.getAttribute(name)) check(node.getAttribute(name));
      node.childNodes.forEach(walk);
    };
    walk(document.documentElement);
    assert.deepEqual([...new Set(missing)], []);
  });
}

test('pages load the engine before other scripts and expose a language toggle', () => {
  const index = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(index.indexOf('/js/i18n.js') > 0 && index.indexOf('/js/i18n.js') < index.indexOf('/js/toast.js'));
  assert.ok(index.indexOf('/js/i18n-zh-ui.js') < index.indexOf('/js/app.js'));
  assert.match(index, /data-lang-toggle/);
  assert.match(fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8'), /data-lang-toggle/);
  const h5 = fs.readFileSync(path.join(ROOT, 'public', 'h5.html'), 'utf8');
  assert.ok(h5.indexOf('/js/i18n.js') > 0 && h5.indexOf('/js/i18n-zh-ui.js') < h5.indexOf('/js/h5.js'));
  assert.match(h5, /data-lang-toggle/);
});

// The project source is English. Chinese text may only appear in the translation dictionaries and in a few fixtures that
// exist precisely to prove that Chinese user content (translator input, terminal output, file names) is handled.
const CJK_ALLOWED = new Set([
  'public/js/i18n-zh-ui.js', 'public/js/i18n-zh-server.js', 'public/js/i18n-zh-extra.js', 'test/i18n.test.js',
  'test/translator.test.js', 'test/terminal-clipboard.test.js', 'test/terminal-snapshot.test.js', 'test/install-script.test.js',
  'scripts/test-terminal-clipboard-browser.cjs', 'scripts/test-terminal-selection-browser.cjs', 'scripts/test-terminal-translate-browser.cjs', 'scripts/test-terminal-width-browser.cjs',
]);
function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'logs', 'tasks', 'vendor'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(js|cjs|html|css|sh|py|sql|md|json|yml|yaml|svg|example)$/.test(entry.name) && entry.name !== 'package-lock.json') out.push(full);
  }
  return out;
}
test('source files, comments and docs are English (Chinese only in dictionaries and CJK-handling fixtures)', () => {
  const offenders = [];
  for (const file of sourceFiles(ROOT)) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (CJK_ALLOWED.has(relative) || relative === 'public/js/markdown-view.js') continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => { if (HAN.test(line)) offenders.push(`${relative}:${index + 1}`); });
  }
  assert.deepEqual(offenders.slice(0, 20), []);
});
