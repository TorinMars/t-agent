// 更新后的自动刷新：磁盘上的版本号在重启前就已是新版本，所以旧进程退出前不能刷新，必须等新进程起来。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function setup({ applyStatus, statusReplies = [], versionReplies = [] }) {
  const { document } = parseHTML(fs.readFileSync('public/index.html', 'utf8'));
  let tick = null;
  const context = {
    document, console, reloaded: false,
    clearInterval() { tick = null; },
    setInterval(fn) { tick = fn; return 1; },
    setTimeout(fn) { context.pendingReload = fn; return 1; },
    window: { location: { reload() { context.reloaded = true; } } },
    escapeHtml: value => String(value),
    Modal: { show(title, body) { document.getElementById('modal-title').textContent = title; document.getElementById('modal-body').innerHTML = body; }, hide() {} },
    fetch: async () => {
      const reply = versionReplies.shift();
      if (reply instanceof Error) throw reply;
      return { ok: reply.ok !== false, json: async () => reply };
    },
    API: {
      post: async () => applyStatus,
      get: async () => {
        const reply = statusReplies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('public/js/update-log.js', 'utf8') + '\nthis.UpdateLog=UpdateLog;', context);
  const source = fs.readFileSync('public/js/app.js', 'utf8');
  vm.runInContext(source.slice(source.indexOf('const Updates ='), source.indexOf('const ContextMenu =')) + '\nthis.Updates=Updates;', context);
  context.runTick = async () => { assert.ok(tick, '轮询没有启动'); await tick(); };
  return context;
}

const restarting = bootId => ({ status: 'updating', stage: 'restarting', remote_version: '2.0.0', boot_id: bootId, log: [] });

test('旧进程已经报告新版本号但还没退出：不刷新；换成新进程后才刷新', async () => {
  const ctx = setup({
    applyStatus: { status: 'updating', stage: 'installing', boot_id: 'old', log: [] },
    statusReplies: [restarting('old')],
    versionReplies: [
      { app_version: '2.0.0', boot_id: 'old' },
      new Error('ECONNREFUSED'),
      { ok: false },
      { app_version: '2.0.0', boot_id: 'new' },
    ],
  });
  await ctx.Updates.apply();
  await ctx.runTick(); // update-status 显示 restarting，转入等待重启
  await ctx.runTick(); // 旧进程，版本号已是新的
  assert.equal(ctx.reloaded, false, '旧进程还在时不能刷新');
  await ctx.runTick(); // 服务中断
  await ctx.runTick(); // 新进程还没就绪
  assert.equal(ctx.reloaded, false);
  await ctx.runTick(); // 新进程
  assert.equal(ctx.reloaded, true);
});

test('轮询到的状态不是 updating：同一进程不刷新，新进程才刷新', async () => {
  const ctx = setup({
    applyStatus: { status: 'updating', stage: 'installing', boot_id: 'old', log: [] },
    statusReplies: [
      { status: 'current', stage: null, boot_id: 'old', log: [] },
      { status: 'current', stage: null, boot_id: 'new', log: [] },
    ],
  });
  await ctx.Updates.apply();
  await ctx.runTick();
  assert.equal(ctx.pendingReload, undefined, '旧进程不能当作更新完成');
  await ctx.runTick();
  assert.equal(typeof ctx.pendingReload, 'function');
  ctx.pendingReload();
  assert.equal(ctx.reloaded, true);
});

test('旧版服务没有进程 ID 时，必须先观察到服务中断才刷新', async () => {
  const ctx = setup({
    applyStatus: { status: 'updating', stage: 'installing', log: [] },
    statusReplies: [{ status: 'updating', stage: 'restarting', remote_version: '2.0.0', log: [] }],
    versionReplies: [{ app_version: '2.0.0' }, new Error('down'), { app_version: '2.0.0', boot_id: 'new' }],
  });
  await ctx.Updates.apply();
  await ctx.runTick();
  await ctx.runTick();
  assert.equal(ctx.reloaded, false);
  await ctx.runTick();
  await ctx.runTick();
  assert.equal(ctx.reloaded, true);
});
