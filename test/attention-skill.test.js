// The T-Attention agent skill (services/attention-skill.js, routes/attention-skill.js, rules/skills/t-attention/SKILL.md). Every folder is a throwaway one:
// HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and the data folder are made per test; the real ~/.claude, ~/.codex and ~/.tagent are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const skill = require('../services/attention-skill');
const { createAttentionSkillRouter } = require('../routes/attention-skill');

const SOURCE = fs.readFileSync(skill.SOURCE_FILE, 'utf8');
const temps = [];
test.after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

function sandbox({ claudeEnv = false, codexEnv = false, cliPath = '/opt/t agent/scripts/t-attention.js', source = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-skill-'));
  temps.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { HOME: home };
  if (claudeEnv) env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
  if (codexEnv) env.CODEX_HOME = path.join(root, 'codex-home');
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  const dataDir = path.join(root, 'data');
  let sourceFile = skill.SOURCE_FILE;
  if (source !== null) { sourceFile = path.join(root, 'SKILL.source.md'); fs.writeFileSync(sourceFile, source); }
  const service = skill.createAttentionSkill({ env, homedir: () => home, terminalUser: () => ({ user: null }), dataDir, sourceFile, cliPath, now: () => new Date('2026-11-12T10:20:30.456Z') });
  return { root, home, env, claude, codex, dataDir, sourceFile, service, file: dir => path.join(dir, 'skills', 't-attention', 'SKILL.md') };
}

test('install writes the skill for Claude and Codex, with the CLI path of this machine, and is idempotent', () => {
  const box = sandbox();
  const before = box.service.status();
  assert.deepEqual(before.claude, { installed: false, path: box.file(box.claude), current: false, conflict: null });
  assert.deepEqual(before.codex, { installed: false, path: box.file(box.codex), current: false, conflict: null });
  assert.deepEqual(before.old_task_tracker, { claude: false, codex: false });

  const first = box.service.install();
  assert.equal(first.ok, true);
  assert.equal(first.results.claude.action, 'installed');
  assert.equal(first.results.codex.action, 'installed');
  const written = fs.readFileSync(box.file(box.claude), 'utf8');
  assert.equal(written, fs.readFileSync(box.file(box.codex), 'utf8'), 'identical for both agents');
  assert.ok(written.includes('"${TA_ATTENTION_CLI:-/opt/t agent/scripts/t-attention.js}"'), 'the CLI path is written after :-');
  assert.ok(!written.includes(skill.CLI_TOKEN), 'no plain fallback is left');
  assert.equal(written, skill.render(SOURCE, '/opt/t agent/scripts/t-attention.js'));
  assert.equal(fs.statSync(path.dirname(box.file(box.claude))).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(box.claude, 'skills')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(box.file(box.codex)).mode & 0o777, 0o644);
  assert.equal(first.status.claude.current, true);
  assert.equal(first.status.codex.current, true);

  const again = box.service.install();
  assert.deepEqual([again.results.claude.action, again.results.codex.action], ['unchanged', 'unchanged']);
  assert.deepEqual(fs.readdirSync(path.dirname(box.file(box.claude))), ['SKILL.md'], 'no temporary file is left');
});

test('a changed source (or an edited copy) is reported as not current and updated; other files in the folder stay', () => {
  const box = sandbox({ source: SOURCE });
  box.service.install();
  fs.writeFileSync(path.join(path.dirname(box.file(box.claude)), 'notes.txt'), 'mine');
  fs.writeFileSync(box.sourceFile, `${SOURCE}\nOne more line.\n`);
  const status = box.service.status();
  assert.equal(status.claude.installed, true);
  assert.equal(status.claude.current, false);
  const result = box.service.install();
  assert.deepEqual([result.results.claude.action, result.results.codex.action], ['updated', 'updated']);
  assert.ok(fs.readFileSync(box.file(box.codex), 'utf8').endsWith('One more line.\n'));
  assert.equal(fs.readFileSync(path.join(path.dirname(box.file(box.claude)), 'notes.txt'), 'utf8'), 'mine');
});

test('CLAUDE_CONFIG_DIR and CODEX_HOME are respected', () => {
  const box = sandbox({ claudeEnv: true, codexEnv: true });
  box.service.install();
  assert.ok(fs.existsSync(path.join(box.root, 'claude-config', 'skills', 't-attention', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(box.root, 'codex-home', 'skills', 't-attention', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(box.home, '.claude')));
  assert.ok(!fs.existsSync(path.join(box.home, '.codex')));
});

test('render: a CLI path that cannot stand inside double quotes keeps the plain fallback', () => {
  const text = 'run "${TA_ATTENTION_CLI:-t-attention}" add x';
  assert.equal(skill.render(text, '/a/b/t-attention.js'), 'run "${TA_ATTENTION_CLI:-/a/b/t-attention.js}" add x');
  for (const bad of ['/a/"b"/t.js', '/a/$HOME/t.js', '/a/`x`/t.js', '/a/}/t.js', '/a\\b/t.js', '/a/\nb', '']) assert.equal(skill.render(text, bad), text, bad);
});

test('a skill folder owned by the rules and skills sync is never overwritten; it is reported', () => {
  const box = sandbox();
  const dir = path.dirname(box.file(box.claude));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'synced copy');
  fs.writeFileSync(path.join(dir, skill.SYNC_MARKER), JSON.stringify({ source: { instance_id: 'abc', name: 'Studio' }, revision: 'r1' }));
  const status = box.service.status();
  assert.equal(status.claude.conflict, 'rule-sync');
  assert.equal(status.claude.sync_source, 'Studio');
  const result = box.service.install();
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.claude, { action: 'refused', path: box.file(box.claude), conflict: 'rule-sync', sync_source: 'Studio' });
  assert.equal(result.results.codex.action, 'installed', 'the other agent is still installed');
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), 'synced copy');
  // An unreadable marker still means the sync owns the folder.
  fs.writeFileSync(path.join(dir, skill.SYNC_MARKER), 'not json');
  assert.equal(box.service.install().results.claude.action, 'refused');
});

test('a symlinked skill folder or a file at its place is refused too', () => {
  const box = sandbox();
  const elsewhere = path.join(box.root, 'dotfiles', 't-attention');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), 'linked');
  fs.mkdirSync(path.join(box.claude, 'skills'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(box.claude, 'skills', 't-attention'));
  fs.mkdirSync(path.join(box.codex, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(box.codex, 'skills', 't-attention'), 'a file');
  const result = box.service.install();
  assert.equal(result.results.claude.conflict, 'symlink');
  assert.equal(result.results.codex.conflict, 'not-a-directory');
  assert.equal(fs.readFileSync(path.join(elsewhere, 'SKILL.md'), 'utf8'), 'linked');
  assert.equal(fs.readFileSync(path.join(box.codex, 'skills', 't-attention'), 'utf8'), 'a file');
});

function oldSkill(dir) {
  const folder = path.join(dir, 'skills', 'task-tracker');
  fs.mkdirSync(path.join(folder, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: task-tracker\n---\nold');
  fs.writeFileSync(path.join(folder, 'refs', 'api.md'), 'api');
  return folder;
}

test('remove-old moves the task-tracker skill into the backups of the data folder; nothing is deleted', () => {
  const box = sandbox();
  const claudeOld = oldSkill(box.claude);
  const codexOld = oldSkill(box.codex);
  assert.deepEqual(box.service.status().old_task_tracker, { claude: true, codex: true });
  // Without the new skill nothing moves: the agents would be left without one.
  const early = box.service.removeOld();
  assert.deepEqual(early.moved, []);
  assert.deepEqual(early.skipped.map(item => item.reason), ['not-installed', 'not-installed']);
  assert.equal(early.backup, null);
  assert.ok(fs.existsSync(claudeOld));

  box.service.install();
  const result = box.service.removeOld();
  const backup = path.join(box.dataDir, 'backups', 'task-tracker-2026-11-12T10-20-30-456Z');
  assert.equal(result.backup, backup);
  assert.deepEqual(result.moved, [
    { agent: 'claude', from: claudeOld, to: path.join(backup, 'claude', 'task-tracker') },
    { agent: 'codex', from: codexOld, to: path.join(backup, 'codex', 'task-tracker') },
  ]);
  assert.ok(!fs.existsSync(claudeOld) && !fs.existsSync(codexOld));
  assert.equal(fs.readFileSync(path.join(backup, 'claude', 'task-tracker', 'refs', 'api.md'), 'utf8'), 'api');
  assert.equal(fs.readFileSync(path.join(backup, 'codex', 'task-tracker', 'SKILL.md'), 'utf8'), '---\nname: task-tracker\n---\nold');
  assert.deepEqual(result.status.old_task_tracker, { claude: false, codex: false });
  assert.ok(fs.existsSync(box.file(box.claude)), 'the new skill stays');

  // A second run in the same instant gets its own folder; with nothing left it reports 'missing'.
  oldSkill(box.claude);
  const second = box.service.removeOld();
  assert.equal(second.backup, `${backup}-2`);
  assert.deepEqual(second.skipped, [{ agent: 'codex', path: codexOld, reason: 'missing' }]);
  assert.ok(fs.existsSync(path.join(backup, 'claude', 'task-tracker')), 'the first backup is kept');
});

test('remove-old leaves a task-tracker folder that the sync owns', () => {
  const box = sandbox();
  box.service.install();
  const folder = oldSkill(box.claude);
  fs.writeFileSync(path.join(folder, skill.SYNC_MARKER), JSON.stringify({ revision: 'r1' }));
  const result = box.service.removeOld();
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.skipped.map(item => [item.agent, item.reason]), [['claude', 'rule-sync'], ['codex', 'missing']]);
  assert.ok(fs.existsSync(path.join(folder, 'SKILL.md')));
});

test('the terminal user decides where the skill goes when the service drops privileges', () => {
  const box = sandbox();
  const userHome = path.join(box.root, 'dev-home');
  fs.mkdirSync(userHome);
  const service = skill.createAttentionSkill({ env: box.env, homedir: () => box.home, terminalUser: () => ({ user: { name: 'dev', home: userHome, uid: process.getuid(), gid: process.getgid() } }), dataDir: box.dataDir });
  const result = service.install();
  assert.equal(result.status.user, 'dev');
  assert.equal(result.results.claude.path, path.join(userHome, '.claude', 'skills', 't-attention', 'SKILL.md'));
  assert.ok(fs.existsSync(path.join(userHome, '.codex', 'skills', 't-attention', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(box.home, '.claude')));
});

test('a missing source file is a clear error', () => {
  const box = sandbox();
  const service = skill.createAttentionSkill({ env: box.env, homedir: () => box.home, terminalUser: () => ({ user: null }), dataDir: box.dataDir, sourceFile: path.join(box.root, 'nope.md') });
  assert.throws(() => service.status(), error => error.code === 'ATTENTION_SKILL_SOURCE_MISSING' && error.statusCode === 500);
});

// ---- Routes ----

function listen(app) {
  return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
}
function request(server, method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: url, headers, agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { let json = null; try { json = body ? JSON.parse(body) : null; } catch { json = { text: body }; } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    req.end();
  });
}

test('routes: the login is needed, writes need same-origin proof, and the answers come from the service', async () => {
  const box = sandbox();
  let loggedIn = false;
  const requireAuth = (req, res, next) => (loggedIn ? next() : res.status(401).json({ error: 'AUTH_REQUIRED' }));
  const app = express();
  app.use('/api/attention/skill', createAttentionSkillRouter({ getService: () => box.service, requireAuth }));
  const server = await listen(app);
  const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
  try {
    assert.equal((await request(server, 'GET', '/api/attention/skill')).status, 401);
    assert.equal((await request(server, 'POST', '/api/attention/skill/install', XHR)).status, 401);
    assert.ok(!fs.existsSync(box.file(box.claude)), 'nothing written without the login');
    loggedIn = true;
    const status = await request(server, 'GET', '/api/attention/skill');
    assert.equal(status.status, 200);
    assert.deepEqual(Object.keys(status.body).sort(), ['claude', 'cli', 'codex', 'old_task_tracker', 'user']);
    assert.equal((await request(server, 'POST', '/api/attention/skill/install')).body.error, 'CLIENT_ORIGIN_REQUIRED', 'a write without proof');
    assert.equal((await request(server, 'POST', '/api/attention/skill/install', { ...XHR, Origin: 'https://evil.example' })).status, 403);
    const installed = await request(server, 'POST', '/api/attention/skill/install', XHR);
    assert.equal(installed.status, 200);
    assert.equal(installed.body.results.claude.action, 'installed');
    oldSkill(box.codex);
    const moved = await request(server, 'POST', '/api/attention/skill/remove-old', XHR);
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.moved.map(item => item.agent), ['codex']);
    assert.equal((await request(server, 'GET', '/api/attention/skill/nope')).status, 404);
  } finally { server.close(); }
});

test('routes: service errors keep their code', async () => {
  const app = express();
  const failing = { status() { throw new skill.AttentionSkillError('ATTENTION_SKILL_SOURCE_MISSING', 'The skill file of this install is missing: /x', 500); } };
  app.use('/s', createAttentionSkillRouter({ getService: () => failing, requireAuth: (req, res, next) => next() }));
  const server = await listen(app);
  try {
    const res = await request(server, 'GET', '/s');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'ATTENTION_SKILL_SOURCE_MISSING', message: 'The skill file of this install is missing: /x' });
  } finally { server.close(); }
});

test('server.js mounts the skill router before the T-Attention router, which answers every other /api/attention path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mount = source.indexOf("app.use('/api/attention/skill', require('./routes/attention-skill').createAttentionSkillRouter());");
  const attention = source.indexOf("app.use('/api/attention', attentionRoutes.router);");
  const gate = source.indexOf('app.use(createLoginGate(');
  assert.ok(mount > gate && mount < attention, 'after the login gate, before the attention router');
});

// ---- The skill text ----

// The commands and flags of the t-attention CLI contract the skill may use (scripts/t-attention.js; `login` with --url / --token already existed).
const COMMANDS = new Set(['add', 'update', 'review', 'confirm', 'reject', 'handled', 'wait', 'work', 'fail', 'move', 'list', 'tree', 'show', 'login']);
const FLAGS = new Set(['parent', 'status', 'custom-status', 'result', 'notes', 'ref', 'json', 'title', 'note', 'reason', 'before', 'after', 'top', 'bottom', 'tree', 'url', 'token']);

test('SKILL.md: valid frontmatter, only commands and flags of the CLI contract, short enough', () => {
  const lines = SOURCE.split('\n');
  assert.ok(lines.length < 400, `${lines.length} lines`);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(SOURCE);
  assert.ok(match, 'frontmatter between --- lines at the top');
  const fields = Object.fromEntries(match[1].split('\n').map(line => { const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name']);
  assert.equal(fields.name, 't-attention');
  assert.ok(fields.description.length >= 100 && fields.description.length <= 500, `description of ${fields.description.length} characters (Codex takes at most 500)`);
  for (const word of ['sub-agent', 'confirmation', 'tasks']) assert.ok(fields.description.includes(word), word);

  // Every command after the CLI token, and every inline `command <id>` / `command --flag` mention.
  const used = new Set();
  for (const found of SOURCE.matchAll(/"\$\{TA_ATTENTION_CLI:-t-attention\}" ([a-z-]+)/g)) used.add(found[1]);
  for (const found of SOURCE.matchAll(/`(?:t-attention )?([a-z]+) (?:<id>|--)/g)) used.add(found[1]);
  const unknown = [...used].filter(name => !COMMANDS.has(name));
  assert.deepEqual(unknown, []);
  for (const name of ['add', 'update', 'review', 'confirm', 'wait', 'work', 'list', 'show']) assert.ok(used.has(name), `uses ${name}`);
  const flags = new Set([...SOURCE.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map(found => found[1]));
  assert.deepEqual([...flags].filter(flag => !FLAGS.has(flag)), []);
  assert.ok(!/\b(?:done|cancel|rm|upsert|pair|plugins) <id>/.test(SOURCE), 'no command outside the contract');
  // The installer can put the path in, and nothing in the skill restarts T-Agent.
  assert.ok(SOURCE.includes(skill.CLI_TOKEN));
  assert.ok(!/pm2 (?:restart|stop|delete|reload)|systemctl|launchctl/.test(SOURCE));
  assert.ok(!/[\u4e00-\u9fff]/.test(SOURCE), 'English only: headings are localized by the agent');
});
