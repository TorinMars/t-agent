// Browser test of the T-Attention notifier settings (scripts/h5-shell/NotifierSettings.jsx) on a phone-sized page, reached through the plugin list:
// the Telegram login steps (api_id / api_hash / phone -> code -> 2FA password, and the QR login: the code from the server, its refresh, polling only while
// Telegram's page is open, a login left half way shown on the row and again on the page, the 2FA password after the scan), account 2 (the ring time is in the manifest form, PluginConfigForm, not here), the test buttons, the rules (mode per status, delay,
// quiet hours, limits, page address) and that secret fields are never filled from the server. The server is a fake fetch.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
// H5_TEST_WIDTH: the viewport width (390 by default; run it with 320 too).
const WIDTH = Number(process.env.H5_TEST_WIDTH) || 390;
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://app.test/');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/h5.css'), 'utf8') });
    await page.evaluate(() => {
      window.calls = [];
      window.confirm = () => true;
      const rules = { statuses: ['waiting_user', 'failed', 'review'], modes: {}, callDelayMinutes: 0, quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: '' }, rateLimit: { message: 20, call: 6 }, publicUrl: '' };
      window.server = { recent: [{ at: '2026-11-12T10:00:00.000Z', notifier: 'telegram', item_id: 4, status: 'review', mode: 'message', outcome: 'foreground', detail: 'the session is open on screen' }], rules, tg: { loggedIn: false, step: 'none', apiId: null, hasApiHash: false, phone: '', account: null, target: null, callSeconds: 30 } };
      const view = () => ({ rules: server.rules, statuses: ['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled'], modes: ['message', 'call', 'off'], notifiers: [{ name: 'telegram', label: 'Telegram', configFields: [], status: server.tg }], recent: server.recent || [] });
      window.svgOf = n => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="${n}" height="10" fill="#000"/></svg>`;
      window.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ method, url, body });
        const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
        const tg = server.tg;
        if (url.startsWith('/api/system/')) return reply({});
        // The rest of the Settings group "T-Attention" (the notifier settings are drawn in its slot) and the list for the row 2 badge.
        if (url === '/api/attention/tokens') return reply({ tokens: [] });
        if (url === '/api/attention/plugins') return reply({ listeners: [], notifiers: [{ name: 'telegram', version: '1.0.0', description: 'Telegram', loaded: true, error: null, enabled: true, configured: server.tg.loggedIn, summary: server.tg.loggedIn ? 'Logged in as Account One' : 'Not logged in', statuses: {}, settings: true, test: true, customUi: 'telegram' }] });
        if (url === '/api/attention/plugins/telegram/config') return reply({ name: 'telegram', enabled: true, schema: [], test: true, customUi: 'telegram', values: {} });
        if (url === '/api/attention/settings/summary') return reply({ enabled: false, provider: 'deepseek', model: '', providers: [{ id: 'deepseek', label: 'DeepSeek', hasApiKey: false, model: 'deepseek-chat' }] });
        if (url.startsWith('/api/attention') && !url.startsWith('/api/attention-notify')) return reply({ items: [], host: 'mac' });
        if (url === '/api/attention-notify/config' && method === 'GET') return reply(view());
        if (url === '/api/attention-notify/config' && method === 'PUT') { server.rules = { ...server.rules, ...body, modes: body.modes }; return reply(view()); }
        if (url === '/api/attention-notify/telegram/start') { Object.assign(tg, { step: 'code', apiId: Number(body.api_id), phone: '+86*********78' }); return reply({ ...tg, codeVia: 'app' }); }
        if (url === '/api/attention-notify/telegram/verify') { if (body.code !== '24680') return reply({ error: 'The code is wrong' }, 502); tg.step = 'password'; return reply(tg); }
        if (url === '/api/attention-notify/telegram/qr/start') { Object.assign(tg, { step: 'qr', apiId: Number(body.api_id) }); server.qr = { step: 'qr', url: 'tg://login?token=AAA', svg: svgOf(1) }; return reply({ ...tg, ...server.qr }); }
        if (url === '/api/attention-notify/telegram/qr/status') { if (server.qr.step !== 'qr') tg.step = server.qr.step; return reply({ ...tg, ...server.qr }); }
        if (url === '/api/attention-notify/telegram/cancel') { tg.step = 'none'; return reply(tg); }
        if (url === '/api/attention-notify/telegram/password') { Object.assign(tg, { step: 'done', loggedIn: true, hasApiHash: true, account: { id: '1', name: 'Account One', username: 'acc_one' } }); return reply(tg); }
        if (url === '/api/attention-notify/telegram/config') { tg.target = body.target ? { input: body.target.replace(/^@/, ''), name: 'Account Two', username: 'acc_two' } : null; tg.callSeconds = body.callSeconds; return reply(tg); }
        if (url === '/api/attention-notify/telegram/test') return reply({ ok: true, outcome: body.kind === 'call' ? 'timeout' : 'sent' });
        if (url === '/api/attention-notify/telegram/logout') { server.tg = { loggedIn: false, step: 'none', apiId: null, hasApiHash: false, phone: '', account: null, target: null, callSeconds: 30 }; return reply(server.tg); }
        throw new Error(`unexpected ${method} ${url}`);
      };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/h5-shell.js'), 'utf8') });
    await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
    await page.locator('#h5-settings').waitFor({ state: 'visible' });
    const notifyCalls = () => page.evaluate(() => window.calls.filter(call => call.url.startsWith('/api/attention-notify')));
    assert.equal((await notifyCalls()).length, 0, 'nothing is read before the group opens');
    await page.locator('#h5-set-attention .MuiAccordionSummary-root').tap();
    // The list: a row for Telegram and for the rules, no form, and nothing of the notifier settings is read yet.
    const telegramRow = page.locator('#h5-plugins .h5-plugin-notifier[data-name="telegram"]');
    await telegramRow.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#h5-plugins-panel-installed input, #h5-plugins-panel-installed select, #h5-plugins-panel-installed textarea, #h5-tg-qr').count(), 0, 'no config fields on the list');
    assert.equal(await telegramRow.locator('.h5-plugin-summary').textContent(), 'Not logged in');
    assert.equal(await page.locator('#h5-notifier-settings').count(), 0);
    assert.equal((await notifyCalls()).length, 0, 'the list reads no notifier settings');
    // Telegram's page: the login is here; it is read now.
    const back = () => page.locator('.h5-plugin-page-back').last();
    await telegramRow.tap();
    await page.locator('#h5-tg-apiid').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.h5-plugin-page-title').textContent(), 'telegram');
    assert.equal(await page.locator('#h5-notifier-settings').count(), 1, 'drawn once');
    assert.equal(await page.locator('#h5-set-notify').count(), 0, 'and no group of its own');
    assert.equal((await notifyCalls())[0].url, '/api/attention-notify/config');
    assert.equal(await page.locator('#h5-tg-state').textContent(), 'Not logged in');
    // The api_id / api_hash help: the link and four steps. The QR login comes first; the phone login is one tap away.
    assert.equal(await page.getAttribute('#h5-tg-api-link', 'href'), 'https://my.telegram.org/apps');
    assert.equal(await page.locator('#h5-tg-api-help li').count(), 4);
    assert.equal(await page.locator('#h5-tg-qr-start').isVisible(), true);
    assert.equal(await page.locator('#h5-tg-phone').count(), 0);
    // Step 1: api_id, api_hash, phone.
    await page.fill('#h5-tg-apiid', '12345');
    await page.fill('#h5-tg-apihash', '0123456789abcdef0123456789abcdef');
    await page.locator('#h5-tg-use-phone').click();
    await page.fill('#h5-tg-phone', '+8613800000078');
    await page.locator('#h5-tg-start').click();
    await page.locator('#h5-tg-code').waitFor({ state: 'visible' });
    assert.match(await page.locator('#h5-tg-feedback').textContent(), /Code sent to your Telegram app/);
    assert.deepEqual((await notifyCalls()).find(call => call.url.endsWith('/start')).body, { api_id: '12345', api_hash: '0123456789abcdef0123456789abcdef', phone: '+8613800000078' });
    // Step 2: a wrong code shows the error, the right one asks for the password.
    await page.fill('#h5-tg-code', '11111');
    await page.locator('#h5-tg-verify').click();
    await page.waitForFunction(() => /The code is wrong/.test(document.querySelector('#h5-tg-feedback').textContent));
    await page.fill('#h5-tg-code', '24680');
    await page.locator('#h5-tg-verify').click();
    await page.locator('#h5-tg-password').waitFor({ state: 'visible' });
    await page.fill('#h5-tg-password', 'pw');
    await page.locator('#h5-tg-password-send').click();
    await page.locator('#h5-tg-target').waitFor({ state: 'visible' });
    assert.match(await page.locator('#h5-tg-state').textContent(), /Account One \(@acc_one\)/);
    assert.equal(await page.locator('#h5-tg-apihash').count(), 0, 'the login fields are gone once logged in');
    assert.equal(await page.locator('#h5-tg-test').isDisabled(), true, 'no test before account 2 is chosen');
    // Account 2 (no ring time field here any more: it is in the plugin's manifest form); then the test buttons.
    await page.fill('#h5-tg-target', '@acc_two');
    assert.equal(await page.locator('#h5-tg-seconds').count(), 0, 'the old ring time field is gone');
    await page.locator('#h5-tg-save').click();
    await page.waitForFunction(() => /Account Two/.test(document.querySelector('#h5-tg-target-state').textContent));
    assert.deepEqual((await notifyCalls()).find(call => call.url.endsWith('/telegram/config')).body, { target: '@acc_two' });
    assert.equal(await page.inputValue('#h5-tg-target'), 'acc_two', 'the saved target is echoed');
    await page.locator('#h5-tg-test').click();
    await page.waitForFunction(() => /Test message sent/.test(document.querySelector('#h5-tg-feedback').textContent));
    await page.locator('#h5-tg-test-call').click();
    await page.waitForFunction(() => /Rang, no answer/.test(document.querySelector('#h5-tg-feedback').textContent));
    // Rules: a page of their own, opened from the plugin's page ("Message and call rules"); Back returns to the plugin. They are also a row of the list.
    await page.locator('.h5-plugin-page[data-name="telegram"] .h5-plugin-config-rules').click();
    await page.locator('#h5-notify-mode-telegram-waiting_user').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.h5-plugin-page').count(), 2);
    assert.equal(await page.locator('.h5-plugin-page[data-name="rules"] .h5-plugin-page-title').textContent(), 'Message and call rules');
    // The status choices read as what happened: finished (review), needs you, failed; and the foreground rule is said under them.
    const rulesText = await page.locator('.h5-plugin-page[data-name="rules"]').textContent();
    for (const label of ['Finished (ready for review) · Telegram', 'Needs you · Telegram', 'Failed · Telegram']) assert.ok(rulesText.includes(label), `the choice "${label}" is shown`);
    assert.ok(!rulesText.includes('Review · Telegram'), 'the old label is gone');
    assert.equal(await page.locator('#h5-notify-foreground').textContent(), 'No message while the session is open on a screen you used in the last 5 minutes.');
    // A skip because the session was on screen is named in the recent list.
    assert.equal(await page.locator('#h5-notify-recent').textContent().then(text => text.includes('#4 Finished (ready for review) · Skipped: the session was open on screen')), true);
    // Rules: the defaults are echoed (three statuses send a message, the others are off), then saved changed.
    assert.equal(await page.inputValue('#h5-notify-mode-telegram-waiting_user'), 'message');
    assert.equal(await page.inputValue('#h5-notify-mode-telegram-done'), 'off');
    await page.selectOption('#h5-notify-mode-telegram-waiting_user', 'call');
    await page.selectOption('#h5-notify-mode-telegram-review', 'off');
    await page.fill('#h5-notify-delay', '5');
    await page.locator('#h5-notify-quiet').check();
    await page.fill('#h5-notify-quiet-start', '23:00');
    await page.fill('#h5-notify-limit-calls', '3');
    await page.fill('#h5-notify-public-url', 'https://t.example.com');
    await page.locator('#h5-notify-save').click();
    await page.waitForFunction(() => /Saved/.test(document.querySelector('#h5-notify-feedback').textContent));
    const saved = (await notifyCalls()).filter(call => call.url === '/api/attention-notify/config' && call.method === 'PUT').at(-1).body;
    assert.deepEqual(saved.statuses, ['waiting_user', 'failed']);
    assert.equal(saved.modes.telegram.waiting_user, 'call');
    assert.equal(saved.modes.telegram.review, 'off');
    assert.equal(saved.callDelayMinutes, '5');
    assert.equal(saved.quietHours.enabled, true);
    assert.equal(saved.quietHours.start, '23:00');
    assert.ok(saved.quietHours.timeZone, 'the browser time zone is sent');
    assert.deepEqual(saved.rateLimit, { message: '20', call: '3' });
    assert.equal(saved.publicUrl, 'https://t.example.com');
    await back().click();
    await page.locator('.h5-plugin-page[data-name="rules"]').waitFor({ state: 'detached' });
    assert.ok(await page.locator('#h5-tg-logout').isVisible(), 'back on the plugin page');
    // Log out.
    await page.locator('#h5-tg-logout').click();
    await page.locator('#h5-tg-apiid').waitFor({ state: 'visible' });
    assert.equal(await page.inputValue('#h5-tg-apihash'), '', 'secret fields are never filled');
    // QR login: the server-rendered code is shown with the steps, refreshed by polling, not polled while the group is folded, then the 2FA password.
    const qrCalls = async () => (await notifyCalls()).filter(call => call.url.endsWith('/qr/status')).length;
    await page.fill('#h5-tg-apiid', '12345');
    await page.fill('#h5-tg-apihash', '0123456789abcdef0123456789abcdef');
    await page.locator('#h5-tg-use-qr').click();
    await page.locator('#h5-tg-qr-start').click();
    await page.locator('#h5-tg-qr img').waitFor({ state: 'visible' });
    assert.deepEqual((await notifyCalls()).find(call => call.url.endsWith('/qr/start')).body, { api_id: '12345', api_hash: '0123456789abcdef0123456789abcdef' });
    assert.equal(await page.getAttribute('#h5-tg-qr img', 'data-url'), 'tg://login?token=AAA');
    assert.match(await page.getAttribute('#h5-tg-qr img', 'src'), /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    assert.equal(await page.locator('#h5-tg-qr-steps').textContent(), 'Open Telegram on the phone of account 1 \u2192 Settings \u2192 Devices \u2192 Link Desktop Device \u2192 scan this code');
    assert.equal(await page.locator('#h5-tg-apiid').count(), 0, 'the login fields are hidden while the QR is shown');
    await page.evaluate(() => { server.qr = { step: 'qr', url: 'tg://login?token=BBB', svg: svgOf(2) }; });
    await page.waitForFunction(() => document.querySelector('#h5-tg-qr img').dataset.url === 'tg://login?token=BBB', null, { timeout: 5000 });
    const box = await page.locator('#h5-tg-qr').boundingBox();
    assert.ok(box.width >= 200 && box.x >= 16 && box.x + box.width <= WIDTH - 16, `the QR fits the phone width: ${JSON.stringify(box)}`);
    // Leaving the page ends the polling; the row says that a login is under way, and the page shows the current code again.
    await back().tap();
    await page.locator('.h5-plugin-page').waitFor({ state: 'detached' });
    await page.waitForTimeout(600);
    const left = await qrCalls();
    await page.waitForTimeout(4500);
    assert.equal(await qrCalls(), left, 'no polling while the page is closed');
    assert.deepEqual(await telegramRow.locator('.h5-plugin-chip', { hasText: 'Login in progress' }).allTextContents(), ['Login in progress'], 'the row shows the login left half way');
    await telegramRow.tap();
    await page.locator('#h5-tg-qr img').waitFor({ state: 'visible' });
    await page.waitForFunction(n => window.calls.filter(call => call.url.endsWith('/qr/status')).length > n, left);
    assert.equal(await page.getAttribute('#h5-tg-qr img', 'data-url'), 'tg://login?token=BBB', 'the login is still there');
    // After the scan the server asks for the 2FA password.
    await page.evaluate(() => { server.qr = { step: 'password' }; });
    await page.locator('#h5-tg-password').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await page.locator('#h5-tg-feedback').textContent(), /two-step verification password/);
    const settled = await qrCalls();
    await page.fill('#h5-tg-password', 'pw');
    await page.locator('#h5-tg-password-send').click();
    await page.locator('#h5-tg-target').waitFor({ state: 'visible' });
    await page.waitForTimeout(2500);
    assert.equal(await qrCalls(), settled, 'polling stops when the QR step ends');
    assert.deepEqual(errors, []);
    console.log('h5 notifier settings: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
