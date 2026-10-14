// 主题切换：三种主题都能生效、写入 data-theme 与 localStorage，并真的改变页面颜色；选择器点选即时切换。
// 设置 THEME_SHOT_DIR 可顺便保存每个主题的截图。
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // 用真实源（而不是 about:blank）加载，这样 localStorage 可用。
    const html = read('public/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    await page.route('http://theme.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://theme.test/');
    for (const css of ['style', 'file-panel', 'markdown', 'themes']) await page.addStyleTag({ path: path.join(root, `public/css/${css}.css`) });
    await page.addScriptTag({ path: path.join(root, 'public/js/theme.js') });
    await page.evaluate(src => {
      window.escapeHtml = value => String(value);
      window.Modal = { show(title, html) { document.getElementById('modal-title').textContent = title; document.querySelector('.modal-body, #modal-body').innerHTML = html; document.getElementById('modal-overlay').style.display = ''; } };
      new Function(`${src}; window.showThemePicker = showThemePicker;`)();
    }, read('public/js/app.js').match(/function showThemePicker\(\) \{[\s\S]*?\n\}\n/)[0]);

    const header = () => page.evaluate(() => getComputedStyle(document.querySelector('.header')).backgroundImage + '|' + getComputedStyle(document.body).backgroundColor);
    const seen = new Map();
    for (const id of ['light', 'dark', 'tech']) {
      await page.evaluate(theme => Theme.set(theme), id);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), id);
      seen.set(id, await header());
      await page.waitForTimeout(300); // 等按钮的颜色过渡结束
      if (process.env.THEME_SHOT_DIR) await page.screenshot({ path: path.join(process.env.THEME_SHOT_DIR, `theme-${id}.png`) });
    }
    assert.equal(new Set(seen.values()).size, 3, 'each theme must change the page appearance');
    assert.equal(await page.evaluate(() => localStorage.getItem('ta-theme')), 'tech');
    assert.equal(await page.evaluate(() => Theme.monacoTheme()), 'ta-tech');

    await page.evaluate(() => Theme.set('light'));
    await page.evaluate(() => showThemePicker());
    await page.locator('.theme-card[data-theme-id="dark"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.locator('.theme-card.active').getAttribute('data-theme-id'), 'dark');
    assert.deepEqual(errors, []);

    // 图源里写死的浅黄 rect 高亮块在深色主题下必须被压暗，否则浅色文字落在浅黄底上看不见。
    await page.addScriptTag({ path: path.join(root, 'public/vendor/mermaid/mermaid-12.1.0.min.js') });
    await page.evaluate(async () => {
      document.body.insertAdjacentHTML('beforeend', '<div class="mermaid" id="mm">sequenceDiagram\n A->>B: x\n rect rgb(255,249,153)\n B->>A: y\n end</div>');
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      await mermaid.run({ nodes: [document.getElementById('mm')] });
    });
    const fill = theme => page.evaluate(id => { Theme.set(id); return getComputedStyle(document.querySelector('#mm rect.rect')).fill; }, theme);
    assert.equal(await fill('light'), 'rgb(255, 249, 153)');
    for (const id of ['dark', 'tech']) assert.match(await fill(id), /^rgba\(\d+, \d+, \d+, 0\.\d+\)$/, `${id}: highlight block must be a translucent dark tint`);
    assert.deepEqual(errors, []);
    console.log('theme browser test passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
