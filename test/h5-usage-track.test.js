// Usage data on the page (scripts/h5-shell/usage-track.mjs and usage-recorder.mjs; "Usage data" in docs/design/usage-data.md): how a press becomes an
// event (the key, the surface, the context), the privacy rules (labels, titles, names and inputs are never used), the switch, the batches and the
// beacon. The real page is scripts/test-h5-usage-data-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseHTML } = require('linkedom');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', file)).href);
const STATE = { wide: true, input: 'pointer', pane: null, sourceKey: 'local', columns: null, mindmapOpen: false };

// A page with the landmarks of the real one. Names a person could have typed are everywhere a careless recorder would look.
const PAGE = `<!doctype html><body>
  <nav id="h5-columns-nav"><button id="h5-nav-columns" class="h5-nav-item" data-view="columns" aria-label="Columns">Columns</button></nav>
  <header class="h5-header"><button id="h5-term-width" aria-label="Wide terminal"></button><button id="h5-task-name" title="Secret launch plan">Secret launch plan</button></header>
  <nav id="h5-tasks"><div class="h5-task-list">
    <div class="h5-task"><button class="MuiButtonBase-root h5-task-item" title="Acme merger"><span class="h5-task-title">Acme merger</span></button>
      <button class="MuiButtonBase-root h5-task-more h5-row-act" aria-label="Task actions"></button></div>
    <div class="h5-terminal-row" data-session="t-42"><button class="MuiButtonBase-root h5-terminal-main"><span class="h5-terminal-name">payroll.xlsx fix</span></button></div>
    <div class="h5-task-filters"><button class="MuiButtonBase-root MuiChip-root" data-filter="running">Running 3</button></div>
    <div class="h5-menu-actions"><button class="MuiButtonBase-root" data-track="h5-menu-action" data-track-detail="Rename">Rename</button>
      <button class="MuiButtonBase-root" data-track="h5-menu-action">My laptop</button></div>
  </div></nav>
  <main id="h5-terminal"><div class="xterm"><span id="cell">rm -rf secret</span></div></main>
  <div id="h5-bottom" class="h5-bottom" data-single="">
    <form id="h5-translate"><textarea id="h5-translate-input">my password is hunter2</textarea></form>
    <div id="h5-actions" role="toolbar"><button id="h5-cycle" aria-label="Recent sessions"><svg><path id="p"/></svg></button>
      <button id="h5-more" data-action="more"></button><button id="h5-translate-button" disabled>Send</button></div>
    <div class="h5-add-menu" role="menu"><button role="menuitem" data-track="h5-add-menu-command" data-track-detail="/compact">/compact</button></div>
  </div>
  <div id="h5-keys" role="toolbar"><button data-key="Escape" aria-label="Escape">Esc</button><button data-modifier="ctrl" aria-pressed="false">Ctrl</button></div>
  <div id="h5-osk"><button data-char="a">a</button><button data-key="&#27;">Esc</button></div>
  <div class="MuiMenu-root MuiPopover-root" id="h5-header-more-menu"><ul role="menu"><li role="menuitem" class="MuiButtonBase-root" id="h5-refresh">Refresh</li><li role="menuitem" class="MuiButtonBase-root">Board review</li></ul></div>
  <div class="MuiDialog-root" id="h5-new-task-dialog" role="presentation"><div role="dialog"><button id="h5-new-task-create">Create</button><button id=":r5:">Close</button><button id="mui-12">X</button></div></div>
  <div id="h5-settings"><section class="h5-setting-group" data-group="usage-data"><label class="h5-switch-row"><span id="label">Record</span><span class="MuiSwitch-root"><span class="MuiButtonBase-root MuiSwitch-switchBase"><input type="checkbox" id="h5-usage-enabled" role="switch"></span></span></label></section>
    <div id="h5-settings-groups" role="tablist"><div role="tab" class="MuiButtonBase-root h5-settings-group-item" id="h5-settings-group-usage-data">Usage data</div></div></div>
  <div id="h5-switcher" role="dialog"><button class="MuiButtonBase-root h5-switcher-card" data-key="remote:7|12|abc" aria-label="Acme merger, payroll">x</button></div>
  <div id="h5-attention-sheet"><div class="h5-attention-row"><div role="button" class="MuiButtonBase-root h5-attention-open" aria-label="Ship it, open session Claude 2">Ship it</div>
    <button class="MuiButtonBase-root h5-attention-action" data-action="approve">Approve</button>
    <ul><li class="h5-attention-file" data-path="/Users/me/secret.txt"><button class="MuiButtonBase-root">/Users/me/secret.txt</button></li></ul></div></div>
  <div data-test="plain"><a href="/x" class="plain">a plain link</a><button>Untitled</button></div>
</body>`;
const dom = () => parseHTML(PAGE).document;

test('a control is named by its stable identity, never by its text, title, aria-label or a data value with a name in it', async () => {
  const { controlOf, identityOf } = await load('usage-recorder.mjs');
  const document = dom();
  const key = selector => { const el = controlOf(document.querySelector(selector)); return el ? identityOf(el) : null; };
  assert.deepEqual(key('#h5-term-width'), { key: 'h5-term-width', detail: null, source: 'id' });
  assert.deepEqual(key('#p'), { key: 'h5-cycle', detail: null, source: 'id' }, 'a press on the icon inside a button is the button');
  assert.deepEqual(key('#h5-more'), { key: 'h5-more', detail: null, source: 'id' }, 'the id comes before data-action');
  assert.deepEqual(key('.h5-attention-action'), { key: 'action:approve', detail: null, source: 'action' });
  assert.deepEqual(key('[data-filter]'), { key: 'filter:running', detail: null, source: 'data' });
  assert.deepEqual(key('#h5-keys [data-key]'), { key: 'key:Escape', detail: null, source: 'data' });
  assert.deepEqual(key('[data-modifier]'), { key: 'mod:ctrl', detail: null, source: 'data' });
  assert.deepEqual(key('.h5-task-title'), { key: 'h5-task-item', detail: null, source: 'class' }, 'a task row is its kind, not its title');
  assert.deepEqual(key('.h5-terminal-name'), { key: 'h5-terminal-main', detail: null, source: 'class' });
  assert.deepEqual(key('.h5-switcher-card'), { key: 'h5-switcher-card', detail: null, source: 'class' }, 'a data-key with a session reference is not a key name');
  assert.deepEqual(key('.h5-attention-file button'), { key: 'h5-attention-file/button', detail: null, source: 'ancestor' }, 'data-path is never read');
  assert.deepEqual(key('[data-track-detail="Rename"]'), { key: 'h5-menu-action', detail: 'Rename', source: 'track' });
  assert.deepEqual(key('.h5-menu-actions button:last-child'), { key: 'h5-menu-action', detail: null, source: 'track' }, 'a menu row with a name has no detail');
  assert.deepEqual(key('.h5-add-menu button'), { key: 'h5-add-menu-command', detail: '/compact', source: 'track' });
  assert.deepEqual(key('#h5-header-more-menu li:last-child'), { key: 'h5-header-more-menu/menuitem', detail: null, source: 'ancestor' }, 'a menu item without an id: the menu and its role');
  assert.deepEqual(key('[id=":r5:"]'), { key: 'h5-new-task-dialog/button', detail: null, source: 'ancestor' }, 'a React id is not stable');
  assert.deepEqual(key('#mui-12'), { key: 'h5-new-task-dialog/button', detail: null, source: 'ancestor' }, 'an MUI id is not stable');
  assert.deepEqual(key('[data-test=plain] > button'), { key: 'button', detail: null, source: 'role' });
  // Never a control: text, the terminal, a disabled button, a plain link, an input field, a character of the on-screen keyboard.
  for (const selector of ['#cell', '#h5-translate-input', '#h5-translate-button', 'a.plain', '[data-char]', '#label']) assert.equal(key(selector), null, selector);
  // The words a person typed never appear in any key or detail of the whole page.
  const all = [...document.querySelectorAll('*')].map(el => controlOf(el)).filter(Boolean).map(el => JSON.stringify(identityOf(el))).join(' ');
  for (const secret of ['Secret', 'Acme', 'payroll', 'hunter2', 'laptop', 'Board', 'Ship it', 'secret.txt', 't-42', 'remote:7', 'Untitled']) assert.ok(!all.includes(secret), secret);
});

test('ids are cleaned: generated ids are refused, numbers and uuids are masked, a name at the end is cut', async () => {
  const { cleanId } = await load('usage-recorder.mjs');
  assert.equal(cleanId('h5-cycle'), 'h5-cycle');
  assert.equal(cleanId('h5-settings-tab-12'), 'h5-settings-tab-#');
  assert.equal(cleanId('h5-col-3f2a9c1e-77aa-4b1c-9d2e-0123456789ab'), 'h5-col-*');
  assert.equal(cleanId('h5-agent-skill-install-my-private-skill'), 'h5-agent-skill-install-*');
  assert.equal(cleanId('h5-plugin-login-acme'), 'h5-plugin-login-*');
  assert.equal(cleanId('h5-attention-delete-confirm'), 'h5-attention-delete-confirm', 'a word made of hex letters stays');
  for (const bad of [':r1:', '_r_3_', 'mui-4', '«r2»', 'has space', '', null, 'x'.repeat(90)]) assert.equal(cleanId(bad), null, String(bad));
});

test('the surface is one of a small fixed set, from the closest known container', async () => {
  const { surfaceOf } = await load('usage-recorder.mjs');
  const document = dom();
  const at = selector => surfaceOf(document.querySelector(selector));
  assert.equal(at('#h5-nav-columns'), 'rail');
  assert.equal(at('#h5-term-width'), 'header');
  assert.equal(at('.h5-task-item'), 'task-list');
  assert.equal(at('#h5-cycle'), 'bottom-row', 'the one row of a computer');
  assert.equal(at('.h5-add-menu button'), 'menu:commands');
  assert.equal(at('#h5-keys [data-key]'), 'key-row');
  assert.equal(at('#h5-refresh'), 'menu:header-more-menu');
  assert.equal(at('#h5-new-task-create'), 'dialog:new-task-dialog');
  assert.equal(at('#h5-usage-enabled'), 'settings:usage-data');
  assert.equal(at('#h5-settings-group-usage-data'), 'settings');
  assert.equal(at('.h5-switcher-card'), 'switcher');
  assert.equal(at('.h5-attention-open'), 'attention');
  assert.equal(at('[data-test=plain] > button'), 'page');
  // A phone: row 2 is the tool row.
  document.getElementById('h5-bottom').removeAttribute('data-single');
  assert.equal(at('#h5-cycle'), 'tool-row');
});

test('an event carries the context of the page (never a name) and the new state of a switch', async () => {
  const { eventOf, eventOfPress, contextOf } = await load('usage-recorder.mjs');
  const document = dom();
  assert.deepEqual(contextOf(STATE), { view: 'sessions', layout: 'wide', input: 'pointer', pane: false, device: 'local' });
  assert.deepEqual(contextOf({ wide: false, input: 'touch', pane: 'p1', sourceKey: 'remote:7', columns: null, mindmapOpen: true }), { view: 'maps', layout: 'narrow', input: 'touch', pane: true, device: 'remote' });
  assert.equal(contextOf({ ...STATE, columns: { shown: true, tab: 'columns' } }).view, 'columns');
  assert.equal(contextOf({ ...STATE, columns: { shown: true, tab: 'maps' } }).view, 'maps');
  assert.deepEqual(eventOf(document.querySelector('#p'), STATE, 1000), { at: 1000, key: 'h5-cycle', surface: 'bottom-row', view: 'sessions', layout: 'wide', input: 'pointer', pane: false, device: 'local' });
  const input = document.getElementById('h5-usage-enabled');
  input.checked = true; // the browser has flipped it before the capture listener runs
  assert.equal(eventOf(input, STATE).state, 'on');
  assert.equal(eventOf(document.querySelector('[data-modifier]'), STATE).state, 'on', 'aria-pressed false becomes on');
  assert.equal(eventOf(document.querySelector('.h5-add-menu button'), STATE).detail, '/compact');
  assert.equal(eventOf(document.getElementById('cell'), STATE), null);
  // Enter / Space count only on controls that are not native buttons (those fire a click by themselves) and never in a text field.
  assert.equal(eventOfPress({ type: 'keydown', target: document.getElementById('h5-cycle'), s: STATE, at: 1 }), null);
  assert.equal(eventOfPress({ type: 'keydown', target: document.getElementById('h5-translate-input'), s: STATE, at: 1 }), null);
  assert.equal(eventOfPress({ type: 'keydown', target: document.querySelector('.h5-attention-open'), s: STATE, at: 1 }).key, 'h5-attention-open');
});

test('menu rows carry their label only when it is a fixed product label', async () => {
  const { menuDetail } = await load('usage-track.mjs');
  assert.equal(menuDetail({ label: 'Rename' }), 'Rename');
  assert.equal(menuDetail({ label: 'Delete', kind: 'danger' }), 'Delete');
  assert.equal(menuDetail({ label: 'K01', kind: 'raw' }), undefined);
  assert.equal(menuDetail({ label: 'Claude', kind: 'raw' }), undefined, 'a raw label is a name even when it looks fixed');
  assert.equal(menuDetail({ label: 'Move to Marketing' }), undefined);
});

// A fake page around the listener: a store, timers, fetch and sendBeacon that record what is sent.
async function harness({ enabled = true } = {}) {
  const { startUsageTracking } = await load('usage-track.mjs');
  const recorder = await load('usage-recorder.mjs');
  const { createStore } = await load('store.mjs');
  const { document, window } = parseHTML(PAGE);
  const ui = createStore({ ...STATE, usageRecording: null });
  const posts = [];
  const beacons = [];
  const reads = [];
  let switchOn = enabled;
  const win = {
    addEventListener: (type, fn) => window.addEventListener(type, fn),
    fetch: async (url, options = {}) => {
      if (url.endsWith('/settings')) { reads.push(url); return { ok: true, json: async () => ({ enabled: switchOn }) }; }
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ accepted: 1, enabled: switchOn }) };
    },
    navigator: { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } },
  };
  const loaded = [];
  startUsageTracking(ui, { doc: document, win, load: async () => { loaded.push(1); return recorder; } });
  const click = selector => document.querySelector(selector).dispatchEvent(new window.Event('click', { bubbles: true }));
  return { ui, document, window, posts, beacons, reads, loaded, click, setSwitch: on => { switchOn = on; } };
}

test('presses are batched (every 10 s or 50), the recorder loads only when recording is on, and a beacon takes the rest when the page goes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const page = await harness();
  page.click('#h5-term-width'); // before the switch is read: kept
  assert.equal(page.loaded.length, 0, 'not loaded before the switch is known');
  t.mock.timers.tick(1500);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.ui.get().usageRecording, true);
  assert.equal(page.loaded.length, 1);
  page.click('#p');
  page.click('.h5-task-title');
  assert.equal(page.posts.length, 0, 'no request per click');
  t.mock.timers.tick(10000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.posts.length, 1);
  const batch = page.posts[0];
  assert.deepEqual(Object.keys(batch).sort(), ['events', 'page', 'seen', 'sent']);
  assert.deepEqual(batch.events.map(event => event.key), ['h5-term-width', 'h5-cycle', 'h5-task-item']);
  assert.match(batch.page, /^[a-z0-9]{6,32}$/);
  // 50 presses go at once.
  for (let i = 0; i < 50; i += 1) page.click('#h5-more');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.posts.length, 2);
  assert.equal(page.posts[1].events.length, 50);
  // The page goes away: one beacon with what is left.
  page.click('#h5-refresh');
  page.window.dispatchEvent(new page.window.Event('pagehide'));
  assert.equal(page.beacons.length, 1);
  assert.equal(page.beacons[0].url, '/api/ui-events');
  const sent = JSON.parse(await page.beacons[0].blob.text());
  assert.deepEqual(sent.events.map(event => event.key), ['h5-refresh']);
  assert.equal(sent.events[0].surface, 'menu:header-more-menu');
  t.mock.timers.reset();
});

test('while recording is off nothing is kept, loaded or sent; turning it off drops what is buffered', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const off = await harness({ enabled: false });
  off.click('#h5-term-width');
  t.mock.timers.tick(1500);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(off.ui.get().usageRecording, false);
  off.click('#h5-cycle');
  t.mock.timers.tick(20000);
  off.window.dispatchEvent(new off.window.Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([off.loaded.length, off.posts.length, off.beacons.length], [0, 0, 0]);

  const on = await harness();
  t.mock.timers.tick(1500);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  on.click('#h5-cycle');
  on.ui.set({ usageRecording: false }); // the switch in Settings
  t.mock.timers.tick(20000);
  on.window.dispatchEvent(new on.window.Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([on.posts.length, on.beacons.length], [0, 0], 'the buffered press was dropped');
  // On again: recording goes on in the same recorder.
  on.ui.set({ usageRecording: true });
  on.click('#h5-more');
  t.mock.timers.tick(10000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(on.loaded.length, 1, 'loaded once');
  assert.deepEqual(on.posts.at(-1).events.map(event => event.key), ['h5-more']);
  t.mock.timers.reset();
});
