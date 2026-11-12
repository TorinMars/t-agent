'use strict';
// Shared Claude Code settings for the rules and skills sync (services/rule-sync.js): the source picks some keys of its own <claude>/settings.json, the
// receivers keep them in <claude>/shared/claude-settings.json and T-Agent passes them to the Claude sessions it starts with `--settings` (routes/terminal.js).
// No one's settings.json is ever written. Only the keys in KEYS can be shared; the denylist below is checked again at every step, so a stored or received
// choice can never carry credentials, hooks, permission rules or MCP servers. See "Shared Claude settings (injected at session start)" in DESIGN.md.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Checked against the settings schema of Claude Code 2.1.322 (the strings of the installed binary): every key is a real top-level setting, and
// `permissions.defaultMode` is the one shared field inside `permissions`.
const KEYS = Object.freeze([
  'statusLine', 'model', 'effortLevel', 'modelSettings', 'switchModelsOnFlag', 'permissions.defaultMode', 'skipDangerousModePermissionPrompt',
  'agentPushNotifEnabled', 'outputStyle', 'spinnerTipsEnabled', 'includeCoAuthoredBy', 'cleanupPeriodDays', 'alwaysThinkingEnabled',
]);
// What a source shares before the person chose anything: the status line and the preferences of the interface. The model, the effort, the permission
// mode and the rest stay off until they are ticked.
const DEFAULT_KEYS = Object.freeze(['statusLine', 'switchModelsOnFlag', 'agentPushNotifEnabled', 'spinnerTipsEnabled', 'outputStyle']);
// Never shared, whatever was stored or received.
const DENIED = new Set([
  'env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'hooks', 'permissions.allow', 'permissions.deny', 'permissions.ask',
  'permissions.additionalDirectories', 'mcpServers', 'enabledMcpjsonServers', 'forceLoginMethod',
]);
const TYPES = Object.freeze({
  statusLine: 'statusLine', model: 'string', effortLevel: 'string', modelSettings: 'object', switchModelsOnFlag: 'boolean', 'permissions.defaultMode': 'string',
  skipDangerousModePermissionPrompt: 'boolean', agentPushNotifEnabled: 'boolean', outputStyle: 'string', spinnerTipsEnabled: 'boolean',
  includeCoAuthoredBy: 'boolean', cleanupPeriodDays: 'int', alwaysThinkingEnabled: 'boolean',
});
const LIMITS = Object.freeze({ valueBytes: 16 * 1024, stringLength: 4096, depth: 6, files: 5, fileBytes: 256 * 1024, refLength: 4096 });
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// The words of a key name (camelCase, snake_case, dots and dashes), lower case.
const words = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// A word that names a credential: key, token, secret, password, credential, auth... Word by word, so `includeCoAuthoredBy` (co, authored, by) is not one
// while `apiKeyHelper`, `awsAuthRefresh` and `ANTHROPIC_AUTH_TOKEN` are.
const sensitiveWord = word => /key$|keys$|token|secret|password|passwd|credential/.test(word) || (/^o?auth/.test(word) && !/^author(s|ed)?$/.test(word));
function deniedName(name) {
  const text = String(name);
  if (DENIED.has(text) || /^ANTHROPIC_/i.test(text)) return true;
  return text.split('.').some(part => DENIED.has(part) || /^ANTHROPIC_/i.test(part) || words(part).some(sensitiveWord));
}
const allowedKey = key => KEYS.includes(key) && !deniedName(key);
// Only allowlisted keys, each once, in the order of KEYS.
const cleanKeys = list => (Array.isArray(list) ? KEYS.filter(key => list.includes(key) && allowedKey(key)) : null);

// Plain JSON data without a denied name at any depth.
function plainValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= LIMITS.stringLength;
  if (depth >= LIMITS.depth) return false;
  if (Array.isArray(value)) return value.every(item => plainValue(item, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.entries(value).every(([name, item]) => name !== '__proto__' && !deniedName(name) && plainValue(item, depth + 1));
}
function validValue(key, value) {
  if (!allowedKey(key) || value === undefined || !plainValue(value)) return false;
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.valueBytes) return false;
  switch (TYPES[key]) {
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string' && value.length > 0 && value.length <= 200;
    case 'int': return Number.isInteger(value) && value > 0;
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'statusLine': return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.command === 'string' && value.command.length > 0;
    default: return false;
  }
}

// A key is a path in the settings object: `permissions.defaultMode` is `permissions: { defaultMode }`.
function getKey(settings, key) {
  let value = settings;
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
function setKey(settings, key, value) {
  const parts = key.split('.');
  let target = settings;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
    target = target[part];
  }
  target[parts[parts.length - 1]] = value;
}
// The flat `{ key: value }` of a settings object, allowlisted and checked; anything else is left out.
function flatten(settings) {
  const values = {};
  for (const key of KEYS) {
    const value = getKey(settings, key);
    if (validValue(key, value)) values[key] = value;
  }
  return values;
}
// The settings object of a flat `{ key: value }`, allowlisted and checked again.
function nest(values) {
  const settings = {};
  for (const key of KEYS) if (values && Object.hasOwn(values, key) && validValue(key, values[key])) setKey(settings, key, values[key]);
  return settings;
}

// JSON with sorted object keys: the same values give the same text (and revision) on every machine.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const isEmpty = shared => !shared || ((!shared.values || !Object.keys(shared.values).length) && (!shared.files || !shared.files.length));
// The part of the bundle revision for the shared settings; `null` when nothing is shared, so the revision is the one older services compute.
function settingsHash(shared) {
  if (isEmpty(shared)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(`values\0${stableJson(shared.values || {})}\0`);
  for (const file of [...(shared.files || [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`file\0${file.path}\0${file.mode}\0${file.ref || ''}\0${file.content_base64}\0`);
  }
  return hash.digest('hex');
}

// A short text of a value for the page: the status line command, a string, or the JSON cut to 80 characters.
function preview(key, value) {
  const text = key === 'statusLine' && value && typeof value.command === 'string' ? value.command : typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

// ---------------------------------------------------------------------------
// The status line scripts
// ---------------------------------------------------------------------------

// Paths in a status line command that may name a script: `~/...`, `$HOME/...`, `${HOME}/...` and absolute paths, bare or in double quotes (where `~`
// does not expand, so only $HOME and absolute ones), or absolute in single quotes. `ref` is the text exactly as written, quotes included.
const PATH_TOKEN = /"((?:\$HOME|\$\{HOME\}|\/)[^"$`\\]*)"|'(\/[^']*)'|(?<=^|[\s;|&(=])((?:~|\$HOME|\$\{HOME\}|\/)[^\s"'`;|&<>()$\\]*)/g;
function commandPaths(command, home) {
  const found = [];
  for (const match of String(command).matchAll(PATH_TOKEN)) {
    const raw = match[1] ?? match[2] ?? match[3];
    const expanded = raw.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home);
    if (!path.isAbsolute(expanded)) continue;
    found.push({ ref: match[0], file: path.resolve(expanded) });
  }
  return found;
}
const inside = (dir, file) => file.startsWith(`${dir}${path.sep}`);

// The script files a shared status line runs from <claude>: regular files (never a link), at most 5 of at most 256 KiB, with a plain name. Returns
// { files: [{ path, mode, content_base64, ref }], warnings: [{ path, warning }] }.
function statusLineFiles(statusLine, { claudeDir, home }) {
  const files = [];
  const warnings = [];
  if (!statusLine || typeof statusLine.command !== 'string') return { files, warnings };
  let realClaude;
  try { realClaude = fs.realpathSync(claudeDir); } catch { return { files, warnings }; }
  const seen = new Map();
  for (const { ref, file } of commandPaths(statusLine.command, home)) {
    if (!inside(claudeDir, file) && !inside(realClaude, file)) continue;
    const name = path.basename(file);
    if (seen.has(file)) continue;
    seen.set(file, true);
    const warn = warning => warnings.push({ path: file, warning });
    let stat;
    try { stat = fs.lstatSync(file); } catch { warn('missing'); continue; }
    if (stat.isSymbolicLink()) { warn('symlink'); continue; }
    if (!stat.isFile()) { warn('skipped'); continue; }
    let real;
    try { real = fs.realpathSync(file); } catch { warn('missing'); continue; }
    if (!inside(realClaude, real)) { warn('symlink'); continue; }
    if (!FILE_NAME.test(name)) { warn('name'); continue; }
    if (files.some(item => item.path === name)) { warn('duplicate'); continue; }
    if (stat.size > LIMITS.fileBytes) { warn('too-large'); continue; }
    if (files.length >= LIMITS.files) { warn('too-many'); continue; }
    files.push({ path: name, mode: (stat.mode & 0o111) ? 0o755 : 0o644, content_base64: fs.readFileSync(file).toString('base64'), ref, source_path: file, size: stat.size });
  }
  return { files, warnings };
}

// A word for the shell: unquoted when it has only safe characters, else in single quotes.
const shellWord = text => (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);
// How a receiver's command names its shared copy of a script: `~/.claude/shared/statusline/<name>` when the Claude folder is ~/.claude, else the absolute
// path, quoted for the shell when it needs it.
function sharedScriptWord(name, { claudeDir, home }) {
  const defaultDir = path.join(home, '.claude');
  if (claudeDir === defaultDir) return `~/${shellWord(path.posix.join('.claude', 'shared', 'statusline', name))}`;
  return shellWord(path.join(claudeDir, 'shared', 'statusline', name));
}
// The status line with each script reference replaced by the receiver's copy.
function rewriteStatusLine(statusLine, files, where) {
  let command = statusLine.command;
  for (const file of files) if (file.ref && command.includes(file.ref)) command = command.split(file.ref).join(sharedScriptWord(file.path, where));
  return { ...statusLine, command };
}

// ---------------------------------------------------------------------------
// The source: what it shares
// ---------------------------------------------------------------------------

// <claude>/settings.json as an object; `error` when it exists but cannot be read as a JSON object.
function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return { settings: {}, error: error.code === 'ENOENT' ? null : 'unreadable' }; }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { settings: value, error: null } : { settings: {}, error: 'not-an-object' };
  } catch { return { settings: {}, error: 'invalid-json' }; }
}

// The source's view and its share: the allowlisted keys present in its settings.json, and the chosen ones with the status line scripts.
function collect({ claudeDir, home, keys }) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const { settings, error } = readSettings(settingsPath);
  const present = flatten(settings);
  const chosen = cleanKeys(keys) || [];
  const values = {};
  for (const key of chosen) if (Object.hasOwn(present, key)) values[key] = present[key];
  const scripts = values.statusLine ? statusLineFiles(values.statusLine, { claudeDir, home }) : { files: [], warnings: [] };
  return {
    settingsPath, error, present, keys: chosen, warnings: scripts.warnings,
    scripts: scripts.files.map(file => ({ name: file.path, path: file.source_path, size: file.size })),
    shared: { values, files: scripts.files.map(({ path: name, mode, content_base64: content, ref }) => ({ path: name, mode, content_base64: content, ref })) },
  };
}

// ---------------------------------------------------------------------------
// The receiver: checking what came, and what is injected
// ---------------------------------------------------------------------------

// `claude_settings` of a received bundle. The shape must be right (else `invalid(reason)`); values of keys that are not allowlisted, denied or of the wrong
// type are dropped (a newer source may know more keys). The revision is computed over what was sent, so `raw` is kept for it.
function parseShared(value, { invalid, tooLarge }) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) invalid('claude_settings');
  const raw = { values: value.values === undefined ? {} : value.values, files: value.files === undefined ? [] : value.files };
  if (!raw.values || typeof raw.values !== 'object' || Array.isArray(raw.values)) invalid('claude_settings values');
  if (Buffer.byteLength(JSON.stringify(raw.values)) > LIMITS.valueBytes * KEYS.length) throw tooLarge('file', 'claude_settings');
  if (!Array.isArray(raw.files)) invalid('claude_settings files');
  if (raw.files.length > LIMITS.files) throw tooLarge('files', 'claude_settings');
  const names = new Set();
  const files = raw.files.map(file => {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !FILE_NAME.test(file.path) || names.has(file.path)) invalid('claude_settings file name');
    names.add(file.path);
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o7777) invalid('mode');
    if (file.ref !== undefined && (typeof file.ref !== 'string' || file.ref.length > LIMITS.refLength)) invalid('claude_settings ref');
    if (typeof file.content_base64 !== 'string' || file.content_base64.length % 4 !== 0 || !BASE64.test(file.content_base64)) invalid('content');
    const data = Buffer.from(file.content_base64, 'base64');
    if (data.length > LIMITS.fileBytes) throw tooLarge('file', `statusline/${file.path}`);
    return { path: file.path, mode: file.mode, content_base64: file.content_base64, ref: file.ref || '', data };
  });
  const values = {};
  for (const key of KEYS) if (Object.hasOwn(raw.values, key) && validValue(key, raw.values[key])) values[key] = raw.values[key];
  return { raw: { values: raw.values, files: files.map(({ data, ...rest }) => rest) }, values, files };
}

// The text of <claude>/shared/claude-settings.json on a receiver: the notice first, then the settings as Claude reads them (status line already pointing
// to this machine's copies of the scripts).
function fileText(values, sourceName) {
  const name = String(sourceName || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) || 'the source';
  const comment = `Synced by T-Agent from ${name} and injected into the Claude Code sessions T-Agent starts (--settings); settings.json is not changed. Choose the keys on ${name} (Settings > Rules and skills sync); changes made here are replaced.`;
  return `${JSON.stringify({ _comment: comment, ...nest(values) }, null, 2)}\n`;
}
// The flat values of that file (null when it is missing; throws on a malformed file).
function readFileValues(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a JSON object');
  return flatten(value);
}

module.exports = {
  KEYS, DEFAULT_KEYS, DENIED, LIMITS, allowedKey, deniedName, cleanKeys, validValue, flatten, nest, getKey, stableJson, isEmpty, settingsHash, preview,
  commandPaths, statusLineFiles, sharedScriptWord, rewriteStatusLine, shellWord, readSettings, collect, parseShared, fileText, readFileValues,
};
