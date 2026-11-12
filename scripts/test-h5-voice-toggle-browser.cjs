// Browser test of the "Voice input" setting on the real shell (Settings.jsx, Terminal.jsx, h5.css, voice-input.js), with Chromium's fake microphone. At 390 and 320 px
// (touch) and on a computer: on by default; turned off, the button takes no room, the bar keeps its layout, a kept microphone is let go and nothing starts a recording;
// a reload keeps it off without asking for the microphone; turned on, everything is back. The composer of the chat is covered in test-agent-chat-browser.cjs.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://localhost:4599'; // localhost: getUserMedia needs a secure page
const read = file => fs.readFileSync(path.join(root, 'public', file), 'utf8');
const html = read('h5.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');

function installFakes() {
  window.gum = 0; window.streams = [];
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => { window.gum += 1; const stream = await real(constraints); window.streams.push(stream); return stream; };
  window.liveMics = () => window.streams.filter(stream => stream.getTracks().every(track => track.readyState === 'live')).length;
  window.WebSocket = class {
    constructor() { setTimeout(() => this.onopen && this.onopen(), 0); }
    send(data) { if (typeof data === 'string' && data.includes('run-task')) setTimeout(() => this.onmessage({ data: JSON.stringify({ header: { event: 'task-started' } }) }), 0); }
    close() {}
  };
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async url => {
    if (url === '/api/speech/token') return reply({ url: 'wss://speech.example/ws', token: 't', model: 'm', language: 'zh' });
    if (url === '/api/speech/config') return reply({ keySource: 'none', region: 'cn', regions: { cn: { label: 'China', endpoint: 'wss://cn.example/ws' } }, language: 'zh', languages: { zh: 'Chinese' }, model: 'm' });
    return reply({ error: 'not mocked' }, 404);
  };
}

async function boot(page, { beforeVoice } = {}) {
  await page.addStyleTag({ content: read('css/h5.css') });
  await page.addScriptTag({ content: read('js/h5-shell.js') });
  if (beforeVoice) await beforeVoice();
  await page.addScriptTag({ content: read('js/voice-overlay.js') });
  await page.addScriptTag({ content: read('js/voice-input.js') });
}

const measure = page => page.evaluate(() => {
  const row = document.getElementById('h5-actions');
  const voice = document.getElementById('h5-voice');
  const shown = [...row.children].filter(el => el.matches('button, label') && getComputedStyle(el).display !== 'none'); // not the divider before the send buttons
  const area = row.getBoundingClientRect();
  return {
    voiceDisplay: getComputedStyle(voice).display, voiceWidth: voice.getBoundingClientRect().width, height: area.height,
    bottom: document.getElementById('h5-bottom').getBoundingClientRect().height, overflow: row.scrollWidth - row.clientWidth,
    ids: shown.map(el => el.id || el.dataset.action), widths: shown.map(el => el.getBoundingClientRect().width),
    inside: shown.every(el => { const box = el.getBoundingClientRect(); return box.left >= area.left - 0.5 && box.right <= area.right + 0.5; }),
  };
});

async function openSwitch(page) {
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await page.locator('#h5-set-voice-translate .MuiAccordionSummary-root').click();
  await page.waitForFunction(() => Boolean(document.querySelector('#h5-set-voice-translate .MuiCollapse-entered')));
  return page.locator('#h5-vi-enabled');
}
async function closeSettings(page) {
  await page.evaluate(() => window.H5UI.set({ settingsOpen: false }));
  await page.locator('#h5-settings').waitFor({ state: 'detached' });
}
const liveIs = (page, count) => page.waitForFunction(expected => window.liveMics() === expected, count, { timeout: 5000 });

async function run(browser, { label, viewport, touch, minWidth }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${ORIGIN}/**`, route => (new URL(route.request().url()).pathname === '/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.fulfill({ status: 404, body: '' })));
  await page.addInitScript(installFakes);
  await page.goto(`${ORIGIN}/`);
  await boot(page);

  // On by default: the button is there.
  const before = await measure(page);
  assert.equal(await page.evaluate(() => window.VoiceInput.enabled), true, `${label}: on by default`);
  assert.notEqual(before.voiceDisplay, 'none', `${label}: the button shows`);
  assert.ok(before.voiceWidth >= minWidth, `${label}: the button has its size`);
  assert.ok(before.ids.includes('h5-voice'));

  // A kept microphone, then turned off in Settings: released at once, with no reload.
  await page.evaluate(() => window.VoiceInput.setKeepWarm(true));
  await liveIs(page, 1);
  const box = await openSwitch(page);
  assert.equal(await box.isChecked(), true, `${label}: the checkbox shows the setting`);
  await box.click();
  await liveIs(page, 0);
  assert.equal(await box.isChecked(), false);
  await closeSettings(page);

  const off = await measure(page);
  assert.equal(off.voiceDisplay, 'none', `${label}: hidden`);
  assert.equal(off.voiceWidth, 0, `${label}: no layout space`);
  assert.deepEqual(off.ids, before.ids.filter(id => id !== 'h5-voice'), `${label}: only the voice button left the row`);
  assert.equal(off.height, before.height, `${label}: the row keeps its height`);
  assert.equal(off.bottom, before.bottom, `${label}: the bottom bar keeps its height`);
  assert.ok(off.overflow <= 0, `${label}: nothing overflows`);
  assert.ok(off.inside, `${label}: every button stays inside the row`);
  assert.ok(off.widths.every(width => width >= minWidth), `${label}: finger-sized buttons: ${off.widths}`);

  // No route starts a recording: a press, a click and keyboard activation of the hidden button.
  const asked = await page.evaluate(() => window.gum);
  await page.evaluate(() => {
    const button = document.getElementById('h5-voice');
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
    button.click();
  });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.gum), asked, `${label}: the microphone is not requested`);
  assert.equal(await page.locator('.h5-voice.listening').count(), 0);
  assert.equal(await page.locator('.vo-overlay:not([hidden])').count(), 0, `${label}: no hold-to-talk screen`);

  // A reload keeps it off and the kept microphone is not requested. The shell hides the button before voice-input.js runs.
  await page.reload();
  await boot(page, { beforeVoice: async () => assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-voice-off')), true, `${label}: hidden before the first paint`) });
  await page.waitForTimeout(150);
  assert.equal((await measure(page)).voiceDisplay, 'none', `${label}: still off after a reload`);
  assert.equal(await page.evaluate(() => window.gum), 0, `${label}: the microphone is not requested after a reload`);

  // Turned on: the button comes back, in the same layout, and so does the kept microphone.
  const again = await openSwitch(page);
  assert.equal(await again.isChecked(), false, `${label}: the checkbox shows it is off`);
  await again.click();
  await liveIs(page, 1);
  await closeSettings(page);
  assert.deepEqual(await measure(page), before, `${label}: the bar is as it was`);
  await page.evaluate(() => window.VoiceInput.setKeepWarm(false));
  await liveIs(page, 0);

  // A running recording stops when the setting is turned off.
  if (touch) {
    await page.evaluate(() => document.getElementById('h5-voice').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })));
    await page.locator('.vo-overlay:not([hidden])').waitFor({ state: 'visible' });
  } else await page.click('#h5-voice');
  await page.waitForSelector('.h5-voice.listening', { state: 'attached' });
  await liveIs(page, 1);
  await page.evaluate(() => window.VoiceInput.setEnabled(false));
  await liveIs(page, 0);
  assert.equal(await page.locator('.h5-voice.listening').count(), 0, `${label}: the recording ended`);
  assert.equal(await page.locator('.vo-overlay:not([hidden])').count(), 0, `${label}: the hold-to-talk screen closed`);

  assert.deepEqual(errors, [], `${label}: no page errors`);
  await context.close();
  return { label, gaps: off.widths.length };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, { label: 'phone 390', viewport: { width: 390, height: 844 }, touch: true, minWidth: 44 });
    await run(browser, { label: 'phone 320', viewport: { width: 320, height: 640 }, touch: true, minWidth: 44 });
    await run(browser, { label: 'computer', viewport: { width: 1280, height: 800 }, touch: false, minWidth: 40 });
    console.log('Voice input setting: default on, hidden with no layout space at 390, 320 px and on a computer, kept microphone released, nothing starts, kept off after a reload, back when turned on.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
