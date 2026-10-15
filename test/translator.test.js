// Backend of the terminal's Chinese-to-English input: configuration is stored encrypted, the key is not sent back, English does not call the endpoint, DeepSeek errors become readable messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { createTranslator } = require('../services/translator');
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
  await assert.rejects(empty.service.translate('o', '好'.repeat(4001)), /cannot exceed/);
});

test('HTTP routes: reading and writing config and translating, with no key in the responses', async () => {
  const { service } = setup(() => reply(200, { choices: [{ message: { content: 'Hello' } }] }));
  const app = express();
  app.use(express.json());
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
