// 应用注册表：保存“有哪些服务、怎么访问”。PM2 运行状态和端口检测在 apps-service.js 里合并，这里只管数据和校验。
class AppsError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const FIELDS = ['name', 'port', 'host', 'domain', 'scheme', 'path', 'url', 'description', 'pm2_name'];
const hasControl = value => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function text(value, field, { max, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new AppsError('APP_FIELD_REQUIRED', `${field} 不能为空`);
    return null;
  }
  if (typeof value !== 'string') throw new AppsError('APP_FIELD_INVALID', `${field} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new AppsError('APP_FIELD_REQUIRED', `${field} 不能为空`);
    return null;
  }
  if (trimmed.length > max) throw new AppsError('APP_FIELD_TOO_LONG', `${field} 不能超过 ${max} 个字符`);
  if (hasControl(trimmed)) throw new AppsError('APP_FIELD_INVALID', `${field} 含有不允许的控制字符`);
  return trimmed;
}

// 只接受 http/https，不含账号密码：这些地址会变成界面里可以点击的链接。
function httpUrl(value, field) {
  const raw = text(value, field, { max: 500 });
  if (raw === null) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new AppsError('APP_URL_INVALID', `${field} 不是合法的地址`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || /\s/.test(raw)) {
    throw new AppsError('APP_URL_INVALID', `${field} 只支持不含账号密码的 http:// 或 https:// 地址`);
  }
  return raw;
}

function port(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : (/^\d{1,5}$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new AppsError('APP_PORT_INVALID', '端口必须是 1-65535 的整数');
  return number;
}

function host(value) {
  const raw = text(value, 'IP', { max: 255 });
  if (raw === null) return null;
  if (!/^[A-Za-z0-9.:-]+$/.test(raw)) throw new AppsError('APP_HOST_INVALID', 'IP 只能包含字母、数字、点、冒号和连字符（IPv6 不要加方括号）');
  return raw;
}

// 域名可以写成裸域名（app.example.com 或 app.example.com:8443），也可以是完整的 http(s):// 地址。
function domain(value) {
  const raw = text(value, '域名', { max: 255 });
  if (raw === null) return null;
  if (/^https?:\/\//i.test(raw)) return httpUrl(raw, '域名');
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(raw)) throw new AppsError('APP_DOMAIN_INVALID', '域名格式不正确，例如 app.example.com 或 https://app.example.com');
  return raw;
}

function scheme(value) {
  if (value === undefined || value === null || value === '') return 'http';
  if (value !== 'http' && value !== 'https') throw new AppsError('APP_SCHEME_INVALID', '协议只能是 http 或 https');
  return value;
}

function pathField(value) {
  if (value === undefined || value === null || value === '') return '/';
  const raw = text(value, '路径', { max: 300 });
  if (raw === null) return '/';
  if (!raw.startsWith('/') || /\s/.test(raw)) throw new AppsError('APP_PATH_INVALID', '路径必须以 / 开头且不含空白');
  return raw;
}

function normalize(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppsError('APP_BODY_INVALID', '请求内容必须是 JSON 对象');
  const out = {};
  const has = field => Object.prototype.hasOwnProperty.call(input, field);
  if (!partial || has('name')) out.name = text(input.name, '名称', { max: 64, required: true });
  if (!partial || has('port')) out.port = port(input.port);
  if (!partial || has('host')) out.host = host(input.host);
  if (!partial || has('domain')) out.domain = domain(input.domain);
  if (!partial || has('scheme')) out.scheme = scheme(input.scheme);
  if (!partial || has('path')) out.path = pathField(input.path);
  if (!partial || has('url')) out.url = httpUrl(input.url, '访问地址');
  if (!partial || has('description')) out.description = text(input.description, '说明', { max: 500 });
  if (!partial || has('pm2_name')) out.pm2_name = text(input.pm2_name, 'PM2 进程名', { max: 128 });
  return out;
}

function createAppsRegistry({ db }) {
  const row = id => db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
  const byName = name => db.prepare('SELECT * FROM apps WHERE name = ?').get(name);
  const byPm2 = name => db.prepare('SELECT * FROM apps WHERE pm2_name = ?').get(name);
  const clean = app => (app ? { ...app, hidden: Boolean(app.hidden) } : null);

  function write(sql, params) {
    try { return db.prepare(sql).run(...params); }
    catch (error) {
      if (/UNIQUE constraint failed: apps\.name/.test(error.message)) throw new AppsError('APP_NAME_TAKEN', '已有同名应用', 409);
      if (/UNIQUE constraint failed: apps\.pm2_name/.test(error.message)) throw new AppsError('APP_PM2_LINKED', '这个 PM2 进程已经关联了别的应用', 409);
      throw error;
    }
  }

  function insert(values, source) {
    const result = write(
      `INSERT INTO apps (name, source, pm2_name, port, host, domain, scheme, path, url, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [values.name, source, values.pm2_name, values.port, values.host, values.domain, values.scheme, values.path, values.url, values.description],
    );
    return row(result.lastInsertRowid);
  }

  function applyUpdate(id, values) {
    const columns = Object.keys(values);
    if (!columns.length) return row(id);
    write(`UPDATE apps SET ${columns.map(column => `${column} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...columns.map(column => values[column]), id]);
    return row(id);
  }

  return {
    AppsError,
    list: ({ includeHidden = false } = {}) => db.prepare(`SELECT * FROM apps ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY name COLLATE NOCASE`).all().map(clean),
    hiddenCount: () => db.prepare('SELECT COUNT(*) AS count FROM apps WHERE hidden = 1').get().count,
    get: id => clean(row(id)),

    create(input) {
      return clean(insert(normalize(input), 'manual'));
    },

    update(id, input) {
      const current = row(id);
      if (!current) throw new AppsError('APP_NOT_FOUND', '找不到这个应用', 404);
      const values = normalize(input, { partial: true });
      // 隐藏的应用被编辑后视为“又要用了”，重新显示。
      if (current.hidden) values.hidden = 0;
      return clean(applyUpdate(id, values));
    },

    // 自动登记的 PM2 服务：仍在 PM2 里时只隐藏（否则下次同步会再登记回来），已不在 PM2 里或手动/API 登记的直接删除。
    remove(id, { pm2Present = false } = {}) {
      const current = row(id);
      if (!current) throw new AppsError('APP_NOT_FOUND', '找不到这个应用', 404);
      if (current.source === 'pm2' && current.pm2_name && pm2Present) {
        db.prepare('UPDATE apps SET hidden = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        return { deleted: false, hidden: true };
      }
      db.prepare('DELETE FROM apps WHERE id = ?').run(id);
      return { deleted: true, hidden: false };
    },

    restoreHidden() {
      return db.prepare('UPDATE apps SET hidden = 0, updated_at = CURRENT_TIMESTAMP WHERE hidden = 1').run().changes;
    },

    // 程序自注册：按 PM2 进程名（有则优先）或应用名幂等更新，重复启动不会产生重复记录。
    register(input) {
      const values = normalize(input);
      const existing = (values.pm2_name && byPm2(values.pm2_name)) || byName(values.name);
      if (!existing) return { app: clean(insert(values, 'api')), created: true };
      const update = { ...values };
      // 没有传的可选字段保持原值，避免程序只上报端口就把手填的域名清空。
      for (const field of FIELDS) {
        if (field !== 'name' && !Object.prototype.hasOwnProperty.call(input, field)) delete update[field];
      }
      if (existing.hidden) update.hidden = 0;
      if (update.name === existing.name) delete update.name;
      return { app: clean(applyUpdate(existing.id, update)), created: false };
    },

    // 自动登记 PM2 进程：已有关联就不动；同名的未关联应用直接关联；否则新建。被隐藏的不会再登记。
    ensurePm2(name) {
      if (byPm2(name)) return null;
      const sameName = byName(name);
      if (sameName && !sameName.pm2_name) {
        applyUpdate(sameName.id, { pm2_name: name });
        return clean(row(sameName.id));
      }
      if (sameName) return null;
      return clean(insert({ name, port: null, host: null, domain: null, scheme: 'http', path: '/', url: null, description: null, pm2_name: name }, 'pm2'));
    },
  };
}

module.exports = { createAppsRegistry, AppsError, normalize };
