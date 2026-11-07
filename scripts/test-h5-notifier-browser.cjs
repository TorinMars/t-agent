// Browser test of the T-Attention notifier settings (scripts/h5-shell/NotifierSettings.jsx) on a phone-sized page: the Telegram login steps
// (api_id / api_hash / phone -> code -> 2FA password), account 2 and the ring time, the test buttons, the rules (mode per status, delay,
// quiet hours, limits, page address) and that secret fields are never filled from the server. The server is a fake fetch.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://app.test/');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/h5.css'), 'utf8') });
    await page.evaluate(() => {
      window.calls = [];
      window.confirm = () => true;
      const rules = { statuses: ['waiting_user', 'failed', 'review'], modes: {}, callDelayMinutes: 0, quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: '' }, rateLimit: { message: 20, call: 6 }, publicUrl: '' };
      window.server = { rules, tg: { loggedIn: false, step: 'none', apiId: null, hasApiHash: false, phone: '', account: null, target: null, callSeconds: 30 } };
      const view = () => ({ rules: server.rules, statuses: ['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled'], modes: ['message', 'call', 'off'], notifiers: [{ name: 'telegram', label: 'Telegram', configFields: [], status: server.tg }], recent: server.recent || [] });
      window.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ method, url, body });
        const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
        const tg = server.tg;
        if (url.startsWith('/api/system/')) return reply({});
        if (url === '/api/attention-notify/config' && method === 'GET') return reply(view());
        if (url === '/api/attention-notify/config' && method === 'PUT') { server.rules = { ...server.rules, ...body, modes: body.modes }; return reply(view()); }
        if (url === '/api/attention-notify/telegram/start') { Object.assign(tg, { step: 'code', apiId: Number(body.api_id), phone: '+86*********78' }); return reply({ ...tg, codeVia: 'app' }); }
        if (url === '/api/attention-notify/telegram/verify') { if (body.code !== '24680') return reply({ error: 'The code is wrong' }, 502); tg.step = 'password'; return reply(tg); }
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
    await page.locator('#h5-set-notify .MuiAccordionSummary-root').tap();
    await page.locator('#h5-tg-apiid').waitFor({ state: 'visible' });
    assert.equal((await notifyCalls())[0].url, '/api/attention-notify/config');
    assert.equal(await page.locator('#h5-tg-state').textContent(), 'Not logged in');
    // Step 1: api_id, api_hash, phone.
    await page.fill('#h5-tg-apiid', '12345');
    await page.fill('#h5-tg-apihash', '0123456789abcdef0123456789abcdef');
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
    // Account 2 and the ring time; then the test buttons.
    await page.fill('#h5-tg-target', '@acc_two');
    await page.fill('#h5-tg-seconds', '45');
    await page.locator('#h5-tg-save').click();
    await page.waitForFunction(() => /Account Two/.test(document.querySelector('#h5-tg-target-state').textContent));
    assert.deepEqual((await notifyCalls()).find(call => call.url.endsWith('/telegram/config')).body, { target: '@acc_two', callSeconds: 45 });
    assert.equal(await page.inputValue('#h5-tg-target'), 'acc_two', 'the saved target is echoed');
    await page.locator('#h5-tg-test').click();
    await page.waitForFunction(() => /Test message sent/.test(document.querySelector('#h5-tg-feedback').textContent));
    await page.locator('#h5-tg-test-call').click();
    await page.waitForFunction(() => /Rang, no answer/.test(document.querySelector('#h5-tg-feedback').textContent));
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
    // Log out.
    await page.locator('#h5-tg-logout').click();
    await page.locator('#h5-tg-apiid').waitFor({ state: 'visible' });
    assert.equal(await page.inputValue('#h5-tg-apihash'), '', 'secret fields are never filled');
    assert.deepEqual(errors, []);
    console.log('h5 notifier settings: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
