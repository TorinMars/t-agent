const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const pending = [];
const server = http.createServer((req, res) => {
  if (req.url === '/api/oss/images') { req.resume(); req.on('end', () => pending.push(res)); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1400, height: 900 } });
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.dismiss());
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.addStyleTag({ path: path.join(root, 'public/css/style.css') });
      await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') });
      await page.evaluate(() => {
        window.API = { get: async () => ({ enabled: true }) }; window.sent = []; window.clicks = 0; window.keys = 0;
        document.getElementById('btn-settings').addEventListener('click', () => clicks++);
        document.addEventListener('keydown', () => keys++);
        document.getElementById('preview-pane').style.display = 'none';
        document.getElementById('terminal-pane').style.display = 'flex';
        document.getElementById('xterm-container').innerHTML = '<div class="xterm-host" id="host"></div>';
        window.socket = { readyState: 1 }; window.currentSocket = socket;
      });
      for (const file of [require.resolve('@xterm/xterm'), path.join(root, 'public/js/terminal-images.js'), path.join(root, 'public/js/terminal-clipboard.js')]) await page.addScriptTag({ path: file });
      await page.evaluate(async () => {
        window.term = new Terminal({ cols: 65, rows: 20 }); term.open(document.getElementById('host'));
        term.onData(data => sent.push(data)); TerminalClipboard.attach(term, document.getElementById('host'));
        window.handle = TerminalImages.attach(term, document.getElementById('host'), () => currentSocket);
        await TerminalImages.load(); term.focus();
        window.pasteImage = () => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array([137,80,78,71])], 'image.png', { type: 'image/png' })); term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); };
      });
      await page.evaluate(() => {
        const data = new DataTransfer(); data.setData('text/plain', 'plain text'); term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      assert.deepEqual(await page.evaluate(() => sent), ['plain text']);
      await page.evaluate(() => { sent.length = 0; keys = 0; pasteImage(); });
      await page.waitForFunction(() => document.querySelector('.terminal-image-upload-status')?.textContent.includes('OSS'));
      assert.equal(pending.length, 1);
      if (mobile) await page.screenshot({ path: '/private/tmp/t-agent-oss-upload.png' });
      await page.keyboard.press('Escape'); await page.keyboard.type('should-not-send');
      await page.evaluate(() => { document.getElementById('btn-settings').click(); term.focus(); });
      assert.deepEqual(await page.evaluate(() => ({ sent, clicks, keys, locked: term.options.disableStdin, focused: document.activeElement.className })), { sent: [], clicks: 0, keys: 0, locked: true, focused: 'terminal-image-upload-overlay' });
      pending.shift().end(JSON.stringify({ url: 'https://images.example/picture.png' }));
      await page.waitForFunction(() => !TerminalImages.busy);
      assert.deepEqual(await page.evaluate(() => sent), ['https://images.example/picture.png']);
      await page.keyboard.type('x'); assert.deepEqual(await page.evaluate(() => sent), ['https://images.example/picture.png', 'x']);
      assert.equal(await page.getByRole('button', { name: '上传图片', exact: true }).isVisible(), true);
      if (mobile) {
        await page.screenshot({ path: '/private/tmp/t-agent-oss-mobile.png' });
        const bounds = await page.getByRole('button', { name: '上传图片', exact: true }).boundingBox();
        const terminal = await page.locator('#terminal-pane').boundingBox();
        assert.ok(bounds.height >= 40, 'coarse pointer target keeps at least 40 CSS pixels');
        assert.ok(bounds.y >= terminal.y && bounds.y + bounds.height <= terminal.y + terminal.height);
        assert.ok(terminal.y + terminal.height - bounds.y - bounds.height < 20, 'same unified terminal bottom placement');
        const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '上传图片', exact: true }).tap();
        await (await chooser).setFiles({ name: 'phone.png', mimeType: 'image/png', buffer: Buffer.from([137,80,78,71]) });
      } else await page.evaluate(() => pasteImage());
      await page.waitForFunction(() => document.querySelector('.terminal-image-upload-status')?.textContent.includes('OSS'));
      pending.shift().writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'simulated OSS failure' }));
      await page.waitForFunction(() => !TerminalImages.busy);
      assert.equal(await page.evaluate(() => term.options.disableStdin), false);
      await page.getByRole('button', { name: /设置/ }).click();
      assert.equal(await page.evaluate(() => clicks), 1);
      await page.evaluate(() => { pasteImage(); currentSocket = { readyState: 1 }; });
      await page.waitForFunction(() => document.querySelector('.terminal-image-upload-status')?.textContent.includes('OSS'));
      pending.shift().end(JSON.stringify({ url: 'https://images.example/retained.png' }));
      await page.waitForFunction(() => !TerminalImages.busy);
      assert.equal(await page.locator('.terminal-image-result input').inputValue(), 'https://images.example/retained.png');
      assert.deepEqual(await page.evaluate(() => sent), ['https://images.example/picture.png', 'x']);
      assert.deepEqual(errors, []); await context.close();
    }
    console.log('PASS: real xterm text/image paste, upload processing lock, keyboard/pointer/focus block, no Enter, failure unlock, stale socket retained URL, phone bottom picker.');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); for (const res of pending) res.destroy(); server.close(); process.exitCode = 1; });
