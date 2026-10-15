const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Configurable items ──────────────────────────────────────────────
// Values are always strings in the API; empty string = leave alone (do not change the existing value on that machine).
// type: enum (fixed options), text (free text), number (non-negative integer), list (comma separated, stored as an array).
const SCHEMA = {
  claude: [
    { key: 'permission', label: 'Default permissions', group: 'Common', type: 'enum', path: ['permissions', 'defaultMode'],
      options: [['default', 'Default (confirm each one)'], ['acceptEdits', 'Auto-accept edits'], ['plan', 'Plan mode'], ['auto', 'Auto'], ['bypassPermissions', 'Skip all confirmations']],
      hint: 'Permission mode for new sessions. “Skip all confirmations” is risky and only recommended on an isolated development machine.' },
    { key: 'model', label: 'Default model', group: 'Common', type: 'text', path: ['model'], placeholder: 'sonnet / opus / haiku or a full model ID',
      hint: 'Enter an alias or a full model ID.' },
    { key: 'effort', label: 'Default reasoning effort', group: 'Common', type: 'enum', path: ['effortLevel'],
      options: [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']],
      hint: 'Higher is slower and more expensive but reasons more thoroughly. If the model does not support the level, Claude Code handles it.' },
    { key: 'statusLine', label: 'Status line command', group: 'Common', type: 'text', path: ['statusLine'], placeholder: 'e.g. basename "$PWD"',
      presets: [
        ['Directory name', 'basename "$PWD"'],
        ['Directory + Git branch', 'printf \'%s %s\' "$(basename "$PWD")" "$(git branch --show-current 2>/dev/null)"'],
      ],
      hint: 'The status line shows this command’s output (the command receives the session JSON on standard input). It runs on that machine, so only enter trusted commands.' },
    { key: 'language', label: 'Reply language', group: 'More', type: 'text', path: ['language'], placeholder: 'e.g. Chinese', hint: 'Have Claude reply in this language by default.' },
    { key: 'alwaysThinking', label: 'Thinking on by default', group: 'More', type: 'enum', path: ['alwaysThinkingEnabled'], bool: true,
      options: [['true', 'On'], ['false', 'Close']] },
    { key: 'cleanupDays', label: 'Session retention (days)', group: 'More', type: 'number', path: ['cleanupPeriodDays'], placeholder: 'e.g. 30', hint: 'Session records older than this are removed.' },
    { key: 'coAuthor', label: 'Add Co-Authored-By to commits', group: 'More', type: 'enum', path: ['includeCoAuthoredBy'], bool: true,
      options: [['true', 'Include'], ['false', 'Do not include']] },
  ],
  codex: [
    { key: 'approval', label: 'Default permissions (approval policy)', group: 'Common', type: 'enum', path: ['approval_policy'],
      options: [['untrusted', 'untrusted (only run trusted commands automatically)'], ['on-failure', 'on-failure (ask when a command fails)'], ['on-request', 'on-request (ask when the model requests)'], ['never', 'never (never ask)']] },
    { key: 'sandbox', label: 'Sandbox mode', group: 'Common', type: 'enum', path: ['sandbox_mode'],
      options: [['read-only', 'read-only'], ['workspace-write', 'workspace-write (writable workspace)'], ['danger-full-access', 'danger-full-access (full access)']],
      hint: '“Full access” is risky and only recommended on an isolated development machine.' },
    { key: 'model', label: 'Default model', group: 'Common', type: 'text', path: ['model'], placeholder: 'Model ID, e.g. gpt-5.5' },
    { key: 'effort', label: 'Default reasoning effort', group: 'Common', type: 'enum', path: ['model_reasoning_effort'],
      options: [['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']] },
    { key: 'statusLine', label: 'Status line items', group: 'Common', type: 'list', path: ['tui', 'status_line'], placeholder: 'model-with-reasoning, current-dir, git-branch, context-remaining',
      presets: [
        ['Compact', 'model-with-reasoning, current-dir'],
        ['Common', 'model-with-reasoning, current-dir, git-branch, context-remaining'],
      ],
      hint: 'Comma-separated status line items, shown in order. Item names depend on the installed Codex version; unknown ones are ignored or flagged by it.' },
    { key: 'summary', label: 'Reasoning summary', group: 'More', type: 'enum', path: ['model_reasoning_summary'],
      options: [['auto', 'auto'], ['concise', 'concise'], ['detailed', 'detailed'], ['none', 'none']] },
    { key: 'webSearch', label: 'Web search', group: 'More', type: 'enum', path: ['web_search'],
      options: [['cached', 'cached (cached results)'], ['live', 'live'], ['disabled', 'disabled']] },
  ],
};
const TOOLS = Object.keys(SCHEMA);
const MAX_TEXT = 500;

class AgentConfigError extends Error {
  constructor(code, message, statusCode = 400) { super(code); this.code = code; this.userMessage = message; this.statusCode = statusCode; }
}

function fieldOf(tool, key) { return (SCHEMA[tool] || []).find(field => field.key === key); }

// Validate and normalize a set of values: keep only keys in the schema, with string values.
function cleanValues(tool, values) {
  if (!SCHEMA[tool]) throw new AgentConfigError('UNKNOWN_TOOL', 'Only claude and codex are supported');
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new AgentConfigError('INVALID_VALUES', 'Invalid configuration');
  const clean = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = fieldOf(tool, key);
    if (!field) throw new AgentConfigError('UNKNOWN_FIELD', `Unknown setting: ${key}`);
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string') throw new AgentConfigError('INVALID_VALUE', `${field.label} must be text`);
    const value = raw.trim();
    if (value.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new AgentConfigError('INVALID_VALUE', `${field.label} has invalid content`);
    if (value && field.type === 'enum' && !field.options.some(([option]) => option === value)) throw new AgentConfigError('INVALID_VALUE', `${field.label} is not one of the allowed values`);
    if (value && field.type === 'number' && !/^\d{1,5}$/.test(value)) throw new AgentConfigError('INVALID_VALUE', `${field.label} must be a non-negative integer of at most 5 digits`);
    if (value && field.type === 'list' && !value.split(',').every(item => /^[A-Za-z0-9_.-]+$/.test(item.trim()))) throw new AgentConfigError('INVALID_VALUE', `${field.label} must be comma-separated item names`);
    if (value && field.type === 'text' && /[\r\n]/.test(value)) throw new AgentConfigError('INVALID_VALUE', `${field.label} cannot contain line breaks`);
    clean[key] = value;
  }
  return clean;
}

// ── File locations ──────────────────────────────────────────────
function locations(env = process.env, home = os.homedir()) {
  const claudeRoot = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexRoot = env.CODEX_HOME || path.join(home, '.codex');
  const overrides = env.T_AGENT_OVERRIDES_DIR || path.join(home, '.config', 't-agent', 'overrides');
  return {
    claude: { file: path.join(claudeRoot, 'settings.json'), override: path.join(overrides, 'claude', 'settings.json') },
    codex: { file: path.join(codexRoot, 'config.toml'), override: path.join(overrides, 'codex', 'config.toml') },
  };
}

// ── JSON (Claude) ────────────────────────────────────────
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!text.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new AgentConfigError('CONFIG_INVALID', `${file} is not valid JSON; skipped and left unchanged`, 409); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AgentConfigError('CONFIG_INVALID', `The top level of ${file} is not an object; skipped and left unchanged`, 409);
  return parsed;
}
function getPath(object, keys) { return keys.reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), object); }
function setPath(object, keys, value) {
  let node = object;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function claudeEncode(field, value) {
  if (field.key === 'statusLine') return { type: 'command', command: value };
  if (field.bool) return value === 'true';
  if (field.type === 'number') return Number(value);
  return value;
}
function claudeDecode(field, raw) {
  if (raw === undefined || raw === null) return '';
  if (field.key === 'statusLine') return raw && typeof raw === 'object' && typeof raw.command === 'string' ? raw.command : '';
  return String(raw);
}

// ── TOML (Codex): only single-line key/values are handled, the rest of the content and comments are preserved ──────────
function tomlLiteral(field, value) {
  if (field.type === 'list') return `[${value.split(',').map(item => JSON.stringify(item.trim())).join(', ')}]`;
  return JSON.stringify(value);
}
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function tomlSections(lines) {
  const sections = [{ name: '', start: 0 }];
  lines.forEach((line, index) => {
    const header = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) sections.push({ name: header[1].trim().replace(/\s*\.\s*/g, '.'), start: index });
  });
  sections.forEach((section, index) => { section.end = index + 1 < sections.length ? sections[index + 1].start : lines.length; });
  return sections;
}
function setTomlKey(text, tableKeys, literal) {
  const table = tableKeys.slice(0, -1).join('.');
  const key = tableKeys[tableKeys.length - 1];
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const section = tomlSections(lines).find(item => item.name === table);
  const pattern = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
  if (section) {
    for (let index = section.start + (section.name ? 1 : 0); index < section.end; index += 1) {
      if (pattern.test(lines[index])) { lines[index] = `${key} = ${literal}`; return `${lines.join('\n')}\n`; }
    }
    let at = section.end;
    while (at > section.start + (section.name ? 1 : 0) && lines[at - 1].trim() === '') at -= 1;
    lines.splice(at, 0, `${key} = ${literal}`);
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${table}]`, `${key} = ${literal}`);
  }
  return `${lines.join('\n')}\n`;
}
function getTomlKey(text, tableKeys) {
  const table = tableKeys.slice(0, -1).join('.');
  const key = tableKeys[tableKeys.length - 1];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const section = tomlSections(lines).find(item => item.name === table);
  if (!section) return undefined;
  const pattern = new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*(.*)$`);
  for (let index = section.start + (section.name ? 1 : 0); index < section.end; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match) return match[1].replace(/\s+#.*$/, '').trim();
  }
  return undefined;
}
function tomlDecode(field, raw) {
  if (raw === undefined) return '';
  if (field.type === 'list') return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(match => match[1] ?? match[2]).join(', ');
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(raw) || /^'([^']*)'$/.exec(raw);
  return quoted ? quoted[1] : raw;
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const temp = `${file}.t-agent-${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, file);
}

// Write values into a config file. Returns the keys that actually changed.
function applyToFile(tool, file, values) {
  const fields = Object.entries(values).filter(([, value]) => value !== '').map(([key, value]) => [fieldOf(tool, key), value]);
  const changed = [];
  if (!fields.length) return changed;
  if (tool === 'claude') {
    const settings = readJson(file);
    for (const [field, value] of fields) {
      const encoded = claudeEncode(field, value);
      if (JSON.stringify(getPath(settings, field.path)) !== JSON.stringify(encoded)) { setPath(settings, field.path, encoded); changed.push(field.key); }
    }
    if (changed.length) writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
    return changed;
  }
  let text = readText(file);
  for (const [field, value] of fields) {
    const literal = tomlLiteral(field, value);
    if (getTomlKey(text, field.path) !== literal) { text = setTomlKey(text, field.path, literal); changed.push(field.key); }
  }
  if (changed.length) writeAtomic(file, text);
  return changed;
}

function createAgentConfig({ env = process.env, home = os.homedir() } = {}) {
  const where = () => locations(env, home);
  return {
    // Read the current values of each tool on this machine.
    read() {
      const place = where();
      const result = { paths: { claude: place.claude.file, codex: place.codex.file }, claude: {}, codex: {}, errors: {} };
      try {
        const settings = readJson(place.claude.file);
        for (const field of SCHEMA.claude) result.claude[field.key] = claudeDecode(field, getPath(settings, field.path));
      } catch (error) { result.errors.claude = error.code || 'READ_FAILED'; }
      try {
        const text = readText(place.codex.file);
        for (const field of SCHEMA.codex) result.codex[field.key] = tomlDecode(field, getTomlKey(text, field.path));
      } catch (error) { result.errors.codex = error.code || 'READ_FAILED'; }
      return result;
    },
    // Write the tool config and also the local override file (agent-sync.py overwrites same-named keys with the remote rules on every start; the override file wins, which is what makes the values set here last).
    apply(tool, values) {
      const clean = cleanValues(tool, values);
      const place = where()[tool];
      const changed = applyToFile(tool, place.file, clean);
      let overrideError = null;
      try { applyToFile(tool, place.override, clean); } catch (error) { overrideError = error.code || 'OVERRIDE_FAILED'; }
      return { tool, changed, file: place.file, ...(overrideError ? { override_error: overrideError } : {}) };
    },
  };
}

// ── Client-side saving: global defaults + per-server overrides ───────────────
function createAgentConfigStore(database) {
  const key = owner => `agent-config:${owner}`;
  const empty = () => ({ defaults: { claude: {}, codex: {} }, servers: {}, status: {} });
  function read(owner) {
    const row = database.prepare('SELECT value FROM system_state WHERE key = ?').get(key(owner));
    if (!row) return empty();
    try { return { ...empty(), ...JSON.parse(row.value) }; } catch { return empty(); }
  }
  function write(owner, state) {
    database.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key(owner), JSON.stringify(state));
  }
  return {
    get: read,
    setDefaults(owner, tool, values) {
      const state = read(owner);
      state.defaults[tool] = cleanValues(tool, values);
      write(owner, state);
      return state;
    },
    setOverride(owner, serverKey, tool, values) {
      const state = read(owner);
      state.servers[serverKey] = { ...(state.servers[serverKey] || {}), [tool]: cleanValues(tool, values) };
      write(owner, state);
      return state;
    },
    setStatus(owner, serverKey, status) {
      const state = read(owner);
      state.status[serverKey] = status;
      write(owner, state);
    },
    forgetServer(owner, serverKey) {
      const state = read(owner);
      delete state.servers[serverKey]; delete state.status[serverKey];
      write(owner, state);
    },
    // The value actually pushed for a tool on a server: keys present in the override (including empty string = leave this server alone) win over the global default.
    effective(state, serverKey, tool) {
      return { ...(state.defaults[tool] || {}), ...((state.servers[serverKey] || {})[tool] || {}) };
    },
  };
}

module.exports = { SCHEMA, TOOLS, AgentConfigError, cleanValues, createAgentConfig, createAgentConfigStore, locations, setTomlKey, getTomlKey };
