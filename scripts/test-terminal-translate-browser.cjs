// Terminal Chinese-to-English input: Enter → call translation → type the translation into the terminal and press Enter; on failure keep the original text and show a notice; when not configured open the settings.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const html = read('public/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    await page.route('http://tr.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://tr.test/');
    await page.addStyleTag({ path: path.join(root, 'public/css/style.css') });
    await page.evaluate(() => {
      window.sent = []; window.apiCalls = []; window.modals = [];
      window.escapeHtml = value => String(value);
      window.Modal = { show: (title, html) => { window.modals.push(title); let box = document.getElementById('fake-modal'); if (!box) { box = document.createElement('div'); box.id = 'fake-modal'; document.body.append(box); } box.innerHTML = html; }, hide() {} };
      window.Tasks = { sendTerminalInput: data => { window.sent.push(data); return window.terminalUp; } };
      window.terminalUp = true;
      window.API = { post: async (url, body) => { window.apiCalls.push([url, body]); return window.nextResult(body); }, get: async () => ({}), put: async () => ({}) };
      window.nextResult = body => ({ text: `EN(${body.text})`, translated: true });
    });
    // The terminal panel is hidden by default: show the input and all its ancestors.
    await page.evaluate(() => { for (let el = document.getElementById('terminal-translate'); el && el !== document.body; el = el.parentElement) { el.hidden = false; if (getComputedStyle(el).display === 'none') el.style.display = 'flex'; } });
    await page.addScriptTag({ path: path.join(root, 'public/js/toast.js') });
    await page.addScriptTag({ path: path.join(root, 'public/js/terminal-translate.js') });
    const barHeight = () => page.locator('#terminal-translate').evaluate(el => el.getBoundingClientRect().height);
    const idleHeight = await barHeight();

    const input = page.locator('#terminal-translate-input');
    await input.fill('修复登录页面的 bug');
    await input.press('Enter');
    await page.waitForFunction(() => window.sent.length === 2);
    assert.deepEqual(await page.evaluate(() => window.sent), ['EN(修复登录页面的 bug)', '\r']);
    assert.deepEqual(await page.evaluate(() => window.apiCalls), [['/api/translate', { text: '修复登录页面的 bug' }]]);
    assert.equal(await input.inputValue(), '', 'input is cleared after sending');
    assert.equal(await page.locator('.toast').count(), 0, 'no "sent" echo of the translation after success');

    // While translating: the input pulses, there is no extra text on the same line; restored afterwards.
    await page.evaluate(() => { window.releaseTranslation = null; window.API.post = body => new Promise(resolve => { window.releaseTranslation = () => resolve({ text: 'EN-slow', translated: true }); }); });
    await input.fill('Slow down'); await input.press('Enter');
    await page.waitForFunction(() => document.getElementById('terminal-translate-input').classList.contains('translating'));
    assert.equal(await input.evaluate(el => getComputedStyle(el).animationName), 'translate-breathe');
    assert.equal(await input.evaluate(el => el.readOnly), true);
    assert.equal(await page.locator('.toast').count(), 0, 'no separate "translating" message');
    assert.equal(await barHeight(), idleHeight, 'the bar keeps its height while translating');
    assert.equal(await page.locator('#terminal-translate-send').isDisabled(), true);
    await page.evaluate(() => window.releaseTranslation());
    await page.waitForFunction(() => !document.getElementById('terminal-translate-input').classList.contains('translating'));
    assert.equal(await input.evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.waitForFunction(() => window.sent.length >= 4);
    await page.evaluate(() => { window.sent.length = 0; window.API.post = async (url, body) => ({ text: 'ok\u001b[31m\nnext', translated: true }); });

    // Control characters never reach the terminal
    await input.fill('test'); await input.press('Enter');
    await page.waitForFunction(() => window.sent.length === 2);
    assert.equal((await page.evaluate(() => window.sent))[0], 'ok [31m next');

    // Terminal not connected: nothing is sent, the input is kept, a notice is shown
    await page.evaluate(() => { window.sent.length = 0; window.terminalUp = false; window.nextResult = body => ({ text: 'EN', translated: true }); });
    await input.fill('你好'); await input.press('Enter');
    await page.waitForSelector('.toast.toast-error');
    assert.equal(await input.inputValue(), '你好', 'text is kept when it could not be sent');
    assert.match(await page.locator('.toast-error').first().textContent(), /Terminal not connected/);
    assert.equal(await barHeight(), idleHeight, 'a message must not change the bar height');
    assert.equal(await page.locator('.toast-stack').evaluate(el => getComputedStyle(el).position), 'fixed', 'messages float above the page');

    // Translation failed: keep the original text; not configured: open the settings
    await page.evaluate(() => { window.terminalUp = true; window.API.post = async () => { throw new Error(JSON.stringify({ error: 'Translation service not configured yet' })); }; });
    await input.press('Enter');
    await page.waitForFunction(() => window.modals.length > 0);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => /not configured/i.test(node.textContent)));
    assert.equal(await barHeight(), idleHeight);
    assert.equal(await input.inputValue(), '你好');
    assert.equal(await page.locator('#terminal-translate-send').isDisabled(), false, 'controls are re-enabled after a failure');
    assert.deepEqual(errors, []);
    console.log('terminal translate browser test passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
