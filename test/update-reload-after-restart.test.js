// Automatic refresh after an update: the on-disk version is already new before the restart, so the page must not refresh before the old process exits and must wait for the new process;
// it must also not depend on one particular poll hitting the outage, otherwise the page would wait forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

// versionBoot: the start ID of the current process before the update (null means an old service has none).
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
      // the real result of apply-update: 202 { accepted, status }
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
  context.runTick = async () => { assert.ok(tick, 'Polling did not start'); await tick(); };
  context.advance = ms => { clock += ms; };
  return context;
}

const restarting = bootId => ({ status: 'updating', stage: 'restarting', remote_version: '2.0.0', boot_id: bootId, log: [] });

test('Record the old process id from the real 202 response shape; do not refresh while the old process is still there, and refresh immediately once it is replaced by a new one (even if no outage was observed and the version does not match)', async () => {
  const ctx = setup({
    statusReplies: [restarting('old')],
    fetchReplies: [
      { app_version: '9.9.9', boot_id: 'old' }, // old process; the on-disk version is already the new one
      { app_version: '9.9.9', boot_id: 'old' },
      { app_version: '5.5.5', boot_id: 'new' }, // new process; refresh even when the version differs from the update target
    ],
  });
  await ctx.Updates.apply();
  assert.equal(ctx.Updates.updateBootId, 'old');
  await ctx.runTick(); // status shows restarting; enter the wait for the restart
  await ctx.runTick();
  await ctx.runTick();
  assert.equal(ctx.reloaded, false, 'Must not refresh while the old process is still there');
  await ctx.runTick();
  assert.equal(ctx.reloaded, true);
});

test('Fallback: with no process id and no outage observed, refresh on a successful response about 4 seconds after seeing “restarting”, and not before', async () => {
  const ctx = setup({
    versionBoot: null,
    statusReplies: [restarting(undefined)],
    fetchReplies: [{ app_version: '2.0.0' }, { app_version: '2.0.0' }],
  });
  await ctx.Updates.apply();
  await ctx.runTick();
  ctx.advance(1500);
  await ctx.runTick();
  assert.equal(ctx.reloaded, false, 'Right after seeing “restarting” the old process may still be there');
  ctx.advance(3000);
  await ctx.runTick();
  assert.equal(ctx.reloaded, true);
});

test('An old service has no process id: after an outage is observed, the next successful response refreshes', async () => {
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

test('A polled status that is not updating: the same process does not refresh, only a new process does', async () => {
  const ctx = setup({
    statusReplies: [
      { status: 'current', stage: null, boot_id: 'old', log: [] },
      { status: 'current', stage: null, boot_id: 'new', log: [] },
    ],
  });
  await ctx.Updates.apply();
  await ctx.runTick();
  assert.equal(ctx.pendingReload, undefined, 'The old process must not count as update finished');
  await ctx.runTick();
  assert.equal(typeof ctx.pendingReload, 'function');
  ctx.pendingReload();
  assert.equal(ctx.reloaded, true);
});

test('If 20 seconds pass without a refresh, the “Refresh now” button appears', async () => {
  const ctx = setup({ statusReplies: [restarting('old')], fetchReplies: [new Error('down'), new Error('down'), new Error('down')] });
  await ctx.Updates.apply();
  await ctx.runTick();
  assert.equal(ctx.document.querySelector('#update-progress-error button'), null);
  ctx.advance(21_000);
  await ctx.runTick();
  const button = ctx.document.querySelector('#update-progress-error button');
  assert.ok(button, 'The manual refresh button should appear');
  assert.equal(button.textContent, 'Refresh now');
});

test('Waiting for the restart does not throw even if the update dialog was closed', async () => {
  const ctx = setup({ statusReplies: [restarting('old')], fetchReplies: [{ app_version: '1', boot_id: 'new' }] });
  await ctx.Updates.apply();
  ctx.document.getElementById('update-progress-message').remove();
  await ctx.runTick();
  await ctx.runTick();
  assert.equal(ctx.reloaded, true);
});
