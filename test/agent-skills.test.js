// The agent skills installer (services/agent-skills.js, routes/agent-skills.js) with both bundled skills, t-attention and tcli, and the text of
// rules/skills/tcli/SKILL.md. The first t-attention installer (services/attention-skill.js) has its own tests in test/attention-skill.test.js. Every
// folder is a throwaway one: HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and the data folder are made per test; the real ~/.claude, ~/.codex and ~/.tagent
// are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const express = require('express');
const skills = require('../services/agent-skills');
const { createAgentSkillsRouter } = require('../routes/agent-skills');
const { createAttentionSkillRouter } = require('../routes/attention-skill');
const attentionSkill = require('../services/attention-skill');

const TCLI = skills.SKILLS.find(skill => skill.name === 'tcli');
const ATTENTION = skills.SKILLS.find(skill => skill.name === 't-attention');
const TCLI_SOURCE = fs.readFileSync(TCLI.sourceFile, 'utf8');
const temps = [];
test.after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

function sandbox({ claudeEnv = false, codexEnv = false, tcliSource = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-agent-skills-'));
  temps.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { HOME: home };
  if (claudeEnv) env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
  if (codexEnv) env.CODEX_HOME = path.join(root, 'codex-home');
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  const dataDir = path.join(root, 'data');
  const own = { 't-attention': { cliPath: '/opt/t agent/scripts/t-attention.js' }, tcli: { cliPath: '/opt/t agent/scripts/tcli.js' } };
  if (tcliSource !== null) { own.tcli.sourceFile = path.join(root, 'tcli.source.md'); fs.writeFileSync(own.tcli.sourceFile, tcliSource); }
  const service = skills.createAgentSkills({ env, homedir: () => home, terminalUser: () => ({ user: null }), dataDir, skills: own, now: () => new Date('2026-11-12T10:20:30.456Z') });
  return { root, home, env, claude, codex, dataDir, own, service, file: (dir, name) => path.join(dir, 'skills', name, 'SKILL.md') };
}

test('the list has both skills in order, each with a description and the state for both agents', () => {
  const box = sandbox();
  const view = box.service.list();
  assert.deepEqual(Object.keys(view).sort(), ['old_task_tracker', 'skills', 'user']);
  assert.deepEqual(view.skills.map(skill => skill.name), ['t-attention', 'tcli']);
  for (const skill of view.skills) {
    assert.ok(skill.description.length > 40 && !skill.description.includes('\n'), `${skill.name}: one line`);
    assert.deepEqual(skill.claude, { installed: false, path: box.file(box.claude, skill.name), current: false, conflict: null });
    assert.deepEqual(skill.codex, { installed: false, path: box.file(box.codex, skill.name), current: false, conflict: null });
    assert.equal(skill.cli.path, box.own[skill.name].cliPath);
  }
  assert.deepEqual(view.old_task_tracker, { claude: false, codex: false });
  assert.equal(view.user, null);
});

test('install writes each skill for Claude and Codex with this machine\'s CLI path, and is idempotent', () => {
  const box = sandbox();
  const tcli = box.service.install('tcli');
  assert.equal(tcli.ok, true);
  assert.equal(tcli.name, 'tcli');
  assert.deepEqual([tcli.results.claude.action, tcli.results.codex.action], ['installed', 'installed']);
  const written = fs.readFileSync(box.file(box.claude, 'tcli'), 'utf8');
  assert.equal(written, fs.readFileSync(box.file(box.codex, 'tcli'), 'utf8'), 'identical for both agents');
  assert.ok(written.includes('node "${TA_TCLI:-/opt/t agent/scripts/tcli.js}" oss ls'), 'node runs the script of this install, or $TA_TCLI');
  assert.ok(!written.includes(skills.TCLI_TOKEN), 'no plain fallback is left');
  assert.ok(!written.includes('${TA_TCLI:+node}'));
  assert.equal(written, skills.renderSkill('tcli', TCLI_SOURCE, '/opt/t agent/scripts/tcli.js'));
  assert.equal(fs.statSync(path.dirname(box.file(box.claude, 'tcli'))).mode & 0o777, 0o755);
  assert.equal(fs.statSync(box.file(box.codex, 'tcli')).mode & 0o777, 0o644);
  // Installing one skill leaves the other alone.
  const after = tcli.status.skills;
  assert.equal(after.find(skill => skill.name === 'tcli').claude.current, true);
  assert.equal(after.find(skill => skill.name === 't-attention').claude.installed, false);

  const attention = box.service.install('t-attention');
  assert.deepEqual([attention.results.claude.action, attention.results.codex.action], ['installed', 'installed']);
  assert.ok(fs.readFileSync(box.file(box.codex, 't-attention'), 'utf8').includes('"${TA_ATTENTION_CLI:-/opt/t agent/scripts/t-attention.js}"'));
  assert.ok(attention.status.skills.every(skill => skill.claude.current && skill.codex.current));

  const again = box.service.install('tcli');
  assert.deepEqual([again.results.claude.action, again.results.codex.action], ['unchanged', 'unchanged']);
  assert.deepEqual(fs.readdirSync(path.dirname(box.file(box.claude, 'tcli'))), ['SKILL.md'], 'no temporary file is left');
});

test('a changed source is reported as not current and updated; other files in the folder stay', () => {
  const box = sandbox({ tcliSource: TCLI_SOURCE });
  box.service.install('tcli');
  const dir = path.dirname(box.file(box.claude, 'tcli'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
  fs.writeFileSync(box.own.tcli.sourceFile, `${TCLI_SOURCE}\nOne more line.\n`);
  const state = box.service.list().skills.find(skill => skill.name === 'tcli');
  assert.equal(state.claude.installed, true);
  assert.equal(state.claude.current, false);
  const result = box.service.install('tcli');
  assert.deepEqual([result.results.claude.action, result.results.codex.action], ['updated', 'updated']);
  assert.ok(fs.readFileSync(box.file(box.codex, 'tcli'), 'utf8').endsWith('One more line.\n'));
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine');
});

test('CLAUDE_CONFIG_DIR and CODEX_HOME are respected; the terminal user decides where the skills go', () => {
  const box = sandbox({ claudeEnv: true, codexEnv: true });
  box.service.install('tcli');
  assert.ok(fs.existsSync(path.join(box.root, 'claude-config', 'skills', 'tcli', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(box.root, 'codex-home', 'skills', 'tcli', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(box.home, '.claude')) && !fs.existsSync(path.join(box.home, '.codex')));

  const userHome = path.join(box.root, 'dev-home');
  fs.mkdirSync(userHome);
  const service = skills.createAgentSkills({ env: { HOME: box.home }, homedir: () => box.home, terminalUser: () => ({ user: { name: 'dev', home: userHome, uid: process.getuid(), gid: process.getgid() } }), dataDir: box.dataDir });
  const result = service.install('tcli');
  assert.equal(result.status.user, 'dev');
  assert.equal(result.results.codex.path, path.join(userHome, '.codex', 'skills', 'tcli', 'SKILL.md'));
  assert.ok(fs.existsSync(path.join(userHome, '.claude', 'skills', 'tcli', 'SKILL.md')));
});

test('render: the tcli command runs node on this install\'s script; an unsafe path keeps the plain fallback', () => {
  const text = `run ${skills.TCLI_TOKEN} oss ls`;
  assert.equal(skills.renderSkill('tcli', text, '/a/b/tcli.js'), 'run node "${TA_TCLI:-/a/b/tcli.js}" oss ls');
  for (const bad of ['/a/"b"/t.js', '/a/$HOME/t.js', '/a/`x`/t.js', '/a/}/t.js', '/a\\b/t.js', '/a/\nb', '', null]) assert.equal(skills.renderSkill('tcli', text, bad), text, String(bad));
  assert.equal(skills.renderSkill('nope', text, '/a/b/tcli.js'), text, 'an unknown skill is left as it is');
  assert.equal(skills.renderSkill('t-attention', `x ${skills.TCLI_TOKEN}`, '/a/t.js'), `x ${skills.TCLI_TOKEN}`, 'each skill replaces only its own command');
});

test('the shell form works: with TA_TCLI it runs node on that script, without it the command on PATH, and the installed form runs node on its path', () => {
  const box = sandbox();
  const script = path.join(box.root, 'fake-tcli.js');
  fs.writeFileSync(script, 'console.log("ran " + process.argv.slice(2).join(" "));\n', { mode: 0o644 }); // not executable on purpose
  const bin = path.join(box.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tcli'), '#!/bin/sh\necho "path $*"\n', { mode: 0o755 });
  const nodeDir = path.dirname(process.execPath);
  const run = (line, extra) => execFileSync('/bin/sh', ['-c', line], { env: { PATH: `${bin}:${nodeDir}:/usr/bin:/bin`, ...extra }, encoding: 'utf8' }).trim();
  assert.equal(run(`${skills.TCLI_TOKEN} oss ls`, { TA_TCLI: script }), 'ran oss ls');
  assert.equal(run(`${skills.TCLI_TOKEN} oss ls`, {}), 'path oss ls');
  const installed = skills.renderSkill('tcli', `${skills.TCLI_TOKEN} oss ls`, script);
  assert.equal(run(installed, {}), 'ran oss ls');
  assert.equal(run(installed, { TA_TCLI: script }), 'ran oss ls');
});

test('refusals: a folder owned by the rules and skills sync, a symlinked folder or a file at its place is never written', () => {
  const box = sandbox();
  const synced = path.dirname(box.file(box.claude, 'tcli'));
  fs.mkdirSync(synced, { recursive: true });
  fs.writeFileSync(path.join(synced, 'SKILL.md'), 'synced copy');
  fs.writeFileSync(path.join(synced, skills.SYNC_MARKER), JSON.stringify({ source: { name: 'Studio' } }));
  fs.mkdirSync(path.join(box.codex, 'skills'), { recursive: true });
  const elsewhere = path.join(box.root, 'dotfiles', 'tcli');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), 'linked');
  fs.symlinkSync(elsewhere, path.join(box.codex, 'skills', 'tcli'));
  const state = box.service.list().skills.find(skill => skill.name === 'tcli');
  assert.equal(state.claude.conflict, 'rule-sync');
  assert.equal(state.claude.sync_source, 'Studio');
  assert.equal(state.codex.conflict, 'symlink');
  const result = box.service.install('tcli');
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.claude, { action: 'refused', path: box.file(box.claude, 'tcli'), conflict: 'rule-sync', sync_source: 'Studio' });
  assert.equal(result.results.codex.conflict, 'symlink');
  assert.equal(fs.readFileSync(path.join(synced, 'SKILL.md'), 'utf8'), 'synced copy');
  assert.equal(fs.readFileSync(path.join(elsewhere, 'SKILL.md'), 'utf8'), 'linked');
  // The other skill is not affected.
  assert.equal(box.service.install('t-attention').ok, true);
  fs.rmSync(path.join(box.codex, 'skills', 'tcli'));
  fs.writeFileSync(path.join(box.codex, 'skills', 'tcli'), 'a file');
  assert.equal(box.service.install('tcli').results.codex.conflict, 'not-a-directory');
});

test('an unknown skill is a 404 error, a missing source a 500 one', () => {
  const box = sandbox();
  assert.throws(() => box.service.install('task-tracker'), error => error.code === 'AGENT_SKILL_UNKNOWN' && error.statusCode === 404);
  assert.throws(() => box.service.install('__proto__'), error => error.code === 'AGENT_SKILL_UNKNOWN');
  const broken = skills.createAgentSkills({ env: box.env, homedir: () => box.home, terminalUser: () => ({ user: null }), dataDir: box.dataDir, skills: { tcli: { sourceFile: path.join(box.root, 'nope.md') } } });
  assert.throws(() => broken.install('tcli'), error => error.code === 'AGENT_SKILL_SOURCE_MISSING' && error.statusCode === 500);
  const listed = broken.list().skills;
  assert.match(listed[1].error, /^The skill file of this install is missing: .*nope\.md$/);
  assert.equal(listed[1].claude.current, false);
  assert.equal(listed[0].error, undefined);
  assert.equal(broken.install('t-attention').ok, true, 'the other skill still installs');
});

test('remove-old moves task-tracker into the backups once t-attention is in place', () => {
  const box = sandbox();
  const old = path.join(box.claude, 'skills', 'task-tracker');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'SKILL.md'), 'old');
  assert.deepEqual(box.service.list().old_task_tracker, { claude: true, codex: false });
  box.service.install('tcli');
  assert.deepEqual(box.service.removeOld().skipped.map(item => item.reason), ['not-installed', 'missing'], 'tcli does not count');
  box.service.install('t-attention');
  const result = box.service.removeOld();
  const backup = path.join(box.dataDir, 'backups', 'task-tracker-2026-11-12T10-20-30-456Z');
  assert.deepEqual(result.moved, [{ agent: 'claude', from: old, to: path.join(backup, 'claude', 'task-tracker') }]);
  assert.equal(fs.readFileSync(path.join(backup, 'claude', 'task-tracker', 'SKILL.md'), 'utf8'), 'old');
  assert.deepEqual(result.status.old_task_tracker, { claude: false, codex: false });
  assert.deepEqual(result.status.skills.map(skill => skill.name), ['t-attention', 'tcli'], 'the status is the full list');
});

test('the first installer is a view of the same files: what one installs, the other sees', () => {
  const box = sandbox();
  const old = attentionSkill.createAttentionSkill({ env: box.env, homedir: () => box.home, terminalUser: () => ({ user: null }), dataDir: box.dataDir, cliPath: '/opt/t agent/scripts/t-attention.js' });
  box.service.install('t-attention');
  const status = old.status();
  assert.deepEqual(Object.keys(status).sort(), ['claude', 'cli', 'codex', 'old_task_tracker', 'user']);
  assert.equal(status.claude.current, true, 'the same text');
  assert.equal(old.install().results.codex.action, 'unchanged');
  assert.equal(attentionSkill.AttentionSkillError, skills.AgentSkillError);
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

test('routes: the login is needed, writes need same-origin proof; list, install per skill, remove-old, and the old routes as aliases', async () => {
  const box = sandbox();
  let loggedIn = false;
  const requireAuth = (req, res, next) => (loggedIn ? next() : res.status(401).json({ error: 'AUTH_REQUIRED' }));
  const app = express();
  app.use('/api/agent-skills', createAgentSkillsRouter({ getService: () => box.service, requireAuth }));
  const oldService = attentionSkill.createAttentionSkill({ env: box.env, homedir: () => box.home, terminalUser: () => ({ user: null }), dataDir: box.dataDir });
  app.use('/api/attention/skill', createAttentionSkillRouter({ getService: () => oldService, requireAuth }));
  const server = await listen(app);
  const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
  try {
    assert.equal((await request(server, 'GET', '/api/agent-skills')).status, 401);
    assert.equal((await request(server, 'POST', '/api/agent-skills/tcli/install', XHR)).status, 401);
    assert.ok(!fs.existsSync(box.file(box.claude, 'tcli')), 'nothing written without the login');
    loggedIn = true;
    const list = await request(server, 'GET', '/api/agent-skills');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.skills.map(skill => skill.name), ['t-attention', 'tcli']);
    assert.equal((await request(server, 'POST', '/api/agent-skills/tcli/install')).body.error, 'CLIENT_ORIGIN_REQUIRED', 'a write without proof');
    assert.equal((await request(server, 'POST', '/api/agent-skills/tcli/install', { ...XHR, Origin: 'https://evil.example' })).status, 403);
    const installed = await request(server, 'POST', '/api/agent-skills/tcli/install', XHR);
    assert.equal(installed.status, 200);
    assert.equal(installed.body.name, 'tcli');
    assert.equal(installed.body.results.claude.action, 'installed');
    assert.ok(fs.existsSync(box.file(box.codex, 'tcli')));
    const unknown = await request(server, 'POST', '/api/agent-skills/nope/install', XHR);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'AGENT_SKILL_UNKNOWN');

    // The old routes: t-attention only, the old shape.
    const old = await request(server, 'GET', '/api/attention/skill');
    assert.deepEqual(Object.keys(old.body).sort(), ['claude', 'cli', 'codex', 'old_task_tracker', 'user']);
    const oldInstall = await request(server, 'POST', '/api/attention/skill/install', XHR);
    assert.equal(oldInstall.body.results.claude.action, 'installed');
    assert.equal(oldInstall.body.status.claude.current, true);
    const fresh = await request(server, 'GET', '/api/agent-skills');
    assert.equal(fresh.body.skills[0].claude.installed, true, 'the new list sees what the old route wrote');

    fs.mkdirSync(path.join(box.codex, 'skills', 'task-tracker'), { recursive: true });
    const moved = await request(server, 'POST', '/api/agent-skills/t-attention/remove-old', XHR);
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.moved.map(item => item.agent), ['codex']);
    assert.ok(Array.isArray(moved.body.status.skills));
    fs.mkdirSync(path.join(box.claude, 'skills', 'task-tracker'), { recursive: true });
    const movedOld = await request(server, 'POST', '/api/attention/skill/remove-old', XHR);
    assert.deepEqual(movedOld.body.moved.map(item => item.agent), ['claude']);
    assert.deepEqual(movedOld.body.status.old_task_tracker, { claude: false, codex: false });
    assert.equal((await request(server, 'POST', '/api/agent-skills/tcli/remove-old', XHR)).status, 404, 'remove-old belongs to t-attention');
  } finally { server.close(); }
});

test('server.js mounts the agent skills router, and the old routes before the T-Attention router', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mount = source.indexOf("app.use('/api/agent-skills', require('./routes/agent-skills').createAgentSkillsRouter());");
  const old = source.indexOf("app.use('/api/attention/skill', require('./routes/attention-skill').createAttentionSkillRouter());");
  const attention = source.indexOf("app.use('/api/attention', attentionRoutes.router);");
  const gate = source.indexOf('app.use(createLoginGate(');
  assert.ok(mount > gate && old > gate && old < attention, 'after the login gate; the old routes before the attention router');
});

// ---- The tcli skill text ----

// The commands and flags of the tcli CLI contract (scripts/tcli.js) the skill may use.
const OSS_COMMANDS = new Set(['ls', 'stat', 'get', 'put', 'cp', 'mv', 'rm', 'url']);
const FLAGS = new Set(['recursive', 'all', 'max', 'json', 'force', 'prefix', 'content-type', 'yes', 'expires']);
const SHORT_FLAGS = new Set(['o']);

test('tcli SKILL.md: valid frontmatter, only commands and flags of the CLI contract, short enough', () => {
  const lines = TCLI_SOURCE.split('\n');
  assert.ok(lines.length <= 250, `${lines.length} lines`);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(TCLI_SOURCE);
  assert.ok(match, 'frontmatter between --- lines at the top');
  const fields = Object.fromEntries(match[1].split('\n').map(line => { const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name']);
  assert.equal(fields.name, 'tcli');
  assert.ok(fields.description.length >= 100 && fields.description.length <= 500, `description of ${fields.description.length} characters (Codex takes at most 500)`);
  for (const word of ['OSS', 'upload', 'download', 'link', 'image']) assert.ok(fields.description.includes(word), word);

  // Every command after the CLI token, and every inline `oss <command>` mention.
  const calls = [...TCLI_SOURCE.matchAll(/\$\{TA_TCLI:\+node\} "\$\{TA_TCLI:-tcli\}" ([a-z]+)(?: ([a-z]+))?/g)];
  assert.ok(calls.length >= 10);
  for (const [, group, command] of calls) {
    assert.ok(group === 'oss' || group === 'help', `group ${group}`);
    if (group === 'oss') assert.ok(OSS_COMMANDS.has(command), `oss ${command}`);
  }
  const used = new Set([...TCLI_SOURCE.matchAll(/`oss ([a-z]+)/g)].map(found => found[1]));
  assert.deepEqual([...used].filter(name => !OSS_COMMANDS.has(name)), []);
  for (const name of OSS_COMMANDS) assert.ok(used.has(name), `explains oss ${name}`);
  const flags = new Set([...TCLI_SOURCE.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map(found => found[1]));
  assert.deepEqual([...flags].filter(flag => !FLAGS.has(flag)), []);
  const shorts = new Set([...TCLI_SOURCE.matchAll(/(?<=[\s`])-([a-zA-Z])(?=[\s`])/g)].map(found => found[1]));
  assert.deepEqual([...shorts].filter(flag => !SHORT_FLAGS.has(flag)), []);
  // Every rm is confirmed with --yes, and every --expires is inside 60..604800.
  for (const [line] of TCLI_SOURCE.matchAll(/^.*"\$\{TA_TCLI:-tcli\}" oss rm .*$/gm)) assert.ok(line.includes('--yes'), line);
  for (const [, seconds] of TCLI_SOURCE.matchAll(/--expires (\d+)/g)) assert.ok(Number(seconds) >= 60 && Number(seconds) <= 604800, seconds);

  // The installer can put the path in; the safety rules, the error messages and where to send the user are there.
  assert.ok(TCLI_SOURCE.includes(skills.TCLI_TOKEN));
  for (const text of ['OSS_NOT_CONFIGURED', 'OSS_AGENT_ACCESS_OFF', 'Settings → Tasks and files → Image and file upload', 'Let agent sessions manage OSS files (tcli)', 'agent/<YYYY-MM-DD>/', 'Never delete without confirmation', 'Never overwrite without confirmation', 'Never move without confirmation', 'credentials']) {
    assert.ok(TCLI_SOURCE.includes(text), text);
  }
  assert.ok(!/pm2 (?:restart|stop|delete|reload)|systemctl|launchctl/.test(TCLI_SOURCE));
  assert.ok(!/accessKeySecret|ALIBABA_CLOUD|OSS_ACCESS_KEY/i.test(TCLI_SOURCE), 'no hint at where the secret is kept');
  assert.ok(!/[\u4e00-\u9fff]/.test(TCLI_SOURCE), 'English only');
});

test('every bundled skill has a source file whose name matches its folder', () => {
  for (const skill of skills.SKILLS) {
    const source = fs.readFileSync(skill.sourceFile, 'utf8');
    assert.equal(path.basename(path.dirname(skill.sourceFile)), skill.name);
    assert.match(source, new RegExp(`^---\\nname: ${skill.name}\\n`));
    assert.ok(source.includes(skill.token), `${skill.name} uses its command token`);
  }
  assert.equal(ATTENTION.token, attentionSkill.CLI_TOKEN);
});
