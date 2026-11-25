// The voice engines of the Learn page ("DeepSeek voice" in docs/design/learn-english-voice.md): this device's voices (speechSynthesis,
// learn-speech.mjs) or DeepSeek's, made on the server (GET /api/learn/speech, services/learn-speech.js) and played with one HTMLAudioElement.
// Pure: fetch, the audio element and the object URLs are handed in, so test/h5-learn-voice.test.js runs it with fakes.
// - The DeepSeek audio of a text is fetched once per page load (kept as an object URL, the oldest dropped after URL_LIMIT) and preloaded when a card
//   appears, so the play itself is synchronous inside the tap (iOS keeps sound only for a play started by the tap). A play whose audio is still
//   loading tells the player (`onLoading`, then `onReady`), so the wait is not taken for a browser that refuses sound; meanwhile the element is
//   started on a short silent sound, which unlocks it on iOS when the play came from a tap.
// - DeepSeek has no speed: Slow and the Speed setting use `playbackRate` (SLOW_RATE) with the pitch kept.
// - Any failure (the network, an error status, no DeepSeek key, an engine without the route, audio that cannot be decoded) reads that play with this
//   device's voice instead and calls `onNotice(reason)`; the page shows one short notice per page load. No key (409) and no route (404) stay for
//   the page load: later plays use this device's voice at once.

export const SPEECH_URL = '/api/learn/speech';
export const STATUS_URL = '/api/learn/speech/status';
export const TRY_TEXT = 'Hello from your English coach.';
export const SLOW_RATE = 0.7;
export const URL_LIMIT = 80;
export const LOAD_TIMEOUT_MS = 50_000;
export const VOICES = ['stella', 'tide'];
export const ENGINES = ['system', 'deepseek'];
// 24 kHz 16-bit mono, 24 samples of silence: started in the tap while the real audio loads (it unlocks the element on iOS).
export const SILENCE = 'data:audio/wav;base64,UklGRlQAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// What the settings ask for: the engine and DeepSeek's voice, and whether the server knows the fields at all (an older one does not: the Voice row
// is not shown and this device's voices read).
export function voiceOptions(settings) {
  const value = settings || {};
  return {
    known: typeof value.voice_engine === 'string',
    engine: ENGINES.includes(value.voice_engine) ? value.voice_engine : 'system',
    voice: VOICES.includes(value.voice_id) ? value.voice_id : 'stella',
  };
}

const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
export const speechUrl = (text, voice) => `${SPEECH_URL}?${new URLSearchParams({ text: clean(text), voice: VOICES.includes(voice) ? voice : 'stella' })}`;

// The state of the DeepSeek voice as the page shows it, from GET /speech/status (null while unknown; `unsupported` for an engine without it).
export function voiceState(status) {
  if (!status) return { ready: null, reason: null };
  if (status.unsupported) return { ready: false, reason: 'unsupported' };
  return { ready: status.ready === true, reason: status.ready === true ? null : (status.reason || 'failed') };
}

// Asks the server whether the DeepSeek voice can read: { ready, reason, voices }, { unsupported: true } for an engine without the route (404), or
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

// The DeepSeek player: `fetchImpl`, `makeAudio()` (an HTMLAudioElement), `createUrl(blob)` / `revokeUrl(url)` (URL.createObjectURL).
export function createServerVoice({ fetchImpl, makeAudio, createUrl, revokeUrl = () => {}, limit = URL_LIMIT }) {
  const loaded = new Map(); // `${voice}\n${text}` -> { promise, url, error }
  let audio = null;
  let run = 0; // the play in progress; anything of an older one is ignored
  let down = null; // 409 (no key) or 404 (no route): every play reads with this device's voice for the rest of the page load
  const element = () => {
    if (!audio) {
      audio = makeAudio();
      try { audio.preload = 'auto'; } catch { /* a fake */ }
    }
    return audio;
  };
  function load(text, voice) {
    const words = clean(text);
    const key = `${voice}\n${words}`;
    const known = loaded.get(key);
    if (known) { loaded.delete(key); loaded.set(key, known); return known; }
    const entry = { promise: null, url: '', error: null };
    entry.promise = (async () => {
      // A server that never answers is given up after LOAD_TIMEOUT_MS (its own call to DeepSeek stops after 20 s, a retry included about 41 s).
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS) : null;
      try {
        const res = await fetchImpl(speechUrl(words, voice), { headers: { 'X-Requested-With': 'XMLHttpRequest' }, ...(controller ? { signal: controller.signal } : {}) });
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
      if (error && (error.status === 409 || error.status === 404)) down = error.status;
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

  // Reads `text` once with DeepSeek's `voice`. Calls back like speakOnce of learn-speech.mjs (onStart, onEnd, onError('not-allowed' | 'error')),
  // plus onLoading / onReady around a fetch, and onFail(reason) when DeepSeek cannot read it (the caller reads it another way).
  function speakOnce(text, { voice = 'stella', slow = false, onStart = () => {}, onEnd = () => {}, onError = () => {}, onLoading = () => {}, onReady = () => {}, onFail = () => {} } = {}) {
    if (!clean(text)) return false;
    run += 1;
    const mine = run;
    const live = () => mine === run;
    const el = element();
    quiet(el);
    if (down) { onFail(down); return true; }
    const start = url => {
      if (!live()) return;
      el.onplaying = () => { if (live()) onStart(); };
      el.onended = () => { if (live()) onEnd(); };
      el.onerror = () => { if (live()) { quiet(el); onFail('media'); } };
      el.src = url;
      const rate = slow ? SLOW_RATE : 1;
      try { el.defaultPlaybackRate = rate; el.playbackRate = rate; el.preservesPitch = true; el.webkitPreservesPitch = true; el.mozPreservesPitch = true; } catch { /* an older browser */ }
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
    const entry = load(text, voice);
    if (entry.url) { start(entry.url); return true; }
    onLoading();
    // In the tap: a moment of silence on the same element, so iOS lets it play the real audio when it arrives.
    try { el.src = SILENCE; const unlocked = el.play(); if (unlocked && typeof unlocked.catch === 'function') unlocked.catch(() => {}); } catch { /* refused: the real play says so */ }
    entry.promise.then(url => { if (live()) { onReady(); start(url); } }, error => { if (live()) { quiet(el); onFail((error && error.status) || 'network'); } });
    return true;
  }
  return {
    speakOnce,
    preload(text, voice = 'stella') { if (!down && clean(text)) load(text, voice); },
    stop() { run += 1; if (audio) quiet(audio); },
    speaking: () => Boolean(audio && !audio.paused && !audio.ended && audio.src !== SILENCE),
    down: () => down,
    setDown(reason) { down = reason || null; },
  };
}

// One speakOnce / cancel / speaking for the player of learn-audio.mjs over both engines. `system`: { speakOnce, cancel, speaking } of
// learn-speech.mjs; `server`: createServerVoice or null; `choice()`: { engine, voice } now; `onNotice(reason)`: DeepSeek could not read a play,
// which this device's voice read instead.
export function createVoiceEngine({ system, server, choice, onNotice = () => {} }) {
  const deepseek = () => { const now = choice() || {}; return server && now.engine === 'deepseek' ? now : null; };
  return {
    speakOnce(text, options = {}) {
      const now = deepseek();
      if (!now) return system.speakOnce(text, options);
      return server.speakOnce(text, {
        ...options, voice: now.voice,
        onFail: reason => {
          onNotice(reason);
          if (options.onReady) options.onReady();
          // This device's voice reads it; with none, the play ends here (never "Tap to play" for a voice that is not there).
          if (!system.speakOnce(text, options) && options.onEnd) options.onEnd();
        },
      });
    },
    cancel() { try { system.cancel(); } catch { /* nothing to stop */ } if (server) server.stop(); },
    speaking() { return Boolean(system.speaking()) || Boolean(server && server.speaking()); },
    preload(text) { const now = deepseek(); if (now) server.preload(text, now.voice); },
  };
}
