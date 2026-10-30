// Browser test of tap to translate: what a tap on an English word in the chat does with the option on and off, where it does nothing, and the popup.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/js/word-translate.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/agent-chat.css'), 'utf8');

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; font: 16px/1.5 sans-serif; } #scroller { height: 380px; overflow: auto; } .spacer { height: 600px; } p { margin: 8px; }</style>
<div class="agent-chat" style="height:auto">
  <div id="scroller">
    <div class="ac-text"><p id="p1">The conflict was resolved by a merge. It wasn't a well-known fix, so we tried again.</p>
      <p id="p2">Open <a href="#x" id="link">the link</a> or press <button id="btn">this button</button> and see <code id="code">resolved</code> here.</p>
      <pre id="pre">const resolved = true</pre><p id="p3">\u6570\u5b57 42 and \u4e2d\u6587 mixed with English words.</p></div>
    <div class="ac-tool"><p id="tool">tool output resolved</p></div>
    <div class="ac-user"><p id="user">please translate this</p></div>
    <div class="spacer"></div><div class="ac-text"><p id="low">A word near the bottom.</p></div>
  </div>
  <form class="ac-composer"><textarea id="box">typed resolved text</textarea></form>
</div>
<script>window.asked = []; ${script}</script>`;

const server = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(page));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const tab = await (await browser.newContext({ viewport: { width: 400, height: 500 } })).newPage();
    const errors = [];
    tab.on('pageerror', error => errors.push(error.message));
    let respond = body => ({ status: 200, body: { word: body.word, base: body.word === 'resolved' ? 'resolve' : body.word.toLowerCase(), phonetic: '/fɒnɛtɪk/', pos: 'n.', meaning: `\u610f\u601d:${body.word}` } });
    let delayMs = 0;
    await tab.route('**/api/translate/word', async route => {
      const body = route.request().postDataJSON();
      assert.equal(route.request().headers()['x-requested-with'], 'XMLHttpRequest');
      await tab.evaluate(b => window.asked.push(b), body);
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      const answer = respond(body);
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
    });
    await tab.goto(origin);
    const asked = () => tab.evaluate(() => window.asked);
    const popup = tab.locator('.wt-popup');
    // The centre of the n-th word of an element, so a tap lands on that word.
    const wordPoint = (selector, word, nth = 0) => tab.evaluate(([sel, w, n]) => {
      const node = document.querySelector(sel).firstChild.nodeType === 3 ? document.querySelector(sel).firstChild : [...document.querySelector(sel).childNodes].find(child => child.nodeType === 3);
      let from = -1;
      for (let i = 0; i <= n; i += 1) from = node.data.indexOf(w, from + 1);
      const range = document.createRange();
      range.setStart(node, from); range.setEnd(node, from + w.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } };
    }, [selector, word, nth]);
    const tap = async point => { await tab.mouse.move(point.x, point.y); await tab.mouse.down(); await tab.mouse.up(); };

    // Off by default: nothing happens.
    assert.equal(await tab.evaluate(() => WordTranslate.enabled), false);
    await tap(await wordPoint('#p1', 'resolved'));
    await tab.waitForTimeout(200);
    assert.equal(await popup.count(), 0);
    assert.deepEqual(await asked(), [], 'nothing is asked while the option is off');

    // On: a tap on a word shows its meaning beside it, with the sentence it stands in.
    await tab.evaluate(() => WordTranslate.setEnabled(true));
    assert.equal(await tab.evaluate(() => localStorage.getItem('word-translate')), '1', 'kept on this device');
    assert.equal(await tab.evaluate(() => document.body.classList.contains('wt-on')), true);
    const at = await wordPoint('#p1', 'resolved');
    await tap(at);
    await popup.waitFor();
    await tab.waitForSelector('.wt-meaning');
    assert.equal(await tab.locator('.wt-word').textContent(), 'resolved');
    assert.equal(await tab.locator('.wt-meaning').textContent(), '\u610f\u601d:resolved');
    assert.equal(await tab.locator('.wt-phonetic').textContent(), '/fɒnɛtɪk/');
    assert.equal(await tab.locator('.wt-pos').textContent(), 'n.');
    assert.match(await tab.locator('.wt-base').textContent(), /Base form: resolve/, 'the base form is shown when it differs');
    assert.deepEqual(await asked(), [{ word: 'resolved', context: 'The conflict was resolved by a merge.' }], 'the sentence of the word, not the whole message');
    const box = await popup.boundingBox();
    assert.ok(box.y >= at.rect.bottom - 1 && box.y < at.rect.bottom + 30, 'the popup is just below the word');
    assert.ok(box.x >= 0 && box.x + box.width <= 400, 'and inside the window');
    // The word is marked while its meaning is shown (where the browser supports it).
    if (await tab.evaluate(() => typeof CSS !== 'undefined' && Boolean(CSS.highlights))) assert.equal(await tab.evaluate(() => CSS.highlights.has('wt-word')), true);

    // Another word replaces it; the same word again is answered from memory.
    await tap(await wordPoint('#p1', 'merge'));
    await tab.waitForFunction(() => document.querySelector('.wt-word')?.textContent === 'merge' && document.querySelector('.wt-meaning'));
    assert.equal((await asked()).length, 2);
    assert.equal(await popup.count(), 1, 'one popup at a time');
    await tap(await wordPoint('#p1', 'resolved'));
    await tab.waitForFunction(() => document.querySelector('.wt-word')?.textContent === 'resolved');
    assert.equal((await asked()).length, 2, 'asking again costs nothing');

    // Words with an apostrophe or a hyphen are one word; the sentence is the one the word is in.
    await tap(await wordPoint('#p1', "wasn't"));
    await tab.waitForFunction(() => document.querySelector('.wt-word')?.textContent === "wasn't");
    await tap(await wordPoint('#p1', 'well')); // the first part of the word: a hyphenated word may break over two lines
    await tab.waitForFunction(() => document.querySelector('.wt-word')?.textContent === 'well-known');
    assert.deepEqual((await asked()).slice(-2), [{ word: "wasn't", context: "It wasn't a well-known fix, so we tried again." }, { word: 'well-known', context: "It wasn't a well-known fix, so we tried again." }]);

    // Where a tap is not a lookup.
    const before = (await asked()).length;
    for (const [what, point] of [
      ['empty space after the text', { x: 380, y: (await wordPoint('#p1', 'The')).y }],
      ['a link', await wordPoint('#link', 'the link')],
      ['a button', await wordPoint('#btn', 'this button')],
      ['inline code', await wordPoint('#code', 'resolved')],
      ['a code block', await wordPoint('#pre', 'resolved')],
      ['a tool card', await wordPoint('#tool', 'resolved')],
      ['the input box', await tab.locator('#box').boundingBox().then(box => ({ x: box.x + 20, y: box.y + box.height / 2 }))],
      ['a number', await wordPoint('#p3', '42')],
      ['Chinese text', await wordPoint('#p3', '\u4e2d\u6587')],
    ]) {
      await tap(point);
      await tab.waitForTimeout(120);
      assert.equal(await popup.count(), 0, `${what}: no popup`);
    }
    assert.equal((await asked()).length, before, 'and nothing is asked for them');
    await tap(await wordPoint('#user', 'translate'));
    await tab.waitForFunction(() => document.querySelector('.wt-word')?.textContent === 'translate');
    await tap(await wordPoint('#p3', 'English'));
    await tab.waitForFunction(() => document.querySelector('.wt-word')?.textContent === 'English');
    assert.equal((await asked()).at(-1).context, '\u6570\u5b57 42 and \u4e2d\u6587 mixed with English words.', 'English among Chinese is looked up too');

    // Dismissing: Escape, and a tap beside the words.
    await tab.keyboard.press('Escape');
    assert.equal(await popup.count(), 0, 'Escape closes it');
    await tap(await wordPoint('#p1', 'conflict'));
    await popup.waitFor();
    await tap({ x: 380, y: 450 });
    await tab.waitForTimeout(100);
    assert.equal(await popup.count(), 0, 'a tap elsewhere closes it');

    // Selecting is not tapping: a drag, a long press and an existing selection do nothing.
    const sel = await wordPoint('#p1', 'conflict');
    const end = await wordPoint('#p1', 'merge');
    await tab.mouse.move(sel.x, sel.y); await tab.mouse.down(); await tab.mouse.move(end.x, end.y, { steps: 5 }); await tab.mouse.up();
    await tab.waitForTimeout(150);
    assert.equal(await popup.count(), 0, 'dragging over text selects it');
    await tab.evaluate(() => getSelection().removeAllRanges());
    await tab.mouse.move(sel.x, sel.y); await tab.mouse.down(); await tab.waitForTimeout(750); await tab.mouse.up();
    await tab.waitForTimeout(150);
    assert.equal(await popup.count(), 0, 'a long press is not a tap');
    await tab.evaluate(() => getSelection().removeAllRanges());

    // An answer that comes late does not replace the word that was tapped after it.
    delayMs = 500;
    await tap(await wordPoint('#p1', 'again'));
    await tab.waitForSelector('.wt-loading');
    delayMs = 0;
    await tap(await wordPoint('#p1', 'tried'));
    await tab.waitForFunction(() => document.querySelector('.wt-word')?.textContent === 'tried' && document.querySelector('.wt-meaning'));
    await tab.waitForTimeout(700);
    assert.equal(await tab.locator('.wt-word').textContent(), 'tried', 'the slow answer for "again" is dropped');

    // The popup follows the word while the chat scrolls, and goes when the word has scrolled out of view.
    const y0 = (await popup.boundingBox()).y;
    await tab.evaluate(() => { document.getElementById('scroller').scrollTop = 30; });
    await tab.waitForTimeout(100);
    assert.ok(Math.abs((await popup.boundingBox()).y - (y0 - 30)) < 3, 'it moves with the word');
    await tab.evaluate(() => { document.getElementById('scroller').scrollTop = 300; });
    await tab.waitForTimeout(100);
    assert.equal(await popup.count(), 0, 'and goes when the word is out of view');
    // Near the bottom of the window the popup opens above the word.
    await tab.evaluate(() => { document.getElementById('scroller').scrollTop = 1000; });
    const low = await wordPoint('#low', 'bottom');
    await tab.setViewportSize({ width: 400, height: Math.round(low.rect.bottom + 20) });
    await tab.waitForTimeout(100);
    await tap(await wordPoint('#low', 'bottom'));
    await tab.waitForSelector('.wt-meaning');
    assert.ok((await popup.boundingBox()).y + (await popup.boundingBox()).height <= (await wordPoint('#low', 'bottom')).rect.top + 1, 'above the word when there is no room below');

    // Errors are shown in the popup, and a failed word is asked again next time.
    await tab.setViewportSize({ width: 400, height: 500 });
    await tab.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
    respond = () => ({ status: 409, body: { error: 'Translation service not configured yet' } });
    await tap(await wordPoint('#p1', 'fix'));
    await tab.waitForSelector('.wt-error');
    assert.equal(await tab.locator('.wt-error').textContent(), 'Translation service not configured yet');
    respond = body => ({ status: 200, body: { word: body.word, base: body.word, phonetic: '', pos: '', meaning: '\u4fee\u590d' } });
    await tap(await wordPoint('#p1', 'tried'));
    await tab.waitForSelector('.wt-meaning');
    await tap(await wordPoint('#p1', 'fix'));
    await tab.waitForFunction(() => document.querySelector('.wt-meaning')?.textContent === '\u4fee\u590d');
    assert.equal(await tab.locator('.wt-phonetic').count(), 0, 'no empty phonetic is drawn');
    assert.equal(await tab.locator('.wt-base').count(), 0, 'and no base form when it is the word itself');

    // Off again: nothing, and the popup goes.
    await tab.evaluate(() => WordTranslate.setEnabled(false));
    assert.equal(await popup.count(), 0);
    assert.equal(await tab.evaluate(() => document.body.classList.contains('wt-on')), false);
    const total = (await asked()).length;
    await tap(await wordPoint('#p1', 'conflict'));
    await tab.waitForTimeout(150);
    assert.equal(await popup.count(), 0);
    assert.equal((await asked()).length, total);
    // On a phone it is a touch: a tap shows the meaning, a swipe (scrolling) does not.
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true })).newPage();
    phone.on('pageerror', error => errors.push(error.message));
    await phone.route('**/api/translate/word', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ word: 'x', base: 'x', phonetic: '', pos: '', meaning: '\u89e6\u6478' }) }));
    await phone.goto(origin);
    await phone.evaluate(() => WordTranslate.setEnabled(true));
    const where = await phone.evaluate(() => {
      const node = document.getElementById('p1').firstChild;
      const range = document.createRange();
      range.setStart(node, node.data.indexOf('conflict')); range.setEnd(node, node.data.indexOf('conflict') + 8);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await phone.touchscreen.tap(where.x, where.y);
    await phone.waitForSelector('.wt-meaning');
    assert.equal(await phone.locator('.wt-meaning').textContent(), '\u89e6\u6478');
    assert.equal(await phone.locator('.wt-word').textContent(), 'conflict');
    await phone.keyboard.press('Escape');
    assert.equal(await phone.locator('.wt-popup').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Tap to translate: off by default, a tap on an English word in a message shows its meaning beside it, and code, links, buttons, the input box, selections and long presses are left alone.');
  } finally { await browser.close(); server.closeAllConnections(); server.close(); }
})().catch(error => { console.error(error); process.exit(1); });
