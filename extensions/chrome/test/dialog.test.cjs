// page.dialog with a mocked chrome.debugger ("Dialogs" in docs/design/browser-extension.md): a dialog Chrome reports while the probe waits
// gives its type and text and is answered with the prompt text; a blocked page is `known: false`; no dialog is NO_DIALOG; DevTools is
// DEBUGGER_BUSY; the debugger always detaches. (Real Chromium cannot show a native dialog headless: see actions.test.cjs for the rest.)
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('page.dialog: report, answer, blocked page, no dialog', async t => {
  const listeners = [];
  const calls = [];
  let mode = 'none';
  let attached = false;
  global.chrome = {
    debugger: {
      onEvent: { addListener: f => listeners.push(f) },
      attach: async ({ tabId }) => {
        if (mode === 'busy') throw new Error('Another debugger is already attached');
        attached = true;
        calls.push(['attach', tabId]);
      },
      detach: async () => { attached = false; calls.push(['detach']); },
      sendCommand: (target, method, params) => {
        calls.push([method, params]);
        if (method === 'Page.enable') {
          if (mode === 'open') {
            setTimeout(() => listeners.forEach(f => f(target, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'Name? token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', defaultPrompt: 'x', url: 'http://localhost/' })), 10);
            return new Promise(() => {});
          }
          if (mode === 'blocked') return new Promise(() => {});
          return Promise.resolve({});
        }
        if (method === 'Page.handleJavaScriptDialog') return mode === 'none' ? Promise.reject(new Error('{"code":-32602,"message":"No dialog is showing"}')) : Promise.resolve({});
        return Promise.resolve({});
      }
    }
  };
  t.after(() => { delete global.chrome; });
  const { runAction } = await import('../actions.js');
  const run = p => runAction('page.dialog', 7, p, {});

  mode = 'open';
  const status = await run({});
  assert.deepEqual([status.open, status.known, status.type, status.default_prompt], [true, true, 'prompt', 'x']);
  assert(!status.message.includes('eyJ'), 'the text is redacted');
  calls.length = 0;
  assert.equal((await run({ action: 'accept', text: 'Ann' })).handled, 'accepted');
  assert.deepEqual(calls.find(c => c[0] === 'Page.handleJavaScriptDialog')[1], { accept: true, promptText: 'Ann' });
  assert.equal(attached, false, 'detached after the answer');
  calls.length = 0;
  assert.equal((await run({ action: 'dismiss' })).handled, 'dismissed');
  assert.deepEqual(calls.find(c => c[0] === 'Page.handleJavaScriptDialog')[1], { accept: false });

  mode = 'blocked';
  assert.deepEqual(await run({ action: 'status' }), { open: true, known: false });
  const blind = await run({ action: 'accept' });
  assert.deepEqual([blind.handled, blind.known], ['accepted', false], 'a blocked page is answered without its text');

  mode = 'none';
  assert.deepEqual(await run({}), { open: false });
  await assert.rejects(run({ action: 'accept' }), /NO_DIALOG/);
  await assert.rejects(run({ action: 'open' }), /BAD_PARAMS/);
  await assert.rejects(run({ action: 'dismiss', text: 'x' }), /BAD_PARAMS/);
  mode = 'busy';
  await assert.rejects(run({}), /DEBUGGER_BUSY/);
  assert.equal(attached, false);
});
