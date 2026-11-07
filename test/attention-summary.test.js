const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionService } = require('../services/attention');
const { createAttentionSummary } = require('../services/attention-summary');
const { createTranslator } = require('../services/translator');
const { createAttentionRoutes } = require('../routes/attention');

const SECRET = 'attention-summary-test-secret';
const API_KEY = 'sk-test-key-never-shown';

// A fake OpenAI-compatible provider: records the requests and answers with `reply` (a function of the request), never a real model.
function fakeProvider(reply = () => ({ status: 200, content: 'Doing: fixing login\nProgress: tests pass\nNeeds: approve the push' })) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, headers: options.headers, body });
    const answer = await reply(body, options);
    if (answer.status !== 200) return { ok: false, status: answer.status, json: async () => ({}), text: async () => '' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: answer.content } }] }) };
  };
  return { calls, fetchImpl };
}

function setup({ reply, timeoutMs = 20000, withKey = true } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const attention = createAttentionService({ db });
  const translator = createTranslator({ db, sessionSecret: SECRET });
  if (withKey) translator.saveConfig('local', { provider: 'deepseek', apiKey: API_KEY, enabled: false });
  const provider = fakeProvider(reply);
  const logs = [];
  const summary = createAttentionSummary({ db, sessionSecret: SECRET, attention, translator, owner: () => 'local', fetchImpl: provider.fetchImpl, timeoutMs, log: message => logs.push(message) });
  return { db, attention, translator, summary, provider, logs };
}
const settle = async (summary, ms = 2000) => {
  const deadline = Date.now() + ms;
  await new Promise(resolve => setImmediate(resolve));
  while (summary.running().size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setImmediate(resolve));
};

test('off by default: no call is made when an item needs the person', async () => {
  const { attention, summary, provider } = setup();
  assert.equal(summary.getSettings('local').enabled, false);
  const item = attention.create({ title: 'job', status: 'working' });
  attention.update(item.id, { status: 'waiting_user', excerpt: 'transcript' });
  await settle(summary);
  assert.equal(provider.calls.length, 0);
  assert.throws(() => summary.summarize('local', item.id), error => error.code === 'SUMMARY_DISABLED' && error.statusCode === 409);
});

test('when on: only entering waiting_user or review starts a summary; it is stored in context.summary with a change event', async () => {
  const { attention, summary, provider } = setup();
  summary.saveSettings('local', { enabled: true, provider: 'deepseek' });
  const changes = [];
  attention.onChange(change => changes.push(change));
  const item = attention.create({ title: 'job', status: 'working', context: { goal: 'Fix the login', last_reply: 'Tests pass', pending: { kind: 'permission', text: 'Allow git push?' }, files: [{ path: 'a.js', added: 3, deleted: 1 }] } });
  attention.update(item.id, { notes: 'still working' });
  attention.update(item.id, { status: 'done' });
  await settle(summary);
  assert.equal(provider.calls.length, 0, 'other statuses and other changes do not start one');

  attention.update(item.id, { status: 'waiting_user', excerpt: 'USER: please fix\nASSISTANT: done, may I push?' });
  await settle(summary);
  assert.equal(provider.calls.length, 1);
  const call = provider.calls[0];
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`);
  const userMessage = call.body.messages[1].content;
  for (const part of ['Fix the login', 'Tests pass', 'Allow git push?', 'a.js', 'may I push?']) assert.ok(userMessage.includes(part), part);
  assert.match(call.body.messages[0].content, /exactly three short lines/);
  const stored = attention.get(item.id).context.summary;
  assert.equal(stored.text, 'Doing: fixing login\nProgress: tests pass\nNeeds: approve the push');
  assert.equal(stored.model, 'deepseek-flash');
  assert.ok(stored.at);
  const last = changes[changes.length - 1];
  assert.equal(last.kind, 'updated');
  assert.equal(last.event.actor, 'summary');
  assert.deepEqual(last.event.data.context, ['summary']);
  assert.equal(attention.get(item.id).status, 'waiting_user');

  // Staying in waiting_user (another update) does not start another; moving to review does, without an excerpt.
  attention.update(item.id, { attention_reason: 'still waiting' });
  await settle(summary);
  assert.equal(provider.calls.length, 1);
  attention.update(item.id, { status: 'review' });
  await settle(summary);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1].body.messages[1].content.includes('may I push?'), false, 'the excerpt was used once and dropped');
  // A new item created straight in review counts as entering it.
  attention.create({ title: 'new', status: 'review' });
  await settle(summary);
  assert.equal(provider.calls.length, 3);
});

test('at most one summary runs per item; a manual refresh while one runs is not started twice', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { attention, summary, provider } = setup({ reply: async () => { await gate; return { status: 200, content: 'Doing: a\nProgress: b\nNeeds: c' }; } });
  summary.saveSettings('local', { enabled: true });
  const item = attention.create({ title: 'job', status: 'working' });
  attention.update(item.id, { status: 'waiting_user' });
  attention.update(item.id, { status: 'working' });
  attention.update(item.id, { status: 'review' });
  assert.equal(summary.summarize('local', item.id).started, false);
  assert.equal(summary.running().size, 1);
  release();
  await settle(summary);
  assert.equal(provider.calls.length, 1);
  const again = summary.summarize('local', item.id);
  assert.equal(again.started, true);
  assert.equal(await again.promise, true);
  assert.equal(provider.calls.length, 2);
});

test('timeouts and provider errors are logged and leave the item alone; other items still work', async () => {
  const { attention, summary, logs } = setup({
    timeoutMs: 50,
    reply: async body => {
      const text = body.messages[1].content;
      if (text.includes('slow')) return new Promise(() => {}); // never answers (and ignores the abort)
      if (text.includes('broken')) return { status: 500 };
      if (text.includes('empty')) return { status: 200, content: '   ' };
      return { status: 200, content: '- Doing: ok\n- Progress: ok\n- Needs: ok\n- extra line' };
    },
  });
  summary.saveSettings('local', { enabled: true });
  const ids = {};
  for (const name of ['slow', 'broken', 'empty', 'fine']) ids[name] = attention.create({ title: name, status: 'working' }).id;
  const changes = [];
  attention.onChange(change => changes.push(change));
  for (const name of Object.keys(ids)) attention.update(ids[name], { status: 'waiting_user' });
  await settle(summary, 3000);
  assert.equal(summary.running().size, 0, 'the slow one was given up after the timeout');
  for (const name of ['slow', 'broken', 'empty']) {
    const item = attention.get(ids[name]);
    assert.equal(item.status, 'waiting_user', name);
    assert.equal(item.context, null, name);
  }
  assert.equal(attention.get(ids.fine).context.summary.text, 'Doing: ok\nProgress: ok\nNeeds: ok', 'list marks removed, three lines kept');
  assert.equal(logs.length, 3);
  assert.match(logs.join('\n'), /no answer within/);
  assert.match(logs.join('\n'), /HTTP 500/);
  assert.equal(logs.join('\n').includes(API_KEY), false);
  assert.equal(changes.filter(change => change.event.actor === 'summary').length, 1);
});

test('settings: saved encrypted, never return the API key, validated; enabling needs a saved key', () => {
  const { db, summary, translator } = setup();
  const saved = summary.saveSettings('local', { enabled: true, provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(saved.enabled, true);
  assert.equal(saved.model, 'deepseek-chat');
  assert.deepEqual(saved.providers.map(p => [p.id, p.hasApiKey]), [['deepseek', true], ['glm', false]]);
  const raw = db.prepare("SELECT value FROM system_state WHERE key = 'attention-summary:local'").get().value;
  assert.equal(raw.includes('deepseek'), false, 'stored encrypted');
  assert.equal(JSON.stringify(summary.getSettings('local')).includes(API_KEY), false);
  assert.throws(() => summary.saveSettings('local', { enabled: 'yes' }), /enabled must be true or false/);
  assert.throws(() => summary.saveSettings('local', { provider: 'openai' }), /provider must be one of/);
  assert.throws(() => summary.saveSettings('local', { model: 'bad model!' }), /Invalid model name/);
  assert.throws(() => summary.saveSettings('local', { provider: 'glm' }), error => error.code === 'SUMMARY_PROVIDER_NOT_CONFIGURED');
  assert.equal(summary.saveSettings('local', { enabled: false, provider: 'glm' }).provider, 'glm', 'a provider without a key can be chosen while off');
  assert.equal(translator.getConfig('local').enabled, false, 'the translator setting is not touched');
});

test('HTTP: settings and summarize are session only; a token gets 403; the answer never holds the key', async t => {
  const { attention, summary, provider } = setup();
  const routes = createAttentionRoutes({ service: attention, summary });
  const app = express();
  app.use('/api/attention', routes.bearer);
  app.use(express.json());
  app.use('/api/attention', (req, res, next) => { req.session = { user: { login: 'local' } }; next(); }, routes.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { routes.closeStreams(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/attention`;
  const json = { 'Content-Type': 'application/json' };
  const { token } = attention.createToken({ name: 'cli' });

  const got = await fetch(`${base}/settings/summary`);
  assert.equal(got.status, 200);
  const gotText = await got.text();
  assert.equal(gotText.includes(API_KEY), false);
  assert.equal(JSON.parse(gotText).enabled, false);
  const item = attention.create({ title: 'job', status: 'waiting_user' });
  const off = await fetch(`${base}/${item.id}/summarize`, { method: 'POST' });
  assert.equal(off.status, 409);
  assert.equal((await off.json()).error, 'SUMMARY_DISABLED');
  const put = await fetch(`${base}/settings/summary`, { method: 'PUT', headers: json, body: JSON.stringify({ enabled: true }) });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).enabled, true);
  const started = await fetch(`${base}/${item.id}/summarize`, { method: 'POST' });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { started: true });
  await settle(summary);
  assert.ok(attention.get(item.id).context.summary);
  assert.equal(provider.calls.length, 1);
  assert.equal((await fetch(`${base}/999/summarize`, { method: 'POST' })).status, 404);

  for (const [method, route] of [['GET', '/settings/summary'], ['PUT', '/settings/summary'], ['POST', `/${item.id}/summarize`], ['GET', '/SETTINGS/summary']]) {
    const response = await fetch(`${base}${route}`, { method, headers: { ...json, Authorization: `Bearer ${token}` }, ...(method === 'PUT' ? { body: JSON.stringify({ enabled: false }) } : {}) });
    assert.equal(response.status, 403, `${method} ${route}`);
  }
  assert.equal(summary.getSettings('local').enabled, true, 'a token could not switch it off');
});
