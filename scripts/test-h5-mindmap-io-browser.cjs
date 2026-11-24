// Mind maps in and out, in real Chromium ("Export and import" and "Copy and paste" in docs/design/mind-maps.md): the Export menu (XMind with
// content.json and content.xml, Markdown, OPML, FreeMind, outline text, and copying the map as text), the Import menu (a file of any of those kinds,
// chosen by content, from text with its live count, from the clipboard, and a file dropped on the list), and topics copied to and pasted from other
// apps (plain text, an HTML list and the exact topics together). The /api/mindmaps endpoints are mocked here. Also the phone's bottom sheets.
const { chromium } = require('playwright');
const { bnavTap } = require('./h5-bottom-nav-tap.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://localhost:4931'; // localhost is a secure context, as https is: the async clipboard works there
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const failures = [];
const pageErrors = [];
let currentCase = '';
const check = (ok, message) => { if (!ok) { failures.push(`${currentCase}: ${message}`); console.log(`  FAILED ${message}`); } };

function createServer() {
  let nextId = 1;
  const maps = new Map();
  const stamp = () => new Date().toISOString();
  const make = (title, data) => { const id = `m${nextId++}`; const map = { id, title: title || 'Untitled map', data: data ?? null, revision: 1, created_at: stamp(), updated_at: stamp() }; maps.set(id, map); return map; };
  async function handle(route, request, pathname, json) {
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    if (pathname === '/api/mindmaps' && method === 'GET') return json({ maps: [...maps.values()].reverse().map(({ data, ...rest }) => ({ ...rest, size: JSON.stringify(data || {}).length })) });
    if (pathname === '/api/mindmaps' && method === 'POST') return json(make(body.title, body.data), 201);
    const m = pathname.match(/^\/api\/mindmaps\/([^/]+)$/);
    if (!m) return null;
    const map = maps.get(m[1]);
    if (!map) return json({ error: 'MINDMAP_NOT_FOUND' }, 404);
    if (method === 'GET') return json(map);
    if (method === 'PUT') {
      if (body.revision !== map.revision) return json({ error: 'MINDMAP_CONFLICT', current_revision: map.revision }, 409);
      map.revision += 1;
      if (body.title !== undefined) map.title = body.title;
      if (body.data !== undefined) map.data = body.data;
      return json({ id: map.id, title: map.title, revision: map.revision, updated_at: stamp() });
    }
    return null;
  }
  return { maps, handle, make };
}

async function openPage(browser, { touch }) {
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: touch, hasTouch: touch, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`${currentCase}: ${error.message}`));
  const server = createServer();
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(data); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    localStorage.setItem('h5-task:local', '1');
    localStorage.setItem('h5-terminal:local:1', 'h5-default');
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname.startsWith('/api/mindmaps')) { const answered = await server.handle(route, request, pathname, json); if (answered !== null) return answered; return json({ error: 'not mocked' }, 404); }
    if (pathname === '/api/remote-servers') return json([]);
    if (pathname === '/api/tasks') return json([{ id: 1, title: 'Alpha', status: 'doing', work_dir: '/work/a' }]);
    if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json({});
    if (pathname === '/api/tasks/1/terminals') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname === '/api/oss/config') return json({ enabled: false });
    if (pathname === '/api/system/check-update' || pathname === '/api/system/update-status') return json({ status: 'current', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets[0].readyState === 1);
  return { context, page, server };
}

async function openView(page, touch) {
  if (touch) {
    if (await page.locator('#h5-tasks').isVisible().catch(() => false)) { await page.locator('#h5-close-tasks').tap(); await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); }
    await bnavTap(page, '#h5-bnav-maps');
  } else {
    await page.evaluate(() => window.H5UI.actions.openMindmaps());
  }
  await page.locator('#mm-new').waitFor();
}
const topicTexts = page => page.evaluate(() => [...document.querySelectorAll('.mm-canvas .me-tpc')].map(el => el.textContent));
const tree = node => ({ t: node.topic, c: (node.children || []).map(tree) });
const flat = node => [node.topic, ...(node.children || []).flatMap(flat)];
const lastMap = server => [...server.maps.values()].at(-1);
const bodyHas = (page, re) => page.waitForFunction(source => new RegExp(source).test(document.body.textContent), re.source);
const backToList = async page => { await page.locator('#mm-back').click(); await page.locator('.mm-row').first().waitFor(); };

// A map with notes, a link, a folded branch and an arrow, stored on the mocked server and opened.
const SAMPLE = {
  nodeData: { id: 'r', topic: 'Q1 launch', children: [
    { id: 'a', topic: 'Scope', note: 'What ships', children: [{ id: 'a1', topic: 'Login page', children: [] }, { id: 'a2', topic: 'Pay & <ment>', hyperLink: 'https://example.com/pay', children: [] }] },
    { id: 'b', topic: 'Timeline \u65f6\u95f4', children: [] },
    { id: 'c', topic: 'Risks', expanded: false, children: [{ id: 'c1', topic: 'Vendor delay', children: [] }] },
  ] },
  arrows: [{ id: 'x', label: 'needs', from: 'a1', to: 'c1', delta1: { x: 80, y: -40 }, delta2: { x: -80, y: -40 } }],
  summaries: [],
  direction: 1,
};
const EXPECTED = tree(SAMPLE.nodeData);

async function openSample(page, server) {
  const map = server.make('Q1 launch', JSON.parse(JSON.stringify(SAMPLE)));
  await openView(page, false);
  await page.locator('.mm-row', { hasText: 'Q1 launch' }).first().waitFor();
  await page.locator('.mm-row-open', { hasText: 'Q1 launch' }).first().click();
  await page.locator('.me-tpc', { hasText: 'Scope' }).waitFor();
  return server.maps.get(map.id);
}

const CASES = {
  async 'computer: the Export menu writes every format and copies the map as text'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    const { unzipSync, strFromU8 } = await import('fflate');
    await openSample(page, server);

    await page.locator('#mm-export').click();
    await page.locator('.mm-popmenu').waitFor();
    const items = await page.locator('.mm-popmenu .mm-menu-item').evaluateAll(list => list.map(n => n.id));
    check(JSON.stringify(items) === JSON.stringify(['mm-export-xmind', 'mm-export-md', 'mm-export-opml', 'mm-export-mm', 'mm-export-txt', 'mm-copy-md', 'mm-copy-txt']), `the menu items: ${items}`);
    check(await page.evaluate(() => document.activeElement.id === 'mm-export-xmind'), 'the first item has the keyboard');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement.id === 'mm-export-md'), 'ArrowDown moves to the next item');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    check(await page.evaluate(() => document.activeElement.id === 'mm-copy-txt'), 'ArrowUp wraps to the last item');
    const box = await page.locator('.mm-popmenu').boundingBox();
    const button = await page.locator('#mm-export').boundingBox();
    check(box.y >= button.y + button.height && box.x + box.width <= 1280, `the menu drops from its button and stays in the view: ${JSON.stringify(box)}`);
    await page.keyboard.press('Escape');
    await page.locator('.mm-popmenu').waitFor({ state: 'detached' });

    const save = async key => {
      const download = page.waitForEvent('download');
      await page.locator('#mm-export').click();
      await page.locator(`#mm-export-${key}`).click();
      const file = await download;
      return { name: file.suggestedFilename(), bytes: fs.readFileSync(await file.path()) };
    };
    const xmind = await save('xmind');
    const entries = unzipSync(new Uint8Array(xmind.bytes));
    check(xmind.name === 'Q1 launch.xmind', `the file name: ${xmind.name}`);
    for (const name of ['content.json', 'content.xml', 'META-INF/manifest.xml', 'metadata.json']) check(entries[name], `the .xmind has ${name}`);
    check(/<title>Pay &amp; &lt;ment&gt;<\/title>/.test(strFromU8(entries['content.xml'])), 'content.xml has the escaped text');

    const md = await save('md');
    const mdText = md.bytes.toString('utf8');
    check(md.name === 'Q1 launch.md' && /^# Q1 launch\n/.test(mdText) && /\n- Scope\n/.test(mdText) && /\[Pay & <ment>\]\(https:\/\/example\.com\/pay\)/.test(mdText) && mdText.includes('What ships'), `the Markdown: ${mdText}`);
    const opml = (await save('opml')).bytes.toString('utf8');
    check(/<opml version="2\.0">/.test(opml) && /text="Pay &amp; &lt;ment&gt;"/.test(opml) && /_note="What ships"/.test(opml), `the OPML: ${opml}`);
    const mm = (await save('mm')).bytes.toString('utf8');
    check(/^<map version="1\.0\.1">/.test(mm.trim()) && /FOLDED="true"/.test(mm) && /<arrowlink /.test(mm), `the FreeMind file: ${mm}`);
    const txt = (await save('txt')).bytes.toString('utf8');
    check(txt.startsWith('Q1 launch\n\tScope\n\t\tLogin page\n'), `the outline text: ${JSON.stringify(txt)}`);

    // Every export reads back as the same tree (through the page's own Import, as a person would).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-io-'));
    try {
      // Each file has its own name, so the wait below sees this import's map and not the one opened by the import before it.
      for (const [name, bytes] of [['back-xmind.xmind', xmind.bytes], ['back-md.md', md.bytes], ['back-opml.opml', Buffer.from(opml)], ['back-mm.mm', Buffer.from(mm)], ['back-txt.txt', Buffer.from(txt)]]) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, bytes);
        const before = server.maps.size;
        await page.locator('.mm-file').setInputFiles(file);
        await page.waitForFunction(title => document.querySelector('.mm-title') && document.querySelector('.mm-title').value === title, path.basename(name, path.extname(name)));
        check(server.maps.size === before + 1, `${name} made a map`);
        const map = lastMap(server);
        check(JSON.stringify(tree(map.data.nodeData)) === JSON.stringify(EXPECTED), `${name} reads back as the same tree: ${JSON.stringify(tree(map.data.nodeData))}`);
        if (!name.endsWith('.txt')) check(flat(map.data.nodeData).length === 7 && map.data.nodeData.children[0].note === 'What ships', `${name} keeps the note`);
        if (/xmind|mm$/.test(name)) check(map.data.arrows.length === 1 && map.data.nodeData.children[2].expanded === false, `${name} keeps the arrow and the folded branch`);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }

    // Copy as outline text / Markdown: the system clipboard has the whole map.
    await page.locator('#mm-export').click();
    await page.locator('#mm-copy-txt').click();
    await bodyHas(page, /Copied/);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(copied.startsWith('Q1 launch\n\tScope\n\t\tLogin page'), `Copy as outline text: ${JSON.stringify(copied)}`);
    await page.locator('#mm-export').click();
    await page.locator('#mm-copy-md').click();
    await page.waitForFunction(async () => (await navigator.clipboard.readText()).startsWith('# Q1 launch'));
    await context.close();
  },

  async 'computer: Import from a file, from text, from the clipboard and by dropping a file'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    await openView(page, false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-io-'));
    try {
      await page.locator('#mm-import').click();
      const ids = await page.locator('.mm-popmenu .mm-menu-item').evaluateAll(list => list.map(n => n.id));
      check(JSON.stringify(ids) === JSON.stringify(['mm-import-file', 'mm-import-text', 'mm-import-clipboard']), `the Import menu: ${ids}`);
      check((await page.locator('.mm-file').getAttribute('accept')) === '.xmind,.mm,.opml,.md,.markdown,.txt', 'the file chooser offers every kind');
      await page.keyboard.press('Escape');

      // A file chosen by its content: OPML saved as .txt (MindNode's export renamed).
      const opml = path.join(dir, 'Reading.txt');
      fs.writeFileSync(opml, '<?xml version="1.0"?><opml version="2.0"><head><title>Reading</title></head><body><outline text="Books"><outline text="Dune" _note="Herbert"/><outline text="Emma"/></outline></body></opml>');
      await page.locator('.mm-file').setInputFiles(opml);
      await page.locator('.me-tpc', { hasText: 'Dune' }).waitFor();
      check(lastMap(server).title === 'Reading' && lastMap(server).data.nodeData.topic === 'Books' && lastMap(server).data.nodeData.children[0].note === 'Herbert', `OPML in a .txt: ${JSON.stringify(lastMap(server))}`);
      await backToList(page);

      // A file that cannot be a map says so and makes nothing.
      const before = server.maps.size;
      const bad = path.join(dir, 'bad.xmind');
      fs.writeFileSync(bad, 'hello');
      await page.locator('.mm-file').setInputFiles(bad);
      await bodyHas(page, /not a \.xmind file/);
      check(server.maps.size === before, 'a text file named .xmind makes nothing');

      // From text: the live count, then Create map.
      await page.locator('#mm-import').click();
      await page.locator('#mm-import-text').click();
      await page.locator('#mm-import-text-input').waitFor();
      check(await page.locator('.mm-dialog .mm-btn-primary').isDisabled(), 'Create map waits for an outline');
      await page.locator('#mm-import-text-input').fill('# Q1 launch\n- Scope\n  - Login page\n  - Payments\n- Timeline\n- Risks\n  - Vendor delay');
      await page.waitForFunction(() => /7 topics · 3 levels · root: Q1 launch/.test(document.querySelector('#mm-import-count').textContent));
      await page.locator('.mm-dialog .mm-btn-primary').click();
      await page.locator('.me-tpc', { hasText: 'Vendor delay' }).waitFor();
      check(JSON.stringify(tree(lastMap(server).data.nodeData)) === JSON.stringify({ t: 'Q1 launch', c: [{ t: 'Scope', c: [{ t: 'Login page', c: [] }, { t: 'Payments', c: [] }] }, { t: 'Timeline', c: [] }, { t: 'Risks', c: [{ t: 'Vendor delay', c: [] }] }] }), `from text: ${JSON.stringify(tree(lastMap(server).data.nodeData))}`);
      check(lastMap(server).title === 'Q1 launch', 'the title is the root topic');
      await backToList(page);

      // From the clipboard: an HTML list (a copy from a document or a web page).
      await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob(['<ul><li>Trip<ul><li><a href="https://example.com/">Hotel</a></li><li>Train<script>window.bad = 1</script></li></ul></li></ul>'], { type: 'text/html' }),
        'text/plain': new Blob(['Trip\n  Hotel\n  Train'], { type: 'text/plain' }),
      })]));
      await page.locator('#mm-import').click();
      await page.locator('#mm-import-clipboard').click();
      await page.locator('.me-tpc', { hasText: 'Hotel' }).waitFor();
      const trip = lastMap(server).data.nodeData;
      check(trip.topic === 'Trip' && trip.children[0].hyperLink === 'https://example.com/' && trip.children[1].topic.startsWith('Train'), `from the clipboard: ${JSON.stringify(trip)}`);
      check(await page.evaluate(() => window.bad === undefined), 'no script from the clipboard ran');
      await backToList(page);

      // A file dropped on the list.
      await page.evaluate(() => {
        const list = document.querySelector('.mm-list');
        const data = new DataTransfer();
        data.items.add(new File(['Garden\n\tTomatoes\n\tBeans'], 'Garden.md', { type: 'text/markdown' }));
        list.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
        window.dropShown = getComputedStyle(document.querySelector('.mm-drop')).display !== 'none';
        list.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      });
      check(await page.evaluate(() => window.dropShown), 'the drop hint shows while a file is over the list');
      await page.locator('.me-tpc', { hasText: 'Beans' }).waitFor();
      check(lastMap(server).title === 'Garden' && lastMap(server).data.nodeData.children.length === 2, 'the dropped file became a map');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    await context.close();
  },

  async 'computer: copy puts text, an HTML list and the exact topics on the clipboard; paste reads outlines from other apps'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    const map = await openSample(page, server);

    // Copy Scope: the three forms.
    await page.locator('.me-tpc', { hasText: 'Scope' }).click();
    // The editor takes the copy in the capture phase and stops it there, so the forms are read from the event's own DataTransfer once the
    // (synchronous) dispatch is over, not from a listener of the test that would never be called.
    const copied = await page.evaluate(() => {
      const data = new DataTransfer();
      const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
      document.querySelector('.mm-canvas').dispatchEvent(event);
      return { taken: event.defaultPrevented, text: data.getData('text/plain'), html: data.getData('text/html'), custom: data.getData('application/x-t-agent-mindmap+json') };
    });
    check(copied.taken, 'the editor takes the copy');
    check(copied.text === 'Scope\n\tLogin page\n\tPay & <ment>', `plain text: ${JSON.stringify(copied.text)}`);
    check(/<ul><li>Scope<ul><li>Login page<\/li><li><a href="https:\/\/example\.com\/pay">Pay &amp; &lt;ment&gt;<\/a><\/li><\/ul><\/li><\/ul>/.test(copied.html), `HTML: ${copied.html}`);
    check(JSON.parse(copied.custom).data[0].note === 'What ships', 'the exact topics keep the note');

    const paste = async (forms, onto) => {
      await page.locator('.me-tpc', { hasText: onto }).first().click();
      await page.evaluate(f => {
        const data = new DataTransfer();
        for (const [type, value] of Object.entries(f)) data.setData(type, value);
        document.querySelector('.mm-canvas').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, forms);
    };
    // Exact topics: the note comes along, no message.
    await paste({ 'application/x-t-agent-mindmap+json': copied.custom, 'text/plain': copied.text }, 'Timeline');
    // 6 topics are drawn (Vendor delay is inside the folded Risks), and the pasted Scope adds 3.
    await page.waitForFunction(() => document.querySelectorAll('.mm-canvas .me-tpc').length === 9);
    await page.locator('.mm-status[data-state="saved"]').waitFor({ timeout: 8000 });
    const timeline = map.data.nodeData.children.find(node => node.topic.startsWith('Timeline'));
    check(timeline.children[0].topic === 'Scope' && timeline.children[0].note === 'What ships' && timeline.children[0].children.length === 2, `the exact paste: ${JSON.stringify(timeline)}`);

    // A tab outline from XMind or MindNode: levels kept, a message says where it went.
    await paste({ 'text/plain': 'Ideas\n\tOne\n\t\tOne a\n\tTwo' }, 'Login page');
    await bodyHas(page, /Pasted 4 topics under “Login page”/);
    await page.locator('.mm-status[data-state="saved"]').waitFor({ timeout: 8000 });
    const login = map.data.nodeData.children[0].children[0];
    check(JSON.stringify(tree(login)) === JSON.stringify({ t: 'Login page', c: [{ t: 'Ideas', c: [{ t: 'One', c: [{ t: 'One a', c: [] }] }, { t: 'Two', c: [] }] }] }), `a tab outline: ${JSON.stringify(tree(login))}`);

    // Markdown from Obsidian or Typora, and an HTML list from Notion (the HTML wins over its plain text). Risks is unfolded first, so that
    // Vendor delay can be chosen.
    await page.locator('.me-tpc', { hasText: 'Risks' }).click();
    await page.keyboard.press(`${mod}+/`);
    await page.locator('.me-tpc', { hasText: 'Vendor delay' }).waitFor();
    await paste({ 'text/plain': '- Alpha\n    - Beta\n- Gamma' }, 'Vendor delay');
    await bodyHas(page, /Pasted 3 topics under “Vendor delay”/);
    await paste({ 'text/html': '<ol><li>North<ol><li>Pole</li></ol></li></ol>', 'text/plain': 'North Pole' }, 'Risks');
    await page.locator('.mm-status[data-state="saved"]').waitFor({ timeout: 8000 });
    await page.waitForFunction(() => /North/.test(document.querySelector('.mm-canvas').textContent));
    const risks = map.data.nodeData.children[2];
    check(risks.children.some(node => node.topic === 'North' && node.children[0].topic === 'Pole'), `an HTML list: ${JSON.stringify(tree(risks))}`);
    const vendor = risks.children[0];
    check(JSON.stringify(tree(vendor)) === JSON.stringify({ t: 'Vendor delay', c: [{ t: 'Alpha', c: [{ t: 'Beta', c: [] }] }, { t: 'Gamma', c: [] }] }), `Markdown: ${JSON.stringify(tree(vendor))}`);

    // One undo takes a whole paste away.
    const count = (await topicTexts(page)).length;
    await page.keyboard.press(`${mod}+z`);
    await page.waitForFunction(n => document.querySelectorAll('.mm-canvas .me-tpc').length === n - 2, count);
    await context.close();
  },

  async 'phone: Export and Import are bottom sheets'(browser) {
    const { context, page, server } = await openPage(browser, { touch: true });
    await openView(page, true);
    await page.locator('#mm-import').tap();
    await page.locator('.mm-sheet').waitFor();
    const sheet = await page.locator('.mm-sheet').boundingBox();
    // The view ends above the bottom navigation, which stays shown (as the T-Attention and Settings sheets do), so the sheet sits on the
    // navigation, not at the bottom of the window.
    const view = await page.locator('#h5-mindmap').boundingBox();
    const nav = await page.locator('#h5-bnav').boundingBox();
    check(Math.abs(sheet.y + sheet.height - view.y - view.height) < 2 && Math.abs(view.y + view.height - nav.y) < 2 && sheet.width === 390, `the Import sheet sits at the bottom: ${JSON.stringify({ sheet, view, nav })}`);
    check(await page.locator('.mm-sheet .mm-sheet-title', { hasText: 'Import' }).count() === 1, 'the sheet has its title');
    const heights = await page.locator('.mm-sheet .mm-menu-item').evaluateAll(list => list.map(n => n.getBoundingClientRect().height));
    check(heights.length === 3 && heights.every(h => h >= 44), `touch targets: ${heights}`);
    await page.locator('#mm-import-text').tap();
    await page.locator('#mm-import-text-input').fill('Plan\n  Step one\n  Step two');
    await page.waitForFunction(() => /3 topics/.test(document.querySelector('#mm-import-count').textContent));
    await page.locator('.mm-dialog .mm-btn-primary').tap();
    await page.locator('.me-tpc', { hasText: 'Step two' }).waitFor();
    check(lastMap(server).data.nodeData.topic === 'Plan', 'the map from text');
    await page.locator('#mm-export').tap();
    await page.locator('.mm-sheet').waitFor();
    check(await page.locator('.mm-sheet .mm-menu-item').count() === 7, 'the Export sheet has every item');
    check(await page.locator('.mm-sheet .mm-menu-caption').count() === 1, 'the sheet says where the file goes');
    await page.mouse.click(195, 100); // the scrim closes it
    await page.locator('.mm-sheet').waitFor({ state: 'detached' });
    await context.close();
  },
};

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [name, run] of Object.entries(CASES)) {
      if (process.env.MINDMAP_ONLY && !name.includes(process.env.MINDMAP_ONLY)) continue;
      currentCase = name;
      console.log(`case: ${name}`);
      // A step that never settles (an evaluate has no timeout of its own) fails this case after two minutes instead of hanging the run.
      let timer;
      await Promise.race([run(browser), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`case timed out after 120 s: ${name}`)), 120000); })]).finally(() => clearTimeout(timer));
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'all checks pass');
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Mind maps in and out passed.');
})().catch(error => { console.error(error); console.error(failures); process.exit(1); });
