const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { logUpdate, recentLog, clearLog } = require('../lib/update-command');

test('更新日志：按行记录、隐藏凭据、只保留最近的行，开始新一轮前可清空', () => {
  const original = console.log;
  console.log = () => {};
  try {
    clearLog();
    logUpdate('installing', 'stdout: added 1 package\nstdout: https://user:secret@example.com/x');
    const lines = recentLog();
    assert.equal(lines.length, 2);
    assert.equal(lines[0].stage, 'installing');
    assert.match(lines[1].text, /\[redacted\]@/);
    assert.doesNotMatch(JSON.stringify(lines), /secret/);
    for (let index = 0; index < 400; index += 1) logUpdate('x', `line ${index}`);
    const kept = recentLog();
    assert.equal(kept.length, 300);
    assert.equal(kept[kept.length - 1].text, 'line 399');
    clearLog();
    assert.deepEqual(recentLog(), []);
  } finally { console.log = original; }
});

test('终端式日志：渲染时间和文本，内容没变不重绘，贴底时跟随滚动，向上翻看时不拉回底部', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync('public/js/update-log.js', 'utf8')}\nthis.UpdateLog = UpdateLog;`, context);
  const node = { dataset: {}, textContent: '', scrollTop: 0, clientHeight: 100, scrollHeight: 100 };
  let writes = 0;
  let text = '';
  Object.defineProperty(node, 'textContent', { get: () => text, set: value => { text = value; writes += 1; node.scrollHeight = 500; } });
  const lines = [{ at: '2026-10-13T08:00:00.000Z', text: 'npm ci' }, { at: '2026-10-13T08:00:01.000Z', text: 'added 5 packages' }];
  context.UpdateLog.render(node, lines);
  assert.match(text, /^\d\d:\d\d:\d\d npm ci\n\d\d:\d\d:\d\d added 5 packages$/);
  assert.equal(node.scrollTop, 500);
  context.UpdateLog.render(node, lines);
  assert.equal(writes, 1);
  node.scrollTop = 0;
  context.UpdateLog.render(node, [...lines, { at: '2026-10-13T08:00:02.000Z', text: 'done' }]);
  assert.equal(writes, 2);
  assert.equal(node.scrollTop, 0);
  assert.equal(context.UpdateLog.headline('正在安装依赖 · 已用 4 秒 · npm warn deprecated'), '正在安装依赖 · 已用 4 秒');
  context.UpdateLog.render(null, lines);
  context.UpdateLog.render(node, undefined);
});
