// The collection hooks of English learning in real Chromium ("Collection hooks" in docs/design/learn-english.md; public/js/learn-collect.js):
// translate-and-send (computer row and phone) posts one sentence card with the typed Chinese and the sent English, without delaying the send even
// while the learning API is slow; "send as typed", text the translator left as it was and collect=false post nothing; tap to translate posts a word
// card in its dictionary form. The server is mocked (no data folder is used).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const ZH = '\u8bf7\u4fee\u590d\u767b\u5f55\u9875\u9762'; // what the person types
const EN = 'Please fix the login page';
const SLOW_MS = 3000; // the learning API answers this late: the send must not wait for it
const pageErrors = [];

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

async function openPage(browser, device, { collect = true } = {}) {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const learn = { settings: 0, cards: [] };
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/translate' && method === 'POST') {
      const text = route.request().postDataJSON().text;
      // English typed into the box is sent unchanged, as the real translator does (translated: false).
      return json(/[\u4e00-\u9fff]/.test(text) ? { text: EN, translated: true } : { text, translated: false });
    }
    if (url.pathname === '/api/learn/settings' && method === 'GET') {
      learn.settings += 1;
      await new Promise(resolve => setTimeout(resolve, SLOW_MS));
      return json({ collect, daily_goal: 20, starter: 'dev' });
    }
    if (url.pathname === '/api/learn/cards' && method === 'POST') {
      assert.equal(route.request().headers()['x-requested-with'], 'XMLHttpRequest');
      learn.cards.push(route.request().postDataJSON());
      return json({ card: { id: learn.cards.length }, created: true });
    }
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/terminal-activity') return json({});
    if (url.pathname === '/api/tasks/terminal-subagents') return json({});
    if (/^\/api\/tasks\/1\/terminals$/.test(url.pathname) && method === 'GET') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).click();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).click();
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  return { context, page, input: page.locator('#h5-translate-input'), learn };
}

const typedToTerminal = page => page.evaluate(() => window.sockets.at(-1).sent.filter(item => !item.startsWith('{')));
// Types the text and presses the button; returns what reached the terminal and how long the text and its Enter took to get there.
async function press(page, input, button, text) {
  const before = (await typedToTerminal(page)).length;
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await input.focus();
  else await input.click();
  await input.fill(text);
  if (button === '#h5-translate-send' && await page.locator('#h5-more').isVisible()) await page.locator('#h5-more').click();
  const started = Date.now();
  await page.locator(button).click();
  await page.waitForFunction(count => window.sockets.at(-1).sent.filter(item => !item.startsWith('{')).length >= count + 2, before);
  const elapsed = Date.now() - started;
  return { sent: (await typedToTerminal(page)).slice(before), elapsed };
}
// Waits until the slow settings read has been answered and anything that follows it has had its chance to be sent.
const settle = page => page.waitForTimeout(SLOW_MS + 500);

async function translateFlow(browser, device, label) {
  const { context, page, input, learn } = await openPage(browser, device);
  const { sent, elapsed } = await press(page, input, '#h5-translate-button', ZH);
  assert.deepEqual(sent, [EN, '\r'], `${label}: the English and Enter are sent`);
  assert.ok(elapsed < SLOW_MS - 500, `${label}: sending did not wait for the learning API (${elapsed} ms)`);
  assert.equal(learn.cards.length, 0, `${label}: the card waits for the switch, the send does not`);
  await settle(page);
  assert.deepEqual(learn.cards, [{ kind: 'sentence', en: EN, zh: ZH, source: 'translation', context: 'Fix login' }], `${label}: one sentence card`);
  assert.equal(learn.settings, 1, `${label}: the switch is read once`);

  // The send arrow sends as typed: nothing was translated, nothing is collected. English sent through the translate button is not a translation either.
  await press(page, input, '#h5-translate-send', 'please run all the tests');
  await press(page, input, '#h5-translate-button', 'please run all the tests again');
  await page.waitForTimeout(500);
  assert.equal(learn.cards.length, 1, `${label}: send as typed and untranslated text post nothing`);
  // The same sentence again in this page load is not sent twice; the switch is not read again.
  await press(page, input, '#h5-translate-button', ZH);
  await page.waitForTimeout(500);
  assert.equal(learn.cards.length, 1);
  assert.equal(learn.settings, 1);
  await context.close();
}

async function collectOff(browser) {
  const { context, page, input, learn } = await openPage(browser, DESKTOP, { collect: false });
  const { sent } = await press(page, input, '#h5-translate-button', ZH);
  assert.deepEqual(sent, [EN, '\r']);
  await settle(page);
  assert.equal(learn.settings, 1);
  assert.deepEqual(learn.cards, [], 'collect off: nothing is posted');
  await context.close();
}

// Tap to translate (word-translate.js) in a chat-like page: a shown meaning posts a word card, in its dictionary form.
async function tapFlow(browser) {
  const scripts = ['public/js/local-keys.js', 'public/js/learn-collect.js', 'public/js/word-translate.js'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const css = fs.readFileSync(path.join(root, 'public/css/agent-chat.css'), 'utf8');
  const html = `<!doctype html><meta charset="utf-8"><style>${css} body { margin: 0; font: 16px/1.5 sans-serif; } p { margin: 8px; }</style>
<div class="agent-chat" style="height:auto"><div class="ac-text"><p id="p1">The conflicts were resolved by a merge.</p></div></div><script>${scripts}</script>`;
  const server = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(html));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const tab = await (await browser.newContext({ viewport: { width: 400, height: 500 } })).newPage();
    tab.on('pageerror', error => pageErrors.push(error.message));
    const cards = [];
    let collect = true;
    await tab.route('**/api/translate/word', route => {
      const { word } = route.request().postDataJSON();
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ word, base: word === 'resolved' ? 'resolve' : word.toLowerCase(), phonetic: word === 'conflicts' ? '/ˈkɑnflɪkts/' : '', pos: 'v.', meaning: `\u610f\u601d:${word}` }) });
    });
    await tab.route('**/api/learn/settings', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ collect, daily_goal: 20, starter: 'dev' }) }));
    await tab.route('**/api/learn/cards', route => { cards.push(route.request().postDataJSON()); route.fulfill({ contentType: 'application/json', body: '{"card":{"id":1},"created":true}' }); });
    await tab.goto(`http://localhost:${server.address().port}/`);
    await tab.evaluate(() => WordTranslate.setEnabled(true));
    const tap = async text => {
      const point = await tab.evaluate(w => {
        const node = document.querySelector('#p1').firstChild;
        const range = document.createRange();
        const from = node.data.indexOf(w);
        range.setStart(node, from); range.setEnd(node, from + w.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, text);
      await tab.mouse.move(point.x, point.y); await tab.mouse.down(); await tab.mouse.up();
      await tab.waitForSelector('.wt-meaning');
    };
    await tap('resolved');
    await tab.waitForTimeout(400);
    assert.deepEqual(cards, [{ kind: 'word', en: 'resolve', zh: '\u610f\u601d:resolved', source: 'lookup' }], 'the dictionary form with the meaning that was shown');
    await tab.keyboard.press('Escape');
    await tap('resolved');
    await tab.waitForTimeout(300);
    assert.equal(cards.length, 1, 'tapped again: the same word is not posted twice');
    // Collecting turned off on the Learn page (LearnCollect.set): a shown meaning posts nothing.
    await tab.evaluate(() => LearnCollect.set(false));
    await tab.keyboard.press('Escape');
    await tap('merge');
    await tab.waitForTimeout(300);
    assert.equal(cards.length, 1, 'collect off: nothing is posted');
    await tab.evaluate(() => LearnCollect.set(true));
    await tab.keyboard.press('Escape');
    await tap('conflicts');
    await tab.waitForTimeout(300);
    assert.deepEqual(cards.at(-1), { kind: 'word', en: 'conflicts', zh: '\u610f\u601d:conflicts', source: 'lookup', phonetic: '/ˈkɑnflɪkts/' }, 'the transcription that was shown goes with it');
  } finally { server.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await translateFlow(browser, DESKTOP, 'computer');
    await translateFlow(browser, PHONE, 'phone');
    await collectOff(browser);
    await tapFlow(browser);
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('h5 learning collection hooks: all checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
