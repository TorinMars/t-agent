// The T-Attention first-run guide (scripts/h5-shell/AttentionGuide.jsx, guide-model.mjs) on the MUI page in real Chromium, with the API stubbed
// by Playwright routes (GET /api/attention/plugins, GET / PUT /api/attention/settings/guide, the claude install, pairing, the notifier test):
// - phone 390x844 (touch): a fresh Client shows the guide at the top of the panel (0/3, step 1 open, 44px targets, fits the width); "Install on
//   this machine" (POST /plugins/claude/install) finishes step 1; "Allow system notifications" asks the browser; "Page and system notifications
//   only" (PUT { pageOnly }) finishes step 2; "Test this page" shows a toast, plays the sound, shows a system notification and saves { tested };
//   "All set" stays until the panel closes; opened again, the guide is gone.
// - phone 320x640 (touch): the guide fits; Close (aria-label = title "Hide setup guide") saves { dismissed }; Settings → T-Attention has
//   "Show setup guide", which brings it back there (PUT { dismissed: false }); "Set up Telegram" from the panel opens Settings → T-Attention.
// - computer 1440x900 (mouse): "Another machine…" opens the pairing dialog, the claim saves { paired }; a Telegram that is set up finishes step 2;
//   a failed notifier test shows its message and does not finish step 3, a working one does.
// H5_SHOT_DIR=<dir> saves screenshots (phones at 3x).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';

const overview = db => ({
  listeners: [{ name: 'claude', version: '1.0.0', description: 'Claude Code hooks', local: { installable: true, autoTerminal: true, itemCount: 0, lastEventAt: null, ...db.claude } }],
  notifiers: [{ name: 'telegram', version: '1.0.0', description: 'Telegram', loaded: true, error: null, enabled: true, configured: db.telegramReady, summary: null, statuses: {}, settings: true, test: true, customUi: 'telegram' }],
});

async function openPage(browser, { viewport, touch = true, db: start = {} }) {
  const scale = SHOTS && touch ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
  const page = await context.newPage();
  const errors = [];
  const calls = [];
  const db = { claude: { hookPath: false, loggedIn: false, toolHooks: null }, telegramReady: false, guide: { dismissed: false, pageOnly: false, paired: false, tested: false }, testResults: [], pairingReads: 0, ...start };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    window.EventSource = class extends EventTarget { constructor(url) { super(); this.url = url; setTimeout(() => this.dispatchEvent(new Event('open')), 0); } close() {} };
    window.notes = [];
    window.Notification = class { constructor(title, options = {}) { window.notes.push({ title, body: options.body, tag: options.tag }); } close() {} };
    window.Notification.permission = 'default';
    window.Notification.requestPermission = async () => { window.Notification.permission = 'granted'; return 'granted'; };
    window.tones = 0;
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createOscillator() { window.tones += 1; return { type: '', frequency: {}, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/1/terminals') return json([{ terminal_id: 't1', title: 'Terminal 1' }]);
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (p.startsWith('/api/attention')) {
      const body = request.postData() ? JSON.parse(request.postData()) : undefined;
      calls.push({ method, path: p, body });
      if (p === '/api/attention' && method === 'GET') return json({ items: [], host: 'mac' });
      if (p === '/api/attention/plugins' && method === 'GET') return json(overview(db));
      if (p === '/api/attention/settings/guide' && method === 'GET') return json({ ...db.guide, updatedAt: null });
      if (p === '/api/attention/settings/guide' && method === 'PUT') { db.guide = { ...db.guide, ...body }; return json({ ...db.guide, updatedAt: new Date().toISOString() }); }
      if (p === '/api/attention/plugins/claude/install' && method === 'POST') {
        db.claude = { hookPath: true, loggedIn: true, toolHooks: true, hooksCurrent: true };
        return json({ ok: true, client: 'written', changed: true, added: 8, updated: 0, settingsFile: '/home/me/.claude/settings.json' });
      }
      if (p === '/api/attention/plugins/telegram/test' && method === 'POST') return json(db.testResults.shift() || { ok: true, message: 'Test sent' });
      if (p === '/api/attention/pairing' && method === 'POST') return json({ code: '123456', expiresAt: new Date(Date.now() + 600000).toISOString(), url: body.origin, command: `t-attention pair 123456 --url ${body.origin}` }, 201);
      if (p === '/api/attention/pairing' && method === 'GET') {
        db.pairingReads += 1;
        return json(db.pairingReads >= 1 ? { active: false, expiresAt: null, claimed: { name: 'claude listener (laptop)', at: new Date().toISOString() } } : { active: true, claimed: null });
      }
      if (p === '/api/attention/pairing' && method === 'DELETE') return json({ active: false, expiresAt: null, claimed: null });
      if (p === '/api/attention-notify/config') return json({ rules: null, modes: [], notifiers: [{ name: 'telegram', label: 'Telegram', status: { loggedIn: false, step: 'none', hasApiHash: false } }], recent: [] });
      if (p === '/api/attention/plugins/telegram/config') return json({ name: 'telegram', enabled: true, schema: [], test: true, customUi: 'telegram', values: {} });
      if (p === '/api/attention/tokens') return json({ tokens: [] });
      if (p === '/api/attention/settings/summary') return json({ enabled: false, provider: 'deepseek', model: '', providers: [] });
      return json({ error: 'not mocked' }, 404);
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  // Open the task's terminal, so row 2 (with the Attention button) is there; on a phone the task sheet slides away.
  const how = touch ? 'tap' : 'click';
  const row = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await row.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await row[how]();
  await page.waitForFunction(() => innerWidth >= 900 || !document.body.classList.contains('h5-tasks-open') && Math.abs(document.getElementById('h5-app').getBoundingClientRect().left) < 0.5);
  await page.locator('#h5-attention').waitFor();
  return { context, page, errors, calls, db, how };
}

const guide = page => page.locator('#h5-guide');
const stepDone = (page, key, scope = '#h5-guide') => page.locator(`${scope} .h5-guide-step[data-step="${key}"]`).getAttribute('data-done');
const openStep = (page, scope = '#h5-guide') => page.evaluate(sel => [...document.querySelectorAll(`${sel} .h5-guide-step`)].filter(node => node.querySelector('.h5-guide-step-body')).map(node => node.dataset.step), scope);
const puts = calls => calls.filter(call => call.method === 'PUT' && call.path === '/api/attention/settings/guide').map(call => call.body);
// Buttons in the guide smaller than 44px (touch) and nodes wider than the viewport.
const small = page => page.evaluate(() => [...document.querySelectorAll('#h5-guide button')].map(node => ({ id: node.id || node.className.split(' ')[0], ...node.getBoundingClientRect().toJSON() })).filter(r => r.width < 43.99 || r.height < 43.99));
const overflow = page => page.evaluate(() => [...document.querySelectorAll('#h5-guide, #h5-guide *')].filter(node => node.getBoundingClientRect().right > innerWidth + 0.5 || node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== 'hidden').map(node => node.id || node.className));

// Waits until the sheet's slide-in has ended (no transform left), so sizes and positions are final.
async function openPanel(page, how) {
  await page.locator('#h5-attention')[how]();
  await page.locator('#h5-attention-sheet .h5-attention-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => { const node = document.querySelector('#h5-attention-sheet .h5-attention-panel'); return node && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(node).transform); }, null, { timeout: 3000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── Phone 390x844, touch: the whole way through ──
    {
      const { context, page, errors, calls, db, how } = await openPage(browser, { viewport: { width: 390, height: 844 } });
      assert.equal(calls.filter(call => call.path === '/api/attention/settings/guide').length, 0, 'nothing is read before the panel opens');
      await openPanel(page, how);
      await guide(page).waitFor();
      assert.equal(await guide(page).locator('h3').textContent(), 'Set up T-Attention');
      assert.equal(await guide(page).locator('.h5-guide-count').textContent(), '0/3');
      assert.deepEqual(await openStep(page), ['claude'], 'step 1 is open');
      const close = page.locator('#h5-guide-close-panel');
      assert.equal(await close.getAttribute('aria-label'), 'Hide setup guide');
      assert.equal(await close.getAttribute('title'), 'Hide setup guide');
      assert.equal(await page.locator('#h5-guide .h5-guide-step-head').first().getAttribute('aria-expanded'), 'true');
      assert.deepEqual(await small(page), []);
      assert.deepEqual(await overflow(page), []);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-guide-phone-390.png') });

      await page.locator('#h5-guide-install')[how]();
      await page.locator('#h5-guide-feedback-panel', { hasText: 'Claude Code hooks added' }).waitFor();
      assert.equal(await stepDone(page, 'claude'), 'true');
      assert.deepEqual(await openStep(page), ['notify'], 'the next open step opens');
      assert.equal(await guide(page).locator('.h5-guide-count').textContent(), '1/3');
      assert.ok(await page.locator('#h5-guide-telegram').isVisible(), 'Set up Telegram is offered');

      await page.locator('#h5-guide-allow')[how]();
      await page.locator('#h5-guide .h5-guide-notify-on').waitFor();
      assert.equal(await page.locator('#h5-guide-allow').count(), 0, 'asked once; system notifications are on');
      assert.equal(await stepDone(page, 'notify'), 'false', 'the browser permission alone does not finish step 2');
      await page.locator('#h5-guide-page-only')[how]();
      await page.waitForFunction(() => document.querySelector('#h5-guide .h5-guide-step[data-step="notify"]').dataset.done === 'true');
      assert.deepEqual(await openStep(page), ['test']);
      assert.equal(await page.locator('#h5-guide .h5-guide-test').count(), 0, 'no notifier test while none is set up');

      const tones = await page.evaluate(() => window.tones);
      await page.locator('#h5-guide-test-page')[how]();
      await page.locator('.MuiSnackbar-root .MuiAlert-message', { hasText: 'T-Attention test: reminders on this page work' }).waitFor();
      await page.locator('#h5-guide .h5-guide-all-done').waitFor();
      assert.ok(await page.evaluate(() => window.tones) > tones, 'the sound played');
      assert.equal((await page.evaluate(() => window.notes)).filter(note => note.tag === 'attention-test').length, 1, 'a system notification');
      assert.equal(await guide(page).locator('.h5-guide-count').textContent(), '3/3');
      assert.deepEqual(puts(calls), [{ pageOnly: true }, { tested: true }]);
      assert.deepEqual(await openStep(page), [], 'all done: no step is open');
      // A done step opens on a tap and shows how it was done.
      await page.locator('#h5-guide .h5-guide-step[data-step="claude"] .h5-guide-step-head')[how]();
      assert.equal(await page.locator('#h5-guide .h5-guide-done-line').textContent(), 'Claude Code on this machine reports here.');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-guide-phone-390-done.png') });

      await page.locator('#h5-attention-close')[how]();
      await page.locator('#h5-attention-sheet .h5-attention-panel').waitFor({ state: 'hidden' });
      await openPanel(page, how);
      await page.waitForFunction(() => document.querySelector('#h5-attention-empty'));
      await page.waitForTimeout(300);
      assert.equal(await guide(page).count(), 0, 'all done: the guide does not come back by itself');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Phone 320x640, touch: close, "Show setup guide", "Set up Telegram" ──
    {
      const { context, page, errors, calls, how } = await openPage(browser, { viewport: { width: 320, height: 640 } });
      await openPanel(page, how);
      await guide(page).waitFor();
      assert.deepEqual(await small(page), []);
      assert.deepEqual(await overflow(page), [], 'fits at 320px');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-guide-phone-320.png') });
      await page.locator('#h5-guide-close-panel')[how]();
      await guide(page).waitFor({ state: 'detached' });
      assert.deepEqual(puts(calls), [{ dismissed: true }]);
      await page.locator('#h5-attention-close')[how]();
      await page.locator('#h5-attention-sheet .h5-attention-panel').waitFor({ state: 'hidden' });
      // Settings → T-Attention: "Show setup guide" brings it back.
      await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
      await page.locator('#h5-settings').waitFor({ state: 'visible' });
      await page.locator('#h5-set-attention .MuiAccordionSummary-root')[how]();
      await page.locator('#h5-guide-show').waitFor();
      await page.locator('#h5-guide-show')[how]();
      await page.locator('#h5-guide-settings').waitFor();
      assert.deepEqual(puts(calls).at(-1), { dismissed: false });
      assert.deepEqual(await openStep(page, '#h5-guide-settings'), ['claude']);
      // "Set up Telegram" in the Settings guide opens Telegram's page of the plugin list; Back returns to the sheet.
      await page.locator('#h5-guide-settings .h5-guide-step[data-step="notify"] .h5-guide-step-head')[how]();
      await page.locator('#h5-guide-settings #h5-guide-telegram')[how]();
      await page.locator('.h5-plugin-page[data-name="telegram"] #h5-tg-qr-start').waitFor();
      await page.locator('.h5-plugin-page-back')[how]();
      await page.locator('.h5-plugin-page').waitFor({ state: 'detached' });
      assert.ok(await page.locator('#h5-guide-settings').isVisible());
      await page.locator('#h5-guide-settings .h5-guide-step[data-step="notify"] .h5-guide-step-head')[how]();
      await page.evaluate(() => window.H5UI.set({ settingsOpen: false }));
      await page.locator('#h5-settings').waitFor({ state: 'hidden' });
      // In the panel again (not closed any more); "Set up Telegram" closes the sheet and opens Settings → T-Attention.
      await openPanel(page, how);
      await guide(page).waitFor();
      await page.locator('#h5-guide .h5-guide-step[data-step="notify"] .h5-guide-step-head')[how]();
      await page.locator('#h5-guide-telegram')[how]();
      await page.locator('#h5-settings').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#h5-set-attention .MuiAccordionSummary-root').getAttribute('aria-expanded') === 'true');
      assert.equal(await page.evaluate(() => window.H5UI.get().attention.open), false, 'the phone sheet closed');
      await page.locator('.h5-plugin-page[data-name="telegram"] #h5-tg-qr-start').waitFor();
      assert.equal(await page.locator('.h5-plugin-page-title').textContent(), 'telegram', 'the guide lands on Telegram\'s page');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Computer 1440x900, mouse: pairing, a set-up Telegram, the notifier test ──
    {
      const { context, page, errors, calls, db, how } = await openPage(browser, { viewport: { width: 1440, height: 900 }, touch: false, db: { telegramReady: true, testResults: [{ ok: false, message: 'The plugin is not set up yet' }] } });
      await openPanel(page, how);
      await guide(page).waitFor();
      assert.equal(await stepDone(page, 'notify'), 'true', 'Telegram is on and set up');
      assert.equal(await guide(page).locator('.h5-guide-count').textContent(), '1/3');
      await page.locator('#h5-guide-pair').click();
      await page.locator('#h5-pairing-code').waitFor();
      await page.locator('#h5-pairing-done').waitFor({ timeout: 8000 });
      await page.locator('#h5-pairing-close').click();
      await page.waitForFunction(() => document.querySelector('#h5-guide .h5-guide-step[data-step="claude"]').dataset.done === 'true');
      assert.deepEqual(puts(calls), [{ paired: true }]);
      assert.deepEqual(await openStep(page), ['test']);
      const test = page.locator('#h5-guide .h5-guide-test[data-name="telegram"]');
      assert.equal((await test.textContent()).replace(/\s+/g, ' ').trim(), 'Test telegram');
      await test.click();
      await page.locator('#h5-guide-feedback-panel', { hasText: 'Test failed: The plugin is not set up yet' }).waitFor();
      assert.equal(await stepDone(page, 'test'), 'false', 'a failed test does not finish step 3');
      await test.click();
      await page.locator('#h5-guide .h5-guide-all-done').waitFor();
      await page.locator('#h5-guide-feedback-panel', { hasText: 'Test sent' }).waitFor();
      assert.deepEqual(puts(calls), [{ paired: true }, { tested: true }]);
      assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/api/attention/plugins/telegram/test').length, 2);
      assert.equal(db.guide.tested, true);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-guide.png') });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('h5 attention guide browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
