// The back button of the phone page closes the open layer (scripts/h5-shell/back.mjs), with fake history, body and modals.
const test = require('node:test');
const assert = require('node:assert/strict');

function fakePage() {
  const listeners = {};
  const observers = [];
  const entries = [{ state: null }];
  let index = 0;
  const pops = [];
  const win = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: type => { delete listeners[type]; },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    Event: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} },
    history: {
      get state() { return entries[index].state; },
      get length() { return entries.length; },
      pushState(state) { entries.splice(index + 1); entries.push({ state }); index += 1; },
      go(delta) { pops.push(delta); setTimeout(() => { index = Math.max(0, index + delta); listeners.popstate?.({}); }, 1); },
    },
    back() { index -= 1; listeners.popstate?.({}); }, // what the Android back button does
    get index() { return index; },
  };
  const body = { children: [] };
  const doc = { body };
  function modal(name, { escape = true } = {}) {
    const classes = new Set(['MuiModal-root']);
    const el = {
      name, isConnected: true,
      classList: { contains: c => classes.has(c) },
      dispatchEvent(event) { if (event.key === 'Escape' && escape) el.remove(); },
      remove() { el.isConnected = false; body.children.splice(body.children.indexOf(el), 1); for (const o of observers) o.fn(); },
    };
    body.children.push(el);
    for (const o of observers) o.fn();
    return el;
  }
  return { win, doc, modal, pops, entries };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('each open layer has its own entry; back closes the top one and a closed one takes its entry back', async () => {
  const { createBackLayers } = await import('../scripts/h5-shell/back.mjs');
  const page = fakePage();
  const back = createBackLayers({ win: page.win, doc: page.doc, closeTimeoutMs: 50 });
  await settle();
  assert.equal(page.win.history.length, 1, 'nothing open: no entry');

  const settings = page.modal('settings');
  await settle();
  const dialog = page.modal('engine dialog');
  await settle();
  assert.equal(back.depth, 2);
  assert.equal(page.win.index, 2);

  page.win.back(); // closes the dialog, not the page
  await settle();
  assert.equal(dialog.isConnected, false);
  assert.equal(settings.isConnected, true);
  assert.equal(back.depth, 1);
  assert.deepEqual(page.pops, [], 'no history.go: the entry was already popped');

  settings.remove(); // its close button
  await settle();
  assert.deepEqual(page.pops, [-1], 'its entry is taken back');
  assert.equal(page.win.index, 0);
  assert.equal(back.depth, 0);

  // A back press with nothing open is the page's own (leave the page): nothing is closed or pushed.
  page.win.back();
  await settle();
  assert.equal(back.depth, 0);
  back.dispose();
});

test('a modal that ignores Escape (the upload overlay) gets a new entry, so the next back press does not leave the page', async () => {
  const { createBackLayers } = await import('../scripts/h5-shell/back.mjs');
  const page = fakePage();
  const back = createBackLayers({ win: page.win, doc: page.doc, closeTimeoutMs: 30 });
  const overlay = page.modal('upload', { escape: false });
  await settle();
  assert.equal(back.depth, 1);
  page.win.back();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(overlay.isConnected, true);
  assert.equal(back.depth, 1, 'pushed again');
  assert.equal(page.win.index, 1);
  back.dispose();
});

test('an extra layer (the file sheet beside the terminal) is closed by back like a modal', async () => {
  const { createBackLayers } = await import('../scripts/h5-shell/back.mjs');
  const page = fakePage();
  let open = true;
  const back = createBackLayers({ win: page.win, doc: page.doc, extra: () => (open ? [{ close: () => { open = false; } }] : []) });
  await settle();
  assert.equal(back.depth, 1);
  page.win.back();
  await settle();
  assert.equal(open, false);
  assert.equal(back.depth, 0);
  assert.deepEqual(page.pops, []);
  back.dispose();
});
