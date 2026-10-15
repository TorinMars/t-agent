// 更新后的自动刷新：磁盘上的版本号在重启前就已是新版本，所以旧进程退出前不能刷新，必须等新进程起来；
// 同时不能依赖某次轮询恰好撞上服务中断，否则页面会一直等下去。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

// versionBoot：更新前当前进程的启动 ID（null 表示旧版服务没有）。
function setup({ versionBoot = 'old', statusReplies = [], fetchReplies = [], applyResponse } = {}) {
  const { document } = parseHTML(fs.readFileSync('public/index.html', 'utf8'));
  let tick = null;
  let clock = 1_000_000;
  const context = {
    document, console, reloaded: false,
    Date: { now: () => clock },
    clearInterval() { tick = null; },
    setInterval(fn) { tick = fn; return 1; },
    setTimeout(fn) { context.pendingReload = fn; return 1; },
    window: { location: { reload() { context.reloaded = true; } } },
    escapeHtml: value => String(value),
    Modal: { show(title, body) { document.getElementById('modal-title').textContent = title; document.getElementById('modal-body').innerHTML = body; }, hide() {} },
    fetch: async () => {
      const reply = fetchReplies.shift();
      if (reply instanceof Error) throw reply;
      return { ok: reply.ok !== false, json: async () => reply };
    },
    API: {
      // apply-update 的真实返回：202 { accepted, status }
      post: async () => applyResponse || { accepted: true, status: { status: 'updating', stage: 'installing', boot_id: versionBoot || undefined, log: [] } },
      get: async url => {
        if (url === '/api/system/version') return { app_version: '1.0.0', boot_id: versionBoot || undefined };
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
  context.advance = ms => { clock += ms; };
  return context;
}

const restarting = bootId => ({ status: 'updating', stage: 'restarting', remote_version: '2.0.0', boot_id: bootId, log: [] });

test('按真实的 202 返回结构记下旧进程 ID；旧进程还在时不刷新，换成新进程后立刻刷新（即使没观察到服务中断、版本号也对不上）', async () => {
  const ctx = setup({
    statusReplies: [restarting('old')],
    fetchReplies: [
      { app_version: '9.9.9', boot_id: 'old' }, // 旧进程，磁盘版本号已是新的
      { app_version: '9.9.9', boot_id: 'old' },
      { app_version: '5.5.5', boot_id: 'new' }, // 新进程；版本号和更新目标不同也照样刷新
    ],
  });
  await ctx.Updates.apply();
  assert.equal(ctx.Updates.updateBootId, 'old');
  await ctx.runTick(); // 状态显示 restarting，转入等待重启
  await ctx.runTick();
  await ctx.runTick();
  assert.equal(ctx.reloaded, false, '旧进程还在时不能刷新');
  await ctx.runTick();
  assert.equal(ctx.reloaded, true);
});

test('兜底：没有进程 ID、也没撞上服务中断时，看到“正在重启”约 4 秒后的成功响应就刷新，之前不刷新', async () => {
  const ctx = setup({
    versionBoot: null,
    statusReplies: [restarting(undefined)],
    fetchReplies: [{ app_version: '2.0.0' }, { app_version: '2.0.0' }],
  });
  await ctx.Updates.apply();
  await ctx.runTick();
  ctx.advance(1500);
  await ctx.runTick();
  assert.equal(ctx.reloaded, false, '刚看到“正在重启”时旧进程可能还在');
  ctx.advance(3000);
  await ctx.runTick();
  assert.equal(ctx.reloaded, true);
});

test('旧版服务没有进程 ID：观察到服务中断后，下一次成功响应就刷新', async () => {
  const ctx = setup({
    versionBoot: null,
    statusReplies: [restarting(undefined)],
    fetchReplies: [{ app_version: '2.0.0' }, new Error('down'), { app_version: '2.0.0', boot_id: 'new' }],
  });
  await ctx.Updates.apply();
  await ctx.runTick();
  await ctx.runTick();
  assert.equal(ctx.reloaded, false);
  await ctx.runTick();
  await ctx.runTick();
  assert.equal(ctx.reloaded, true);
});

test('轮询到的状态不是 updating：同一进程不刷新，新进程才刷新', async () => {
  const ctx = setup({
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

test('等了 20 秒仍没刷新时出现“立即刷新页面”按钮', async () => {
  const ctx = setup({ statusReplies: [restarting('old')], fetchReplies: [new Error('down'), new Error('down'), new Error('down')] });
  await ctx.Updates.apply();
  await ctx.runTick();
  assert.equal(ctx.document.querySelector('#update-progress-error button'), null);
  ctx.advance(21_000);
  await ctx.runTick();
  const button = ctx.document.querySelector('#update-progress-error button');
  assert.ok(button, '应该出现手动刷新按钮');
  assert.equal(button.textContent, '立即刷新页面');
});

test('更新提示框被关掉后等待重启也不会抛错', async () => {
  const ctx = setup({ statusReplies: [restarting('old')], fetchReplies: [{ app_version: '1', boot_id: 'new' }] });
  await ctx.Updates.apply();
  ctx.document.getElementById('update-progress-message').remove();
  await ctx.runTick();
  await ctx.runTick();
  assert.equal(ctx.reloaded, true);
});
