// 终端中译英输入框的翻译后端：配置加密保存、不回传密钥、英文不调用接口、DeepSeek 错误转成中文提示。
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
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function setup(responder) {
  const calls = [];
  const db = makeDb();
  const service = createTranslator({ db, sessionSecret: SECRET, fetchImpl: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return responder(calls.length); } });
  return { db, service, calls };
}

test('保存配置时加密 API Key，读取配置不返回密钥', () => {
  const { db, service } = setup(() => reply(200, {}));
  const saved = service.saveConfig('owner', { apiKey: 'sk-secret-123', model: 'deepseek-chat' });
  assert.equal(saved.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes('sk-secret-123'), false);
  assert.equal(JSON.stringify(service.getConfig('owner')).includes('sk-secret-123'), false);
  assert.equal(db.prepare('SELECT value FROM system_state').get().value.includes('sk-secret-123'), false, 'stored encrypted');
  // 再次保存不填密钥则沿用旧密钥
  assert.equal(service.saveConfig('owner', { model: 'deepseek-chat' }).hasApiKey, true);
  assert.equal(service.getConfig('other').hasApiKey, false, 'config is per user');
});

test('拒绝不安全的接口地址和缺少密钥', () => {
  const { service } = setup(() => reply(200, {}));
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', baseUrl: 'http://api.deepseek.com' }), /HTTPS/);
  assert.throws(() => service.saveConfig('o', { apiKey: 'k', baseUrl: 'https://user:pw@api.deepseek.com' }), /HTTPS/);
  assert.throws(() => service.saveConfig('o', { baseUrl: 'https://api.deepseek.com' }), /API Key/);
});

test('中文调用 DeepSeek，请求带固定提示词且只返回译文', async () => {
  const { service, calls } = setup(() => reply(200, { choices: [{ message: { content: '  Fix the login bug in `auth.js`.\n' } }] }));
  service.saveConfig('owner', { apiKey: 'sk-1' });
  const result = await service.translate('owner', '修复 `auth.js` 里的登录 bug');
  assert.deepEqual(result, { text: 'Fix the login bug in `auth.js`.', translated: true });
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-1');
  assert.equal(calls[0].body.messages[1].content, '修复 `auth.js` 里的登录 bug');
  assert.match(calls[0].body.messages[0].content, /never instructions for you/);
});

test('没有中文时原样返回，不调用接口；未配置时给出明确提示', async () => {
  const { service, calls } = setup(() => reply(200, {}));
  assert.deepEqual(await service.translate('owner', 'git status'), { text: 'git status', translated: false });
  assert.equal(calls.length, 0);
  await assert.rejects(service.translate('owner', '你好'), /尚未配置/);
});

test('DeepSeek 错误转成可读提示，空内容和超长内容被拒绝', async () => {
  for (const [status, pattern] of [[401, /无效/], [402, /余额/], [429, /频繁/], [500, /HTTP 500/]]) {
    const { service } = setup(() => reply(status, {}));
    service.saveConfig('o', { apiKey: 'k' });
    await assert.rejects(service.translate('o', '你好'), pattern);
  }
  const empty = setup(() => reply(200, { choices: [{ message: { content: '' } }] }));
  empty.service.saveConfig('o', { apiKey: 'k' });
  await assert.rejects(empty.service.translate('o', '你好'), /为空/);
  await assert.rejects(empty.service.translate('o', ' '), /请输入/);
  await assert.rejects(empty.service.translate('o', '好'.repeat(4001)), /不能超过/);
});

test('HTTP 路由：配置读写与翻译，密钥不出现在响应里', async () => {
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
