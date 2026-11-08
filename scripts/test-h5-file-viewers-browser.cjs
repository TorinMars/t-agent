// The file sheet's views by file kind (scripts/h5-shell/Design.jsx, FileViewers.jsx, file-kinds.mjs; h5.js openFileSheet) in real Chromium, files
// opened from the file tree on a phone (390x844, touch):
// - code (app.py, a template string over lines in app.js) is highlighted line by line (hljs spans, every line balanced), keeps the line numbers;
//   a file over 1 MiB stays plain and is still drawn only in part;
// - JSON is pretty-printed with a Formatted / Raw toggle; CSV is a table with a sticky header and a Table / Raw toggle, quoted fields with commas and
//   line ends in one cell; HTML shows its highlighted code and a Preview toggle with an `<iframe sandbox="">` whose srcdoc carries a CSP;
// - an image is not read as text: it is shown from `…/files/image?path=` with its pixel size, and a tap opens the full-screen viewer;
// - PDF, audio and video are read raw (`…/files/raw?path=`, probed with one byte first); a PDF has "Open in new tab"; a missing raw file says so;
// - a remote Engine without 'files:raw' shows "This Engine cannot show this file type" without reading the file.
// H5_SHOT_DIR=<dir> saves screenshots (3x).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';

// A 2x3 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEUlEQVR4nGP4z8DwnwGMERQARNAF+7BYSawAAAAASUVORK5CYII=', 'base64');
const BIG = Array.from({ length: 40000 }, (_, i) => `const value${i} = "${'x'.repeat(20)}";`).join('\n'); // about 1.3 MB
const CONTENT = {
  'app.py': 'def hello(name):\n    """Say hello."""\n    return f"hi {name}"  # greet\n',
  'app.js': 'const s = `one\ntwo`;\nlet n = 42;\n',
  'big.js': BIG,
  'data.json': '{"name":"t-agent","n":12345678901234567890,"list":[1,2]}',
  'data.csv': 'name,note\n"Smith, J","two\nlines"\nLee,ok\n',
  'page.html': '<!doctype html><h1>Hello</h1><script>parent.hacked = 1</script>',
};
const TREE = ['app.py', 'app.js', 'big.js', 'data.json', 'data.csv', 'page.html', 'photo.png', 'doc.pdf', 'song.mp3', 'clip.mp4', 'gone.pdf'];

async function openPage(browser, { desktop = false } = {}) {
  const context = await browser.newContext(desktop ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([{ id: 7, name: 'Lab', status: 'online' }]);
    if (p === '/api/tasks' && route.request().method() === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
    if (p === '/api/remote-servers/7/tasks') return json([{ id: 5, title: 'Remote job', status: 'doing', work_dir: '/srv/job' }]);
    if (/^\/api(\/remote-servers\/7)?\/task-groups$/.test(p)) return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    const terms = p.match(/^\/api(?:\/remote-servers\/7)?\/tasks\/(\d+)\/terminals$/);
    if (terms) return json([{ terminal_id: `t${terms[1]}`, title: 'Terminal 1' }]);
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/remote-servers/7/info') return json({ capabilities: ['fs:read-any'] }); // an Engine without 'files:raw'
    const file = url.searchParams.get('path');
    const files = p.match(/^(\/api(?:\/remote-servers\/7)?\/tasks\/\d+\/files)(?:\/(content|image|raw))?$/);
    if (!files) return json({ error: 'not mocked' }, 404);
    requests.push(`${files[2] || 'list'} ${file || '.'}${route.request().headers().range ? ` ${route.request().headers().range}` : ''}`);
    if (!files[2]) return json({ entries: TREE.map(name => ({ name, path: name, type: 'file' })), nextOffset: null, root: '/work', writable: false });
    if (files[2] === 'content') return CONTENT[file] !== undefined ? json({ path: file, content: CONTENT[file], revision: 'r1', eol: '\n', bom: false }) : json({ error: 'FILE_UNSUPPORTED' }, 415);
    if (files[2] === 'image') return file === 'photo.png' ? route.fulfill({ contentType: 'image/png', body: PNG }) : json({ error: 'FILE_NOT_FOUND' }, 404);
    if (file === 'gone.pdf') return json({ error: 'FILE_NOT_FOUND' }, 404);
    const types = { 'doc.pdf': 'application/pdf', 'song.mp3': 'audio/mpeg', 'clip.mp4': 'video/mp4' };
    const body = file === 'doc.pdf' ? Buffer.from('%PDF-1.4\n%%EOF\n') : Buffer.alloc(64);
    return route.fulfill({ status: 206, headers: { 'Content-Type': types[file], 'Accept-Ranges': 'bytes', 'Content-Range': `bytes 0-0/${body.length}` }, body: body.subarray(0, 1) });
  });
  await page.goto(`${ORIGIN}/h5`);
  const how = desktop ? 'click' : 'tap';
  const row = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await row.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await row[how]();
  await page.waitForFunction(() => window.sockets.length >= 1 && window.sockets.at(-1).readyState === 1);
  return { context, page, errors, requests };
}

const rowOf = (page, filePath) => page.locator(`#h5-files-tree [data-path="${filePath}"]`);
async function openTree(page) {
  await page.locator('#h5-design').tap();
  await page.locator('#h5-design-files').tap();
  await page.locator('#h5-files-sheet .h5-files-panel').waitFor({ state: 'visible' });
}
async function openFile(page, name) {
  await rowOf(page, name).scrollIntoViewIfNeeded();
  await rowOf(page, name).tap();
  await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(title => document.getElementById('h5-design-title')?.textContent === title, name);
}
async function back(page) {
  await page.locator('#h5-design-back').tap();
  await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'hidden' });
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name) }) : null);

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const { context, page, errors, requests } = await openPage(browser);
    await openTree(page);
    await rowOf(page, 'app.py').waitFor();

    // Code: highlighted per line.
    await openFile(page, 'app.py');
    await page.locator('#h5-design-body .h5-file-text.is-highlighted .hljs-keyword').first().waitFor();
    const py = await page.evaluate(() => [...document.querySelectorAll('#h5-design-body .h5-file-line')].map(node => ({ n: node.dataset.line, text: node.textContent, html: node.innerHTML })));
    assert.deepEqual(py.map(line => line.n), ['1', '2', '3']);
    assert.equal(py[0].text, 'def hello(name):\n');
    assert.match(py[0].html, /<span class="hljs-keyword">def<\/span>/);
    assert.match(py[1].html, /hljs-string/);
    assert.match(py[2].html, /hljs-comment">#\s*greet/);
    assert.equal(await page.locator('#h5-file-toolbar').count(), 0, 'code has no view toggle');
    await shot(page, 'h5-file-code.png');
    await back(page);
    await openFile(page, 'app.js');
    await page.locator('#h5-design-body .h5-file-text.is-highlighted').waitFor();
    const js = await page.evaluate(() => [...document.querySelectorAll('#h5-design-body .h5-file-line')].map(node => node.innerHTML));
    assert.equal(js.length, 3);
    assert.match(js[0], /^<span class="hljs-keyword">const<\/span> s = <span class="hljs-string">`one<\/span>/, 'the template string is closed at the line end');
    assert.match(js[1], /^<span class="hljs-string">two`<\/span>;/, 'and opened again on the next line');
    await back(page);
    await openFile(page, 'big.js');
    await page.locator('#h5-design-body .h5-file-line').first().waitFor();
    assert.equal(await page.locator('#h5-design-body .h5-file-text.is-highlighted').count(), 0, 'over 1 MiB: plain');
    assert.ok(await page.locator('#h5-design-body .h5-file-line').count() < 400, 'still drawn in part');
    await back(page);

    // JSON: formatted, with a toggle to the raw text.
    await openFile(page, 'data.json');
    await page.locator('#h5-file-modes [data-mode="formatted"][aria-pressed="true"]').waitFor();
    await page.locator('#h5-design-body .h5-file-line[data-line="3"]').waitFor();
    const formatted = await page.evaluate(() => [...document.querySelectorAll('#h5-design-body .h5-file-line')].map(node => node.textContent.replace(/\n$/, '')));
    assert.deepEqual(formatted, ['{', '  "name": "t-agent",', '  "n": 12345678901234567890,', '  "list": [', '    1,', '    2', '  ]', '}']);
    assert.ok(await page.locator('#h5-design-body .hljs-attr').count() > 0, 'highlighted as JSON');
    assert.equal(await page.locator('#h5-file-modes [data-mode="source"]').textContent(), 'Raw');
    await page.locator('#h5-file-modes [data-mode="source"]').tap();
    await page.waitForFunction(() => document.querySelectorAll('#h5-design-body .h5-file-line').length === 1);
    assert.match(await page.locator('#h5-design-body .h5-file-line').textContent(), /^\{"name":"t-agent"/);
    await back(page);

    // CSV: a table, a quoted field with a comma and a line end stays one cell.
    await openFile(page, 'data.csv');
    await page.locator('#h5-file-table').waitFor();
    assert.deepEqual(await page.locator('#h5-file-table th').allTextContents(), ['name', 'note']);
    const cells = await page.evaluate(() => [...document.querySelectorAll('#h5-file-table tbody tr')].map(tr => [...tr.cells].map(td => td.textContent)));
    assert.deepEqual(cells, [['Smith, J', 'two\nlines'], ['Lee', 'ok']]);
    assert.equal(await page.locator('#h5-file-table th').first().evaluate(node => getComputedStyle(node).position), 'sticky');
    await shot(page, 'h5-file-csv.png');
    await page.locator('#h5-file-modes [data-mode="source"]').tap();
    await page.locator('#h5-design-body .h5-file-line[data-line="4"]').waitFor();
    assert.equal(await page.locator('#h5-file-table').count(), 0);
    await back(page);

    // HTML: the highlighted code, then a sandboxed preview whose script does not run.
    await openFile(page, 'page.html');
    await page.locator('#h5-design-body .h5-file-text.is-highlighted .hljs-tag').first().waitFor();
    await page.locator('#h5-file-modes [data-mode="preview"]').tap();
    const frame = page.locator('#h5-file-html');
    await frame.waitFor();
    assert.equal(await frame.getAttribute('sandbox'), '');
    const srcdoc = await frame.getAttribute('srcdoc');
    assert.match(srcdoc, /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';/, 'the CSP comes right after the doctype');
    await page.frameLocator('#h5-file-html').locator('h1', { hasText: 'Hello' }).waitFor();
    assert.equal(await page.evaluate(() => window.hacked), undefined, 'no script ran');
    await back(page);

    // An image: no text read, shown from the image read, a tap opens the full-screen viewer.
    const before = requests.length;
    await openFile(page, 'photo.png');
    await page.locator('#h5-file-image').waitFor();
    await page.waitForFunction(() => document.getElementById('h5-file-image-info')?.textContent.startsWith('2 × 3'));
    assert.deepEqual(requests.slice(before), ['image photo.png'], 'read once, as an image');
    assert.match(await page.locator('#h5-file-image').getAttribute('src'), /\/api\/tasks\/1\/files\/image\?path=photo\.png$/);
    assert.equal(await page.locator('#h5-file-image-open').getAttribute('aria-label'), 'View image');
    await shot(page, 'h5-file-image.png');
    await page.locator('#h5-file-image-open').tap();
    await page.locator('.MuiDialog-root img').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.MuiDialog-root img').waitFor({ state: 'detached' });
    await back(page);

    // PDF, audio, video: read raw after a one-byte probe.
    await openFile(page, 'doc.pdf');
    await page.locator('#h5-file-pdf').waitFor();
    assert.match(await page.locator('#h5-file-pdf').getAttribute('src'), /\/files\/raw\?path=doc\.pdf$/);
    assert.equal(await page.locator('#h5-file-pdf').getAttribute('sandbox'), null);
    assert.equal(await page.locator('#h5-file-open-tab').getAttribute('target'), '_blank');
    assert.ok(requests.includes('raw doc.pdf bytes=0-0'), 'probed with one byte');
    await back(page);
    await openFile(page, 'song.mp3');
    await page.locator('#h5-file-audio').waitFor();
    assert.match(await page.locator('#h5-file-audio').getAttribute('src'), /\/files\/raw\?path=song\.mp3$/);
    await back(page);
    await openFile(page, 'clip.mp4');
    await page.locator('#h5-file-video').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#h5-file-video').evaluate(node => node.playsInline), true);
    await back(page);
    await openFile(page, 'gone.pdf');
    await page.locator('#h5-design-empty', { hasText: 'Not found in the working directory: gone.pdf' }).waitFor();
    await back(page);
    assert.equal(requests.filter(entry => entry.startsWith('content ') && /\.(png|pdf|mp3|mp4)$/.test(entry)).length, 0, 'binary kinds are never read as text');

    assert.deepEqual(errors, []);
    await context.close();

    // A computer, a remote Engine without 'files:raw': the note, and the file is not read.
    {
      const pc = await openPage(browser, { desktop: true });
      const p = pc.page;
      await p.locator('#h5-engine').selectOption('remote:7');
      await p.locator('.h5-task-item', { hasText: 'Remote job' }).click();
      const remoteRow = p.locator('#h5-tasks .h5-terminal-list[aria-label="Remote job"] .h5-terminal-main').first();
      await remoteRow.waitFor();
      await remoteRow.click();
      await p.locator('#h5-design').click();
      await p.locator('#h5-design-files').click();
      await p.locator('#h5-files-tree [data-path="doc.pdf"]').click();
      await p.locator('#h5-design-empty', { hasText: 'This Engine cannot show this file type' }).waitFor();
      assert.equal(pc.requests.filter(entry => entry.startsWith('raw ')).length, 0, 'nothing is read');
      // An image of the remote Engine is read through the proxy.
      await p.locator('#h5-design-back').click();
      await p.locator('#h5-files-tree [data-path="photo.png"]').click();
      await p.locator('#h5-file-image').waitFor();
      assert.match(await p.locator('#h5-file-image').getAttribute('src'), /^\/api\/remote-servers\/7\/tasks\/5\/files\/image\?path=photo\.png$/);
      assert.deepEqual(pc.errors, []);
      await pc.context.close();
    }
    console.log('h5 file viewers browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
