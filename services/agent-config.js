const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 可配置项 ──────────────────────────────────────────────
// 值在接口里一律是字符串；空字符串 = 不管（不改动该机器上的现有值）。
// type: enum（固定选项）、text（自由文本）、number（非负整数）、list（逗号分隔，写成数组）。
const SCHEMA = {
  claude: [
    { key: 'permission', label: '默认权限', group: '常用', type: 'enum', path: ['permissions', 'defaultMode'],
      options: [['default', '默认（逐项确认）'], ['acceptEdits', '自动接受编辑'], ['plan', '计划模式'], ['auto', '自动'], ['bypassPermissions', '跳过所有确认']],
      hint: '新会话的权限模式。“跳过所有确认”风险高，只建议用于隔离的开发机。' },
    { key: 'model', label: '默认模型', group: '常用', type: 'text', path: ['model'], placeholder: 'sonnet / opus / haiku 或完整模型 ID',
      hint: '填别名或完整模型 ID。' },
    { key: 'effort', label: '默认思考强度', group: '常用', type: 'enum', path: ['effortLevel'],
      options: [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']],
      hint: '越高越慢、越贵，推理更充分。模型不支持该档位时由 Claude Code 自行处理。' },
    { key: 'statusLine', label: '状态栏命令', group: '常用', type: 'text', path: ['statusLine'], placeholder: '例如：basename "$PWD"',
      presets: [
        ['目录名', 'basename "$PWD"'],
        ['目录 + Git 分支', 'printf \'%s %s\' "$(basename "$PWD")" "$(git branch --show-current 2>/dev/null)"'],
      ],
      hint: '状态栏显示该命令的输出（命令从标准输入收到会话 JSON）。会在该机器上执行，请只填可信命令。' },
    { key: 'language', label: '回复语言', group: '更多', type: 'text', path: ['language'], placeholder: '例如：中文', hint: '让 Claude 默认用这种语言回复。' },
    { key: 'alwaysThinking', label: '默认开启思考', group: '更多', type: 'enum', path: ['alwaysThinkingEnabled'], bool: true,
      options: [['true', '开启'], ['false', '关闭']] },
    { key: 'cleanupDays', label: '会话保留天数', group: '更多', type: 'number', path: ['cleanupPeriodDays'], placeholder: '例如：30', hint: '超过天数的会话记录会被清理。' },
    { key: 'coAuthor', label: '提交附带 Co-Authored-By', group: '更多', type: 'enum', path: ['includeCoAuthoredBy'], bool: true,
      options: [['true', '附带'], ['false', '不附带']] },
  ],
  codex: [
    { key: 'approval', label: '默认权限（审批策略）', group: '常用', type: 'enum', path: ['approval_policy'],
      options: [['untrusted', 'untrusted（只自动运行可信命令）'], ['on-failure', 'on-failure（失败时询问）'], ['on-request', 'on-request（模型请求时询问）'], ['never', 'never（从不询问）']] },
    { key: 'sandbox', label: '沙箱模式', group: '常用', type: 'enum', path: ['sandbox_mode'],
      options: [['read-only', 'read-only（只读）'], ['workspace-write', 'workspace-write（可写工作区）'], ['danger-full-access', 'danger-full-access（完全访问）']],
      hint: '“完全访问”风险高，只建议用于隔离的开发机。' },
    { key: 'model', label: '默认模型', group: '常用', type: 'text', path: ['model'], placeholder: '模型 ID，例如 gpt-5.5' },
    { key: 'effort', label: '默认思考强度', group: '常用', type: 'enum', path: ['model_reasoning_effort'],
      options: [['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']] },
    { key: 'statusLine', label: '状态栏项目', group: '常用', type: 'list', path: ['tui', 'status_line'], placeholder: 'model-with-reasoning, current-dir, git-branch, context-remaining',
      presets: [
        ['简洁', 'model-with-reasoning, current-dir'],
        ['常用', 'model-with-reasoning, current-dir, git-branch, context-remaining'],
      ],
      hint: '逗号分隔的状态栏项目，按顺序显示。项目名以所装 Codex 版本为准，不认识的会被它忽略或提示。' },
    { key: 'summary', label: '推理摘要', group: '更多', type: 'enum', path: ['model_reasoning_summary'],
      options: [['auto', 'auto'], ['concise', 'concise'], ['detailed', 'detailed'], ['none', 'none']] },
    { key: 'webSearch', label: '网页搜索', group: '更多', type: 'enum', path: ['web_search'],
      options: [['cached', 'cached（缓存结果）'], ['live', 'live（实时）'], ['disabled', 'disabled（关闭）']] },
  ],
};
const TOOLS = Object.keys(SCHEMA);
const MAX_TEXT = 500;

class AgentConfigError extends Error {
  constructor(code, message, statusCode = 400) { super(code); this.code = code; this.userMessage = message; this.statusCode = statusCode; }
}

function fieldOf(tool, key) { return (SCHEMA[tool] || []).find(field => field.key === key); }

// 校验并规范化一组值：只保留 schema 里的键，值为字符串。
function cleanValues(tool, values) {
  if (!SCHEMA[tool]) throw new AgentConfigError('UNKNOWN_TOOL', '只支持 claude 和 codex');
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new AgentConfigError('INVALID_VALUES', '配置内容无效');
  const clean = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = fieldOf(tool, key);
    if (!field) throw new AgentConfigError('UNKNOWN_FIELD', `不认识的配置项：${key}`);
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string') throw new AgentConfigError('INVALID_VALUE', `${field.label} 必须是文本`);
    const value = raw.trim();
    if (value.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new AgentConfigError('INVALID_VALUE', `${field.label} 内容无效`);
    if (value && field.type === 'enum' && !field.options.some(([option]) => option === value)) throw new AgentConfigError('INVALID_VALUE', `${field.label} 的值不在可选范围内`);
    if (value && field.type === 'number' && !/^\d{1,5}$/.test(value)) throw new AgentConfigError('INVALID_VALUE', `${field.label} 必须是不超过 5 位的非负整数`);
    if (value && field.type === 'list' && !value.split(',').every(item => /^[A-Za-z0-9_.-]+$/.test(item.trim()))) throw new AgentConfigError('INVALID_VALUE', `${field.label} 只能填用逗号分隔的项目名`);
    if (value && field.type === 'text' && /[\r\n]/.test(value)) throw new AgentConfigError('INVALID_VALUE', `${field.label} 不能换行`);
    clean[key] = value;
  }
  return clean;
}

// ── 文件位置 ──────────────────────────────────────────────
function locations(env = process.env, home = os.homedir()) {
  const claudeRoot = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexRoot = env.CODEX_HOME || path.join(home, '.codex');
  const overrides = env.T_AGENT_OVERRIDES_DIR || path.join(home, '.config', 't-agent', 'overrides');
  return {
    claude: { file: path.join(claudeRoot, 'settings.json'), override: path.join(overrides, 'claude', 'settings.json') },
    codex: { file: path.join(codexRoot, 'config.toml'), override: path.join(overrides, 'codex', 'config.toml') },
  };
}

// ── JSON（Claude） ────────────────────────────────────────
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!text.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new AgentConfigError('CONFIG_INVALID', `${file} 不是合法的 JSON，已跳过，未改动`, 409); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AgentConfigError('CONFIG_INVALID', `${file} 的顶层不是对象，已跳过，未改动`, 409);
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

// ── TOML（Codex）：只处理单行键值，保留其余内容和注释 ──────────
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

// 把值写进一个配置文件。返回实际改动的键。
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
    // 读这台机器上各工具当前的值。
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
    // 写入工具配置，并同步写入本机覆盖文件（agent-sync.py 每次启动都会用远程规则覆盖同名键，覆盖文件优先，才能让这里设的值长期有效）。
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

// ── Client 侧保存：全局默认 + 每台服务器的覆盖 ───────────────
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
    // 某台服务器上某工具实际要下发的值：覆盖里出现的键（包括空字符串 = 这台不管）优先于全局默认。
    effective(state, serverKey, tool) {
      return { ...(state.defaults[tool] || {}), ...((state.servers[serverKey] || {})[tool] || {}) };
    },
  };
}

module.exports = { SCHEMA, TOOLS, AgentConfigError, cleanValues, createAgentConfig, createAgentConfigStore, locations, setTomlKey, getTomlKey };
