// Continue where you left off in real Chromium (public/js/continue-drafts.js, h5.js "The Continue hint" and "Drafts that follow their session";
// docs/design/continue-and-drafts.md). The page of T01 on a computer (1440x900) and the page of K01 on a phone (390x844, an iPhone) of the same
// person, with one shared page state behind them (the real merge rules, services/page-state-merge.js) pushed to every open page after each change,
// as the server does. Proven: the phone offers "Continue <session> · Last viewed on your computer" on entry, Open switches to it, the close button
// and the 10 s timeout dismiss it, and it is not offered for a session the phone noted itself; the text typed on the computer is in the phone's
// draft box within 3 s with the caption "Draft from your computer", a send clears both, a draft from the phone comes into the computer's idle box,
// the phone's own text is never overwritten (the other draft is offered) and a focused box never changes. Screenshots (390px) of the hint and the
// caption go to SHOTS_DIR when it is set.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const merge = require('../services/page-state-merge');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const T = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const SHOTS = process.env.SHOTS_DIR || '';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const T_TASKS = [{ id: 1, title: 'SELF-TAGENT', status: 'doing' }, { id: 2, title: 'Write docs', status: 'doing' }];
const T_TERMINALS = { 1: [{ terminal_id: 'c1', title: 'SELF AGENT DEV', agent: 'claude' }], 2: [{ terminal_id: 'd1', title: 'Docs shell' }] };
const K_TASKS = [{ id: 5, title: 'Notes', status: 'doing' }];
const K_TERMINALS = { 5: [{ terminal_id: 'k1', title: 'Notes shell' }] };
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }];

let shared = { recent: {}, keys: {} };
let version = 1;
let puts = 0;
const answer = instance => ({ instance_id: instance, version, ...merge.pageView(shared), peers: [] });
const pages = [];
const STREAM = '/api/tasks/terminal-activity/stream';
function pushAll() {
  setTimeout(() => {
    for (const { page, own } of pages) page.evaluate(([url, text]) => window.activityStream.send(url, 'page-state', text), [STREAM, JSON.stringify(answer(own))]).catch(() => {});
  }, 50);
}

async function openPage(browser, { origin, own, other, otherId, otherName, viewport, phone }) {
  const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, userAgent: IPHONE, deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(activityStreamMock);
  await page.addInitScript(() => {
    window.sent = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'history', data: '$ ', cols: 60, rows: 20 }) }); }, 0); }
      send(data) { window.sent.push(String(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  const mine = own === T ? { tasks: T_TASKS, terminals: T_TERMINALS } : { tasks: K_TASKS, terminals: K_TERMINALS };
  const theirs = own === T ? { tasks: K_TASKS, terminals: K_TERMINALS } : { tasks: T_TASKS, terminals: T_TERMINALS };
  await page.route(`${origin}/**`, route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/page-state' && method === 'GET') return json(answer(own));
    if (p === '/api/page-state' && method === 'PUT') {
      const body = JSON.parse(route.request().postData() || '{}');
      puts += 1;
      shared = merge.merge(shared, merge.changeState(body, { at: Date.now() + puts, by: own }), Date.now()).state;
      version += 1;
      pushAll();
      return json(answer(own));
    }
    if (p === '/api/system/version') return json({ engine_name: own === T ? 'T01' : 'K01', instance_id: own });
    if (p === '/api/remote-servers') return json([{ id: otherId, name: otherName, status: 'online', base_url: 'http://10.0.0.7:14002', enabled: true, instance_id: other }]);
    if (p === '/api/tasks' && method === 'GET') return json(mine.tasks);
    if (p === `/api/remote-servers/${otherId}/tasks` && method === 'GET') return json(theirs.tasks);
    if (p === '/api/task-groups' || p === `/api/remote-servers/${otherId}/task-groups`) return json(GROUPS);
    if (/terminal-activity$/.test(p) || /terminal-subagents$/.test(p)) return json({});
    if (/\/terminal\/ack$/.test(p)) return json({ success: true });
    const local = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (local && method === 'GET') return json(mine.terminals[local[1]] || []);
    const remote = p.match(new RegExp(`^/api/remote-servers/${otherId}/tasks/(\\d+)/terminals$`));
    if (remote && method === 'GET') return json(theirs.terminals[remote[1]] || []);
    if (p === `/api/remote-servers/${otherId}/info`) return json({ capabilities: [] });
    if (/\/agent\/conversations$/.test(p)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${origin}/h5`);
  await page.waitForFunction(() => (window.H5UI.get().taskList.tasks || []).length === 3, null, { timeout: 15000 });
  const entry = { context, page, errors, own };
  pages.push(entry);
  return entry;
}
const openPhone = browser => openPage(browser, { origin: 'http://k01.test', own: K, other: T, otherId: 3, otherName: 'T01', viewport: { width: 390, height: 844 }, phone: true });
async function close(entry) {
  assert.deepEqual(entry.errors, [], 'no page errors');
  pages.splice(pages.indexOf(entry), 1);
  await entry.context.close();
}
const shownIs = (page, terminal) => page.waitForFunction(id => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === id, terminal, { timeout: 10000 });
async function visit(page, ref, terminal) {
  await page.evaluate(([r, id]) => window.H5UI.actions.openRow(r, { kind: 'terminal', id }), [ref, terminal]);
  await shownIs(page, terminal);
}
const boxText = page => page.evaluate(() => document.getElementById('h5-translate-input').value);
const noteText = page => page.evaluate(() => document.getElementById('h5-draft-note')?.textContent || '');
const hint = page => page.locator('.h5-notice-action');
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) });
}
// Types into the draft box as a person does (focus, text, blur), on a phone by a tap.
async function typeInBox(page, text, { blur = true } = {}) {
  await page.evaluate(() => document.getElementById('h5-translate-input').focus());
  await page.locator('#h5-translate-input').fill(text);
  if (blur) await page.evaluate(() => document.getElementById('h5-translate-input').blur());
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── The computer of T01 looks at SELF AGENT DEV ──
    const pc = await openPage(browser, { origin: 'http://t01.test', own: T, other: K, otherId: 7, otherName: 'K01', viewport: { width: 1440, height: 900 } });
    await visit(pc.page, 'local|2', 'd1');
    await visit(pc.page, 'local|1', 'c1');
    await pc.page.waitForFunction(() => window.TAPageState.recent()[0]?.terminal === 'c1' && window.TAPageState.recent()[0]?.client === 'computer', null, { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(merge.pageView(shared).recent[0].client, 'computer', 'the entry says where it was seen');
    assert.match(merge.pageView(shared).recent[0].device, /^[a-z0-9]{8,32}$/);

    // ── The phone of K01 opens: it offers to continue there, and Open switches ──
    const phone = await openPhone(browser);
    await hint(phone.page).waitFor({ timeout: 8000 });
    const hintText = await hint(phone.page).innerText();
    assert.match(hintText, /Continue SELF AGENT DEV/);
    assert.match(hintText, /Last viewed on your computer · just now/);
    assert.equal(await phone.page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId || null) === 'c1', false, 'it never switches by itself');
    await phone.page.waitForTimeout(500); // the snackbar's enter transition
    await shot(phone.page, 'continue-hint-390.png');
    await hint(phone.page).locator('.h5-notice-action-button').tap();
    await shownIs(phone.page, 'c1');
    assert.equal(await phone.page.evaluate(() => window.H5UI.get().shownTarget.sourceKey), 'remote:3');
    await hint(phone.page).waitFor({ state: 'detached', timeout: 3000 });
    await phone.page.waitForFunction(() => window.TAPageState.recent()[0]?.client === 'phone', null, { timeout: 5000 });

    // ── Drafts: typed on the computer, in the phone's box within 3 s with its caption ──
    let since = Date.now();
    await typeInBox(pc.page, 'Turn the sync delay into a push, then', { blur: false });
    await phone.page.waitForFunction(() => document.getElementById('h5-translate-input').value === 'Turn the sync delay into a push, then', null, { timeout: 3000 });
    console.log(`  a draft typed on the computer -> the phone's box: ${Date.now() - since} ms`);
    assert.match(await noteText(phone.page), /^Draft from your computer · just now$/);
    await pc.page.evaluate(() => document.getElementById('h5-translate-input').blur());
    // The phone opens its draft box (the Draft keyboard key): the text and its caption; focusing changes nothing.
    await phone.page.evaluate(() => document.getElementById('h5-translate-input').focus());
    await phone.page.waitForTimeout(400);
    assert.equal(await boxText(phone.page), 'Turn the sync delay into a push, then');
    await shot(phone.page, 'continue-draft-caption-390.png');
    await phone.page.evaluate(() => document.getElementById('h5-translate-input').blur());

    // ── A send on the computer clears both boxes ──
    await pc.page.evaluate(() => document.getElementById('h5-translate-input').focus());
    await pc.page.keyboard.press('Alt+Enter');
    await pc.page.waitForFunction(() => document.getElementById('h5-translate-input').value === '', null, { timeout: 3000 });
    assert.ok(await pc.page.evaluate(() => window.sent.some(data => data.includes('Turn the sync delay'))), 'the computer sent it to the terminal');
    await phone.page.waitForFunction(() => document.getElementById('h5-translate-input').value === '', null, { timeout: 3000 });
    assert.equal(await noteText(phone.page), '', 'the caption went');
    await pc.page.evaluate(() => document.getElementById('h5-translate-input').blur());

    // ── A draft from the phone comes into the computer's idle box, with its caption ──
    since = Date.now();
    await typeInBox(phone.page, 'Check the phone layout');
    await pc.page.waitForFunction(() => document.getElementById('h5-translate-input').value === 'Check the phone layout', null, { timeout: 3000 });
    console.log(`  a draft typed on the phone -> the computer's box: ${Date.now() - since} ms`);
    assert.match(await noteText(pc.page), /^Draft from your phone · just now$/);
    if (SHOTS) await pc.page.screenshot({ path: path.join(SHOTS, 'continue-draft-caption-computer.png'), clip: { x: 0, y: 700, width: 1440, height: 200 } });
    // Editing it takes the caption away.
    await typeInBox(pc.page, 'Check the phone layout at 390px');
    assert.equal(await noteText(pc.page), '', 'edited: the caption goes');

    // ── The phone's own text is never overwritten: the computer's newer draft is offered ──
    await typeInBox(phone.page, 'My own words on the phone');
    await pc.page.waitForTimeout(300);
    await typeInBox(pc.page, 'Newer words on the computer');
    await phone.page.waitForFunction(() => document.getElementById('h5-draft-note')?.textContent === 'Use the draft from your computer', null, { timeout: 3000 });
    assert.equal(await boxText(phone.page), 'My own words on the phone', 'own text kept');
    await phone.page.evaluate(() => document.getElementById('h5-translate-input').focus());
    await phone.page.waitForTimeout(300);
    await shot(phone.page, 'continue-draft-offer-390.png');
    await phone.page.locator('#h5-draft-use').tap();
    assert.equal(await boxText(phone.page), 'Newer words on the computer', 'Use the draft');
    await phone.page.evaluate(() => document.getElementById('h5-translate-input').blur());

    // ── A focused box never changes; after the blur the newer draft is offered (it has its own text) ──
    await pc.page.evaluate(() => document.getElementById('h5-translate-input').focus());
    await typeInBox(phone.page, 'Typed while the computer has the focus');
    await pc.page.waitForTimeout(2500);
    assert.equal(await boxText(pc.page), 'Newer words on the computer', 'focused: unchanged');
    await pc.page.evaluate(() => document.getElementById('h5-translate-input').blur());
    await pc.page.waitForFunction(() => document.getElementById('h5-draft-note')?.textContent === 'Use the draft from your phone', null, { timeout: 3000 });
    assert.equal(await boxText(pc.page), 'Newer words on the computer');
    // Emptied on the phone: cleared everywhere (the computer keeps its own text).
    await typeInBox(phone.page, '');
    await pc.page.waitForFunction(() => !document.getElementById('h5-draft-note'), null, { timeout: 3000 });
    const key = Object.keys(merge.pageView(shared).keys).find(name => name.startsWith('ta-draft:'));
    assert.equal(merge.pageView(shared).keys[key], null, 'the draft is cleared in the shared state');
    assert.equal(await boxText(pc.page), 'Newer words on the computer', 'the computer\'s own text stays');
    await close(phone);

    // ── Another phone: the computer looked at Docs shell last; close and the 10 s timeout dismiss the hint ──
    await visit(pc.page, 'local|2', 'd1');
    await new Promise(resolve => setTimeout(resolve, 1200));
    const second = await openPhone(browser);
    await hint(second.page).waitFor({ timeout: 8000 });
    assert.match(await hint(second.page).innerText(), /Continue Docs shell/);
    await hint(second.page).locator('.h5-notice-close').tap();
    await hint(second.page).waitFor({ state: 'detached', timeout: 3000 });
    assert.notEqual(await second.page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId || null), 'd1', 'closed: no switch');
    await close(second);
    const third = await openPhone(browser);
    await hint(third.page).waitFor({ timeout: 8000 });
    since = Date.now();
    await hint(third.page).waitFor({ state: 'detached', timeout: 12000 });
    const gone = Date.now() - since;
    assert.ok(gone > 8000, `it stays about 10 s (${gone} ms)`);
    // The phone itself opens the session the computer looked at last (its own last session here, K01's Notes shell): no hint.
    await visit(third.page, 'local|5', 'k1');
    await visit(pc.page, 'remote:7|5', 'k1');
    await new Promise(resolve => setTimeout(resolve, 1200));
    await third.page.reload();
    await third.page.waitForFunction(() => (window.H5UI.get().taskList.tasks || []).length === 3, null, { timeout: 15000 });
    await shownIs(third.page, 'k1');
    await third.page.waitForTimeout(5000);
    assert.equal(await hint(third.page).count(), 0, 'the session this device opens anyway: no hint');
    await close(third);

    for (const frame of pc.page.frames()) assert.deepEqual(await frame.evaluate(() => (window.TALocalKeys ? window.TALocalKeys.refused() : [])), [], 'no undeclared key');
    await close(pc);
    console.log('Continue and drafts: the hint on entry (Open, close, 10 s, not for its own session), a draft follows its session between a computer and a phone within 3 s with its caption, a send and an empty box clear it everywhere, own text is offered the other draft instead of being overwritten, a focused box never changes: passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
