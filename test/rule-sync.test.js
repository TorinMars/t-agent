// Rules and skills sync (services/rule-sync.js, routes/rule-sync.js): the import line, the Codex block, skills with markers, the bundle checks and caps, the
// roles, the source loop, the routes, and two real server.js processes with their own throwaway HOME. Nothing here touches the real ~/.claude or ~/.codex.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const sync = require('../services/rule-sync');
const { createEngineRouter, createBrowserRouter } = require('../routes/rule-sync');

const { createRuleSync, layout, buildBundle, parseBundle, revisionOf, syncedNotice, withoutNotice, MARKER, CAPABILITY, EDIT_CAPABILITY, IMPORT_COMMENT, CODEX_BEGIN, CODEX_END, LIMITS } = sync;
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
// The rules a receiver wrote, without the notice line on top.
const rulesOf = file => withoutNotice(read(file));
const HOME_NOTICE = syncedNotice('Home Mac');

// A machine: its own home, database, data folder and service. `env` stays empty so the defaults resolve under the throwaway home.
function machine(t, { id, name, env = {}, ...options } = {}) {
  const home = tempHome(t);
  const db = database(t);
  const dataDir = path.join(home, 'tagent-data');
  const service = createRuleSync({ db, env, home, dataDir, identity: () => ({ instance_id: id, name }), log: quiet, timing: { pollMs: 0, retryMs: 0, debounceMs: 30, guardPollMs: 0, guardDebounceMs: 30 }, ...options });
  t.after(() => service.stop());
  return { home, db, dataDir, service, paths: service.paths };
}

// A machine with linked peers that answer through the services of other machines, as a remote Engine would (errors carry statusCode, the code and the
// JSON body). A peer: { id, name, machine, online?, instanceId?, capabilities?, unreachable? }.
function linkedSource(t, peersOf, options = {}) {
  return linkedMachine(t, peersOf, { id: SOURCE_ID, name: 'Home Mac', ...options });
}
function linkedMachine(t, peersOf, { id, name, ...options }) {
  const calls = [];
  const listeners = new Set();
  const links = { list: peersOf };
  const serviceLinks = {
    peers: () => links.list().map((peer, index) => ({ id: peer.id, name: peer.name, online: peer.online !== false, baseUrl: `tunnel://${peer.id}`, token: 'tae_x', remoteServerId: index + 1, instanceId: peer.instanceId || null })),
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    noteUnauthorized() {},
  };
  const byBase = () => new Map(links.list().map(peer => [`tunnel://${peer.id}`, peer]));
  async function request(base, route, token, opts = {}) {
    const peer = byBase().get(base);
    calls.push({ peer: peer.id, route, method: opts.method || 'GET', body: opts.body });
    // A tunnel that is down: an error without a status, as services/remote-client.js gives.
    if (peer.unreachable) throw new Error('LINK_OFFLINE');
    if (route === '/v1/info') return { capabilities: peer.capabilities || [CAPABILITY, EDIT_CAPABILITY] };
    if (peer.capabilities && !peer.capabilities.includes(EDIT_CAPABILITY) && route === '/v1/rule-sync/shared') throw Object.assign(new Error('REMOTE_HTTP_404'), { statusCode: 404 });
    try {
      if (route === '/v1/rule-sync/status') return JSON.parse(JSON.stringify(peer.machine.service.receiverStatus()));
      if (route === '/v1/rule-sync/bundle' && opts.method === 'PUT') return peer.machine.service.receive(JSON.parse(JSON.stringify(opts.body)));
      if (route === '/v1/rule-sync/shared' && opts.method === 'PUT') return peer.machine.service.writeShared(JSON.parse(JSON.stringify(opts.body)));
      if (route === '/v1/rule-sync/shared') return peer.machine.service.readShared();
    } catch (error) {
      const body = error.code ? { error: error.code, ...error.extra } : null;
      throw Object.assign(new Error(error.code || error.message), { statusCode: error.statusCode || 500, peerBody: body });
    }
    throw Object.assign(new Error('REMOTE_HTTP_404'), { statusCode: 404 });
  }
  const source = machine(t, { id, name, serviceLinks, request, ...options });
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
  assert.equal(read(b.paths.sharedRules), `${HOME_NOTICE}\n\nUse short sentences.\n`, 'the notice on top says where to edit');
  assert.match(read(b.paths.claudeMd), /^<!-- Managed by T-Agent/);
  assert.equal(read(b.paths.codexAgents), `${CODEX_BEGIN}\n${HOME_NOTICE}\nUse short sentences.\n${CODEX_END}\n\nLocal Codex rule.\n`, 'the same notice is the first line in the block');
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
  assert.equal(rulesOf(receiver.paths.sharedRules), 'Shared.\n');
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
  assert.equal(rulesOf(receiver.paths.sharedRules), 'Four.\n');
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
  assert.equal(rulesOf(receiver.paths.sharedRules), 'Rules.\n');
  const calls = a.calls.length;
  await sleep(250);
  assert.equal(a.puts().length, 1, 'an up-to-date peer is not pushed again');
  assert.equal(a.calls.length, calls, 'and not asked again by the retry');
});

// ---- The notice on a receiver ----

test('a receiver puts the notice on top of the shared rules; the bundle revision is over the rules only', t => {
  const { bundle } = sourceBundle(tempHome(t), { rules: 'Rule one.\n' });
  const b = machine(t, { id: RECEIVER_ID });
  b.service.update({ role: 'receive' });
  b.service.receive(bundle);
  const text = read(b.paths.sharedRules);
  assert.equal(text.split('\n')[0], HOME_NOTICE);
  assert.match(HOME_NOTICE, /^<!-- Synced by T-Agent from Home Mac\. Edit it on Home Mac or in the T-Agent page \(Settings > Rules and skills sync\); changes made here are replaced\. -->$/);
  assert.equal(b.service.receiverStatus().revision, revisionOf('Rule one.\n', []));
  assert.equal(bundle.revision, revisionOf('Rule one.\n', []), 'the header is not in the revision');
  // A receiver that becomes the source sends the rules without its old notice, so the revision is the same.
  b.service.update({ role: 'source' });
  assert.equal(b.service.overview().revision, bundle.revision);
  assert.equal(b.service.readShared().content, 'Rule one.\n');
  assert.equal(syncedNotice('Evil --> name\nnext'), '<!-- Synced by T-Agent from Evil - name next. Edit it on Evil - name next or in the T-Agent page (Settings > Rules and skills sync); changes made here are replaced. -->', 'a name cannot end the comment or break the line');
  assert.match(syncedNotice(''), /from the source\./);
});

// ---- Editing the shared rules on the source ----

test('the source reads and writes its shared rules: atomic, mode kept, 409 on a stale base, 413, 400 and 403', async t => {
  const receiver = machine(t, { id: RECEIVER_ID });
  receiver.service.update({ role: 'receive' });
  const a = linkedSource(t, () => [{ id: 'r', name: 'Office', machine: receiver }]);
  refusedWith(() => a.service.readShared(), 'RULE_SYNC_NOT_SOURCE', 403);
  refusedWith(() => a.service.writeShared({ content: 'x', base_revision: 'f'.repeat(64) }), 'RULE_SYNC_NOT_SOURCE', 403);
  a.service.update({ role: 'source' });
  await a.service.pushAll();

  // No file yet: empty content; the first write creates <claude>/shared.
  const empty = a.service.readShared();
  assert.deepEqual({ ...empty, updated_at: null }, { content: '', content_revision: crypto.createHash('sha256').update('').digest('hex'), size: 0, updated_at: null, exists: false });
  const first = a.service.writeShared({ content: 'Rule A.\n', base_revision: empty.content_revision });
  assert.equal(read(a.paths.sharedRules), 'Rule A.\n');
  assert.equal(modeOf(a.paths.sharedRules), 0o644);
  assert.equal(first.size, 8);
  assert.ok(first.updated_at);

  fs.chmodSync(a.paths.sharedRules, 0o600);
  const inodeBefore = fs.statSync(a.paths.sharedRules).ino;
  const second = a.service.writeShared({ content: 'Rule B é.\n', base_revision: first.content_revision });
  assert.equal(read(a.paths.sharedRules), 'Rule B é.\n');
  assert.equal(modeOf(a.paths.sharedRules), 0o600, 'the mode is kept');
  assert.notEqual(fs.statSync(a.paths.sharedRules).ino, inodeBefore, 'written to a new file and renamed into place');
  assert.deepEqual(fs.readdirSync(path.dirname(a.paths.sharedRules)), ['CLAUDE.shared.md'], 'no temporary file is left');
  assert.equal(a.service.readShared().content_revision, second.content_revision);

  // Someone changed the file meanwhile: 409 with the current text, nothing written.
  write(a.paths.sharedRules, 'Edited by hand.\n');
  assert.throws(() => a.service.writeShared({ content: 'Mine.\n', base_revision: second.content_revision }), error => error.code === 'RULE_SYNC_SHARED_CHANGED' && error.statusCode === 409
    && error.extra.current.content === 'Edited by hand.\n' && error.extra.current.content_revision === a.service.readShared().content_revision);
  assert.equal(read(a.paths.sharedRules), 'Edited by hand.\n');

  const base = a.service.readShared().content_revision;
  assert.throws(() => a.service.writeShared({ content: 'x'.repeat(LIMITS.fileBytes + 1), base_revision: base }), error => error.code === 'RULE_SYNC_TOO_LARGE' && error.statusCode === 413);
  for (const body of [null, { content: 1, base_revision: base }, { content: 'a\0b', base_revision: base }, { content: 'bad \ud800', base_revision: base }, { content: 'x' }, { content: 'x', base_revision: 'abc' }]) {
    refusedWith(() => a.service.writeShared(body), 'RULE_SYNC_INVALID_CONTENT', 400);
  }
  assert.equal(read(a.paths.sharedRules), 'Edited by hand.\n', 'nothing refused was written');

  // A write is pushed to the receivers (debounced like any change of the file).
  const puts = a.puts().length;
  a.service.writeShared({ content: 'Pushed rule.\n', base_revision: base });
  await until(() => a.puts().length === puts + 1, 'the edit was pushed');
  assert.equal(rulesOf(receiver.paths.sharedRules), 'Pushed rule.\n');
});

test('a symlinked shared rules file on the source is written through', t => {
  const a = machine(t, { id: SOURCE_ID, name: 'Home Mac' });
  const dotfiles = path.join(a.home, 'dotfiles', 'shared.md');
  write(dotfiles, 'Linked.\n', 0o640);
  fs.mkdirSync(path.dirname(a.paths.sharedRules), { recursive: true });
  fs.symlinkSync(dotfiles, a.paths.sharedRules);
  a.service.update({ role: 'source' });
  const view = a.service.readShared();
  assert.equal(view.content, 'Linked.\n');
  a.service.writeShared({ content: 'Changed.\n', base_revision: view.content_revision });
  assert.equal(fs.lstatSync(a.paths.sharedRules).isSymbolicLink(), true);
  assert.equal(read(dotfiles), 'Changed.\n');
  assert.equal(modeOf(dotfiles), 0o640);
});

// ---- Finding the source from any service ----

// A source machine with a shared rules file, and a receiver that already follows it.
function sourceAndReceiver(t, { instanceId = SOURCE_ID, capabilities } = {}) {
  const src = machine(t, { id: SOURCE_ID, name: 'Home Mac' });
  write(src.paths.sharedRules, 'Shared rule.\n');
  src.service.update({ role: 'source' });
  const peer = { id: 's', name: 'Home link', machine: src, instanceId, capabilities };
  const rec = linkedMachine(t, () => [peer], { id: RECEIVER_ID, name: 'Office' });
  rec.service.update({ role: 'receive' });
  rec.service.receive(buildBundle({ paths: src.paths, skills: [], source: { instance_id: SOURCE_ID, name: 'Home Mac' } }).bundle);
  return { src, rec, peer };
}

test('the editor on the source itself works on the local file', async t => {
  const a = machine(t, { id: SOURCE_ID, name: 'Home Mac' });
  write(a.paths.sharedRules, 'Local.\n');
  a.service.update({ role: 'source' });
  const view = await a.service.sharedForBrowser();
  assert.equal(view.content, 'Local.\n');
  assert.deepEqual(view.source, { name: 'Home Mac', local: true });
  const saved = await a.service.saveSharedForBrowser({ content: 'Local 2.\n', base_revision: view.content_revision });
  assert.deepEqual(saved.source, { name: 'Home Mac', local: true });
  assert.equal(read(a.paths.sharedRules), 'Local 2.\n');
});

test('a receiver edits the rules of the source it follows; a stale base gets 409 with the current text', async t => {
  const { src, rec } = sourceAndReceiver(t);
  const view = await rec.service.sharedForBrowser();
  assert.equal(view.content, 'Shared rule.\n');
  assert.deepEqual(view.source, { name: 'Home Mac', local: false, remote_server_id: 1 });
  assert.equal(rec.calls.filter(call => call.route === '/v1/rule-sync/status').length, 1, 'the link knows the instance: only the source is asked');
  const saved = await rec.service.saveSharedForBrowser({ content: 'From the office.\n', base_revision: view.content_revision });
  assert.equal(saved.content_revision, src.service.readShared().content_revision);
  assert.equal(read(src.paths.sharedRules), 'From the office.\n', 'written on the source, not here');
  assert.deepEqual(rec.calls.filter(call => call.method === 'PUT').map(call => call.body), [{ content: 'From the office.\n', base_revision: view.content_revision }]);
  await assert.rejects(rec.service.saveSharedForBrowser({ content: 'Late.\n', base_revision: view.content_revision }),
    error => error.code === 'RULE_SYNC_SHARED_CHANGED' && error.statusCode === 409 && error.extra.current.content === 'From the office.\n' && error.extra.source.name === 'Home Mac');
});

test('a receiver whose link does not know the instance finds its source through the status answers', async t => {
  const { rec } = sourceAndReceiver(t, { instanceId: null });
  const view = await rec.service.sharedForBrowser();
  assert.equal(view.content, 'Shared rule.\n');
  assert.equal(view.source.name, 'Home Mac');
});

test('with the role off the one linked source is found; several sources are 409, none is 404', async t => {
  const src = machine(t, { id: SOURCE_ID, name: 'Home Mac' });
  write(src.paths.sharedRules, 'Found.\n');
  src.service.update({ role: 'source' });
  const idle = machine(t, { id: RECEIVER_ID, name: 'Idle' });
  const old = { id: 'old', name: 'Old box', machine: idle, capabilities: ['tasks:read'] };
  const list = [{ id: 'i', name: 'Idle', machine: idle }, old, { id: 's', name: 'Home link', machine: src }];
  const off = linkedMachine(t, () => list, { id: OTHER_ID, name: 'Laptop' });
  const view = await off.service.sharedForBrowser();
  assert.equal(view.content, 'Found.\n');
  assert.deepEqual(view.source, { name: 'Home Mac', local: false, remote_server_id: 3 });
  const saved = await off.service.saveSharedForBrowser({ content: 'From the laptop.\n', base_revision: view.content_revision });
  assert.ok(saved.content_revision);
  assert.equal(read(src.paths.sharedRules), 'From the laptop.\n');

  const second = machine(t, { id: '44444444-4444-4444-8444-444444444444', name: 'Work Mac' });
  second.service.update({ role: 'source' });
  list.push({ id: 'w', name: 'Work link', machine: second });
  await assert.rejects(off.service.sharedForBrowser(), error => error.code === 'RULE_SYNC_SEVERAL_SOURCES' && error.statusCode === 409 && error.extra.sources.join() === 'Home Mac,Work Mac');

  list.splice(0, list.length, { id: 'i', name: 'Idle', machine: idle }, { id: 'gone', name: 'Away', machine: idle, online: false });
  await assert.rejects(off.service.sharedForBrowser(), error => error.code === 'RULE_SYNC_NO_SOURCE' && error.statusCode === 404 && error.extra.unreachable.join() === 'Away');
  const lonely = machine(t, { id: OTHER_ID });
  await assert.rejects(lonely.service.sharedForBrowser(), error => error.code === 'RULE_SYNC_NO_SOURCE');
});

test('a source that is offline is 502 ENGINE_OFFLINE; one too old to edit is 501', async t => {
  const { rec, peer } = sourceAndReceiver(t);
  peer.online = false;
  await assert.rejects(rec.service.sharedForBrowser(), error => error.code === 'ENGINE_OFFLINE' && error.statusCode === 502 && error.extra.source.name === 'Home Mac');
  peer.online = true;
  peer.unreachable = true;
  await assert.rejects(rec.service.saveSharedForBrowser({ content: 'x', base_revision: 'f'.repeat(64) }), error => error.code === 'ENGINE_OFFLINE' && error.statusCode === 502);
  peer.unreachable = false;
  peer.capabilities = [CAPABILITY];
  await assert.rejects(rec.service.sharedForBrowser(), error => error.code === 'RULE_SYNC_EDIT_UNSUPPORTED' && error.statusCode === 501);
  // Found without the following too (role off): same answer.
  rec.service.update({ role: 'off' });
  await assert.rejects(rec.service.sharedForBrowser(), error => error.code === 'RULE_SYNC_EDIT_UNSUPPORTED' && error.statusCode === 501);
});

// ---- The guard on a receiver ----

// A receiver that got a bundle with rules, two skills and Codex, next to its own company skill.
function guardedReceiver(t, options = {}) {
  const src = tempHome(t);
  const b = machine(t, { id: RECEIVER_ID, ...options });
  write(b.paths.claudeMd, '# My rules\n\nCompany rule.\n');
  write(b.paths.codexAgents, 'Local Codex rule.\n');
  write(path.join(b.paths.skillsDir, 'company', 'SKILL.md'), 'Company skill.\n');
  b.service.update({ role: 'receive' });
  const { bundle } = sourceBundle(src, { rules: 'Rule one.\n', skills: { deploy: { 'SKILL.md': '# Deploy\n', 'scripts/run.sh': { text: '#!/bin/sh\n', mode: 0o755 } }, notes: { 'SKILL.md': 'Notes.\n' }, company: { 'SKILL.md': 'Shared company.\n' } } });
  b.service.receive(bundle);
  return { ...b, src, bundle, skill: name => path.join(b.paths.skillsDir, name), backups: () => { try { return fs.readdirSync(path.join(b.dataDir, 'rule-sync', 'overwritten')).sort(); } catch { return []; } } };
}

test('the receiver keeps the applied bundle privately with a hash of every written file', t => {
  const b = guardedReceiver(t);
  const file = path.join(b.dataDir, 'rule-sync', 'applied-bundle.json');
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(path.dirname(file)), 0o700);
  const record = JSON.parse(read(file));
  assert.equal(record.revision, b.bundle.revision);
  assert.equal(record.hashes.shared.length, 64);
  assert.equal(record.hashes.codex.length, 64);
  assert.deepEqual(record.skills.map(skill => skill.name), ['deploy', 'notes'], 'a skill that clashed with a local one is not kept');
  assert.deepEqual(record.skills[0].files.map(item => item.path), ['SKILL.md', 'scripts/run.sh']);
  assert.equal(b.service.guardCheck(), null, 'nothing changed');
  assert.equal(b.service.overview().guard_active, true);
});

test('guard: an edited shared rules file is saved, put back and reported', t => {
  const b = guardedReceiver(t);
  const synced = read(b.paths.sharedRules);
  write(b.paths.sharedRules, 'My local edit.\n');
  const entry = b.service.guardCheck();
  assert.deepEqual(entry.paths, [b.paths.sharedRules]);
  assert.equal(read(b.paths.sharedRules), synced, 'the synced version is back');
  assert.equal(read(path.join(entry.backup_dir, 'claude', 'shared', 'CLAUDE.shared.md')), 'My local edit.\n');
  assert.equal(modeOf(path.join(entry.backup_dir, 'claude', 'shared', 'CLAUDE.shared.md')), 0o600);
  assert.equal(modeOf(entry.backup_dir), 0o700);
  assert.equal(path.dirname(entry.backup_dir), path.join(b.dataDir, 'rule-sync', 'overwritten'));
  const changes = b.service.overview().local_changes;
  assert.equal(changes.length, 1);
  assert.deepEqual({ ...changes[0], at: null }, { at: null, paths: [b.paths.sharedRules], backup_dir: entry.backup_dir, source: 'Home Mac', restored: true });
  assert.equal(b.service.guardCheck(), null, 'after the restore nothing differs');
  // Deleted: put back, nothing to save.
  fs.rmSync(b.paths.sharedRules);
  const deleted = b.service.guardCheck();
  assert.equal(deleted.backup_dir, null);
  assert.equal(read(b.paths.sharedRules), synced);
  assert.equal(b.service.dismissLocalChanges().local_changes.length, 0, 'dismissed');
});

test('guard: a deleted skill file and an extra file in a marked skill folder are put back and removed, with a backup', t => {
  const b = guardedReceiver(t);
  fs.rmSync(path.join(b.skill('deploy'), 'SKILL.md'));
  write(path.join(b.skill('deploy'), 'extra', 'mine.md'), 'Added here.\n');
  write(path.join(b.skill('notes'), 'SKILL.md'), 'Edited notes.\n');
  write(path.join(b.skill('deploy'), '.DS_Store'), 'finder');
  const entry = b.service.guardCheck();
  assert.deepEqual(entry.paths, [
    path.join(b.skill('deploy'), 'SKILL.md'), path.join(b.skill('deploy'), 'extra', 'mine.md'), path.join(b.skill('notes'), 'SKILL.md'),
  ]);
  assert.equal(read(path.join(b.skill('deploy'), 'SKILL.md')), '# Deploy\n');
  assert.equal(exists(path.join(b.skill('deploy'), 'extra')), false, 'the extra file is gone from the skill');
  assert.equal(modeOf(path.join(b.skill('deploy'), 'scripts', 'run.sh')), 0o755);
  assert.equal(read(path.join(b.skill('notes'), 'SKILL.md')), 'Notes.\n');
  assert.ok(exists(path.join(b.skill('deploy'), MARKER)), 'the marker is written again');
  assert.equal(read(path.join(entry.backup_dir, 'claude', 'skills', 'deploy', 'extra', 'mine.md')), 'Added here.\n');
  assert.equal(read(path.join(entry.backup_dir, 'claude', 'skills', 'notes', 'SKILL.md')), 'Edited notes.\n');
  assert.equal(exists(path.join(entry.backup_dir, 'claude', 'skills', 'deploy', 'SKILL.md')), false, 'a deleted file has nothing to save');
  // The whole folder deleted: built again.
  fs.rmSync(b.skill('notes'), { recursive: true });
  assert.deepEqual(b.service.guardCheck().paths, [b.skill('notes')]);
  assert.equal(read(path.join(b.skill('notes'), 'SKILL.md')), 'Notes.\n');
  assert.deepEqual(fs.readdirSync(b.paths.skillsDir).sort(), ['company', 'deploy', 'notes'], 'no temporary folder is left');
});

test('guard: an import line taken out is added again without touching the rest of CLAUDE.md', t => {
  const b = guardedReceiver(t);
  write(b.paths.claudeMd, '# My rules\n\nCompany rule, changed today.\n');
  const entry = b.service.guardCheck();
  assert.deepEqual(entry.paths, [b.paths.claudeMd]);
  assert.equal(read(b.paths.claudeMd), `${IMPORT_COMMENT}\n@~/.claude/shared/CLAUDE.shared.md\n\n# My rules\n\nCompany rule, changed today.\n`);
  // Any other change of CLAUDE.md is the user's own.
  write(b.paths.claudeMd, `${read(b.paths.claudeMd)}More of my own rules.\n`);
  assert.equal(b.service.guardCheck(), null);
});

test('guard: the inside of the Codex block is put back, text outside it is never compared', t => {
  const b = guardedReceiver(t);
  const synced = read(b.paths.codexAgents);
  write(b.paths.codexAgents, synced.replace('Rule one.', 'Rule one, edited.'));
  assert.deepEqual(b.service.guardCheck().paths, [b.paths.codexAgents]);
  assert.equal(read(b.paths.codexAgents), synced);
  write(b.paths.codexAgents, `${synced}Another local Codex rule.\n`);
  assert.equal(b.service.guardCheck(), null);
});

test('guard: unmarked skill folders, links and a folder whose marker was removed are never touched', t => {
  const b = guardedReceiver(t);
  write(path.join(b.skill('company'), 'SKILL.md'), 'Company skill, edited.\n');
  write(path.join(b.skill('company'), 'new.md'), 'new');
  fs.rmSync(path.join(b.skill('notes'), MARKER));
  write(path.join(b.skill('notes'), 'SKILL.md'), 'Mine now.\n');
  assert.equal(b.service.guardCheck(), null);
  assert.equal(read(path.join(b.skill('company'), 'SKILL.md')), 'Company skill, edited.\n');
  assert.equal(read(path.join(b.skill('notes'), 'SKILL.md')), 'Mine now.\n');
  // A link in place of a received skill: left alone.
  const outside = path.join(b.home, 'elsewhere');
  write(path.join(outside, 'keep.md'), 'keep');
  fs.rmSync(b.skill('deploy'), { recursive: true });
  fs.symlinkSync(outside, b.skill('deploy'));
  assert.equal(b.service.guardCheck(), null);
  assert.deepEqual(fs.readdirSync(outside), ['keep.md']);
});

test('guard: watch events are debounced into one restore, and its own writes do not start it again', async t => {
  const watchers = [];
  const watch = (dir, options, onEvent) => { watchers.push({ dir, recursive: options.recursive, onEvent }); return Object.assign(new EventEmitter(), { close() {} }); };
  const b = guardedReceiver(t, { watch, timing: { pollMs: 0, retryMs: 0, debounceMs: 30, guardPollMs: 0, guardDebounceMs: 60 } });
  b.service.start();
  const dirs = watchers.map(item => item.dir);
  assert.ok(dirs.includes(path.dirname(b.paths.sharedRules)));
  assert.ok(dirs.includes(b.paths.claudeDir));
  assert.ok(dirs.includes(b.skill('deploy')) && dirs.includes(b.skill('notes')));
  assert.ok(!dirs.includes(b.skill('company')), 'an unmarked skill is not watched');
  const fire = name => watchers.forEach(item => item.onEvent('change', name));

  // An editor's save in several steps: one restore.
  write(b.paths.sharedRules, 'Step 1.\n');
  fire('CLAUDE.shared.md');
  await sleep(10);
  write(b.paths.sharedRules, 'Step 2.\n');
  fire('CLAUDE.shared.md');
  await until(() => b.service.overview().local_changes.length === 1, 'restored');
  assert.equal(rulesOf(b.paths.sharedRules), 'Rule one.\n');
  assert.equal(read(path.join(b.service.overview().local_changes[0].backup_dir, 'claude', 'shared', 'CLAUDE.shared.md')), 'Step 2.\n');
  const stat = fs.statSync(b.paths.sharedRules);

  // The events of our own restore (and any later ones) change nothing.
  for (let i = 0; i < 5; i += 1) { fire('CLAUDE.shared.md'); fire(null); await sleep(20); }
  await sleep(150);
  assert.equal(b.service.overview().local_changes.length, 1, 'no second restore');
  assert.equal(b.backups().length, 1);
  const after = fs.statSync(b.paths.sharedRules);
  assert.equal(after.ino, stat.ino, 'the file was not written again');
  assert.equal(after.mtimeMs, stat.mtimeMs);
  // An event for another file in ~/.claude starts nothing.
  write(b.paths.sharedRules, 'Unseen edit.\n');
  watchers.filter(item => item.dir === b.paths.claudeDir).forEach(item => item.onEvent('change', 'history.jsonl'));
  await sleep(150);
  assert.equal(read(b.paths.sharedRules), 'Unseen edit.\n', 'only CLAUDE.md counts in the config folder (the poll catches the rest)');
});

test('guard: the 30 s poll restores without any event; only the 20 newest backup folders are kept', async t => {
  const b = guardedReceiver(t, { watch: () => { throw new Error('no watch here'); }, timing: { pollMs: 0, retryMs: 0, debounceMs: 30, guardPollMs: 40, guardDebounceMs: 30 } });
  b.service.start();
  write(b.paths.sharedRules, 'Polled.\n');
  await until(() => b.service.overview().local_changes.length === 1, 'the poll restored it');
  b.service.stop();
  for (let i = 0; i < 22; i += 1) { write(b.paths.sharedRules, `Edit ${i}.\n`); b.service.guardCheck(); }
  const kept = b.backups();
  assert.equal(kept.length, 20);
  assert.equal(read(path.join(b.dataDir, 'rule-sync', 'overwritten', kept.at(-1), 'claude', 'shared', 'CLAUDE.shared.md')), 'Edit 21.\n', 'the newest is kept');
  assert.equal(b.service.overview().local_changes.length, 20, 'the last 20 entries');
});

test('guard: a new bundle saves a local edit before it replaces it', t => {
  const b = guardedReceiver(t);
  write(b.paths.sharedRules, 'Edited just before.\n');
  const { bundle } = sourceBundle(b.src, { rules: 'Rule two.\n', skills: { deploy: { 'SKILL.md': '# Deploy\n', 'scripts/run.sh': { text: '#!/bin/sh\n', mode: 0o755 } }, notes: { 'SKILL.md': 'Notes.\n' } } });
  b.service.receive(bundle);
  assert.equal(rulesOf(b.paths.sharedRules), 'Rule two.\n');
  const [entry] = b.service.overview().local_changes;
  assert.equal(entry.restored, false);
  assert.equal(read(path.join(entry.backup_dir, 'claude', 'shared', 'CLAUDE.shared.md')), 'Edited just before.\n');
  assert.equal(b.service.guardCheck(), null, 'the new bundle is the one guarded now');
});

test('guard: turning the role off or resetting the source stops it, and the files stay as they are', t => {
  const b = guardedReceiver(t);
  b.service.update({ role: 'off' });
  assert.equal(exists(path.join(b.dataDir, 'rule-sync', 'applied-bundle.json')), false);
  assert.equal(b.service.overview().guard_active, false);
  write(b.paths.sharedRules, 'Kept.\n');
  assert.equal(b.service.guardCheck(), null);
  assert.equal(read(b.paths.sharedRules), 'Kept.\n');

  const c = guardedReceiver(t);
  c.service.resetSource();
  write(path.join(c.skill('deploy'), 'SKILL.md'), 'Kept too.\n');
  assert.equal(c.service.guardCheck(), null);
  assert.equal(read(path.join(c.skill('deploy'), 'SKILL.md')), 'Kept too.\n');
  // Without a data folder there is no guard at all.
  const plain = createRuleSync({ db: database(t), env: {}, home: tempHome(t), identity: () => ({ instance_id: RECEIVER_ID }), log: quiet });
  plain.update({ role: 'receive' });
  plain.receive(sourceBundle(tempHome(t)).bundle);
  write(plain.paths.sharedRules, 'Free.\n');
  assert.equal(plain.guardCheck(), null);
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
  assert.deepEqual(Object.keys(status.body).sort(), ['codex', 'conflicts', 'following', 'instance_id', 'name', 'revision', 'role', 'synced_at']);
  assert.equal(status.body.instance_id, RECEIVER_ID, 'the status says who answers, so a linked service can find the source');
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

test('routes: the shared rules on the Engine API and in the browser, and dismissing local changes', async t => {
  const a = machine(t, { id: SOURCE_ID, name: 'Home Mac' });
  write(a.paths.sharedRules, 'Route rule.\n');
  const app = express();
  const guard = (req, res, next) => (req.get('authorization') === 'Bearer good' ? next() : res.status(401).json({ error: 'ENGINE_TOKEN_REQUIRED' }));
  app.use('/api/rule-sync', createBrowserRouter({ getService: () => a.service, requireAuth: (req, res, next) => next() }));
  app.use('/v1/rule-sync', createEngineRouter({ getService: () => a.service, guard }));
  const call = await listen(t, app);
  const engine = { 'Content-Type': 'application/json', Authorization: 'Bearer good' };

  assert.equal((await call('GET', '/v1/rule-sync/shared', undefined, {})).status, 401);
  assert.equal((await call('PUT', '/v1/rule-sync/shared', { content: 'x', base_revision: 'f'.repeat(64) }, { 'Content-Type': 'application/json' })).status, 401);
  const notSource = await call('GET', '/v1/rule-sync/shared', undefined, engine);
  assert.deepEqual([notSource.status, notSource.body.error], [403, 'RULE_SYNC_NOT_SOURCE']);
  a.service.update({ role: 'source' });

  const got = await call('GET', '/v1/rule-sync/shared', undefined, engine);
  assert.equal(got.status, 200);
  assert.deepEqual(Object.keys(got.body).sort(), ['content', 'content_revision', 'exists', 'size', 'updated_at']);
  const put = await call('PUT', '/v1/rule-sync/shared', { content: 'Engine edit.\n', base_revision: got.body.content_revision }, engine);
  assert.equal(put.status, 200);
  assert.deepEqual(Object.keys(put.body).sort(), ['content_revision', 'size', 'updated_at']);
  const stale = await call('PUT', '/v1/rule-sync/shared', { content: 'Stale.\n', base_revision: got.body.content_revision }, engine);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'RULE_SYNC_SHARED_CHANGED');
  assert.equal(stale.body.current.content, 'Engine edit.\n');

  const view = await call('GET', '/api/rule-sync/shared');
  assert.equal(view.body.content, 'Engine edit.\n');
  assert.deepEqual(view.body.source, { name: 'Home Mac', local: true });
  assert.equal((await call('PUT', '/api/rule-sync/shared', { content: 'x', base_revision: view.body.content_revision }, { 'Content-Type': 'application/json' })).status, 403, 'a write needs the same-origin header');
  const saved = await call('PUT', '/api/rule-sync/shared', { content: 'Browser edit.\n', base_revision: view.body.content_revision });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.source.local, true);
  assert.equal(read(a.paths.sharedRules), 'Browser edit.\n');
  // Over 1 MiB is the service's 413, not the 64 kB parser of the other routes.
  const big = await call('PUT', '/api/rule-sync/shared', { content: 'x'.repeat(LIMITS.fileBytes + 1), base_revision: saved.body.content_revision });
  assert.deepEqual([big.status, big.body.error, big.body.limit], [413, 'RULE_SYNC_TOO_LARGE', 'file']);
  assert.equal((await call('PUT', '/api/rule-sync', { skills: Array.from({ length: 1500 }, (_, i) => `${'s'.repeat(60)}${i}`) })).status, 413, 'the other routes keep the small parser');
  const dismissed = await call('POST', '/api/rule-sync/dismiss-local-changes', {});
  assert.deepEqual(dismissed.body.local_changes, []);
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
    url, home, claude: path.join(home, '.claude'), data: path.join(temp, 'data'),
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
  assert.match(read(path.join(b.claude, 'shared', 'CLAUDE.shared.md')), /^<!-- Synced by T-Agent from .+\. Edit it on .+ or in the T-Agent page/, 'the receiver copy has the notice');
  assert.doesNotMatch(read(path.join(a.claude, 'shared', 'CLAUDE.shared.md')), /Synced by T-Agent/, 'the original has none');

  // Editing from the receiver's page goes to the source over the tunnel.
  assert.ok(info.body.capabilities.includes(EDIT_CAPABILITY));
  const onSource = (await a.call('GET', '/api/rule-sync/shared')).body;
  assert.equal(onSource.source.local, true);
  const remote = await b.call('GET', '/api/rule-sync/shared');
  assert.equal(remote.status, 200, remote.text);
  assert.equal(remote.body.source.local, false);
  assert.equal(typeof remote.body.source.remote_server_id, 'number');
  assert.equal(remote.body.content, onSource.content);
  assert.equal(remote.body.content_revision, onSource.content_revision);
  const edited = `${remote.body.content}Written from the receiver.\n`;
  const saved = await b.call('PUT', '/api/rule-sync/shared', { content: edited, base_revision: remote.body.content_revision });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(read(path.join(a.claude, 'shared', 'CLAUDE.shared.md')), edited, 'written on the source');
  const stale = await b.call('PUT', '/api/rule-sync/shared', { content: 'Late.\n', base_revision: remote.body.content_revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'RULE_SYNC_SHARED_CHANGED');
  assert.equal(stale.body.current.content, edited);
  // The source pushes the edit back to the receiver by itself (debounced).
  await until(() => /Written from the receiver\./.test(read(path.join(b.claude, 'shared', 'CLAUDE.shared.md'))), 'the edit came back to the receiver', 15000);

  // The guard of the receiver: a local edit is saved under its data folder and replaced.
  const sharedOnB = path.join(b.claude, 'shared', 'CLAUDE.shared.md');
  await until(async () => (await b.call('GET', '/api/rule-sync')).body.guard_active, 'the guard is on');
  const synced = read(sharedOnB);
  fs.writeFileSync(sharedOnB, 'Local edit on the receiver.\n');
  await until(async () => (await b.call('GET', '/api/rule-sync')).body.local_changes.length === 1, 'the receiver put it back', 15000);
  assert.equal(read(sharedOnB), synced);
  const [entry] = (await b.call('GET', '/api/rule-sync')).body.local_changes;
  assert.equal(path.relative(b.data, entry.backup_dir).split(path.sep).slice(0, 2).join('/'), 'rule-sync/overwritten');
  assert.equal(read(path.join(entry.backup_dir, 'claude', 'shared', 'CLAUDE.shared.md')), 'Local edit on the receiver.\n');
  assert.deepEqual((await b.call('POST', '/api/rule-sync/dismiss-local-changes', {})).body.local_changes, []);
});
