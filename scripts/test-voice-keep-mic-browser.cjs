// Browser test of keeping the microphone ready, with Chromium's fake microphone: the real getUserMedia, AudioContext and AudioWorklet.
// The kept microphone is taken once, its audio graph is silent until a recording switches it on, and a recording hands it back instead of stopping it.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/voice-input.js'), 'utf8');

const page = `<!doctype html><meta charset="utf-8"><textarea id="t"></textarea><button id="m">mic</button><button id="keep">keep</button>
<script>
window.notices = []; window.notify = message => window.notices.push(message); window.escapeHtml = text => text;
window.gum = 0; window.streams = []; window.blocks = 0; window.nodes = 0; window.sockets = [];
const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async constraints => { window.gum += 1; const stream = await realGetUserMedia(constraints); window.streams.push(stream); return stream; };
// Counts every block the worklet posts, whoever listens: a worklet that is off must post none.
const RealNode = window.AudioWorkletNode;
window.AudioWorkletNode = class extends RealNode { constructor(...args) { super(...args); window.nodes += 1; this.port.addEventListener('message', () => { window.blocks += 1; }); this.port.start(); } };
window.WebSocket = class { constructor(url) { this.url = url; this.sent = []; window.sockets.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
  send(data) { this.sent.push(typeof data === 'string' ? data : 'audio'); if (typeof data === 'string' && data.includes('run-task')) setTimeout(() => this.onmessage({ data: JSON.stringify({ header: { event: 'task-started' } }) }), 0); }
  close() {} };
</script><script src="/voice-input.js"></script>
<script>window.recording = VoiceInput.attach({ textarea: document.getElementById('t'), button: document.getElementById('m') });
document.getElementById('keep').addEventListener('click', () => VoiceInput.setKeepWarm(!VoiceInput.keepWarm));</script>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
  if (req.url === '/voice-input.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(source);
  if (req.url === '/api/speech/token') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ url: 'wss://speech.example/ws', token: 't', model: 'm', language: 'zh' }));
  res.writeHead(404).end();
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext();
    await context.grantPermissions(['microphone'], { origin });
    const tab = await context.newPage();
    const errors = [];
    tab.on('pageerror', error => errors.push(error.message));
    await tab.goto(origin);
    const get = expression => tab.evaluate(expression);
    const liveTracks = () => get(() => window.streams.filter(stream => stream.getTracks().every(track => track.readyState === 'live')).length);
    const settle = ms => tab.waitForTimeout(ms);
    // Time from the tap to the first block of audio, and whether the recognizer is ready, for the numbers below.
    const record = async () => {
      const before = await get(() => window.blocks);
      const t0 = Date.now();
      await tab.click('#m');
      await tab.waitForFunction(count => window.blocks > count, before, { timeout: 5000 });
      const ms = Date.now() - t0;
      await tab.waitForFunction(() => window.recording.state === 'listening', null, { timeout: 5000 });
      return ms;
    };

    // Off by default: a recording takes the microphone and lets it go.
    assert.equal(await get(() => VoiceInput.keepWarm), false);
    assert.equal(await get(() => window.gum), 0, 'nothing is asked for before the person records');
    const coldMs = await record();
    assert.equal(await get(() => window.gum), 1);
    await get(() => window.recording.cancel());
    await settle(150);
    assert.equal(await liveTracks(), 0, 'the microphone is let go after the recording');

    // On: the microphone is taken once and the audio graph runs silent.
    await tab.click('#keep');
    await tab.waitForFunction(() => window.nodes === 2 && window.gum === 2);
    assert.equal(await get(() => VoiceInput.keepWarm), true);
    assert.equal(await get(() => localStorage.getItem('voice-keep-mic')), '1');
    assert.equal(await liveTracks(), 1, 'the microphone is ready');
    const idleBlocks = await get(() => window.blocks);
    await settle(600);
    assert.equal(await get(() => window.blocks), idleBlocks, 'a worklet that is kept ready posts no audio');

    // A recording uses it: no new microphone, no new graph, and audio flows.
    const warmMs = await record();
    assert.equal(await get(() => window.gum), 2, 'no second request for the microphone');
    assert.equal(await get(() => window.nodes), 2, 'no new audio graph');
    await settle(300);
    assert.ok(await get(() => window.sockets.at(-1).sent.filter(item => item === 'audio').length) > 0, 'the audio reaches the recognizer');
    await get(() => window.recording.cancel());
    await settle(250);
    assert.equal(await liveTracks(), 1, 'the microphone is kept after the recording');
    const after = await get(() => window.blocks);
    await settle(500);
    assert.equal(await get(() => window.blocks), after, 'and the worklet is switched off again');

    // Again: still the same microphone.
    await record();
    assert.equal(await get(() => window.gum), 2);
    await get(() => window.recording.cancel());

    // A hidden page does not hold the microphone; a shown page takes it again.
    await get(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await settle(150);
    assert.equal(await liveTracks(), 0, 'let go while the page is hidden');
    await get(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await tab.waitForFunction(() => window.gum === 3);
    await settle(150);
    assert.equal(await liveTracks(), 1, 'taken again when the page is shown');

    // Off again: the microphone is let go and recordings work as before.
    await tab.click('#keep');
    await settle(150);
    assert.equal(await get(() => VoiceInput.keepWarm), false);
    assert.equal(await liveTracks(), 0);
    await record();
    assert.equal(await get(() => window.gum), 4, 'a recording asks for the microphone again');
    await get(() => window.recording.cancel());
    await settle(150);
    assert.equal(await liveTracks(), 0);
    assert.deepEqual(await get(() => window.notices), []);
    assert.deepEqual(errors, []);
    console.log(`Keep the microphone ready: kept once, silent while idle, handed back by a recording, let go when hidden or turned off (tap to first audio: ${coldMs} ms without it, ${warmMs} ms with it, on this fake microphone).`);
  } finally { await browser.close(); server.closeAllConnections(); server.close(); }
})().catch(error => { console.error(error); process.exit(1); });
