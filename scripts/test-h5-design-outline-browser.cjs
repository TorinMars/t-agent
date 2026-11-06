// The outline of the design document sheet (scripts/h5-shell/Design.jsx, outline.mjs) in real Chromium with a mocked server:
// - phone 390x844 with touch: the Outline button in the sheet header opens a drawer listing the h1-h3 headings with their levels; a tap scrolls the
//   document to that heading and closes the drawer; the section being read is marked while scrolling; Escape and the back button close the drawer
//   before the sheet; a document without headings has no Outline button.
// - computer 1440x900 (mouse): the outline is a column on the right of the document inside the side panel, scrolling on its own, foldable (remembered).
// Headings get unique ids (duplicates, Chinese text), and a `#` line inside a code block is no heading.
// The full-screen viewer (ImageViewer.jsx): a tap on a picture (a relative one, read through the task file API) shows it with the same src; a tap on a
// mermaid diagram shows a clone of its SVG; a pinch (two in-page pointers) zooms, a double tap switches fit / detail, the wheel and a mouse drag work on a
// computer; Escape, the back button and a tap on the background close the viewer and leave the sheet open. H5_SHOT_DIR=<dir> saves screenshots
// (phone at 3x). Chinese text is written with \u escapes (test/i18n.test.js).
const { chromium } = require('playwright');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';

const CN = '\u8bbe\u8ba1\u6982\u89c8'; // "design overview" in Chinese
const paras = (name, n) => Array.from({ length: n }, (_, i) => `${name} paragraph ${i + 1} of the design text, long enough to wrap on a phone screen.\n`);
// A 1200x800 PNG (a colour gradient with a grid), so the viewer has more pixels to show than the phone does.
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + 1 + x * 3; const line = x % 100 === 0 || y % 100 === 0;
    rows[at] = line ? 255 : Math.round(x / width * 200); rows[at + 1] = line ? 255 : Math.round(y / height * 200); rows[at + 2] = line ? 255 : 120;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const PICTURE = png(1200, 800);
const STEPS = Array.from({ length: 24 }, (_, i) => `Step ${i + 1}`);
const WITH_HEADINGS = [
  '# Design of Fix login', '', ...paras('Intro', 2), '![the big picture](img/big.png)', '', '```mermaid', 'graph LR', '  A[Client] --> B[Server]', '  B --> C[(Database)]', '```', '', ...paras('Intro', 4),
  '## Goals', '', ...paras('Goals', 8),
  '### Notes', '', ...paras('Notes A', 6),
  '## Architecture', '', ...paras('Architecture', 6), '```md', '# Not a heading', '## Also not one', '```', '',
  '### Notes', '', ...paras('Notes B', 6),
  '#### Deep detail', '', ...paras('Deep', 4),
  `## ${CN}`, '', ...paras('Overview', 6),
  ...STEPS.flatMap(step => [`### ${step}`, '', ...paras(step, 4)]),
  '## Appendix', '', ...paras('Appendix', 40),
].join('\n');
const NO_HEADINGS = ['Just **text**, no headings.', '', '```md', '# Not a heading', '```', '', ...paras('Plain', 30)].join('\n');
const EXPECTED = [
  ['Design of Fix login', 1, 'h5-doc-design-of-fix-login'], ['Goals', 2, 'h5-doc-goals'], ['Notes', 3, 'h5-doc-notes'], ['Architecture', 2, 'h5-doc-architecture'],
  ['Notes', 3, 'h5-doc-notes-1'], [CN, 2, `h5-doc-${CN}`], ...STEPS.map(step => [step, 3, `h5-doc-${step.toLowerCase().replace(' ', '-')}`]), ['Appendix', 2, 'h5-doc-appendix'],
];
let content = WITH_HEADINGS;
const pageErrors = [];

async function openPage(browser, { viewport, touch }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && route.request().method() === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/1/terminals') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([]);
    if (url.pathname === '/api/tasks/1/files/image') return url.searchParams.get('path') === 'img/big.png' ? route.fulfill({ contentType: 'image/png', body: PICTURE }) : json({ error: 'FILE_NOT_FOUND' }, 404);
    if (url.pathname === '/api/tasks/1/files/content') return json({ path: 'DESIGN.md', content, revision: 'r1', eol: '\n', bom: false });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  const how = touch ? 'tap' : 'click';
  const row = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await row.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await row[how]();
  await page.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
  return { context, page, how };
}

// The heading's top in px from the top of the document view.
const headTop = (page, id) => page.evaluate(target => {
  const body = document.getElementById('h5-design-body');
  return document.getElementById(target).getBoundingClientRect().top - body.getBoundingClientRect().top;
}, id);
// Waits until the heading sits just below the top of the document view (the smooth scroll has ended there).
const waitAtTop = (page, id) => page.waitForFunction(target => {
  const body = document.getElementById('h5-design-body');
  const head = document.getElementById(target);
  const top = head.getBoundingClientRect().top - body.getBoundingClientRect().top;
  const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
  return (top >= 4 && top <= 12) || (atEnd && top >= 0 && top < body.clientHeight);
}, id, { timeout: 5000 });
// The heading the page should mark: the last one whose top has reached 40px (the SECTION_LINE of Design.jsx), else the first.
const expectedCurrent = page => page.evaluate(() => {
  const body = document.getElementById('h5-design-body');
  const heads = [...body.querySelectorAll('h1, h2, h3')].filter(node => !node.closest('pre, .md-code-block'));
  let current = heads[0];
  for (const head of heads) if (head.getBoundingClientRect().top - body.getBoundingClientRect().top <= 40) current = head;
  return current.id;
});
const marked = page => page.evaluate(() => [...document.querySelectorAll('#h5-design-outline-list [aria-current="location"]')].map(node => node.dataset.target));
const listed = page => page.evaluate(() => [...document.querySelectorAll('#h5-design-outline-list [data-target]')].map(node => [node.textContent, Number(node.dataset.level), node.dataset.target]));

// The viewer has faded in (the screenshots show it fully opaque).
const faded = page => page.waitForFunction(() => { const c = document.querySelector('#h5-viewer')?.closest('.MuiDialog-container'); return c && getComputedStyle(c).opacity === '1'; }, null, { timeout: 3000 });
const waitScale = (page, test) => page.waitForFunction(body => { const node = document.getElementById('h5-viewer-content'); return node && new Function('s', `return ${body}`)(Number(node.dataset.scale)); }, test, { timeout: 3000 });
// In-page pointers on the viewer stage: a pinch from `from` px apart to `to` px apart around the centre, and a double tap at the centre.
const pinchOn = (page, from, to) => page.evaluate(([a, b]) => {
  const stage = document.querySelector('.h5-viewer-stage');
  const r = stage.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const fire = (type, id, x) => stage.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: cy, bubbles: true, cancelable: true }));
  fire('pointerdown', 11, cx - a / 2); fire('pointerdown', 12, cx + a / 2);
  for (let i = 1; i <= 5; i++) { const d = a + (b - a) * i / 5; fire('pointermove', 11, cx - d / 2); fire('pointermove', 12, cx + d / 2); }
  fire('pointerup', 11, cx - b / 2); fire('pointerup', 12, cx + b / 2);
}, [from, to]);
const doubleTap = page => page.evaluate(() => {
  const content = document.getElementById('h5-viewer-content');
  const r = content.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  for (let i = 0; i < 2; i++) {
    for (const type of ['pointerdown', 'pointerup']) content.dispatchEvent(new PointerEvent(type, { pointerId: 21 + i, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }
});

async function checkIds(page) {
  const ids = await page.evaluate(() => [...document.querySelectorAll('#h5-design-body :is(h1, h2, h3)')].map(node => node.id));
  assert.deepEqual(ids, EXPECTED.map(entry => entry[2]), 'every h1-h3 has a unique id from its text; the code block has no headings');
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(await page.locator('#h5-design-body pre').first().textContent().then(text => text.includes('# Not a heading')), true, 'the code block keeps its text');
  assert.equal(await page.evaluate(() => document.querySelector('#h5-design-body h4').id), '', 'h4 is not in the outline');
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── Phone 390x844, touch ──
    {
      content = WITH_HEADINGS;
      const { context, page } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await page.locator('#h5-design').tap();
      await page.locator('#h5-design-body h1', { hasText: 'Design of Fix login' }).waitFor();
      const button = page.locator('#h5-design-outline');
      await button.waitFor();
      assert.equal(await button.getAttribute('aria-label'), 'Outline');
      assert.equal(await button.getAttribute('title'), 'Outline');
      const box = await button.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `a 44px touch target (${JSON.stringify(box)})`);
      const close = await page.locator('#h5-design-close').boundingBox();
      assert.ok(box.x + box.width <= close.x + 0.5, 'the Outline button sits left of Close');
      await checkIds(page);
      assert.equal(await page.locator('#h5-design-outline-list').count(), 0, 'on a phone the outline is not shown until asked for');

      // The drawer lists the headings with their levels, indented by level.
      await button.tap();
      const panel = page.locator('#h5-design-outline-panel');
      await panel.waitFor();
      assert.deepEqual(await listed(page), EXPECTED, 'the outline lists h1-h3 in order with their levels');
      const indents = await page.evaluate(() => Object.fromEntries([1, 2, 3].map(level => [level, parseFloat(getComputedStyle(document.querySelector(`#h5-design-outline-list [data-level="${level}"]`)).paddingLeft)])));
      assert.ok(indents[1] < indents[2] && indents[2] < indents[3], `deeper levels are indented more (${JSON.stringify(indents)})`);
      assert.deepEqual(await marked(page), ['h5-doc-design-of-fix-login'], 'at the top the first heading is marked');
      assert.equal(await page.evaluate(() => { const list = document.getElementById('h5-design-outline-list'); return list.scrollHeight > list.clientHeight && getComputedStyle(list).overflowY === 'auto'; }), true, 'a long outline scrolls on its own');
      const item = await page.locator(`#h5-design-outline-list [data-target="h5-doc-${CN}"]`).boundingBox();
      assert.ok(item.height >= 44, 'outline entries are 44px touch targets');

      // A tap on the Chinese heading scrolls to it and closes the drawer; it is then marked.
      await page.locator(`#h5-design-outline-list [data-target="h5-doc-${CN}"]`).tap();
      await panel.waitFor({ state: 'detached' });
      await waitAtTop(page, `h5-doc-${CN}`);
      assert.ok(await headTop(page, `h5-doc-${CN}`) >= 0, 'the heading is not hidden under the sheet header');
      assert.equal(await page.locator('.h5-design-panel').isVisible(), true, 'the sheet stays open');
      await button.tap();
      await panel.waitFor();
      assert.deepEqual(await marked(page), [`h5-doc-${CN}`]);
      // The second "Notes" (a duplicate) has its own target.
      await page.locator('#h5-design-outline-list [data-target="h5-doc-notes-1"]').tap();
      await panel.waitFor({ state: 'detached' });
      await waitAtTop(page, 'h5-doc-notes-1');

      // Scrolling by hand moves the mark: a touch swipe up on the document, then the mark is the section being read.
      const body = await page.locator('#h5-design-body').boundingBox();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(body.x + body.width / 2), y: Math.round(body.y + body.height * 0.7), yDistance: -1400, speed: 4000, gestureSourceType: 'touch' });
      await page.waitForFunction(() => { const b = document.getElementById('h5-design-body'); const t = b.scrollTop; return new Promise(resolve => setTimeout(() => resolve(b.scrollTop === t), 150)); });
      const want = await expectedCurrent(page);
      assert.notEqual(want, 'h5-doc-notes-1', 'the swipe moved to another section');
      await button.tap();
      await panel.waitFor();
      assert.deepEqual(await marked(page), [want], 'the mark follows the scrolling');
      const inView = await page.evaluate(() => { const list = document.getElementById('h5-design-outline-list').getBoundingClientRect(); const item = document.querySelector('#h5-design-outline-list [aria-current="location"]').getBoundingClientRect(); return item.top >= list.top - 1 && item.bottom <= list.bottom + 1; });
      assert.equal(inView, true, 'the marked entry is scrolled into view in the list');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'phone-390-outline-open.png') });

      // Escape closes the drawer first, then the sheet; the back button does the same.
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.h5-design-panel').isVisible(), true, 'Escape closed only the outline');
      await button.tap();
      await panel.waitFor();
      await page.waitForFunction(() => history.state && history.state.h5Layer === 2, null, { timeout: 3000 });
      await page.goBack();
      await panel.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.h5-design-panel').isVisible(), true, 'back closed only the outline');
      await page.waitForFunction(() => history.state && history.state.h5Layer === 1, null, { timeout: 3000 });
      await page.goBack();
      await page.locator('.h5-design-panel').waitFor({ state: 'hidden' });

      // The viewer: a tap on the picture shows it full screen with the same src (the file API URL, at its natural 1200px).
      await page.locator('#h5-design').tap();
      await page.locator('#h5-design-body .mermaid svg').waitFor({ timeout: 15000 });
      const img = page.locator('#h5-design-body img');
      await page.waitForFunction(() => document.querySelector('#h5-design-body img').naturalWidth === 1200);
      assert.equal(await img.evaluate(node => getComputedStyle(node).cursor), 'zoom-in', 'the picture shows it can be opened');
      await img.scrollIntoViewIfNeeded();
      await img.tap();
      const viewer = page.locator('#h5-viewer');
      await viewer.waitFor();
      await page.waitForFunction(() => document.getElementById('h5-viewer-content').complete && document.getElementById('h5-viewer-content').naturalWidth > 0);
      const shown = await page.evaluate(() => { const v = document.getElementById('h5-viewer-content'); return { src: v.getAttribute('src'), doc: document.querySelector('#h5-design-body img').getAttribute('src'), natural: v.naturalWidth, width: v.getBoundingClientRect().width }; });
      assert.equal(shown.src, shown.doc, 'the viewer shows the same src');
      assert.ok(shown.src.includes('/api/tasks/1/files/image?path=img%2Fbig.png'), shown.src);
      assert.equal(shown.natural, 1200);
      assert.ok(Math.abs(shown.width - 390) <= 1, `fit to the screen width (${shown.width})`);
      const closeBox = await page.locator('#h5-viewer-close').boundingBox();
      assert.ok(closeBox.width >= 44 && closeBox.x + closeBox.width <= 390 && closeBox.y >= 0 && closeBox.y < 70, `the close button at the top right (${JSON.stringify(closeBox)})`);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.h5-viewer-stage')).touchAction), 'none', 'the browser does not pan or zoom the page');
      await faded(page);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'phone-390-viewer-image.png') });
      await pinchOn(page, 100, 300);
      await waitScale(page, 's > 2.5');
      await doubleTap(page);
      await waitScale(page, 's === 1');
      await doubleTap(page);
      await waitScale(page, 's > 3.05 && s < 3.1'); // the natural size: 1200 / 390 = 3.08
      assert.equal(await page.evaluate(() => visualViewport.scale), 1, 'the page itself is not zoomed');
      await page.keyboard.press('Escape');
      await viewer.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.h5-design-panel').isVisible(), true, 'Escape closed only the viewer');

      // A tap on the diagram shows a clone of its SVG (vector, without the fixed max-width), zoomable.
      await page.locator('#h5-design-body .mermaid').tap();
      await viewer.waitFor();
      const svg = await page.evaluate(() => {
        const clone = document.querySelector('#h5-viewer-content svg');
        const original = document.querySelector('#h5-design-body .mermaid svg');
        return { clone: Boolean(clone), same: clone === original, maxWidth: clone && clone.style.maxWidth, width: document.getElementById('h5-viewer-content').getBoundingClientRect().width, text: clone && clone.textContent };
      });
      assert.equal(svg.clone, true);
      assert.equal(svg.same, false, 'a clone, the document keeps its diagram');
      assert.equal(svg.maxWidth, '');
      assert.ok(svg.width >= 390 - 2 * 16 - 1, `the diagram fills the width (${svg.width})`);
      assert.ok(svg.text.includes('Database'));
      await pinchOn(page, 80, 240);
      await waitScale(page, 's > 2.5');
      await faded(page);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'phone-390-viewer-diagram-zoomed.png') });
      // The back button closes the viewer, not the sheet.
      await page.waitForFunction(() => history.state && history.state.h5Layer === 2, null, { timeout: 3000 });
      await page.goBack();
      await viewer.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.h5-design-panel').isVisible(), true, 'back closed only the viewer');
      // A tap on the background (not zoomed) closes it; a zoomed view does not close on a background tap.
      await img.tap();
      await viewer.waitFor();
      await page.touchscreen.tap(195, 800);
      await viewer.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.h5-design-panel').isVisible(), true);
      await page.locator('#h5-design-close').tap();
      await page.locator('.h5-design-panel').waitFor({ state: 'hidden' });

      // A document without headings: no Outline button.
      content = NO_HEADINGS;
      await page.locator('#h5-design').tap();
      await page.locator('#h5-design-body', { hasText: 'Just text' }).waitFor();
      await page.locator('#h5-design-loading').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#h5-design-outline').count(), 0, 'no headings: no Outline button');
      assert.equal(await page.locator('#h5-design-body h1').count(), 0);
      await page.locator('#h5-design-close').tap();
      await page.locator('.h5-design-panel').waitFor({ state: 'hidden' });
      await context.close();
    }

    // ── Computer 1440x900, mouse ──
    {
      content = WITH_HEADINGS;
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, touch: false });
      await page.locator('#h5-design').click();
      await page.locator('.h5-design-side h1', { hasText: 'Design of Fix login' }).waitFor({ timeout: 10000 });
      await checkIds(page);
      const list = page.locator('#h5-design-outline-list');
      await list.waitFor();
      assert.equal(await page.locator('#h5-design-outline').getAttribute('aria-expanded'), 'true', 'shown by default at 1440');
      assert.deepEqual(await listed(page), EXPECTED);
      await page.waitForFunction(() => { const p = document.querySelector('.h5-design-side'); return p && Math.abs(p.getBoundingClientRect().right - innerWidth) <= 1; }); // the slide-in has ended
      const geometry = await page.evaluate(() => {
        const r = node => node.getBoundingClientRect();
        const panel = r(document.querySelector('.h5-design-side'));
        const body = r(document.getElementById('h5-design-body'));
        const nav = r(document.getElementById('h5-design-outline-list'));
        const el = document.getElementById('h5-design-outline-list');
        return { panel, body, nav, scrolls: el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto' };
      });
      assert.ok(geometry.nav.left >= geometry.body.right - 1 && geometry.nav.right <= geometry.panel.right + 1, `the outline is a column right of the document inside the panel (${JSON.stringify(geometry)})`);
      assert.ok(geometry.nav.width >= 140 && geometry.nav.width <= 220 && geometry.body.width >= 300, 'the document keeps most of the panel');
      assert.ok(Math.abs(geometry.nav.top - geometry.body.top) <= 1 && Math.abs(geometry.nav.bottom - geometry.body.bottom) <= 1, 'the column is as tall as the document view');
      assert.equal(geometry.scrolls, true, 'a long outline scrolls on its own');

      // A click jumps; the document scrolls, the outline column does not scroll the document view away.
      await page.locator(`#h5-design-outline-list [data-target="h5-doc-${CN}"]`).click();
      await waitAtTop(page, `h5-doc-${CN}`);
      assert.deepEqual(await marked(page), [`h5-doc-${CN}`]);
      await page.locator('#h5-design-outline-list [data-target="h5-doc-step-20"]').click();
      await waitAtTop(page, 'h5-doc-step-20');
      assert.deepEqual(await marked(page), ['h5-doc-step-20']);

      // The wheel over the document moves the mark.
      const body = await page.locator('#h5-design-body').boundingBox();
      await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
      await page.mouse.wheel(0, -900);
      await page.waitForFunction(() => { const b = document.getElementById('h5-design-body'); const t = b.scrollTop; return new Promise(resolve => setTimeout(() => resolve(b.scrollTop === t), 150)); });
      const want = await expectedCurrent(page);
      assert.notEqual(want, 'h5-doc-step-20');
      await page.waitForFunction(target => document.querySelector('#h5-design-outline-list [aria-current="location"]')?.dataset.target === target, want, { timeout: 3000 });
      assert.deepEqual(await marked(page), [want], 'the mark follows the wheel');
      // Only the marked entry keeps a background once the colour change has ended.
      await page.waitForFunction(() => [...document.querySelectorAll('#h5-design-outline-list [data-target]:not([aria-current])')].every(node => {
        const alpha = getComputedStyle(node).backgroundColor.match(/[\d.]+(?=\)$)/);
        return getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)' || (alpha && Number(alpha[0]) < 0.02);
      }), null, { timeout: 3000 });
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-outline-column.png') });

      // Fold the column away and back (remembered).
      await page.locator('#h5-design-outline').click();
      await list.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#h5-design-outline').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => localStorage.getItem('h5-design-outline')), '0');
      const wide = await page.locator('#h5-design-body').boundingBox();
      assert.ok(wide.width > body.width + 100, 'folded: the document takes the whole panel');
      await page.locator('#h5-design-outline').click();
      await list.waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('h5-design-outline')), '1');

      // The viewer on a computer: a click opens the picture, the wheel zooms at the pointer, a drag pans, a double click fits; Escape closes only it.
      await page.locator('#h5-design-body .mermaid svg').waitFor({ timeout: 15000 });
      await page.locator('#h5-design-body img').scrollIntoViewIfNeeded();
      await page.locator('#h5-design-body img').click();
      await page.locator('#h5-viewer').waitFor();
      assert.equal(await page.evaluate(() => document.getElementById('h5-viewer-content').getAttribute('src') === document.querySelector('#h5-design-body img').getAttribute('src')), true);
      await page.mouse.move(720, 450);
      await page.mouse.wheel(0, -600);
      await waitScale(page, 's > 1.5');
      const before = await page.evaluate(() => document.getElementById('h5-viewer-content').style.transform);
      await page.mouse.down();
      await page.mouse.move(620, 400, { steps: 5 });
      await page.mouse.up();
      await page.waitForFunction(t => document.getElementById('h5-viewer-content').style.transform !== t, before, { timeout: 3000 });
      await page.mouse.dblclick(720, 450);
      await waitScale(page, 's === 1');
      await page.keyboard.press('Escape');
      await page.locator('#h5-viewer').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-side-panel')), true, 'Escape closed only the viewer, the panel stays');
      await page.locator('#h5-design-body .mermaid').click();
      await page.locator('#h5-viewer-content svg').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('#h5-viewer').waitFor({ state: 'detached' });

      // A document without headings: no Outline button and no column.
      await page.locator('#h5-design-body').focus();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-side-panel'));
      content = NO_HEADINGS;
      await page.locator('#h5-design').click();
      await page.locator('#h5-design-body', { hasText: 'Just text' }).waitFor();
      await page.locator('#h5-design-loading').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#h5-design-outline').count(), 0);
      assert.equal(await page.locator('#h5-design-outline-list').count(), 0);
      await context.close();
    }
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('h5 design outline browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
