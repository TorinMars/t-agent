// Vibration on key taps ("Vibration on key taps" in docs/design/key-haptics.md) on the real page in Chromium: Settings → Keyboard
// (KeyboardSettings.jsx), the key row of the bottom bar (Terminal.jsx `KeyBar`) and the terminal's own keyboard (Osk.jsx), all played by
// key-feedback.mjs with the strength kept for this device (key-haptics.mjs).
// - An Android-like phone (390 x 844, touch, navigator.vibrate stubbed and recorded): Light (8 ms) by default; the Keyboard group sits between Voice
//   and translation and Devices, with Off / Light / Medium / Strong; choosing one plays it once; "Try it" ticks with it; the key row and the keyboard
//   vibrate with the chosen duration on the press and not on a held key's repeats; Off stops it; the value survives a reload, is kept in this
//   browser only (no request carries it) and another device starts at Light.
// - An iPhone-like phone (no navigator.vibrate, the `switch` input supported, the hidden label's click recorded): one switch, ticks only while on.
// - A computer (no touch screen; desktop Chrome still has navigator.vibrate): "This device cannot vibrate".
// The server is mocked (no data folder is used). H5_SHOT_DIR=<dir> saves 3x screenshots of the Keyboard group.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { openGroup, listedGroups } = require('./settings-test-helper.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const pageErrors = [];
const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'h5-default', title: 'Terminal 1' }] };

// `device`: 'android' (navigator.vibrate recorded), 'ios' (no vibrate; the switch input, its label clicks recorded) or 'computer'.
function fakes(device) {
  window.vibrations = [];
  window.switchTicks = 0;
  if (device === 'android') Object.defineProperty(navigator, 'vibrate', { configurable: true, value: ms => { window.vibrations.push(ms); return true; } });
  if (device === 'ios') {
    Object.defineProperty(Navigator.prototype, 'vibrate', { configurable: true, value: undefined });
    Object.defineProperty(HTMLInputElement.prototype, 'switch', { configurable: true, get() { return this.hasAttribute('switch'); } });
    const click = HTMLElement.prototype.click;
    HTMLLabelElement.prototype.click = function () { if (this.htmlFor === 'h5-key-haptic') window.switchTicks += 1; return click.call(this); };
  }
  window.sockets = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
    send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
    close() { this.readyState = 3; }
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
}

async function openPage(browser, device, { context: given = null } = {}) {
  const touch = device !== 'computer';
  const viewport = touch ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const context = given || await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), deviceScaleFactor: process.env.H5_SHOT_DIR ? 3 : 1 });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`${device}: ${error.message}`));
  const bodies = [];
  await page.addInitScript(fakes, device);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method !== 'GET') bodies.push(`${method} ${url.pathname} ${route.request().postData() || ''}`);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/terminal-activity' || url.pathname === '/api/tasks/terminal-subagents') return json({});
    const terminals = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/oss/config') return json({ enabled: false });
    if (url.pathname === '/api/system/version') return json({ app_version: '1.0.0' });
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.H5UI && window.H5UI.actions && window.H5UI.actions.openSettings);
  // A reload in the same browser opens the session it had (h5-task), so the task list is only used the first time.
  if (touch && !given) {
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  }
  if (touch) await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  return { context, page, bodies };
}

// The haptic ticks so far: the recorded vibrations (Android) or the clicks of the hidden switch label (iPhone).
const vibrations = page => page.evaluate(() => window.vibrations.slice());
const switchTicks = page => page.evaluate(() => window.switchTicks);
// A touch press of an element: pointerdown, `hold` ms, pointerup (in the page, so the timing does not depend on frames).
const press = (page, selector, hold = 0) => page.evaluate(async ({ selector, hold }) => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  const box = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 5, isPrimary: true, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  if (hold) { const until = performance.now() + hold; while (performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10)); }
  el.dispatchEvent(new PointerEvent('pointerup', init));
  await new Promise(resolve => setTimeout(resolve, 60)); // the feel chunk is loaded at the first press
}, { selector, hold });
// The vibrations a press adds (waits a moment for the first load of the feel chunk).
async function added(page, action) {
  const before = (await vibrations(page)).length;
  await action();
  await page.waitForTimeout(80);
  return (await vibrations(page)).slice(before);
}

async function openKeyboardGroup(page) {
  await page.evaluate(() => window.H5UI.actions.openSettings());
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await openGroup(page, 'keyboard');
}
async function closeSettings(page) {
  await page.evaluate(() => window.H5UI.actions.closeSettings());
  await page.locator('#h5-settings').waitFor({ state: 'detached' });
}
const choices = page => page.locator('#h5-key-haptics input[type="radio"]').evaluateAll(nodes => nodes.map(node => ({ value: node.value, checked: node.checked })));
const chosen = async page => (await choices(page)).filter(item => item.checked).map(item => item.value);
const stored = page => page.evaluate(() => window.TALocalKeys.get('h5-key-haptics'));
async function shot(page, name) {
  if (!process.env.H5_SHOT_DIR) return;
  fs.mkdirSync(process.env.H5_SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, `key-haptics-${name}.png`) });
}

async function android(browser) {
  const { context, page, bodies } = await openPage(browser, 'android');
  assert.ok(await page.evaluate(() => navigator.maxTouchPoints > 0), 'the phone has a touch screen');
  // Light by default: the 8 ms of before, on the key row and the terminal's keyboard.
  assert.deepEqual(await added(page, () => press(page, '#h5-keys [data-key="Escape"]')), [8], 'the key row ticks 8 ms by default');
  await page.locator('[data-action="keyboard"]').tap();
  await page.locator('#h5-osk').waitFor();
  assert.deepEqual(await added(page, () => press(page, '#h5-osk [data-char="q"]')), [8], 'a key of the keyboard ticks 8 ms by default');

  // The Keyboard group: between Voice and translation and Devices, its summary, four choices with Light chosen, Try it.
  await page.evaluate(() => window.H5UI.actions.openSettings());
  await page.locator('#h5-settings-groups').waitFor({ state: 'visible' });
  const groups = await listedGroups(page);
  assert.deepEqual(groups.slice(groups.indexOf('voice-translate'), groups.indexOf('voice-translate') + 3), ['voice-translate', 'keyboard', 'devices']);
  assert.match(await page.locator('#h5-settings-group-keyboard').innerText(), /Keyboard\s+Vibration on key taps/);
  await openGroup(page, 'keyboard');
  assert.equal(await page.locator('#h5-sec-key-haptics-title').innerText(), 'Vibration on key taps');
  assert.deepEqual(await choices(page), [{ value: 'off', checked: false }, { value: 'light', checked: true }, { value: 'medium', checked: false }, { value: 'strong', checked: false }]);
  assert.deepEqual(await page.locator('#h5-key-haptics .h5-radio-row').evaluateAll(rows => rows.map(row => row.innerText.replace(/\s+/g, ' ').trim())),
    ['Off No vibration', 'Light A short tap (as today)', 'Medium A firmer tap', 'Strong A clear buzz']);
  const rows = await page.locator('#h5-key-haptics .h5-radio-row').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  assert.ok(rows.every(height => height >= 56), `56px rows: ${rows}`);
  assert.equal(await page.locator('#h5-key-haptics-switch').count(), 0, 'no switch where the strength can vary');
  assert.equal(await page.locator('#h5-key-try .h5-key-try-key').count(), 6, 'Try it: q w e Esc Enter Backspace');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true, 'nothing wider than the phone');
  await shot(page, 'android');

  // Choosing plays it once; Try it ticks with it.
  assert.deepEqual(await added(page, () => page.locator('#h5-key-haptics [data-strength="strong"]').click()), [28], 'choosing Strong plays it once');
  assert.deepEqual(await chosen(page), ['strong']);
  assert.equal(await stored(page), 'strong', 'kept in this browser');
  assert.deepEqual(await added(page, () => press(page, '#h5-key-try [data-key="q"]')), [28], 'Try it ticks with the chosen strength');
  assert.deepEqual(await added(page, () => press(page, '#h5-key-try [data-key="Backspace"]', 600)), [28], 'a held Try it key ticks once');
  await closeSettings(page);

  // The key row and the keyboard follow at once, on the press, once per press.
  assert.deepEqual(await added(page, () => press(page, '#h5-keys [data-key="Enter"]')), [28], 'the key row: Enter');
  assert.deepEqual(await added(page, () => press(page, '#h5-keys [data-modifier="ctrl"]')), [28], 'the key row: Ctrl');
  assert.deepEqual(await added(page, () => press(page, '#h5-keys [data-key="Backspace"]', 900)), [28], 'a held key of the key row ticks once');
  assert.deepEqual(await added(page, () => press(page, '#h5-osk [data-char="w"]')), [28], 'the keyboard: a letter');
  assert.deepEqual(await added(page, () => press(page, '#h5-osk [data-key="Backspace"]', 900)), [28], 'a held Backspace ticks once, not on each repeat');
  assert.deepEqual(await added(page, () => press(page, '#h5-actions [data-action="keyboard"]')), [], 'the tool row does not tick');
  if (!(await page.locator('#h5-osk').count())) { await page.locator('[data-action="keyboard"]').tap(); await page.locator('#h5-osk').waitFor(); }

  // Medium, then Off: Off plays nothing on the choice and nothing on the keys.
  await openKeyboardGroup(page);
  assert.deepEqual(await added(page, () => page.locator('#h5-key-haptics [data-strength="medium"]').click()), [15], 'Medium plays 15 ms');
  await closeSettings(page);
  assert.deepEqual(await added(page, () => press(page, '#h5-keys [data-key="Tab"]')), [15]);
  await openKeyboardGroup(page);
  assert.deepEqual(await added(page, () => page.locator('#h5-key-haptics [data-strength="off"]').click()), [], 'Off plays nothing');
  assert.equal(await stored(page), 'off');
  assert.deepEqual(await added(page, () => press(page, '#h5-key-try [data-key="e"]')), [], 'Try it is silent while Off');
  await closeSettings(page);
  assert.deepEqual(await added(page, () => press(page, '#h5-keys [data-key="Escape"]')), [], 'Off: the key row is silent');
  assert.deepEqual(await added(page, () => press(page, '#h5-osk [data-char="e"]')), [], 'Off: the keyboard is silent');

  // A reload keeps Off; the value never went to the server.
  await page.close();
  const again = await openPage(browser, 'android', { context });
  await openKeyboardGroup(again.page);
  assert.deepEqual(await chosen(again.page), ['off'], 'Off after a reload');
  await closeSettings(again.page);
  assert.deepEqual(await added(again.page, () => press(again.page, '#h5-keys [data-key="Escape"]')), [], 'still silent after a reload');
  const carried = [...bodies, ...again.bodies].filter(body => body.includes('key-haptics'));
  assert.deepEqual(carried, [], 'no request carries the choice: it stays on this device');
  const sent = await again.page.evaluate(() => window.sockets.flatMap(socket => socket.sent).filter(item => item.includes('key-haptics')));
  assert.deepEqual(sent, []);
  await context.close();

  // Another device (another browser) starts at Light.
  const other = await openPage(browser, 'android');
  assert.deepEqual(await added(other.page, () => press(other.page, '#h5-keys [data-key="Escape"]')), [8], 'another device keeps its own choice (Light)');
  await other.context.close();
}

async function ios(browser) {
  const { context, page } = await openPage(browser, 'ios');
  assert.equal(await page.evaluate(() => typeof navigator.vibrate), 'undefined');
  const before = await switchTicks(page);
  await press(page, '#h5-keys [data-key="Escape"]');
  assert.equal(await switchTicks(page), before + 1, 'iPhone: the key row plays the switch tap by default');
  await openKeyboardGroup(page);
  assert.equal(await page.locator('#h5-sec-key-haptics input[type="radio"]').count(), 0, 'no strengths on an iPhone');
  const toggle = page.locator('#h5-key-haptics-switch');
  assert.equal(await toggle.isChecked(), true, 'on by default');
  assert.match(await page.locator('#h5-sec-key-haptics').innerText(), /Vibrate on key taps\s+A light tap, as the system plays it/);
  assert.match(await page.locator('#h5-key-haptics-hint').innerText(), /^iPhone lets a web page play only one kind of tap/);
  assert.equal(await page.locator('#h5-key-try').count(), 0);
  await shot(page, 'ios');
  let ticks = await switchTicks(page);
  await toggle.click();
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await stored(page), 'off');
  assert.equal(await switchTicks(page), ticks, 'turning it off plays nothing');
  await closeSettings(page);
  await press(page, '#h5-keys [data-key="Enter"]');
  await page.locator('[data-action="keyboard"]').tap();
  await page.locator('#h5-osk').waitFor();
  await press(page, '#h5-osk [data-char="a"]');
  assert.equal(await switchTicks(page), ticks, 'off: no tap from the key row or the keyboard');
  await openKeyboardGroup(page);
  await page.locator('#h5-key-haptics-switch').click();
  assert.equal(await stored(page), 'light');
  assert.equal(await switchTicks(page), ticks + 1, 'turning it on plays the tap once');
  await closeSettings(page);
  ticks = await switchTicks(page);
  await press(page, '#h5-osk [data-char="s"]');
  await press(page, '#h5-keys [data-key="Tab"]');
  assert.equal(await switchTicks(page), ticks + 2, 'on: one tap per press');
  await context.close();
}

async function computer(browser) {
  const { context, page } = await openPage(browser, 'computer');
  assert.equal(await page.evaluate(() => typeof navigator.vibrate), 'function', 'desktop Chrome has navigator.vibrate');
  await page.evaluate(() => window.H5UI.actions.openSettings('keyboard'));
  await page.locator('#h5-settings[data-layout="wide"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('h5-set-keyboard') && !document.getElementById('h5-set-keyboard').hidden);
  const groups = await listedGroups(page);
  assert.equal(groups[groups.indexOf('voice-translate') + 1], 'keyboard', 'the same group list as a phone');
  assert.equal(await page.locator('#h5-key-haptics-none').innerText(), 'This device cannot vibrate');
  assert.equal(await page.locator('#h5-sec-key-haptics input').count(), 0, 'no choices');
  assert.equal(await page.locator('#h5-key-haptics-switch').count(), 0);
  await shot(page, 'computer');
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await android(browser);
    await ios(browser);
    await computer(browser);
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('h5 key haptics: ok (Android strengths, iPhone switch, computer)');
})().catch(error => { console.error(error); process.exit(1); });
