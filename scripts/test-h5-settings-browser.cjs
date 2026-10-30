// Browser test of the phone settings groups (the Material UI shell, scripts/h5-shell/Settings.jsx): working directory, image upload, translation, voice input,
// remote service and access mode, on a phone-sized page.
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
      window.makeTr = () => ({ provider: 'deepseek', providers: { deepseek: { label: 'DeepSeek', hasApiKey: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, glm: { label: 'GLM', hasApiKey: false, baseUrl: 'https://glm.example/v4', model: 'glm-4' } } });
      window.makeVi = () => ({ keySource: 'none', region: 'cn', regions: { cn: { label: 'China', endpoint: 'wss://cn.example/ws' }, intl: { label: 'International', endpoint: 'wss://intl.example/ws' } }, language: 'zh', languages: { zh: 'Chinese', en: 'English' }, model: 'asr-1', noiseThreshold: null, hotwords: '', vocabularyId: '', endpoint: '' });
      window.state = { tr: makeTr(), vi: makeVi(), work_dir: null, mode: 'remote', oss: { enabled: false, region: 'oss-cn-hangzhou', bucket: 'b1', accessKeyId: 'id1', prefix: 'p/', publicBaseUrl: '', hasAccessKeySecret: true } };
      window.confirmed = true;
      window.confirm = () => confirmed;
      window.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ method, url, body });
        const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
        if (url === '/auth/me') return reply({ work_dir: state.work_dir, effective_work_dir: '/home/t/tasks', access_mode: state.mode, authenticator_bound: true, listen_host: '127.0.0.1' });
        if (url === '/auth/settings') { state.work_dir = body.work_dir; return reply({ ok: true }); }
        if (url === '/api/oss/config' && method === 'GET') return reply(state.oss);
        if (url === '/api/oss/config' && method === 'PUT') { state.oss = { ...state.oss, ...body, hasAccessKeySecret: true }; delete state.oss.accessKeySecret; return reply(state.oss); }
        if (url === '/api/oss/config' && method === 'DELETE') { state.oss = { enabled: false, hasAccessKeySecret: false }; return reply(state.oss); }
        if (url === '/api/translate/config' && method === 'GET') return reply({ provider: state.tr.provider, providers: state.tr.providers });
        if (url === '/api/translate/config' && method === 'PUT') { state.tr.provider = body.provider; Object.assign(state.tr.providers[body.provider], { baseUrl: body.baseUrl, model: body.model, hasApiKey: state.tr.providers[body.provider].hasApiKey || Boolean(body.apiKey) }); return reply({ ok: true }); }
        if (url === '/api/translate/config' && method === 'DELETE') { state.tr = makeTr(); return reply({ ok: true }); }
        if (url === '/api/speech/config' && method === 'GET') return reply(state.vi);
        if (url === '/api/speech/config' && method === 'PUT') { Object.assign(state.vi, { region: body.region, language: body.language, model: body.model, endpoint: body.endpoint, hotwords: body.hotwords, vocabularyId: body.vocabularyId, noiseThreshold: body.noiseThreshold === '' ? null : Number(body.noiseThreshold), keySource: body.apiKey ? 'saved' : state.vi.keySource }); return reply(state.vi); }
        if (url === '/api/speech/config' && method === 'DELETE') { state.vi = makeVi(); return reply({ ok: true }); }
        if (url === '/api/remote-tokens' && method === 'GET') return reply(state.tokens || [{ id: 5, name: '<img src=x onerror="window.pwned=1">', token_prefix: 'tok_ab', scopes: 'engine' }]);
        if (url === '/api/remote-tokens/pairing') return reply({ code: 'ABCD-1234' });
        if (url === '/api/remote-tokens/5' && method === 'DELETE') { state.tokens = []; return reply({ ok: true }); }
        if (url === '/auth/mode') return reply(state.modeReply || { error: 'AUTH_CODE_INVALID' }, state.modeReply ? 200 : 400);
        throw new Error(`unexpected ${method} ${url}`);
      };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/h5-shell.js'), 'utf8') }); // the shell draws the page, and the settings with it
    await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
    await page.locator('#h5-settings').waitFor({ state: 'visible' });
    const calls = () => page.evaluate(() => window.calls);
    assert.equal((await calls()).length, 0, 'nothing is read until a group is opened');
    assert.deepEqual(await page.locator('.h5-setting-group .MuiAccordionSummary-content').allTextContents(), ['Working directory', 'Image upload', 'Translation', 'Voice input', 'Remote service', 'Access mode']);

    // Working directory: the effective default is shown; an unchanged default stays inherited, a new path is saved, clearing restores the default.
    await page.locator('#h5-set-workdir .MuiAccordionSummary-root').tap();
    await page.waitForFunction(() => document.getElementById('h5-workdir').value === '/home/t/tasks');
    await page.click('#h5-workdir-save');
    await page.waitForFunction(() => calls.some(call => call.url === '/auth/settings'));
    assert.deepEqual((await calls()).find(call => call.url === '/auth/settings').body, { work_dir: null }, 'the untouched default is not saved as a fixed path');
    await page.fill('#h5-workdir', '/data/tasks');
    await page.click('#h5-workdir-save');
    await page.waitForFunction(() => state.work_dir === '/data/tasks' && !document.getElementById('h5-workdir-save').disabled);
    await page.fill('#h5-workdir', '');
    await page.click('#h5-workdir-save');
    await page.waitForFunction(() => calls.filter(call => call.url === '/auth/settings').length === 3 && !document.getElementById('h5-workdir-save').disabled);
    assert.equal(await page.inputValue('#h5-workdir'), '/home/t/tasks', 'clearing the path shows the default in effect');
    assert.equal(await page.evaluate(() => state.work_dir), null);

    // Image upload: values are echoed, the secret is never shown, and an empty secret is sent so the server keeps the saved one.
    await page.locator('#h5-set-oss .MuiAccordionSummary-root').tap();
    await page.waitForFunction(() => document.getElementById('h5-oss-bucket').value === 'b1');
    assert.equal(await page.inputValue('#h5-oss-accessKeySecret'), '');
    assert.equal(await page.locator('#h5-oss-secret-hint').textContent(), 'Secret saved; leave empty to keep it.');
    await page.check('#h5-oss-enabled');
    await page.fill('#h5-oss-bucket', 'b2');
    await page.click('#h5-oss-save');
    await page.waitForFunction(() => state.oss.bucket === 'b2');
    const put = (await calls()).find(call => call.method === 'PUT' && call.url === '/api/oss/config');
    assert.equal(put.body.enabled, true);
    assert.equal(put.body.accessKeySecret, '');
    await page.click('#h5-oss-clear');
    await page.waitForFunction(() => state.oss.hasAccessKeySecret === false && document.getElementById('h5-oss-bucket').value === '');

    // Translation: one key per provider; unsaved input survives switching providers; the saved key is never shown.
    await page.locator('#h5-set-translate .MuiAccordionSummary-root').tap();
    await page.waitForFunction(() => document.getElementById('h5-tr-model').value === 'deepseek-chat');
    assert.deepEqual(await page.locator('#h5-tr-provider option').allTextContents(), ['DeepSeek (Key saved)', 'GLM']);
    assert.equal(await page.inputValue('#h5-tr-key'), '');
    assert.equal(await page.getAttribute('#h5-tr-key', 'placeholder'), 'Saved; leave empty to keep it');
    await page.fill('#h5-tr-model', 'deepseek-reasoner');
    await page.selectOption('#h5-tr-provider', 'glm');
    assert.equal(await page.inputValue('#h5-tr-model'), 'glm-4');
    await page.fill('#h5-tr-key', 'glm-secret');
    await page.selectOption('#h5-tr-provider', 'deepseek');
    assert.equal(await page.inputValue('#h5-tr-model'), 'deepseek-reasoner', 'input that is not saved yet is kept');
    await page.selectOption('#h5-tr-provider', 'glm');
    assert.equal(await page.inputValue('#h5-tr-key'), 'glm-secret');
    await page.click('#h5-tr-save');
    await page.waitForFunction(() => state.tr.provider === 'glm' && state.tr.providers.glm.hasApiKey);
    const trPut = (await calls()).find(call => call.method === 'PUT' && call.url === '/api/translate/config');
    assert.deepEqual(trPut.body, { provider: 'glm', apiKey: 'glm-secret', baseUrl: 'https://glm.example/v4', model: 'glm-4' });
    await page.waitForFunction(() => document.getElementById('h5-tr-key').value === '');
    assert.equal(await page.locator('#h5-tr-provider').inputValue(), 'glm', 'the provider in use is selected after saving');
    await page.click('#h5-tr-clear');
    await page.waitForFunction(() => state.tr.provider === 'deepseek' && !state.tr.providers.glm.hasApiKey);

    // Voice input: the key is never echoed, the address in use follows the region and a custom endpoint, an empty noise filter is the service default.
    await page.locator('#h5-set-voice .MuiAccordionSummary-root').tap();
    await page.waitForFunction(() => document.getElementById('h5-vi-model').value === 'asr-1');
    assert.equal(await page.getAttribute('#h5-vi-key', 'placeholder'), 'API Key');
    assert.equal(await page.locator('#h5-vi-effective').textContent(), 'Address in use: wss://cn.example/ws');
    await page.selectOption('#h5-vi-region', 'intl');
    assert.equal(await page.locator('#h5-vi-effective').textContent(), 'Address in use: wss://intl.example/ws');
    await page.fill('#h5-vi-url', 'wss://mine.example/ws');
    assert.equal(await page.locator('#h5-vi-effective').textContent(), 'Address in use: wss://mine.example/ws');
    await page.fill('#h5-vi-key', 'dash-secret');
    await page.fill('#h5-vi-noise', '0.3');
    await page.fill('#h5-vi-hotwords', 'Claude\nCodex');
    await page.selectOption('#h5-vi-language', 'en');
    await page.click('#h5-vi-save');
    await page.waitForFunction(() => state.vi.keySource === 'saved');
    const viPut = (await calls()).find(call => call.method === 'PUT' && call.url === '/api/speech/config');
    assert.deepEqual(viPut.body, { apiKey: 'dash-secret', region: 'intl', language: 'en', model: 'asr-1', endpoint: 'wss://mine.example/ws', noiseThreshold: '0.3', hotwords: 'Claude\nCodex', vocabularyId: '' });
    await page.waitForFunction(() => document.getElementById('h5-vi-key').value === '' && document.getElementById('h5-vi-key').placeholder === 'Saved; leave empty to keep it');
    assert.equal(await page.inputValue('#h5-vi-noise'), '0.3');
    await page.click('#h5-vi-clear');
    await page.waitForFunction(() => state.vi.keySource === 'none' && document.getElementById('h5-vi-region').value === 'cn' && document.getElementById('h5-vi-noise').value === '');

    // Remote service: tokens are drawn as text, a pairing code can be made, a token can be revoked.
    await page.locator('#h5-set-remote .MuiAccordionSummary-root').tap();
    await page.waitForSelector('.h5-token-row');
    assert.equal(await page.locator('#h5-remote-origin').textContent(), 'http://app.test');
    assert.equal(await page.locator('.h5-token-row img').count(), 0);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    await page.click('#h5-token-create');
    await page.waitForSelector('#h5-token-created:not([hidden])');
    assert.equal(await page.locator('#h5-token-code').textContent(), 'ABCD-1234');
    await page.locator('.h5-token-row button').tap();
    await page.waitForFunction(() => !document.querySelector('.h5-token-row'));
    assert.equal(await page.locator('#h5-token-list').textContent(), 'No tokens created yet');

    // Access mode: external access is on; switching to local access only asks first, and a refused code is explained.
    await page.locator('#h5-set-access .MuiAccordionSummary-root').tap();
    await page.waitForFunction(() => document.getElementById('h5-access-switch').textContent !== '');
    assert.equal(await page.locator('#h5-access-title').textContent(), 'Authenticator + allow external access');
    assert.match(await page.locator('#h5-access-hint').textContent(), /listens only on 127\.0\.0\.1/);
    assert.equal(await page.locator('#h5-access-code-row').isHidden(), true);
    await page.evaluate(() => { window.confirmed = false; });
    await page.click('#h5-access-switch');
    assert.equal((await calls()).filter(call => call.url === '/auth/mode').length, 0, 'declining the question changes nothing');
    await page.evaluate(() => { window.confirmed = true; });
    await page.click('#h5-access-switch');
    await page.waitForFunction(() => !document.getElementById('h5-access-feedback').hidden);
    assert.equal(await page.locator('#h5-access-feedback').textContent(), 'The code is invalid or already used. Wait for the next code.');
    assert.deepEqual((await calls()).find(call => call.url === '/auth/mode').body, { mode: 'local' });
    assert.equal(await page.locator('#h5-authenticator-replace').getAttribute('href'), '/auth/setup?return_to=/h5');

    // Nothing is wider than the phone.
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    assert.deepEqual(errors, []);
    console.log('h5 settings groups: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
