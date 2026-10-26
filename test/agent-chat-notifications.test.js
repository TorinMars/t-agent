const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ hidden = false, focused = true, chatVisible = true, serviceWorker } = {}) {
  const notes = [];
  const document = { hidden, currentScript: null, hasFocus: () => focused };
  let onTurn;
  const context = {
    document, navigator: serviceWorker ? { serviceWorker } : {}, location: { pathname: '/h5' },
    Notification: class { static permission = 'granted'; constructor(title, options) { notes.push({ title, options }); } },
    AgentChatUI: { mount: (container, options) => { onTurn = options.onTurn; return { destroy() {} }; } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/agent-chat.js'), 'utf8') + '\nglobalThis.chat = AgentChat;', context);
  const container = { offsetParent: chatVisible ? {} : null, addEventListener() {}, removeEventListener() {} };
  context.chat.mount(container, { base: '/api/tasks/1/agent', conversation: { id: 'c1', agent: 'claude', title: 'Chat' } });
  return { document, notes, finish: async (turn = {}) => { await tick(); onTurn({ ok: true, summary: 'Finished work', ...turn }); await tick(); } };
}

test('a visible page stays quiet even without focus or with another chat selected', async () => {
  for (const options of [{}, { focused: false }, { chatVisible: false }, { focused: false, chatVisible: false }]) {
    const h = harness(options);
    await h.finish();
    assert.equal(h.notes.length, 0);
  }
});

test('a hidden page notifies when work ends, but stays quiet for a stopped turn', async () => {
  const h = harness({ hidden: true });
  await h.finish({ stopped: true });
  assert.equal(h.notes.length, 0);
  await h.finish();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].options.body, 'Finished work');
});

test('returning to the page while the service worker is loading cancels the notification', async () => {
  let resolve;
  const sent = [];
  const serviceWorker = { addEventListener() {}, getRegistration: () => new Promise(done => { resolve = done; }) };
  const h = harness({ hidden: true, serviceWorker });
  await h.finish();
  h.document.hidden = false;
  resolve({ showNotification: (...args) => sent.push(args) });
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(h.notes.length, 0);
});
