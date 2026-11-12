'use strict';
// Rules and skills sync: one linked service (the source) shares a layer of Claude rules, chosen Claude skills and the same rules for Codex with the linked
// services that only receive. Each machine's own rules and skills are never read, sent or changed. See "Rules and skills sync" in DESIGN.md.
//
// On disk (Claude config dir = $CLAUDE_CONFIG_DIR or ~/.claude, Codex home = $CODEX_HOME or ~/.codex):
//   <claude>/shared/CLAUDE.shared.md   the shared rules (edited by hand on the source, written by the sync on a receiver)
//   <claude>/CLAUDE.md                 one managed import line at the top, nothing else is touched
//   <claude>/skills/<name>/            a shared skill; on a receiver it carries the marker file .t-agent-sync.json
//   <codex>/AGENTS.md                  the shared rules inside a managed block, nothing outside the block is touched
//
// The setting is one system_state row, `rule_sync_v1`. Transport: the source PUTs a bundle to /v1/rule-sync/bundle of every linked receiver; a receiver
// has no route that reads anything back, so it never sends rules or skills anywhere.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_KEY = 'rule_sync_v1';
const CAPABILITY = 'rule-sync:receive';
const ROLES = Object.freeze(['off', 'source', 'receive']);
const ROUTE = '/v1/rule-sync';
const MARKER = '.t-agent-sync.json';
// Our own temporary folders inside <claude>/skills; never a skill name.
const TEMP_PREFIX = '.t-agent-sync-';
const SKILL_NAME = /^[a-zA-Z0-9._-]{1,64}$/;
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;
const REVISION = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MIB = 1024 * 1024;
const LIMITS = Object.freeze({ fileBytes: MIB, totalBytes: 20 * MIB, filesPerSkill: 200, skills: 100, pathLength: 512, nameLength: 200 });
// Files of a skill folder that are never sent: version control data and Finder's folder settings.
const SKIPPED = new Set(['.git', '.DS_Store']);
const IMPORT_COMMENT = '<!-- Managed by T-Agent (rules and skills sync): the next line imports the shared rules. Remove it in T-Agent Settings. -->';
const CODEX_BEGIN = '<!-- t-agent shared rules: begin (managed by T-Agent, do not edit inside) -->';
const CODEX_END = '<!-- t-agent shared rules: end -->';
const SHARED_TEMPLATE = '# Shared rules\n\nRules in this file are shared by T-Agent with the linked machines that receive them.\n';
const TIMING = Object.freeze({ debounceMs: 2_000, pollMs: 30_000, retryMs: 60_000, requestTimeoutMs: 10_000, pushTimeoutMs: 120_000 });

class RuleSyncError extends Error {
  constructor(code, statusCode = 400, extra = {}) { super(code); this.name = 'RuleSyncError'; this.code = code; this.statusCode = statusCode; this.extra = extra; }
}
const fail = (code, statusCode, extra) => { throw new RuleSyncError(code, statusCode, extra); };
const tooLarge = (limit, item) => new RuleSyncError('RULE_SYNC_TOO_LARGE', 413, { limit, item });

// ---------------------------------------------------------------------------
// Paths and files
// ---------------------------------------------------------------------------

function layout({ env = process.env, home = os.homedir() } = {}) {
  const defaultClaude = path.join(home, '.claude');
  const claudeDir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? path.resolve(env.CLAUDE_CONFIG_DIR) : defaultClaude;
  const codexDir = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const sharedRules = path.join(claudeDir, 'shared', 'CLAUDE.shared.md');
  return {
    claudeDir, codexDir, sharedRules,
    claudeMd: path.join(claudeDir, 'CLAUDE.md'),
    skillsDir: path.join(claudeDir, 'skills'),
    codexAgents: path.join(codexDir, 'AGENTS.md'),
    // Claude Code resolves `~/` in an import; a config dir elsewhere is named by its absolute path.
    importLine: claudeDir === defaultClaude ? '@~/.claude/shared/CLAUDE.shared.md' : `@${sharedRules}`,
  };
}

const isMissing = error => error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) { if (isMissing(error)) return null; throw error; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (isMissing(error)) return null; throw error; }
}

// Write to a temporary file next to the target, then rename it over the target: a reader sees the old or the new content, never half of it.
function writeAtomic(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${TEMP_PREFIX}${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, data, { mode, flag: 'wx' });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing was written */ }
    throw error;
  }
}

// The file to write for a file of the user (CLAUDE.md, AGENTS.md, the shared rules): a symlink (a dotfiles setup) is written through, so the link stays,
// and the file keeps its mode. A link that points nowhere is refused rather than replaced.
function userFile(file) {
  const stat = lstatOrNull(file);
  if (!stat) return { file, mode: 0o644, text: null };
  if (stat.isSymbolicLink()) {
    let real;
    try { real = fs.realpathSync(file); } catch { fail('RULE_SYNC_FILE_UNSAFE', 409, { item: file }); }
    const target = fs.statSync(real);
    if (!target.isFile()) fail('RULE_SYNC_FILE_UNSAFE', 409, { item: file });
    return { file: real, mode: target.mode & 0o777, text: fs.readFileSync(real, 'utf8') };
  }
  if (!stat.isFile()) fail('RULE_SYNC_FILE_UNSAFE', 409, { item: file });
  return { file, mode: stat.mode & 0o777, text: fs.readFileSync(file, 'utf8') };
}
// Change a user file with `edit(text or null) -> text`; written only when the text changes. True when it was written.
function editUserFile(file, edit) {
  const current = userFile(file);
  const next = edit(current.text);
  if (next === current.text || next === null) return false;
  writeAtomic(current.file, next, current.mode);
  return true;
}

// ---------------------------------------------------------------------------
// The import line in CLAUDE.md and the managed block in AGENTS.md
// ---------------------------------------------------------------------------

const lineMatches = (line, wanted) => line.replace(/\r$/, '').trim() === wanted;
const hasImportLine = (text, importLine) => typeof text === 'string' && text.split('\n').some(line => lineMatches(line, importLine));

// The import line once, at the top, with the comment that marks it as ours. Nothing else in the file changes.
function withImportLine(text, importLine) {
  if (hasImportLine(text, importLine)) return text;
  const head = `${IMPORT_COMMENT}\n${importLine}\n`;
  return text ? `${head}\n${text}` : head;
}
function withoutImportLine(text, importLine) {
  if (!hasImportLine(text, importLine)) return text;
  const inserted = `${IMPORT_COMMENT}\n${importLine}\n`;
  if (text.startsWith(`${inserted}\n`)) return text.slice(inserted.length + 1);
  if (text.startsWith(inserted)) return text.slice(inserted.length);
  return text.split('\n').filter(line => !lineMatches(line, importLine) && !lineMatches(line, IMPORT_COMMENT)).join('\n');
}

function findBlock(lines) {
  const begin = lines.findIndex(line => lineMatches(line, CODEX_BEGIN));
  if (begin < 0) return null;
  const end = lines.findIndex((line, index) => index > begin && lineMatches(line, CODEX_END));
  return end < 0 ? null : { begin, end };
}
function codexBlock(rules) {
  // The marker lines themselves never appear inside, or the next update would find the wrong end.
  const inner = String(rules || '').split('\n').filter(line => !lineMatches(line, CODEX_BEGIN) && !lineMatches(line, CODEX_END)).join('\n').replace(/\s+$/, '');
  return `${CODEX_BEGIN}\n${inner ? `${inner}\n` : ''}${CODEX_END}`;
}
// The block placed at the top on the first write; afterwards only its inside changes.
function withCodexBlock(text, rules) {
  const block = codexBlock(rules);
  if (!text) return `${block}\n`;
  const lines = text.split('\n');
  const found = findBlock(lines);
  if (!found) return `${block}\n\n${text}`;
  return [...lines.slice(0, found.begin), block, ...lines.slice(found.end + 1)].join('\n');
}
function withoutCodexBlock(text) {
  if (!text) return text;
  const lines = text.split('\n');
  const found = findBlock(lines);
  if (!found) return text;
  const after = found.begin === 0 && lines[found.end + 1] === '' ? found.end + 2 : found.end + 1;
  return [...lines.slice(0, found.begin), ...lines.slice(after)].join('\n');
}
const hasCodexBlock = text => typeof text === 'string' && Boolean(findBlock(text.split('\n')));

// ---------------------------------------------------------------------------
// Skills and the bundle
// ---------------------------------------------------------------------------

const validSkillName = name => typeof name === 'string' && SKILL_NAME.test(name) && name !== '.' && name !== '..' && !name.startsWith(TEMP_PREFIX);

// A path inside a skill: relative, with `/` only, no empty, `.` or `..` part, and not the marker file.
function validFilePath(value) {
  if (typeof value !== 'string' || !value || value.length > LIMITS.pathLength) return false;
  if (/[\0\\]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  return !(parts.length === 1 && parts[0] === MARKER);
}
const fileMode = mode => ((Number(mode) & 0o111) ? 0o755 : 0o644);
const byKey = key => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

function skillHash(files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort(byKey('path'))) hash.update(`${file.path}\0${file.mode}\0${file.content_base64}\0`);
  return hash.digest('hex');
}
// The revision of a bundle: the hash of its content, so the same rules and skills give the same revision on every machine.
function revisionOf(rules, skills) {
  const hash = crypto.createHash('sha256');
  hash.update(`rules\0${rules}\0`);
  for (const skill of [...skills].sort(byKey('name'))) hash.update(`skill\0${skill.name}\0${skillHash(skill.files)}\0`);
  return hash.digest('hex');
}

// A marker file written by this sync: a regular file with a JSON object that has a revision. Anything else means the folder is not ours.
function readMarker(dir) {
  const file = path.join(dir, MARKER);
  const stat = lstatOrNull(file);
  if (!stat || !stat.isFile()) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.revision === 'string' ? value : null;
  } catch { return null; }
}

// The skill folders under <claude>/skills: a symlinked one cannot be shared, a marked one was received from a source.
function listSkills(skillsDir) {
  let entries;
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => validSkillName(entry.name)).flatMap(entry => {
    if (entry.isSymbolicLink()) return [{ name: entry.name, symlink: true }];
    if (!entry.isDirectory()) return [];
    return [{ name: entry.name, synced: readMarker(path.join(skillsDir, entry.name)) !== null }];
  }).sort(byKey('name'));
}

// The files of one skill on the source. Symlinks and special files are skipped with a warning, never followed.
function readSkillFiles(root, name, warnings, budget) {
  const files = [];
  const walk = (dir, relative) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort(byKey('name'));
    for (const entry of entries) {
      if (SKIPPED.has(entry.name) || (!relative && entry.name === MARKER)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { warnings.push({ skill: name, path: rel, warning: 'symlink' }); continue; }
      if (entry.isDirectory()) { walk(full, rel); continue; }
      if (!entry.isFile() || !validFilePath(rel)) { warnings.push({ skill: name, path: rel, warning: 'skipped' }); continue; }
      const stat = fs.statSync(full);
      if (stat.size > LIMITS.fileBytes) throw tooLarge('file', `${name}/${rel}`);
      if (files.length >= LIMITS.filesPerSkill) throw tooLarge('files', name);
      budget.bytes += stat.size;
      if (budget.bytes > LIMITS.totalBytes) throw tooLarge('total', name);
      files.push({ path: rel, mode: fileMode(stat.mode), content_base64: fs.readFileSync(full).toString('base64') });
    }
  };
  walk(root, '');
  return files;
}

// What the source sends: its shared rules file (empty when there is none) and the chosen skills. Throws RULE_SYNC_TOO_LARGE over a cap.
function buildBundle({ paths, skills: chosen, source }) {
  const warnings = [];
  const rules = readText(paths.sharedRules) || '';
  const budget = { bytes: Buffer.byteLength(rules) };
  if (budget.bytes > LIMITS.fileBytes) throw tooLarge('file', path.basename(paths.sharedRules));
  const names = [...new Set(chosen)].filter(validSkillName).sort();
  if (names.length > LIMITS.skills) throw tooLarge('skills', String(names.length));
  const skills = [];
  for (const name of names) {
    const dir = path.join(paths.skillsDir, name);
    const stat = lstatOrNull(dir);
    if (!stat) { warnings.push({ skill: name, warning: 'missing' }); continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) { warnings.push({ skill: name, warning: stat.isSymbolicLink() ? 'symlink' : 'skipped' }); continue; }
    skills.push({ name, files: readSkillFiles(dir, name, warnings, budget) });
  }
  return { bundle: { source, revision: revisionOf(rules, skills), rules, skills }, warnings };
}

// A bundle as received, checked completely before anything is written. Throws 400 RULE_SYNC_INVALID_BUNDLE or 413 RULE_SYNC_TOO_LARGE.
function parseBundle(body) {
  const invalid = reason => fail('RULE_SYNC_INVALID_BUNDLE', 400, { reason });
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('body');
  const source = body.source;
  if (!source || typeof source !== 'object' || typeof source.instance_id !== 'string' || !INSTANCE_ID.test(source.instance_id)) invalid('source');
  const name = typeof source.name === 'string' ? source.name.slice(0, LIMITS.nameLength) : '';
  if (typeof body.revision !== 'string' || !REVISION.test(body.revision)) invalid('revision');
  if (typeof body.rules !== 'string') invalid('rules');
  let total = Buffer.byteLength(body.rules);
  if (total > LIMITS.fileBytes) throw tooLarge('file', 'CLAUDE.shared.md');
  if (!Array.isArray(body.skills)) invalid('skills');
  if (body.skills.length > LIMITS.skills) throw tooLarge('skills', String(body.skills.length));
  const seen = new Set();
  const skills = body.skills.map(skill => {
    if (!skill || typeof skill !== 'object' || !validSkillName(skill.name) || seen.has(skill.name)) invalid('skill name');
    seen.add(skill.name);
    if (!Array.isArray(skill.files)) invalid('files');
    if (skill.files.length > LIMITS.filesPerSkill) throw tooLarge('files', skill.name);
    const paths = new Set();
    const files = skill.files.map(file => {
      if (!file || typeof file !== 'object' || !validFilePath(file.path) || paths.has(file.path)) invalid(`path in ${skill.name}`);
      paths.add(file.path);
      if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o7777) invalid('mode');
      if (typeof file.content_base64 !== 'string' || file.content_base64.length % 4 !== 0 || !BASE64.test(file.content_base64)) invalid('content');
      const data = Buffer.from(file.content_base64, 'base64');
      if (data.length > LIMITS.fileBytes) throw tooLarge('file', `${skill.name}/${file.path}`);
      total += data.length;
      if (total > LIMITS.totalBytes) throw tooLarge('total', skill.name);
      return { path: file.path, mode: file.mode, content_base64: file.content_base64, data };
    });
    // A file may not also be a folder of another file (`a` and `a/b`).
    for (const file of paths) {
      const parts = file.split('/');
      for (let index = 1; index < parts.length; index += 1) if (paths.has(parts.slice(0, index).join('/'))) invalid(`path in ${skill.name}`);
    }
    return { name: skill.name, files, hash: skillHash(files) };
  });
  if (revisionOf(body.rules, skills) !== body.revision) invalid('revision does not match the content');
  return { source: { instance_id: source.instance_id, name }, revision: body.revision, rules: body.rules, skills };
}

// One skill into <skills root>/<name>: built in a temporary folder, then renamed into place. A folder without our marker (a local skill), a symlink or a
// file at that name is a conflict and is left alone.
function writeSkill(root, skill, marker) {
  const target = path.join(root, skill.name);
  const stat = lstatOrNull(target);
  if (stat && stat.isSymbolicLink()) return { conflict: { skill: skill.name, reason: 'symlink' } };
  if (stat && !stat.isDirectory()) return { conflict: { skill: skill.name, reason: 'not-a-directory' } };
  if (stat) {
    const existing = readMarker(target);
    if (!existing) return { conflict: { skill: skill.name, reason: 'local' } };
    if (existing.skill_hash === skill.hash) {
      writeAtomic(path.join(target, MARKER), `${JSON.stringify({ ...marker, skill_hash: skill.hash }, null, 2)}\n`);
      return { unchanged: true };
    }
  }
  const suffix = `${skill.name}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const temp = path.join(root, `${TEMP_PREFIX}new-${suffix}`);
  fs.mkdirSync(temp, { mode: 0o755 });
  try {
    for (const file of skill.files) {
      const destination = path.join(temp, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      const mode = fileMode(file.mode);
      fs.writeFileSync(destination, file.data, { mode, flag: 'wx' });
      fs.chmodSync(destination, mode);
    }
    fs.writeFileSync(path.join(temp, MARKER), `${JSON.stringify({ ...marker, skill_hash: skill.hash }, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    fs.chmodSync(temp, 0o755);
    if (stat) {
      const old = path.join(root, `${TEMP_PREFIX}old-${suffix}`);
      fs.renameSync(target, old);
      fs.renameSync(temp, target);
      fs.rmSync(old, { recursive: true, force: true });
    } else {
      fs.renameSync(temp, target);
    }
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return { written: true };
}

// Marked skill folders that the bundle no longer has. Only real folders directly inside the skills root, never through a symlink.
function removeStaleSkills(root, keep) {
  const removed = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !validSkillName(entry.name) || keep.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (!readMarker(dir)) continue;
    let real;
    try { real = fs.realpathSync(dir); } catch { continue; }
    if (real !== dir || path.dirname(real) !== root) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  // Left behind by a write that was interrupted.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(TEMP_PREFIX)) fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
  return removed.sort();
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

function normalizeState(value) {
  const given = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const following = given.following && typeof given.following === 'object' && INSTANCE_ID.test(String(given.following.instance_id || ''))
    ? { instance_id: given.following.instance_id, name: String(given.following.name || ''), since: given.following.since || null } : null;
  const received = given.received && typeof given.received === 'object' ? given.received : {};
  return {
    role: ROLES.includes(given.role) ? given.role : 'off',
    codex: given.codex !== false,
    skills: Array.isArray(given.skills) ? [...new Set(given.skills.filter(validSkillName))].sort() : [],
    following,
    received: {
      revision: typeof received.revision === 'string' ? received.revision : null,
      synced_at: typeof received.synced_at === 'string' ? received.synced_at : null,
      conflicts: Array.isArray(received.conflicts) ? received.conflicts : [],
    },
  };
}

const errorCode = error => (/^[A-Z0-9_]+$/.test((error && (error.code || error.message)) || '') ? (error.code || error.message) : 'RULE_SYNC_FAILED');
const unref = timer => { if (timer && timer.unref) timer.unref(); return timer; };

function createRuleSync({ db, serviceLinks = null, request = null, identity = () => ({ instance_id: null, name: '' }), env = process.env, home = os.homedir(), now = Date.now, log = console, timing = {}, watch = fs.watch }) {
  const paths = layout({ env, home });
  const times = { ...TIMING, ...timing };
  const targets = new Map(); // link id -> what the source last learned about that peer
  const runs = new Map(); // link id -> the sync running for it
  let snapshot = null; // the source's current bundle: { bundle, warnings } or { error }
  let lastChangeAt = null;
  let localError = null;
  let started = false;
  let unsubscribe = null;
  let timers = [];
  let watchers = [];
  let debounce = null;

  const iso = () => new Date(now()).toISOString();
  function load() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    try { return normalizeState(row ? JSON.parse(row.value) : {}); } catch { return normalizeState({}); }
  }
  function save(state) {
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify(normalizeState(state)));
  }
  function self() {
    const value = identity() || {};
    return { instance_id: value.instance_id || value.engine_id || null, name: value.name || '' };
  }

  const ensureImport = () => editUserFile(paths.claudeMd, text => withImportLine(text, paths.importLine));
  const writeCodex = rules => editUserFile(paths.codexAgents, text => withCodexBlock(text, rules));

  // ----- Receiver -----

  function receiverStatus() {
    const state = load();
    return {
      role: state.role,
      following: state.following ? { instance_id: state.following.instance_id, name: state.following.name } : null,
      revision: state.received.revision,
      synced_at: state.received.synced_at,
      conflicts: state.received.conflicts,
      codex: state.codex,
    };
  }

  // PUT /v1/rule-sync/bundle. Synchronous from start to end, so two bundles never interleave.
  function receive(body) {
    const state = load();
    if (state.role !== 'receive') fail('RULE_SYNC_NOT_RECEIVING', 403);
    const bundle = parseBundle(body);
    if (state.following && state.following.instance_id !== bundle.source.instance_id) {
      fail('RULE_SYNC_OTHER_SOURCE', 409, { following: { instance_id: state.following.instance_id, name: state.following.name } });
    }
    const syncedAt = iso();
    const following = { instance_id: bundle.source.instance_id, name: bundle.source.name || (state.following && state.following.name) || '', since: (state.following && state.following.since) || syncedAt };
    // The source is remembered first: a failure further down still leaves this service following it.
    save({ ...state, following });

    editUserFile(paths.sharedRules, () => bundle.rules);
    ensureImport();
    const codex = state.codex ? (writeCodex(bundle.rules), true) : false;

    fs.mkdirSync(paths.skillsDir, { recursive: true, mode: 0o755 });
    const root = fs.realpathSync(paths.skillsDir);
    const marker = { source: bundle.source, revision: bundle.revision, synced_at: syncedAt };
    const written = [];
    const conflicts = [];
    for (const skill of bundle.skills) {
      const result = writeSkill(root, skill, marker);
      if (result.conflict) conflicts.push(result.conflict);
      else if (result.written) written.push(skill.name);
    }
    const removed = removeStaleSkills(root, new Set(bundle.skills.map(skill => skill.name)));
    save({ ...load(), following, received: { revision: bundle.revision, synced_at: syncedAt, conflicts } });
    return { revision: bundle.revision, applied: { rules: true, codex, skills: written, removed, conflicts } };
  }

  // ----- Source -----

  function refreshSnapshot() {
    const state = load();
    if (state.role !== 'source') { snapshot = null; return null; }
    const previous = snapshot && snapshot.bundle ? snapshot.bundle.revision : null;
    try {
      snapshot = buildBundle({ paths, skills: state.skills, source: self() });
    } catch (error) {
      snapshot = { error: error instanceof RuleSyncError ? { code: error.code, ...error.extra } : { code: errorCode(error) } };
      if (!(error instanceof RuleSyncError)) log.error('[rule-sync] reading the shared layer failed:', error && error.message);
      return snapshot;
    }
    if (snapshot.bundle.revision !== previous) {
      lastChangeAt = iso();
      // The source's own Codex gets the same shared rules.
      try { if (state.codex) writeCodex(snapshot.bundle.rules); localError = null; }
      catch (error) { localError = errorCode(error); }
    }
    return snapshot;
  }
  const currentSnapshot = () => snapshot || refreshSnapshot();

  const peers = () => {
    if (!serviceLinks) return [];
    try { return serviceLinks.peers(); } catch { return []; }
  };
  function entryOf(peer) {
    if (!targets.has(peer.id)) targets.set(peer.id, { status: 'unknown', role: null, revision: null, following: null, last_push_at: null, last_error: null, conflicts: [] });
    return targets.get(peer.id);
  }

  async function syncOnce(peer, force) {
    if (load().role !== 'source' || !request) return;
    const entry = entryOf(peer);
    const built = currentSnapshot();
    try {
      const info = await request(peer.baseUrl, '/v1/info', peer.token, { timeoutMs: times.requestTimeoutMs });
      if (!info || !Array.isArray(info.capabilities) || !info.capabilities.includes(CAPABILITY)) {
        Object.assign(entry, { status: 'unsupported', role: null, last_error: null });
        return;
      }
      const status = await request(peer.baseUrl, `${ROUTE}/status`, peer.token, { timeoutMs: times.requestTimeoutMs });
      Object.assign(entry, {
        role: status && ROLES.includes(status.role) ? status.role : null,
        revision: status && typeof status.revision === 'string' ? status.revision : null,
        following: status && status.following ? status.following : null,
        conflicts: status && Array.isArray(status.conflicts) ? status.conflicts : [],
      });
      // Only a peer that chose to receive gets anything.
      if (entry.role !== 'receive') { Object.assign(entry, { status: 'not-receiving', last_error: null }); return; }
      const me = self().instance_id;
      if (entry.following && entry.following.instance_id !== me) { Object.assign(entry, { status: 'other-source', last_error: 'RULE_SYNC_OTHER_SOURCE' }); return; }
      if (!built || !built.bundle) { Object.assign(entry, { status: 'error', last_error: (built && built.error && built.error.code) || 'RULE_SYNC_FAILED' }); return; }
      if (!force && entry.following && entry.revision === built.bundle.revision) { Object.assign(entry, { status: 'up-to-date', last_error: null }); return; }
      const answer = await request(peer.baseUrl, `${ROUTE}/bundle`, peer.token, { method: 'PUT', body: built.bundle, timeoutMs: times.pushTimeoutMs });
      Object.assign(entry, {
        status: 'up-to-date', last_error: null, last_push_at: iso(),
        revision: answer && typeof answer.revision === 'string' ? answer.revision : built.bundle.revision,
        following: { instance_id: me, name: self().name },
        conflicts: answer && answer.applied && Array.isArray(answer.applied.conflicts) ? answer.applied.conflicts : [],
      });
    } catch (error) {
      if (error && error.statusCode === 401 && typeof serviceLinks.noteUnauthorized === 'function') {
        try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* the next call tries again */ }
      }
      Object.assign(entry, { status: error && error.statusCode === 409 ? 'other-source' : 'error', last_error: errorCode(error) });
    }
  }

  // One sync per peer at a time; a request that comes while one runs makes it run once more afterwards.
  function syncPeer(peer, { force = false } = {}) {
    const running = runs.get(peer.id);
    if (running) { running.again = true; running.force = running.force || force; return running.promise; }
    const run = { again: false, force };
    run.promise = (async () => {
      do {
        const forced = run.force;
        run.again = false;
        run.force = false;
        const live = peers().find(candidate => candidate.id === peer.id) || peer;
        if (live.online) await syncOnce(live, forced);
      } while (run.again);
    })().catch(error => log.error('[rule-sync] sync failed:', error && error.message)).finally(() => runs.delete(peer.id));
    runs.set(peer.id, run);
    return run.promise;
  }
  const pushAll = (options = {}) => Promise.all(peers().filter(peer => peer.online).map(peer => syncPeer(peer, options)));

  // The shared layer changed (or may have): read it again and push only when its revision (or the reason it cannot be sent) moved.
  const snapshotKey = value => (!value ? null : value.bundle ? value.bundle.revision : `error:${JSON.stringify(value.error)}`);
  function check() {
    if (load().role !== 'source') return Promise.resolve();
    const before = snapshotKey(snapshot);
    if (snapshotKey(refreshSnapshot()) === before) return Promise.resolve();
    return pushAll();
  }
  function scheduleCheck() {
    if (debounce) clearTimeout(debounce);
    debounce = unref(setTimeout(() => { debounce = null; check(); }, times.debounceMs));
  }
  // Peers whose last known revision is not ours are asked again; a peer that switched to receive is found this way too.
  function retry() {
    if (load().role !== 'source') return Promise.resolve();
    const built = currentSnapshot();
    const revision = built && built.bundle ? built.bundle.revision : null;
    return Promise.all(peers().filter(peer => peer.online).filter(peer => {
      const entry = targets.get(peer.id);
      return !entry || entry.status !== 'up-to-date' || entry.revision !== revision;
    }).map(peer => syncPeer(peer)));
  }

  function closeWatchers() {
    for (const watcher of watchers) { try { watcher.close(); } catch { /* already closed */ } }
    watchers = [];
  }
  // fs.watch where it works; the poll catches whatever it misses.
  function rewatch() {
    closeWatchers();
    const state = load();
    if (!started || state.role !== 'source') return;
    const watchOne = (dir, recursive) => {
      try {
        const watcher = watch(dir, { recursive, persistent: false }, () => scheduleCheck());
        watcher.on('error', () => { try { watcher.close(); } catch { /* gone */ } });
        watchers.push(watcher);
      } catch { /* missing folder or no recursive watch here: the poll covers it */ }
    };
    watchOne(path.dirname(paths.sharedRules), false);
    for (const name of state.skills) watchOne(path.join(paths.skillsDir, name), true);
  }

  function start() {
    if (started) return;
    started = true;
    if (serviceLinks && typeof serviceLinks.onChange === 'function') {
      unsubscribe = serviceLinks.onChange(id => {
        const peer = peers().find(candidate => candidate.id === id);
        if (!peer) { targets.delete(id); return; }
        if (peer.online && load().role === 'source') syncPeer(peer);
      });
    }
    if (times.pollMs > 0) timers.push(unref(setInterval(() => { check(); }, times.pollMs)));
    if (times.retryMs > 0) timers.push(unref(setInterval(() => { retry(); }, times.retryMs)));
    rewatch();
    setImmediate(() => { if (started) check(); });
  }
  function stop() {
    started = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    for (const timer of timers) clearInterval(timer);
    timers = [];
    if (debounce) clearTimeout(debounce);
    debounce = null;
    closeWatchers();
  }

  // ----- The browser's view and actions -----

  function overview() {
    const state = load();
    const claudeMd = readText(paths.claudeMd);
    const codexText = readText(paths.codexAgents);
    const local = listSkills(paths.skillsDir);
    const names = new Set(local.map(skill => skill.name));
    const skills = [
      ...local.map(skill => ({ ...skill, shared: state.skills.includes(skill.name) })),
      ...state.skills.filter(name => !names.has(name)).map(name => ({ name, shared: true, missing: true })),
    ].sort(byKey('name'));
    const built = state.role === 'source' ? currentSnapshot() : null;
    return {
      role: state.role,
      codex: state.codex,
      shared_rules_path: paths.sharedRules,
      shared_rules_exists: Boolean(lstatOrNull(paths.sharedRules)),
      import_line: paths.importLine,
      import_line_present: hasImportLine(claudeMd, paths.importLine),
      claude_md_path: paths.claudeMd,
      codex_agents_path: paths.codexAgents,
      codex_block_present: hasCodexBlock(codexText),
      skills,
      following: state.following,
      received: state.received,
      revision: built && built.bundle ? built.bundle.revision : null,
      bundle_error: built && built.error ? built.error : null,
      warnings: built && built.warnings ? built.warnings : [],
      local_error: localError,
      last_change_at: lastChangeAt,
      targets: state.role === 'source' ? peers().map(peer => {
        const entry = targets.get(peer.id) || entryOf(peer);
        return {
          id: peer.id, name: peer.name, online: Boolean(peer.online), status: peer.online ? entry.status : 'offline',
          role: entry.role, revision: entry.revision, last_push_at: entry.last_push_at, last_error: entry.last_error, conflicts: entry.conflicts,
        };
      }) : [],
    };
  }

  // PUT /api/rule-sync `{ role?, codex?, skills? }`.
  function update(body) {
    const given = body && typeof body === 'object' && !Array.isArray(body) ? body : fail('RULE_SYNC_INVALID_SETTINGS', 400);
    const state = load();
    const next = { ...state };
    if (given.role !== undefined) { if (!ROLES.includes(given.role)) fail('RULE_SYNC_INVALID_SETTINGS', 400, { field: 'role' }); next.role = given.role; }
    if (given.codex !== undefined) { if (typeof given.codex !== 'boolean') fail('RULE_SYNC_INVALID_SETTINGS', 400, { field: 'codex' }); next.codex = given.codex; }
    if (given.skills !== undefined) {
      if (!Array.isArray(given.skills) || given.skills.length > LIMITS.skills || !given.skills.every(validSkillName)) fail('RULE_SYNC_INVALID_SETTINGS', 400, { field: 'skills' });
      next.skills = [...new Set(given.skills)].sort();
    }
    save(next);
    if (next.role !== 'off') {
      try { ensureImport(); } catch (error) { localError = errorCode(error); }
    }
    if (next.role !== 'source') { snapshot = null; targets.clear(); }
    if (next.role === 'source') {
      const roleChanged = state.role !== 'source';
      if (roleChanged || state.codex !== next.codex) snapshot = null; // the own Codex block is written with the next snapshot
      refreshSnapshot();
      setImmediate(() => { pushAll(); });
    }
    rewatch();
    return overview();
  }

  function createShared() {
    if (!lstatOrNull(paths.sharedRules)) writeAtomic(paths.sharedRules, SHARED_TEMPLATE, 0o644);
    if (load().role !== 'off') ensureImport();
    rewatch();
    if (load().role === 'source') scheduleCheck();
    return overview();
  }

  async function pushNow() {
    if (load().role !== 'source') fail('RULE_SYNC_NOT_SOURCE', 403);
    refreshSnapshot();
    await pushAll({ force: true });
    return overview();
  }

  function resetSource() {
    const state = load();
    save({ ...state, following: null, received: { revision: null, synced_at: null, conflicts: [] } });
    return overview();
  }

  // The import line out of CLAUDE.md and the managed block out of AGENTS.md; the shared files and synced skills stay.
  function removeImport() {
    editUserFile(paths.claudeMd, text => (text === null ? null : withoutImportLine(text, paths.importLine)));
    editUserFile(paths.codexAgents, text => (text === null ? null : withoutCodexBlock(text)));
    return overview();
  }

  return {
    paths, receiverStatus, receive, overview, update, createShared, pushNow, resetSource, removeImport,
    check, retry, pushAll, syncPeer, refreshSnapshot, start, stop,
  };
}

let singleton = null;
function getRuleSync() {
  if (singleton) return singleton;
  const { getEngineIdentity } = require('./engine-identity');
  singleton = createRuleSync({
    db: require('../db'),
    serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
    identity: () => { const { engine_id: instanceId, name } = getEngineIdentity(); return { instance_id: instanceId, name }; },
  });
  return singleton;
}

module.exports = {
  createRuleSync, getRuleSync, RuleSyncError, layout, buildBundle, parseBundle, revisionOf,
  withImportLine, withoutImportLine, withCodexBlock, withoutCodexBlock, hasImportLine, hasCodexBlock,
  STATE_KEY, CAPABILITY, ROLES, MARKER, LIMITS, IMPORT_COMMENT, CODEX_BEGIN, CODEX_END, TIMING,
};
