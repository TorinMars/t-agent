// Links in the terminal: only Cmd/Ctrl + click opens them; a plain click does not. Uses the same xterm and WebLinksAddon configuration as tasks.js.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<link rel="stylesheet" href="x"><body style="margin:0"><div id="t" style="width:800px;height:200px"></div></body>');
    for (const file of ['xterm/xterm-5.5.0.js', 'xterm/addon-web-links-0.11.0.js']) await page.addScriptTag({ path: path.join(root, 'public/vendor', file) });
    await page.addStyleTag({ path: path.join(root, 'public/vendor/xterm/xterm-5.5.0.css') });
    // Copy the registration code from tasks.js so the two places stay consistent.
    const handler = fs.readFileSync(path.join(root, 'public/js/tasks.js'), 'utf8').match(/linkHandler: \{[\s\S]*?\n      \},/)[0];
    const registration = fs.readFileSync(path.join(root, 'public/js/tasks.js'), 'utf8').match(/t\.loadAddon\(new WebLinksAddon[\s\S]*?\}\)\);/)[0];
    await page.evaluate(async ({ code, handlerCode }) => {
      window.opened = [];
      window.open = (...args) => { window.opened.push(args); return null; };
      window.confirm = () => true;
      const t = new Terminal(new Function(`return { fontSize: 13, ${handlerCode} }`)());
      t.open(document.getElementById('t'));
      new Function('t', code)(t);
      await new Promise(resolve => t.write('see https://example.com/docs?a=1 ok\r\nopen \u001b]8;;https://example.com/pr/1\u0007this PR\u001b]8;;\u0007 end\r\n', resolve));
    }, { code: registration, handlerCode: handler });
    await page.waitForTimeout(200);
    // "see " takes 4 columns and the link starts at column 5; pick the middle of the link.
    const box = await page.locator('.xterm-screen').boundingBox();
    const cell = box.width / 80;
    const point = { x: box.x + cell * 12, y: box.y + 6 };
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(200);
    await page.mouse.click(point.x, point.y);
    assert.deepEqual(await page.evaluate(() => window.opened), [], 'plain click must not open the link');
    await page.keyboard.down('Meta');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Meta');
    const opened = await page.evaluate(() => window.opened);
    assert.equal(opened.length, 1, 'Cmd+click opens the link');
    assert.equal(opened[0][0], 'https://example.com/docs?a=1');
    assert.match(opened[0][2], /noopener/);

    // OSC 8 hyperlink (the visible text "this PR" starts at row 2 column 6): likewise only Cmd/Ctrl + click opens it.
    const row = { x: box.x + cell * 8, y: box.y + 6 + (box.height / (await page.evaluate(() => document.querySelectorAll('.xterm-rows > div').length))) };
    await page.evaluate(() => { window.opened.length = 0; });
    await page.mouse.move(row.x, row.y); await page.waitForTimeout(200);
    await page.mouse.click(row.x, row.y);
    assert.deepEqual(await page.evaluate(() => window.opened), [], 'plain click on an OSC 8 link must not open it');
    await page.keyboard.down('Meta'); await page.mouse.click(row.x, row.y); await page.keyboard.up('Meta');
    assert.equal((await page.evaluate(() => window.opened.map(call => call[0])))[0], 'https://example.com/pr/1');
    assert.deepEqual(errors, []);
    console.log('terminal links browser test passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
