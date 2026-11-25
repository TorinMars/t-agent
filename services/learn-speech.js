// The server voice of Learn ("Bailian voice" in docs/design/learn-english-voice.md): a word or a sentence of a study card read aloud by Alibaba Cloud
// Model Studio (Bailian), made on the server with a key that stays in this process (read for each call, never written to the cache, a log or an
// answer). One provider behind a small interface (credentials, call), with the checks, the cache, the coalescing, the retry and the error mapping
// around it, so another one can be added the same way. (The DeepSeek voice of v2.169.0 was removed.)
// - bailian: model qwen-audio-3.1-tts-flash, POST https://<workspace>.<region>.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer with
//   the DashScope key and workspace id saved for the Learn voice (services/learn-voice-keys.js); its English system voices (Cindy_v3.1, the default,
//   and the others of BAILIAN_VOICES), region beijing | singapore, and a real speech rate (`rate`: 1 normal, 0.7 slow). The answer is JSON with
//   output.audio.url (valid 24 hours), which is downloaded at once (without the key) and kept in the cache.
// - speak(owner, { text, engine, voice, region, speed }) -> Buffer (audio/wav). The text is trimmed, 1..MAX_TEXT characters, without Chinese (Learn
//   reads English only); `engine` is 'bailian' (the default); anything else, such as the removed 'deepseek', is 400.
// - A disk cache in <data dir>/learn-speech/<sha256('bailian', region, voice, speed, text)>.wav (0600; MAX_CACHE_BYTES in all, the least recently
//   played removed first; it survives restarts). Files of the removed DeepSeek voice are never read again and leave with the eviction. The same
//   request asked twice while the first is being made is one call.
// - Answers: busy (429 / 5xx) is tried once more after RETRY_MS; a refused or missing key is 409; a text the service cannot read is 422; a timeout
//   (TIMEOUT_MS for the whole call, the download included) is 504; anything else 502.
// - status(owner) -> { bailian: { ready, reason, has_key, workspace, voices, regions } } (never the key).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CAPABILITY = 'learn:speech';
// The Bailian voice is there (a home of v2.169.0 had only the DeepSeek voice, which was removed).
const BAILIAN_CAPABILITY = 'learn:speech:bailian';
const ENGINES = Object.freeze(['bailian']);
// qwen-audio-3.1-tts-flash and its English system voices (docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list, read
// 2026-11-25): a voice must belong to the model of the request. American first (the user's rule of American pronunciation), then British.
const BAILIAN_MODEL = 'qwen-audio-3.1-tts-flash';
const BAILIAN_VOICES = Object.freeze([
  'Cindy_v3.1', 'Ava_v3.1', 'Abby_v3.1', 'Annie_v3.1', 'Beth_v3.1', 'Betty_v3.1', 'Cally_v3.1', 'Donna_v3.1', 'Andy_v3.1', 'Brian_v3.1', 'David_v3.1',
  'Emily_v3.1', 'Luna_v3.1', 'Eric_v3.1', 'Luca_v3.1',
]);
const BAILIAN_DEFAULT_VOICE = 'Cindy_v3.1';
// The regions of the workspace hosts (docs: qwen-audio-tts-http-api); the English premium voices are in both.
const BAILIAN_REGIONS = Object.freeze({ beijing: 'cn-beijing', singapore: 'ap-southeast-1' });
const BAILIAN_DEFAULT_REGION = 'beijing';
const BAILIAN_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';
const SPEEDS = Object.freeze({ normal: 1, slow: 0.7 });
const SAMPLE_RATE = 24000;
const MAX_TEXT = 500;
const TIMEOUT_MS = 20_000;
const RETRY_MS = 500;
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // far above 500 characters of speech (24 kHz 16-bit mono is 48 KB a second)
const BAILIAN_NO_KEY = 'Bailian key missing or wrong';
// Chinese, Japanese and Korean text is refused: Learn reads English only.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

function speechError(message, statusCode) {
  const { LearnError } = require('./learn');
  return new LearnError(message, statusCode);
}
const given = value => value !== undefined && value !== null && value !== '';
const bailianEndpoint = (workspace, region) => `https://${workspace}.${BAILIAN_REGIONS[region]}.maas.aliyuncs.com${BAILIAN_PATH}`;

// The request, checked: { engine, text, voice, region, speed } or throws 400.
function checkRequest(body) {
  const value = body && typeof body === 'object' ? body : {};
  const text = typeof value.text === 'string' ? value.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw speechError('Nothing to read', 400);
  if (text.length > MAX_TEXT) throw speechError(`The text to read is longer than ${MAX_TEXT} characters`, 400);
  if (CJK.test(text)) throw speechError('Only English text is read aloud', 400);
  const engine = given(value.engine) ? value.engine : 'bailian';
  if (!ENGINES.includes(engine)) throw speechError('Unknown voice', 400);
  const voice = given(value.voice) ? value.voice : BAILIAN_DEFAULT_VOICE;
  if (!BAILIAN_VOICES.includes(voice)) throw speechError('Unknown voice', 400);
  const region = given(value.region) ? value.region : BAILIAN_DEFAULT_REGION;
  if (!Object.hasOwn(BAILIAN_REGIONS, region)) throw speechError('Unknown region', 400);
  const speed = given(value.speed) ? value.speed : 'normal';
  if (!Object.hasOwn(SPEEDS, speed)) throw speechError('Unknown speed', 400);
  return { engine, text, voice, region, speed };
}

const cacheName = (...parts) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
const cacheNameOf = request => cacheName(request.engine, request.region, request.voice, request.speed, request.text);
// A WAV file: RIFF....WAVE and more than the 44 bytes of the header.
const isWav = buffer => Buffer.isBuffer(buffer) && buffer.length > 44 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WAVE';

// The audio of an answer, read whole: a Buffer, or null when the stream broke off.
async function readAudio(res) {
  try { return Buffer.from(await res.arrayBuffer()); } catch { return null; }
}
// The `code` of a DashScope error body ({ code, message, request_id }), or ''; the message is never used (it may quote the text).
async function errorCode(res) {
  try {
    const body = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
    return body && typeof body.code === 'string' ? body.code : '';
  } catch { return ''; }
}

// ---- A provider: { label, credentials(owner) -> credentials or null, noKey, call(credentials, request, { fetchImpl, signal, timedOut }) } ----
// `call` answers { audio } or { error, retry }; it never puts the key into an error.
function bailianProvider(keys) {
  return {
    label: 'Bailian',
    noKey: () => speechError(BAILIAN_NO_KEY, 409),
    credentials(owner) {
      const saved = keys && typeof keys.bailian === 'function' ? keys.bailian(owner) : null;
      return saved && saved.apiKey && saved.workspace ? { key: saved.apiKey, workspace: saved.workspace } : null;
    },
    async call({ key, workspace }, { text, voice, region, speed }, { fetchImpl, signal, timedOut }) {
      // `reason` goes to the log only (never to the person, never the key or the text): what failed, as a short code.
      const unavailable = reason => ({ error: speechError('The Bailian voice is not available right now', 502), reason });
      const tooLong = () => ({ error: speechError('Bailian took too long to read this text', 504), reason: 'timeout' });
      const busy = reason => ({ retry: true, error: speechError('Bailian is busy, try again in a moment', 503), reason });
      let res;
      try {
        res = await fetchImpl(bailianEndpoint(workspace, region), {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: BAILIAN_MODEL, input: { text, voice, format: 'wav', sample_rate: SAMPLE_RATE, rate: SPEEDS[speed] } }),
          signal,
        });
      } catch (error) {
        // A workspace id that names no host ends here too (the name does not resolve).
        if (timedOut()) return tooLong();
        const code = String((error && ((error.cause && error.cause.code) || error.code)) || 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 30);
        return { error: speechError('Bailian cannot be reached right now', 502), reason: `network ${code}` };
      }
      if (res.status === 429 || res.status >= 500) return busy(`http ${res.status}`);
      if (res.status === 401 || res.status === 403 || res.status === 404) return { error: speechError(BAILIAN_NO_KEY, 409), reason: `http ${res.status}` };
      if (res.status === 400) {
        const code = await errorCode(res);
        if (code === 'InvalidApiKey') return { error: speechError(BAILIAN_NO_KEY, 409), reason: 'http 400 InvalidApiKey' };
        if (code === 'Arrearage') return { error: speechError('Bailian refused: the account has an overdue payment', 402), reason: 'http 400 Arrearage' };
        return { error: speechError('Bailian could not read this text', 422), reason: `http 400 ${code || 'no code'}` };
      }
      if (res.status !== 200) return unavailable(`http ${res.status}`);
      let answer;
      try { answer = await res.json(); } catch { return timedOut() ? tooLong() : unavailable('answer is not json'); }
      const audio = answer && answer.output && answer.output.audio;
      let buffer = null;
      if (audio && typeof audio.data === 'string' && audio.data) {
        buffer = Buffer.from(audio.data, 'base64');
      } else if (audio && typeof audio.url === 'string') {
        // The file of the answer (24 hours on Alibaba's storage): fetched now, without the key, only over https.
        let url;
        try { url = new URL(audio.url); } catch { return unavailable('audio url is broken'); }
        if (url.protocol !== 'https:' || url.username || url.password) return unavailable('audio url is not plain https');
        let file;
        try { file = await fetchImpl(url.href, { signal }); } catch { return timedOut() ? tooLong() : unavailable('audio download failed'); }
        if (file.status === 429 || file.status >= 500) return busy(`audio download http ${file.status}`);
        if (file.status !== 200) return unavailable(`audio download http ${file.status}`);
        buffer = await readAudio(file);
        if (!buffer) return timedOut() ? tooLong() : unavailable('audio download is empty or too large');
      } else {
        return unavailable(`answer has no audio (keys: ${Object.keys(answer && typeof answer === 'object' ? answer : {}).slice(0, 6).join(',').replace(/[^A-Za-z0-9_,]/g, '')})`);
      }
      if (!buffer || buffer.length > MAX_AUDIO_BYTES) return unavailable('audio is empty or too large');
      if (!isWav(buffer)) return unavailable('audio is not wav');
      return { audio: buffer };
    },
  };
}

function createLearnSpeech({
  keys = null, dir, fetchImpl = (...args) => fetch(...args), timeoutMs = TIMEOUT_MS, retryMs = RETRY_MS, maxCacheBytes = MAX_CACHE_BYTES,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console,
} = {}) {
  if (!dir) throw new Error('createLearnSpeech needs dir');
  const providers = { bailian: bailianProvider(keys) };
  const pending = new Map(); // cache name -> the promise of its audio

  // ---- The cache ----
  const fileOf = name => path.join(dir, `${name}.wav`);
  function readCache(name) {
    const file = fileOf(name);
    let buffer;
    try { buffer = fs.readFileSync(file); } catch { return null; }
    if (!isWav(buffer)) { try { fs.unlinkSync(file); } catch { /* gone */ } return null; }
    // Played now: the newest for the eviction.
    try { const at = new Date(); fs.utimesSync(file, at, at); } catch { /* still served */ }
    return buffer;
  }
  function writeCache(name, buffer) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = path.join(dir, `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      fs.writeFileSync(temp, buffer, { mode: 0o600 });
      fs.renameSync(temp, fileOf(name));
      trim();
    } catch (error) {
      log.warn(`[learn-speech] the audio could not be cached: ${error && error.code ? error.code : 'error'}`);
    }
  }
  // Removes the least recently played files until the cache is at most maxCacheBytes (and any temporary file left by a crash).
  function trim() {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    const files = [];
    let total = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (name.endsWith('.tmp')) { if (Date.now() - stat.mtimeMs > 60_000) { try { fs.unlinkSync(file); } catch { /* gone */ } } continue; }
      if (!/^[0-9a-f]{64}\.wav$/.test(name)) continue;
      files.push({ file, size: stat.size, at: stat.mtimeMs });
      total += stat.size;
    }
    files.sort((a, b) => a.at - b.at);
    for (const item of files) {
      if (total <= maxCacheBytes) break;
      try { fs.unlinkSync(item.file); total -= item.size; } catch { /* gone */ }
    }
  }
  function cacheStats() {
    let names;
    try { names = fs.readdirSync(dir).filter(name => /^[0-9a-f]{64}\.wav$/.test(name)); } catch { return { files: 0, bytes: 0 }; }
    let bytes = 0;
    for (const name of names) { try { bytes += fs.statSync(path.join(dir, name)).size; } catch { /* gone */ } }
    return { files: names.length, bytes };
  }

  // ---- One call with its timeout, and the retry ----
  async function callOnce(provider, credentials, request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await provider.call(credentials, request, { fetchImpl, signal: controller.signal, timedOut: () => controller.signal.aborted });
    } finally {
      clearTimeout(timer);
    }
  }
  async function synthesize(owner, request) {
    const provider = providers[request.engine];
    const credentials = provider.credentials(owner);
    if (!credentials) throw provider.noKey();
    let result = await callOnce(provider, credentials, request);
    if (result.retry) {
      await wait(retryMs);
      result = await callOnce(provider, credentials, request);
    }
    if (result.error) {
      // The status only: never the text (the person's sentence) or the key.
      log.warn(`[learn-speech] ${provider.label}: ${result.error.statusCode}${result.reason ? ` (${result.reason})` : ''}`);
      throw result.error;
    }
    return result.audio;
  }

  async function speak(owner, body) {
    const request = checkRequest(body);
    const name = cacheNameOf(request);
    const cached = readCache(name);
    if (cached) return cached;
    if (pending.has(name)) return pending.get(name);
    const job = (async () => {
      try {
        const audio = await synthesize(owner, request);
        writeCache(name, audio);
        return audio;
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, job);
    return job;
  }

  function bailianStatus(owner) {
    const view = keys && typeof keys.view === 'function' ? keys.view(owner) : { has_key: false, workspace: '' };
    return {
      ready: Boolean(view.has_key), reason: view.has_key ? null : 'no_key', has_key: Boolean(view.has_key), workspace: view.workspace || '',
      voices: [...BAILIAN_VOICES], regions: Object.keys(BAILIAN_REGIONS),
    };
  }
  const status = owner => ({ bailian: bailianStatus(owner) });
  // The Bailian key of the Learn voice (services/learn-voice-keys.js): saved or removed, then the status (never the key).
  function saveBailianKey(owner, body) {
    if (!keys) throw speechError('The Bailian voice is not available', 503);
    keys.saveBailian(owner, body);
    return status(owner);
  }
  function removeBailianKey(owner) {
    if (!keys) throw speechError('The Bailian voice is not available', 503);
    keys.removeBailian(owner);
    return status(owner);
  }

  return { speak, status, saveBailianKey, removeBailianKey, cacheStats, trim };
}

let singleton = null;
function getLearnSpeech() {
  if (singleton) return singleton;
  const db = require('../db');
  const config = require('../config');
  const keys = require('./learn-voice-keys').createVoiceKeys({ db, sessionSecret: config.sessionSecret });
  singleton = createLearnSpeech({ keys, dir: path.join(require('../lib/data-home').paths().root, 'learn-speech') });
  return singleton;
}

module.exports = {
  CAPABILITY, BAILIAN_CAPABILITY, ENGINES, BAILIAN_MODEL, BAILIAN_VOICES, BAILIAN_DEFAULT_VOICE, BAILIAN_REGIONS,
  BAILIAN_DEFAULT_REGION, BAILIAN_PATH, SPEEDS, MAX_TEXT, TIMEOUT_MS, RETRY_MS, MAX_CACHE_BYTES, BAILIAN_NO_KEY,
  createLearnSpeech, getLearnSpeech, checkRequest, cacheName, cacheNameOf, bailianEndpoint, isWav,
};
