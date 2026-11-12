// Browser test of the peer file access switch in Settings → Engines (scripts/h5-shell/PeerFs.jsx), with the routes mocked: it is read when the
// group opens and echoes the server's value, a change is saved at once, a refused save shows the error and the value in effect, it is read
// again each time the group opens, an older server (404) shows nothing, and the Chinese page shows the dictionary text.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');

async function openPage(browser, { supported = true, enabled = false, zh = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/h5.css'), 'utf8') });
  if (zh) {
    await page.evaluate(() => localStorage.setItem('ta-lang', 'zh')); // read by i18n.js when it loads
    for (const file of ['i18n.js', 'i18n-zh-ui.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });
    assert.equal(await page.evaluate(() => I18n.get()), 'zh');
  }
  await page.evaluate(({ supported, enabled }) => {
    window.calls = [];
    window.peer = { supported, enabled, failNext: null };
    window.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method, url, body });
      const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/peer-fs/settings') {
        if (!peer.supported) return new Response('Cannot GET /api/peer-fs/settings', { status: 404 });
        if (method === 'PUT') {
          if (peer.failNext) { const failed = peer.failNext; peer.failNext = null; return reply(failed.body, failed.status); }
          peer.enabled = body.enabled;
        }
        return reply({ enabled: peer.enabled });
      }
      if (url === '/api/remote-servers') return reply([]);
      return new Response('Not found', { status: 404 }); // the other reads of the page and the sheet: an older server
    };
  }, { supported, enabled });
  await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/h5-shell.js'), 'utf8') });
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  const peerCalls = () => page.evaluate(() => window.calls.filter(call => call.url === '/api/peer-fs/settings'));
  const toggleGroup = async () => {
    await page.locator('#h5-set-engines .MuiAccordionSummary-root').tap();
  };
  const openGroup = async () => {
    await toggleGroup();
    await page.waitForFunction(() => Boolean(document.querySelector('#h5-set-engines .MuiCollapse-entered')));
  };
  return { page, errors, peerCalls, openGroup, toggleGroup };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // A current server, the switch off.
    {
      const { page, errors, peerCalls, openGroup, toggleGroup } = await openPage(browser, { enabled: false });
      assert.equal((await peerCalls()).length, 0, 'nothing is read until the Engines group is opened');
      await openGroup();
      await page.waitForFunction(() => { const input = document.getElementById('h5-peer-fs-enabled'); return input && !input.disabled; });
      assert.equal(await page.isChecked('#h5-peer-fs-enabled'), false, 'the saved value (off) is echoed');
      const label = await page.getAttribute('#h5-peer-fs-enabled', 'aria-label');
      assert.equal(label, 'Sessions can read files on linked engines');
      const text = await page.locator('#h5-peer-fs').textContent();
      assert.match(text, /home folder/);
      assert.match(text, /~\/\.ssh and \.env/);
      assert.match(text, /Read only/);
      assert.match(text, /linked engines can read this engine’s files/);
      assert.match(text, /sessions started after the change/);

      // Turn it on: saved at once.
      await page.click('#h5-peer-fs-enabled');
      await page.waitForFunction(() => window.peer.enabled === true && document.getElementById('h5-peer-fs-feedback').textContent === 'Saved');
      assert.deepEqual((await peerCalls()).filter(call => call.method === 'PUT').map(call => call.body), [{ enabled: true }]);
      assert.equal(await page.isChecked('#h5-peer-fs-enabled'), true);

      // A refused save: the error is shown and the value in effect comes back.
      await page.evaluate(() => { window.peer.failNext = { status: 500, body: { error: 'INTERNAL_ERROR' } }; });
      await page.click('#h5-peer-fs-enabled');
      await page.waitForFunction(() => /INTERNAL_ERROR/.test(document.getElementById('h5-peer-fs-feedback').textContent) && !document.getElementById('h5-peer-fs-enabled').disabled);
      assert.match(await page.locator('#h5-peer-fs-feedback').textContent(), /^Failed: INTERNAL_ERROR$/);
      assert.equal(await page.isChecked('#h5-peer-fs-enabled'), true, 'still on, as on the server');
      assert.equal(await page.evaluate(() => window.peer.enabled), true);

      // Changed elsewhere: reopening the group reads it again.
      await page.evaluate(() => { window.peer.enabled = false; });
      const before = (await peerCalls()).filter(call => call.method === 'GET').length;
      await toggleGroup();
      await page.waitForFunction(() => !document.querySelector('#h5-set-engines .Mui-expanded'));
      await openGroup();
      await page.waitForFunction(count => window.calls.filter(call => call.url === '/api/peer-fs/settings' && call.method === 'GET').length > count, before);
      await page.waitForFunction(() => !document.getElementById('h5-peer-fs-enabled').checked);
      assert.equal(await page.locator('#h5-peer-fs-feedback').isHidden(), true, 'the old error is cleared when the group is read again');
      // A phone-width layout: the switch row does not overflow the sheet.
      const outside = await page.evaluate(() => [...document.querySelectorAll('#h5-peer-fs, #h5-peer-fs *')].filter(el => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.right > document.documentElement.clientWidth + 0.5 || box.left < -0.5); }).map(el => el.id || el.className));
      assert.deepEqual(outside, [], 'nothing of the switch (its hidden input included) is outside the screen');
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Turned on by default (a fresh server), echoed as on.
    {
      const { page, errors, openGroup } = await openPage(browser, { enabled: true });
      await openGroup();
      await page.waitForFunction(() => { const input = document.getElementById('h5-peer-fs-enabled'); return input && !input.disabled && input.checked; });
      assert.deepEqual(errors, []);
      await page.close();
    }

    // An older server without the route: no switch and no error.
    {
      const { page, errors, peerCalls, openGroup } = await openPage(browser, { supported: false });
      await openGroup();
      await page.waitForFunction(() => window.calls.some(call => call.url === '/api/peer-fs/settings'));
      await page.waitForFunction(() => { const node = document.getElementById('h5-peer-fs'); return node && node.hidden; });
      assert.equal(await page.locator('#h5-peer-fs-enabled').count(), 0);
      assert.equal((await peerCalls()).filter(call => call.method === 'PUT').length, 0);
      assert.equal(await page.locator('#h5-engines-feedback').isHidden(), true);
      assert.deepEqual(errors, []);
      await page.close();
    }

    // The Chinese page shows the dictionary text.
    {
      const { page, errors, openGroup } = await openPage(browser, { enabled: true, zh: true });
      await openGroup();
      await page.waitForFunction(() => { const input = document.getElementById('h5-peer-fs-enabled'); return input && !input.disabled; });
      const label = await page.getAttribute('#h5-peer-fs-enabled', 'aria-label');
      assert.equal(label, I18nZh('Sessions can read files on linked engines'));
      assert.ok(!/[A-Za-z]{4,}/.test((await page.locator('#h5-peer-fs .MuiTypography-root').first().textContent()).replace(/Claude|Codex|ssh|env/g, '')), 'the hint is translated');
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('h5 peer file access switch browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

// The Chinese text of an English key, read from the dictionary file (the test itself holds no Chinese).
function I18nZh(key) {
  const source = fs.readFileSync(path.join(root, 'public/js/i18n-zh-ui.js'), 'utf8');
  const line = source.split('\n').find(text => text.startsWith(`  ${JSON.stringify(key)}:`));
  return JSON.parse(line.slice(line.indexOf(':') + 1).trim().replace(/,$/, ''));
}
