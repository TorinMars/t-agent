// The DeepSeek voice of Learn ("DeepSeek voice" in docs/design/learn-english-voice.md): a word or a sentence of a study card read aloud by DeepSeek's
// text-to-speech (POST https://api.deepseek.com/v1/tools/tts), with the DeepSeek API key the person saved for the translation service. The key
// stays in this process: it is read from the translator's store for each call and never written to the cache, a log or an answer.
// - speak(owner, { text, voice }) -> Buffer (audio/wav). The text is trimmed, 1..MAX_TEXT characters, without Chinese (Learn reads English only);
//   the voice is 'stella' (female, the default) or 'tide' (male).
// - A disk cache in <data dir>/learn-speech/<sha256(voice + text)>.wav (0600; MAX_CACHE_BYTES in all, the least recently played removed first; it
//   survives restarts), so a word is made once. The same text asked twice while the first is being made is one call.
// - DeepSeek's answers: 429 (too many at once) and 503 (busy) are tried once more after RETRY_MS; 400 is "DeepSeek could not read this text"; 401 /
//   403 a key DeepSeek refused; 504 and our own timeout (TIMEOUT_MS) "took too long"; anything else, or audio that ends early, "not available". The
//   error body is not read (its shape is not documented).
// - status(owner) -> { ready, reason: null | 'no_key', voices }: whether a DeepSeek key is saved (never the key).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CAPABILITY = 'learn:speech';
const ENDPOINT = 'https://api.deepseek.com/v1/tools/tts';
const VOICES = Object.freeze(['stella', 'tide']);
const DEFAULT_VOICE = 'stella';
const MAX_TEXT = 500;
const TIMEOUT_MS = 20_000;
const RETRY_MS = 500;
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // far above 500 characters of speech (24 kHz 16-bit mono is 48 KB a second)
const NO_KEY = 'Set up the DeepSeek translation service first';
// Chinese, Japanese and Korean text is refused: Learn reads English, and DeepSeek bills a Chinese character twice.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

function speechError(message, statusCode) {
  const { LearnError } = require('./learn');
  return new LearnError(message, statusCode);
}

// The text and voice of a request, checked: { text, voice } or throws 400.
function checkRequest(body) {
  const value = body && typeof body === 'object' ? body : {};
  const text = typeof value.text === 'string' ? value.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw speechError('Nothing to read', 400);
  if (text.length > MAX_TEXT) throw speechError(`The text to read is longer than ${MAX_TEXT} characters`, 400);
  if (CJK.test(text)) throw speechError('Only English text is read aloud', 400);
  const voice = value.voice === undefined || value.voice === null || value.voice === '' ? DEFAULT_VOICE : value.voice;
  if (!VOICES.includes(voice)) throw speechError('Unknown voice', 400);
  return { text, voice };
}

const cacheName = (voice, text) => crypto.createHash('sha256').update(`${voice}\n${text}`).digest('hex');
// A WAV file: RIFF....WAVE and more than the 44 bytes of the header.
const isWav = buffer => Buffer.isBuffer(buffer) && buffer.length > 44 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WAVE';

function createLearnSpeech({
  translator, dir, fetchImpl = (...args) => fetch(...args), timeoutMs = TIMEOUT_MS, retryMs = RETRY_MS, maxCacheBytes = MAX_CACHE_BYTES,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console,
} = {}) {
  if (!translator) throw new Error('createLearnSpeech needs translator');
  if (!dir) throw new Error('createLearnSpeech needs dir');
  const pending = new Map(); // cache name -> the promise of its audio
  const keyOf = owner => {
    const saved = typeof translator.providerConfig === 'function' ? translator.providerConfig(owner, 'deepseek') : null;
    return saved && typeof saved.apiKey === 'string' ? saved.apiKey : '';
  };

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

  // ---- DeepSeek ----
  async function callOnce(key, text, voice) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice_id: voice, format: 'wav' }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return { error: speechError('DeepSeek took too long to read this text', 504) };
        return { error: speechError('DeepSeek cannot be reached right now', 502) };
      }
      if (res.status === 429 || res.status === 503) return { retry: true, error: speechError('DeepSeek is busy, try again in a moment', 503) };
      if (res.status === 400) return { error: speechError('DeepSeek could not read this text', 422) };
      if (res.status === 401 || res.status === 403) return { error: speechError('DeepSeek refused the API key of the translation service', 502) };
      if (res.status === 504) return { error: speechError('DeepSeek took too long to read this text', 504) };
      if (res.status !== 200) return { error: speechError('The DeepSeek voice is not available right now', 502) };
      let buffer;
      try { buffer = Buffer.from(await res.arrayBuffer()); } catch {
        // The stream broke off after it started (or our timeout cut it): a failure, never a cut-off word in the cache.
        if (controller.signal.aborted) return { error: speechError('DeepSeek took too long to read this text', 504) };
        return { error: speechError('The DeepSeek voice is not available right now', 502) };
      }
      if (buffer.length > MAX_AUDIO_BYTES || !isWav(buffer)) return { error: speechError('The DeepSeek voice is not available right now', 502) };
      return { audio: buffer };
    } finally {
      clearTimeout(timer);
    }
  }
  async function synthesize(owner, text, voice) {
    const key = keyOf(owner);
    if (!key) throw speechError(NO_KEY, 409);
    let result = await callOnce(key, text, voice);
    if (result.retry) {
      await wait(retryMs);
      result = await callOnce(key, text, voice);
    }
    if (result.error) {
      // The status only: never the text (the person's sentence) or the key.
      log.warn(`[learn-speech] DeepSeek: ${result.error.statusCode}`);
      throw result.error;
    }
    return result.audio;
  }

  async function speak(owner, body) {
    const { text, voice } = checkRequest(body);
    const name = cacheName(voice, text);
    const cached = readCache(name);
    if (cached) return cached;
    if (pending.has(name)) return pending.get(name);
    const job = (async () => {
      try {
        const audio = await synthesize(owner, text, voice);
        writeCache(name, audio);
        return audio;
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, job);
    return job;
  }

  function status(owner) {
    const ready = Boolean(keyOf(owner));
    return { ready, reason: ready ? null : 'no_key', voices: [...VOICES] };
  }

  return { speak, status, cacheStats, trim };
}

let singleton = null;
function getLearnSpeech() {
  if (singleton) return singleton;
  const db = require('../db');
  const config = require('../config');
  const translator = require('./translator').createTranslator({ db, sessionSecret: config.sessionSecret });
  singleton = createLearnSpeech({ translator, dir: path.join(require('../lib/data-home').paths().root, 'learn-speech') });
  return singleton;
}

module.exports = { CAPABILITY, ENDPOINT, VOICES, DEFAULT_VOICE, MAX_TEXT, TIMEOUT_MS, RETRY_MS, MAX_CACHE_BYTES, NO_KEY, createLearnSpeech, getLearnSpeech, checkRequest, cacheName, isWav };
