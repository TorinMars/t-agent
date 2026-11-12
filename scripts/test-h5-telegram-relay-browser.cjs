// Browser test of the one Telegram sender of linked devices on Telegram's settings page (scripts/h5-shell/NotifierSettings.jsx, `relay` of
// GET /api/attention-notify/config, services/attention-relay.js): the sender with the devices that send through it, a device that relays (not logged in:
// the login is one tap away; logged in: "Use this device as the sender" and "Log out here"), the switch, the test through the sender, an offline sender,
// the choice when several devices are logged in, and the recent list. At 390px (touch), 1280px (mouse) and in Chinese at 390px; the page never scrolls
// sideways. The server is a fake fetch. H5_SHOT_DIR=<dir> saves screenshots there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const SHOTS = process.env.H5_SHOT_DIR;
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const loggedIn = { loggedIn: true, step: 'done', apiId: 12345, hasApiHash: true, phone: '+86*********78', account: { id: '1', name: 'Account One', username: 'acc_one' }, target: { input: 'acc_two', name: 'Account Two', username: 'acc_two' }, callSeconds: 30 };
const loggedOut = { loggedIn: false, step: 'none', apiId: null, hasApiHash: false, phone: '', account: null, target: null, callSeconds: 30 };
const senderView = (fields = {}) => ({ notifier: 'telegram', me: { name: 'T01', ready: true }, linked: 2, sender: { name: 'T01', self: true, online: true }, explicit: true, conflict: false, relaying: [{ name: 'K01', online: true }, { name: 'K02 laptop with a long name that has to wrap on a phone', online: false }], ...fields });
const relayingView = (fields = {}) => ({ notifier: 'telegram', me: { name: 'K01', ready: false }, linked: 1, sender: { name: 'T01', self: false, online: true }, explicit: false, conflict: false, relaying: [], ...fields });

async function openPage(browser, { wide = false, zh = false, state }) {
  const width = wide ? 1280 : 390;
  const context = await browser.newContext({ viewport: { width, height: 844 }, ...(wide ? {} : { isMobile: true, hasTouch: true }), ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  await page.addStyleTag({ content: read('public/css/h5.css') });
  if (zh) {
    await page.evaluate(() => localStorage.setItem('ta-lang', 'zh'));
    for (const file of ['public/js/i18n.js', 'public/js/i18n-zh-ui.js', 'public/js/i18n-zh-server.js', 'public/js/i18n-zh-extra.js']) await page.addScriptTag({ content: read(file) });
  }
  await page.evaluate(initial => {
    window.calls = [];
    window.confirm = () => true;
    window.server = initial;
    const rules = { statuses: ['waiting_user', 'failed', 'review'], modes: {}, callDelayMinutes: 0, quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: '' }, rateLimit: { message: 20, call: 6 }, publicUrl: '' };
    const view = () => ({ rules, statuses: ['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled'], modes: ['message', 'call', 'off'], notifiers: [{ name: 'telegram', label: 'Telegram', configFields: [], status: server.tg }], recent: server.recent || [], relay: server.relay });
    window.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method, url, body });
      const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/system/')) return reply({});
      if (url === '/api/attention/tokens') return reply({ tokens: [] });
      if (url === '/api/attention/plugins') return reply({ listeners: [], notifiers: [{ name: 'telegram', version: '1.0.0', description: 'Telegram', loaded: true, error: null, enabled: true, configured: true, summary: server.relay.sender.self ? 'Logged in' : `Sent through ${server.relay.sender.name}`, statuses: {}, settings: true, test: true, customUi: 'telegram' }] });
      if (url === '/api/attention/plugins/telegram/config') return reply({ name: 'telegram', enabled: true, schema: [], test: true, customUi: 'telegram', values: {} });
      if (url === '/api/attention/settings/summary') return reply({ enabled: false, provider: 'deepseek', model: '', providers: [{ id: 'deepseek', label: 'DeepSeek', hasApiKey: false, model: 'deepseek-chat' }] });
      if (url.startsWith('/api/attention') && !url.startsWith('/api/attention-notify')) return reply({ items: [], host: 'mac' });
      if (url === '/api/attention-notify/config' && method === 'GET') return reply(view());
      if (url === '/api/attention-notify/relay/test') return server.relay.sender.online ? reply({ ok: true, outcome: 'sent', via: server.relay.sender.name }) : reply({ error: 'The sender device is offline; try again when it is online' }, 502);
      if (url === '/api/attention-notify/relay/sender' && method === 'PUT') {
        server.relay = { ...server.relay, me: { ...server.relay.me, ready: true }, sender: { name: server.relay.me.name, self: true, online: true }, explicit: true, conflict: false, relaying: [{ name: 'T01', online: true }] };
        return reply({ told: 1, offline: 0, relay: server.relay });
      }
      if (url === '/api/attention-notify/telegram/logout') { server.tg = { loggedIn: false, step: 'none', apiId: null, hasApiHash: false, phone: '', account: null, target: null, callSeconds: 30 }; return reply(server.tg); }
      if (url === '/api/attention-notify/telegram/test') return reply({ ok: true, outcome: 'sent' });
      if (url === '/api/attention-notify/telegram/qr/start') { server.tg = { ...server.tg, step: 'qr' }; return reply({ ...server.tg, step: 'qr', url: 'tg://login?token=AAA', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>' }); }
      if (url === '/api/attention-notify/telegram/qr/status') return reply({ ...server.tg, step: 'qr', url: 'tg://login?token=AAA', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>' });
      throw new Error(`unexpected ${method} ${url}`);
    };
  }, state);
  await page.addScriptTag({ content: read('public/js/h5-shell.js') });
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  const press = locator => (wide ? locator.click() : locator.tap());
  await press(page.locator('#h5-set-attention .MuiAccordionSummary-root'));
  const row = page.locator('#h5-plugins .h5-plugin-notifier[data-name="telegram"]');
  await row.waitFor({ state: 'visible' });
  await press(row);
  await page.locator('#h5-notifier-settings #h5-tg-state').waitFor({ state: 'visible', timeout: 10000 }).catch(error => { throw new Error(`the Telegram page did not open: ${error.message}; page errors: ${errors.join(' | ')}`); });
  const calls = () => page.evaluate(() => window.calls.filter(call => call.url.startsWith('/api/attention-notify')));
  const fits = async label => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${label}: the page scrolls sideways by ${overflow}px`);
    const box = await page.locator('#h5-tg-relay').boundingBox();
    if (box) assert.ok(box.x >= 0 && box.x + box.width <= width, `${label}: the relay part fits: ${JSON.stringify(box)}`);
  };
  const shot = async name => { if (SHOTS) { await page.locator('#h5-notifier-settings').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, `telegram-relay-${name}${wide ? '-wide' : ''}${zh ? '-zh' : ''}.png`) }); } };
  return { context, page, errors, press, calls, fits, shot };
}

async function senderCase(browser, wide) {
  const { context, page, errors, fits, shot } = await openPage(browser, { wide, state: { tg: { ...loggedIn }, relay: senderView(), recent: [{ at: '2026-11-12T10:00:00.000Z', notifier: 'telegram', item_id: 4, status: 'waiting_user', mode: 'message', outcome: 'sent', origin: 'K01' }] } });
  await page.locator('#h5-tg-relay[data-role="sender"]').waitFor();
  assert.equal(await page.locator('#h5-tg-relay-note').textContent(), 'This device sends Telegram notifications for all linked devices');
  assert.deepEqual(await page.locator('#h5-tg-relay-list li').allTextContents(), ['K01 \u00b7 Online', 'K02 laptop with a long name that has to wrap on a phone \u00b7 Offline']);
  assert.equal(await page.locator('#h5-tg-use-here').count(), 0, 'the chosen sender needs no switch');
  assert.ok(await page.locator('#h5-tg-target').isVisible(), 'the sender keeps its own Telegram settings');
  assert.ok(await page.locator('#h5-tg-logout').isVisible());
  assert.equal(await page.locator('#h5-tg-relay-test').count(), 0);
  await fits('sender');
  await shot('sender');
  // The rules page lists a relayed delivery with the device it came from.
  await page.locator('.h5-plugin-page[data-name="telegram"] .h5-plugin-config-rules').click();
  await page.locator('#h5-notify-recent').waitFor();
  assert.match(await page.locator('#h5-notify-recent').textContent(), /#4 Needs you \u00b7 Sent \u00b7 From K01/);
  assert.deepEqual(errors, []);
  await context.close();
}

async function relayingCase(browser, wide) {
  // Not logged in here: the note, the online state, the test through the sender; the login is behind one tap.
  const first = await openPage(browser, { wide, state: { tg: { ...loggedOut }, relay: relayingView(), recent: [{ at: '2026-11-12T10:00:00.000Z', notifier: 'telegram', item_id: 7, status: 'failed', mode: 'message', outcome: 'relayed', detail: 'sent', via: 'T01' }, { at: '2026-11-12T10:01:00.000Z', notifier: 'telegram', item_id: 8, status: 'failed', mode: 'message', outcome: 'relay_offline', detail: 'REMOTE_OFFLINE', via: 'T01' }] } });
  let { page } = first;
  await page.locator('#h5-tg-relay[data-role="relaying"]').waitFor();
  assert.equal(await page.locator('#h5-tg-relay-note').textContent(), 'Telegram notifications are sent through T01 \u00b7 Online');
  assert.equal(await page.locator('#h5-tg-apiid').count(), 0, 'no login form while another device sends');
  assert.equal(await page.locator('#h5-tg-use-here').count(), 0, 'not logged in here: nothing to switch');
  assert.equal(await page.locator('#h5-tg-logout-here').count(), 0);
  await first.fits('relaying');
  await first.shot('relaying');
  await first.press(page.locator('#h5-tg-relay-test'));
  await page.waitForFunction(() => /Test message sent through T01/.test(document.querySelector('#h5-tg-feedback').textContent));
  assert.deepEqual((await first.calls()).find(call => call.url.endsWith('/relay/test')).body, { kind: 'message' });
  await first.press(page.locator('#h5-tg-login-here'));
  await page.locator('#h5-tg-qr-start').waitFor({ state: 'visible' });
  assert.ok(await page.locator('#h5-tg-apiid').isVisible());
  await page.locator('.h5-plugin-page[data-name="telegram"] .h5-plugin-config-rules').click();
  await page.locator('#h5-notify-recent').waitFor();
  const recent = await page.locator('#h5-notify-recent').textContent();
  assert.match(recent, /#7 Failed \u00b7 Sent through the sender device \u00b7 Through T01/);
  assert.match(recent, /#8 Failed \u00b7 Not sent: the sender device is offline \u00b7 Through T01/);
  assert.deepEqual(first.errors, []);
  await first.context.close();

  // Logged in here too: "Use this device as the sender" switches; the page then shows this device as the sender.
  const second = await openPage(browser, { wide, state: { tg: { ...loggedIn }, relay: relayingView({ me: { name: 'K01', ready: true } }) } });
  page = second.page;
  await page.locator('#h5-tg-relay-own').waitFor();
  assert.equal(await page.locator('#h5-tg-target').count(), 0, 'its own Telegram settings are hidden while it does not send');
  assert.equal(await page.locator('#h5-tg-logout').count(), 0);
  assert.ok(await page.locator('#h5-tg-use-here').isVisible());
  assert.ok(await page.locator('#h5-tg-logout-here').isVisible());
  await second.fits('relaying, logged in');
  await second.shot('relaying-logged-in');
  await second.press(page.locator('#h5-tg-use-here'));
  await page.locator('#h5-tg-relay[data-role="sender"]').waitFor();
  assert.match(await page.locator('#h5-tg-feedback').textContent(), /This device is now the sender/);
  assert.deepEqual((await second.calls()).find(call => call.url.endsWith('/relay/sender')), { method: 'PUT', url: '/api/attention-notify/relay/sender', body: { use: 'self' } });
  assert.deepEqual(await page.locator('#h5-tg-relay-list li').allTextContents(), ['T01 \u00b7 Online']);
  assert.ok(await page.locator('#h5-tg-target').isVisible(), 'its own Telegram settings are back');
  assert.deepEqual(second.errors, []);
  await second.context.close();

  // "Log out here" on a device that relays: the login is gone, the note stays.
  const third = await openPage(browser, { wide, state: { tg: { ...loggedIn }, relay: relayingView({ me: { name: 'K01', ready: true }, sender: { name: 'T01', self: false, online: false } }) } });
  page = third.page;
  await page.locator('#h5-tg-logout-here').waitFor();
  assert.equal(await page.locator('#h5-tg-relay-note').textContent(), 'Telegram notifications are sent through T01 \u00b7 Offline');
  await third.press(page.locator('#h5-tg-relay-test'));
  await page.waitForFunction(() => /The sender device is offline/.test(document.querySelector('#h5-tg-feedback').textContent));
  await third.press(page.locator('#h5-tg-logout-here'));
  await page.locator('#h5-tg-login-here').waitFor();
  assert.equal(await page.locator('#h5-tg-logout-here').count(), 0);
  assert.equal(await page.locator('#h5-tg-state').textContent(), 'Not logged in');
  assert.ok((await third.calls()).some(call => call.url === '/api/attention-notify/telegram/logout' && call.method === 'POST'));
  assert.deepEqual(third.errors, []);
  await third.context.close();
}

async function conflictCase(browser, wide) {
  const { context, page, errors, press, fits } = await openPage(browser, { wide, state: { tg: { ...loggedIn }, relay: senderView({ explicit: false, conflict: true, relaying: [] }) } });
  await page.locator('#h5-tg-relay-conflict').waitFor();
  assert.equal(await page.locator('#h5-tg-relay-list-empty').textContent(), 'No linked device sends through this one yet.');
  await press(page.locator('#h5-tg-use-here'));
  await page.locator('#h5-tg-relay-conflict').waitFor({ state: 'detached' });
  await fits('conflict');
  assert.deepEqual(errors, []);
  await context.close();
}

async function chineseCase(browser) {
  const relaying = await openPage(browser, { zh: true, state: { tg: { ...loggedIn }, relay: relayingView({ me: { name: 'K01', ready: true } }) } });
  let { page } = relaying;
  assert.equal(await page.evaluate(() => I18n.get()), 'zh');
  await page.locator('#h5-tg-relay-own').waitFor();
  assert.equal(await page.locator('#h5-tg-relay-note').textContent(), `Telegram \u901a\u77e5\u901a\u8fc7 T01 \u53d1\u9001 \u00b7 ${await page.evaluate(() => I18n.t('Online'))}`);
  const text = await page.locator('#h5-tg-relay').innerText();
  assert.match(text, /\u6539\u7531\u8fd9\u53f0\u8bbe\u5907\u53d1\u9001/);
  assert.match(text, /\u5728\u8fd9\u53f0\u8bbe\u5907\u4e0a\u9000\u51fa/);
  assert.doesNotMatch(text, /Use this device|Log out here|sent through|logged in/, 'no English left');
  await relaying.fits('Chinese relaying');
  await relaying.shot('relaying-logged-in');
  await relaying.press(page.locator('#h5-tg-relay-test'));
  await page.waitForFunction(() => /\u6d4b\u8bd5\u6d88\u606f\u5df2\u901a\u8fc7 T01 \u53d1\u51fa/.test(document.querySelector('#h5-tg-feedback').textContent));
  assert.deepEqual(relaying.errors, []);
  await relaying.context.close();
  const sender = await openPage(browser, { zh: true, state: { tg: { ...loggedIn }, relay: senderView() } });
  page = sender.page;
  await page.locator('#h5-tg-relay-list').waitFor();
  const senderText = await page.locator('#h5-tg-relay').innerText();
  assert.match(senderText, /\u8fd9\u53f0\u8bbe\u5907\u4e3a\u6240\u6709\u5173\u8054\u8bbe\u5907\u53d1\u9001 Telegram \u901a\u77e5/);
  assert.doesNotMatch(senderText, /This device|Devices that/, 'no English left');
  await sender.fits('Chinese sender');
  await sender.shot('sender');
  assert.deepEqual(sender.errors, []);
  await sender.context.close();
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const wide of [false, true]) {
      await senderCase(browser, wide);
      await relayingCase(browser, wide);
      await conflictCase(browser, wide);
    }
    await chineseCase(browser);
    console.log('h5 telegram relay settings: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
