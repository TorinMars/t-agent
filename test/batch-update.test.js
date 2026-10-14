// 侧栏“一键更新全部”：先升级所有远程引擎，最后才更新本机；失败/已最新的引擎不会触发更新。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(path.join(__dirname, '../public/js/batch-update.js'), 'utf8');

function load({ servers, statuses, local }) {
  const { document } = parseHTML('<button id="btn-batch-update"></button><div id="modal"></div>');
  const calls = [];
  const polled = {};
  const context = {
    document, window: {}, confirm: () => true, setTimeout: fn => { fn(); return 0; },
    escapeHtml: value => String(value),
    Modal: { show: (title, html) => { context.lastModal = html; }, hide() {} },
    Tasks: { disposeSourceTerminals() {} },
    Updates: { errorLabel: code => code, statusLabel: status => status, apply: async () => { calls.push('local-apply'); } },
    API: {
      get: async url => {
        if (url === '/api/remote-servers') return servers;
        const id = url.split('/')[3];
        polled[id] = (polled[id] || 0) + 1;
        return { status: 'current', local_version: statuses[id].remote_version };
      },
      post: async url => {
        calls.push(url);
        if (url === '/api/system/check-update') return local;
        if (url.endsWith('/check-update')) return statuses[url.split('/')[3]];
        return { accepted: true };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.BatchUpdate = BatchUpdate;`, context);
  return { context, calls };
}

test('先升级每个有新版本的引擎，已最新的跳过，本机最后更新', async () => {
  const { context, calls } = load({
    servers: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
    statuses: { 1: { status: 'available', local_version: '2.48.0', remote_version: '2.49.0' }, 2: { status: 'current', local_version: '2.49.0', remote_version: '2.49.0' } },
    local: { status: 'available', is_update_admin: true },
  });
  await context.BatchUpdate.run();
  assert.ok(calls.includes('/api/remote-servers/1/apply-update'));
  assert.ok(!calls.includes('/api/remote-servers/2/apply-update'));
  assert.equal(calls[calls.length - 1], 'local-apply');
  assert.ok(calls.indexOf('/api/remote-servers/1/apply-update') < calls.indexOf('local-apply'));
});

test('本机已是最新时只汇总结果，不触发本机更新', async () => {
  const { context, calls } = load({
    servers: [{ id: 1, name: 'A' }],
    statuses: { 1: { status: 'blocked', message: 'x' } },
    local: { status: 'current', local_version: '2.49.0' },
  });
  await context.BatchUpdate.run();
  assert.ok(!calls.includes('local-apply'));
  assert.match(context.lastModal, /已是最新 2\.49\.0/);
});
