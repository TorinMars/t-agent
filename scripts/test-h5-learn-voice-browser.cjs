// The DeepSeek voice of the Learn page ("DeepSeek voice" in docs/design/learn-english-voice.md; learn-voice.mjs, VoiceChoice and useAudio in
// Learn.jsx), in real Chromium with every route mocked. GET /api/learn/speech answers a tiny valid WAV (never DeepSeek); the page's audio element is
// a recording stand-in (it records the source, playbackRate and preservesPitch, and ends after window.audioMs), and speechSynthesis records what it
// reads. The engine has no coach (its GET answers 404), so the Learn home is there.
// - 390x844 touch: Learn settings → Audio → Voice: This device's voices / DeepSeek as radios in a list row (44px), saved at once; for DeepSeek the
//   voice select (Stella / Tide), Try it (the sample text, played with the chosen voice), the caption about the accent; no key: the notice with
//   Open Settings, Try it off; an engine without the voice: said so.
// - Playback with DeepSeek: a word card plays by itself with the repeat (the audio of the text requested once, the element played twice), Hear it
//   plays at once from the loaded audio, Play slowly uses playbackRate 0.7 with the pitch kept, nothing is read by speechSynthesis; the
//   autoplay-refused "Tap to play" works the same.
// - Fallback: the speech route failing (503): the card is read by this device's voice and one notice says so.
// H5_SHOT_DIR=<dir> saves voice-*.png.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = new Date(Date.now() - 86400000).toISOString();
const TRY_TEXT = 'Hello from your English coach.';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
const ZH = '\u8fc7\u671f';
const card = (id, kind, en, zh, source, extra = {}) => ({
  id, kind, en, zh, source, context: '', due_at: AT, interval_days: 0, ease: 2.5, reps: 0, lapses: 0, last_result: null, last_at: null, suspended: false, created_at: AT, ...extra,
});
const WORDS = [card(1, 'word', 'expire', ZH, 'lookup'), card(2, 'word', 'deploy', ZH, 'starter')];
const SUMMARY = { due: 2, new_today: 0, done_today: 0, goal: 20, streak: 1, words: 2, sentences: 0, mistakes: 0, chats: 0, collecting: true, starter: 'dev' };
const SETTINGS = {
  collect: true, daily_goal: 20, starter: 'dev', audio_words: true, audio_sentences: true, audio_sentences_at: 'after', audio_repeat: 2, audio_pause: 1,
  audio_speed: 'normal', audio_stop_on_typing: true, voice_engine: 'system', voice_id: 'stella',
};
// A WAV header and two samples of silence.
function wav() {
  const data = Buffer.alloc(4);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(24000, 24);
  head.writeUInt32LE(48000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36, 'latin1'); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const pageErrors = [];

function learnMock(options = {}) {
  const mock = { settings: { ...SETTINGS, ...(options.settings || {}) }, status: options.status || { ready: true, reason: null, voices: ['stella', 'tide'] }, speechStatus: 200, requests: [], speech: [] };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, search: url.search, body });
    if (p === '/api/learn/summary') return { ...SUMMARY };
    if (p === '/api/learn/settings' && method === 'GET') return mock.settings;
    if (p === '/api/learn/settings' && method === 'PUT') { mock.settings = { ...mock.settings, ...body }; return mock.settings; }
    if (p === '/api/learn/speech/status') return mock.status === 404 ? [404, { error: 'not mocked' }] : mock.status;
    if (p === '/api/learn/queue') return { cards: WORDS };
    if (p === '/api/learn/meaning') return { zh: ZH };
    const answer = p.match(/^\/api\/learn\/cards\/(\d+)\/answer$/);
    if (answer) return { card: { ...WORDS.find(item => String(item.id) === answer[1]), reps: 1 } };
    return [404, { error: 'not mocked' }];
  };
  mock.puts = () => mock.requests.filter(item => item.method === 'PUT' && item.path === '/api/learn/settings').map(item => item.body);
  mock.spoken = text => mock.speech.filter(item => item.text === text);
  return mock;
}

async function openPage(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const mock = learnMock(options);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('h5-columns', JSON.stringify({ on: false }));
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {} close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1; window.WebSocket.CONNECTING = 0;
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; const event = new Event('open'); this.onopen?.(event); this.dispatchEvent(event); }, 50); }
      close() { this.readyState = 2; }
    };
    // This device's voice: records what it reads; a reading ends after 60 ms.
    window.spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak(u) { window.spoken.push({ text: u.text, rate: u.rate }); setTimeout(() => u.onstart && u.onstart(), 0); setTimeout(() => u.onend && u.onend(), 60); },
      cancel() {}, getVoices: () => [{ lang: 'en-US', name: 'Test', localService: true }], addEventListener() {}, removeEventListener() {},
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    // The audio element: records each play (source, rate, pitch); window.refuseAudio rejects play() like iOS before the first tap.
    window.audioMs = 120;
    window.played = [];
    window.Audio = class {
      constructor() { this.src = ''; this.paused = true; this.ended = false; this.playbackRate = 1; this.defaultPlaybackRate = 1; this.preservesPitch = false; this.timer = null; }
      play() {
        if (window.refuseAudio) return Promise.reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' }));
        window.played.push({ src: this.src, rate: this.playbackRate, pitch: this.preservesPitch, at: performance.now() });
        this.paused = false; this.ended = false;
        clearTimeout(this.timer);
        const silent = this.src.startsWith('data:');
        setTimeout(() => { if (!this.paused && this.onplaying) this.onplaying(); }, 0);
        this.timer = setTimeout(() => { if (this.paused) return; this.paused = true; this.ended = true; if (this.onended) this.onended(); }, silent ? 5 : window.audioMs);
        return Promise.resolve();
      }
      pause() { this.paused = true; clearTimeout(this.timer); }
    };
  });
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) {
      const file = path.join(root, 'public', p);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(file) });
    }
    if (p === '/api/learn/speech') {
      mock.speech.push({ text: url.searchParams.get('text'), voice: url.searchParams.get('voice') });
      if (mock.speechStatus !== 200) return json({ error: 'The DeepSeek voice is not available right now' }, mock.speechStatus);
      return route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'Cache-Control': 'private, max-age=604800' }, body: wav() });
    }
    if (p.startsWith('/api/learn/')) {
      let body = null;
      try { body = route.request().postData() ? JSON.parse(route.request().postData()) : null; } catch { body = null; }
      const out = mock.handle(p, method, url, body);
      return Array.isArray(out) ? json(out[1], out[0]) : json(out);
    }
    if (p === '/api/system/update-status' || p === '/api/system/check-update') return json({ status: 'idle', local_version: '1.0.0', install_type: 'git', log: [] });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/terminal-activity' || p === '/api/tasks/terminal-subagents') return json({});
    const terminals = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (/\/terminal\/(ack|control)$/.test(p)) return json({ success: true });
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/attention' && method === 'GET') return json({ items: [], host: 'T01' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, mock };
}

const text = (page, selector) => page.locator(selector).first().evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(350); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const waitFor = async (check, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const played = page => page.evaluate(() => window.played.filter(item => item.src.startsWith('blob:')));
const spokenBySystem = page => page.evaluate(() => window.spoken.map(item => item.text));
const notice = page => page.evaluate(() => { const value = window.H5UI.get().notice; return value ? value.message : ''; });
async function toLearn(page) {
  await page.locator('.h5-header').waitFor({ state: 'visible' });
  if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: 'Claude: login fix' });
  if (!(await row.count())) await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
  await row.tap();
  await page.waitForFunction(() => !document.body.classList.contains('h5-tasks-open'));
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-bnav'));
  await page.locator('#h5-bnav-learn').tap();
  await page.locator('#h5-learn-due').waitFor();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── Learn settings → Audio → Voice ──
    {
      const { context, page, mock } = await openPage(browser);
      await toLearn(page);
      await page.locator('#h5-learn-settings').tap();
      await page.locator('#h5-learn-voice').waitFor();
      assert.equal(await page.locator('#h5-learn-voice-system').isChecked(), true, "this device's voices by default");
      assert.equal(await page.locator('#h5-learn-voice-deepseek').count(), 1);
      assert.equal(await page.locator('#h5-learn-voice-deepseek').isChecked(), false);
      assert.equal(await page.locator('#h5-learn-voice-id').count(), 0, 'no DeepSeek voice choice for the system voices');
      const rows = await page.locator('#h5-learn-voice label.MuiFormControlLabel-root').evaluateAll(list => list.map(el => Math.round(el.getBoundingClientRect().height)));
      assert.ok(rows.length === 2 && rows.every(h => h >= 44), `44px rows (${rows})`);
      await page.locator('#h5-learn-voice-deepseek').tap();
      await waitFor(() => mock.puts().some(body => body.voice_engine === 'deepseek'), 'DeepSeek saved at once');
      await page.locator('#h5-learn-voice-id').waitFor();
      await page.locator('#h5-learn-voice[data-ready="true"]').waitFor();
      assert.match(await text(page, '#h5-learn-voice-caption'), /may not be American/);
      assert.match(await text(page, '#h5-learn-voice-caption'), /This device's voices/);
      assert.deepEqual(await page.locator('#h5-learn-voice-id option').allTextContents(), ['Stella (female)', 'Tide (male)']);
      assert.equal(await page.locator('#h5-learn-voice-id').inputValue(), 'stella');
      await page.locator('#h5-learn-voice-id').selectOption('tide');
      await waitFor(() => mock.puts().some(body => body.voice_id === 'tide'), 'the voice saved at once');
      const tryBox = await page.locator('#h5-learn-voice-try').boundingBox();
      assert.ok(tryBox.height >= 44, `Try it is a 44px target (${tryBox.height})`);
      await shot(page, 'voice-settings.png');
      await page.locator('#h5-learn-voice-try').tap();
      await waitFor(async () => (await played(page)).length === 1, 'Try it plays');
      assert.deepEqual(mock.speech, [{ text: TRY_TEXT, voice: 'tide' }], 'the sample, with the chosen voice');
      await waitFor(async () => (await text(page, '#h5-learn-voice-try')) === 'Try it', 'back to Try it after the sample');
      // Back to this device's voices: the DeepSeek choices go.
      await page.locator('#h5-learn-voice-system').tap();
      await waitFor(() => mock.puts().some(body => body.voice_engine === 'system'), 'system saved');
      await page.locator('#h5-learn-voice-id').waitFor({ state: 'detached' });
      // The other audio settings stay as they were.
      assert.equal(await page.locator('#h5-learn-audio-repeat button[data-value="2"]').getAttribute('aria-pressed'), 'true');
      await context.close();
    }
    // ── Without a DeepSeek key; an engine without the voice; a server without the setting ──
    {
      const { context, page, mock } = await openPage(browser, { settings: { voice_engine: 'deepseek' }, status: { ready: false, reason: 'no_key', voices: ['stella', 'tide'] } });
      await toLearn(page);
      await page.locator('#h5-learn-settings').tap();
      await page.locator('#h5-learn-voice-no-key').waitFor();
      assert.match(await text(page, '#h5-learn-voice-no-key'), /Set up the DeepSeek translation service first/);
      assert.equal(await page.locator('#h5-learn-voice-try').isDisabled(), true, 'nothing to try without a key');
      await shot(page, 'voice-no-key.png');
      await page.locator('#h5-learn-voice-no-key #h5-learn-open-translator').tap();
      await waitFor(async () => (await page.evaluate(() => window.H5UI.get().settingsOpen)) && !(await page.evaluate(() => window.H5UI.get().learnOpen)), 'Settings opened on the translation service');
      assert.equal(mock.speech.length, 0);
      await context.close();
    }
    {
      const { context, page } = await openPage(browser, { settings: { voice_engine: 'deepseek' }, status: 404 });
      await toLearn(page);
      await page.locator('#h5-learn-settings').tap();
      await page.locator('#h5-learn-voice-unsupported').waitFor();
      await context.close();
    }
    {
      const { context, page } = await openPage(browser, { settings: { voice_engine: undefined, voice_id: undefined } });
      await toLearn(page);
      await page.locator('#h5-learn-settings').tap();
      await page.locator('#h5-learn-audio-card').waitFor();
      assert.equal(await page.locator('#h5-learn-voice').count(), 0, 'an older server: no Voice row');
      await context.close();
    }
    // ── Playback with DeepSeek: repeat, Hear it, Slowly, no speechSynthesis; then "Tap to play" ──
    {
      const { context, page, mock } = await openPage(browser, { settings: { voice_engine: 'deepseek', voice_id: 'tide' } });
      await toLearn(page);
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-meaning').waitFor();
      await waitFor(async () => (await played(page)).length >= 1, 'the word plays when the card appears');
      await page.locator('#h5-learn-hear[data-playing="true"]').waitFor();
      assert.match(await page.locator('#h5-learn-hear').getAttribute('aria-label'), /^Playing [12] of 2$/);
      await waitFor(async () => (await played(page)).length === 2, 'the repeat', 4000);
      const [first, second] = await played(page);
      assert.ok(second.at - first.at >= 1000, `the pause between repeats (${Math.round(second.at - first.at)} ms)`);
      assert.equal(first.src, second.src, 'the same audio');
      assert.deepEqual(mock.spoken('expire'), [{ text: 'expire', voice: 'tide' }], 'the audio of the word requested once');
      await waitFor(async () => (await page.locator('#h5-learn-hear[data-playing]').count()) === 0, 'idle after the repeats');
      // Hear it: from the loaded audio, no new request; typing skips the repeat as with this device's voices.
      await page.locator('#h5-learn-hear').tap();
      await waitFor(async () => (await played(page)).length === 3, 'Hear it plays');
      await page.locator('#h5-learn-stop').tap();
      await page.waitForTimeout(1400);
      assert.equal((await played(page)).length, 3, 'Stop: no repeat');
      // Play slowly: playbackRate 0.7 with the pitch kept.
      await page.locator('#h5-learn-slow').tap();
      await waitFor(async () => (await played(page)).length === 4, 'Play slowly plays');
      const slow = (await played(page))[3];
      assert.deepEqual([slow.rate, slow.pitch], [0.7, true]);
      assert.equal((await played(page))[0].rate, 1, 'normal speed otherwise');
      assert.equal(mock.spoken('expire').length, 1, 'still one request');
      assert.deepEqual(await spokenBySystem(page), [], "this device's voice read nothing");
      await shot(page, 'voice-spell-deepseek.png');
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });
      // A browser that refuses sound before the first tap: "Tap to play", and the tap plays.
      await page.evaluate(() => { window.refuseAudio = true; });
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-tap-play').waitFor({ timeout: 4000 });
      await page.evaluate(() => { window.refuseAudio = false; });
      const before = (await played(page)).length;
      await page.locator('#h5-learn-tap-play').tap();
      await page.locator('#h5-learn-hear[data-playing="true"]').waitFor();
      assert.ok((await played(page)).length > before, 'the tap plays');
      assert.deepEqual(await spokenBySystem(page), []);
      await context.close();
    }
    // ── Fallback: the speech route fails, this device's voice reads, one notice ──
    {
      const { context, page, mock } = await openPage(browser, { settings: { voice_engine: 'deepseek' } });
      mock.speechStatus = 503;
      await toLearn(page);
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-meaning').waitFor();
      await waitFor(async () => (await spokenBySystem(page)).includes('expire'), "this device's voice reads the word");
      assert.equal(await notice(page), "The DeepSeek voice is not available right now. This device's voice reads instead.");
      await waitFor(async () => (await spokenBySystem(page)).filter(item => item === 'expire').length === 2, 'with the repeat', 4000);
      assert.equal((await played(page)).length, 0);
      assert.ok(mock.spoken('expire').length >= 1);
      await shot(page, 'voice-fallback.png');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const errors = pageErrors.filter(message => !/ResizeObserver loop/.test(message));
  assert.deepEqual(errors, [], 'no page errors');
  console.log('Learn DeepSeek voice browser test passed');
})().catch(error => { console.error(error); process.exit(1); });
