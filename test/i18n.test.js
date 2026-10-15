const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const JS = path.join(__dirname, '..', 'public', 'js');
const HAN = /[一-鿿]/;

// 在没有 DOM 的沙箱里加载引擎和词典；stored 是 localStorage 里已保存的语言。
function load(stored = null) {
  const sandbox = { localStorage: { getItem: () => stored, setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-en-shell.js', 'i18n-en-tools.js']) vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox);
  return sandbox.I18n;
}

test('defaults to English and only switches to Chinese when stored', () => {
  assert.equal(load().get(), 'en');
  assert.equal(load('fr').get(), 'en');
  assert.equal(load('zh').get(), 'zh');
});

test('Chinese mode leaves every string untouched', () => {
  assert.equal(load('zh').t('保存'), '保存');
});

test('translates exact strings, keeps surrounding whitespace and passes non-Chinese text through', () => {
  const I18n = load();
  assert.equal(I18n.t('保存'), 'Save');
  assert.equal(I18n.t('\n  取消 '), '\n  Cancel ');
  assert.equal(I18n.t('already english 123'), 'already english 123');
  assert.equal(I18n.t(42), 42);
});

test('patterns and phrase replacement handle interpolated text', () => {
  const I18n = load();
  assert.equal(I18n.t('已保存 DESIGN.md'), 'Saved DESIGN.md');
  assert.equal(I18n.t('删除失败：boom'), 'Delete failed: boom');
  assert.equal(I18n.t('确定停止 api？'), 'Stop api?');
  assert.equal(I18n.t('5 分钟'), '5 min');
  assert.equal(I18n.t('\r\n\x1b[33m[连接已断开，3s 后自动重连...]\x1b[0m\r\n').includes('reconnecting in 3s'), true);
});

test('unknown Chinese is shown unchanged rather than dropped', () => {
  assert.equal(load().t('完全没收录的句子'), '完全没收录的句子');
});

test('longer phrases win over shorter ones inside a sentence', () => {
  const I18n = load();
  assert.equal(I18n.t('默认分组'), 'Default group');
  assert.match(I18n.t('读取翻译设置失败：x'), /^Could not read translation settings: x$/);
});

for (const page of ['index.html', 'login.html']) {
  test(`${page}: every static label has an English translation`, () => {
    const I18n = load();
    const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8'));
    const missing = [];
    const check = text => { const value = text.trim(); if (HAN.test(value) && HAN.test(I18n.t(value))) missing.push(value); };
    const walk = node => {
      if (node.nodeType === 3) { if (!['SCRIPT', 'STYLE'].includes(node.parentNode.nodeName)) check(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      for (const name of ['title', 'placeholder', 'aria-label', 'data-tip', 'alt']) if (node.getAttribute(name)) check(node.getAttribute(name));
      node.childNodes.forEach(walk);
    };
    walk(document.documentElement);
    assert.deepEqual(missing, []);
  });
}

test('pages load the i18n engine before other scripts and expose a language toggle', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(index.indexOf('/js/i18n.js') > 0 && index.indexOf('/js/i18n.js') < index.indexOf('/js/toast.js'));
  assert.ok(index.indexOf('/js/i18n-en-shell.js') < index.indexOf('/js/app.js'));
  assert.match(index, /data-lang-toggle/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8'), /data-lang-toggle/);
});
