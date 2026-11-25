// The voice engines of the Learn page (scripts/h5-shell/learn-voice.mjs; "Bailian voice" in docs/design/learn-english-voice.md) with a fake fetch
// and a fake audio element: the settings, the audio of a text fetched once, a play synchronous when it is loaded, Slow as Bailian's own slow audio,
// a refusal, the fallback to this device's voice with the notice, and the player of learn-audio.mjs waiting for the audio to load.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/learn-voice.mjs');
const loadAudio = () => import('../scripts/h5-shell/learn-audio.mjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

// A fake HTMLAudioElement: play() resolves (or rejects with `refuse`), 'playing' fires on play, the test ends it with finish().
function fakeAudio({ refuse = null } = {}) {
  const el = {
    src: '', paused: true, ended: false, playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: false, plays: [],
    onplaying: null, onended: null, onerror: null,
    play() {
      el.plays.push({ src: el.src, rate: el.playbackRate, pitch: el.preservesPitch });
      if (refuse) return Promise.reject(Object.assign(new Error('refused'), { name: refuse }));
      el.paused = false; el.ended = false;
      if (el.onplaying) el.onplaying();
      return Promise.resolve();
    },
    pause() { el.paused = true; },
    finish() { el.paused = true; el.ended = true; if (el.onended) el.onended(); },
    fail() { if (el.onerror) el.onerror(); },
  };
  return el;
}
function rig({ status = 200, refuse = null, gate = null } = {}) {
  const fetched = [];
  const el = fakeAudio({ refuse });
  let n = 0;
  const fetchImpl = async url => {
    fetched.push(url);
    if (gate) await gate;
    const code = typeof status === 'function' ? status(url) : status;
    if (code === 'throw') throw new TypeError('Failed to fetch');
    return { ok: code === 200, status: code, blob: async () => ({ url }) };
  };
  return { fetched, el, fetchImpl, makeAudio: () => el, createUrl: () => `blob:${n += 1}`, revoked: [] };
}

const CHOICE = { engine: 'bailian', bailianVoice: 'Brian_v3.1', region: 'beijing' };
const url = (text, { voice = 'Brian_v3.1', region = 'beijing', speed = 'normal' } = {}) => `/api/learn/speech?${new URLSearchParams({ text, engine: 'bailian', voice, region, speed })}`;

test('the settings: the engine, the voice and region, and whether the server knows them; the removed DeepSeek reads as this device', async () => {
  const { voiceOptions, voiceState, speechUrl } = await load();
  const base = { bailian: false, bailianVoice: 'Cindy_v3.1', region: 'beijing' };
  assert.deepEqual(voiceOptions({}), { known: false, engine: 'system', ...base });
  assert.deepEqual(voiceOptions({ voice_engine: 'deepseek', voice_id: 'tide' }), { known: true, engine: 'system', ...base }, 'the removed DeepSeek voice');
  assert.deepEqual(voiceOptions({ voice_engine: 'cloud' }), { known: true, engine: 'system', ...base });
  // Bailian, once the server knows it (v2.169.0 has no voice_id_bailian: Bailian is not offered and this device reads).
  assert.deepEqual(voiceOptions({ voice_engine: 'bailian', voice_id_bailian: 'Ava_v3.1', voice_region: 'singapore' }),
    { known: true, bailian: true, engine: 'bailian', bailianVoice: 'Ava_v3.1', region: 'singapore' });
  assert.equal(voiceOptions({ voice_engine: 'bailian' }).engine, 'system');
  assert.deepEqual(voiceOptions({ voice_engine: 'bailian', voice_id_bailian: 'longanhuan_v3.1', voice_region: 'mars' }), { known: true, bailian: true, engine: 'bailian', bailianVoice: 'Cindy_v3.1', region: 'beijing' });
  const none = { hasKey: false, workspace: '' };
  assert.deepEqual(voiceState(null), { ready: null, reason: null, ...none });
  assert.deepEqual(voiceState({ unsupported: true }), { ready: false, reason: 'unsupported', ...none });
  assert.deepEqual(voiceState({ ready: false, reason: 'failed' }), { ready: false, reason: 'failed', ...none });
  assert.deepEqual(voiceState({ ready: true, reason: null, voices: ['stella', 'tide'] }), { ready: false, reason: 'unsupported', ...none }, 'a server of v2.169.0');
  assert.deepEqual(voiceState({ bailian: { ready: true, reason: null, has_key: true, workspace: 'llm-a' } }), { ready: true, reason: null, hasKey: true, workspace: 'llm-a' });
  assert.deepEqual(voiceState({ bailian: { ready: false, reason: 'no_key', has_key: false } }), { ready: false, reason: 'no_key', ...none });
  assert.deepEqual(voiceState({ bailian: { ready: false, reason: 'home_older' } }), { ready: false, reason: 'home_older', ...none });
  assert.equal(speechUrl('  Run  the tests. ', CHOICE), url('Run the tests.'));
  assert.equal(speechUrl('Run.', { ...CHOICE, bailianVoice: 'David_v3.1', region: 'singapore' }, true), '/api/learn/speech?text=Run.&engine=bailian&voice=David_v3.1&region=singapore&speed=slow');
});

test('fetchVoiceStatus: the answer, 404 is an engine without the voice, a failure is not ready', async () => {
  const { fetchVoiceStatus } = await load();
  assert.deepEqual(await fetchVoiceStatus(async () => ({ ok: true, status: 200, json: async () => ({ ready: true, reason: null }) })), { ready: true, reason: null });
  assert.deepEqual(await fetchVoiceStatus(async () => ({ ok: false, status: 404 })), { unsupported: true });
  assert.deepEqual(await fetchVoiceStatus(async () => ({ ok: false, status: 500 })), { ready: false, reason: 'failed' });
  assert.deepEqual(await fetchVoiceStatus(async () => { throw new Error('offline'); }), { ready: false, reason: 'failed' });
});

test('the audio of a text is fetched once; a loaded one plays at once; Slow is its own slow audio, played at 1', async () => {
  const { createServerVoice, SILENCE } = await load();
  const r = rig();
  const voice = createServerVoice(r);
  voice.preload('expire', CHOICE);
  voice.preload('expire', CHOICE);
  await tick();
  assert.deepEqual(r.fetched, [url('expire')], 'one request for the text');
  const calls = [];
  const handlers = { choice: CHOICE, onStart: () => calls.push('start'), onEnd: () => calls.push('end'), onError: e => calls.push(`error:${e}`), onLoading: () => calls.push('loading'), onReady: () => calls.push('ready'), onFail: e => calls.push(`fail:${e}`) };
  assert.equal(voice.speakOnce('expire', handlers), true);
  assert.deepEqual(calls, ['start'], 'preloaded: played inside the call (the tap), no loading');
  assert.equal(r.el.plays.at(-1).rate, 1);
  assert.equal(voice.speaking(), true);
  r.el.finish();
  assert.deepEqual(calls, ['start', 'end']);
  assert.equal(voice.speaking(), false);
  calls.length = 0;
  voice.speakOnce('expire', { ...handlers, slow: true });
  await tick(); await tick();
  assert.equal(r.fetched.at(-1), url('expire', { speed: 'slow' }), 'the slow audio is asked for');
  assert.deepEqual(r.el.plays.at(-1), { src: 'blob:2', rate: 1, pitch: false }, 'never slowed again here');
  calls.length = 0;
  voice.speakOnce('expire', handlers);
  assert.deepEqual(calls, ['start']);
  assert.equal(r.el.plays.at(-1).src, 'blob:1');
  assert.equal(r.fetched.length, 2, 'each audio fetched once');
  // A text not loaded yet: loading, a moment of silence (it unlocks the element on iOS), then ready and the play.
  calls.length = 0;
  voice.speakOnce('deploy', handlers);
  assert.deepEqual(calls, ['loading']);
  assert.equal(r.el.plays.at(-1).src, SILENCE);
  await tick(); await tick();
  assert.deepEqual(calls, ['loading', 'ready', 'start']);
  assert.equal(r.el.plays.at(-1).src, 'blob:3');
  // Stop: nothing of the stopped play is heard or reported afterwards.
  voice.stop();
  assert.equal(r.el.paused, true);
  calls.length = 0;
  r.el.finish();
  assert.deepEqual(calls, []);
});

test('a refused play is "not-allowed"; a failed request or audio that cannot play is onFail; no key and no route stay for the page load', async () => {
  const { createServerVoice } = await load();
  const refused = rig({ refuse: 'NotAllowedError' });
  const voice = createServerVoice(refused);
  voice.preload('expire');
  await tick();
  const errors = [];
  voice.speakOnce('expire', { onError: e => errors.push(e) });
  await tick();
  assert.deepEqual(errors, ['not-allowed']);

  for (const [status, reason] of [[503, 503], [422, 422], ['throw', 'network']]) {
    const r = rig({ status });
    const server = createServerVoice(r);
    const fails = [];
    server.speakOnce('Hello there.', { onFail: e => fails.push(e) });
    await tick(); await tick();
    assert.deepEqual(fails, [reason]);
    assert.equal(server.down(), null, `${status}: the next play tries again`);
    server.speakOnce('Hello there.', { onFail: e => fails.push(e) });
    await tick(); await tick();
    assert.equal(r.fetched.length, 2, `${status}: a failure is not kept`);
  }
  const noKey = rig({ status: 409 });
  const keyless = createServerVoice(noKey);
  const fails = [];
  keyless.speakOnce('Hello.', { onFail: e => fails.push(e) });
  await tick(); await tick();
  assert.equal(keyless.down(), 409);
  keyless.speakOnce('Other.', { onFail: e => fails.push(e) });
  assert.deepEqual(fails, [409, 409], 'at once, without a request');
  assert.equal(noKey.fetched.length, 1);
  keyless.setDown(null);
  assert.equal(keyless.down(), null);
  // The element cannot decode the audio.
  const media = rig();
  const bad = createServerVoice(media);
  bad.preload('expire');
  await tick();
  const mediaFails = [];
  bad.speakOnce('expire', { onFail: e => mediaFails.push(e) });
  media.el.fail();
  assert.deepEqual(mediaFails, ['media']);
});

test('the engine: this device or Bailian as chosen now; a Bailian failure is read by this device with one notice', async () => {
  const { createServerVoice, createVoiceEngine } = await load();
  const r = rig({ status: 503 });
  const server = createServerVoice(r);
  const system = { said: [], speakOnce(text, options) { this.said.push(text); options.onStart && options.onStart(); return true; }, cancel() { this.cancels = (this.cancels || 0) + 1; }, speaking: () => false };
  let chosen = { engine: 'system' };
  const notices = [];
  const engine = createVoiceEngine({ system, server, choice: () => chosen, onNotice: reason => notices.push(reason) });
  engine.speakOnce('expire', {});
  engine.preload('expire');
  assert.deepEqual(system.said, ['expire']);
  assert.equal(r.fetched.length, 0, 'this device: nothing fetched');
  chosen = CHOICE;
  const calls = [];
  engine.speakOnce('deploy', { onLoading: () => calls.push('loading'), onReady: () => calls.push('ready'), onStart: () => calls.push('start') });
  await tick(); await tick();
  assert.deepEqual(r.fetched, [url('deploy')]);
  assert.deepEqual(notices, [503]);
  assert.deepEqual(system.said, ['expire', 'deploy'], 'read by this device instead');
  assert.deepEqual(calls, ['loading', 'ready', 'start']);
  engine.cancel();
  assert.equal(system.cancels, 1);
  // No voice on this device either: the play ends (never "Tap to play" for a voice that is not there).
  const mute = createVoiceEngine({ system: { speakOnce: () => false, cancel() {}, speaking: () => false }, server, choice: () => chosen });
  const ends = [];
  mute.speakOnce('merge', { onEnd: () => ends.push('end') });
  await tick(); await tick();
  assert.deepEqual(ends, ['end']);
});

test('the engine with Bailian: the voice, region and speed of the choice; the Speed setting preloads the slow audio; a missing key stays for the page load', async () => {
  const { createServerVoice, createVoiceEngine } = await load();
  const r = rig({ status: url => (url.includes('engine=bailian') && url.includes('text=Locked') ? 409 : 200) });
  const server = createServerVoice(r);
  const system = { said: [], speakOnce(text) { this.said.push(text); return true; }, cancel() {}, speaking: () => false };
  let chosen = { engine: 'bailian', bailianVoice: 'Cindy_v3.1', region: 'beijing', slow: false };
  const notices = [];
  const engine = createVoiceEngine({ system, server, choice: () => chosen, onNotice: (reason, name) => notices.push(`${name}:${reason}`) });
  engine.preload('expire');
  await tick();
  assert.deepEqual(r.fetched, ['/api/learn/speech?text=expire&engine=bailian&voice=Cindy_v3.1&region=beijing&speed=normal']);
  engine.speakOnce('expire', {});
  assert.equal(r.el.plays.at(-1).rate, 1);
  // Slow: Bailian makes it slow (speed=slow), so it plays at 1.
  engine.speakOnce('expire', { slow: true });
  await tick(); await tick();
  assert.equal(r.fetched.at(-1), '/api/learn/speech?text=expire&engine=bailian&voice=Cindy_v3.1&region=beijing&speed=slow');
  assert.equal(r.el.plays.at(-1).rate, 1, 'never slowed twice');
  // The Speed setting slow: the preload asks for the slow audio.
  chosen = { ...chosen, slow: true };
  engine.preload('deploy');
  await tick();
  assert.equal(r.fetched.at(-1), '/api/learn/speech?text=deploy&engine=bailian&voice=Cindy_v3.1&region=beijing&speed=slow');
  // 409: its plays read on this device from now on.
  engine.speakOnce('Locked', {});
  await tick(); await tick();
  assert.deepEqual(notices, ['bailian:409']);
  assert.equal(server.down('bailian'), 409);
  const before = r.fetched.length;
  engine.speakOnce('Another', {});
  assert.equal(r.fetched.length, before, 'no request while Bailian is down');
  assert.deepEqual(system.said, ['Locked', 'Another']);
  server.setDown(null);
  assert.equal(server.down(), null);
  engine.speakOnce('Another', {});
  await tick();
  assert.equal(r.fetched.at(-1), '/api/learn/speech?text=Another&engine=bailian&voice=Cindy_v3.1&region=beijing&speed=normal', 'asked again once the key is there');
});

test('saveBailianKey: PUT with the key and the workspace, DELETE to remove, the server message on a refusal', async () => {
  const { saveBailianKey, BAILIAN_KEY_URL } = await load();
  const calls = [];
  const answer = (status, body) => async (url, init) => { calls.push({ url, init }); return { ok: status === 200, status, json: async () => body }; };
  assert.deepEqual(await saveBailianKey({ api_key: 'k', workspace: 'llm-a' }, answer(200, { bailian: { has_key: true } })), { bailian: { has_key: true } });
  assert.equal(calls[0].url, BAILIAN_KEY_URL);
  assert.equal(calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].init.body), { api_key: 'k', workspace: 'llm-a' });
  await saveBailianKey(null, answer(200, {}));
  assert.equal(calls[1].init.method, 'DELETE');
  await assert.rejects(saveBailianKey({ api_key: 'k', workspace: '!' }, answer(400, { error: 'Enter the workspace ID of Bailian (llm-…), or paste its API host' })),
    error => error.status === 400 && /workspace ID/.test(error.message));
});

test('the player waits for the audio to load before it watches for a refusal or a lost end', async () => {
  const { createPlayer, START_MS } = await loadAudio();
  let now = 0;
  let timers = [];
  const setTimer = (fn, ms) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; };
  const clearTimer = timer => { timers = timers.filter(item => item !== timer); };
  const advance = ms => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter(timer => timer !== due);
      now = due.at;
      due.fn();
    }
    now = until;
  };
  let handlers = null;
  const states = [];
  const player = createPlayer({ speakOnce: (text, h) => { handlers = h; h.onLoading(); return true; }, setTimer, clearTimer, onChange: state => states.push(state) });
  player.play('expire', { repeat: 1, auto: true });
  assert.equal(timers.length, 0, 'no watch while the audio loads');
  advance(START_MS * 3);
  assert.equal(player.state().blocked, false, 'a slow load is not a refusal');
  handlers.onReady();
  handlers.onStart();
  advance(START_MS + 10);
  assert.equal(player.state().blocked, false);
  handlers.onEnd();
  assert.equal(player.state().playing, false);
  // Loaded but never started: refused as before.
  player.play('deploy', { repeat: 1, auto: true });
  handlers.onReady();
  advance(START_MS + 10);
  assert.equal(player.state().blocked, true);
});
