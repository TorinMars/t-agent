// Rules and skills sync (services/rule-sync.js, routes/rule-sync.js): the import line, the Codex block, skills with markers, the bundle checks and caps, the
// roles, the source loop, the routes, and two real server.js processes with their own throwaway HOME. Nothing here touches the real ~/.claude or ~/.codex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const sync = require('../services/rule-sync');
const { createEngineRouter, createBrowserRouter } = require('../routes/rule-sync');

const { createRuleSync, layout, buildBundle, parseBundle, revisionOf, MARKER, CAPABILITY, IMPORT_COMMENT, CODEX_BEGIN, CODEX_END, LIMITS } = sync;
const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const RECEIVER_ID = '22222222-2222-4222-8222-222222222222';
const quiet = { error() {} };

function tempHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-rule-sync-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function database(t) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  t.after(() => db.close());
  return db;
}
const write = (file, text, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); if (mode) fs.chmodSync(file, mode); };
const read = file => fs.readFileSync(file, 'utf8');
const exists = file => { try { fs.lstatSync(file); return true; } catch { return false; } };
const modeOf = file => fs.statSync(file).mode & 0o777;
const until = async (check, label, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A machine: its own home, database and service. `env` stays empty so the defaults resolve under the throwaway home.
function machine(t, { id, name, env = {}, ...options } = {}) {
  const home = tempHome(t);
  const db = database(t);
  const service = createRuleSync({ db, env, home, identity: () => ({ instance_id: id, name }), log: quiet, timing: { pollMs: 0, retryMs: 0, debounceMs: 30 }, ...options });
  t.after(() => service.stop());
  return { home, db, service, paths: service.paths };
}

// A source with linked peers that answer through the services of other machines, as a remote Engine would (errors carry statusCode and the code).
function linkedSource(t, peersOf, options = {}) {
  const calls = [];
  const listeners = new Set();
  const links = { list: peersOf };
  const serviceLinks = {
    peers: () => links.list().map(peer => ({ id: peer.id, name: peer.name, online: peer.online !== false, baseUrl: `tunnel://${peer.id}`, token: 'tae_x', remoteServerId: 1 })),
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    noteUnauthorized() {},
  };
  const byBase = () => new Map(links.list().map(peer => [`tunnel://${peer.id}`, peer]));
  async function request(base, route, token, opts = {}) {
    const peer = byBase().get(base);
    calls.push({ peer: peer.id, route, method: opts.method || 'GET' });
    if (route === '/v1/info') return { capabilities: peer.capabilities || [CAPABILITY] };
    try {
      if (route === '/v1/rule-sync/status') return JSON.parse(JSON.stringify(peer.machine.service.receiverStatus()));
      if (route === '/v1/rule-sync/bundle' && opts.method === 'PUT') return peer.machine.service.receive(JSON.parse(JSON.stringify(opts.body)));
    } catch (error) {
      throw Object.assign(new Error(error.code || error.message), { statusCode: error.statusCode || 500 });
    }
    throw Object.assign(new Error('REMOTE_HTTP_404'), { statusCode: 404 });
  }
  const source = machine(t, { id: SOURCE_ID, name: 'Home Mac', serviceLinks, request, ...options });
  return { ...source, calls, emit: id => listeners.forEach(fn => fn(id)), puts: () => calls.filter(call => call.method === 'PUT') };
}

function sourceBundle(home, { rules = 'Use short sentences.\n', skills = {} } = {}) {
  const paths = layout({ env: {}, home });
  write(paths.sharedRules, rules);
  for (const [name, files] of Object.entries(skills)) {
    for (const [file, content] of Object.entries(files)) write(path.join(paths.skillsDir, name, file), typeof content === 'string' ? content : content.text, content.mode);
  }
  return buildBundle({ paths, skills: Object.keys(skills), source: { instance_id: SOURCE_ID, name: 'Home Mac' } });
}
// A bundle written by hand, with a correct revision, to try what a receiver refuses.
function handBundle(skills, rules = '') {
  const encoded = skills.map(skill => ({ name: skill.name, files: skill.files.map(file => ({ mode: 0o644, ...file, content_base64: file.content_base64 ?? Buffer.from(file.text || 'x').toString('base64') })) }));
  const valid = encoded.map(skill => ({ ...skill, files: skill.files.map(({ text, ...rest }) => rest) }));
  return { source: { instance_id: SOURCE_ID, name: 'Home Mac' }, revision: revisionOf(rules, valid), rules, skills: valid };
}
const refusedWith = (fn, code, status) => assert.throws(fn, error => error.code === code && (status === undefined || error.statusCode === status));

// ---- Paths, the import line and the Codex block ----

test('the import line uses ~/.claude by default and the absolute path for a custom CLAUDE_CONFIG_DIR', t => {
  const home = tempHome(t);
  assert.equal(layout({ env: {}, home }).importLine, '@~/.claude/shared/CLAUDE.shared.md');
  assert.equal(layout({ env: {}, home }).sharedRules, path.join(home, '.claude', 'shared', 'CLAUDE.shared.md'));
  const custom = path.join(home, 'elsewhere', 'claude');
  const paths = layout({ env: { CLAUDE_CONFIG_DIR: custom, CODEX_HOME: path.join(home, 'cx') }, home });
  assert.equal(paths.importLine, `@${path.join(custom, 'shared', 'CLAUDE.shared.md')}`);
  assert.equal(paths.claudeMd, path.join(custom, 'CLAUDE.md'));
  assert.equal(paths.codexAgents, path.join(home, 'cx', 'AGENTS.md'));
  assert.equal(layout({ env: { CLAUDE_CONFIG_DIR: 'relative' }, home }).claudeDir, path.join(home, '.claude'), 'a relative value is ignored');
});

test('the import line goes on top once, creates a missing CLAUDE.md, leaves the rest alone and comes out cleanly', t => {
  const a = machine(t, { id: RECEIVER_ID });
  a.service.update({ role: 'receive' });
  assert.equal(read(a.paths.claudeMd), `${IMPORT_COMMENT}\n@~/.claude/shared/CLAUDE.shared.md\n`, 'created when missing');
  a.service.update({ role: 'receive' });
  assert.equal(read(a.paths.claudeMd).split('@~/.claude/shared/CLAUDE.shared.md').length, 2, 'idempotent');
  a.service.removeImport();
  assert.equal(read(a.paths.claudeMd), '', 'the file is kept, only our lines go');

  const own = '# My rules\n\nCompany secret rule.\n';
  write(a.paths.claudeMd, own, 0o600);
  a.service.update({ role: 'source' });
  const text = read(a.paths.claudeMd);
  assert.equal(text, `${IMPORT_COMMENT}\n@~/.claude/shared/CLAUDE.shared.md\n\n${own}`);
  assert.equal(modeOf(a.paths.claudeMd), 0o600, 'the mode of the user file is kept');
  a.service.update({ codex: false });
  assert.equal(read(a.paths.claudeMd), text, 'unchanged by a second save');
  a.service.update({ role: 'off' });
  assert.equal(read(a.paths.claudeMd), text, 'turning the role off removes nothing by itself');
  assert.equal(a.service.overview().import_line_present, true);
  a.service.removeImport();
  assert.equal(read(a.paths.claudeMd), own);
  assert.equal(a.service.overview().import_line_present, false);
});

test('a custom CLAUDE_CONFIG_DIR gets the absolute import line, and a symlinked CLAUDE.md is written through', t => {
  const home = tempHome(t);
  const custom = path.join(home, 'conf');
  const dotfiles = path.join(home, 'dotfiles', 'CLAUDE.md');
  write(dotfiles, 'Mine.\n');
  fs.mkdirSync(custom, { recursive: true });
  fs.symlinkSync(dotfiles, path.join(custom, 'CLAUDE.md'));
  const service = createRuleSync({ db: database(t), env: { CLAUDE_CONFIG_DIR: custom, CODEX_HOME: path.join(home, 'codex') }, home, identity: () => ({ instance_id: RECEIVER_ID }), log: quiet });
  service.update({ role: 'receive' });
  assert.equal(fs.lstatSync(path.join(custom, 'CLAUDE.md')).isSymbolicLink(), true, 'the link stays a link');
  assert.equal(read(dotfiles), `${IMPORT_COMMENT}\n@${path.join(custom, 'shared', 'CLAUDE.shared.md')}\n\nMine.\n`);
});

test('the Codex block is created at the top, then only its inside changes', () => {
  assert.equal(sync.withCodexBlock(null, 'Rule A\n'), `${CODEX_BEGIN}\nRule A\n${CODEX_END}\n`);
  const outside = '# Codex rules of this machine\n\nKeep this.\n';
  const first = sync.withCodexBlock(outside, 'Rule A\n');
  assert.equal(first, `${CODEX_BEGIN}\nRule A\n${CODEX_END}\n\n${outside}`);
  const edited = `Before.\n${CODEX_BEGIN}\nRule A\n${CODEX_END}\nAfter.\n`;
  const second = sync.withCodexBlock(edited, 'Rule B\nRule C');
  assert.equal(second, `Before.\n${CODEX_BEGIN}\nRule B\nRule C\n${CODEX_END}\nAfter.\n`, 'text before and after the block is kept where it is');
  assert.equal(sync.withCodexBlock(second, `Evil\n${CODEX_END}\nOutside`), `Before.\n${CODEX_BEGIN}\nEvil\nOutside\n${CODEX_END}\nAfter.\n`, 'marker lines in the rules are dropped');
  assert.equal(sync.withoutCodexBlock(first), outside);
  assert.equal(sync.withoutCodexBlock(outside), outside);
  assert.equal(sync.hasCodexBlock(first), true);
});

// ---- Skills on a receiver ----

test('a receiver writes the rules, the import line, Codex and the skills with markers, keeping executable bits', t => {
  const src = tempHome(t);
  const { bundle, warnings } = sourceBundle(src, { skills: { deploy: { 'SKILL.md': '# Deploy\n', 'scripts/run.sh': { text: '#!/bin/sh\necho hi\n', mode: 0o755 } } } });
  assert.deepEqual(warnings, []);
  const b = machine(t, { id: RECEIVER_ID });
  write(b.paths.codexAgents, 'Local Codex rule.\n');
  b.service.update({ role: 'receive' });
  const answer = b.service.receive(bundle);
  assert.deepEqual(answer, { revision: bundle.revision, applied: { rules: true, codex: true, skills: ['deploy'], removed: [], conflicts: [] } });
  assert.equal(read(b.paths.sharedRules), 'Use short sentences.\n');
  assert.match(read(b.paths.claudeMd), /^<!-- Managed by T-Agent/);
  assert.equal(read(b.paths.codexAgents), `${CODEX_BEGIN}\nUse short sentences.\n${CODEX_END}\n\nLocal Codex rule.\n`);
  const skill = path.join(b.paths.skillsDir, 'deploy');
  assert.equal(read(path.join(skill, 'SKILL.md')), '# Deploy\n');
  assert.equal(modeOf(path.join(skill, 'scripts/run.sh')), 0o755);
  assert.equal(modeOf(path.join(skill, 'SKILL.md')), 0o644);
  assert.equal(modeOf(skill), 0o755);
  const marker = JSON.parse(read(path.join(skill, MARKER)));
  assert.deepEqual(marker.source, { instance_id: SOURCE_ID, name: 'Home Mac' });
  assert.equal(marker.revision, bundle.revision);
  assert.ok(marker.synced_at);
  const status = b.service.receiverStatus();
  assert.deepEqual(status.following, { instance_id: SOURCE_ID, name: 'Home Mac' });
  assert.equal(status.revision, bundle.revision);
  assert.deepEqual(fs.readdirSync(b.paths.skillsDir), ['deploy'], 'no temporary folder is left');

  b.service.update({ codex: false });
  const again = sourceBundle(src, { rules: 'Changed.\n', skills: { deploy: { 'SKILL.md': '# Deploy\n' } } }).bundle;
  assert.equal(b.service.receive(again).applied.codex, false);
  assert.match(read(b.paths.codexAgents), /Use short sentences/, 'with Codex off the block is left as it was');
});

test('an unmarked local skill is a conflict and never overwritten; only marked folders are removed', t => {
  const src = tempHome(t);
  const b = machine(t, { id: RECEIVER_ID });
  b.service.update({ role: 'receive' });
  const local = path.join(b.paths.skillsDir, 'company');
  write(path.join(local, 'SKILL.md'), 'Company only.\n');
  const outside = path.join(b.home, 'outside-skill');
  write(path.join(outside, MARKER), JSON.stringify({ revision: 'x' }));
  write(path.join(outside, 'keep.md'), 'keep');
  fs.symlinkSync(outside, path.join(b.paths.skillsDir, 'linked'));

  const first = sourceBundle(src, { skills: { company: { 'SKILL.md': 'Shared.\n' }, linked: { 'SKILL.md': 'x' }, old: { 'SKILL.md': 'old' }, keep: { 'SKILL.md': 'k' } } }).bundle;
  const answer = b.service.receive(first);
  assert.deepEqual(answer.applied.skills, ['keep', 'old']);
  assert.deepEqual(answer.applied.conflicts, [{ skill: 'company', reason: 'local' }, { skill: 'linked', reason: 'symlink' }]);
  assert.equal(read(path.join(local, 'SKILL.md')), 'Company only.\n', 'the local skill is untouched');
  assert.equal(exists(path.join(local, MARKER)), false);
  assert.deepEqual(b.service.receiverStatus().conflicts, answer.applied.conflicts);

  fs.rmSync(path.join(src, '.claude', 'skills', 'old'), { recursive: true });
  const second = buildBundle({ paths: layout({ env: {}, home: src }), skills: ['company', 'keep'], source: { instance_id: SOURCE_ID, name: 'Home Mac' } }).bundle;
  const next = b.service.receive(second);
  assert.deepEqual(next.applied.removed, ['old'], 'a marked folder that left the bundle is removed');
  assert.deepEqual(next.applied.skills, [], 'an unchanged skill is not rewritten');
  assert.equal(exists(path.join(b.paths.skillsDir, 'old')), false);
  assert.equal(exists(local), true, 'the unmarked folder is never removed');
  assert.equal(exists(path.join(outside, 'keep.md')), true, 'a symlinked folder is never followed');
  assert.equal(exists(path.join(b.paths.skillsDir, 'linked')), true);
});

test('a receiver refuses traversal, absolute paths, bad names and a wrong revision before writing anything', t => {
  const b = machine(t, { id: RECEIVER_ID });
  b.service.update({ role: 'receive' });
  const bad = [
    [{ name: 'x', files: [{ path: '../escape.md' }] }],
    [{ name: 'x', files: [{ path: 'a/../../escape.md' }] }],
    [{ name: 'x', files: [{ path: '/etc/passwd' }] }],
    [{ name: 'x', files: [{ path: 'C:/x' }] }],
    [{ name: 'x', files: [{ path: 'a\\b' }] }],
    [{ name: 'x', files: [{ path: 'a//b' }] }],
    [{ name: 'x', files: [{ path: './a' }] }],
    [{ name: 'x', files: [{ path: MARKER }] }],
    [{ name: 'x', files: [{ path: 'a' }, { path: 'a/b' }] }],
    [{ name: 'x', files: [{ path: 'a' }, { path: 'a' }] }],
    [{ name: '..', files: [] }],
    [{ name: '.', files: [] }],
    [{ name: 'a/b', files: [] }],
    [{ name: 'x'.repeat(65), files: [] }],
    [{ name: '.t-agent-sync-new', files: [] }],
    [{ name: 'x', files: [] }, { name: 'x', files: [] }],
    [{ name: 'x', files: [{ path: 'a', content_base64: 'not base64!' }] }],
  ];
  for (const skills of bad) refusedWith(() => b.service.receive(handBundle(skills)), 'RULE_SYNC_INVALID_BUNDLE', 400);
  const good = handBundle([{ name: 'x', files: [{ path: 'a.md' }] }]);
  refusedWith(() => b.service.receive({ ...good, revision: 'f'.repeat(64) }), 'RULE_SYNC_INVALID_BUNDLE', 400);
  refusedWith(() => b.service.receive({ ...good, source: { instance_id: '../x' } }), 'RULE_SYNC_INVALID_BUNDLE', 400);
  refusedWith(() => b.service.receive({ ...good, skills: 'x' }), 'RULE_SYNC_INVALID_BUNDLE', 400);
  assert.equal(exists(b.paths.sharedRules), false, 'nothing was written');
  assert.equal(exists(path.join(b.home, 'escape.md')), false);
  assert.equal(b.service.receiverStatus().following, null, 'a refused bundle does not choose a source');
});

test('the caps: file size, files per skill, skill count and total size are refused on both sides', t => {
  const b = machine(t, { id: RECEIVER_ID });
  b.service.update({ role: 'receive' });
  const big = Buffer.alloc(LIMITS.fileBytes + 1, 1).toString('base64');
  const cap = (skills, limit, rules) => assert.throws(() => b.service.receive(handBundle(skills, rules)), error => error.code === 'RULE_SYNC_TOO_LARGE' && error.statusCode === 413 && error.extra.limit === limit);
  cap([{ name: 'x', files: [{ path: 'big', content_base64: big }] }], 'file');
  cap([{ name: 'x', files: Array.from({ length: LIMITS.filesPerSkill + 1 }, (_, i) => ({ path: `f${i}` })) }], 'files');
  cap(Array.from({ length: LIMITS.skills + 1 }, (_, i) => ({ name: `s${i}`, files: [] })), 'skills');
  const mib = Buffer.alloc(LIMITS.fileBytes, 2).toString('base64');
  cap(Array.from({ length: 21 }, (_, i) => ({ name: `s${i}`, files: [{ path: 'f', content_base64: mib }] })), 'total');
  cap([], 'file', 'x'.repeat(LIMITS.fileBytes + 1));

  // The source refuses before sending.
  const src = tempHome(t);
  const paths = layout({ env: {}, home: src });
  write(path.join(paths.skillsDir, 'huge', 'big.bin'), Buffer.alloc(LIMITS.fileBytes + 1));
  assert.throws(() => buildBundle({ paths, skills: ['huge'], source: { instance_id: SOURCE_ID } }), error => error.code === 'RULE_SYNC_TOO_LARGE' && error.extra.item === 'huge/big.bin');
  for (let i = 0; i <= LIMITS.filesPerSkill; i += 1) write(path.join(paths.skillsDir, 'many', `f${i}`), 'x');
  assert.throws(() => buildBundle({ paths, skills: ['many'], source: { instance_id: SOURCE_ID } }), error => error.extra.limit === 'files');
});

test('the source skips symlinks inside a skill with a warning and never sends the marker file', t => {
  const src = tempHome(t);
  const paths = layout({ env: {}, home: src });
  write(path.join(paths.skillsDir, 'tool', 'SKILL.md'), 'ok');
  write(path.join(paths.skillsDir, 'tool', MARKER), '{"revision":"x"}');
  write(path.join(paths.skillsDir, 'tool', '.git', 'HEAD'), 'ref');
  write(path.join(src, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(src, 'secret.txt'), path.join(paths.skillsDir, 'tool', 'leak.txt'));
  fs.symlinkSync(path.join(paths.skillsDir, 'tool'), path.join(paths.skillsDir, 'alias'));
  const { bundle, warnings } = buildBundle({ paths, skills: ['tool', 'alias', 'gone'], source: { instance_id: SOURCE_ID } });
  assert.deepEqual(bundle.skills.map(skill => skill.name), ['tool']);
  assert.deepEqual(bundle.skills[0].files.map(file => file.path), ['SKILL.md']);
  assert.deepEqual(warnings, [{ skill: 'alias', warning: 'symlink' }, { skill: 'gone', warning: 'missing' }, { skill: 'tool', path: 'leak.txt', warning: 'symlink' }]);
  assert.doesNotThrow(() => parseBundle(JSON.parse(JSON.stringify(bundle))), 'what the source builds, the receiver accepts');
});

// ---- Roles ----

test('only a receiver accepts bundles; a second source gets 409 until the user resets the followed source', t => {
  const src = tempHome(t);
  const { bundle } = sourceBundle(src);
  const b = machine(t, { id: RECEIVER_ID });
  refusedWith(() => b.service.receive(bundle), 'RULE_SYNC_NOT_RECEIVING', 403);
  b.service.update({ role: 'source' });
  refusedWith(() => b.service.receive(bundle), 'RULE_SYNC_NOT_RECEIVING', 403);
  b.service.update({ role: 'receive' });
  b.service.receive(bundle);
  const other = { ...bundle, source: { instance_id: OTHER_ID, name: 'Other' } };
  assert.throws(() => b.service.receive(other), error => error.code === 'RULE_SYNC_OTHER_SOURCE' && error.statusCode === 409 && error.extra.following.name === 'Home Mac');
  assert.equal(b.service.overview().following.instance_id, SOURCE_ID);
  b.service.resetSource();
  assert.equal(b.service.receiverStatus().following, null);
  b.service.receive(other);
  assert.equal(b.service.receiverStatus().following.name, 'Other');
});

test('settings are checked and echoed', t => {
  const a = machine(t, { id: SOURCE_ID });
  const view = a.service.overview();
  assert.equal(view.role, 'off');
  assert.equal(view.codex, true);
  assert.equal(view.shared_rules_exists, false);
  assert.equal(view.shared_rules_path, path.join(a.home, '.claude', 'shared', 'CLAUDE.shared.md'));
  for (const body of [{ role: 'boss' }, { codex: 'yes' }, { skills: ['../x'] }, { skills: 'x' }, null]) refusedWith(() => a.service.update(body), 'RULE_SYNC_INVALID_SETTINGS', 400);
  write(path.join(a.paths.skillsDir, 'alpha', 'SKILL.md'), 'a');
  fs.symlinkSync(path.join(a.paths.skillsDir, 'alpha'), path.join(a.paths.skillsDir, 'beta'));
  const saved = a.service.update({ role: 'source', skills: ['alpha', 'alpha', 'zeta'], codex: false });
  assert.equal(saved.role, 'source');
  assert.equal(saved.codex, false);
  assert.deepEqual(saved.skills, [{ name: 'alpha', synced: false, shared: true }, { name: 'beta', symlink: true, shared: false }, { name: 'zeta', shared: true, missing: true }]);
  assert.equal(a.service.createShared().shared_rules_exists, true);
  write(a.paths.sharedRules, 'Mine.\n');
  a.service.createShared();
  assert.equal(read(a.paths.sharedRules), 'Mine.\n', 'an existing shared file is never replaced');
  assert.equal(exists(a.paths.codexAgents), false, 'Codex off on the source: its AGENTS.md is left alone');
});

// ---- The source loop ----

test('the source pushes only to linked receivers, and a receiver never pushes', async t => {
  const receiver = machine(t, { id: RECEIVER_ID });
  const idle = machine(t, { id: OTHER_ID });
  receiver.service.update({ role: 'receive' });
  const old = { id: 'old', name: 'Old', capabilities: ['tasks:read'] };
  const peers = [{ id: 'r', name: 'Office', machine: receiver }, { id: 'i', name: 'Laptop', machine: idle }, old];
  const a = linkedSource(t, () => peers);
  write(a.paths.sharedRules, 'Shared.\n');
  a.service.update({ role: 'source' });
  await a.service.pushAll();
  assert.deepEqual(a.puts().map(call => call.peer), ['r'], 'only the receiver gets a bundle');
  assert.equal(read(receiver.paths.sharedRules), 'Shared.\n');
  assert.equal(exists(idle.paths.sharedRules), false);
  const targets = Object.fromEntries(a.service.overview().targets.map(target => [target.id, target]));
  assert.equal(targets.r.status, 'up-to-date');
  assert.equal(targets.r.revision, a.service.overview().revision);
  assert.ok(targets.r.last_push_at);
  assert.equal(targets.i.status, 'not-receiving');
  assert.equal(targets.i.role, 'off');
  assert.equal(targets.old.status, 'unsupported');
  assert.equal(a.calls.filter(call => call.peer === 'old' && call.route !== '/v1/info').length, 0, 'an older Engine is only asked what it can do');

  // Same revision: asked, not pushed again.
  await a.service.pushAll();
  assert.equal(a.puts().length, 1);

  // A receiving machine with links never sends anything.
  const b = linkedSource(t, () => [{ id: 'a', name: 'Home', machine: a }]);
  b.service.update({ role: 'receive' });
  await b.service.pushAll();
  await b.service.check();
  await b.service.retry();
  await assert.rejects(b.service.pushNow(), error => error.code === 'RULE_SYNC_NOT_SOURCE');
  assert.deepEqual(b.calls, []);
});

test('a receiver that follows another source is not pushed to, and a 409 shows as other-source', async t => {
  const receiver = machine(t, { id: RECEIVER_ID });
  receiver.service.update({ role: 'receive' });
  receiver.service.receive({ ...sourceBundle(tempHome(t)).bundle, source: { instance_id: OTHER_ID, name: 'Other' } });
  const a = linkedSource(t, () => [{ id: 'r', name: 'Office', machine: receiver }]);
  a.service.update({ role: 'source' });
  await a.service.pushNow();
  assert.equal(a.puts().length, 0);
  assert.equal(a.service.overview().targets[0].status, 'other-source');
  assert.equal(a.service.overview().targets[0].last_error, 'RULE_SYNC_OTHER_SOURCE');
});

test('a change is pushed once after the debounce, and a bundle over a cap is reported and not sent', async t => {
  const receiver = machine(t, { id: RECEIVER_ID });
  receiver.service.update({ role: 'receive' });
  const watchers = [];
  const watch = (dir, options, onEvent) => { const watcher = Object.assign(new EventEmitter(), { dir, close() {} }); watchers.push({ dir, onEvent }); return watcher; };
  const a = linkedSource(t, () => [{ id: 'r', name: 'Office', machine: receiver }], { watch, timing: { pollMs: 0, retryMs: 0, debounceMs: 60 } });
  write(a.paths.sharedRules, 'One.\n');
  write(path.join(a.paths.skillsDir, 'tool', 'SKILL.md'), 'tool');
  a.service.update({ role: 'source', skills: ['tool'] });
  a.service.start();
  await until(() => a.puts().length === 1, 'first push');
  assert.deepEqual(watchers.map(item => item.dir).sort(), [path.dirname(a.paths.sharedRules), path.join(a.paths.skillsDir, 'tool')].sort());

  for (const text of ['Two.\n', 'Three.\n', 'Four.\n']) {
    write(a.paths.sharedRules, text);
    watchers.forEach(item => item.onEvent('change'));
    await sleep(10);
  }
  await until(() => a.puts().length === 2, 'the change was pushed');
  await sleep(200);
  assert.equal(a.puts().length, 2, 'several events within the debounce make one push');
  assert.equal(read(receiver.paths.sharedRules), 'Four.\n');
  assert.ok(a.service.overview().last_change_at);
  // An event without a content change pushes nothing.
  watchers.forEach(item => item.onEvent('change'));
  await sleep(200);
  assert.equal(a.puts().length, 2);

  write(path.join(a.paths.skillsDir, 'tool', 'big.bin'), Buffer.alloc(LIMITS.fileBytes + 1));
  watchers.forEach(item => item.onEvent('change'));
  await until(() => a.service.overview().targets[0].last_error === 'RULE_SYNC_TOO_LARGE', 'the cap is reported on the target');
  assert.deepEqual(a.service.overview().bundle_error, { code: 'RULE_SYNC_TOO_LARGE', limit: 'file', item: 'tool/big.bin' });
  assert.equal(a.puts().length, 2, 'nothing over a cap is sent');
});

test('a receiver that comes online is pushed to at once; a failed push is retried', async t => {
  const receiver = machine(t, { id: RECEIVER_ID });
  receiver.service.update({ role: 'receive' });
  const peer = { id: 'r', name: 'Office', machine: receiver, online: false };
  const a = linkedSource(t, () => [peer], { timing: { pollMs: 0, retryMs: 80, debounceMs: 30 } });
  write(a.paths.sharedRules, 'Rules.\n');
  a.service.update({ role: 'source' });
  a.service.start();
  await sleep(150);
  assert.deepEqual(a.calls, [], 'an offline peer is not called');
  assert.equal(a.service.overview().targets[0].status, 'offline');

  peer.online = true;
  receiver.service.update({ role: 'off' }); // not receiving yet: asked, not pushed
  a.emit('r');
  await until(() => a.service.overview().targets[0].status === 'not-receiving', 'asked when it came online');
  assert.equal(a.puts().length, 0);
  receiver.service.update({ role: 'receive' });
  await until(() => a.puts().length === 1, 'the retry found it receiving');
  assert.equal(read(receiver.paths.sharedRules), 'Rules.\n');
  const calls = a.calls.length;
  await sleep(250);
  assert.equal(a.puts().length, 1, 'an up-to-date peer is not pushed again');
  assert.equal(a.calls.length, calls, 'and not asked again by the retry');
});

// ---- Routes ----

async function listen(t, app) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, route, body, headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }) => {
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed };
  };
}

test('routes: the browser router needs a login and the same origin; the Engine router needs its guard', async t => {
  const b = machine(t, { id: RECEIVER_ID });
  const app = express();
  let loggedIn = false;
  const requireAuth = (req, res, next) => (loggedIn ? next() : res.status(401).json({ error: 'AUTH_REQUIRED' }));
  const guard = (req, res, next) => (req.get('authorization') === 'Bearer good' ? next() : res.status(401).json({ error: 'ENGINE_TOKEN_REQUIRED' }));
  app.use('/api/rule-sync', createBrowserRouter({ getService: () => b.service, requireAuth }));
  app.use('/v1/rule-sync', createEngineRouter({ getService: () => b.service, guard }));
  const call = await listen(t, app);

  assert.equal((await call('GET', '/api/rule-sync')).status, 401);
  assert.equal((await call('PUT', '/api/rule-sync', { role: 'receive' })).status, 401);
  loggedIn = true;
  assert.equal((await call('PUT', '/api/rule-sync', { role: 'receive' }, { 'Content-Type': 'application/json' })).status, 403, 'a write needs the same-origin header');
  assert.equal((await call('PUT', '/api/rule-sync', { role: 'receive' })).body.role, 'receive');
  assert.equal((await call('PUT', '/api/rule-sync', { role: 'x' })).body.error, 'RULE_SYNC_INVALID_SETTINGS');
  assert.equal((await call('POST', '/api/rule-sync/push', {})).status, 403);

  const { bundle } = sourceBundle(tempHome(t));
  const engine = { 'Content-Type': 'application/json', Authorization: 'Bearer good' };
  assert.equal((await call('GET', '/v1/rule-sync/status', undefined, {})).status, 401);
  assert.equal((await call('PUT', '/v1/rule-sync/bundle', bundle, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal(exists(b.paths.sharedRules), false, 'nothing is written without the token');
  const put = await call('PUT', '/v1/rule-sync/bundle', bundle, engine);
  assert.equal(put.status, 200);
  assert.equal(put.body.revision, bundle.revision);
  const status = await call('GET', '/v1/rule-sync/status', undefined, engine);
  assert.deepEqual(Object.keys(status.body).sort(), ['codex', 'conflicts', 'following', 'revision', 'role', 'synced_at']);
  const other = await call('PUT', '/v1/rule-sync/bundle', { ...bundle, source: { instance_id: OTHER_ID, name: 'X' } }, engine);
  assert.equal(other.status, 409);
  assert.equal(other.body.error, 'RULE_SYNC_OTHER_SOURCE');
  assert.equal(other.body.following.name, 'Home Mac');
  assert.equal((await call('POST', '/api/rule-sync/reset-source', {})).body.following, null);
  assert.equal((await call('PUT', '/v1/rule-sync/bundle', { ...bundle, source: { instance_id: OTHER_ID, name: 'X' } }, engine)).status, 200);
  assert.equal((await call('PUT', '/api/rule-sync', { role: 'off' })).body.role, 'off');
  assert.equal((await call('PUT', '/v1/rule-sync/bundle', bundle, engine)).body.error, 'RULE_SYNC_NOT_RECEIVING');
  assert.equal((await call('POST', '/api/rule-sync/remove-import', {})).body.import_line_present, false);
  assert.equal((await call('GET', '/v1/rule-sync/bundle', undefined, engine)).status, 404, 'nothing reads a bundle back');
});

// ---- Two real services ----

const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
async function startService(t, extraEnv = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-rule-sync-e2e-')));
  const home = path.join(temp, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TAGENT_HOME']) delete env[key];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
      HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'rule-sync-test-secret-'.repeat(3), T_AGENT_DATA_DIR: path.join(temp, 'data'),
      T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local', ...extraEnv,
    },
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
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url, home, claude: path.join(home, '.claude'),
    async call(method, route, body, headers = HEADERS) {
      const response = await fetch(`${url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed, text };
    },
  };
}

test('two real services: the source shares rules and a skill over the link, and the receiver keeps its own', async t => {
  const [a, b] = await Promise.all([startService(t), startService(t)]);
  // The Engine API of the receiver needs a token, and advertises the capability.
  assert.equal((await b.call('GET', '/v1/rule-sync/status', undefined, {})).status, 401);
  assert.equal((await b.call('PUT', '/v1/rule-sync/bundle', {}, { 'Content-Type': 'application/json' })).status, 401);
  const token = (await b.call('POST', '/api/remote-tokens', { name: 'test' })).body.token;
  const info = await b.call('GET', '/v1/info', undefined, { Authorization: `Bearer ${token}` });
  assert.ok(info.body.capabilities.includes(CAPABILITY));
  assert.equal((await b.call('GET', '/api/rule-sync', undefined, { Origin: 'http://evil.example.test' })).status, 403);

  const made = await a.call('POST', '/api/service-links/code', {});
  const joined = await b.call('POST', '/api/service-links/join', { url: a.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, joined.text);
  await until(async () => (await a.call('GET', '/api/service-links')).body.links[0]?.online && (await b.call('GET', '/api/service-links')).body.links[0]?.online, 'linked', 10000);

  write(path.join(b.claude, 'CLAUDE.md'), 'Company rule.\n');
  write(path.join(b.claude, 'skills', 'company', 'SKILL.md'), 'Company skill.\n');
  write(path.join(a.claude, 'skills', 'shared-tool', 'SKILL.md'), '# Shared tool\n');
  write(path.join(a.claude, 'skills', 'shared-tool', 'run.sh'), '#!/bin/sh\n', 0o755);
  write(path.join(a.claude, 'skills', 'private', 'SKILL.md'), 'Not shared.\n');
  write(path.join(a.claude, 'skills', 'company', 'SKILL.md'), 'Would clash.\n');
  assert.equal((await b.call('PUT', '/api/rule-sync', { role: 'receive' })).body.role, 'receive');
  assert.equal((await a.call('POST', '/api/rule-sync/create-shared', {})).body.shared_rules_exists, true);
  fs.appendFileSync(path.join(a.claude, 'shared', 'CLAUDE.shared.md'), 'Shared rule one.\n');
  const set = await a.call('PUT', '/api/rule-sync', { role: 'source', skills: ['shared-tool', 'company'] });
  assert.equal(set.status, 200, set.text);

  await until(async () => {
    const view = (await a.call('GET', '/api/rule-sync')).body;
    return view.targets.length === 1 && view.targets[0].status === 'up-to-date' && view.targets[0].revision === view.revision;
  }, 'the receiver is up to date', 15000);
  const shared = read(path.join(b.claude, 'shared', 'CLAUDE.shared.md'));
  assert.match(shared, /Shared rule one\./);
  assert.equal(read(path.join(b.claude, 'CLAUDE.md')), `${IMPORT_COMMENT}\n@~/.claude/shared/CLAUDE.shared.md\n\nCompany rule.\n`);
  assert.match(read(path.join(b.home, '.codex', 'AGENTS.md')), /Shared rule one\./);
  assert.match(read(path.join(a.home, '.codex', 'AGENTS.md')), /Shared rule one\./, 'the source has the block too');
  assert.equal(read(path.join(b.claude, 'skills', 'shared-tool', 'SKILL.md')), '# Shared tool\n');
  assert.equal(modeOf(path.join(b.claude, 'skills', 'shared-tool', 'run.sh')), 0o755);
  assert.equal(exists(path.join(b.claude, 'skills', 'private')), false, 'an unchosen skill is not sent');
  assert.equal(read(path.join(b.claude, 'skills', 'company', 'SKILL.md')), 'Company skill.\n', 'the company skill is untouched');
  const view = (await a.call('GET', '/api/rule-sync')).body;
  assert.deepEqual(view.targets[0].conflicts, [{ skill: 'company', reason: 'local' }]);
  const onB = (await b.call('GET', '/api/rule-sync')).body;
  assert.equal(onB.following.instance_id.length, 36);
  assert.equal(onB.targets.length, 0, 'a receiver lists no targets');
  // The receiver never sends: its own files never reach the source.
  assert.doesNotMatch(read(path.join(a.claude, 'CLAUDE.md')), /Company rule/);
  assert.equal(read(path.join(a.claude, 'skills', 'company', 'SKILL.md')), 'Would clash.\n');

  // Sync now pushes the edited file at once.
  fs.appendFileSync(path.join(a.claude, 'shared', 'CLAUDE.shared.md'), 'Shared rule two.\n');
  const pushed = await a.call('POST', '/api/rule-sync/push', {});
  assert.equal(pushed.status, 200, pushed.text);
  assert.match(read(path.join(b.claude, 'shared', 'CLAUDE.shared.md')), /Shared rule two\./);
});
