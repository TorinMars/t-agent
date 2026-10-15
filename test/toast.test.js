const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function setup() {
  const { document } = parseHTML('<!doctype html><body></body>');
  const timers = [];
  const alerts = [];
  const context = { document, alerts, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cancelled = true; }, alert: message => alerts.push(message) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('public/js/toast.js', 'utf8') + '\nthis.Toast = Toast; this.notify = notify;', context);
  context.timers = timers;
  return context;
}
const items = ctx => [...ctx.document.querySelectorAll('.toast')];

test('提示显示在固定定位的悬浮容器里，自动消失，点击可关闭', () => {
  const ctx = setup();
  const node = ctx.Toast.show('已复制', { type: 'success' });
  assert.equal(items(ctx).length, 1);
  assert.equal(node.className, 'toast toast-success');
  assert.equal(node.parentElement.className, 'toast-stack');
  assert.equal(ctx.timers.at(-1).ms, 2500);
  ctx.timers.at(-1).fn();
  assert.equal(items(ctx).length, 0, '到时间自动消失');
  const clicked = ctx.Toast.error('出错了');
  assert.equal(ctx.timers.at(-1).ms, 6000, '错误提示停留更久');
  clicked.dispatchEvent(new ctx.document.defaultView.Event('click'));
  assert.equal(items(ctx).length, 0, '点击立即关闭');
});

test('空消息被忽略；相同文字只重新计时，不重复堆叠；最多同时显示 4 条', () => {
  const ctx = setup();
  assert.equal(ctx.Toast.show('   '), null);
  assert.equal(ctx.Toast.show(undefined), null);
  assert.equal(items(ctx).length, 0);
  ctx.Toast.error('同一条'); ctx.Toast.error('同一条'); ctx.Toast.error('同一条');
  assert.equal(items(ctx).length, 1);
  for (let i = 0; i < 6; i += 1) ctx.Toast.show(`消息 ${i}`);
  assert.equal(items(ctx).length, 4);
  assert.equal(items(ctx).at(-1).textContent, '消息 5', '保留最新的');
});

test('文字按纯文本写入，不会被当成 HTML', () => {
  const ctx = setup();
  const node = ctx.Toast.show('<img src=x onerror=alert(1)>');
  assert.equal(node.children.length, 0);
  assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
});

test('notify：有 Toast 时用悬浮提示，没有时退回 alert', () => {
  const ctx = setup();
  ctx.notify('读取失败', 'error');
  assert.equal(items(ctx).length, 1);
  assert.deepEqual(ctx.alerts, []);
  // 没有 Toast 的环境：只取 toast.js 里真实的 notify 函数来执行。
  const source = fs.readFileSync('public/js/toast.js', 'utf8');
  const bare = { alert: message => bare.alerts.push(message), alerts: [] };
  vm.createContext(bare);
  vm.runInContext(source.slice(source.indexOf('function notify')) + "\nnotify('退回');", bare);
  assert.deepEqual(bare.alerts, ['退回']);
});
