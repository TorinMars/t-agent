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

test('The notice is shown in a fixed-position floating container, disappears on its own and can be dismissed by clicking', () => {
  const ctx = setup();
  const node = ctx.Toast.show('Copied', { type: 'success' });
  assert.equal(items(ctx).length, 1);
  assert.equal(node.className, 'toast toast-success');
  assert.equal(node.parentElement.className, 'toast-stack');
  assert.equal(ctx.timers.at(-1).ms, 2500);
  ctx.timers.at(-1).fn();
  assert.equal(items(ctx).length, 0, 'Disappears automatically when the time is up');
  const clicked = ctx.Toast.error('Something went wrong');
  assert.equal(ctx.timers.at(-1).ms, 6000, 'Error notices stay longer');
  clicked.dispatchEvent(new ctx.document.defaultView.Event('click'));
  assert.equal(items(ctx).length, 0, 'Click to dismiss immediately');
});

test('Empty messages are ignored; the same text only restarts the timer and does not stack; at most 4 are shown at once', () => {
  const ctx = setup();
  assert.equal(ctx.Toast.show('   '), null);
  assert.equal(ctx.Toast.show(undefined), null);
  assert.equal(items(ctx).length, 0);
  ctx.Toast.error('The same one'); ctx.Toast.error('The same one'); ctx.Toast.error('The same one');
  assert.equal(items(ctx).length, 1);
  for (let i = 0; i < 6; i += 1) ctx.Toast.show(`Message ${i}`);
  assert.equal(items(ctx).length, 4);
  assert.equal(items(ctx).at(-1).textContent, 'Message 5', 'Keep the newest');
});

test('Text is written as plain text and never treated as HTML', () => {
  const ctx = setup();
  const node = ctx.Toast.show('<img src=x onerror=alert(1)>');
  assert.equal(node.children.length, 0);
  assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
});

test('notify: uses the floating notice when a Toast exists and falls back to alert otherwise', () => {
  const ctx = setup();
  ctx.notify('Read failed', 'error');
  assert.equal(items(ctx).length, 1);
  assert.deepEqual(ctx.alerts, []);
  // An environment without Toast: take only the real notify function from toast.js and run it.
  const source = fs.readFileSync('public/js/toast.js', 'utf8');
  const bare = { alert: message => bare.alerts.push(message), alerts: [] };
  vm.createContext(bare);
  vm.runInContext(source.slice(source.indexOf('function notify')) + "\nnotify('fallback');", bare);
  assert.deepEqual(bare.alerts, ['fallback']);
});
