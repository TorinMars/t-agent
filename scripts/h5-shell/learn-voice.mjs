// The voice engines of the Learn page ("Bailian voice" in docs/design/learn-english-voice.md): this device's voices (speechSynthesis,
// learn-speech.mjs) or Bailian's, made on the server (GET /api/learn/speech, services/learn-speech.js) and played with one HTMLAudioElement. (The
// DeepSeek voice of v2.169.0 was removed; a stored 'deepseek' reads as this device's voices.)
// Pure: fetch, the audio element and the object URLs are handed in, so test/h5-learn-voice.test.js runs it with fakes.
// - The server audio of a text is fetched once per page load (kept as an object URL, the oldest dropped after URL_LIMIT) and preloaded when a card
//   appears, so the play itself is synchronous inside the tap (iOS keeps sound only for a play started by the tap). A play whose audio is still
//   loading tells the player (`onLoading`, then `onReady`), so the wait is not taken for a browser that refuses sound; meanwhile the element is
//   started on a short silent sound, which unlocks it on iOS when the play came from a tap.
// - Bailian has a real speech rate: Slow and the Speed setting ask for its slow audio (`speed=slow`, made at rate 0.7 by Bailian), played at 1.
// - Any failure (the network, an error status, no key, an engine without the route, audio that cannot be decoded) reads that play with this
//   device's voice instead and calls `onNotice(reason)`; the page shows one short notice per page load. No key (409) and no route (404) stay for
//   the page load: later plays use this device's voice at once.

export const SPEECH_URL = '/api/learn/speech';
export const STATUS_URL = '/api/learn/speech/status';
export const TRY_TEXT = 'Hello from your English coach.';
export const URL_LIMIT = 80;
export const LOAD_TIMEOUT_MS = 50_000;
export const ENGINES = ['system', 'bailian'];
export const SERVER_ENGINES = ['bailian'];
// Bailian's English voices of qwen-audio-3.1-tts-flash (the same list as BAILIAN_VOICES of services/learn-speech.js): American, then British.
export const BAILIAN_VOICES = [
  { id: 'Cindy_v3.1', name: 'Cindy', accent: 'us', gender: 'female' }, { id: 'Ava_v3.1', name: 'Ava', accent: 'us', gender: 'female' },
  { id: 'Abby_v3.1', name: 'Abby', accent: 'us', gender: 'female' }, { id: 'Annie_v3.1', name: 'Annie', accent: 'us', gender: 'female' },
  { id: 'Beth_v3.1', name: 'Beth', accent: 'us', gender: 'female' }, { id: 'Betty_v3.1', name: 'Betty', accent: 'us', gender: 'female' },
  { id: 'Cally_v3.1', name: 'Cally', accent: 'us', gender: 'female' }, { id: 'Donna_v3.1', name: 'Donna', accent: 'us', gender: 'female' },
  { id: 'Andy_v3.1', name: 'Andy', accent: 'us', gender: 'male' }, { id: 'Brian_v3.1', name: 'Brian', accent: 'us', gender: 'male' },
  { id: 'David_v3.1', name: 'David', accent: 'us', gender: 'male' },
  { id: 'Emily_v3.1', name: 'Emily', accent: 'uk', gender: 'female' }, { id: 'Luna_v3.1', name: 'Luna', accent: 'uk', gender: 'female' },
  { id: 'Eric_v3.1', name: 'Eric', accent: 'uk', gender: 'male' }, { id: 'Luca_v3.1', name: 'Luca', accent: 'uk', gender: 'male' },
];
export const BAILIAN_DEFAULT_VOICE = 'Cindy_v3.1';
export const REGIONS = ['beijing', 'singapore'];
const bailianVoice = id => BAILIAN_VOICES.some(voice => voice.id === id);
// 24 kHz 16-bit mono, 24 samples of silence: started in the tap while the real audio loads (it unlocks the element on iOS).
export const SILENCE = 'data:audio/wav;base64,UklGRlQAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// What the settings ask for: the engine, Bailian's voice and region, whether the server knows the fields at all (an older one does not: the Voice
// row is not shown and this device's voices read) and `bailian`: whether it knows Bailian (v2.169.0 does not, and the row offers only this device's
// voices). Anything else stored, such as the removed 'deepseek', is this device's voices.
export function voiceOptions(settings) {
  const value = settings || {};
  const bailian = typeof value.voice_id_bailian === 'string';
  return {
    known: typeof value.voice_engine === 'string',
    bailian,
    engine: value.voice_engine === 'bailian' && bailian ? 'bailian' : 'system',
    bailianVoice: bailianVoice(value.voice_id_bailian) ? value.voice_id_bailian : BAILIAN_DEFAULT_VOICE,
    region: REGIONS.includes(value.voice_region) ? value.voice_region : 'beijing',
  };
}
// The voice of a play as the server takes it: { engine, voice, region }, from a choice of voiceOptions ({ engine, bailianVoice, region }) or one
// made by this function ({ voice }).
export function serverChoice(choice) {
  const value = choice && typeof choice === 'object' ? choice : {};
  const voice = [value.bailianVoice, value.voice].find(bailianVoice) || BAILIAN_DEFAULT_VOICE;
  return { engine: 'bailian', voice, region: REGIONS.includes(value.region) ? value.region : 'beijing' };
}

const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
// The URL of the audio: the text, the engine, the voice, the region and the speed (Bailian's own speech rate).
export function speechUrl(text, choice, slow = false) {
  const now = serverChoice(choice);
  return `${SPEECH_URL}?${new URLSearchParams({ text: clean(text), engine: now.engine, voice: now.voice, region: now.region, speed: slow ? 'slow' : 'normal' })}`;
}
export const BAILIAN_KEY_URL = '/api/learn/speech/bailian-key';

// The state of the Bailian voice as the page shows it, from GET /speech/status (null while unknown; `unsupported` for an engine without it, or one
// whose answer has no `bailian` part: v2.169.0), with `hasKey` and `workspace` (never the key).
export function voiceState(status) {
  const none = { hasKey: false, workspace: '' };
  if (!status) return { ready: null, reason: null, ...none };
  if (status.unsupported) return { ready: false, reason: 'unsupported', ...none };
  const part = status.bailian && typeof status.bailian === 'object' ? status.bailian : null;
  if (!part) return { ready: false, reason: status.reason === 'failed' ? 'failed' : 'unsupported', ...none };
  return {
    ready: part.ready === true, reason: part.ready === true ? null : (part.reason || 'failed'),
    hasKey: part.has_key === true, workspace: typeof part.workspace === 'string' ? part.workspace : '',
  };
}
// Saves ({ api_key, workspace }) or removes (null) the Bailian key: the new status, or throws an Error with the server's message and `status`.
export async function saveBailianKey(body, fetchImpl = (...args) => fetch(...args)) {
  const init = body
    ? { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) }
    : { method: 'DELETE', headers: { 'X-Requested-With': 'XMLHttpRequest' } };
  const res = await fetchImpl(BAILIAN_KEY_URL, init);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw Object.assign(new Error((data && typeof data.error === 'string' && data.error) || 'The Bailian voice is not available right now'), { status: res.status });
  return data;
}

// Asks the server whether the Bailian voice can read: { bailian }, { unsupported: true } for an engine without the route (404), or
// { ready: false, reason: 'failed' } when the question fails.
export async function fetchVoiceStatus(fetchImpl = (...args) => fetch(...args)) {
  try {
    const res = await fetchImpl(STATUS_URL, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (res.status === 404) return { unsupported: true };
    if (!res.ok) return { ready: false, reason: 'failed' };
    const data = await res.json();
    return data && typeof data === 'object' ? data : { ready: false, reason: 'failed' };
  } catch {
    return { ready: false, reason: 'failed' };
  }
}

// The player of the server audio: `fetchImpl`, `makeAudio()` (an HTMLAudioElement), `createUrl(blob)` / `revokeUrl(url)` (URL.createObjectURL).
export function createServerVoice({ fetchImpl, makeAudio, createUrl, revokeUrl = () => {}, limit = URL_LIMIT }) {
  const loaded = new Map(); // the URL of the audio -> { promise, url, error }
  let audio = null;
  let run = 0; // the play in progress; anything of an older one is ignored
  const down = new Map(); // engine -> 409 (no key) or 404 (no route): its plays read with this device's voice for the rest of the page load
  const element = () => {
    if (!audio) {
      audio = makeAudio();
      try { audio.preload = 'auto'; } catch { /* a fake */ }
    }
    return audio;
  };
  function load(text, choice, slow = false) {
    const now = serverChoice(choice);
    const key = speechUrl(text, now, slow);
    const known = loaded.get(key);
    if (known) { loaded.delete(key); loaded.set(key, known); return known; }
    const entry = { promise: null, url: '', error: null };
    entry.promise = (async () => {
      // A server that never answers is given up after LOAD_TIMEOUT_MS (its own call to Bailian stops after 20 s, a retry included about 41 s).
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS) : null;
      try {
        const res = await fetchImpl(key, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, ...(controller ? { signal: controller.signal } : {}) });
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        const blob = await res.blob();
        return createUrl(blob);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    entry.promise.then(url => { entry.url = url; }, error => {
      entry.error = error;
      loaded.delete(key);
      if (error && (error.status === 409 || error.status === 404)) down.set(now.engine, error.status);
    });
    entry.promise.catch(() => {});
    loaded.set(key, entry);
    while (loaded.size > limit) {
      const [oldest, old] = loaded.entries().next().value;
      loaded.delete(oldest);
      if (old.url) { try { revokeUrl(old.url); } catch { /* gone */ } }
    }
    return entry;
  }
  const quiet = el => { try { el.pause(); } catch { /* not started */ } el.onplaying = null; el.onended = null; el.onerror = null; };

  // Reads `text` once with the server voice of `choice` (voiceOptions). Calls back like speakOnce of learn-speech.mjs
  // (onStart, onEnd, onError('not-allowed' | 'error')), plus onLoading / onReady around a fetch, and onFail(reason) when the server voice cannot read
  // it (the caller reads it another way).
  function speakOnce(text, { choice = null, slow = false, onStart = () => {}, onEnd = () => {}, onError = () => {}, onLoading = () => {}, onReady = () => {}, onFail = () => {} } = {}) {
    if (!clean(text)) return false;
    run += 1;
    const mine = run;
    const live = () => mine === run;
    const now = serverChoice(choice);
    const el = element();
    quiet(el);
    if (down.has(now.engine)) { onFail(down.get(now.engine)); return true; }
    const start = url => {
      if (!live()) return;
      el.onplaying = () => { if (live()) onStart(); };
      el.onended = () => { if (live()) onEnd(); };
      el.onerror = () => { if (live()) { quiet(el); onFail('media'); } };
      el.src = url;
      // Bailian's slow audio is made slow, so it is never slowed again here.
      try { el.defaultPlaybackRate = 1; el.playbackRate = 1; } catch { /* an older browser */ }
      let played;
      try { played = el.play(); } catch (error) { onError(error && error.name === 'NotAllowedError' ? 'not-allowed' : 'error'); return; }
      if (played && typeof played.catch === 'function') {
        played.catch(error => {
          if (!live()) return;
          // A play cut by the next one ('AbortError') is not an error of this one.
          if (error && error.name === 'AbortError') return;
          onError(error && error.name === 'NotAllowedError' ? 'not-allowed' : 'error');
        });
      }
    };
    const entry = load(text, now, slow);
    if (entry.url) { start(entry.url); return true; }
    onLoading();
    // In the tap: a moment of silence on the same element, so iOS lets it play the real audio when it arrives.
    try { el.src = SILENCE; const unlocked = el.play(); if (unlocked && typeof unlocked.catch === 'function') unlocked.catch(() => {}); } catch { /* refused: the real play says so */ }
    entry.promise.then(url => { if (live()) { onReady(); start(url); } }, error => { if (live()) { quiet(el); onFail((error && error.status) || 'network'); } });
    return true;
  }
  return {
    speakOnce,
    preload(text, choice = null, slow = false) { const now = serverChoice(choice); if (!down.has(now.engine) && clean(text)) load(text, now, slow); },
    stop() { run += 1; if (audio) quiet(audio); },
    speaking: () => Boolean(audio && !audio.paused && !audio.ended && audio.src !== SILENCE),
    down: (engine = 'bailian') => down.get(engine) || null,
    setDown(reason, engine = 'bailian') { if (reason) down.set(engine, reason); else down.delete(engine); },
  };
}

// One speakOnce / cancel / speaking for the player of learn-audio.mjs over the engines. `system`: { speakOnce, cancel, speaking } of
// learn-speech.mjs; `server`: createServerVoice or null; `choice()`: { engine, bailianVoice, region, slow } now (`slow`: the Speed setting,
// for the preload); `onNotice(reason, engine)`: a server voice could not read a play, which this device's voice read instead.
export function createVoiceEngine({ system, server, choice, onNotice = () => {} }) {
  const serverNow = () => { const now = choice() || {}; return server && SERVER_ENGINES.includes(now.engine) ? now : null; };
  return {
    speakOnce(text, options = {}) {
      const now = serverNow();
      if (!now) return system.speakOnce(text, options);
      return server.speakOnce(text, {
        ...options, choice: now,
        onFail: reason => {
          onNotice(reason, now.engine);
          if (options.onReady) options.onReady();
          // This device's voice reads it; with none, the play ends here (never "Tap to play" for a voice that is not there).
          if (!system.speakOnce(text, options) && options.onEnd) options.onEnd();
        },
      });
    },
    cancel() { try { system.cancel(); } catch { /* nothing to stop */ } if (server) server.stop(); },
    speaking() { return Boolean(system.speaking()) || Boolean(server && server.speaking()); },
    preload(text) { const now = serverNow(); if (now) server.preload(text, now, Boolean(now.slow)); },
  };
}
