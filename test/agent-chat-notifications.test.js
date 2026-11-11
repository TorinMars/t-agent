// public/js/agent-chat.js shows no system (browser / OS) notifications: a turn that ends while the page is hidden creates no Notification,
// the page never asks for the notification permission, and it does not listen to the service worker for notification clicks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ hidden = false, permission = 'default' } = {}) {
  const counts = { constructed: 0, requested: 0, shown: 0, swListeners: 0, containerListeners: 0 };
  const document = { hidden, currentScript: null, hasFocus: () => !hidden };
  let mounted;
  const serviceWorker = {
    addEventListener() { counts.swListeners += 1; },
    getRegistration: async () => ({ showNotification() { counts.shown += 1; } }),
    ready: Promise.resolve({ showNotification() { counts.shown += 1; } }),
  };
  const context = {
    document, navigator: { serviceWorker }, location: { pathname: '/h5' },
    Notification: class {
      static permission = permission;
      static requestPermission() { counts.requested += 1; return Promise.resolve('granted'); }
      constructor() { counts.constructed += 1; }
    },
    AgentChatUI: { mount: (container, options) => { mounted = options; return { destroy() {}, focus() {} }; } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/agent-chat.js'), 'utf8') + '\nglobalThis.chat = AgentChat;', context);
  const container = { offsetParent: {}, addEventListener() { counts.containerListeners += 1; }, removeEventListener() {} };
  const view = context.chat.mount(container, { base: '/api/tasks/1/agent', conversation: { id: 'c1', agent: 'claude', title: 'Chat' } });
  return { context, counts, view, mounted: async () => { await tick(); return mounted; } };
}

test('a chat never asks for the notification permission and listens to no service worker message', async () => {
  const h = harness();
  const options = await h.mounted();
  assert.ok(options, 'the view was mounted');
  assert.equal(h.counts.requested, 0, 'Notification.requestPermission is never called');
  assert.equal(h.counts.containerListeners, 0, 'no gesture listener waits to ask for the permission');
  assert.equal(h.counts.swListeners, 0, 'no notification click comes from the service worker');
  assert.equal(options.onTurn, undefined, 'the host gets no turn hook for notifications');
  assert.equal(h.context.chat.setOpenHandler, undefined, 'there is no notification click handler to set');
  h.view.destroy();
});

test('a turn that ends while the page is hidden creates no Notification', async () => {
  const h = harness({ hidden: true, permission: 'granted' });
  const options = await h.mounted();
  // The view reports a finished turn through any hook the page gave it; none of them may make a notification.
  for (const hook of ['onTurn', 'onTitle', 'notify']) if (typeof options[hook] === 'function') options[hook]({ ok: true, summary: 'Finished work', title: 'Chat' });
  await tick();
  await tick();
  assert.deepEqual([h.counts.constructed, h.counts.shown, h.counts.requested], [0, 0, 0]);
});
