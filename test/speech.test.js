// Voice input: the server only stores the configuration and mints a short-lived token (no audio passes through it); the browser module resamples the microphone and talks the Alibaba real-time protocol itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { createSpeech } = require('../services/speech');
const { createSpeechRouter } = require('../routes/speech');
const VoiceInput = require('../public/js/voice-input');

const SECRET = 'speech-test-secret-speech-test-secret';
const makeDb = () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return db;
};
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function setup(responder = () => reply(200, { token: 'st-temp', expires_at: 1 }), env = {}) {
  const calls = [];
  const db = makeDb();
  const service = createSpeech({ db, sessionSecret: SECRET, env, fetchImpl: async (url, options) => { calls.push({ url, options }); return responder(calls.length); } });
  return { db, service, calls };
}

test('The API key is encrypted when saving, and reading the configuration does not return it', () => {
  const { db, service } = setup();
  const saved = service.saveConfig('owner', { apiKey: 'sk-secret-123' });
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.keySource, 'saved');
  assert.equal(JSON.stringify(saved).includes('sk-secret-123'), false);
  assert.equal(JSON.stringify(service.getConfig('owner')).includes('sk-secret-123'), false);
  assert.equal(db.prepare('SELECT value FROM system_state').get().value.includes('sk-secret-123'), false, 'stored encrypted');
  assert.equal(service.saveConfig('owner', { region: 'singapore' }).hasApiKey, true, 'an empty key keeps the saved key');
  assert.equal(service.getConfig('other').hasApiKey, false, 'config is per user');
  assert.equal(service.clearConfig('owner').hasApiKey, false);
});

test('The configuration echoes the address that is really in effect, and a blank endpoint keeps the region default', () => {
  const { service } = setup();
  const beijing = service.saveConfig('o', { apiKey: 'k' });
  assert.equal(beijing.region, 'beijing');
  assert.equal(beijing.endpoint, '');
  assert.equal(beijing.effectiveEndpoint, 'wss://dashscope.aliyuncs.com/api-ws/v1/inference');
  const singapore = service.saveConfig('o', { region: 'singapore' });
  assert.equal(singapore.effectiveEndpoint, 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference');
  const custom = service.saveConfig('o', { endpoint: 'wss://ws-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference/' });
  assert.equal(custom.endpoint, 'wss://ws-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference');
  assert.equal(service.saveConfig('o', { endpoint: '' }).effectiveEndpoint, singapore.effectiveEndpoint, 'clearing the endpoint restores the default');
});

test('Unsafe endpoints, unknown regions and a missing key are rejected', () => {
  const { service } = setup();
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', endpoint: 'ws://x.com/a' }), /wss/);
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', endpoint: 'wss://u:p@x.com/a' }), /wss/);
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', endpoint: 'wss://x.com/a?k=1' }), /wss/);
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', region: 'mars' }), /region/);
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', language: 'xx' }), /language/);
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', model: 'bad model!' }), /model/);
  assert.throws(() => service.saveConfig('o', {}), /API key/);
});

test('The token comes from the region endpoint with the real key, and only the token is returned to the browser', async () => {
  const { service, calls } = setup();
  service.saveConfig('o', { apiKey: 'sk-real', region: 'singapore', language: 'en' });
  const grant = await service.createToken('o');
  assert.deepEqual(grant, { url: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference', token: 'st-temp', model: 'fun-asr-realtime', language: 'en' });
  assert.equal(JSON.stringify(grant).includes('sk-real'), false);
  assert.equal(calls[0].url, 'https://dashscope-intl.aliyuncs.com/api/v1/tokens?expire_in_seconds=60');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-real');
});

test('DASHSCOPE_API_KEY from the environment is used until a key is saved, and a saved key overrides it', async () => {
  const { service, calls } = setup(undefined, { DASHSCOPE_API_KEY: 'sk-env' });
  assert.equal(service.getConfig('o').keySource, 'environment');
  assert.equal(service.getConfig('o').hasApiKey, false);
  await service.createToken('o');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-env');
  service.saveConfig('o', { apiKey: 'sk-saved' });
  await service.createToken('o');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer sk-saved');
});

test('Without any key the token request says it is not configured and Alibaba is not called', async () => {
  const { service, calls } = setup();
  await assert.rejects(service.createToken('o'), error => error.statusCode === 409 && /not configured/.test(error.message));
  assert.equal(calls.length, 0);
});

test('Token errors become readable messages', async () => {
  for (const [status, pattern] of [[401, /invalid or lacks permission/], [403, /invalid or lacks permission/], [429, /rate limit/], [500, /HTTP 500/]]) {
    const { service } = setup(() => reply(status, {}));
    service.saveConfig('o', { apiKey: 'k' });
    await assert.rejects(service.createToken('o'), pattern);
  }
  const empty = setup(() => reply(200, {}));
  empty.service.saveConfig('o', { apiKey: 'k' });
  await assert.rejects(empty.service.createToken('o'), /no token/);
  const down = setup(() => { throw new Error('ECONNREFUSED'); });
  down.service.saveConfig('o', { apiKey: 'k' });
  await assert.rejects(down.service.createToken('o'), /Cannot reach/);
});

test('HTTP routes: config and token, with no real key in any response', async () => {
  const { service } = setup();
  const app = express();
  app.use('/api/speech', createSpeechRouter({ service, requireAuth: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/speech`;
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  try {
    const put = await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: 'sk-http' }) });
    assert.equal(put.status, 200);
    assert.equal((await put.text()).includes('sk-http'), false);
    const token = await fetch(`${base}/token`, { method: 'POST', headers, body: '{}' });
    assert.equal(token.status, 200);
    assert.equal(token.headers.get('cache-control'), 'no-store');
    const body = await token.json();
    assert.equal(body.token, 'st-temp');
    assert.equal(JSON.stringify(body).includes('sk-http'), false);
    assert.equal((await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: 'k', endpoint: 'http://x.com' }) })).status, 400);
    assert.equal((await fetch(`${base}/token`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 403, 'needs same-origin proof');
    await fetch(`${base}/config`, { method: 'DELETE', headers });
    assert.equal((await fetch(`${base}/token`, { method: 'POST', headers, body: '{}' })).status, 409, 'not configured after deleting');
  } finally { server.close(); }
});

// ── Browser module ──

test('The resampler turns 48 kHz float audio into 16 kHz 16-bit samples, also when the audio arrives in small blocks', () => {
  const tone = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 20));
  const whole = VoiceInput.createResampler(48000).push(tone);
  assert.ok(Math.abs(whole.length - 1600) <= 1, `got ${whole.length} samples`);
  const resampler = VoiceInput.createResampler(48000);
  const parts = [];
  for (let i = 0; i < tone.length; i += 128) parts.push(...resampler.push(tone.subarray(i, i + 128)));
  assert.ok(Math.abs(parts.length - whole.length) <= 1, 'blocks give the same amount of audio');
  assert.deepEqual(parts.slice(0, 100), [...whole.slice(0, 100)], 'and the same samples');
  const loud = VoiceInput.createResampler(16000).push(Float32Array.from([2, -2, 2, -2]));
  assert.deepEqual([...loud], [32767, -32768, 32767], 'values are clipped to 16 bits');
});

test('compose keeps the text that was in the box before recording', () => {
  assert.equal(VoiceInput.compose('Fix ', 'the test. ', 'then run'), 'Fix the test. then run');
});

class FakeSocket {
  constructor(url) { this.url = url; this.sent = []; FakeSocket.last = this; }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
  receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
}
const header = (event, extra = {}) => ({ header: { event, task_id: 't', ...extra }, payload: {} });

function recognizer(overrides = {}) {
  const log = { ready: 0, results: [], done: 0, errors: [] };
  const instance = VoiceInput.createRecognizer({
    url: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', token: 'st-a b', model: 'fun-asr-realtime', language: 'zh', WebSocketImpl: FakeSocket, ...overrides,
    callbacks: { onReady: () => { log.ready += 1; }, onResult: r => log.results.push(r), onDone: () => { log.done += 1; }, onError: m => log.errors.push(m) },
  });
  return { instance, log, socket: FakeSocket.last };
}

test('The browser connects with the token in the URL, starts the task, buffers audio until task-started, then finishes cleanly', () => {
  const { instance, log, socket } = recognizer();
  assert.equal(socket.url, 'wss://dashscope.aliyuncs.com/api-ws/v1/inference?api_key=st-a%20b');
  instance.sendAudio(new ArrayBuffer(3200)); // before the connection is open
  socket.onopen();
  const run = JSON.parse(socket.sent[0]);
  assert.equal(run.header.action, 'run-task');
  assert.equal(run.header.streaming, 'duplex');
  assert.equal(run.payload.model, 'fun-asr-realtime');
  assert.deepEqual(run.payload.parameters, { format: 'pcm', sample_rate: 16000, language_hints: ['zh'] });
  assert.equal(socket.sent.length, 1, 'no audio before task-started');
  socket.receive(header('task-started'));
  assert.equal(log.ready, 1);
  assert.equal(socket.sent.length, 2, 'buffered audio is flushed');
  instance.sendAudio(new ArrayBuffer(3200));
  assert.equal(socket.sent.length, 3);
  socket.receive({ ...header('result-generated'), payload: { output: { sentence: { text: 'Hello', sentence_id: 1, sentence_end: false } } } });
  socket.receive({ ...header('result-generated'), payload: { output: { sentence: { text: '', sentence_id: 0, heartbeat: true, sentence_end: false } } } });
  socket.receive({ ...header('result-generated'), payload: { output: { sentence: { text: 'Hello.', sentence_id: 1, sentence_end: true } } } });
  assert.deepEqual(log.results, [{ text: 'Hello', sentenceId: 1, final: false }, { text: 'Hello.', sentenceId: 1, final: true }], 'heartbeats are ignored');
  instance.finish();
  const finish = JSON.parse(socket.sent.at(-1));
  assert.equal(finish.header.action, 'finish-task');
  assert.equal(finish.header.task_id, run.header.task_id, 'the same task id');
  socket.receive(header('task-finished'));
  assert.equal(log.done, 1);
  assert.equal(socket.closed, true);
  assert.deepEqual(log.errors, []);
});

test('Finishing before task-started waits for it, then sends finish-task after the buffered audio', () => {
  const { instance, socket } = recognizer({ language: '' });
  socket.onopen();
  assert.equal(JSON.parse(socket.sent[0]).payload.parameters.language_hints, undefined, 'auto detect sends no language hint');
  instance.sendAudio(new ArrayBuffer(100));
  instance.finish();
  assert.equal(socket.sent.length, 1);
  socket.receive(header('task-started'));
  assert.equal(socket.sent[1].byteLength, 100);
  assert.equal(JSON.parse(socket.sent[2]).header.action, 'finish-task');
});

test('A failed task and a dropped connection are reported once', () => {
  const failed = recognizer();
  failed.socket.onopen();
  failed.socket.receive(header('task-failed', { error_code: 'CLIENT_ERROR', error_message: 'request timeout after 23 seconds.' }));
  failed.socket.onclose();
  assert.deepEqual(failed.log.errors, ['Speech recognition failed: request timeout after 23 seconds.']);
  const refused = recognizer();
  refused.socket.onerror();
  refused.socket.onclose();
  assert.equal(refused.log.errors.length, 1);
  assert.match(refused.log.errors[0], /Cannot reach/);
  const closed = recognizer();
  closed.instance.close();
  closed.socket.onclose();
  assert.deepEqual(closed.log.errors, [], 'closing it yourself is not an error');
});

test('Recording starts on a page that has no API helper or Modal (the phone page does not load app.js)', async () => {
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/voice-input.js'), 'utf8');
  const notices = [];
  const fetches = [];
  const handlers = {};
  const classes = new Set();
  const button = { addEventListener: (type, fn) => { handlers[type] = fn; }, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) }, setAttribute() {} };
  const textarea = { value: '', dispatchEvent() {}, focus() {} };
  const elements = { 'h5-translate-input': textarea, 'h5-voice': button };
  class FakeContext {
    constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  const sandbox = {
    document: { getElementById: id => elements[id] || null },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    fetch: async (url, options) => { fetches.push({ url, options }); return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'wss://speech.example/api-ws/v1/inference', token: 'st-1', model: 'fun-asr-realtime', language: 'zh' }) }; },
    WebSocket: FakeSocket,
    AudioWorkletNode: class { constructor() { this.port = {}; } connect() {} disconnect() {} },
    Blob: class {}, URL: { createObjectURL: () => 'blob:x' }, Event: class {},
    crypto: require('crypto').webcrypto, console, setTimeout, clearTimeout,
    notify: (message, type) => notices.push([message, type]),
  };
  sandbox.window = sandbox;
  sandbox.AudioContext = FakeContext;
  vm.runInNewContext(source, sandbox);
  assert.equal(typeof handlers.pointerdown, 'function', 'the phone microphone button is wired for hold to speak');
  handlers.pointerdown({ button: 0, pointerId: 1 });
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notices, [], 'no error notice');
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, '/api/speech/token');
  assert.equal(fetches[0].options.method, 'POST');
  assert.equal(fetches[0].options.headers['X-Requested-With'], 'XMLHttpRequest', 'same-origin proof for the server');
  const socket = FakeSocket.last;
  assert.equal(socket.url, 'wss://speech.example/api-ws/v1/inference?api_key=st-1');
  socket.onopen();
  socket.receive(header('task-started'));
  assert.equal(classes.has('listening'), true);
  await new Promise(resolve => setTimeout(resolve, 400)); // a real long press
  handlers.pointerup(); // release stops the recognition
  assert.equal(JSON.parse(socket.sent.at(-1)).header.action, 'finish-task');
  socket.receive({ ...header('result-generated'), payload: { output: { sentence: { text: 'done.', sentence_id: 1, sentence_end: true } } } });
  socket.receive(header('task-finished'));
  assert.equal(textarea.value, 'done.');
  assert.equal(classes.has('listening'), false);
});

test('Phone microphone: a tap shorter than a long press is discarded, and keyboard activation still toggles', async () => {
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/voice-input.js'), 'utf8');
  const handlers = {};
  const classes = new Set();
  const button = { addEventListener: (type, fn) => { handlers[type] = fn; }, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) }, setAttribute() {} };
  const textarea = { value: '', dispatchEvent() {}, focus() {} };
  const elements = { 'h5-translate-input': textarea, 'h5-voice': button };
  class FakeContext {
    constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  const sandbox = {
    document: { getElementById: id => elements[id] || null },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ url: 'wss://speech.example/x', token: 't', model: 'm', language: 'zh' }) }),
    WebSocket: FakeSocket,
    AudioWorkletNode: class { constructor() { this.port = {}; } connect() {} disconnect() {} },
    Blob: class {}, URL: { createObjectURL: () => 'blob:x' }, Event: class {},
    crypto: require('crypto').webcrypto, console, setTimeout, clearTimeout,
    notify() {},
  };
  sandbox.window = sandbox;
  sandbox.AudioContext = FakeContext;
  vm.runInNewContext(source, sandbox);
  handlers.pointerdown({ button: 0, pointerId: 1 });
  assert.equal(classes.has('listening'), true, 'pressing starts at once');
  handlers.pointerup(); // released right away
  assert.equal(classes.has('listening'), false, 'a short tap cancels');
  handlers.click({ detail: 1 }); // the click that follows a pointer press is ignored
  assert.equal(classes.has('listening'), false);
  handlers.click({ detail: 0 }); // keyboard
  assert.equal(classes.has('listening'), true);
  handlers.click({ detail: 0 });
  assert.equal(classes.has('listening'), false);
});
