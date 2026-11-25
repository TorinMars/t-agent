// The DeepSeek voice of Learn (services/learn-speech.js, GET /api/learn/speech in routes/learn.js; "DeepSeek voice" in
// docs/design/learn-english-voice.md). DeepSeek is never called: every test hands in a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const speechModule = require('../services/learn-speech');
const { createLearnSpeech, ENDPOINT, MAX_TEXT, NO_KEY } = speechModule;
const { createLearnRouter } = require('../routes/learn');

const KEY = 'sk-test-SECRET-never-shown-0123456789';
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-speech-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'learn-speech'); };
function wav(label, size = 0) {
  const data = Buffer.concat([Buffer.from(label, 'utf8'), Buffer.alloc(size)]);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(24000, 24);
  head.writeUInt32LE(48000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36, 'latin1'); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const audioResponse = (label, size) => ({ status: 200, arrayBuffer: async () => { const b = wav(label, size); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
const statusResponse = status => ({ status, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '{"error":{"message":"whatever"}}' });
// A fake fetch that answers from `answers` in turn (a function gets the call) and records each call.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return typeof next === 'function' ? next(url, init) : next;
  };
  fn.calls = calls;
  return fn;
}
const translatorWith = key => ({ providerConfig: (owner, id) => (id === 'deepseek' ? { apiKey: key, baseUrl: 'https://api.deepseek.com', model: 'm' } : null) });
function make(t, { answers = [audioResponse('one')], key = KEY, ...options } = {}) {
  const fetchImpl = fakeFetch(answers);
  const logs = [];
  const log = { warn: message => logs.push(message), info: message => logs.push(message) };
  const dir = options.dir || tmp(t);
  const speech = createLearnSpeech({ translator: translatorWith(key), dir, fetchImpl, wait: async () => {}, log, ...options });
  return { speech, fetchImpl, logs, dir };
}
const rejectsWith = (promise, statusCode, message) => assert.rejects(promise, error => {
  assert.equal(error.statusCode, statusCode);
  if (message) assert.equal(error.message, message);
  assert.ok(!String(error.message).includes(KEY));
  return true;
});

test('the request to DeepSeek: POST /v1/tools/tts with the key, the text, the voice and WAV; the audio comes back', async t => {
  const { speech, fetchImpl } = make(t);
  const audio = await speech.speak('me', { text: '  Run the tests\n again. ', voice: 'tide' });
  assert.equal(audio.subarray(44, 47).toString(), 'one');
  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, ENDPOINT);
  assert.equal(ENDPOINT, 'https://api.deepseek.com/v1/tools/tts');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
  assert.deepEqual(call.body, { text: 'Run the tests again.', voice_id: 'tide', format: 'wav' });
  assert.ok(call.init.signal, 'with a timeout');
  // Stella is the default voice.
  await speech.speak('me', { text: 'Merge it.' });
  assert.equal(fetchImpl.calls[1].body.voice_id, 'stella');
});

test('a word is made once: the cache answers the second time and after a restart, and the key is never in it', async t => {
  const { speech, fetchImpl, dir } = make(t);
  await speech.speak('me', { text: 'expire', voice: 'stella' });
  const again = await speech.speak('me', { text: 'expire', voice: 'stella' });
  assert.equal(again.subarray(44, 47).toString(), 'one');
  assert.equal(fetchImpl.calls.length, 1, 'served from the cache');
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, [`${speechModule.cacheName('stella', 'expire')}.wav`], 'named by the hash, never by the text');
  assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(dir, files[0])).includes(KEY));
  // Another voice is another file.
  await speech.speak('me', { text: 'expire', voice: 'tide' });
  assert.equal(fetchImpl.calls.length, 2);
  // A new service on the same folder (a restart) still has them.
  const restarted = make(t, { dir, answers: [statusResponse(500)] });
  assert.equal((await restarted.speech.speak('me', { text: 'expire' })).subarray(44, 47).toString(), 'one');
  assert.equal(restarted.fetchImpl.calls.length, 0);
});

test('the same text asked twice at once is one call to DeepSeek', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { speech, fetchImpl } = make(t, { answers: [async () => { await gate; return audioResponse('shared'); }] });
  const both = Promise.all([speech.speak('me', { text: 'Deploy tonight.' }), speech.speak('me', { text: 'Deploy  tonight.' })]);
  await new Promise(resolve => setImmediate(resolve));
  release();
  const [a, b] = await both;
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(a.subarray(44, 50).toString(), 'shared');
  assert.ok(a.equals(b));
});

test('429 and 503 are tried once more after a pause; a second refusal is "busy"', async t => {
  const waits = [];
  const busyOnce = make(t, { answers: [statusResponse(503), audioResponse('later')], wait: async ms => { waits.push(ms); } });
  assert.equal((await busyOnce.speech.speak('me', { text: 'Try again.' })).subarray(44, 49).toString(), 'later');
  assert.equal(busyOnce.fetchImpl.calls.length, 2);
  assert.deepEqual(waits, [speechModule.RETRY_MS]);
  assert.equal(speechModule.RETRY_MS, 500);
  const tooMany = make(t, { answers: [statusResponse(429)] });
  await rejectsWith(tooMany.speech.speak('me', { text: 'Try again.' }), 503, 'DeepSeek is busy, try again in a moment');
  assert.equal(tooMany.fetchImpl.calls.length, 2, 'one retry only');
});

test("DeepSeek's errors are clear messages with a status, nothing is cached, and the key and the text never reach the log", async t => {
  const cases = [
    [400, 422, 'DeepSeek could not read this text'],
    [401, 502, 'DeepSeek refused the API key of the translation service'],
    [403, 502, 'DeepSeek refused the API key of the translation service'],
    [504, 504, 'DeepSeek took too long to read this text'],
    [500, 502, 'The DeepSeek voice is not available right now'],
  ];
  for (const [from, to, message] of cases) {
    const { speech, fetchImpl, logs, dir } = make(t, { answers: [statusResponse(from)] });
    await rejectsWith(speech.speak('me', { text: 'A private sentence.' }), to, message);
    assert.equal(fetchImpl.calls.length, 1, `${from}: no retry`);
    assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, `${from}: nothing cached`);
    assert.ok(logs.every(line => !line.includes(KEY) && !line.includes('private')), JSON.stringify(logs));
  }
  // Not reachable, an answer that is not audio, a stream that breaks off after it started.
  const offline = make(t, { answers: [async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); }] });
  await rejectsWith(offline.speech.speak('me', { text: 'Hello.' }), 502, 'DeepSeek cannot be reached right now');
  assert.ok(offline.logs.every(line => !line.includes(KEY)));
  const notAudio = make(t, { answers: [{ status: 200, arrayBuffer: async () => new TextEncoder().encode('{"ok":true}').buffer }] });
  await rejectsWith(notAudio.speech.speak('me', { text: 'Hello.' }), 502);
  const cut = make(t, { answers: [{ status: 200, arrayBuffer: async () => { throw new TypeError('terminated'); } }] });
  await rejectsWith(cut.speech.speak('me', { text: 'Hello.' }), 502, 'The DeepSeek voice is not available right now');
  assert.ok(!fs.existsSync(cut.dir) || fs.readdirSync(cut.dir).length === 0, 'a cut-off answer is never cached');
});

test('a call that takes longer than the timeout is cancelled: "took too long"', async t => {
  const { speech } = make(t, {
    timeoutMs: 30,
    answers: [(url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); })],
  });
  await rejectsWith(speech.speak('me', { text: 'Slow server.' }), 504, 'DeepSeek took too long to read this text');
  assert.equal(speechModule.TIMEOUT_MS, 20_000);
});

test('the text is checked before anything is sent: 1 to 500 characters, English only, a known voice', async t => {
  const { speech, fetchImpl } = make(t);
  await rejectsWith(speech.speak('me', { text: '   ' }), 400, 'Nothing to read');
  await rejectsWith(speech.speak('me', {}), 400, 'Nothing to read');
  await rejectsWith(speech.speak('me', { text: ['a'] }), 400, 'Nothing to read');
  await rejectsWith(speech.speak('me', { text: 'a'.repeat(MAX_TEXT + 1) }), 400, `The text to read is longer than ${MAX_TEXT} characters`);
  await rejectsWith(speech.speak('me', { text: 'Fix \u767b\u5f55 now' }), 400, 'Only English text is read aloud');
  await rejectsWith(speech.speak('me', { text: 'Hello.', voice: 'alloy' }), 400, 'Unknown voice');
  assert.equal(fetchImpl.calls.length, 0);
  await speech.speak('me', { text: 'a'.repeat(MAX_TEXT) });
  assert.equal(fetchImpl.calls.length, 1, '500 characters are read');
});

test('without a DeepSeek key: 409 "Set up the DeepSeek translation service first", and the status says so (never the key)', async t => {
  const none = make(t, { key: '' });
  await rejectsWith(none.speech.speak('me', { text: 'Hello.' }), 409, NO_KEY);
  assert.equal(none.fetchImpl.calls.length, 0);
  assert.deepEqual(none.speech.status('me'), { ready: false, reason: 'no_key', voices: ['stella', 'tide'] });
  const ready = make(t);
  assert.deepEqual(ready.speech.status('me'), { ready: true, reason: null, voices: ['stella', 'tide'] });
  assert.ok(!JSON.stringify(ready.speech.status('me')).includes(KEY));
});

test('the cache keeps at most its size: the least recently played files go first', async t => {
  let n = 0;
  const { speech, dir } = make(t, { maxCacheBytes: 2500, answers: [() => audioResponse(`w${n += 1}`, 1000)] });
  await speech.speak('me', { text: 'one' });
  await speech.speak('me', { text: 'two' });
  // "one" is played again (it becomes the newest), so "two" is the oldest when "three" comes.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, `${speechModule.cacheName('stella', 'two')}.wav`), past, past);
  fs.utimesSync(path.join(dir, `${speechModule.cacheName('stella', 'one')}.wav`), past, past);
  await speech.speak('me', { text: 'one' });
  await speech.speak('me', { text: 'three' });
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, [speechModule.cacheName('stella', 'one'), speechModule.cacheName('stella', 'three')].map(name => `${name}.wav`).sort());
  assert.ok(speech.cacheStats().bytes <= 2500);
  assert.equal(speechModule.MAX_CACHE_BYTES, 50 * 1024 * 1024);
});

// ---- The routes ----
async function serve(t, { speech, sync } = {}) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { req.session = { user: { login: 'me' } }; next(); };
  app.use('/api/learn', createLearnRouter({ service: { settings: () => ({}) }, speech, sync: sync || null, requireAuth, clientOrigin: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/learn`;
}

test('GET /api/learn/speech answers audio/wav, private to the browser; errors are JSON with their status; GET /speech/status', async t => {
  const { speech, fetchImpl } = make(t, { answers: [audioResponse('route'), statusResponse(400)] });
  const base = await serve(t, { speech });
  const ok = await fetch(`${base}/speech?${new URLSearchParams({ text: 'Merge the branch.', voice: 'stella' })}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'audio/wav');
  assert.equal(ok.headers.get('cache-control'), 'private, max-age=604800');
  assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(44, 49).toString(), 'route');
  const refused = await fetch(`${base}/speech?${new URLSearchParams({ text: 'Something else.' })}`);
  assert.deepEqual([refused.status, await refused.json()], [422, { error: 'DeepSeek could not read this text' }]);
  const long = await fetch(`${base}/speech?${new URLSearchParams({ text: 'a'.repeat(501) })}`);
  assert.equal(long.status, 400);
  assert.equal(fetchImpl.calls.length, 2);
  const status = await (await fetch(`${base}/speech/status`)).json();
  assert.deepEqual(status, { ready: true, reason: null, voices: ['stella', 'tide'] });
  // Without a key the page is told what to set up.
  const noKey = await serve(t, { speech: make(t, { key: '' }).speech });
  const refusedNoKey = await fetch(`${noKey}/speech?text=Hello`);
  assert.deepEqual([refusedNoKey.status, (await refusedNoKey.json()).error], [409, NO_KEY]);
  // A test router without the voice answers 503 (no crash).
  const without = await serve(t, {});
  assert.equal((await fetch(`${without}/speech?text=Hello`)).status, 503);
});

test('a company computer asks its home and decodes the base64 audio; an answer that is not WAV is refused', async t => {
  const asked = [];
  let answer = { type: 'audio/wav', audio: wav('home').toString('base64') };
  const sync = { cacheOnly: () => true, refresh: async () => {}, status: () => ({}), askHome: async (route, options) => { asked.push({ route, options }); return answer; } };
  const base = await serve(t, { speech: null, sync });
  const response = await fetch(`${base}/speech?${new URLSearchParams({ text: ' Hello  there ', voice: 'tide' })}`);
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(44).toString(), 'home');
  assert.equal(asked[0].route, `speech?${new URLSearchParams({ text: 'Hello there', voice: 'tide' })}`);
  assert.ok(asked[0].options.timeout >= 30_000);
  answer = { audio: Buffer.from('not a wav file at all, just text that is long enough to pass the size').toString('base64') };
  assert.equal((await fetch(`${base}/speech?text=Hello`)).status, 502);
});

test('every English message of the DeepSeek voice has a Chinese translation', () => {
  const source = ['services/learn-speech.js', 'routes/learn.js'].map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
  const dictionary = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n-zh-server.js'), 'utf8');
  const messages = new Set();
  for (const match of source.matchAll(/speechError\((['`])([^'`]+)\1/g)) { let n = 0; messages.add(match[2].replace(/\$\{[^}]+\}/g, () => `{${++n}}`)); }
  for (const match of source.matchAll(/const (?:NO_KEY|SPEECH_OFFLINE) = '([^']+)'/g)) messages.add(match[1]);
  messages.add('The DeepSeek voice is not available');
  assert.ok(messages.size >= 12, [...messages].join(' | '));
  for (const message of messages) assert.ok(dictionary.includes(JSON.stringify(message)), `missing Chinese text for: ${message}`);
});
