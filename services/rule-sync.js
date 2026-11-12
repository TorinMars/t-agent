'use strict';
// Rules and skills sync: one linked service (the source) shares a layer of Claude rules, chosen Claude skills and the same rules for Codex with the linked
// services that only receive. Each machine's own rules and skills are never read, sent or changed. See "Rules and skills sync" in DESIGN.md.
//
// On disk (Claude config dir = $CLAUDE_CONFIG_DIR or ~/.claude, Codex home = $CODEX_HOME or ~/.codex):
//   <claude>/shared/CLAUDE.shared.md   the shared rules (edited by hand on the source, written by the sync on a receiver)
//   <claude>/CLAUDE.md                 one managed import line at the top, nothing else is touched
//   <claude>/skills/<name>/            a shared skill; on a receiver it carries the marker file .t-agent-sync.json
//   <codex>/AGENTS.md                  the shared rules inside a managed block, nothing outside the block is touched
//   <data>/rule-sync/applied-bundle.json   on a receiver: the last applied bundle and a hash of every file written from it (the guard below)
//   <data>/rule-sync/overwritten/<time>/   on a receiver: local edits of synced files, saved before the guard put the synced version back
//   <claude>/shared/claude-settings.json   on a receiver: the shared Claude settings, injected at session start (services/shared-claude-settings.js)
//   <claude>/shared/statusline/<name>      on a receiver: the scripts of a shared status line
//
// The setting is one system_state row, `rule_sync_v1`. Transport: the source PUTs a bundle to /v1/rule-sync/bundle of every linked receiver; a receiver
// has no route that reads its rules or skills back, so it never sends them anywhere. The shared rules file can be edited from the page of any linked
// service: the edit always goes to the source (GET / PUT /v1/rule-sync/shared there), which then pushes it as usual.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeShared = require('./shared-claude-settings');

const STATE_KEY = 'rule_sync_v1';
const CAPABILITY = 'rule-sync:receive';
// GET / PUT /v1/rule-sync/shared: the shared rules file of the source can be read and written from a linked service.
const EDIT_CAPABILITY = 'rule-sync:edit';
// The bundle may carry `claude_settings`. An older receiver recomputes the revision without it and would refuse the bundle, so it gets one without the field.
const SETTINGS_CAPABILITY = 'rule-sync:claude-settings';
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
// The first line of the shared rules file on a receiver (and inside its Codex block): where to edit them. Never part of the bundle revision.
const NOTICE_LINE = /^<!-- Synced by T-Agent from [^\n]*-->\r?\n(?:\r?\n)?/;
const KEEP = Object.freeze({ backups: 20, localChanges: 20 });
const TIMING = Object.freeze({
  debounceMs: 2_000, pollMs: 30_000, retryMs: 60_000, requestTimeoutMs: 10_000, pushTimeoutMs: 120_000, guardDebounceMs: 2_000, guardPollMs: 30_000,
});

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
    claudeDir, codexDir, sharedRules, home,
    claudeSettings: path.join(claudeDir, 'settings.json'),
    sharedClaudeSettings: path.join(claudeDir, 'shared', 'claude-settings.json'),
    statuslineDir: path.join(claudeDir, 'shared', 'statusline'),
    claudeMd: path.join(claudeDir, 'CLAUDE.md'),
    skillsDir: path.join(claudeDir, 'skills'),
    codexAgents: path.join(codexDir, 'AGENTS.md'),
    // Claude Code resolves `~/` in an import; a config dir elsewhere is named by its absolute path.
    importLine: claudeDir === defaultClaude ? '@~/.claude/shared/CLAUDE.shared.md' : `@${sharedRules}`,
  };
}

const isMissing = error => error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
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
function codexBlock(rules, notice = '') {
  // The marker lines themselves never appear inside, or the next update would find the wrong end.
  const inner = String(rules || '').split('\n').filter(line => !lineMatches(line, CODEX_BEGIN) && !lineMatches(line, CODEX_END)).join('\n').replace(/\s+$/, '');
  return `${CODEX_BEGIN}\n${notice ? `${notice}\n` : ''}${inner ? `${inner}\n` : ''}${CODEX_END}`;
}
// The block placed at the top on the first write; afterwards only its inside changes. `notice` (a receiver's) is the first line inside.
function withCodexBlock(text, rules, notice = '') {
  const block = codexBlock(rules, notice);
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
// The text between the two marker lines, or null when there is no block.
function codexInner(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  const found = findBlock(lines);
  return found ? lines.slice(found.begin + 1, found.end).join('\n') : null;
}

// The notice a receiver puts on top of the shared rules file and inside its Codex block. The name cannot end the comment or break the line.
function syncedNotice(name) {
  const clean = String(name || '').replace(/[\r\n\t]+/g, ' ').replace(/-{2,}/g, '-').replace(/[<>]/g, '').trim().slice(0, LIMITS.nameLength) || 'the source';
  return `<!-- Synced by T-Agent from ${clean}. Edit it on ${clean} or in the T-Agent page (Settings > Rules and skills sync); changes made here are replaced. -->`;
}
const withNotice = (rules, notice) => `${notice}\n\n${rules}`;
// The rules without a receiver's notice: a service that was a receiver and became the source does not send its old notice on.
const withoutNotice = text => String(text || '').replace(NOTICE_LINE, '');

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
// The revision of a bundle: the hash of its content, so the same rules, skills and shared Claude settings give the same revision on every machine. Without
// shared settings it is the revision older services compute from the rules and skills alone.
function revisionOf(rules, skills, claudeSettings = null) {
  const hash = crypto.createHash('sha256');
  hash.update(`rules\0${rules}\0`);
  for (const skill of [...skills].sort(byKey('name'))) hash.update(`skill\0${skill.name}\0${skillHash(skill.files)}\0`);
  const settings = claudeShared.settingsHash(claudeSettings);
  if (settings) hash.update(`claude_settings\0${settings}\0`);
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

// What the source sends: its shared rules file (empty when there is none), the chosen skills and, with `claudeKeys`, the chosen keys of its Claude
// settings.json with the status line scripts. `legacy` is the same bundle without the settings, for a receiver that does not know them. Throws
// RULE_SYNC_TOO_LARGE over a cap.
function buildBundle({ paths, skills: chosen, source, claudeKeys = null }) {
  const warnings = [];
  const rules = withoutNotice(readText(paths.sharedRules));
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
  const legacy = { source, revision: revisionOf(rules, skills), rules, skills };
  if (!claudeKeys) return { bundle: legacy, legacy, warnings, claude: null };
  const claude = claudeShared.collect({ claudeDir: paths.claudeDir, home: paths.home, keys: claudeKeys });
  for (const file of claude.shared.files) {
    budget.bytes += Buffer.from(file.content_base64, 'base64').length;
    if (budget.bytes > LIMITS.totalBytes) throw tooLarge('total', `statusline/${file.path}`);
  }
  if (claudeShared.isEmpty(claude.shared)) return { bundle: legacy, legacy, warnings, claude };
  const bundle = { ...legacy, revision: revisionOf(rules, skills, claude.shared), claude_settings: claude.shared };
  return { bundle, legacy, warnings, claude };
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
  // Shared Claude settings (optional; a bundle of an older source has none, which means nothing is shared).
  const claudeSettings = claudeShared.parseShared(body.claude_settings, { invalid, tooLarge });
  if (claudeSettings) for (const file of claudeSettings.files) { total += file.data.length; if (total > LIMITS.totalBytes) throw tooLarge('total', `statusline/${file.path}`); }
  if (revisionOf(body.rules, skills, claudeSettings && claudeSettings.raw) !== body.revision) invalid('revision does not match the content');
  return { source: { instance_id: source.instance_id, name }, revision: body.revision, rules: body.rules, skills, claudeSettings };
}

// One skill into <skills root>/<name>: built in a temporary folder, then renamed into place. A folder without our marker (a local skill), a symlink or a
// file at that name is a conflict and is left alone.
function writeSkill(root, skill, marker, { force = false } = {}) {
  const target = path.join(root, skill.name);
  const stat = lstatOrNull(target);
  if (stat && stat.isSymbolicLink()) return { conflict: { skill: skill.name, reason: 'symlink' } };
  if (stat && !stat.isDirectory()) return { conflict: { skill: skill.name, reason: 'not-a-directory' } };
  if (stat) {
    const existing = readMarker(target);
    if (!existing) return { conflict: { skill: skill.name, reason: 'local' } };
    if (!force && existing.skill_hash === skill.hash) {
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
    // On a receiver: synced files that were changed here and put back by the guard, newest first.
    local_changes: Array.isArray(given.local_changes) ? given.local_changes.slice(0, KEEP.localChanges) : [],
    // On a source: the Claude settings keys it shares; null until the person chooses, which means claudeShared.DEFAULT_KEYS. Denied keys never stay.
    claude_settings_keys: claudeShared.cleanKeys(given.claude_settings_keys),
    // On a receiver: the received keys not injected here, so this machine's own settings.json value wins.
    keep_local: claudeShared.cleanKeys(given.keep_local) || [],
  };
}
const sharedKeysOf = state => state.claude_settings_keys || [...claudeShared.DEFAULT_KEYS];

// The shared Claude settings that a Claude session started by T-Agent here gets with `--settings` (routes/terminal.js): only on a receiver that follows a
// source, from <claude>/shared/claude-settings.json, without the keys kept local. A missing file gives {}; a malformed one gives {} and is logged once.
const reportedSettingsErrors = new Map();
function sessionClaudeSettings({ db, env = process.env, home = os.homedir(), log = console } = {}) {
  let state;
  try {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    state = normalizeState(row ? JSON.parse(row.value) : {});
  } catch { return {}; }
  if (state.role !== 'receive' || !state.following) return {};
  const file = layout({ env, home }).sharedClaudeSettings;
  let values;
  try { values = claudeShared.readFileValues(file); } catch (error) {
    let signature = error.message;
    try { const stat = fs.statSync(file); signature = `${stat.mtimeMs}:${stat.size}`; } catch { /* the message is the signature */ }
    if (reportedSettingsErrors.get(file) !== signature) {
      reportedSettingsErrors.set(file, signature);
      log.warn(`[rule-sync] ${file} cannot be read, so no shared Claude settings are added to new sessions: ${error.message}`);
    }
    return {};
  }
  reportedSettingsErrors.delete(file);
  if (!values) return {};
  for (const key of state.keep_local) delete values[key];
  return claudeShared.nest(values);
}

const errorCode = error => (/^[A-Z0-9_]+$/.test((error && (error.code || error.message)) || '') ? (error.code || error.message) : 'RULE_SYNC_FAILED');
const unref = timer => { if (timer && timer.unref) timer.unref(); return timer; };

function createRuleSync({ db, serviceLinks = null, request = null, identity = () => ({ instance_id: null, name: '' }), env = process.env, home = os.homedir(), now = Date.now, log = console, timing = {}, watch = fs.watch, dataDir = null }) {
  const paths = layout({ env, home });
  // The receiver's own records (the guard); without a data folder there is no guard.
  const store = dataDir ? { dir: path.join(dataDir, 'rule-sync'), applied: path.join(dataDir, 'rule-sync', 'applied-bundle.json'), backups: path.join(dataDir, 'rule-sync', 'overwritten') } : null;
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
  let guardDebounce = null;

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
  const writeCodex = (rules, notice = '') => editUserFile(paths.codexAgents, text => withCodexBlock(text, rules, notice));

  // ----- Receiver -----

  function receiverStatus() {
    const state = load();
    const me = self();
    return {
      // Who answers: a linked service that looks for the source of the shared rules (sharedTarget) matches it with `following`.
      instance_id: me.instance_id,
      name: me.name,
      role: state.role,
      following: state.following ? { instance_id: state.following.instance_id, name: state.following.name } : null,
      revision: state.received.revision,
      synced_at: state.received.synced_at,
      conflicts: state.received.conflicts,
      codex: state.codex,
    };
  }

  // The shared Claude settings of a bundle on this receiver: the status line scripts into <claude>/shared/statusline/ (a link or a file at that folder's
  // name is left alone, and the status line is then not shared), the values into <claude>/shared/claude-settings.json with the status line command
  // pointing to the copies here. Scripts that the last bundle wrote and this one has not are removed; nothing shared removes the settings file.
  // Returns what was written: { text (the file, or null), files: [{ path, mode, content_base64, sha256 }] }.
  function writeClaudeSettings(shared, sourceName, previous) {
    const values = { ...((shared && shared.values) || {}) };
    const files = (shared && shared.files) || [];
    const dirStat = lstatOrNull(paths.statuslineDir);
    const dirSafe = !dirStat || (dirStat.isDirectory() && !dirStat.isSymbolicLink());
    const written = [];
    if (dirSafe) {
      for (const file of files) {
        writeAtomic(path.join(paths.statuslineDir, file.path), file.data, fileMode(file.mode));
        written.push({ path: file.path, mode: file.mode, content_base64: file.content_base64, ref: file.ref, sha256: sha256(file.data) });
      }
      for (const name of previous || []) {
        if (files.some(file => file.path === name)) continue;
        const target = path.join(paths.statuslineDir, name);
        const stat = lstatOrNull(target);
        if (stat && stat.isFile()) fs.rmSync(target, { force: true });
      }
    }
    // A status line whose scripts could not be written here would run the source's paths: it is left out.
    if (values.statusLine) {
      if (files.length && !dirSafe) delete values.statusLine;
      else values.statusLine = claudeShared.rewriteStatusLine(values.statusLine, written, paths);
    }
    if (!Object.keys(values).length) {
      const stat = lstatOrNull(paths.sharedClaudeSettings);
      if (stat && stat.isFile()) fs.rmSync(paths.sharedClaudeSettings, { force: true });
      return { text: null, files: written, keys: [] };
    }
    const text = claudeShared.fileText(values, sourceName);
    writeAtomic(paths.sharedClaudeSettings, text, 0o644);
    return { text, files: written, keys: Object.keys(values) };
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
    // Local edits of the files written from the last bundle are saved first: the new bundle never replaces them without a note.
    guardCheck({ restore: false });

    const notice = syncedNotice(following.name);
    editUserFile(paths.sharedRules, () => withNotice(bundle.rules, notice));
    ensureImport();
    const codex = state.codex ? (writeCodex(bundle.rules, notice), true) : false;

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
    const before = readApplied();
    const previousScripts = before && before.claude_settings ? before.claude_settings.files.map(file => file.path) : [];
    const claudeSettings = writeClaudeSettings(bundle.claudeSettings, following.name, previousScripts);
    save({ ...load(), following, received: { revision: bundle.revision, synced_at: syncedAt, conflicts } });
    const clashing = new Set(conflicts.map(item => item.skill));
    recordApplied(bundle, { following, notice, codex, syncedAt, skills: bundle.skills.filter(skill => !clashing.has(skill.name)), claudeSettings });
    rewatch();
    return { revision: bundle.revision, applied: { rules: true, codex, skills: written, removed, conflicts, claude_settings: claudeSettings.keys, statusline_files: claudeSettings.files.map(file => file.path) } };
  }

  // ----- Receiver: the guard of the synced copies -----
  //
  // After a bundle is applied, the receiver keeps it in <data>/rule-sync/applied-bundle.json with a SHA-256 of every file it wrote: the shared rules file
  // (with the notice), the inside of the Codex block, every file of every skill folder it owns (the ones with the marker) and the list of files in each.
  // When one of them is changed here (edited, deleted, a file added to a marked skill folder, or the import line taken out of CLAUDE.md), the changed
  // version is saved to <data>/rule-sync/overwritten/<time>/ and the synced version is put back. Hashes are compared, never events, so the guard's own
  // writes do not start it again.

  function privateDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  function readApplied() {
    if (!store) return null;
    try {
      const value = JSON.parse(fs.readFileSync(store.applied, 'utf8'));
      return value && value.version === 1 && value.source && Array.isArray(value.skills) && value.hashes ? value : null;
    } catch { return null; }
  }
  function clearApplied() {
    if (store) { try { fs.rmSync(store.applied, { force: true }); } catch { /* nothing kept */ } }
  }
  function recordApplied(bundle, { following, notice, codex, syncedAt, skills, claudeSettings }) {
    if (!store) return;
    try {
      privateDir(store.dir);
      const record = {
        version: 1, source: { instance_id: following.instance_id, name: following.name }, revision: bundle.revision, synced_at: syncedAt, notice, codex,
        rules: bundle.rules,
        hashes: { shared: sha256(withNotice(bundle.rules, notice)), codex: codex ? (inner => (inner === null ? null : sha256(inner)))(codexInner(readText(paths.codexAgents))) : null },
        skills: skills.map(skill => ({
          name: skill.name, hash: skill.hash,
          files: skill.files.map(file => ({ path: file.path, mode: file.mode, content_base64: file.content_base64, sha256: sha256(file.data) })),
        })),
        // The shared Claude settings file as written (null when nothing is shared) and the status line scripts.
        claude_settings: claudeSettings ? {
          text: claudeSettings.text, sha256: claudeSettings.text === null ? null : sha256(claudeSettings.text),
          files: claudeSettings.files.map(file => ({ path: file.path, mode: file.mode, content_base64: file.content_base64, sha256: file.sha256 })),
        } : null,
      };
      writeAtomic(store.applied, JSON.stringify(record), 0o600);
    } catch (error) {
      localError = errorCode(error);
      log.error('[rule-sync] keeping the applied bundle failed:', error && error.message);
    }
  }

  // The files in a skill folder: path -> sha256 (null for a link or a special file). Never follows a link; .git, .DS_Store and the marker are skipped.
  function scanSkill(dir) {
    const found = new Map();
    const walk = (folder, relative) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (SKIPPED.has(entry.name) || (!relative && entry.name === MARKER)) continue;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(full, rel);
        else found.set(rel, entry.isFile() ? sha256(fs.readFileSync(full)) : null);
      }
    };
    walk(dir, '');
    return found;
  }

  // What differs from the applied bundle: [{ paths, saved: [{ rel, data }], restore }].
  function localDifferences(applied, state) {
    const changes = [];
    const shared = readText(paths.sharedRules);
    if (shared === null || sha256(shared) !== applied.hashes.shared) {
      changes.push({
        paths: [paths.sharedRules], saved: shared === null ? [] : [{ rel: 'claude/shared/CLAUDE.shared.md', data: shared }],
        restore: () => editUserFile(paths.sharedRules, () => withNotice(applied.rules, applied.notice)),
      });
    }
    // Only the managed import line of CLAUDE.md is ours; the rest of the file is never compared.
    const claudeMd = readText(paths.claudeMd);
    if (!hasImportLine(claudeMd, paths.importLine)) {
      changes.push({ paths: [paths.claudeMd], saved: claudeMd === null ? [] : [{ rel: 'claude/CLAUDE.md', data: claudeMd }], restore: ensureImport });
    }
    if (applied.codex && state.codex && applied.hashes.codex) {
      const text = readText(paths.codexAgents);
      const inner = codexInner(text);
      if (inner === null || sha256(inner) !== applied.hashes.codex) {
        changes.push({ paths: [paths.codexAgents], saved: text === null ? [] : [{ rel: 'codex/AGENTS.md', data: text }], restore: () => writeCodex(applied.rules, applied.notice) });
      }
    }
    // The shared Claude settings file and the status line scripts: edited or deleted ones are put back. Other files in that folder are not ours to compare.
    const settings = applied.claude_settings;
    if (settings && settings.text !== null && typeof settings.text === 'string') {
      const now = readText(paths.sharedClaudeSettings);
      if (now === null || sha256(now) !== settings.sha256) {
        changes.push({
          paths: [paths.sharedClaudeSettings], saved: now === null ? [] : [{ rel: 'claude/shared/claude-settings.json', data: now }],
          restore: () => writeAtomic(paths.sharedClaudeSettings, settings.text, 0o644),
        });
      }
    }
    const scriptsDir = lstatOrNull(paths.statuslineDir);
    if (settings && Array.isArray(settings.files) && (!scriptsDir || (scriptsDir.isDirectory() && !scriptsDir.isSymbolicLink()))) {
      for (const file of settings.files) {
        const target = path.join(paths.statuslineDir, file.path);
        const stat = lstatOrNull(target);
        if (stat && !stat.isFile()) continue; // a link or a folder put there is the user's
        const data = stat ? fs.readFileSync(target) : null;
        if (data && sha256(data) === file.sha256) continue;
        changes.push({
          paths: [target], saved: data ? [{ rel: `claude/shared/statusline/${file.path}`, data }] : [],
          restore: () => writeAtomic(target, Buffer.from(file.content_base64, 'base64'), fileMode(file.mode)),
        });
      }
    }
    let root = null;
    try { root = fs.realpathSync(paths.skillsDir); } catch { /* no skills folder any more: every owned skill is missing */ }
    for (const skill of applied.skills) {
      const dir = root ? path.join(root, skill.name) : path.join(paths.skillsDir, skill.name);
      const stat = lstatOrNull(dir);
      // A link or a file at that name, or a folder without the marker: not ours, never touched.
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || !readMarker(dir))) continue;
      const expected = new Map(skill.files.map(file => [file.path, file.sha256]));
      const actual = stat ? scanSkill(dir) : new Map();
      const changed = [];
      const saved = [];
      for (const [rel, hash] of expected) {
        if (!actual.has(rel)) changed.push(rel);
        else if (actual.get(rel) !== hash) {
          changed.push(rel);
          if (actual.get(rel) !== null) saved.push({ rel: `claude/skills/${skill.name}/${rel}`, data: fs.readFileSync(path.join(dir, ...rel.split('/'))) });
        }
      }
      for (const [rel, hash] of actual) {
        if (expected.has(rel)) continue;
        changed.push(rel);
        if (hash !== null) saved.push({ rel: `claude/skills/${skill.name}/${rel}`, data: fs.readFileSync(path.join(dir, ...rel.split('/'))) });
      }
      if (!stat || changed.length) {
        changes.push({
          paths: stat ? changed.sort().map(rel => path.join(paths.skillsDir, skill.name, ...rel.split('/'))) : [path.join(paths.skillsDir, skill.name)],
          saved,
          restore: () => {
            fs.mkdirSync(paths.skillsDir, { recursive: true, mode: 0o755 });
            const real = fs.realpathSync(paths.skillsDir);
            const files = skill.files.map(file => ({ path: file.path, mode: file.mode, content_base64: file.content_base64, data: Buffer.from(file.content_base64, 'base64') }));
            const marker = { source: applied.source, revision: applied.revision, synced_at: applied.synced_at };
            writeSkill(real, { name: skill.name, files, hash: skill.hash }, marker, { force: true });
          },
        });
      }
    }
    return changes;
  }

  // The changed versions into a new folder <data>/rule-sync/overwritten/<time>/ (0700, files 0600); only the 20 newest folders are kept.
  function saveOverwritten(items) {
    if (!items.length) return null;
    privateDir(store.backups);
    const stamp = iso().replace(/:/g, '-');
    let dir = path.join(store.backups, stamp);
    for (let index = 1; lstatOrNull(dir); index += 1) dir = path.join(store.backups, `${stamp}-${String(index).padStart(3, '0')}`); // sorts after `stamp`
    fs.mkdirSync(dir, { mode: 0o700 });
    for (const item of items) {
      const target = path.join(dir, ...item.rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, item.data, { mode: 0o600, flag: 'wx' });
    }
    const folders = fs.readdirSync(store.backups, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort();
    for (const name of folders.slice(0, Math.max(0, folders.length - KEEP.backups))) fs.rmSync(path.join(store.backups, name), { recursive: true, force: true });
    return dir;
  }

  // Compare, save what was changed here, and (unless `restore` is false, as before a new bundle is written) put the synced version back.
  // Returns the entry added to `local_changes`, or null when nothing differs.
  function guardCheck({ restore = true } = {}) {
    if (!store) return null;
    const state = load();
    if (state.role !== 'receive' || !state.following) return null;
    const applied = readApplied();
    if (!applied || applied.source.instance_id !== state.following.instance_id) return null;
    try {
      const changes = localDifferences(applied, state);
      if (!changes.length) return null;
      // Saved first: when that fails nothing is put back, so an edit is never lost.
      const backupDir = saveOverwritten(changes.flatMap(change => change.saved));
      if (restore) for (const change of changes) change.restore();
      const entry = { at: iso(), paths: changes.flatMap(change => change.paths), backup_dir: backupDir, source: applied.source.name || '', restored: restore };
      const now = load();
      save({ ...now, local_changes: [entry, ...now.local_changes].slice(0, KEEP.localChanges) });
      return entry;
    } catch (error) {
      localError = errorCode(error);
      log.error('[rule-sync] checking the synced files failed:', error && error.message);
      return null;
    }
  }
  function scheduleGuard() {
    if (guardDebounce) clearTimeout(guardDebounce);
    guardDebounce = unref(setTimeout(() => { guardDebounce = null; guardCheck(); }, times.guardDebounceMs));
  }

  // ----- Source -----

  function refreshSnapshot() {
    const state = load();
    if (state.role !== 'source') { snapshot = null; return null; }
    const previous = snapshot && snapshot.bundle ? snapshot.bundle.revision : null;
    try {
      snapshot = buildBundle({ paths, skills: state.skills, source: self(), claudeKeys: sharedKeysOf(state) });
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
    if (!targets.has(peer.id)) targets.set(peer.id, { status: 'unknown', role: null, revision: null, following: null, last_push_at: null, last_error: null, conflicts: [], settings: null });
    return targets.get(peer.id);
  }

  // The bundle for one peer: without the shared Claude settings when it does not know them.
  const bundleFor = (built, entry) => (entry && entry.settings === false ? built.legacy : built.bundle);

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
      // A receiver that does not know the shared Claude settings gets the bundle without them (and with the revision it computes).
      entry.settings = info.capabilities.includes(SETTINGS_CAPABILITY);
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
      const bundle = bundleFor(built, entry);
      if (!force && entry.following && entry.revision === bundle.revision) { Object.assign(entry, { status: 'up-to-date', last_error: null }); return; }
      const answer = await request(peer.baseUrl, `${ROUTE}/bundle`, peer.token, { method: 'PUT', body: bundle, timeoutMs: times.pushTimeoutMs });
      Object.assign(entry, {
        status: 'up-to-date', last_error: null, last_push_at: iso(),
        revision: answer && typeof answer.revision === 'string' ? answer.revision : bundle.revision,
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
    return Promise.all(peers().filter(peer => peer.online).filter(peer => {
      const entry = targets.get(peer.id);
      const revision = built && built.bundle ? bundleFor(built, entry).revision : null;
      return !entry || entry.status !== 'up-to-date' || entry.revision !== revision;
    }).map(peer => syncPeer(peer)));
  }

  function closeWatchers() {
    for (const watcher of watchers) { try { watcher.close(); } catch { /* already closed */ } }
    watchers = [];
  }
  // fs.watch where it works; the poll catches whatever it misses. A source watches its shared layer; a receiver watches the files it wrote (the guard).
  // `only` keeps the events of one folder to the names that matter (an event without a name is always taken).
  function rewatch() {
    closeWatchers();
    const state = load();
    if (!started) return;
    const watchOne = (dir, recursive, onEvent, only = null) => {
      try {
        const watcher = watch(dir, { recursive, persistent: false }, (event, name) => {
          if (!only || !name || only.has(String(name).split(path.sep)[0])) onEvent();
        });
        watcher.on('error', () => { try { watcher.close(); } catch { /* gone */ } });
        watchers.push(watcher);
      } catch { /* missing folder or no recursive watch here: the poll covers it */ }
    };
    if (state.role === 'source') {
      watchOne(path.dirname(paths.sharedRules), false, scheduleCheck);
      // settings.json and the status line scripts directly in <claude> (scripts deeper down are left to the poll).
      const scripts = snapshot && snapshot.claude ? snapshot.claude.scripts.filter(item => path.dirname(item.path) === paths.claudeDir).map(item => item.name) : [];
      watchOne(paths.claudeDir, false, scheduleCheck, new Set([path.basename(paths.claudeSettings), ...scripts]));
      for (const name of state.skills) watchOne(path.join(paths.skillsDir, name), true, scheduleCheck);
      return;
    }
    const applied = state.role === 'receive' && state.following ? readApplied() : null;
    if (!applied) return;
    watchOne(path.dirname(paths.sharedRules), false, scheduleGuard);
    if (applied.claude_settings && applied.claude_settings.files.length) watchOne(paths.statuslineDir, false, scheduleGuard);
    watchOne(paths.claudeDir, false, scheduleGuard, new Set([path.basename(paths.claudeMd)]));
    if (applied.codex) watchOne(paths.codexDir, false, scheduleGuard, new Set([path.basename(paths.codexAgents)]));
    const names = applied.skills.map(skill => skill.name);
    if (names.length) watchOne(paths.skillsDir, false, scheduleGuard, new Set(names));
    for (const name of names) watchOne(path.join(paths.skillsDir, name), true, scheduleGuard);
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
    if (times.guardPollMs > 0) timers.push(unref(setInterval(() => { guardCheck(); }, times.guardPollMs)));
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
    if (guardDebounce) clearTimeout(guardDebounce);
    guardDebounce = null;
    closeWatchers();
  }

  // ----- The browser's view and actions -----

  // The shared Claude settings part of the view. Source: the allowlisted keys present in its settings.json with a short preview, the chosen ones, the
  // status line scripts that go with them. Receiver: the received keys (from its claude-settings.json) and the ones kept local. Off: null.
  function claudeSettingsView(state) {
    if (state.role === 'source') {
      const collected = claudeShared.collect({ claudeDir: paths.claudeDir, home: paths.home, keys: sharedKeysOf(state) });
      return {
        settings_path: collected.settingsPath,
        settings_error: collected.error,
        shared_keys: collected.keys,
        defaults: !state.claude_settings_keys,
        available: Object.entries(collected.present).map(([key, value]) => ({ key, preview: claudeShared.preview(key, value), shared: collected.keys.includes(key) })),
        files: collected.scripts,
        warnings: collected.warnings,
      };
    }
    if (state.role === 'receive') {
      let values = null;
      let error = null;
      try { values = claudeShared.readFileValues(paths.sharedClaudeSettings); } catch { error = 'invalid-json'; }
      const applied = readApplied();
      const files = applied && applied.claude_settings ? applied.claude_settings.files.map(file => ({ name: file.path, path: path.join(paths.statuslineDir, file.path) })) : [];
      return {
        file_path: paths.sharedClaudeSettings,
        file_error: error,
        statusline_dir: paths.statuslineDir,
        received: Object.entries(values || {}).map(([key, value]) => ({ key, preview: claudeShared.preview(key, value), kept_local: state.keep_local.includes(key) })),
        keep_local: state.keep_local,
        files,
      };
    }
    return null;
  }

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
      local_changes: state.local_changes,
      guard_active: Boolean(store && state.role === 'receive' && state.following && readApplied()),
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
          // false: an older T-Agent that gets the rules and skills only; its up-to-date revision is `expected_revision`.
          claude_settings_supported: entry.settings,
          expected_revision: built && built.bundle ? bundleFor(built, entry).revision : null,
        };
      }) : [],
      claude_settings: claudeSettingsView(state),
    };
  }

  // PUT /api/rule-sync `{ role?, codex?, skills?, claude_settings_keys?, keep_local? }`. The keys must be allowlisted (claudeShared.KEYS).
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
    const keyList = (value, field) => {
      if (!Array.isArray(value) || value.length > claudeShared.KEYS.length * 2 || !value.every(key => typeof key === 'string' && claudeShared.allowedKey(key))) {
        fail('RULE_SYNC_INVALID_SETTINGS', 400, { field });
      }
      return claudeShared.cleanKeys(value);
    };
    if (given.claude_settings_keys !== undefined) next.claude_settings_keys = keyList(given.claude_settings_keys, 'claude_settings_keys');
    if (given.keep_local !== undefined) next.keep_local = keyList(given.keep_local, 'keep_local');
    save(next);
    if (next.role !== 'off') {
      try { ensureImport(); } catch (error) { localError = errorCode(error); }
    }
    if (next.role !== 'source') { snapshot = null; targets.clear(); }
    // Leaving the receive role ends the guard; the files stay as they are.
    if (next.role !== 'receive') clearApplied();
    if (next.role === 'source') {
      const roleChanged = state.role !== 'source';
      if (roleChanged || state.codex !== next.codex) snapshot = null; // the own Codex block is written with the next snapshot
      // A new choice of Claude settings changes the bundle: refreshSnapshot below builds it and the push sends it.
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
    clearApplied();
    rewatch();
    return overview();
  }

  function dismissLocalChanges() {
    save({ ...load(), local_changes: [] });
    return overview();
  }

  // The import line out of CLAUDE.md and the managed block out of AGENTS.md; the shared files and synced skills stay.
  function removeImport() {
    editUserFile(paths.claudeMd, text => (text === null ? null : withoutImportLine(text, paths.importLine)));
    editUserFile(paths.codexAgents, text => (text === null ? null : withoutCodexBlock(text)));
    return overview();
  }

  // ----- The shared rules file, edited from any linked service -----

  // GET /v1/rule-sync/shared on the source. `content_revision` is the SHA-256 of `content`; a write must name the revision it started from.
  function readShared() {
    if (load().role !== 'source') fail('RULE_SYNC_NOT_SOURCE', 403);
    const current = userFile(paths.sharedRules);
    const content = withoutNotice(current.text);
    let updatedAt = null;
    if (current.text !== null) { try { updatedAt = fs.statSync(current.file).mtime.toISOString(); } catch { /* removed meanwhile */ } }
    return { content, content_revision: sha256(content), size: Buffer.byteLength(content), updated_at: updatedAt, exists: current.text !== null };
  }

  // PUT /v1/rule-sync/shared `{ content, base_revision }` on the source: written atomically (keeping the mode, through a symlink), then pushed as any
  // change of the file is (debounced). 409 RULE_SYNC_SHARED_CHANGED with the current text when the file changed after `base_revision`.
  function writeShared(body) {
    if (load().role !== 'source') fail('RULE_SYNC_NOT_SOURCE', 403);
    const given = body && typeof body === 'object' && !Array.isArray(body) ? body : fail('RULE_SYNC_INVALID_CONTENT', 400, { field: 'body' });
    const { content, base_revision: base } = given;
    if (typeof content !== 'string') fail('RULE_SYNC_INVALID_CONTENT', 400, { field: 'content' });
    if (typeof base !== 'string' || !REVISION.test(base)) fail('RULE_SYNC_INVALID_CONTENT', 400, { field: 'base_revision' });
    if (content.includes('\0')) fail('RULE_SYNC_INVALID_CONTENT', 400, { field: 'content', reason: 'nul' });
    if (!content.isWellFormed()) fail('RULE_SYNC_INVALID_CONTENT', 400, { field: 'content', reason: 'utf8' });
    if (Buffer.byteLength(content) > LIMITS.fileBytes) throw tooLarge('file', path.basename(paths.sharedRules));
    const now = readShared();
    if (now.content_revision !== base) {
      fail('RULE_SYNC_SHARED_CHANGED', 409, { current: { content: now.content, content_revision: now.content_revision, updated_at: now.updated_at } });
    }
    const target = userFile(paths.sharedRules);
    if (target.text !== content) writeAtomic(target.file, content, target.mode);
    try { ensureImport(); } catch (error) { localError = errorCode(error); }
    rewatch();
    scheduleCheck();
    const saved = readShared();
    return { content_revision: saved.content_revision, updated_at: saved.updated_at, size: saved.size };
  }

  // What a linked service says about itself for the editor: role, instance and whether it takes edits. `offline` when it cannot be reached.
  async function probe(peer) {
    const timeoutMs = times.requestTimeoutMs;
    try {
      const info = await request(peer.baseUrl, '/v1/info', peer.token, { timeoutMs });
      const capabilities = info && Array.isArray(info.capabilities) ? info.capabilities : [];
      if (!capabilities.includes(CAPABILITY)) return { peer, role: null, edit: false };
      const status = await request(peer.baseUrl, `${ROUTE}/status`, peer.token, { timeoutMs });
      return {
        peer, role: status && ROLES.includes(status.role) ? status.role : null, edit: capabilities.includes(EDIT_CAPABILITY),
        instance_id: status && typeof status.instance_id === 'string' ? status.instance_id : null, name: status && typeof status.name === 'string' ? status.name : '',
      };
    } catch (error) {
      return { peer, role: null, edit: false, offline: !error.statusCode };
    }
  }
  const sourceOf = (found, name) => ({ name: name || found.name || found.peer.name || '', local: false, remote_server_id: found.peer.remoteServerId ?? null });

  // Where the shared rules live: this service when it is the source; else the source a receiver follows; else the one linked service whose role is source.
  async function sharedTarget() {
    const state = load();
    if (state.role === 'source') return { local: true, source: { name: self().name, local: true } };
    if (!request) fail('RULE_SYNC_NO_SOURCE', 404);
    const linked = peers();
    const online = linked.filter(peer => peer.online);
    let probes = null;
    if (state.role === 'receive' && state.following) {
      const wanted = state.following.instance_id;
      let peer = linked.find(candidate => candidate.instanceId === wanted);
      let found = null;
      if (!peer) {
        probes = await Promise.all(online.map(probe));
        found = probes.find(item => item.instance_id === wanted) || null;
        peer = found && found.peer;
      }
      if (peer) {
        const name = state.following.name || peer.name;
        if (!peer.online) fail('ENGINE_OFFLINE', 502, { source: { name, local: false, remote_server_id: peer.remoteServerId ?? null } });
        if (!found) found = await probe(peer);
        if (found.offline) fail('ENGINE_OFFLINE', 502, { source: sourceOf(found, name) });
        // A followed source that is no longer the source: look for the current one below.
        if (found.role === 'source') {
          if (!found.edit) fail('RULE_SYNC_EDIT_UNSUPPORTED', 501, { source: sourceOf(found, name) });
          return { peer, source: sourceOf(found, name) };
        }
      }
    }
    if (!probes) probes = await Promise.all(online.map(probe));
    const sources = probes.filter(item => item.role === 'source');
    if (sources.length > 1) fail('RULE_SYNC_SEVERAL_SOURCES', 409, { sources: sources.map(item => item.name || item.peer.name) });
    if (!sources.length) {
      const unreachable = [...linked.filter(peer => !peer.online), ...probes.filter(item => item.offline).map(item => item.peer)].map(peer => peer.name);
      fail('RULE_SYNC_NO_SOURCE', 404, { unreachable });
    }
    const [found] = sources;
    if (!found.edit) fail('RULE_SYNC_EDIT_UNSUPPORTED', 501, { source: sourceOf(found) });
    return { peer: found.peer, source: sourceOf(found) };
  }

  // The source's answer, or its error passed on with its status and fields (a 409 carries `current`).
  async function remoteShared(target, method, body) {
    const { peer, source } = target;
    try {
      return await request(peer.baseUrl, `${ROUTE}/shared`, peer.token, { method, body, timeoutMs: times.requestTimeoutMs, maxBytes: 8 * MIB });
    } catch (error) {
      if (!error.statusCode) fail('ENGINE_OFFLINE', 502, { source });
      if (error.statusCode === 401) {
        if (serviceLinks && typeof serviceLinks.noteUnauthorized === 'function') { try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* checked again later */ } }
        fail('ENGINE_UNAUTHORIZED', 502, { source });
      }
      const answer = error.peerBody || {};
      if (typeof answer.error === 'string' && /^RULE_SYNC_[A-Z0-9_]+$/.test(answer.error)) {
        const { error: code, ...extra } = answer;
        fail(code, error.statusCode, { ...extra, source });
      }
      if (error.statusCode === 404) fail('RULE_SYNC_EDIT_UNSUPPORTED', 501, { source });
      fail(errorCode(error), error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502, { source });
    }
  }

  // GET / PUT /api/rule-sync/shared: the same answers as the source's, plus `source: { name, local, remote_server_id? }`.
  async function sharedForBrowser() {
    const target = await sharedTarget();
    const answer = target.local ? readShared() : await remoteShared(target, 'GET');
    return { ...answer, source: target.source };
  }
  async function saveSharedForBrowser(body) {
    const target = await sharedTarget();
    if (target.local) return { ...writeShared(body), source: target.source };
    const given = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const answer = await remoteShared(target, 'PUT', { content: given.content, base_revision: given.base_revision });
    return { ...answer, source: target.source };
  }

  return {
    paths, receiverStatus, receive, overview, update, createShared, pushNow, resetSource, removeImport, dismissLocalChanges,
    readShared, writeShared, sharedForBrowser, saveSharedForBrowser, guardCheck,
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
    dataDir: require('../lib/data-home').paths().root,
  });
  return singleton;
}

module.exports = {
  createRuleSync, getRuleSync, RuleSyncError, layout, buildBundle, parseBundle, revisionOf,
  withImportLine, withoutImportLine, withCodexBlock, withoutCodexBlock, hasImportLine, hasCodexBlock,
  syncedNotice, withoutNotice, codexInner,
  sessionClaudeSettings, claudeShared,
  STATE_KEY, CAPABILITY, EDIT_CAPABILITY, SETTINGS_CAPABILITY, ROLES, MARKER, LIMITS, IMPORT_COMMENT, CODEX_BEGIN, CODEX_END, TIMING,
};
