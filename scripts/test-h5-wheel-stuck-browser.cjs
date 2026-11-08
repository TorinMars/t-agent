// The wheel strip (#h5-wheel, public/js/h5.js bindWheelStrip) never gets stuck, in Chromium at phone size with mocked sockets.
// A touch whose pointerup / pointercancel never comes (Android system gestures, a hidden page, a re-mounted strip, a second
// finger) used to leave the drag open for good: later drags were ignored and the track stayed visible. Each case starts a drag
// that does not end normally and checks that the track dims, that the spring stops and that a new drag scrolls again.
// The terminal runs a full-screen program, so the strip is the spring (data-mode 'spring'): a pull scrolls by time, so every
// drag is held for a moment before it is lifted.
// The touches are PointerEvents fired inside the page (CDP touches arrive one per frame, and headless Chromium draws slowly
// while the display sleeps); waits use the page's own timers.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const TERMINALS = [1, 2].map(i => ({ terminal_id: `t${i}`, title: `Term ${i}` }));
const pageErrors = [];

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/tasks/1/terminal/ack' && method === 'POST') return json({ success: true });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Alpha', status: 'doing' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/1/terminals') return json(TERMINALS);
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('.h5-task-item', { hasText: 'Alpha' }).tap();
  return { context, page };
}

async function pick(page, name) {
  if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
  const id = TERMINALS.find(row => row.title === name).terminal_id;
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: name });
  await row.waitFor();
  await row.evaluate(el => el.click());
  await page.waitForFunction(want => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === want, id);
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  // A full-screen program with mouse mode: every scroll step of the strip becomes a wheel report on this terminal's socket.
  await page.waitForFunction(want => window.sockets.some(socket => socket.readyState === 1 && new URL(socket.url).searchParams.get('terminalId') === want), id);
  await page.evaluate(want => {
    const socket = window.sockets.filter(item => new URL(item.url).searchParams.get('terminalId') === want).at(-1);
    socket.emit(JSON.stringify({ type: 'history', data: '\x1b[?1049h\x1b[?1000h\x1b[?1006hfull screen app', cols: 40, rows: 30 }));
  }, id);
  await page.waitForTimeout(150);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const failures = [];
  // Each case is checked on its own, so a run on the old code lists every stuck case instead of stopping at the first.
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
  };
  try {
    const { context, page } = await openPage(browser);
    await pick(page, 'Term 1');
    await page.evaluate(() => {
      // fire(type, pointerId, y, target): one touch pointer event at the strip's centre line.
      window.__fire = (type, id, y, target) => {
        const el = target || document.querySelector('#h5-wheel');
        const box = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: y }));
      };
      // A drag of 100 px down in four moves (no pointerdown, no pointerup).
      window.__moves = (id, from, target) => { for (let y = from + 25; y <= from + 100; y += 25) window.__fire('pointermove', id, y, target); };
      window.__codes = () => {
        const shown = document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId;
        const socket = window.sockets.filter(item => new URL(item.url).searchParams.get('terminalId') === shown).at(-1);
        return socket ? socket.sent.filter(item => /^\x1b\[<6[45];/.test(item)).map(item => item.slice(3, 5)) : [];
      };
      window.__wheels = () => window.__codes().length;
      window.__sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      window.__active = () => [...document.querySelectorAll('.h5-wheel.active')].length + (window.__oldStrip?.classList.contains('active') ? 1 : 0);
    });
    let nextId = 1;
    const wheels = () => page.evaluate(() => window.__wheels());
    const active = () => page.evaluate(() => window.__active());
    const hold = ms => page.evaluate(ms => window.__sleep(ms), ms);
    // The strip is dimmed and the spring no longer scrolls.
    const hidden = async (ms, what) => {
      try { await page.waitForFunction(() => window.__active() === 0 && !window.__h5WheelSpring(), null, { timeout: ms }); } catch { assert.fail(`the track still shows ${what}`); }
    };
    // A full, normal pull (100 px down, held 400 ms): it must scroll toward newer output (wheel-down reports), then the track must fade out.
    const goodDrag = async what => {
      const id = nextId++;
      const before = (await page.evaluate(() => window.__codes())).length;
      await page.evaluate(id => { window.__fire('pointerdown', id, 300); window.__moves(id, 300); }, id);
      // Held until it has scrolled (state, not a fixed delay: a loaded machine runs timers and frames late).
      await page.waitForFunction(before => window.__wheels() > before, before, { timeout: 8000 }).catch(() => {});
      await page.evaluate(id => window.__fire('pointerup', id, 400), id);
      const codes = (await page.evaluate(() => window.__codes())).slice(before);
      assert.ok(codes.length > 0, `a new drag scrolls ${what}`);
      assert.ok(codes.every(code => code === '65'), `pulling down scrolls down (newer) ${what}: ${codes.join(',')}`);
      await hidden(2500, `after a normal drag ${what}`);
      const after = await wheels();
      await hold(300);
      assert.equal(await wheels(), after, `the spring stops when it is released ${what}`);
    };
    // A drag that is started and never ends by itself.
    const openDrag = async () => { const id = nextId++; await page.evaluate(id => { window.__fire('pointerdown', id, 300); window.__moves(id, 300); }, id); return id; };
    // Puts the page in a clean state between cases: whatever the old code left open is closed with its own pointer id.
    const reset = async id => { await page.evaluate(id => window.__fire('pointercancel', id, 400), id); await page.waitForFunction(() => window.__active() === 0, null, { timeout: 3000 }).catch(() => {}); };

    await check('baseline: a normal drag scrolls and the track fades', () => goodDrag('at the start'));

    let id;
    id = await openDrag();
    await check('lost pointerup: a new touch takes over and scrolls', async () => {
      assert.equal(await active(), 1, 'the track shows during the open drag');
      await goodDrag('after a touch whose pointerup was lost');
    });
    await reset(id);

    id = await openDrag();
    await check('lost pointerup: the track hides by itself (stale check)', async () => {
      await hidden(4500, 'long after a touch whose pointerup was lost');
      const still = await wheels();
      await hold(500);
      assert.equal(await wheels(), still, 'the stale spring no longer scrolls');
      const before = await wheels();
      await page.evaluate(id => window.__moves(id, 400), id);
      await page.waitForFunction(before => window.__wheels() > before, before, { timeout: 8000 }).catch(() => assert.fail('the same finger can still scroll'));
      assert.equal(await active(), 1, 'its next move shows the track again');
      await page.evaluate(id => window.__fire('pointerup', id, 500), id);
      await hidden(2500, 'after that finger is lifted');
    });
    await reset(id);

    id = await openDrag();
    await check('page hidden mid-drag: the drag ends and the track hides', async () => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await hidden(2000, 'after the page was hidden');
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const before = await wheels();
      await page.evaluate(id => window.__moves(id, 400), id);
      await hold(400);
      assert.equal(await wheels(), before, 'the ended drag no longer scrolls');
      await goodDrag('after the page was shown again');
    });
    await reset(id);

    id = await openDrag();
    await check('lostpointercapture mid-drag: the drag ends and the track hides', async () => {
      await page.evaluate(id => window.__fire('lostpointercapture', id, 400), id);
      await hidden(2000, 'after the pointer capture was lost');
      const before = await wheels();
      await page.evaluate(id => window.__moves(id, 400), id);
      await hold(400);
      assert.equal(await wheels(), before, 'the ended drag no longer scrolls');
      await goodDrag('after lostpointercapture');
    });
    await reset(id);

    id = await openDrag();
    await check('window blur mid-drag: the drag ends and the track hides', async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await hidden(2000, 'after the window lost the focus');
      await goodDrag('after blur');
    });
    await reset(id);

    id = await openDrag();
    await check('pagehide mid-drag: the drag ends and the track hides', async () => {
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      await hidden(2000, 'after pagehide');
      await goodDrag('after pagehide');
    });
    await reset(id);

    id = await openDrag();
    await check('strip re-mounted mid-drag: the old element loses the track, the new one scrolls', async () => {
      await page.evaluate(() => { const old = document.querySelector('#h5-wheel'); window.__oldStrip = old; old.replaceWith(old.cloneNode(false)); });
      assert.equal(await page.evaluate(() => document.querySelector('#h5-wheel').classList.contains('active')), true, 'the copy carries the class (as a stale render would)');
      await page.evaluate(() => document.querySelector('#h5-wheel').classList.remove('active'));
      await hidden(2000, 'on the detached strip');
      const before = await wheels();
      await page.evaluate(id => window.__moves(id, 400, window.__oldStrip), id);
      await hold(400);
      assert.equal(await wheels(), before, 'moves of the drag on the detached strip do not scroll');
      await goodDrag('on the new strip');
    });
    await reset(id);
    await page.evaluate(() => { document.querySelector('#h5-wheel').replaceWith(window.__oldStrip); window.__oldStrip = null; });

    id = await openDrag();
    await check('second finger: it takes over; the first finger no longer scrolls', async () => {
      const second = nextId++;
      const before = await wheels();
      await page.evaluate(second => { window.__fire('pointerdown', second, 300); window.__moves(second, 300); }, second);
      await page.waitForFunction(before => window.__wheels() > before, before, { timeout: 8000 }).catch(() => assert.fail('the second finger scrolls'));
      await page.evaluate(second => window.__fire('pointermove', second, 300), second);
      await hold(100);
      const afterSecond = await wheels(); // the second finger rests in the middle now: no scrolling
      await page.evaluate(id => window.__moves(id, 400), id);
      await hold(400);
      assert.equal(await wheels(), afterSecond, 'the first finger no longer scrolls');
      await page.evaluate(({ id, second }) => { window.__fire('pointerup', second, 400); window.__fire('pointerup', id, 500); }, { id, second });
      await hidden(2500, 'after both fingers are lifted');
      await goodDrag('after two fingers');
    });
    await reset(id);

    id = await openDrag();
    await check('terminal switched mid-drag: the drag ends, the track hides, the new terminal scrolls', async () => {
      await pick(page, 'Term 2');
      await hidden(2500, 'after the terminal was switched');
      const before = await wheels();
      await page.evaluate(id => window.__moves(id, 400), id);
      await hold(400);
      assert.equal(await wheels(), before, 'the old drag does not scroll the new terminal');
      await goodDrag('on the switched terminal');
    });
    await reset(id);

    await check('a pull springs back when released and the spring stops', async () => {
      const offset = () => page.evaluate(() => document.querySelector('#h5-wheel').style.getPropertyValue('--h5-spring-offset'));
      const before = await wheels();
      await page.evaluate(() => { window.__fire('pointerdown', 999, 400); window.__fire('pointermove', 999, 340); });
      await page.waitForFunction(before => window.__wheels() > before, before, { timeout: 8000 }).catch(() => assert.fail('the spring scrolls while pulled'));
      assert.equal(await page.evaluate(() => window.__h5WheelSpring()), true, 'the spring runs while pulled');
      assert.equal(await offset(), '-60px', 'the thumb follows the pull');
      await page.evaluate(() => window.__fire('pointerup', 999, 340));
      assert.equal(await page.evaluate(() => window.__h5WheelSpring()), false, 'the spring stops on release');
      assert.equal(await offset(), '0px', 'the thumb springs back to the middle');
      await hidden(2500, 'after the pull ended');
    });

    await context.close();
    assert.deepEqual(pageErrors, [], 'no browser runtime errors');
    assert.deepEqual(failures, [], `wheel strip cases failed: ${failures.join('; ')}`);
    console.log('Phone wheel strip: lost pointerup, stale track, hidden page, lostpointercapture, blur, pagehide, re-mounted strip, second finger, switched terminal and spring release passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
