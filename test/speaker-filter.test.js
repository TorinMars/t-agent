const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const express = require('express');
const { createSpeakerFilter, validateAudio, signedUrl } = require('../services/speaker-filter');
const { createSpeechRouter } = require('../routes/speech');
const { pcmWav, base64, createGate } = require('../public/js/speaker-filter');
const wav = seconds => base64(pcmWav(new Int16Array(Math.floor(seconds * 16000))));
const credentials = { appId: 'testapp', apiKey: 'testkey', apiSecret: 'testsecret' };
function harness() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT)');
  const calls = [];
  let score = 0.9, failure = false;
  const service = createSpeakerFilter({ db, sessionSecret: 'speaker-filter-test-secret', now: () => new Date('2026-10-27T00:00:00Z'), fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body), params = body.parameter.s1aa729d0, func = params.func;
    calls.push({ url, body });
    if (failure) throw new Error('do not expose signed URLs or testsecret');
    const result = func === 'createGroup' ? { groupId: params.groupId } : func === 'createFeature' ? { featureId: params.featureId } : func === 'searchScoreFea' ? { featureId: params.dstFeatureId, score } : { msg: 'success' };
    return { ok: true, json: async () => ({ header: { code: 0 }, payload: { [`${func}Res`]: { text: Buffer.from(JSON.stringify(result)).toString('base64') } } }) };
  } });
  return { db, service, calls, score: value => { score = value; }, fail: value => { failure = value; } };
}
async function enroll(h, owner = 'owner') { h.service.saveConfig(owner, credentials); await h.service.enroll(owner, wav(10)); h.service.saveConfig(owner, { enabled: true }); }

test('speaker credentials are encrypted and profiles are isolated by user', async () => {
  const h = harness();
  assert.equal(h.service.sessionConfig('owner'), false);
  await enroll(h);
  await enroll(h, 'other');
  const safe = JSON.stringify(h.service.getConfig('owner'));
  assert.equal(safe.includes(credentials.apiSecret), false);
  assert.equal(safe.includes(credentials.apiKey), false);
  assert.equal(h.db.prepare('SELECT value FROM system_state').all().some(row => row.value.includes(credentials.apiSecret)), false);
  const groups = h.calls.filter(call => call.body.parameter.s1aa729d0.func === 'createGroup').map(call => call.body.parameter.s1aa729d0.groupId);
  assert.notEqual(groups[0], groups[1]);
  assert.equal(h.service.getConfig('stranger').enrolled, false);
  assert.equal(h.service.saveConfig('owner', { threshold: 0.8 }).enabled, true);
  assert.throws(() => h.service.saveConfig('owner', { apiSecret: 'replacement' }), /Delete your voiceprint/);
  h.db.close();
});

test('verification accepts only the matching voice above the configured threshold', async () => {
  const h = harness(); await enroll(h);
  assert.deepEqual(await h.service.verify('owner', wav(1)), { matched: true, score: 0.9 });
  const call = h.calls.at(-1);
  assert.equal(call.body.parameter.s1aa729d0.func, 'searchScoreFea');
  assert.equal(call.body.payload.resource.sample_rate, 16000);
  h.score(0.74);
  assert.equal((await h.service.verify('owner', wav(1))).matched, false);
  h.score(0.75);
  assert.equal((await h.service.verify('owner', wav(1))).matched, true);
  h.score('0.99'); await assert.rejects(h.service.verify('owner', wav(1)), /Invalid iFlytek speaker match/);
  h.score(NaN); await assert.rejects(h.service.verify('owner', wav(1)), /Invalid iFlytek speaker match/);
  h.fail(true); await assert.rejects(h.service.verify('owner', wav(1)), error => !error.message.includes('testsecret') && /not accepted/.test(error.message));
  h.db.close();
});

test('missing profiles, unsafe settings and malformed or too-short audio never reach the vendor', async () => {
  const h = harness();
  assert.throws(() => h.service.saveConfig('owner', { ...credentials, enabled: true }), /Register your voice/);
  h.service.saveConfig('owner', credentials);
  for (const threshold of ['', null, true, -0.1, 1.1, 'bad']) assert.throws(() => h.service.saveConfig('owner', { threshold }), /threshold/);
  await assert.rejects(h.service.verify('owner', wav(1)), /not enabled/);
  for (const audio of ['invalid', wav(0.2), wav(9)]) await assert.rejects(h.service.enroll('owner', audio));
  const corrupt = Buffer.from(wav(10), 'base64'); corrupt.writeUInt32LE(8000, 24);
  assert.throws(() => validateAudio(corrupt.toString('base64'), true), /16 kHz/);
  assert.doesNotThrow(() => validateAudio(wav(60), true));
  assert.throws(() => validateAudio(wav(60.1)), /Invalid voice sample/);
  assert.equal(h.calls.length, 0);
  h.db.close();
});

test('deleting removes the cloud profile before forgetting local credentials; a failed delete can be retried', async () => {
  const h = harness(); await enroll(h);
  h.fail(true); await assert.rejects(h.service.clearConfig('owner'));
  assert.equal(h.service.getConfig('owner').enrolled, true);
  h.fail(false); await h.service.clearConfig('owner');
  assert.equal(h.calls.at(-1).body.parameter.s1aa729d0.func, 'deleteGroup');
  assert.equal(h.service.getConfig('owner').hasApiSecret, false);
  h.db.close();
});

test('failed re-enrollment keeps the previous profile and settings', async () => {
  const h = harness(); await enroll(h);
  h.fail(true); await assert.rejects(h.service.enroll('owner', wav(10)));
  assert.equal(h.service.getConfig('owner').enabled, true);
  assert.equal(h.service.getConfig('owner').enrolled, true);
  h.db.close();
});

test('signed requests use the fixed HTTPS endpoint and do not contain the API secret', () => {
  const url = new URL(signedUrl(credentials, new Date('2026-10-27T00:00:00Z')));
  assert.equal(url.origin + url.pathname, 'https://api.xf-yun.com/v1/private/s1aa729d0');
  assert.equal(url.searchParams.get('date'), 'Tue, 27 Oct 2026 00:00:00 GMT');
  const auth = Buffer.from(url.searchParams.get('authorization'), 'base64').toString();
  assert.match(auth, /algorithm="hmac-sha256"/);
  assert.equal(auth.includes(credentials.apiSecret), false);
});

test('the audio gate uses sentence timestamps and holds back text until verification completes', async () => {
  const accepted = [], rejected = [], calls = [], errors = []; let resolve;
  const gate = createGate({ verify: (audio, signal) => { calls.push({ audio, signal }); return new Promise(done => { resolve = done; }); }, onAccepted: text => accepted.push(text), onRejected: text => rejected.push(text), onError: text => errors.push(text) });
  gate.push(Int16Array.from({ length: 48000 }, (_, i) => i % 1000));
  gate.enqueue({ sentenceId: 1, beginTime: 500, endTime: 1500, text: 'mine', final: false });
  assert.equal(calls.length, 0);
  const first = { sentenceId: 1, beginTime: 500, endTime: 1500, text: 'mine', final: true };
  gate.enqueue(first); gate.enqueue(first);
  await new Promise(done => setImmediate(done));
  assert.equal(accepted.length, 0);
  const clip = Buffer.from(calls[0].audio, 'base64');
  assert.equal(clip.length, 32044); assert.equal(clip.readInt16LE(44), 8000 % 1000);
  gate.enqueue({ sentenceId: 2, beginTime: 1500, endTime: 2500, text: 'other', final: true });
  resolve({ matched: true });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(accepted, ['mine']);
  resolve({ matched: false }); await gate.finish();
  assert.equal(rejected.length, 1); assert.equal(calls.length, 2); assert.equal(errors.length, 0);
  gate.close();
});

test('cancellation, missing timestamps and verification failures never expose text', async () => {
  for (const mode of ['cancel', 'bad-time', 'error']) {
    const accepted = [], errors = []; let resolve;
    const gate = createGate({ verify: () => mode === 'error' ? Promise.reject(new Error('offline')) : new Promise(done => { resolve = done; }), onAccepted: text => accepted.push(text), onError: error => errors.push(error) });
    gate.push(new Int16Array(16000));
    gate.enqueue({ sentenceId: 1, beginTime: mode === 'bad-time' ? undefined : 0, endTime: 1000, text: 'never', final: true });
    await new Promise(done => setImmediate(done));
    if (mode === 'cancel') { gate.close(); resolve({ matched: true }); }
    await gate.finish(); assert.equal(accepted.length, 0);
    if (mode !== 'cancel') assert.equal(errors.length, 1);
    gate.close();
  }
});

test('authenticated routes enforce origin proof and advertise filtering only for enrolled users', async () => {
  const h = harness();
  const app = express();
  app.use('/api/speech', createSpeechRouter({ service: { createToken: async () => ({ token: 'temporary' }) }, speakerService: h.service, requireAuth: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/speech`, headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  try {
    assert.deepEqual(await (await fetch(`${base}/token`, { method: 'POST', headers, body: '{}' })).json(), { token: 'temporary' });
    assert.equal((await fetch(`${base}/speaker/config`, { method: 'PUT', headers, body: JSON.stringify(credentials) })).status, 200);
    assert.equal((await fetch(`${base}/speaker/enroll`, { method: 'POST', headers, body: JSON.stringify({ audio: wav(10) }) })).status, 200);
    assert.equal((await fetch(`${base}/speaker/config`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).status, 200);
    assert.equal((await fetch(`${base}/token`, { method: 'POST', headers, body: '{}' })).status, 409, 'an old page cannot silently bypass an enabled filter');
    const grant = await fetch(`${base}/token`, { method: 'POST', headers, body: JSON.stringify({ speakerFilterVersion: 1 }) });
    assert.equal((await grant.json()).speakerFilter, true); assert.equal(grant.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/speaker/verify`, { method: 'POST', headers, body: JSON.stringify({ audio: wav(1) }) })).status, 200);
    assert.equal((await fetch(`${base}/speaker/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/speaker/verify`, { method: 'POST', headers, body: JSON.stringify({ audio: 'bad' }) })).status, 400);
  } finally { server.closeAllConnections(); server.close(); h.db.close(); }
});

test('VoiceInput stop/send waits for speaker verification and never inserts rejected or cancelled text', async () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/voice-input.js'), 'utf8');
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const nodes = [], sockets = [], pending = [], errors = [];
  class Socket {
    constructor() { this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(value); } close() {}
    receive(event, sentence) { this.onmessage({ data: JSON.stringify({ header: { event }, payload: sentence ? { output: { sentence } } : {} }) }); }
  }
  class Context {
    constructor() { this.sampleRate = 16000; this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  const sandbox = {
    document: { getElementById: () => null }, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ url: 'wss://speech.example/x', token: 't', model: 'm', speakerFilter: true }) }),
    SpeakerFilter: { createGate, request: (path, options) => new Promise(resolve => { pending.push({ resolve, options }); }) },
    WebSocket: Socket, AudioContext: Context, AudioWorkletNode: class { constructor() { this.port = {}; nodes.push(this); } connect() {} disconnect() {} },
    Blob: class {}, URL: { createObjectURL: () => 'blob:x' }, Event: class {}, crypto: require('node:crypto').webcrypto,
    setTimeout, clearTimeout, notify: message => errors.push(message),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  const textarea = { value: 'before ', dispatchEvent() {}, focus() {} }, button = { addEventListener() {}, classList: { toggle() {} }, setAttribute() {} };
  const controller = sandbox.VoiceInput.attach({ textarea, button });
  await controller.start(); const socket = sockets.at(-1); socket.onopen(); socket.receive('task-started');
  nodes.at(-1).port.onmessage({ data: new Float32Array(48001) });
  socket.receive('result-generated', { sentence_id: 1, text: 'mine.', sentence_end: true, begin_time: 0, end_time: 1000 });
  socket.receive('result-generated', { sentence_id: 2, text: 'other.', sentence_end: true, begin_time: 1000, end_time: 2000 });
  await tick(); assert.equal(textarea.value, 'before ');
  let finished = false;
  const finishing = controller.finish().then(() => { finished = true; });
  socket.receive('task-finished'); await tick(); assert.equal(finished, false);
  pending[0].resolve({ matched: true }); await tick(); assert.equal(textarea.value, 'before mine.'); assert.equal(finished, false);
  pending[1].resolve({ matched: false }); await finishing;
  assert.equal(textarea.value, 'before mine.'); assert.equal(controller.state, 'idle');
  await controller.start(); const cancelled = sockets.at(-1); cancelled.onopen(); cancelled.receive('task-started');
  nodes.at(-1).port.onmessage({ data: new Float32Array(16001) });
  cancelled.receive('result-generated', { sentence_id: 1, text: 'cancelled.', sentence_end: true, begin_time: 0, end_time: 1000 });
  await tick(); controller.cancel(); pending[2].resolve({ matched: true }); await tick();
  assert.equal(textarea.value, 'before mine.');
});
