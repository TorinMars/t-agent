// Easy listener install (A, C, D in DESIGN.md "T-Attention: easy listener install"): POST /api/attention/plugins/claude/install|uninstall,
// terminal tokens in services/attention.js, pairing codes (create / claim / expire / reuse / rate limit) and the CLI `pair` and `login` with
// the hook sync. Every home and data folder is temporary: the real ~/.tagent and ~/.claude are never read or written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionService } = require('../services/attention');
const { createAttentionRoutes } = require('../routes/attention');
const { createPluginOverview, createListenerInstaller, INSTALL_TOKEN_NAME } = require('../services/attention-plugins');
const listenerInstall = require('../lib/listener-install');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 't-attention.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-attention-install-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let count = 0;
const newHome = () => { const dir = path.join(tmp, `home-${count += 1}`); fs.mkdirSync(dir, { recursive: true }); return dir; };

function makeDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  return db;
}

// A server with the real routes: the claim endpoint before the Bearer path, a stub session for the browser path.
async function startServer(t, { home, clock, pairingClaims } = {}) {
  const db = makeDb();
  const service = createAttentionService({ db, ...(clock ? { now: () => new Date(clock.at) } : {}) });
  const env = {};
  const userHome = home || newHome();
  const homedir = () => userHome;
  const terminalUser = () => ({ user: null });
  let localUrl = null;
  const overview = createPluginOverview({ service, env, homedir, terminalUser, autoTerminal: () => true });
  const installer = createListenerInstaller({ service, overview, env, homedir, terminalUser, localUrl: () => localUrl, checkRemote: async () => false });
  const routes = createAttentionRoutes({ service, plugins: overview, installer, ...(pairingClaims ? { pairingClaims } : {}), ...(clock ? { now: () => clock.at } : {}) });
  const app = express();
  app.use('/api/attention/pairing/claim', routes.claim);
  app.use('/api/attention', routes.bearer);
  app.use(express.json());
  app.use('/api/attention', (req, res, next) => { req.session = { user: { login: 'local' } }; next(); }, routes.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  localUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { routes.closeStreams(); server.close(); db.close(); });
  return { service, db, url: localUrl, base: `${localUrl}/api/attention` };
}

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });

test('install: hooks for the terminal user, a token named "claude listener (this machine)", attention-client.json (600) with the loopback URL', async t => {
  const home = newHome();
  const s = await startServer(t, { home });
  const res = await post(`${s.base}/plugins/claude/install`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.client, 'written');
  assert.equal(body.changed, true);
  assert.equal(body.settingsFile, path.join(home, '.claude', 'settings.json'));
  const config = JSON.parse(fs.readFileSync(path.join(home, '.tagent', 'attention-client.json'), 'utf8'));
  assert.equal(config.url, s.url);
  assert.equal(fs.statSync(path.join(home, '.tagent', 'attention-client.json')).mode & 0o777, 0o600);
  assert.ok(!text.includes(config.token), 'the token is never in the answer');
  assert.ok(s.service.verifyToken(config.token), 'the stored token works');
  assert.deepEqual(s.service.listTokens().map(token => token.name), [INSTALL_TOKEN_NAME]);
  assert.deepEqual(body.listener.local.hookPath && body.listener.local.loggedIn && body.listener.local.toolHooks && body.listener.local.hooksCurrent, true);
  assert.equal(body.listener.local.autoTerminal, true);

  // A second install keeps a config that works: no new token.
  const again = await (await post(`${s.base}/plugins/claude/install`)).json();
  assert.deepEqual([again.client, again.changed], ['kept', false]);
  assert.equal(s.service.listTokens().length, 1);

  // A config whose token was revoked is replaced; the old token of that name is revoked, a new one made.
  s.service.revokeToken(s.service.listTokens()[0].id);
  const third = await (await post(`${s.base}/plugins/claude/install`)).json();
  assert.equal(third.client, 'written');
  const tokens = s.service.listTokens();
  assert.equal(tokens.length, 2);
  assert.equal(tokens.filter(token => !token.revoked_at).length, 1);
  const before = s.service.listTokens().find(token => !token.revoked_at);
  // A config for another server that does not answer is replaced too (checkRemote is false here) and the older install token revoked.
  fs.writeFileSync(path.join(home, '.tagent', 'attention-client.json'), JSON.stringify({ url: 'http://127.0.0.1:9', token: 'tatt_x' }));
  await post(`${s.base}/plugins/claude/install`);
  assert.ok(s.service.listTokens().find(token => token.id === before.id).revoked_at, 'the old token with that exact name is revoked');

  // Uninstall: hooks and path file go, tokens stay.
  const removed = await (await post(`${s.base}/plugins/claude/uninstall`)).json();
  assert.deepEqual([removed.changed, removed.pathRemoved, removed.tokensKept], [true, true, true]);
  assert.equal(s.service.listTokens().filter(token => !token.revoked_at).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')), {});
});

test('install refuses a ~/.claude/settings.json that is not valid JSON (409) and makes no token; tokens cannot install or pair', async t => {
  const home = newHome();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ broken');
  const s = await startServer(t, { home });
  const res = await post(`${s.base}/plugins/claude/install`);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'SETTINGS_INVALID', message: '~/.claude/settings.json is not valid JSON' });
  assert.equal(s.service.listTokens().length, 0);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ broken');

  const { token } = s.service.createToken({ name: 'cli' });
  const terminal = s.service.issueTerminalToken({ taskId: 1, terminalId: 'default' }).token;
  for (const bearer of [token, terminal]) {
    const headers = { Authorization: `Bearer ${bearer}` };
    for (const address of ['/plugins/claude/install', '/plugins/claude/uninstall', '/pairing']) {
      const denied = await post(`${s.base}${address}`, {}, headers);
      assert.equal(denied.status, 403, `${address} is browser only`);
      assert.equal((await denied.json()).error, 'TOKEN_NOT_ALLOWED');
    }
  }
});

test('terminal tokens: in memory only, not in the token list, work as Bearer tokens until revoked; a new one ends the previous one', async t => {
  const s = await startServer(t);
  const first = s.service.issueTerminalToken({ taskId: 3, terminalId: 'abc' });
  assert.match(first.token, /^tatt_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(s.service.listTokens(), []);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM attention_tokens').get().n, 0, 'never stored in the database');
  const headers = { Authorization: `Bearer ${first.token}` };
  const created = await post(s.base, { title: 'From a terminal', source: 'claude' }, headers);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).source, 'claude');
  assert.equal(s.service.tokenActive(first.id), true);
  const second = s.service.issueTerminalToken({ taskId: 3, terminalId: 'abc' });
  assert.equal((await fetch(s.base, { headers })).status, 401, 'the previous token of that terminal ended');
  assert.equal(s.service.tokenActive(first.id), false);
  assert.equal((await fetch(s.base, { headers: { Authorization: `Bearer ${second.token}` } })).status, 200);
  assert.equal(s.service.revokeTerminalToken({ taskId: 3, terminalId: 'abc' }), true);
  assert.equal((await fetch(s.base, { headers: { Authorization: `Bearer ${second.token}` } })).status, 401);
  assert.equal(s.service.terminalTokenCount(), 0);
});

test('pairing: one active 6-digit code for 10 minutes; a claim gives the page URL and one token, once', async t => {
  const clock = { at: Date.parse('2026-11-08T10:00:00Z') };
  const s = await startServer(t, { clock });
  const created = await post(`${s.base}/pairing`, { origin: 'https://agent.example.com/' });
  assert.equal(created.status, 201);
  const pairing = await created.json();
  assert.match(pairing.code, /^\d{6}$/);
  assert.equal(pairing.url, 'https://agent.example.com');
  assert.equal(pairing.expiresAt, '2026-11-08T10:10:00.000Z');
  assert.equal(pairing.command, `t-attention pair ${pairing.code} --url https://agent.example.com`);
  assert.deepEqual(await (await fetch(`${s.base}/pairing`)).json(), { active: true, expiresAt: pairing.expiresAt, claimed: null });

  // A Bearer header does not change anything: the code is the credential.
  const claim = await post(`${s.base}/pairing/claim`, { code: pairing.code, name: 'laptop' }, { Authorization: 'Bearer tatt_ignored' });
  assert.equal(claim.status, 201);
  const claimed = await claim.json();
  assert.deepEqual(Object.keys(claimed).sort(), ['name', 'token', 'url']);
  assert.equal(claimed.url, 'https://agent.example.com');
  assert.equal(claimed.name, 'claude listener (laptop)');
  assert.ok(s.service.verifyToken(claimed.token));
  const row = s.db.prepare('SELECT * FROM attention_tokens').get();
  assert.notEqual(row.token_hash, claimed.token, 'stored hashed');
  assert.equal(row.token_hash.length, 64);

  const reuse = await post(`${s.base}/pairing/claim`, { code: pairing.code, name: 'other' });
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, 'PAIRING_INVALID');
  assert.equal(s.service.listTokens().length, 1, 'a code makes one token');
  const status = await (await fetch(`${s.base}/pairing`)).json();
  assert.equal(status.active, false);
  assert.equal(status.claimed.name, 'claude listener (laptop)');

  // A new code replaces the previous one; it expires after 10 minutes.
  const one = await (await post(`${s.base}/pairing`, { origin: 'http://10.0.0.2:3000' })).json();
  const two = await (await post(`${s.base}/pairing`, { origin: 'http://10.0.0.2:3000' })).json();
  if (one.code !== two.code) assert.equal((await post(`${s.base}/pairing/claim`, { code: one.code })).status, 400, 'only the newest code works');
  clock.at += 10 * 60 * 1000;
  assert.equal((await post(`${s.base}/pairing/claim`, { code: two.code })).status, 400, 'expired');
  // Cancel.
  await post(`${s.base}/pairing`, { origin: 'http://10.0.0.2:3000' });
  const cancelled = await (await fetch(`${s.base}/pairing`, { method: 'DELETE' })).json();
  assert.equal(cancelled.active, false);
  // Bad origins are refused.
  for (const origin of ['javascript:alert(1)', 'https://user:pw@host', 'not a url']) assert.equal((await post(`${s.base}/pairing`, { origin })).status, 400);
});

test('pairing claims: 5 wrong codes in a minute lock the address for a minute; a bad name does not use up the code', async t => {
  const clock = { at: Date.parse('2026-11-08T10:00:00Z') };
  const s = await startServer(t, { clock });
  const { code } = await (await post(`${s.base}/pairing`, { origin: 'http://127.0.0.1:1' })).json();
  const wrong = code === '000000' ? '000001' : '000000';
  assert.equal((await post(`${s.base}/pairing/claim`, { code, name: 'bad\nname' })).status, 400);
  for (let i = 0; i < 5; i += 1) assert.equal((await post(`${s.base}/pairing/claim`, { code: wrong })).status, 400);
  const locked = await post(`${s.base}/pairing/claim`, { code });
  assert.equal(locked.status, 429, 'even the right code waits');
  assert.equal((await locked.json()).error, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  clock.at += 61 * 1000;
  const ok = await post(`${s.base}/pairing/claim`, { code, name: 'desk' });
  assert.equal(ok.status, 201, 'after the minute the (still valid) code works');
  assert.equal((await post(`${s.base}/pairing/claim`, 'not json')).status, 400);
  assert.equal((await fetch(`${s.base}/pairing/claim`)).status, 405);
});

test('pairing: the active code ends after 20 wrong codes from many addresses', () => {
  const db = makeDb();
  const service = createAttentionService({ db });
  const { code } = service.createPairing({ url: 'http://127.0.0.1:1' });
  const wrong = code === '111111' ? '222222' : '111111';
  for (let i = 0; i < 20; i += 1) assert.throws(() => service.claimPairing({ code: wrong }), { code: 'PAIRING_INVALID' });
  assert.throws(() => service.claimPairing({ code }), { code: 'PAIRING_INVALID' });
  assert.equal(service.pairingStatus().active, false);
  db.close();
});

function run(args, { home, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI pair claims the code, saves the config, syncs the hooks; --no-hooks leaves ~/.claude alone; a used code exits 1', async t => {
  const s = await startServer(t);
  const home = newHome();
  const { code } = await (await post(`${s.base}/pairing`, { origin: s.url })).json();
  const paired = await run(['pair', code, '--url', s.url, '--name', 'laptop'], { home });
  assert.equal(paired.code, 0, paired.stderr);
  assert.match(paired.stdout, /^Paired: this machine has the token "claude listener \(laptop\)"/);
  assert.match(paired.stdout, /Claude Code hooks: added \d+ entries in .*\.claude\/settings\.json/);
  const config = JSON.parse(fs.readFileSync(path.join(home, '.tagent', 'attention-client.json'), 'utf8'));
  assert.equal(config.url, s.url);
  assert.ok(!paired.stdout.includes(config.token), 'the token is never printed');
  assert.ok(s.service.verifyToken(config.token));
  assert.deepEqual(listenerInstall.checkClaudeHooks({ dataDir: path.join(home, '.tagent'), home }), { hookPath: true, toolHooks: true, current: true });

  const used = await run(['pair', code, '--url', s.url], { home: newHome() });
  assert.equal(used.code, 1);
  assert.match(used.stderr, /The pairing code is wrong, used or expired/);

  const other = newHome();
  const next = await (await post(`${s.base}/pairing`, { origin: s.url })).json();
  const noHooks = await run(['pair', next.code, '--url', s.url, '--no-hooks', '--json'], { home: other });
  assert.equal(noHooks.code, 0, noHooks.stderr);
  assert.equal(JSON.parse(noHooks.stdout).hooks, null);
  assert.equal(fs.existsSync(path.join(other, '.claude')), false);
  assert.equal(fs.readFileSync(path.join(other, '.tagent', 'listeners', 'claude-hook.path'), 'utf8').trim(), listenerInstall.HOOK_PATH);

  assert.equal((await run(['pair', '12345', '--url', s.url], { home: newHome() })).code, 1, 'not 6 digits');
  assert.equal((await run(['pair', '123456'], { home: newHome() })).code, 1, 'no --url');
});

test('CLI login syncs the hooks after the check, says so, and leaves an unmergeable settings file alone', async t => {
  const s = await startServer(t);
  const { token } = s.service.createToken({ name: 'cli' });
  const home = newHome();
  const first = await run(['login', '--url', s.url, '--token', token], { home });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Claude Code hooks: added \d+ entries in /);
  const second = await run(['login', '--url', s.url, '--token', token], { home });
  assert.match(second.stdout, /Claude Code hooks: already in place in /);

  // A refused token: nothing is written, not even the hooks.
  const refused = newHome();
  assert.equal((await run(['login', '--url', s.url, '--token', 'tatt_wrong'], { home: refused })).code, 2);
  assert.equal(fs.existsSync(path.join(refused, '.claude')), false);

  const broken = newHome();
  fs.mkdirSync(path.join(broken, '.claude'));
  fs.writeFileSync(path.join(broken, '.claude', 'settings.json'), '{');
  const kept = await run(['login', '--url', s.url, '--token', token], { home: broken });
  assert.equal(kept.code, 0, 'the login itself worked');
  assert.match(kept.stdout, /Claude Code hooks: not changed: ~\/\.claude\/settings\.json is not valid JSON/);
  assert.equal(fs.readFileSync(path.join(broken, '.claude', 'settings.json'), 'utf8'), '{');

  const skipped = newHome();
  const noHooks = await run(['login', '--url', s.url, '--token', token, '--no-hooks'], { home: skipped });
  assert.match(noHooks.stdout, /Claude Code hooks: skipped \(--no-hooks\)/);
  assert.equal(fs.existsSync(path.join(skipped, '.claude')), false);
});
