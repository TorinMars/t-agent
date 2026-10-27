// Real settings UI with deterministic HTTP responses; no microphone or vendor credentials are used.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pcmWav } = require('../public/js/speaker-filter');
const root = path.resolve(__dirname, '../public');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let config = { appId: '', hasApiKey: false, hasApiSecret: false, enabled: false, enrolled: false, threshold: 0.75 };
    const calls = [];
    page.on('pageerror', error => { throw error; });
    await page.route('http://speaker-filter.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        const method = route.request().method(), body = route.request().postDataJSON();
        calls.push({ path: url.pathname, method, body });
        if (method === 'PUT') config = { ...config, appId: body.appId, hasApiKey: true, hasApiSecret: true, enabled: body.enabled, threshold: Number(body.threshold) };
        if (url.pathname.endsWith('/enroll')) config = { ...config, enrolled: true };
        if (method === 'DELETE') config = { appId: '', hasApiKey: false, hasApiSecret: false, enabled: false, enrolled: false, threshold: 0.75 };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(config) });
      }
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/speaker-filter.css"><button id="settings" onclick="SpeakerFilter.showSettings()">Settings</button><script src="/js/speaker-filter.js"></script>' });
      const name = url.pathname.slice(1);
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript', body: fs.readFileSync(path.join(root, name)) });
    });
    await page.goto('http://speaker-filter.test/');
    await page.click('#settings');
    await page.waitForSelector('#sf-feedback');
    assert.equal(await page.locator('#sf-enabled').isDisabled(), true);
    await page.fill('#sf-app', 'testapp'); await page.fill('#sf-key', 'testkey'); await page.fill('#sf-secret', 'testsecret');
    await page.click('#sf-save');
    await page.waitForFunction(() => document.querySelector('#sf-key').value === '');
    assert.equal(await page.inputValue('#sf-secret'), '', 'saved credentials are not echoed');
    await page.locator('#sf-file').setInputFiles({ name: 'sample.wav', mimeType: 'audio/wav', buffer: Buffer.from(pcmWav(new Int16Array(160000))) });
    await page.waitForFunction(() => document.querySelector('#sf-feedback').textContent.includes('sample ready'));
    await page.click('#sf-enroll');
    await page.waitForFunction(() => !document.querySelector('#sf-enabled').disabled);
    const enrollment = calls.find(call => call.path.endsWith('/enroll'));
    assert.equal(Buffer.from(enrollment.body.audio, 'base64').length, 320044);
    assert.equal(config.enabled, false, 'enrollment does not turn on filtering without the person choosing it');
    await page.check('#sf-enabled'); await page.click('#sf-save');
    await page.waitForFunction(() => document.querySelector('#sf-save').disabled === false);
    assert.equal(config.enabled, true);
    assert.equal(await page.locator('.sf-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'the dialog fits a phone');
    await page.screenshot({ path: '/tmp/iflytek-speaker-settings.png' });
    await page.click('#sf-delete');
    await page.waitForFunction(() => document.querySelector('#sf-enabled').disabled);
    assert.equal(config.enrolled, false);
    await page.click('#sf-close');
    assert.equal(await page.locator('.sf-overlay').count(), 0);
    await page.click('#settings'); await page.waitForSelector('.sf-dialog');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.sf-overlay').count(), 0);
    console.log('Speaker filter settings: credentials, WAV enrollment, explicit enable, delete and phone layout passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
