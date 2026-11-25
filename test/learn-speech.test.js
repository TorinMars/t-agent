// The Bailian voice of Learn (services/learn-speech.js, services/learn-voice-keys.js, the speech routes of routes/learn.js; "Bailian voice" in
// docs/design/learn-english-voice.md). Alibaba Cloud is never called: every test hands in a fake fetch, and the key is a made-up string. (The
// DeepSeek voice of v2.169.0 was removed: a request for it is refused.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const speechModule = require('../services/learn-speech');
const keysModule = require('../services/learn-voice-keys');
const { createLearnSpeech, BAILIAN_MODEL, BAILIAN_VOICES, BAILIAN_NO_KEY, MAX_TEXT } = speechModule;
const { createLearnRouter } = require('../routes/learn');

const KEY = 'sk-bailian-test-SECRET-never-shown-9876543210';
const SECRET = 'learn-speech-bailian-test-secret-learn-speech-bailian';
const AUDIO_URL = 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio/abc.wav?Expires=1&Signature=x';
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-bailian-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'learn-speech'); };
function wav(label, size = 0) {
  const data = Buffer.concat([Buffer.from(label, 'utf8'), Buffer.alloc(size)]);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(24000, 24);
  head.writeUInt32LE(48000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36, 'latin1'); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const bytes = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
// The answer of the synthesis (JSON with the URL of the file), as the docs show it.
const synthesis = (url = AUDIO_URL) => ({
  status: 200,
  json: async () => ({ output: { audio: { data: '', id: 'audio_1', expires_at: 1792079569, url }, finish_reason: 'stop' }, usage: { characters: 12 }, request_id: 'r1' }),
});
const file = (label, size) => ({ status: 200, arrayBuffer: async () => bytes(wav(label, size)) });
const failure = (status, code = '') => ({ status, json: async () => ({ code, message: `whatever ${code}`, request_id: 'r2' }), arrayBuffer: async () => new ArrayBuffer(0) });
// A fake fetch: the synthesis calls (POST) and the downloads (GET) answered from their own lists in turn.
function fakeFetch({ posts = [synthesis()], gets = [file('cindy')] } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const list = init.method === 'POST' ? posts : gets;
    const next = list.length > 1 ? list.shift() : list[0];
    return typeof next === 'function' ? next(url, init) : next;
  };
  fn.calls = calls;
  return fn;
}
function memoryDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  return db;
}
function make(t, { fetchOptions, saved = { api_key: KEY, workspace: 'llm-abc123' }, ...options } = {}) {
  const db = memoryDb();
  const keys = keysModule.createVoiceKeys({ db, sessionSecret: SECRET });
  if (saved) keys.saveBailian('me', saved);
  const fetchImpl = fakeFetch(fetchOptions);
  const logs = [];
  const log = { warn: message => logs.push(message), info: message => logs.push(message) };
  const dir = tmp(t);
  const speech = createLearnSpeech({ keys, dir, fetchImpl, wait: async () => {}, log, ...options });
  return { speech, keys, db, fetchImpl, logs, dir };
}
const noSecret = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); assert.ok(!text.includes(KEY), 'the key never shows'); };
const rejectsWith = (promise, statusCode, message) => assert.rejects(promise, error => {
  assert.equal(error.statusCode, statusCode);
  if (message) assert.equal(error.message, message);
  noSecret(error.message);
  return true;
});

test('the request to Bailian: the workspace host of the region, the key, qwen-audio-3.1-tts-flash, the voice, WAV and the rate; the file is downloaded without the key', async t => {
  const { speech, fetchImpl } = make(t);
  const audio = await speech.speak('me', { text: '  Ship it\n today. ', engine: 'bailian', voice: 'Ava_v3.1', region: 'singapore', speed: 'slow' });
  assert.equal(audio.subarray(44).toString(), 'cindy');
  assert.equal(fetchImpl.calls.length, 2);
  const [call, download] = fetchImpl.calls;
  assert.equal(call.url, 'https://llm-abc123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
  assert.deepEqual(call.body, { model: BAILIAN_MODEL, input: { text: 'Ship it today.', voice: 'Ava_v3.1', format: 'wav', sample_rate: 24000, rate: 0.7 } });
  assert.equal(BAILIAN_MODEL, 'qwen-audio-3.1-tts-flash');
  assert.ok(call.init.signal, 'with a timeout');
  assert.equal(download.url, AUDIO_URL);
  assert.equal(download.init.headers, undefined, 'the download carries no key');
  noSecret(download.init);
  // The defaults: Cindy, Beijing, the normal rate.
  await speech.speak('me', { text: 'Merge it.', engine: 'bailian' });
  assert.equal(fetchImpl.calls[2].url, 'https://llm-abc123.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.deepEqual(fetchImpl.calls[2].body.input, { text: 'Merge it.', voice: 'Cindy_v3.1', format: 'wav', sample_rate: 24000, rate: 1 });
});

test('base64 audio in the answer is taken as it is; a URL that is not https, or an answer that is not WAV, is refused', async t => {
  const inline = make(t, { fetchOptions: { posts: [{ status: 200, json: async () => ({ output: { audio: { data: wav('inline').toString('base64'), url: '' } } }) }] } });
  assert.equal((await inline.speech.speak('me', { text: 'Hello.', engine: 'bailian' })).subarray(44).toString(), 'inline');
  assert.equal(inline.fetchImpl.calls.length, 1, 'nothing to download');
  const plain = make(t, { fetchOptions: { posts: [synthesis('http://example.test/a.wav')] } });
  await rejectsWith(plain.speech.speak('me', { text: 'Hello.', engine: 'bailian' }), 502, 'The Bailian voice is not available right now');
  assert.equal(plain.fetchImpl.calls.length, 1, 'an http:// link is never fetched');
  const notWav = make(t, { fetchOptions: { gets: [{ status: 200, arrayBuffer: async () => bytes(Buffer.from('ID3 an mp3 or something else entirely, long enough')) }] } });
  await rejectsWith(notWav.speech.speak('me', { text: 'Hello.', engine: 'bailian' }), 502);
  assert.equal(fs.existsSync(notWav.dir) ? fs.readdirSync(notWav.dir).length : 0, 0, 'nothing cached');
});

test('the cache is keyed per region, voice and speed; a hit makes no call, the same request at once is one call', async t => {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return synthesis(); }
    return file(`file-${posts.length}`);
  };
  const { speech, dir } = make(t, { fetchImpl });
  const text = 'expire';
  assert.equal((await speech.speak('me', { text, engine: 'bailian' })).subarray(44).toString(), 'file-1');
  assert.equal((await speech.speak('me', { text })).subarray(44).toString(), 'file-1', 'served from the cache (Bailian is the default engine)');
  assert.equal(posts.length, 1);
  await speech.speak('me', { text, region: 'singapore' });
  await speech.speak('me', { text, voice: 'David_v3.1' });
  await speech.speak('me', { text, speed: 'slow' });
  assert.equal(posts.length, 4);
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, [
    speechModule.cacheName('bailian', 'beijing', 'Cindy_v3.1', 'normal', text),
    speechModule.cacheName('bailian', 'singapore', 'Cindy_v3.1', 'normal', text),
    speechModule.cacheName('bailian', 'beijing', 'David_v3.1', 'normal', text),
    speechModule.cacheName('bailian', 'beijing', 'Cindy_v3.1', 'slow', text),
  ].map(name => `${name}.wav`).sort(), 'named by the hash, never by the text');
  for (const name of names) { noSecret(fs.readFileSync(path.join(dir, name)).toString('latin1')); assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600); }
  // After a restart the cache still answers; a file of the removed DeepSeek voice (named by its voice and text) is never read.
  fs.writeFileSync(path.join(dir, `${speechModule.cacheName('stella', 'old')}.wav`), wav('deepseek'), { mode: 0o600 });
  const again = createLearnSpeech({ keys: { bailian: () => ({ apiKey: KEY, workspace: 'llm-abc123' }) }, dir, fetchImpl, wait: async () => {}, log: { warn() {} } });
  await again.speak('me', { text });
  assert.equal(posts.length, 4, 'the cache survives a restart');
  assert.equal((await again.speak('me', { text: 'old' })).subarray(44).toString(), 'file-5', 'made by Bailian, never the old DeepSeek file');
  // Two at once: one call.
  const [a, b] = await Promise.all([speech.speak('me', { text: 'together' }), speech.speak('me', { text: 'together' })]);
  assert.equal(a, b);
  assert.equal(posts.length, 6);
});

test('the cache keeps at most its size: the least recently played files go first', async t => {
  let n = 0;
  const fetchImpl = async (url, init = {}) => (init.method === 'POST' ? synthesis() : file(`w${n += 1}`, 1000));
  const { speech, dir } = make(t, { fetchImpl, maxCacheBytes: 2500 });
  const nameOf = text => `${speechModule.cacheName('bailian', 'beijing', 'Cindy_v3.1', 'normal', text)}.wav`;
  await speech.speak('me', { text: 'one' });
  await speech.speak('me', { text: 'two' });
  // "one" is played again (it becomes the newest), so "two" is the oldest when "three" comes.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, nameOf('two')), past, past);
  fs.utimesSync(path.join(dir, nameOf('one')), past, past);
  await speech.speak('me', { text: 'one' });
  await speech.speak('me', { text: 'three' });
  assert.deepEqual(fs.readdirSync(dir).sort(), [nameOf('one'), nameOf('three')].sort());
  assert.ok(speech.cacheStats().bytes <= 2500);
  assert.equal(speechModule.MAX_CACHE_BYTES, 50 * 1024 * 1024);
});

test('429 and 5xx are tried once more; a second refusal is "Bailian is busy"', async t => {
  const again = make(t, { fetchOptions: { posts: [failure(429, 'Throttling.RateQuota'), synthesis()] } });
  assert.equal((await again.speech.speak('me', { text: 'Hello.', engine: 'bailian' })).subarray(44).toString(), 'cindy');
  assert.equal(again.fetchImpl.calls.filter(call => call.init.method === 'POST').length, 2);
  const busy = make(t, { fetchOptions: { posts: [failure(500, 'InternalError'), failure(503, 'ServiceUnavailable')] } });
  await rejectsWith(busy.speech.speak('me', { text: 'Hello.', engine: 'bailian' }), 503, 'Bailian is busy, try again in a moment');
  assert.equal(busy.fetchImpl.calls.length, 2, 'only one retry');
});

test("Bailian's errors are clear messages; nothing is cached, and the key and the text never reach the log", async t => {
  const cases = [
    [failure(401, 'InvalidApiKey'), 409, BAILIAN_NO_KEY],
    [failure(403, 'AccessDenied'), 409, BAILIAN_NO_KEY],
    [failure(404, 'ModelNotFound'), 409, BAILIAN_NO_KEY],
    [failure(400, 'InvalidApiKey'), 409, BAILIAN_NO_KEY],
    [failure(400, 'InvalidParameter'), 422, 'Bailian could not read this text'],
    [failure(400, 'DataInspectionFailed'), 422, 'Bailian could not read this text'],
    [failure(400, 'Arrearage'), 402, 'Bailian refused: the account has an overdue payment'],
    [failure(418), 502, 'The Bailian voice is not available right now'],
    [{ status: 200, json: async () => { throw new Error('bad json'); } }, 502, 'The Bailian voice is not available right now'],
    [async () => { throw new TypeError('getaddrinfo ENOTFOUND llm-abc123.cn-beijing.maas.aliyuncs.com'); }, 502, 'Bailian cannot be reached right now'],
  ];
  for (const [answer, status, message] of cases) {
    const { speech, logs, dir } = make(t, { fetchOptions: { posts: [answer] } });
    await rejectsWith(speech.speak('me', { text: 'A private sentence.', engine: 'bailian' }), status, message);
    assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, `${status} ${message}: nothing cached`);
    assert.deepEqual(logs, [`[learn-speech] Bailian: ${status}`]);
  }
  // A download that fails.
  const broken = make(t, { fetchOptions: { gets: [failure(403)] } });
  await rejectsWith(broken.speech.speak('me', { text: 'Hello.', engine: 'bailian' }), 502);
});

test('a call that takes longer than the timeout is cancelled: "took too long"', async t => {
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const { speech } = make(t, { fetchOptions: { posts: [hang] }, timeoutMs: 20 });
  await rejectsWith(speech.speak('me', { text: 'Hello.', engine: 'bailian' }), 504, 'Bailian took too long to read this text');
  assert.equal(speechModule.TIMEOUT_MS, 20_000);
});

test('the request is checked before anything is sent: 1 to 500 characters (longer is refused, never split), English only, a voice of the model, a region, a speed', async t => {
  const { speech, fetchImpl } = make(t);
  await rejectsWith(speech.speak('me', { text: '   ' }), 400, 'Nothing to read');
  await rejectsWith(speech.speak('me', {}), 400, 'Nothing to read');
  await rejectsWith(speech.speak('me', { text: ['a'] }), 400, 'Nothing to read');
  await rejectsWith(speech.speak('me', { text: 'Fix \u767b\u5f55 now' }), 400, 'Only English text is read aloud');
  await rejectsWith(speech.speak('me', { text: 'a'.repeat(MAX_TEXT + 1), engine: 'bailian' }), 400, 'The text to read is longer than 500 characters');
  await rejectsWith(speech.speak('me', { text: 'Hello.', engine: 'bailian', voice: 'stella' }), 400, 'Unknown voice');
  await rejectsWith(speech.speak('me', { text: 'Hello.', engine: 'bailian', voice: 'longanhuan_v3.1' }), 400, 'Unknown voice');
  await rejectsWith(speech.speak('me', { text: 'Hello.', engine: 'bailian', region: 'virginia' }), 400, 'Unknown region');
  await rejectsWith(speech.speak('me', { text: 'Hello.', engine: 'bailian', speed: 'fast' }), 400, 'Unknown speed');
  await rejectsWith(speech.speak('me', { text: 'Hello.', engine: 'openai' }), 400, 'Unknown voice');
  // The removed DeepSeek voice: its engine and its voices are refused (a page of v2.169.0 then reads with this device's voice).
  await rejectsWith(speech.speak('me', { text: 'Hello.', engine: 'deepseek' }), 400, 'Unknown voice');
  await rejectsWith(speech.speak('me', { text: 'Hello.', voice: 'tide' }), 400, 'Unknown voice');
  assert.equal(fetchImpl.calls.length, 0);
  await speech.speak('me', { text: 'a'.repeat(MAX_TEXT), engine: 'bailian' });
  assert.equal(fetchImpl.calls[0].body.input.text.length, 500, 'exactly 500 is one request');
  assert.deepEqual(BAILIAN_VOICES.slice(0, 11), ['Cindy_v3.1', 'Ava_v3.1', 'Abby_v3.1', 'Annie_v3.1', 'Beth_v3.1', 'Betty_v3.1', 'Cally_v3.1', 'Donna_v3.1', 'Andy_v3.1', 'Brian_v3.1', 'David_v3.1']);
});

test('the key: stored encrypted, never in the status, kept when only the workspace changes, removed; without one 409 and no call', async t => {
  const { speech, keys, db, fetchImpl } = make(t, { saved: null });
  await rejectsWith(speech.speak('me', { text: 'Hello.', engine: 'bailian' }), 409, BAILIAN_NO_KEY);
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(speech.status('me').bailian, { ready: false, reason: 'no_key', has_key: false, workspace: '', voices: [...BAILIAN_VOICES], regions: ['beijing', 'singapore'] });
  // The whole API host may be pasted: its first label is the workspace id.
  const saved = speech.saveBailianKey('me', { api_key: ` ${KEY} `, workspace: 'https://LLM-abc123.cn-beijing.maas.aliyuncs.com/api/v1' });
  assert.deepEqual(saved.bailian, { ready: true, reason: null, has_key: true, workspace: 'llm-abc123', voices: [...BAILIAN_VOICES], regions: ['beijing', 'singapore'] });
  noSecret(saved);
  const row = db.prepare("SELECT value FROM system_state WHERE key = 'learn-voice:me'").get();
  assert.ok(row && !row.value.includes(KEY) && !row.value.includes('llm-abc123'), 'encrypted at rest');
  assert.deepEqual(keys.bailian('me'), { apiKey: KEY, workspace: 'llm-abc123' });
  speech.saveBailianKey('me', { api_key: '', workspace: 'llm-other' });
  assert.deepEqual(keys.bailian('me'), { apiKey: KEY, workspace: 'llm-other' }, 'an empty key keeps the saved one');
  assert.throws(() => speech.saveBailianKey('me', { api_key: 'sk-new', workspace: 'not a workspace!' }), /workspace ID/);
  assert.throws(() => speech.saveBailianKey('me', { api_key: 'sk new\nline', workspace: 'llm-x' }), /invalid characters/);
  assert.throws(() => speech.saveBailianKey('me', { api_key: 'k'.repeat(513), workspace: 'llm-x' }), /too long/);
  assert.deepEqual(keys.bailian('me'), { apiKey: KEY, workspace: 'llm-other' }, 'a refused save changes nothing');
  const removed = speech.removeBailianKey('me');
  assert.equal(removed.bailian.has_key, false);
  assert.equal(db.prepare("SELECT value FROM system_state WHERE key = 'learn-voice:me'").get(), undefined);
  assert.throws(() => speech.saveBailianKey('me', { workspace: 'llm-x' }), /Enter the Bailian API key/);
  assert.deepEqual(Object.keys(speech.status('me')), ['bailian'], 'no other voice in the status');
});

// ---- The routes ----
async function serve(t, { speech, sync } = {}) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { req.session = { user: { login: 'me' } }; next(); };
  app.use('/api/learn', createLearnRouter({ service: {}, speech, sync: sync || null, requireAuth, clientOrigin: (req, res, next) => next() }));
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}/api/learn`;
}

test('the routes: Bailian audio as audio/wav, the key saved and removed but never answered, the status', async t => {
  const { speech } = make(t, { saved: null });
  const base = await serve(t, { speech });
  const status = await (await fetch(`${base}/speech/status`)).json();
  assert.equal(status.bailian.has_key, false);
  const put = await fetch(`${base}/speech/bailian-key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: KEY, workspace: 'llm-abc123' }) });
  assert.equal(put.status, 200);
  const putText = await put.text();
  noSecret(putText);
  assert.equal(JSON.parse(putText).bailian.has_key, true);
  const statusText = await (await fetch(`${base}/speech/status`)).text();
  noSecret(statusText);
  assert.equal(JSON.parse(statusText).bailian.workspace, 'llm-abc123');
  const audio = await fetch(`${base}/speech?${new URLSearchParams({ text: 'Hello there.', engine: 'bailian', voice: 'Cindy_v3.1', region: 'beijing', speed: 'normal' })}`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.equal(audio.headers.get('cache-control'), 'private, max-age=604800');
  const bad = await fetch(`${base}/speech/bailian-key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'x', workspace: '!!' }) });
  assert.equal(bad.status, 400);
  const removed = await fetch(`${base}/speech/bailian-key`, { method: 'DELETE' });
  assert.equal((await removed.json()).bailian.has_key, false);
  const noKey = await fetch(`${base}/speech?${new URLSearchParams({ text: 'Hello again.', engine: 'bailian' })}`);
  assert.deepEqual([noKey.status, (await noKey.json()).error], [409, BAILIAN_NO_KEY]);
});

test('a company computer: Bailian on its own home route, the key saved on the home, an older home detected', async t => {
  const asked = [];
  let homeAnswer = { type: 'audio/wav', audio: wav('home').toString('base64') };
  let refuse = null;
  const sync = {
    cacheOnly: () => true, refresh: async () => {}, status: () => ({}),
    askHome: async (route, options) => { asked.push({ route, options }); if (refuse) throw refuse; return typeof homeAnswer === 'function' ? homeAnswer(route) : homeAnswer; },
  };
  const base = await serve(t, { speech: null, sync });
  const response = await fetch(`${base}/speech?${new URLSearchParams({ text: ' Hello  there ', engine: 'bailian', voice: 'Brian_v3.1', region: 'singapore', speed: 'slow' })}`);
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(44).toString(), 'home');
  assert.equal(asked[0].route, `bailian-speech?${new URLSearchParams({ text: 'Hello there', voice: 'Brian_v3.1', region: 'singapore', speed: 'slow' })}`);
  // A request of the removed DeepSeek voice is refused here, before the home is asked.
  assert.equal((await fetch(`${base}/speech?${new URLSearchParams({ text: 'Hi', voice: 'tide' })}`)).status, 400);
  assert.equal(asked.length, 1);
  asked.push({ route: 'placeholder' });
  // The key goes to the home, and only the home's status comes back.
  homeAnswer = { bailian: { ready: true, reason: null, has_key: true, workspace: 'llm-home' } };
  const put = await fetch(`${base}/speech/bailian-key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: KEY, workspace: 'llm-home', extra: 'dropped' }) });
  assert.equal(put.status, 200);
  assert.deepEqual(asked[2], { route: 'bailian-key', options: { method: 'POST', body: { api_key: KEY, workspace: 'llm-home' }, offline: 'The Bailian voice is on a normal computer, which cannot be reached right now' } });
  await fetch(`${base}/speech/bailian-key`, { method: 'DELETE' });
  assert.equal(asked[3].route, 'bailian-key-remove');
  // A home of v2.169.0: its status has no `bailian`; its routes answer 404.
  homeAnswer = { ready: true, reason: null, voices: ['stella', 'tide'] };
  const older = await (await fetch(`${base}/speech/status`)).json();
  assert.deepEqual(Object.keys(older), ['bailian']);
  assert.equal(older.bailian.reason, 'home_older');
  refuse = Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
  const olderAudio = await fetch(`${base}/speech?${new URLSearchParams({ text: 'Hello', engine: 'bailian' })}`);
  assert.equal(olderAudio.status, 409);
  // Away.
  refuse = Object.assign(new Error('away'), { statusCode: 503 });
  const away = await (await fetch(`${base}/speech/status`)).json();
  assert.equal(away.bailian.reason, 'offline');
});

test('every English message of the Bailian voice has a Chinese translation', () => {
  const source = ['services/learn-speech.js', 'services/learn-voice-keys.js', 'routes/learn.js'].map(name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')).join('\n');
  const dictionary = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n-zh-server.js'), 'utf8');
  const messages = new Set(['The Bailian API key is too long (at most 512 characters)', 'The text to read is longer than {1} characters']);
  for (const match of source.matchAll(/(?:speechError|keyError)\('([^']+)'/g)) messages.add(match[1]);
  // No message of the removed DeepSeek voice is left.
  assert.equal(/DeepSeek (could not|is busy|took too long|cannot be reached|refused the API key)/.test(source), false);
  for (const match of source.matchAll(/const (?:BAILIAN_NO_KEY|BAILIAN_OFFLINE) = '([^']+)'/g)) messages.add(match[1]);
  assert.ok([...messages].filter(message => message.includes('Bailian')).length >= 10, [...messages].join(' | '));
  for (const message of messages) assert.ok(dictionary.includes(JSON.stringify(message)), `missing Chinese text for: ${message}`);
});
