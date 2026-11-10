// The page side of "linked services share upload, translation and speech", on the real page (/h5) in Chromium with a mocked API and a fake microphone. With
// `shared_from` in a config and nothing set up here: the entry point works against the mocked call, Settings names the provider, an offline provider is
// said so everywhere. With `shared_from: null`, and on an older server with no such field, the "not configured" behaviour is what it always was.
// H5_SHOT_DIR=<dir> also saves a 390px screenshot of the Translation settings group.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://localhost:9'; // a secure context, for the microphone; every request is answered by the route below
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const PROVIDER = 'Studio Mac';
const OFFLINE_TEXT = `${PROVIDER} is offline, so this is not available right now`;
const SHARED_ONLINE = { name: PROVIDER, online: true };
const SHARED_OFFLINE = { name: PROVIDER, online: false };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const COMPUTER = { viewport: { width: 1200, height: 800 } };
const PNG = { name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') };

// `shared`: what the three configs say while nothing is set up here (undefined: an older server, the field is left out). `calls`: how the feature calls answer.
function makeServer({ shared, calls }) {
  return { shared, calls, local: { oss: false, translate: false, voice: false }, requests: [], ossPosts: 0 };
}
const sharedPart = (server, feature) => {
  if (server.local[feature]) return { shared_from: null };
  return server.shared === undefined ? {} : { shared_from: server.shared };
};

async function apiReply(server, route, url, method) {
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const offline = () => json({ error: 'LINKED_PROVIDER_OFFLINE', provider: PROVIDER }, 502);
  const { pathname } = url;
  if (pathname === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
  if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
  if (pathname === '/api/remote-servers') return json([]);
  if (pathname === '/api/tasks/1/terminals' && method === 'GET') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
  if (pathname === '/api/tasks/1/agent/conversations' || pathname === '/api/tasks/1/agent-sessions') return json([]);
  if (pathname === '/api/system/version') return json({ boot_id: 'b' });

  if (pathname === '/api/oss/config') {
    if (method === 'PUT') { server.local.oss = true; return json({ enabled: true, hasAccessKeySecret: true, ...sharedPart(server, 'oss') }); }
    if (method === 'DELETE') { server.local.oss = false; return json({ enabled: false, hasAccessKeySecret: false, ...sharedPart(server, 'oss') }); }
    return json({ enabled: server.local.oss, hasAccessKeySecret: server.local.oss, ...sharedPart(server, 'oss') });
  }
  if (pathname === '/api/oss/upload-policy' && method === 'POST') {
    server.requests.push('upload-policy');
    if (server.calls === 'offline') return offline();
    if (server.calls === 'none') return json({ error: 'OSS is not configured' }, 400);
    return json({ host: 'https://bucket.oss.test', fields: { key: 'terminal-images/shot.png', policy: 'p' }, url: 'https://img.test/shot.png', expiresAt: null });
  }
  if (pathname === '/api/translate/config') {
    if (method === 'PUT') { server.local.translate = true; return json({ ok: true }); }
    if (method === 'DELETE') { server.local.translate = false; return json({ ok: true }); }
    return json({ provider: 'deepseek', providers: { deepseek: { label: 'DeepSeek', hasApiKey: server.local.translate, baseUrl: '', model: '' } }, ...sharedPart(server, 'translate') });
  }
  if (pathname === '/api/translate' && method === 'POST') {
    server.requests.push('translate');
    if (server.calls === 'offline') return offline();
    if (server.calls === 'none') return json({ error: 'Translation service not configured yet' }, 400);
    return json({ text: 'Run the tests' });
  }
  if (pathname === '/api/translate/word' && method === 'POST') {
    server.requests.push('word');
    if (server.calls === 'offline') return offline();
    if (server.calls === 'none') return json({ error: 'Translation service not configured yet' }, 400);
    return json({ word: 'conflict', base: 'conflict', phonetic: '', pos: 'n.', meaning: 'shared meaning' });
  }
  if (pathname === '/api/speech/config') {
    if (method === 'PUT') { server.local.voice = true; return json({ ok: true }); }
    if (method === 'DELETE') { server.local.voice = false; return json({ ok: true }); }
    return json({ keySource: server.local.voice ? 'saved' : 'none', region: 'cn', regions: { cn: { label: 'China', endpoint: 'wss://cn.example/ws' } }, language: 'zh', languages: { zh: 'Chinese' }, model: '', noiseThreshold: null, hotwords: '', vocabularyId: '', endpoint: '', ...sharedPart(server, 'voice') });
  }
  if (pathname === '/api/speech/token' && method === 'POST') {
    server.requests.push('speech-token');
    if (server.calls === 'offline') return offline();
    if (server.calls === 'none') return json({ error: 'Voice input not configured yet' }, 400);
    return json({ url: 'wss://speech.test/ws', token: 't', model: 'm', language: 'zh' });
  }
  return json({ error: 'not mocked' }, 404);
}

async function openPage(browser, server, { device = COMPUTER, chinese = false, scale } = {}) {
  const context = await browser.newContext({ ...device, ...(scale ? { deviceScaleFactor: scale } : {}) });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(language => {
    if (language) localStorage.setItem('ta-lang', language);
    window.confirm = () => true;
    window.sockets = [];
    window.WebSocket = class FakeSocket {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  }, chinese ? 'zh' : null);
  await page.route(`${ORIGIN}/**`, route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    return apiReply(server, route, url, method);
  });
  await page.route('https://bucket.oss.test/**', route => { server.ossPosts += 1; return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' }); });
  await page.goto(`${ORIGIN}/h5`);
  // Every notice the page gives, in order: the floating notice shows only the last one.
  await page.evaluate(() => { const show = window.notify; window.notices = []; window.notify = (message, type) => { window.notices.push([message, type]); return show(message, type); }; });
  return { context, page, errors };
}

async function openTerminal(page) {
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).click();
  await page.locator('#h5-tasks .h5-terminal-main').first().click();
  await page.waitForFunction(() => window.sockets.some(socket => socket.readyState === 1));
  await page.locator('#h5-voice').waitFor({ state: 'visible' });
}
const noticed = (page, text, type = 'error') => page.waitForFunction(([message, kind]) => window.notices.some(item => item[0] === message && item[1] === kind), [text, type]);
const onScreen = (page, text) => page.locator('.MuiSnackbar-root [role="status"]', { hasText: text }).waitFor();
const offlineSaid = async page => { await noticed(page, OFFLINE_TEXT); await onScreen(page, OFFLINE_TEXT); await page.evaluate(() => { window.notices = []; }); };
const typedInTerminal = (page, text) => page.waitForFunction(value => window.sockets[0].sent.includes(value), text);
const translateBar = async page => {
  await page.locator('#h5-translate-input').fill('run the tests');
  await page.locator('#h5-translate-button').click();
};
// Through the real file picker: h5.js notes the terminal to type the link into on the input's click.
const upload = async page => {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#h5-image').click()]);
  await chooser.setFiles(PNG);
};
const voice = page => page.locator('#h5-voice').click();
// Tap to translate acts on the chat; a message is put on top of the page, since a chat of its own would bring its whole store for one word.
async function lookUpWord(page) {
  const point = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div class="agent-chat" style="position:fixed;left:0;top:0;width:360px;height:auto;z-index:2000;background:#fff"><div class="ac-text"><p id="wt-p" style="margin:40px 20px">The conflict was resolved</p></div></div>');
    window.WordTranslate.setEnabled(true);
    const node = document.getElementById('wt-p').firstChild;
    const range = document.createRange();
    range.setStart(node, 4); range.setEnd(node, 12);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
}
const noErrors = errors => assert.deepEqual(errors, [], 'no script error on the page');

// With shared_from and a provider that answers: every entry point works.
async function sharedWorks(browser) {
  const server = makeServer({ shared: SHARED_ONLINE, calls: 'ok' });
  const { context, page, errors } = await openPage(browser, server);
  await openTerminal(page);
  await upload(page);
  await typedInTerminal(page, 'https://img.test/shot.png ');
  assert.equal(server.ossPosts, 1, 'the file went up with the signed policy');
  await translateBar(page);
  await typedInTerminal(page, 'Run the tests');
  await lookUpWord(page);
  await page.locator('.wt-meaning', { hasText: 'shared meaning' }).waitFor();
  await page.keyboard.press('Escape');
  await voice(page);
  await page.waitForFunction(() => window.sockets.some(socket => socket.url.startsWith('wss://speech.test/')));
  assert.deepEqual(server.requests.sort(), ['speech-token', 'translate', 'upload-policy', 'word']);
  assert.deepEqual(await page.evaluate(() => window.notices.filter(item => item[1] === 'error')), [], 'no error was shown');
  noErrors(errors);
  await context.close();
}

// The provider went offline: each entry point says so, by name, in its own error display.
async function providerOffline(browser) {
  const server = makeServer({ shared: SHARED_OFFLINE, calls: 'offline' });
  const { context, page, errors } = await openPage(browser, server);
  await openTerminal(page);
  await upload(page);
  await offlineSaid(page);
  assert.equal(server.ossPosts, 0, 'nothing went to OSS');
  await page.locator('.h5-upload-overlay').waitFor({ state: 'detached' });
  await translateBar(page);
  await offlineSaid(page);
  assert.equal(await page.locator('#h5-translate-input').inputValue(), 'run the tests', 'the text stays in the box');
  await voice(page);
  await offlineSaid(page);
  await lookUpWord(page);
  await page.locator('.wt-error', { hasText: OFFLINE_TEXT }).waitFor();
  assert.deepEqual(server.requests.sort(), ['speech-token', 'translate', 'upload-policy', 'word']);
  assert.deepEqual(await page.evaluate(() => window.notices.filter(item => /^Set up/.test(item[0]))), [], 'an offline provider is not a "set it up" problem');
  noErrors(errors);
  await context.close();
}

// Nothing shared: what the page did before. `shared` is null, or undefined for an older server.
async function notConfigured(browser, shared) {
  const label = shared === undefined ? 'older server' : 'shared_from null';
  const server = makeServer({ shared, calls: 'none' });
  const { context, page, errors } = await openPage(browser, server);
  await openTerminal(page);
  await upload(page);
  await noticed(page, 'Enable Alibaba Cloud OSS upload in this client’s settings first');
  assert.ok(!server.requests.includes('upload-policy'), `${label}: no upload is prepared`);
  await page.locator('.h5-upload-overlay').waitFor({ state: 'detached' });
  await translateBar(page);
  await noticed(page, 'Translation service not configured yet');
  await noticed(page, 'Set up the translation service in Settings', 'info');
  await voice(page);
  await noticed(page, 'Cannot start the microphone: Voice input not configured yet');
  await noticed(page, 'Set up voice input in Settings', 'info');
  await lookUpWord(page);
  await page.locator('.wt-error', { hasText: 'Translation service not configured yet' }).waitFor();
  noErrors(errors);
  await context.close();
}

const GROUPS = [
  { group: 'oss', line: 'h5-oss-shared', save: 'h5-oss-save', clear: 'h5-oss-clear', empties: ['h5-oss-bucket', 'h5-oss-accessKeyId', 'h5-oss-accessKeySecret'] },
  { group: 'translate', line: 'h5-tr-shared', save: 'h5-tr-save', clear: 'h5-tr-clear', empties: ['h5-tr-key'] },
  { group: 'voice', line: 'h5-vi-shared', save: 'h5-vi-save', clear: 'h5-vi-clear', empties: ['h5-vi-key', 'h5-vi-hotwords'] },
];
const CHARGE = 'Usage is charged to that service’s account; saving settings here makes this device use its own.';
async function openSettings(page) {
  await openTerminal(page);
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
}
const openGroup = async (page, id) => {
  await page.locator(`#h5-set-${id} .MuiAccordionSummary-root`).click();
  await page.waitForFunction(groupId => Boolean(document.querySelector(`#h5-set-${groupId} .MuiCollapse-entered`)), id);
};
const enabled = (page, id) => page.waitForFunction(button => !document.getElementById(button).disabled, id);

// Settings with a provider: the line at the top, an empty form, and saving or deleting here refreshes the group.
async function settingsShared(browser) {
  const server = makeServer({ shared: SHARED_ONLINE, calls: 'ok' });
  const { context, page, errors } = await openPage(browser, server, { device: PHONE, scale: process.env.H5_SHOT_DIR ? 3 : undefined });
  await openSettings(page);
  for (const { group, line, save, clear, empties } of GROUPS) {
    await openGroup(page, group);
    const shown = page.locator(`#${line}`);
    await shown.waitFor();
    assert.equal(await shown.textContent(), `Provided by ${PROVIDER}`, group);
    const details = await page.evaluate(id => { const node = document.getElementById(id); const details = node.parentElement; return { first: details.querySelector('p, span, label') === node || details.firstElementChild === node, next: node.nextElementSibling.textContent }; }, line);
    assert.ok(details.first, `${group}: the line is at the top of the group`);
    assert.equal(details.next, CHARGE, group);
    for (const id of empties) assert.equal(await page.inputValue(`#${id}`), '', `${group}: ${id} starts empty`);
    assert.equal(await page.locator(`#${save}`).isEnabled(), true, `${group}: the form stays usable`);
    if (group === 'translate' && process.env.H5_SHOT_DIR) {
      fs.mkdirSync(process.env.H5_SHOT_DIR, { recursive: true });
      await page.locator(`#h5-set-${group}`).screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'settings-translate-shared-390.png') });
    }
    if (group === 'voice') assert.equal(await page.locator('#h5-vi-effective').count(), 0, 'the address of the linked service is not known here');
    await page.locator(`#${save}`).click();
    await shown.waitFor({ state: 'detached' });
    await enabled(page, save);
    await page.locator(`#${clear}`).click();
    await shown.waitFor();
    await enabled(page, clear);
    assert.equal(await shown.textContent(), `Provided by ${PROVIDER}`, `${group}: back after deleting the local settings`);
  }
  noErrors(errors);
  await context.close();
}

async function settingsOffline(browser) {
  const server = makeServer({ shared: SHARED_OFFLINE, calls: 'offline' });
  const { context, page, errors } = await openPage(browser, server, { device: PHONE });
  await openSettings(page);
  for (const { group, line } of GROUPS) {
    await openGroup(page, group);
    await page.locator(`#${line}`, { hasText: `Provided by ${PROVIDER} (offline)` }).waitFor();
  }
  noErrors(errors);
  await context.close();
}

async function settingsNothing(browser, shared) {
  const label = shared === undefined ? 'older server' : 'shared_from null';
  const server = makeServer({ shared, calls: 'none' });
  const { context, page, errors } = await openPage(browser, server, { device: PHONE });
  await openSettings(page);
  await openGroup(page, 'voice');
  await page.locator('#h5-vi-effective', { hasText: 'wss://cn.example/ws' }).waitFor(); // the group has read its config
  await openGroup(page, 'oss');
  await page.locator('#h5-oss-secret-hint', { hasText: 'required for first-time' }).waitFor();
  await openGroup(page, 'translate');
  await page.locator('#h5-tr-provider option', { hasText: 'DeepSeek' }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('#h5-oss-shared, #h5-tr-shared, #h5-vi-shared').count(), 0, `${label}: no "Provided by" line`);
  assert.equal(await page.getByText(CHARGE).count(), 0, `${label}: no charge sentence`);
  noErrors(errors);
  await context.close();
}

async function settingsChinese(browser) {
  const server = makeServer({ shared: SHARED_OFFLINE, calls: 'offline' });
  const { context, page, errors } = await openPage(browser, server, { device: PHONE, chinese: true });
  await openSettings(page);
  await openGroup(page, 'translate');
  await page.locator('#h5-tr-shared', { hasText: PROVIDER }).waitFor();
  await page.waitForFunction(name => document.getElementById('h5-tr-shared').textContent === `\u7531 ${name} \u63d0\u4f9b\uff08\u5f53\u524d\u79bb\u7ebf\uff09`, PROVIDER);
  noErrors(errors);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await sharedWorks(browser);
    await providerOffline(browser);
    await notConfigured(browser, null);
    await notConfigured(browser, undefined);
    await settingsShared(browser);
    await settingsOffline(browser);
    await settingsNothing(browser, null);
    await settingsNothing(browser, undefined);
    await settingsChinese(browser);
  } finally { await browser.close(); }
  console.log('h5 link shared browser test passed');
})().catch(error => { console.error(error); process.exit(1); });
