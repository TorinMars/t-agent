// Linked services share translation, voice input and OSS upload: a service without one of them configured sends the call to a linked service that has it.
// The first part runs the real services, routers and HTTP client over loopback, with fake upstream providers; the last test runs two real server.js processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { createTranslator, translationTimeoutMs, needsProvider, CHUNK_CHARS } = require('../services/translator');
const { createSpeech } = require('../services/speech');
const { createOssImages } = require('../services/oss-images');
const { createAccessToken, authenticateAccessToken, hasScope } = require('../services/engine-auth');
const { createLinkedCapabilities, CAPABILITY, CACHE_MS, RETRY_MS, TIMEOUT_MARGIN_MS } = require('../services/linked-capabilities');
const { request: realRequest } = require('../services/remote-client');
const { checkTunnelTarget } = require('../lib/service-link-tunnel');
const { createTranslateRouter } = require('../routes/translate');
const { createSpeechRouter } = require('../routes/speech');
const { createOssRouter } = require('../routes/oss');
const { createLinkedServicesRouter } = require('../routes/linked-services');
const { decryptToken } = require('../lib/token-crypto');

const SECRET = 'linked-capabilities-test-secret-'.repeat(2);
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const OWNER = 'owner';
const CHINESE = '\u4f60\u597d';
const NOT_CONFIGURED = {
  translate: [409, 'Translation service not configured yet'],
  speech: [409, 'Voice input not configured yet'],
  oss: [400, 'OSS upload is not enabled yet'],
};
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const IMAGE = { type: 'image/png', size: 2048 };
const providerAnswer = content => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' });

// One service's real translator, speech and OSS, over its own database, with a fake upstream each.
function makeSide(t, { upstream } = {}) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  t.after(() => db.close());
  const side = {
    db, upstreamCalls: 0,
    answer: upstream || (() => providerAnswer('from-upstream')),
  };
  const fetchImpl = async (url, options) => { side.upstreamCalls += 1; return side.answer(url, options); };
  side.translator = createTranslator({ db, sessionSecret: SECRET, fetchImpl });
  side.speech = createSpeech({ db, sessionSecret: SECRET, env: {}, fetchImpl: async () => { side.upstreamCalls += 1; return side.speechAnswer ? side.speechAnswer() : { ok: true, status: 200, json: async () => ({ token: 'st-from-upstream' }) }; } });
  side.oss = createOssImages({ db, sessionSecret: SECRET, createClient: () => ({ signatureUrlV4: async () => { throw new Error('no signed read in this test'); } }) });
  side.configureAll = () => {
    side.translator.saveConfig(OWNER, { provider: 'deepseek', apiKey: 'sk-translate-secret', enabled: true });
    side.speech.saveConfig(OWNER, { apiKey: 'sk-speech-secret', enabled: true });
    side.oss.saveConfig(OWNER, { enabled: true, region: 'oss-cn-hangzhou', bucket: 'linked-test-bucket', accessKeyId: 'ak-id-value', accessKeySecret: 'ak-secret-value', publicBaseUrl: 'https://cdn.example.test' });
  };
  return side;
}

const listen = async (t, app) => {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
};

// The serving side: the real router and real token checks, on `side`'s database. `linkTokens` maps a token id to its link.
async function servePeer(t, side, { capabilities = [CAPABILITY] } = {}) {
  const linkTokens = new Map();
  const requireEngineAuth = scope => (req, res, next) => {
    const match = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'ENGINE_TOKEN_REQUIRED' });
    const token = authenticateAccessToken(side.db, match[1]);
    if (!token) return res.status(401).json({ error: 'ENGINE_TOKEN_INVALID' });
    if (!hasScope(token.scopes, scope)) return res.status(403).json({ error: 'ENGINE_SCOPE_REQUIRED' });
    req.engineAuth = { tokenId: token.id, principalId: token.principal_id };
    next();
  };
  const app = express();
  const peer = { info: { capabilities }, linkTokens };
  app.get('/v1/info', (req, res) => res.json(peer.info));
  app.use('/v1/linked-services', createLinkedServicesRouter({
    translator: side.translator, speech: side.speech, oss: side.oss, requireEngineAuth, owner: () => OWNER,
    serviceLinks: { linkForToken: id => linkTokens.get(Number(id)) || null },
  }));
  peer.baseUrl = await listen(t, app);
  const issued = createAccessToken(side.db, { name: 'Service link: caller', principalId: 'some-other-principal' });
  linkTokens.set(issued.id, { id: 'link-from-caller', revoked: false });
  peer.token = issued.token;
  peer.tokenId = issued.id;
  peer.call = async (method, route, body, token = issued.token, rawBody) => {
    const response = await fetch(`${peer.baseUrl}/v1/linked-services${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* kept as text */ }
    return { status: response.status, body: parsed, text };
  };
  return peer;
}

const link = (id, name, peer, overrides = {}) => ({ id, name, online: true, remoteServerId: 1, baseUrl: peer.baseUrl, token: peer.token, ...overrides });

// The calling side: linked-capabilities over a fake list of links, and the real browser routers.
async function makeCaller(t, side, peers, { request = realRequest } = {}) {
  const listeners = [];
  const clock = { now: 1_000_000 };
  const noted = [];
  const serviceLinks = { peers: () => peers.slice(), onChange: fn => listeners.push(fn), noteUnauthorized: id => noted.push(id) };
  const requests = [];
  const linked = createLinkedCapabilities({
    serviceLinks, now: () => clock.now,
    request: (base, route, token, options) => { requests.push({ base, route, token, options }); return request(base, route, token, options); },
  });
  const requireAuth = (req, res, next) => { req.session = { user: { login: OWNER } }; next(); };
  const app = express();
  app.use('/api/translate', createTranslateRouter({ service: side.translator, linked, requireAuth }));
  app.use('/api/speech', createSpeechRouter({ service: side.speech, linked, requireAuth }));
  app.use('/api/oss', createOssRouter({ service: side.oss, linked, requireAuth }));
  const base = await listen(t, app);
  const call = async (method, route, body) => {
    const response = await fetch(`${base}/api${route}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* kept as text */ }
    return { status: response.status, body: parsed, text };
  };
  return { linked, call, requests, clock, noted, change: id => listeners.forEach(fn => fn(id)) };
}

const FEATURE_CALLS = [
  ['translate', '/translate', { text: CHINESE }, body => assert.deepEqual(body, { text: 'from-upstream', translated: true })],
  ['translate', '/translate/word', { word: 'river', context: 'the river' }, body => assert.equal(body.meaning, 'river-meaning')],
  ['speech', '/speech/token', {}, body => assert.equal(body.token, 'st-from-upstream')],
  ['oss', '/oss/upload-policy', IMAGE, body => assert.match(body.url, /^https:\/\/cdn\.example\.test\//)],
];

// The word route and the plain translation both come out of the one fake upstream.
function wordFriendly(side) {
  side.answer = (url, options) => {
    const body = JSON.parse(options.body);
    return /dictionary/.test(body.messages[0].content)
      ? providerAnswer(JSON.stringify({ base: 'river', phonetic: '', pos: 'n.', meaning: 'river-meaning' }))
      : providerAnswer('from-upstream');
  };
}

test('the four calls go to a linked service when this one is not configured, and the answer comes back as it is', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  wordFriendly(provider);
  const peer = await servePeer(t, provider);
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer)]);
  for (const [feature, route, body, check] of FEATURE_CALLS) {
    const answer = await caller.call('POST', route, body);
    assert.equal(answer.status, 200, `${route}: ${answer.text}`);
    check(answer.body);
    assert.ok(caller.requests.some(call => call.route === `/v1/linked-services${route}` && call.token === peer.token), `${feature} went through the link`);
  }
});

test('a configured local service answers everything itself and no peer is asked', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  const local = makeSide(t);
  local.configureAll();
  wordFriendly(local);
  const caller = await makeCaller(t, local, [link('l1', 'peer-one', peer)]);
  for (const [, route, body, check] of FEATURE_CALLS) {
    const answer = await caller.call('POST', route, body);
    assert.equal(answer.status, 200, answer.text);
    check(answer.body);
  }
  assert.equal(caller.requests.length, 0, 'not even an availability probe');
  assert.equal(provider.upstreamCalls, 0);
  for (const feature of ['/translate', '/speech', '/oss']) assert.equal((await caller.call('GET', `${feature}/config`)).body.shared_from, null);
});

test('a real failure of a configured local service stays local, with today\'s status and message', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  const local = makeSide(t, { upstream: () => { throw new Error('network down'); } });
  local.configureAll();
  local.speechAnswer = () => ({ ok: false, status: 500, json: async () => ({}) });
  local.oss.saveConfig(OWNER, { enabled: true, region: 'oss-cn-hangzhou', bucket: 'linked-test-bucket', accessKeyId: 'ak-id-value', accessKeySecret: 'ak-secret-value' }); // no public address: the fake client throws
  const caller = await makeCaller(t, local, [link('l1', 'peer-one', peer)]);
  const translated = await caller.call('POST', '/translate', { text: CHINESE });
  assert.equal(translated.status, 502);
  assert.equal(translated.body.error, 'Cannot reach the translation service; check the network and endpoint address');
  const speech = await caller.call('POST', '/speech/token', {});
  assert.equal(speech.status, 502);
  assert.match(speech.body.error, /speech recognition service returned an error/);
  const oss = await caller.call('POST', '/oss/upload-policy', IMAGE);
  assert.equal(oss.status, 502);
  assert.equal(oss.body.error, 'Could not prepare the OSS upload; check the configuration');
  assert.equal(caller.requests.length, 0);
  assert.equal(provider.upstreamCalls, 0);
});

test('with no provider the error is today\'s, unchanged', async t => {
  for (const peers of [[], null]) {
    const unconfiguredPeer = await servePeer(t, makeSide(t));
    const caller = await makeCaller(t, makeSide(t), peers || [link('l1', 'nothing-here', unconfiguredPeer)]);
    for (const [feature, route, body] of [['translate', '/translate', { text: CHINESE }], ['translate', '/translate/word', { word: 'river' }], ['speech', '/speech/token', {}], ['oss', '/oss/upload-policy', IMAGE]]) {
      const answer = await caller.call('POST', route, body);
      assert.equal(answer.status, NOT_CONFIGURED[feature][0], route);
      assert.deepEqual(answer.body, { error: NOT_CONFIGURED[feature][1] });
    }
    assert.equal((await caller.call('GET', '/translate/config')).body.shared_from, null);
  }
});

test('English text is answered here without a provider, even when the linked service is away', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer, { baseUrl: 'http://127.0.0.1:1' })], { request: async () => { throw new Error('ECONNREFUSED'); } });
  const answer = await caller.call('POST', '/translate', { text: 'already english' });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { text: 'already english', translated: false });
  assert.equal(needsProvider('already english'), false);
  assert.equal(needsProvider(CHINESE), true);
  assert.equal(caller.requests.length, 0);
});

test('a provider that went offline gives LINKED_PROVIDER_OFFLINE with its name, and the page sees it offline', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  const entry = link('l1', 'peer-one', peer);
  const caller = await makeCaller(t, makeSide(t), [entry]);
  await caller.call('POST', '/translate', { text: CHINESE });
  assert.deepEqual((await caller.call('GET', '/translate/config')).body.shared_from, { name: 'peer-one', online: true });
  entry.online = false;
  for (const [route, body] of [['/translate', { text: CHINESE }], ['/translate/word', { word: 'river' }], ['/speech/token', {}], ['/oss/upload-policy', IMAGE]]) {
    const answer = await caller.call('POST', route, body);
    assert.equal(answer.status, 502, route);
    assert.deepEqual(answer.body, { error: 'LINKED_PROVIDER_OFFLINE', provider: 'peer-one' });
  }
  assert.deepEqual((await caller.call('GET', '/translate/config')).body.shared_from, { name: 'peer-one', online: false });
  assert.deepEqual((await caller.call('GET', '/oss/config')).body.shared_from, { name: 'peer-one', online: false });
});

test('a connection failure during the call is LINKED_PROVIDER_OFFLINE, and so is a token or route answer from the link', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  let failWith = null;
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer)], {
    request: async (base, route, token, options) => {
      if (route.endsWith('/translate') && failWith) throw failWith;
      return realRequest(base, route, token, options);
    },
  });
  const offline = { error: 'LINKED_PROVIDER_OFFLINE', provider: 'peer-one' };
  for (const error of [new Error('ECONNREFUSED'), new Error('REMOTE_TIMEOUT'), new Error('REMOTE_OFFLINE'),
    Object.assign(new Error('REMOTE_HTTP_404'), { statusCode: 404 }),
    Object.assign(new Error('LINKED_ONLY'), { statusCode: 403, peerError: 'LINKED_ONLY' }),
    Object.assign(new Error('ENGINE_TOKEN_INVALID'), { statusCode: 401, peerError: 'ENGINE_TOKEN_INVALID' }),
    Object.assign(new Error('REMOTE_HTTP_502'), { statusCode: 502 })]) {
    failWith = error;
    const answer = await caller.call('POST', '/translate', { text: CHINESE });
    assert.equal(answer.status, 502, error.message);
    assert.deepEqual(answer.body, offline);
  }
  assert.equal(caller.noted.length, 1, 'only the 401 says the link is revoked');
});

test('the peer\'s own errors pass through with their words and status', async t => {
  const provider = makeSide(t, { upstream: () => ({ ok: false, status: 402, text: async () => '', json: async () => ({}) }) });
  provider.configureAll();
  provider.speechAnswer = () => ({ ok: false, status: 429, json: async () => ({}) });
  const peer = await servePeer(t, provider);
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer)]);
  const translated = await caller.call('POST', '/translate', { text: CHINESE });
  assert.equal(translated.status, 502);
  assert.deepEqual(translated.body, { error: 'The DeepSeek account balance is insufficient' });
  const speech = await caller.call('POST', '/speech/token', {});
  assert.equal(speech.status, 502);
  assert.deepEqual(speech.body, { error: 'Speech recognition rate limit reached; please retry later' });
  const oss = await caller.call('POST', '/oss/upload-policy', { type: 'text/plain', size: 10 });
  assert.equal(oss.status, 415);
  assert.deepEqual(oss.body, { error: 'Only PNG, JPEG, GIF and WebP images are supported' });
  provider.translator.clearConfig(OWNER);
  const stale = await caller.call('POST', '/translate', { text: CHINESE });
  assert.equal(stale.status, 409, 'the cache is a minute behind and the peer says so itself');
  assert.deepEqual(stale.body, { error: NOT_CONFIGURED.translate[1] });
});

test('the oldest online link that has the feature is used', async t => {
  const hasIt = makeSide(t);
  hasIt.configureAll();
  const lacksIt = makeSide(t);
  const peerA = await servePeer(t, lacksIt);
  const peerB = await servePeer(t, hasIt);
  const peerC = await servePeer(t, (() => { const side = makeSide(t); side.configureAll(); return side; })());
  const peers = [link('oldest', 'lacks', peerA), link('middle', 'has-1', peerB), link('newest', 'has-2', peerC)];
  const caller = await makeCaller(t, makeSide(t), peers);
  assert.equal((await caller.linked.providerFor('translate')).name, 'has-1');
  peers[1].online = false;
  assert.equal((await caller.linked.providerFor('translate')).name, 'has-2', 'an offline link is passed over');
  peers[0].online = false;
  peers[2].online = false;
  assert.equal(await caller.linked.providerFor('translate'), null);
});

test('a peer without the capability is never used, and availability is not even asked', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider, { capabilities: ['tasks:read'] });
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'older', peer)]);
  assert.equal(await caller.linked.providerFor('translate'), null);
  assert.deepEqual(caller.requests.map(call => call.route), ['/v1/info']);
  assert.equal(provider.upstreamCalls, 0);
});

test('availability is cached for a minute and dropped when the link changes', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer)]);
  const probes = () => caller.requests.filter(call => /availability$/.test(call.route)).length;
  await caller.linked.providerFor('translate');
  await caller.linked.providerFor('speech');
  assert.equal(probes(), 1);
  caller.clock.now += CACHE_MS - 1;
  await caller.linked.providerFor('oss');
  assert.equal(probes(), 1, 'still inside the minute');
  caller.clock.now += 2;
  await caller.linked.providerFor('oss');
  assert.equal(probes(), 2, 'asked again after the minute');
  caller.change('l1');
  await new Promise(resolve => setImmediate(resolve));
  await caller.linked.providerFor('oss');
  assert.equal(probes(), 3, 'a change of the link drops the cache');
});

test('a peer that did not answer is retried sooner, and its last answer is kept', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  let failing = false;
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer)], {
    request: async (base, route, token, options) => {
      if (failing && /info$/.test(route)) throw new Error('ECONNREFUSED');
      return realRequest(base, route, token, options);
    },
  });
  await caller.linked.providerFor('translate');
  failing = true;
  caller.clock.now += CACHE_MS;
  assert.equal((await caller.linked.providerFor('translate')).name, 'peer-one', 'the last answer stands');
  const asked = caller.requests.length;
  await caller.linked.providerFor('translate');
  assert.equal(caller.requests.length, asked, 'no second probe inside the retry time');
  caller.clock.now += RETRY_MS;
  await caller.linked.providerFor('translate');
  assert.equal(caller.requests.length, asked + 1, 'asked again after the retry time');
});

test('a result that arrives after the link changed is dropped', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  const held = [];
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer)], {
    request: async (base, route, token, options) => {
      if (/availability$/.test(route) && held.length === 0) {
        await new Promise(resolve => held.push(resolve));
        return { translate: false, speech: false, oss: false };
      }
      return realRequest(base, route, token, options);
    },
  });
  const first = caller.linked.providerFor('translate');
  await new Promise(resolve => setTimeout(resolve, 30));
  caller.change('l1');
  await new Promise(resolve => setTimeout(resolve, 30));
  held[0]();
  await first;
  assert.equal((await caller.linked.providerFor('translate')).name, 'peer-one', 'the late "no" did not overwrite the newer answer');
});

test('GET config never waits for a slow peer, and the answer is there on the next read', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer)], {
    request: async (base, route, token, options) => { await gate; return realRequest(base, route, token, options); },
  });
  assert.equal((await caller.call('GET', '/translate/config')).body.shared_from, null, 'answered while the probe hangs');
  release();
  let shared = null;
  for (let attempt = 0; attempt < 100 && !shared; attempt += 1) {
    shared = (await caller.call('GET', '/translate/config')).body.shared_from;
    if (!shared) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(shared, { name: 'peer-one', online: true });
});

test('shared_from has only a name and a state: no key, token or address', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer)]);
  await caller.linked.providerFor('translate');
  for (const route of ['/translate/config', '/speech/config', '/oss/config']) {
    const { body, text } = await caller.call('GET', route);
    assert.deepEqual(Object.keys(body.shared_from).sort(), ['name', 'online']);
    for (const secret of [peer.token, peer.baseUrl, '127.0.0.1', 'sk-translate-secret', 'sk-speech-secret', 'ak-secret-value', 'tae_']) {
      assert.equal(text.includes(secret), false, `${route} shows ${secret}`);
    }
  }
});

test('the timeouts cover what the peer may take, and a long translation gets more', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  wordFriendly(provider);
  const peer = await servePeer(t, provider);
  const caller = await makeCaller(t, makeSide(t), [link('l1', 'peer-one', peer)]);
  const timeoutOf = async (route, body) => {
    await caller.call('POST', route, body);
    return caller.requests.find(call => call.route === `/v1/linked-services${route}`).options;
  };
  assert.equal((await timeoutOf('/translate/word', { word: 'river' })).timeoutMs, 30_000 + TIMEOUT_MARGIN_MS);
  assert.equal((await timeoutOf('/speech/token', {})).timeoutMs, 10_000 + TIMEOUT_MARGIN_MS);
  assert.equal((await timeoutOf('/oss/upload-policy', IMAGE)).timeoutMs, 10_000);
  const long = Array.from({ length: 6 }, () => CHINESE.repeat(Math.floor(CHUNK_CHARS / 2) - 1)).join('\n');
  const options = await timeoutOf('/translate', { text: long });
  assert.equal(options.timeoutMs, translationTimeoutMs(long) + TIMEOUT_MARGIN_MS);
  assert.ok(options.timeoutMs >= 6 * 30_000, `six pieces, ${options.timeoutMs} ms`);
  assert.ok(options.maxBytes >= 6 * 1024 * 1024);
});

test('/v1/linked-services refuses every token that is not a live link token', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  const routes = [['GET', '/availability'], ['POST', '/translate', { text: CHINESE }], ['POST', '/translate/word', { word: 'river' }], ['POST', '/speech/token', {}], ['POST', '/oss/upload-policy', IMAGE]];
  const admin = createAccessToken(provider.db, { name: 'admin', principalId: 'engine' });
  for (const [method, route, body] of routes) {
    const none = await peer.call(method, route, body, null);
    assert.equal(none.status, 401, route);
    const normal = await peer.call(method, route, body, admin.token);
    assert.equal(normal.status, 403, `${route}: an admin Engine token is not a link`);
    assert.deepEqual(normal.body, { error: 'LINKED_ONLY' });
  }
  assert.equal(provider.upstreamCalls, 0, 'nothing was spent');

  assert.equal((await peer.call('GET', '/availability')).status, 200, 'the link token works');
  peer.linkTokens.get(peer.tokenId).revoked = true;
  assert.deepEqual((await peer.call('GET', '/availability')).body, { error: 'LINKED_ONLY' }, 'a revoked link');
  peer.linkTokens.delete(peer.tokenId);
  assert.deepEqual((await peer.call('GET', '/availability')).body, { error: 'LINKED_ONLY' }, 'a removed link');
  provider.db.prepare('UPDATE engine_access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(peer.tokenId);
  assert.equal((await peer.call('GET', '/availability')).status, 401, 'and removal revokes the token as well');
});

test('availability reports local configuration only, and never chains', async t => {
  const empty = makeSide(t);
  const peer = await servePeer(t, empty);
  assert.deepEqual((await peer.call('GET', '/availability')).body, { translate: false, speech: false, oss: false });
  for (const [feature, route, body] of [['translate', '/translate', { text: CHINESE }], ['translate', '/translate/word', { word: 'river' }], ['speech', '/speech/token', {}], ['oss', '/oss/upload-policy', IMAGE]]) {
    const answer = await peer.call('POST', route, body);
    assert.equal(answer.status, NOT_CONFIGURED[feature][0], route);
    assert.deepEqual(answer.body, { error: NOT_CONFIGURED[feature][1] }, 'not configured, and not forwarded to anyone');
  }
  const full = makeSide(t);
  full.configureAll();
  assert.deepEqual((await (await servePeer(t, full)).call('GET', '/availability')).body, { translate: true, speech: true, oss: true });
  const disabled = makeSide(t);
  disabled.configureAll();
  disabled.translator.saveConfig(OWNER, { provider: 'deepseek', enabled: false });
  assert.equal((await (await servePeer(t, disabled)).call('GET', '/availability')).body.translate, false, 'a switched-off translator is not offered');
});

test('the body limits of the /api routes apply to /v1/linked-services', async t => {
  const provider = makeSide(t);
  provider.configureAll();
  const peer = await servePeer(t, provider);
  const padded = size => JSON.stringify({ text: CHINESE, type: 'image/png', size: 1, padding: 'x'.repeat(size) });
  const tooLarge = await peer.call('POST', '/translate', undefined, peer.token, padded(1024 * 1024 + 10));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.body, { error: 'The content is too large' });
  const word = await peer.call('POST', '/translate/word', undefined, peer.token, padded(1024 * 1024 + 10));
  assert.equal(word.status, 413);
  const speech = await peer.call('POST', '/speech/token', undefined, peer.token, padded(17 * 1024));
  assert.equal(speech.status, 413);
  const policy = await peer.call('POST', '/oss/upload-policy', undefined, peer.token, padded(5 * 1024));
  assert.equal(policy.status, 400);
  assert.deepEqual(policy.body, { error: 'Invalid upload request' });
  assert.equal(provider.upstreamCalls, 0);
  assert.equal((await peer.call('POST', '/translate', { text: CHINESE.repeat(40_000) })).status, 200, 'the longest text the translator accepts fits');
});

test('the paths are allowed through the tunnel and the join route stays out', () => {
  for (const route of ['availability', 'translate', 'translate/word', 'speech/token', 'oss/upload-policy']) assert.equal(checkTunnelTarget(`/v1/linked-services/${route}`), `/v1/linked-services/${route}`);
  assert.throws(() => checkTunnelTarget('/v1/service-links/join'), /TUNNEL_PATH_FORBIDDEN/);
});

// ---- Two real services ----
const PRELOAD = path.join(__dirname, 'fixtures', 'linked-fake-upstream.js');

async function startService(t, tag) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-linked-'));
  const child = spawn(process.execPath, ['-r', PRELOAD, 'server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DASHSCOPE_API_KEY: '', FAKE_UPSTREAM_TAG: tag, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: SECRET, T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start: ${output}`)), 20000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', code => reject(new Error(`exited ${code}: ${output}`)));
  });
  const stop = () => (child.exitCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); }));
  const service = {
    url: `http://127.0.0.1:${port}`,
    output: () => output,
    async call(method, route, body, headers = HEADERS, rawBody) {
      const response = await fetch(`${service.url}${route}`, { method, headers, body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)) });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed, text };
    },
    tokenHeld() {
      const database = new Database(path.join(temp, 'db.sqlite'), { readonly: true });
      try { return decryptToken(database.prepare('SELECT token_cipher FROM remote_servers').get().token_cipher, SECRET); }
      finally { database.close(); }
    },
  };
  t.after(async () => { await stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  return service;
}

async function until(check, label) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function linkServices(a, b) {
  const made = await a.call('POST', '/api/service-links/code', {});
  assert.equal(made.status, 201);
  const joined = await b.call('POST', '/api/service-links/join', { url: a.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, joined.text);
  const linkOf = async side => (await side.call('GET', '/api/service-links')).body.links.find(entry => entry.id === joined.body.id);
  await until(async () => (await linkOf(a))?.online && (await linkOf(b))?.online, 'both sides online');
  return { id: joined.body.id, linkOf };
}

const bearer = token => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
const translatorKey = { provider: 'deepseek', apiKey: 'sk-only-on-one-side', baseUrl: 'https://fake-llm.test', model: 'fake-model', enabled: true };

test('two real services: translation through the link in both directions, and the gates of /v1/linked-services', async t => {
  const a = await startService(t, 'A');
  const b = await startService(t, 'B');
  for (const side of [a, b]) assert.deepEqual((await side.call('POST', '/api/translate', { text: CHINESE })).body, { error: NOT_CONFIGURED.translate[1] }, 'not linked yet');
  assert.equal((await a.call('PUT', '/api/translate/config', translatorKey)).status, 200);

  // The joiner calls the initiator directly.
  const first = await linkServices(a, b);
  const nameOfA = (await first.linkOf(b)).name;
  const shared = await until(async () => (await b.call('GET', '/api/translate/config')).body.shared_from, 'B learns that A provides translation');
  assert.deepEqual(shared, { name: nameOfA, online: true });
  assert.equal((await a.call('GET', '/api/translate/config')).body.shared_from, null, 'A has its own');
  assert.deepEqual((await b.call('POST', '/api/translate', { text: CHINESE })).body, { text: 'translated-by-A', translated: true });
  assert.deepEqual((await a.call('POST', '/api/translate', { text: CHINESE })).body, { text: 'translated-by-A', translated: true }, 'local stays local');
  assert.equal((await b.call('GET', '/api/speech/config')).body.shared_from, null, 'nobody provides voice input');
  const page = (await b.call('GET', '/api/translate/config')).text;
  assert.equal(/sk-only|tae_|127\.0\.0\.1/.test(page), false);

  // The token A gave to B, and the gates, on the real app (with its parsers, access gate and login gate).
  const linkToken = b.tokenHeld();
  const asLink = bearer(linkToken);
  assert.ok((await a.call('GET', '/v1/info', undefined, asLink)).body.capabilities.includes('linked-services'));
  assert.deepEqual((await a.call('GET', '/v1/linked-services/availability', undefined, asLink)).body, { translate: true, speech: false, oss: false });
  const admin = (await a.call('POST', '/api/remote-tokens', { name: 'admin' })).body.token;
  assert.deepEqual((await a.call('POST', '/v1/linked-services/translate', { text: CHINESE }, bearer(admin))).body, { error: 'LINKED_ONLY' });
  assert.equal((await a.call('POST', '/v1/linked-services/translate', { text: CHINESE }, bearer(admin))).status, 403);
  const minted = await a.call('POST', '/v1/tokens', { name: 'minted through the link' }, asLink);
  assert.equal(minted.status, 201, minted.text);
  assert.deepEqual((await a.call('GET', '/v1/linked-services/availability', undefined, bearer(minted.body.token))).body, { error: 'LINKED_ONLY' }, 'a token the peer made for itself is not a link token');
  assert.equal((await a.call('POST', '/v1/linked-services/translate', { text: CHINESE }, { 'Content-Type': 'application/json' })).status, 401);

  // The limits hold in the real app, where a body parser for the whole app runs first for every other route.
  const padded = size => JSON.stringify({ text: CHINESE, padding: 'x'.repeat(size) });
  const big = await a.call('POST', '/v1/linked-services/translate', undefined, asLink, padded(1024 * 1024 + 10));
  assert.equal(big.status, 413, big.text);
  assert.equal((await a.call('POST', '/v1/linked-services/speech/token', undefined, asLink, padded(17 * 1024))).status, 413);
  assert.deepEqual((await a.call('POST', '/v1/linked-services/oss/upload-policy', undefined, asLink, padded(5 * 1024))).body, { error: 'Invalid upload request' });

  // B has no configuration, so asking B through its own link answers "not configured", although B could reach A.
  const backToB = bearer(a.tokenHeld());
  const chained = await b.call('POST', '/v1/linked-services/translate', { text: CHINESE }, backToB);
  assert.equal(chained.status, 409, chained.text);
  assert.deepEqual(chained.body, { error: NOT_CONFIGURED.translate[1] });

  // Removed: the token is revoked, and the feature is gone.
  assert.equal((await b.call('DELETE', `/api/service-links/${first.id}`)).status, 204);
  await until(async () => (await a.call('GET', '/api/service-links')).body.links.length === 0, 'A heard the unlink');
  assert.equal((await a.call('GET', '/v1/linked-services/availability', undefined, asLink)).status, 401);
  assert.deepEqual((await b.call('POST', '/api/translate', { text: CHINESE })).body, { error: NOT_CONFIGURED.translate[1] });

  // The other way round: the initiator reaches the joiner through the tunnel.
  assert.equal((await a.call('DELETE', '/api/translate/config')).status, 200);
  assert.equal((await b.call('PUT', '/api/translate/config', translatorKey)).status, 200);
  await linkServices(a, b);
  await until(async () => (await a.call('GET', '/api/translate/config')).body.shared_from, 'A learns that B provides translation');
  assert.deepEqual((await a.call('POST', '/api/translate', { text: CHINESE })).body, { text: 'translated-by-B', translated: true });
  const word = await a.call('POST', '/api/translate/word', { word: 'river' });
  assert.equal(word.status, 502, 'the fake upstream gives a plain line, so the word answer cannot be read; the error is the peer\'s');
  assert.deepEqual(word.body, { error: 'The translation service gave an answer that could not be read' });
  for (const side of [a, b]) assert.equal(/sk-only|translated-by/.test(side.output()), false, 'no key or translated text in the log');
});
