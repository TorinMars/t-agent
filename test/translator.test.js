// Backend of the terminal's Chinese-to-English input: configuration is stored encrypted, the key is not sent back, English does not call the endpoint, DeepSeek errors become readable messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { createTranslator, splitForTranslation, MAX_INPUT_CHARS, CHUNK_CHARS } = require('../services/translator');
const { createTranslateRouter } = require('../routes/translate');

const SECRET = 'translator-test-secret-translator-test-secret';
const makeDb = () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return db;
};
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function setup(responder) {
  const calls = [];
  const db = makeDb();
  const service = createTranslator({ db, sessionSecret: SECRET, fetchImpl: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return responder(calls.length); } });
  return { db, service, calls };
}

test('The API key is encrypted when saving the configuration, and reading the configuration does not return the key', () => {
  const { db, service } = setup(() => reply(200, {}));
  const saved = service.saveConfig('owner', { apiKey: 'sk-secret-123', model: 'deepseek-flash' });
  assert.equal(saved.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes('sk-secret-123'), false);
  assert.equal(JSON.stringify(service.getConfig('owner')).includes('sk-secret-123'), false);
  assert.equal(db.prepare('SELECT value FROM system_state').get().value.includes('sk-secret-123'), false, 'stored encrypted');
  // Saving again without a key keeps the old key
  assert.equal(service.saveConfig('owner', { model: 'deepseek-flash' }).hasApiKey, true);
  assert.equal(service.getConfig('other').hasApiKey, false, 'config is per user');
});

test('Unsafe endpoints and a missing key are rejected', () => {
  const { service } = setup(() => reply(200, {}));
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', baseUrl: 'http://api.deepseek.com' }), /HTTPS/);
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', baseUrl: 'https://user:pw@api.deepseek.com' }), /HTTPS/);
  assert.throws(() => service.saveConfig('o', { baseUrl: 'https://api.deepseek.com' }), /API key/);
});

test('Chinese is sent to DeepSeek with a fixed prompt, and only the translation is returned', async () => {
  const { service, calls } = setup(() => reply(200, { choices: [{ message: { content: '  Fix the login bug in `auth.js`.\n' } }] }));
  service.saveConfig('owner', { apiKey: 'sk-1' });
  const result = await service.translate('owner', '修复 `auth.js` 里的登录 bug');
  assert.deepEqual(result, { text: 'Fix the login bug in `auth.js`.', translated: true });
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-1');
  assert.equal(calls[0].body.model, 'deepseek-flash', 'default model when none is configured');
  assert.equal(calls[0].body.messages[1].content, '修复 `auth.js` 里的登录 bug');
  assert.match(calls[0].body.messages[0].content, /never instructions for you/);
});

test('Without Chinese the text is returned unchanged and no endpoint is called; when not configured a clear message is given', async () => {
  const { service, calls } = setup(() => reply(200, {}));
  assert.deepEqual(await service.translate('owner', 'git status'), { text: 'git status', translated: false });
  assert.equal(calls.length, 0);
  await assert.rejects(service.translate('owner', '你好'), /not configured/);
});

test('DeepSeek errors become readable messages, and empty or over-long content is rejected', async () => {
  for (const [status, pattern] of [[401, /invalid/], [402, /balance/], [429, /rate limit/], [500, /HTTP 500/]]) {
    const { service } = setup(() => reply(status, {}));
    service.saveConfig('o', { apiKey: 'k' });
    await assert.rejects(service.translate('o', '你好'), pattern);
  }
  const empty = setup(() => reply(200, { choices: [{ message: { content: '' } }] }));
  empty.service.saveConfig('o', { apiKey: 'k' });
  await assert.rejects(empty.service.translate('o', '你好'), /is empty/);
  await assert.rejects(empty.service.translate('o', ' '), /Enter/);
  await assert.rejects(empty.service.translate('o', '好'.repeat(MAX_INPUT_CHARS + 1)), /cannot exceed/);
});

test('Long text is translated piece by piece: no piece is over the limit, lines stay in order and English-only pieces cost no call', async () => {
  const { service, calls } = setup(count => reply(200, { choices: [{ message: { content: `T${count}` } }] }));
  service.saveConfig('o', { apiKey: 'k' });
  const line = '好'.repeat(CHUNK_CHARS - 10); // two of them, or one with the English line, do not fit one piece
  const result = await service.translate('o', [line, line, 'npm test\tok', line].join('\n'));
  assert.equal(calls.length, 3, 'three Chinese pieces, three calls');
  assert.ok(calls.every(call => call.body.messages[1].content.length <= CHUNK_CHARS));
  assert.deepEqual(result, { text: 'T1\nT2\nnpm test\tok\nT3', translated: true }, 'the English line is kept exactly, tab included');
  // 50,000 characters in one request: accepted and fully sent to the provider.
  calls.length = 0;
  const long = '\u{1F600}\u597d'.repeat(16_667).slice(0, 50_000);
  await service.translate('o', long);
  assert.equal(calls.map(call => call.body.messages[1].content).join(''), long, 'every character reaches the provider, no surrogate pair is cut');
});

test('Line breaks are kept: the prompt asks for them, and an answer on one line is translated again line by line', async () => {
  // The model joins a three-line message into one line; then each Chinese line is asked again on its own and the lines come back in order.
  const answers = { '背景：登录失败': 'Background: login fails', '日志如下': 'The log is below', '修复目标：不再写入标记': 'Fix goal: no longer write the flag' };
  const { service, calls } = setup(count => {
    const content = calls[count - 1].body.messages[1].content;
    return reply(200, { choices: [{ message: { content: answers[content] || 'Background: login fails. ID 42. The log is below. Fix goal: no longer write the flag.' } }] });
  });
  service.saveConfig('o', { apiKey: 'k' });
  const source = '背景：登录失败\n\nuser_id=42 ERROR timeout\n  日志如下\n\n修复目标：不再写入标记';
  const result = await service.translate('o', source);
  assert.match(calls[0].body.messages[0].content, /same number of lines/);
  assert.equal(calls[0].body.messages[1].content, source, 'first the whole piece in one call');
  assert.equal(calls.length, 4, 'one call for the piece, then one per Chinese line');
  assert.equal(result.text, 'Background: login fails\n\nuser_id=42 ERROR timeout\n  The log is below\n\nFix goal: no longer write the flag', 'same lines, blank lines, indentation and English line kept');
  assert.equal(result.text.split('\n').length, source.split('\n').length);
});

test('Line breaks are kept: an answer with the same lines is used as it is, in one call, and English lines are kept exactly', async () => {
  const { service, calls } = setup(() => reply(200, { choices: [{ message: { content: 'First line\n\nchanged english\nThird line' } }] }));
  service.saveConfig('o', { apiKey: 'k' });
  const result = await service.translate('o', '\n第一行\n\nnpm test -- --grep "a  b"\n第三行');
  assert.equal(calls.length, 1);
  assert.equal(result.text, 'First line\n\nnpm test -- --grep "a  b"\nThird line', 'the line without Chinese is the original, not the model\'s copy');
  // A blank line moved to another place also counts as changed lines.
  const moved = setup(count => reply(200, { choices: [{ message: { content: count === 1 ? 'A\nB\n\nC' : `L${count}` } }] }));
  moved.service.saveConfig('o', { apiKey: 'k' });
  assert.equal((await moved.service.translate('o', '甲\n\n乙\n丙')).text, 'L2\n\nL3\nL4');
});

test('Line breaks are kept across pieces: long text stays in order, line for line', async () => {
  // The model always answers on one line: a piece of many lines is asked again line by line, and a one-line request gets `Line <number>`.
  const { service, calls } = setup(count => {
    const content = calls[count - 1].body.messages[1].content;
    return reply(200, { choices: [{ message: { content: content.includes('\n') ? 'all on one line' : `Line ${content.split(' ')[0]}` } }] });
  });
  service.saveConfig('o', { apiKey: 'k' });
  const source = Array.from({ length: 20 }, (_, index) => `${index} ${'好'.repeat(500)}`).join('\n'); // about 10,000 characters: three pieces
  assert.ok(splitForTranslation(source).length >= 3);
  const result = await service.translate('o', source);
  assert.ok(calls.every(call => call.body.messages[1].content.length <= CHUNK_CHARS));
  assert.equal(result.text, Array.from({ length: 20 }, (_, index) => `Line ${index}`).join('\n'), 'twenty lines in, twenty lines out, in order');
});

test('splitForTranslation keeps every character and cuts long lines at a sentence end', () => {
  const text = `${'a'.repeat(30)}. ${'b'.repeat(30)}\n\nshort\n${'c'.repeat(100)}`;
  const parts = splitForTranslation(text, 40);
  assert.ok(parts.every(part => part.text.length <= 40));
  assert.equal(parts[0].text, `${'a'.repeat(30)}.`, 'cut after the full stop');
  assert.equal(parts.map((part, index) => (index ? part.joint : '') + part.text).join('').replace(/ /g, ''), text.replace(/ /g, ''), 'nothing is lost');
  assert.deepEqual(splitForTranslation('one\ntwo', 40), [{ text: 'one\ntwo', joint: '\n' }], 'short text stays one piece');
});

test('HTTP routes: reading and writing config and translating, with no key in the responses', async () => {
  const { service } = setup(() => reply(200, { choices: [{ message: { content: 'Hello' } }] }));
  const app = express(); // no app-wide body parser: the router's own limit is the one tested
  app.use('/api/translate', createTranslateRouter({ service, requireAuth: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/translate`;
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  try {
    const put = await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: 'sk-http' }) });
    assert.equal(put.status, 200);
    assert.equal((await put.text()).includes('sk-http'), false);
    const translated = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ text: '你好' }) });
    assert.deepEqual(await translated.json(), { text: 'Hello', translated: true });
    const long = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ text: '\u4f60\u597d'.repeat(50_000) }) });
    assert.equal(long.status, 200, 'a 100,000-character body is accepted');
    const bad = await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: 'k', baseUrl: 'http://x.com' }) });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/config`, { method: 'PUT', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 403, 'needs same-origin proof');
  } finally { server.close(); }
});

test('Multiple providers: switching to GLM does not lose the key saved for DeepSeek, and GLM uses its own address and key', async () => {
  const { service, calls } = setup(() => reply(200, { choices: [{ message: { content: 'Hi' } }] }));
  service.saveConfig('o', { provider: 'deepseek', apiKey: 'sk-deepseek' });
  const glm = service.saveConfig('o', { provider: 'glm', apiKey: 'glm-key' });
  assert.equal(glm.provider, 'glm');
  assert.equal(glm.providers.deepseek.hasApiKey, true, 'DeepSeek key kept');
  assert.equal(glm.providers.glm.hasApiKey, true);
  assert.equal(JSON.stringify(glm).includes('glm-key'), false);
  await service.translate('o', '你好');
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer glm-key');
  assert.equal(calls[0].body.model, 'glm-5.3-flash');
  assert.equal(calls[0].body.reasoning_effort, 'low', 'glm-5.3 always thinks and cannot turn it off (thinking:disabled gives 400), so low-effort reasoning is used');
  assert.equal('thinking' in calls[0].body, false);
  // Switch back to DeepSeek: no key given, the previously saved one is kept
  assert.equal(service.saveConfig('o', { provider: 'deepseek' }).provider, 'deepseek');
  await service.translate('o', '你好');
  assert.equal(calls[1].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer sk-deepseek');
  // Switching to a provider that has no saved key must error, without affecting the existing configuration
  const fresh = setup(() => reply(200, {}));
  fresh.service.saveConfig('o', { provider: 'deepseek', apiKey: 'k' });
  assert.throws(() => fresh.service.saveConfig('o', { provider: 'glm' }), /Zhipu GLM API key/);
  assert.equal(fresh.service.getConfig('o').provider, 'deepseek');
  assert.throws(() => fresh.service.saveConfig('o', { provider: 'nope', apiKey: 'k' }), /Unsupported/);
});

test('The error reason returned by the provider (such as GLM 1113 insufficient balance) is reported as-is instead of a generic status-code message', async () => {
  const { service } = setup(() => reply(429, { error: { code: '1113', message: 'Insufficient balance or no available resource package,Please top up.' } }));
  service.saveConfig('o', { provider: 'glm', apiKey: 'k' });
  await assert.rejects(service.translate('o', '你好'), /Zhipu GLM returned an error: Insufficient balance or no available resource package,Please top up\. \(HTTP 429, error code 1113\)/);
});

test('When the error body is not the standard error.message shape, a snippet of the raw response is reported', async () => {
  const flat = setup(() => reply(400, { code: '1210', msg: 'Invalid parameters' }));
  flat.service.saveConfig('o', { provider: 'glm', apiKey: 'k' });
  await assert.rejects(flat.service.translate('o', '你好'), /Invalid parameters \(HTTP 400, error code 1210\)/);
  const plain = setup(() => reply(400, 'Bad Request: temperature out of range'));
  plain.service.saveConfig('o', { provider: 'glm', apiKey: 'k' });
  await assert.rejects(plain.service.translate('o', '你好'), /Zhipu GLM returned an error \(HTTP 400\): Bad Request: temperature out of range/);
});

test('GLM-4.5 to 5.2 turn deep thinking off, and error messages carry the provider name', async () => {
  const { service, calls } = setup(status => (status === 1 ? reply(200, { choices: [{ message: { content: 'Hi' } }] }) : reply(401, {})));
  service.saveConfig('o', { provider: 'glm', apiKey: 'k', model: 'glm-4.5-air' });
  await service.translate('o', '你好');
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  await assert.rejects(service.translate('o', '你好'), /Zhipu GLM API key is invalid/);
});

test('An old flat DeepSeek configuration is migrated automatically, and the saved key is not lost', async () => {
  const { db, service, calls } = setup(() => reply(200, { choices: [{ message: { content: 'Hi' } }] }));
  const { encryptToken } = require('../lib/token-crypto');
  db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('translator:o', encryptToken(JSON.stringify({ enabled: true, apiKey: 'sk-old', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }), SECRET));
  const config = service.getConfig('o');
  assert.equal(config.provider, 'deepseek');
  assert.equal(config.providers.deepseek.hasApiKey, true);
  assert.equal(config.providers.deepseek.model, 'deepseek-chat');
  await service.translate('o', '你好');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-old');
  assert.equal(service.saveConfig('o', { provider: 'glm', apiKey: 'g' }).providers.deepseek.hasApiKey, true);
});

test('A key that was entered but cannot be used gets its own message, and a saved key is not checked again on re-save', () => {
  const { db, service } = setup(() => reply(200, {}));
  assert.throws(() => service.saveConfig('o', { provider: 'glm', apiKey: 'fake inner-space' }), /The Zhipu GLM API key contains invalid characters such as line breaks/);
  assert.throws(() => service.saveConfig('o', { apiKey: 'k'.repeat(513) }), /The DeepSeek API key is too long \(at most 512 characters\)/);
  assert.equal(service.saveConfig('o', { apiKey: '  sk-fake+/=_~!  ' }).hasApiKey, true, 'surrounding white space is trimmed, punctuation is kept');
  assert.equal(service.providerConfig('o', 'deepseek').apiKey, 'sk-fake+/=_~!');
  // An old row may hold a key the check would refuse today: changing only the model must still work.
  const { encryptToken } = require('../lib/token-crypto');
  db.prepare('UPDATE system_state SET value = ?').run(encryptToken(JSON.stringify({ enabled: true, apiKey: 'old key-fake' }), SECRET));
  assert.equal(service.saveConfig('o', { model: 'deepseek-chat' }).model, 'deepseek-chat');
  assert.equal(service.providerConfig('o', 'deepseek').apiKey, 'old key-fake');
});

for (const [provider, label, url] of [['deepseek', 'DeepSeek', 'https://api.deepseek.com/chat/completions'], ['glm', 'Zhipu GLM', 'https://open.bigmodel.cn/api/paas/v4/chat/completions']]) {
  test(`${label}: newlines, CRLF and tabs around a key are removed, and requests send the cleaned key`, async () => {
    for (const raw of ['fake-key-123\n', 'fake-key-123\r\n', '\nfake-key-123', ' \t\r\nfake-key-123\r\n\t ']) {
      const { db, service, calls } = setup(() => reply(200, { choices: [{ message: { content: 'Hi' } }] }));
      assert.equal(service.saveConfig('o', { provider, apiKey: raw }).providers[provider].hasApiKey, true, JSON.stringify(raw));
      assert.equal(service.providerConfig('o', provider).apiKey, 'fake-key-123', 'stored cleaned');
      assert.equal(db.prepare('SELECT value FROM system_state').get().value.includes('fake-key-123'), false, 'still encrypted');
      await service.translate('o', '你好');
      assert.equal(calls[0].url, url);
      assert.equal(calls[0].options.headers.Authorization, 'Bearer fake-key-123');
      assert.doesNotThrow(() => new Headers(calls[0].options.headers), 'a valid header value');
    }
  });

  test(`${label}: a control character or space inside the key gets its own message and keeps the saved key`, () => {
    const { service } = setup(() => reply(200, {}));
    service.saveConfig('o', { provider, apiKey: 'fake-saved' });
    for (const bad of ['fake\nkey', 'fake\r\nkey', 'fake\tkey', 'fake key', 'fake\u0000key', 'fake\u007fkey']) {
      assert.throws(() => service.saveConfig('o', { provider, apiKey: bad }), error => error.statusCode === 400 && error.message === `The ${label} API key contains invalid characters such as line breaks`, JSON.stringify(bad));
    }
    assert.equal(service.providerConfig('o', provider).apiKey, 'fake-saved', 'a refused key changes nothing');
  });

  test(`${label}: white space only keeps the saved key, and asks for a key when none is saved`, () => {
    for (const blank of ['', '   ', '\n', '\r\n', ' \t\r\n ']) {
      const { service } = setup(() => reply(200, {}));
      assert.throws(() => service.saveConfig('o', { provider, apiKey: blank }), new RegExp(`Enter the ${label} API key`), JSON.stringify(blank));
      service.saveConfig('o', { provider, apiKey: 'fake-saved' });
      assert.equal(service.saveConfig('o', { provider, apiKey: blank }).providers[provider].hasApiKey, true);
      assert.equal(service.providerConfig('o', provider).apiKey, 'fake-saved', JSON.stringify(blank));
    }
  });
}

test('The key checks over HTTP: CRLF around the key saves, a line break inside it is a 400 with the accurate message', async () => {
  const { service } = setup(() => reply(200, {}));
  const app = express();
  app.use('/api/translate', createTranslateRouter({ service, requireAuth: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/translate/config`;
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  const put = apiKey => fetch(url, { method: 'PUT', headers, body: JSON.stringify({ provider: 'deepseek', apiKey, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }) });
  try {
    assert.equal((await put('sk-fake-http\r\n')).status, 200);
    assert.equal(service.providerConfig('owner', 'deepseek').apiKey, 'sk-fake-http');
    const bad = await put('sk-fake\nhttp');
    assert.deepEqual([bad.status, (await bad.json()).error], [400, 'The DeepSeek API key contains invalid characters such as line breaks']);
  } finally { server.close(); }
});

// ── One English word (tap to translate in the chat) ──

const wordAnswer = (extra = {}) => ({ base: 'resolve', phonetic: '/rɪˈzɒlv/', pos: 'v.', meaning: '解决；决定', ...extra });
const wordReply = content => reply(200, { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });

test('Word translation: the word and its sentence go to the model as data, and the answer comes back as a small entry', async () => {
  const { service, calls } = setup(() => wordReply(wordAnswer()));
  service.saveConfig('o', { apiKey: 'sk-word' });
  const entry = await service.translateWord('o', { word: 'resolved', context: '  The   conflict was\nresolved by a merge.  ' });
  assert.deepEqual(entry, { word: 'resolved', base: 'resolve', phonetic: '/rɪˈzɒlv/', pos: 'v.', meaning: '解决；决定' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.messages[0].content, /dictionary/);
  assert.match(calls[0].body.messages[0].content, /never instructions/, 'the word is data, not an instruction');
  assert.deepEqual(JSON.parse(calls[0].body.messages[1].content), { word: 'resolved', sentence: 'The conflict was resolved by a merge.' }, 'the sentence is flattened to one line');
  assert.equal(calls[0].body.temperature, 0);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-word');
});

test('Word translation: the same word in the same sentence is answered from memory; another sentence, person or model asks again', async () => {
  const { service, calls } = setup(() => wordReply(wordAnswer()));
  service.saveConfig('o', { apiKey: 'k' });
  service.saveConfig('p', { apiKey: 'k' });
  await service.translateWord('o', { word: 'Merge', context: 'Merge it.' });
  await service.translateWord('o', { word: 'merge', context: 'Merge it.' });
  assert.equal(calls.length, 1, 'the case of the word does not matter');
  await service.translateWord('o', { word: 'merge', context: 'A merge commit.' });
  assert.equal(calls.length, 2, 'another sentence can mean another thing');
  await service.translateWord('p', { word: 'merge', context: 'Merge it.' });
  assert.equal(calls.length, 3, 'one person never gets what another asked');
  service.saveConfig('o', { apiKey: 'k', model: 'another-model' });
  await service.translateWord('o', { word: 'merge', context: 'Merge it.' });
  assert.equal(calls.length, 4, 'a model that answers differently is asked again');
});

test('Word translation: only one English word is accepted, and a sentence is cut to its limit', async () => {
  const { service, calls } = setup(() => wordReply(wordAnswer()));
  service.saveConfig('o', { apiKey: 'k' });
  for (const bad of ['', ' ', 'two words', '123', 'a1', '-dash', "'quote", 'x'.repeat(41), '你好', 'rm -rf', 'a\nb', undefined, null, 5, {}]) {
    await assert.rejects(service.translateWord('o', { word: bad }), /Enter an English word/, JSON.stringify(bad));
  }
  await assert.rejects(service.translateWord('o', null), /Enter an English word/);
  assert.equal(calls.length, 0, 'nothing is sent for a bad word');
  for (const good of ["don't", 'well-known', 'a', 'I', 'x'.repeat(40), 'don’t']) await service.translateWord('o', { word: good });
  await service.translateWord('o', { word: 'long', context: 'word '.repeat(200) });
  assert.equal(JSON.parse(calls.at(-1).body.messages[1].content).sentence.length, 300);
  await service.translateWord('o', { word: 'odd', context: 42 });
  assert.equal(JSON.parse(calls.at(-1).body.messages[1].content).sentence, '', 'a sentence that is not text is ignored');
});

test('Word translation: an answer is read from a line of JSON even when the model wraps it, and an unreadable one is an error, not a guess', async () => {
  const answers = ['```json\n{"base":"run","phonetic":"/rʌn/","pos":"v.","meaning":"运行"}\n```', 'Here you go: {"base":"run","meaning":"运行"} hope it helps', '{"meaning":"  运行 \\n 跑  "}'];
  let n = 0;
  const { service } = setup(() => wordReply(answers[n++]));
  service.saveConfig('o', { apiKey: 'k' });
  assert.deepEqual(await service.translateWord('o', { word: 'run', context: 'one' }), { word: 'run', base: 'run', phonetic: '/rʌn/', pos: 'v.', meaning: '运行' });
  assert.deepEqual(await service.translateWord('o', { word: 'run', context: 'two' }), { word: 'run', base: 'run', phonetic: '', pos: '', meaning: '运行' });
  assert.equal((await service.translateWord('o', { word: 'run', context: 'three' })).meaning, '运行 跑', 'white space is flattened');
  for (const unreadable of ['not json at all', '{"base":"run"}', '{"meaning":""}', '{"meaning":5}', '[1,2]', '{"meaning": "x"']) {
    const { service: bad } = setup(() => wordReply(unreadable));
    bad.saveConfig('o', { apiKey: 'k' });
    await assert.rejects(bad.translateWord('o', { word: 'run' }), /could not be read/, unreadable);
  }
});

test('Word translation: without a configured service, and when the service fails, the person is told why', async () => {
  const { service, calls } = setup(() => reply(401, {}));
  await assert.rejects(service.translateWord('o', { word: 'run' }), error => error.statusCode === 409 && /not configured/.test(error.message));
  assert.equal(calls.length, 0);
  service.saveConfig('o', { apiKey: 'k' });
  await assert.rejects(service.translateWord('o', { word: 'run' }), error => error.statusCode === 502 && /API key is invalid/.test(error.message));
  const failing = setup(() => { throw new Error('network down'); });
  failing.service.saveConfig('o', { apiKey: 'k' });
  await assert.rejects(failing.service.translateWord('o', { word: 'run' }), /Cannot reach the translation service/);
  // A failed word is not remembered: asking again asks the service again.
  let healthy = false;
  const flaky = setup(() => (healthy ? wordReply(wordAnswer()) : reply(429, {})));
  flaky.service.saveConfig('o', { apiKey: 'k' });
  await assert.rejects(flaky.service.translateWord('o', { word: 'run' }), /rate limit/);
  healthy = true;
  assert.equal((await flaky.service.translateWord('o', { word: 'run' })).meaning, '解决；决定');
});

test('Word translation: the HTTP route needs the same-origin proof and returns the entry, or the error with its status', async () => {
  const { service } = setup(() => wordReply(wordAnswer()));
  const app = express();
  app.use(express.json());
  app.use('/api/translate', createTranslateRouter({ service, requireAuth: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/translate`;
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  try {
    const before = await fetch(`${base}/word`, { method: 'POST', headers, body: JSON.stringify({ word: 'resolve' }) });
    assert.equal(before.status, 409, 'not configured yet');
    assert.equal((await before.json()).error, 'Translation service not configured yet');
    await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: 'sk-route' }) });
    const ok = await fetch(`${base}/word`, { method: 'POST', headers, body: JSON.stringify({ word: 'resolve', context: 'resolve it' }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { word: 'resolve', base: 'resolve', phonetic: '/rɪˈzɒlv/', pos: 'v.', meaning: '解决；决定' });
    const bad = await fetch(`${base}/word`, { method: 'POST', headers, body: JSON.stringify({ word: 'two words' }) });
    assert.deepEqual([bad.status, (await bad.json()).error], [400, 'Enter an English word']);
    assert.equal((await fetch(`${base}/word`, { method: 'POST', body: '{"word":"run"}', headers: { 'Content-Type': 'application/json' } })).status, 403, 'needs same-origin proof');
  } finally { server.close(); }
});
