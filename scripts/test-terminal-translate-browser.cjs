// 终端中译英输入框：回车 → 调用翻译 → 把译文键入终端并回车；失败时保留原文并提示；未配置时打开设置。
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
    // 终端面板默认隐藏：把输入框及其所有祖先显示出来。
    await page.evaluate(() => { for (let el = document.getElementById('terminal-translate'); el && el !== document.body; el = el.parentElement) { el.hidden = false; if (getComputedStyle(el).display === 'none') el.style.display = 'flex'; } });
    await page.addScriptTag({ path: path.join(root, 'public/js/terminal-translate.js') });

    const input = page.locator('#terminal-translate-input');
    await input.fill('修复登录页面的 bug');
    await input.press('Enter');
    await page.waitForFunction(() => window.sent.length === 2);
    assert.deepEqual(await page.evaluate(() => window.sent), ['EN(修复登录页面的 bug)', '\r']);
    assert.deepEqual(await page.evaluate(() => window.apiCalls), [['/api/translate', { text: '修复登录页面的 bug' }]]);
    assert.equal(await input.inputValue(), '', 'input is cleared after sending');
    assert.equal(await page.locator('#terminal-translate-status').textContent(), '', 'no "sent" echo of the translation after success');
    assert.equal(await page.locator('#terminal-translate-status').isVisible(), false);

    // 控制字符不会进入终端
    await page.evaluate(() => { window.sent.length = 0; window.nextResult = () => ({ text: 'ok\u001b[31m\nnext', translated: true }); });
    await input.fill('测试'); await input.press('Enter');
    await page.waitForFunction(() => window.sent.length === 2);
    assert.equal((await page.evaluate(() => window.sent))[0], 'ok [31m next');

    // 终端没连上：不发送、保留输入、提示
    await page.evaluate(() => { window.sent.length = 0; window.terminalUp = false; window.nextResult = body => ({ text: 'EN', translated: true }); });
    await input.fill('你好'); await input.press('Enter');
    await page.waitForFunction(() => document.getElementById('terminal-translate-status').classList.contains('error'));
    assert.equal(await input.inputValue(), '你好', 'text is kept when it could not be sent');
    assert.match(await page.locator('#terminal-translate-status').textContent(), /终端未连接/);

    // 翻译失败：保留原文；未配置：打开设置
    await page.evaluate(() => { window.terminalUp = true; window.API.post = async () => { throw new Error(JSON.stringify({ error: '尚未配置翻译服务' })); }; });
    await input.press('Enter');
    await page.waitForFunction(() => window.modals.length > 0);
    assert.match(await page.locator('#terminal-translate-status').textContent(), /尚未配置/);
    assert.equal(await input.inputValue(), '你好');
    assert.equal(await page.locator('#terminal-translate-send').isDisabled(), false, 'controls are re-enabled after a failure');
    assert.deepEqual(errors, []);
    console.log('terminal translate browser test passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
