// Settings "Linked services" (scripts/h5-shell/ServiceLinks.jsx) and the linked rows of Engines (Engines.jsx) in real Chromium at 390px (touch), 320px (touch) and
// 1440px (mouse), against a mocked /api/service-links: the code dialog and its countdown, the localhost warning, the success state, the join form and its
// confirmation, every error text, the list states, unlink, the Engines row, the back gesture, and an older server (404) showing nothing.
// H5_SHOT_DIR=<dir> saves screenshots at 390px there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR;
const LONG_NAME = '\u4e00\u4e2a\u540d\u5b57\u975e\u5e38\u975e\u5e38\u957f\u7684\u5173\u8054\u670d\u52a1\u7528\u6765\u6d4b\u8bd5\u7a84\u5c4f\u5e55\u4e0a\u7684\u6362\u884c\u6548\u679c\u662f\u5426\u6b63\u5e38';
const pageErrors = [];

const link = (id, name, fields = {}) => ({ id, name, role: 'initiator', peer_url: null, online: true, state: 'online', remote_server_id: null, created_at: '2026-11-10T00:00:00Z', last_seen_at: null, ...fields });
const server = (id, name, fields = {}) => ({ id, name, base_url: `http://tunnel-${id}.invalid`, status: 'online', remote_version: '2.95.1', last_checked_at: null, last_error: null, ...fields });

async function openPage(browser, { width = 390, wide = false, origin = ORIGIN, model }) {
  const context = await browser.newContext({ viewport: wide ? { width: 1440, height: 900 } : { width, height: 844 }, ...(wide ? {} : { isMobile: true, hasTouch: true }), ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied.push(text); } }, configurable: true });
  });
  await page.route(`${origin}/**`, async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/api/remote-servers') return json(model.servers);
    if (pathname === '/api/system/version') return json({ app_version: '2.95.1' });
    if (pathname === '/api/tasks') return json([{ id: 1, title: 'Alpha', status: 'doing' }]);
    if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json({});
    if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json([]);
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname.startsWith('/api/service-links')) {
      model.calls.push({ method, pathname, body: request.postData() ? JSON.parse(request.postData()) : undefined });
      if (model.unsupported) return json({ error: 'Not found' }, 404);
      if (pathname === '/api/service-links' && method === 'GET') return json({ links: model.links, supported: true });
      if (pathname === '/api/service-links/code') return json({ code: '123456', expires_in_seconds: model.expires }, 201);
      if (pathname === '/api/service-links/join') {
        if (model.joinError) return json({ error: model.joinError }, 400);
        const made = link('new-join', 'Joined box', { role: 'joiner', peer_url: 'http://10.0.0.9:4000', remote_server_id: 42 });
        model.links.push(made);
        model.servers.push(server(42, 'Joined box'));
        return json(made, 201);
      }
      const one = pathname.match(/^\/api\/service-links\/([^/]+)$/);
      if (one && method === 'DELETE') {
        const gone = model.links.find(item => item.id === one[1]);
        model.links = model.links.filter(item => item !== gone);
        model.servers = model.servers.filter(item => item.id !== gone.remote_server_id);
        return route.fulfill({ status: 204 });
      }
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${origin}/h5`);
  await page.waitForFunction(() => window.H5UI && window.H5UI.actions.enginesChanged && window.H5UI.get().sources.length > 0); // the engine selector has been read
  return { context, page };
}

const newModel = (fields = {}) => ({ links: [], servers: [], calls: [], expires: 600, unsupported: false, joinError: null, ...fields });

function helpers(page, wide) {
  const press = locator => (wide ? locator.click() : locator.tap());
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  const openSettings = async () => { await page.evaluate(() => window.H5UI.set({ settingsOpen: true })); await page.locator('#h5-settings').waitFor({ state: 'visible' }); await settled(); };
  const openGroup = async id => {
    const summary = page.locator(`#h5-set-${id} .MuiAccordionSummary-root`);
    await summary.scrollIntoViewIfNeeded();
    await press(summary);
    await page.waitForFunction(groupId => Boolean(document.querySelector(`#h5-set-${groupId} .MuiCollapse-entered`)), id);
  };
  // Press a control inside the moving sheet: wait until it has stopped first, so a tap cannot land beside it.
  const tap = async selector => { const target = page.locator(selector); await target.scrollIntoViewIfNeeded(); await settled(); await press(target); };
  const shot = async name => { if (SHOTS) { await settled(); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
  return { press, tap, settled, openSettings, openGroup, shot };
}

// Nothing sticks out of the screen, and every button is a real target on a touch screen.
async function assertFits(page, label, touch) {
  const result = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.MuiDialog-root')].at(-1);
    const scope = dialog || document.querySelector('#h5-settings');
    const inner = document.documentElement.clientWidth;
    const outside = [...scope.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > inner + 0.5 || r.left < -0.5); }).map(el => el.id || el.className || el.tagName);
    const small = [...scope.querySelectorAll('button')].filter(el => el.getBoundingClientRect().width > 0).map(el => { const r = el.getBoundingClientRect(); return { id: el.id || el.className, width: r.width, height: r.height }; }).filter(item => item.height < 44 || item.width < 44);
    return { outside, small };
  });
  assert.deepEqual(result.outside, [], `${label}: nothing is wider than the screen`);
  if (touch) assert.deepEqual(result.small, [], `${label}: every button is at least 44px`);
}

async function testOldServer(browser) {
  const model = newModel({ unsupported: true });
  const { context, page } = await openPage(browser, { model });
  const { openSettings, openGroup } = helpers(page, false);
  await openSettings();
  await page.waitForFunction(() => document.querySelector('#h5-set-engines'));
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/api/service-links') && entry.responseEnd > 0));
  assert.equal(await page.locator('#h5-set-service-links').count(), 0, 'an older server shows no Linked services group');
  model.servers.push(server(7, 'Plain'));
  await openGroup('engines');
  await page.locator('.h5-engine-row[data-engine="7"]').waitFor();
  assert.equal(await page.locator('.h5-engine-row[data-engine="7"] .h5-engine-edit').count(), 1, 'a normal Engine keeps Edit connection');
  assert.equal(await page.locator('.h5-engine-linked').count(), 0);
  await context.close();
}

async function testCode(browser) {
  const model = newModel({ links: [link('old', 'Existing')] });
  const { context, page } = await openPage(browser, { model });
  const { tap, openSettings, openGroup, shot, settled } = helpers(page, false);
  await openSettings();
  await openGroup('service-links');
  await page.locator('.h5-link-row[data-link="old"]').waitFor();
  await shot('group');
  await tap('#h5-link-generate');
  await page.locator('#h5-link-code').waitFor();
  assert.equal(await page.locator('#h5-link-code').innerText(), '123 456', 'the six digits are grouped for reading');
  assert.equal(await page.locator('#h5-link-address').innerText(), ORIGIN);
  assert.equal(await page.locator('#h5-link-address-warning').count(), 0, 'a real address has no warning');
  assert.match(await page.locator('#h5-link-code-dialog').innerText(), /On the other service, open Settings → Linked services and enter this address and code\./);
  await tap('#h5-link-copy');
  await page.waitForFunction(() => window.copied.length === 1);
  assert.deepEqual(await page.evaluate(() => window.copied), ['123456'], 'the copied text has no space');
  assert.equal((await page.locator('#h5-link-copy').innerText()).toLowerCase(), 'copied');
  // The countdown is live: it moves on by itself.
  const first = await page.locator('#h5-link-countdown').innerText();
  assert.match(first, /^Valid for (10:00|9:5\d)$/);
  await page.waitForFunction(text => document.querySelector('#h5-link-countdown').textContent !== text, first);
  // The list is read before the code is made, and only while the dialog is open.
  const posted = model.calls.findIndex(call => call.pathname === '/api/service-links/code');
  assert.ok(model.calls.slice(0, posted).some(call => call.method === 'GET'), 'the list is read first');
  await shot('code');
  await assertFits(page, 'code dialog 390', true);
  // The other service uses the code: an old link does not count, a new one does.
  const reads = () => model.calls.filter(call => call.method === 'GET').length;
  const before = reads();
  await page.waitForTimeout(3300);
  assert.ok(reads() > before, 'the list is polled while the dialog is open');
  assert.equal(await page.locator('#h5-link-code-done').count(), 0, 'a link that existed before is not a success');
  model.links.push(link('fresh', LONG_NAME, { remote_server_id: 9 }));
  model.servers.push(server(9, LONG_NAME));
  await page.locator('#h5-link-code-done').waitFor({ timeout: 6000 });
  assert.match(await page.locator('#h5-link-code-done').innerText(), new RegExp(`Linked: ${LONG_NAME}`));
  assert.equal(await page.locator('#h5-link-code').count(), 0, 'the code is gone after the success');
  await shot('code-success');
  await page.waitForFunction(() => window.H5UI.get().sources.some(item => item.key === 'remote:9'));
  await page.locator('.h5-link-row[data-link="fresh"]').waitFor();
  await tap('#h5-link-code-close');
  await page.locator('#h5-link-code-dialog').waitFor({ state: 'detached' });
  await settled();
  // Closed: no more reads.
  const closed = reads();
  await page.waitForTimeout(3500);
  assert.equal(reads(), closed, 'nothing is polled after the dialog closed');
  // The code runs out: copy is off and a new code can be made.
  model.expires = 2;
  await tap('#h5-link-generate');
  await page.locator('#h5-link-code').waitFor();
  await page.waitForFunction(() => /The code expired/.test(document.querySelector('#h5-link-countdown').textContent), null, { timeout: 5000 });
  assert.equal(await page.locator('#h5-link-copy').isDisabled(), true, 'an expired code cannot be copied');
  model.expires = 600;
  const codes = model.calls.filter(call => call.pathname === '/api/service-links/code').length;
  await tap('#h5-link-code-new');
  await page.waitForFunction(() => /Valid for/.test(document.querySelector('#h5-link-countdown')?.textContent || ''));
  assert.equal(model.calls.filter(call => call.pathname === '/api/service-links/code').length, codes + 1, 'New code asks for one more code');
  // The back gesture closes the dialog and leaves the sheet open.
  await settled();
  await page.goBack();
  await page.locator('#h5-link-code-dialog').waitFor({ state: 'detached', timeout: 3000 });
  assert.equal(await page.locator('#h5-settings').isVisible(), true, 'back closes only the dialog');
  await context.close();
}

async function testLocalhostWarning(browser) {
  for (const origin of ['http://localhost:4599', 'http://127.0.0.1:4599']) {
    const model = newModel();
    const { context, page } = await openPage(browser, { model, origin });
    const { tap, openSettings, openGroup, shot } = helpers(page, false);
    await openSettings();
    await openGroup('service-links');
    await tap('#h5-link-generate');
    await page.locator('#h5-link-address-warning').waitFor();
    assert.equal(await page.locator('#h5-link-address').innerText(), origin);
    assert.match(await page.locator('#h5-link-address-warning').innerText(), /will not be able to reach this address.*an address it can reach/);
    const colours = await page.evaluate(() => [getComputedStyle(document.querySelector('#h5-link-address-warning')).color, getComputedStyle(document.querySelector('#h5-link-address')).color]);
    assert.notEqual(colours[0], colours[1], `the warning stands out from the text around it: ${colours}`);
    if (origin.includes('localhost')) await shot('code-localhost');
    await context.close();
  }
}

const ERRORS = [
  ['CONFIRM_REQUIRED', /Accept the warning/],
  ['INVALID_CODE', /wrong or has expired\. Generate a new code on the other service/],
  ['SELF_LINK', /address of this service/],
  ['ALREADY_LINKED', /already linked/],
  ['LINK_UNSUPPORTED', /does not support linking/],
  ['LINK_UNREACHABLE', /This service itself must be able to reach the address you entered/],
  ['SOME_NEW_CODE', /Failed: SOME_NEW_CODE/],
];

async function testJoin(browser) {
  const model = newModel();
  const { context, page } = await openPage(browser, { model });
  const { press, tap, openSettings, openGroup, shot, settled } = helpers(page, false);
  await openSettings();
  await openGroup('service-links');
  await page.locator('#h5-link-empty').waitFor();
  await tap('#h5-link-join');
  await page.locator('#h5-link-url').waitFor();
  await settled();
  const code = page.locator('#h5-link-code-input');
  const send = page.locator('#h5-link-join-send');
  assert.deepEqual(await code.evaluate(el => [el.inputMode, el.autocomplete, el.maxLength, el.type]), ['numeric', 'one-time-code', 6, 'text']);
  assert.equal(await send.isDisabled(), true, 'nothing to send yet');
  await page.locator('#h5-link-url').fill('http://10.0.0.9');
  await page.locator('#h5-link-port').fill('4000');
  await code.fill('12345');
  assert.equal(await send.isDisabled(), true, 'five digits are not enough');
  await code.fill('12345a');
  assert.equal(await send.isDisabled(), true, 'a letter is not a digit');
  // A pasted code keeps none of its spaces, although the field is limited to 6 characters.
  const paste = text => code.evaluate((el, value) => {
    el.focus();
    el.select();
    const data = new DataTransfer();
    data.setData('text', value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await paste(' 123 456 ');
  await page.waitForFunction(() => document.querySelector('#h5-link-code-input').value === '123456');
  assert.equal(await send.isDisabled(), false, 'six digits can be sent');
  await shot('join');
  await assertFits(page, 'join form 390', true);
  // Pressing Link only asks: nothing is sent before the warning is accepted.
  await press(send);
  await page.locator('#h5-link-confirm-accept').waitFor();
  await settled();
  assert.equal(model.calls.filter(call => call.pathname.endsWith('/join')).length, 0, 'nothing is sent before the confirmation');
  const warning = await page.locator('#h5-link-confirm').innerText();
  for (const line of ['Linking gives both services full control of each other, including terminals on both machines.', 'This also applies if this service only allows local access.', 'Only link services you own.']) assert.ok(warning.includes(line), `the confirmation says: ${line}`);
  await shot('join-confirm');
  await assertFits(page, 'confirmation 390', true);
  await page.locator('#h5-link-confirm-cancel').tap();
  await page.locator('#h5-link-confirm').waitFor({ state: 'detached' });
  await settled();
  assert.equal(model.calls.filter(call => call.pathname.endsWith('/join')).length, 0, 'Cancel sends nothing');
  assert.equal(await code.inputValue(), '123456', 'Cancel keeps the form');
  // The back gesture closes the confirmation first, then the form.
  await press(send);
  await page.locator('#h5-link-confirm-accept').waitFor();
  await settled();
  await page.goBack();
  await page.locator('#h5-link-confirm').waitFor({ state: 'detached', timeout: 3000 });
  assert.equal(await page.locator('#h5-link-join-dialog').isVisible(), true, 'back closes the confirmation, the form stays');
  await settled();
  // Every error has its own text.
  for (const [error, expected] of ERRORS) {
    model.joinError = error;
    if (!(await code.inputValue())) await code.fill('123456');
    await press(send);
    await page.locator('#h5-link-confirm-accept').waitFor();
    await settled();
    await page.locator('#h5-link-confirm-accept').tap();
    await page.locator('#h5-link-confirm').waitFor({ state: 'detached' });
    await page.waitForFunction(text => new RegExp(text).test(document.querySelector('#h5-link-join-result').textContent), expected.source);
    await settled();
    if (error === 'LINK_UNREACHABLE') { await shot('join-error'); }
    if (error === 'INVALID_CODE') {
      assert.doesNotMatch(await page.locator('#h5-link-join-result').innerText(), /try again|retry/i);
      assert.equal(await code.inputValue(), '', 'a wrong code is cleared: it cannot work again');
      assert.equal(await send.isDisabled(), true);
    }
  }
  const sent = model.calls.find(call => call.pathname.endsWith('/join'));
  assert.deepEqual(sent.body, { url: 'http://10.0.0.9', port: '4000', code: '123456', confirm: true });
  // Success: the dialog closes, the list and the engine selector follow.
  model.joinError = null;
  await page.locator('#h5-link-port').fill('');
  await page.waitForFunction(() => document.querySelector('#h5-link-port').value === '');
  await press(send);
  await page.locator('#h5-link-confirm-accept').waitFor();
  await settled();
  await page.locator('#h5-link-confirm-accept').tap();
  await page.locator('#h5-link-join-dialog').waitFor({ state: 'detached' });
  await page.locator('.h5-link-row[data-link="new-join"]').waitFor();
  assert.match(await page.locator('#h5-link-feedback').innerText(), /Linked: Joined box/);
  assert.match(await page.locator('.h5-link-row[data-link="new-join"] .h5-link-direction').innerText(), /Joined using a code/);
  await page.waitForFunction(() => window.H5UI.get().sources.some(item => item.key === 'remote:42'));
  assert.deepEqual(model.calls.filter(call => call.pathname.endsWith('/join')).at(-1).body, { url: 'http://10.0.0.9', code: '123456', confirm: true }, 'without a port, no port is sent');
  await context.close();
}

// Every dialog fits at the narrowest phone and on a wide screen, where the join form is a normal dialog.
async function testDialogSizes(browser, options, label) {
  const model = newModel();
  const { context, page } = await openPage(browser, { ...options, model, origin: 'http://localhost:4599' });
  const { press, tap, openSettings, openGroup, settled } = helpers(page, Boolean(options.wide));
  await openSettings();
  await openGroup('service-links');
  await tap('#h5-link-generate');
  await page.locator('#h5-link-address-warning').waitFor();
  await settled();
  await assertFits(page, `code dialog ${label}`, !options.wide);
  await press(page.locator('#h5-link-code-close'));
  await page.locator('#h5-link-code-dialog').waitFor({ state: 'detached' });
  await tap('#h5-link-join');
  await page.locator('#h5-link-url').fill('http://10.0.0.9');
  await page.locator('#h5-link-code-input').fill('123456');
  await settled();
  await assertFits(page, `join form ${label}`, !options.wide);
  const box = await page.locator('#h5-link-join-dialog .MuiDialog-paper').boundingBox();
  if (options.wide) assert.ok(box.width < 1000, `${label}: the form is a normal dialog on a wide screen (${box.width})`);
  else assert.equal(Math.round(box.width), options.width, `${label}: the form fills a phone`);
  await press(page.locator('#h5-link-join-send'));
  await page.locator('#h5-link-confirm-accept').waitFor();
  await settled();
  await assertFits(page, `confirmation ${label}`, !options.wide);
  await context.close();
}

async function testListAndEngines(browser, { width = 390, wide = false, shots = false } = {}) {
  const model = newModel({
    links: [
      link('on', LONG_NAME, { remote_server_id: 5 }),
      link('off', 'Offline box', { role: 'joiner', online: false, state: 'offline', peer_url: 'http://10.0.0.8', remote_server_id: 6 }),
      link('gone', 'Ended box', { online: false, state: 'revoked', remote_server_id: 8 }),
    ],
    servers: [server(5, LONG_NAME), server(6, 'Offline box', { status: 'offline', base_url: 'http://should-not-show.invalid' }), server(7, 'Plain engine'), server(8, 'Ended box', { status: 'offline' })],
  });
  const { context, page } = await openPage(browser, { model, width, wide });
  const { press, tap, openSettings, openGroup, shot, settled } = helpers(page, wide);
  const label = `${wide ? 'wide' : width}`;
  await openSettings();
  await openGroup('service-links');
  await page.locator('.h5-link-row[data-link="gone"]').waitFor();
  const row = id => page.locator(`.h5-link-row[data-link="${id}"]`);
  assert.deepEqual(await page.locator('.h5-link-status').allInnerTexts(), ['Online', 'Offline', 'Revoked'], label);
  assert.match(await row('on').locator('.h5-link-direction').innerText(), /This service generated the code/);
  assert.match(await row('off').locator('.h5-link-direction').innerText(), /Joined using a code.*10\.0\.0\.8/);
  assert.match(await row('gone').locator('.h5-link-revoked').innerText(), /other service ended this link/);
  assert.equal(await row('gone').locator('.h5-link-unlink').innerText().then(text => text.toLowerCase()), 'remove', 'a revoked row offers Remove');
  assert.equal(await row('on').locator('.h5-link-unlink').innerText().then(text => text.toLowerCase()), 'unlink');
  await assertFits(page, `list ${label}`, !wide);
  // The Engines list: linked rows have no edit, and their Remove leads to the Unlink confirmation.
  await openGroup('engines');
  const engine = id => page.locator(`.h5-engine-row[data-engine="${id}"]`);
  await engine(5).locator('.h5-engine-linked').waitFor();
  assert.equal(await engine(5).locator('.h5-engine-linked').innerText(), 'Linked');
  assert.equal(await engine(5).locator('.h5-engine-edit').count(), 0, 'a linked row cannot be edited');
  assert.equal(await engine(7).locator('.h5-engine-edit').count(), 1, 'a normal row can');
  assert.equal(await engine(7).locator('.h5-engine-linked').count(), 0);
  assert.doesNotMatch(await engine(6).locator('.h5-engine-meta').innerText(), /should-not-show/, 'the address of a linked row is the link\'s');
  await settled();
  if (shots) await shot('engines');
  await assertFits(page, `engines ${label}`, !wide);
  // An offline tunnel Engine is in the selector, like any Engine.
  assert.ok((await page.evaluate(() => window.H5UI.get().sources.map(item => item.key))).includes('remote:6'), 'the offline linked Engine is in the selector');
  // Unlink from the Engines list.
  await tap('.h5-engine-row[data-engine="5"] .h5-engine-remove');
  await page.locator('#h5-link-unlink-accept').waitFor();
  await settled();
  const text = await page.locator('#h5-link-unlink').innerText();
  assert.ok(text.includes('The two services will stop seeing each other.') && text.includes('Tasks and files on both stay where they are.'), `${label}: the confirmation says what happens: ${text}`);
  assert.ok(text.includes(LONG_NAME));
  if (shots) await shot('unlink-confirm');
  await assertFits(page, `unlink ${label}`, !wide);
  await press(page.locator('#h5-link-unlink-cancel'));
  await page.locator('#h5-link-unlink').waitFor({ state: 'detached' });
  await settled();
  assert.equal(model.calls.filter(call => call.method === 'DELETE').length, 0, 'Cancel deletes nothing');
  await tap('.h5-engine-row[data-engine="5"] .h5-engine-remove');
  await page.locator('#h5-link-unlink-accept').waitFor();
  await settled();
  await press(page.locator('#h5-link-unlink-accept'));
  await page.locator('#h5-link-unlink').waitFor({ state: 'detached' });
  await engine(5).waitFor({ state: 'detached' });
  await row('on').waitFor({ state: 'detached' });
  await page.waitForFunction(() => !window.H5UI.get().sources.some(item => item.key === 'remote:5'));
  assert.match(await page.locator('#h5-engines-feedback').innerText(), /Unlinked/);
  // Unlink from the list, and Remove on a revoked row; both read the Engines list again.
  await tap('.h5-link-row[data-link="off"] .h5-link-unlink');
  await page.locator('#h5-link-unlink-accept').waitFor();
  await settled();
  await press(page.locator('#h5-link-unlink-accept'));
  await row('off').waitFor({ state: 'detached' });
  await engine(6).waitFor({ state: 'detached' });
  await tap('.h5-link-row[data-link="gone"] .h5-link-unlink');
  await page.locator('#h5-link-unlink-accept').waitFor();
  await settled();
  assert.match(await page.locator('#h5-link-unlink').innerText(), /already ended this link/);
  await press(page.locator('#h5-link-unlink-accept'));
  await row('gone').waitFor({ state: 'detached' });
  await engine(8).waitFor({ state: 'detached' });
  assert.deepEqual(model.calls.filter(call => call.method === 'DELETE').map(call => call.pathname), ['/api/service-links/on', '/api/service-links/off', '/api/service-links/gone']);
  await page.locator('#h5-link-empty').waitFor();
  await context.close();
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await testOldServer(browser);
    await testCode(browser);
    await testLocalhostWarning(browser);
    await testJoin(browser);
    await testDialogSizes(browser, { width: 320 }, '320');
    await testDialogSizes(browser, { wide: true }, 'wide');
    await testListAndEngines(browser, { shots: true });
    await testListAndEngines(browser, { width: 320 });
    await testListAndEngines(browser, { wide: true });
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('h5 service links: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
