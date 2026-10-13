const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { request, normalizeBaseUrl } = require('./remote-client');
const { decryptToken, encryptToken } = require('../lib/token-crypto');

const MAX_FILE = 1024 * 1024;
const CHILD_ONLINE_MS = 15_000;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_KEY = 'file_sync_v1';
const MANAGED_SUFFIX = '.t-agent-file-sync-managed';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
// 用户可能粘贴 192.168.1.5:3000 或带 /web 的完整地址，统一成 协议://主机:端口。
function masterBaseUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw Object.assign(new Error('SYNC_MASTER_URL_INVALID'), { statusCode: 400 });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  try { return normalizeBaseUrl(new URL(text).origin); }
  catch { throw Object.assign(new Error('SYNC_MASTER_URL_INVALID'), { statusCode: 400 }); }
}
const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const PAIRING_CODE = /^TA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const SLAVE_CODE_TTL_MS = 10 * 60 * 1000;
const SLAVE_CODE_MAX_FAILS = 5;
const TOKEN_PREFIX = 'tfs_';
function newPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `TA-${group()}-${group()}-${group()}`;
}

function normalizeSpec(input) {
  if (typeof input !== 'string') throw fault('SYNC_PATH_INVALID');
  let value = input.trim();
  if (value.startsWith('用户目录/')) value = `~/${value.slice(5)}`;
  if (value.startsWith('$HOME/')) value = `~/${value.slice(6)}`;
  if (value.startsWith('~/')) {
    const relative = value.slice(2);
    if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fault('SYNC_PATH_INVALID');
    return `~/${relative}`;
  }
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value === path.parse(value).root) throw fault('SYNC_PATH_INVALID');
  return value;
}
function resolveSpec(spec, home = os.homedir()) { return spec.startsWith('~/') ? path.join(home, spec.slice(2)) : spec; }
function readFile(spec, home) {
  const file = resolveSpec(spec, home);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE) throw fault('SYNC_FILE_INVALID');
    const data = fs.readFileSync(file);
    if (data.length > MAX_FILE) throw fault('SYNC_FILE_INVALID');
    return { hash: sha(data), content: data.toString('base64'), size: data.length };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function writeFile(spec, encoded, home) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_FILE * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw fault('SYNC_CONTENT_INVALID');
  const data = Buffer.from(encoded, 'base64');
  if (data.length > MAX_FILE) throw fault('SYNC_FILE_TOO_LARGE');
  const file = resolveSpec(spec, home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw fault('SYNC_FILE_INVALID');
    mode = stat.mode & 0o777;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.t-agent-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temp, data, { flag: 'wx', mode });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return { hash: sha(data), content: encoded, size: data.length };
}
class FileSync {
  constructor({ db, secret, home, intervalMs = 3000, remoteRequest = request } = {}) {
    this.db = db; this.secret = secret; this.home = home || os.homedir(); this.remoteRequest = remoteRequest;
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    this.state = row ? JSON.parse(row.value) : { masterId: null, files: [], versions: {}, observed: {}, backups: {}, error: null };
    this.state.generation ||= crypto.randomUUID();
    this.state.clock ||= Math.max(0, ...Object.values(this.state.versions || {}).map(value => value.revision || 0));
    // 旧数据没有 mode：已连接主服务器的是从服务器，否则是主服务器。
    this.state.mode ||= this.state.masterId == null ? 'master' : 'slave';
    this.codeInfo = null;
    this.masterCodes = new Map();
    this.busy = false;
    this.timer = intervalMs ? setInterval(() => this.tick().catch(error => { this.state.error = error.message; }), intervalMs) : null;
    this.timer?.unref();
  }
  save() {
    this.db.prepare(`INSERT INTO system_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify(this.state));
  }
  isMaster() { return this.state.mode === 'master'; }
  paired() { return Boolean(this.state.link) || this.state.masterId != null; }
  awaitingPairing() { return this.state.mode === 'slave' && !this.paired(); }
  // 主服务器的地址和令牌：文件同步自己保存在 state.link；旧版本留下的数字 masterId 仍从 remote_servers 读取。
  masterLink(state = this.state) {
    if (state.link) return { url: state.link.url, token: decryptToken(state.link.tokenCipher, this.secret) };
    if (state.masterId == null) return null;
    const row = this.db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(state.masterId);
    return row ? { url: row.base_url, token: decryptToken(row.token_cipher, this.secret) } : null;
  }
  // 主服务器：生成一次性同步配对码，从服务器用它换取只能访问文件同步接口的令牌（与引擎连接、引擎令牌无关）。
  createSyncCode() {
    const now = Date.now();
    for (const [hash, expires] of this.masterCodes) if (expires <= now) this.masterCodes.delete(hash);
    const code = newPairingCode();
    this.masterCodes.set(sha(code), now + SLAVE_CODE_TTL_MS);
    return code;
  }
  exchangeSyncCode({ code, name, instance_id: instanceId }) {
    if (!this.isMaster()) throw fault('SYNC_NOT_MASTER', 409);
    const hash = sha(String(code || '').trim().toUpperCase());
    const expires = this.masterCodes.get(hash);
    this.masterCodes.delete(hash);
    if (!expires || expires <= Date.now()) throw fault('PAIRING_CODE_INVALID_OR_EXPIRED');
    const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
    this.state.tokens ||= {};
    this.state.tokens[sha(token)] = {
      name: typeof name === 'string' ? name.slice(0, 80) : '',
      instanceId: typeof instanceId === 'string' && INSTANCE_ID.test(instanceId) ? instanceId : null,
      createdAt: new Date().toISOString(),
    };
    this.save();
    return { access_token: token, token_type: 'Bearer', instance_id: this.identity() };
  }
  verifyToken(token) {
    return this.isMaster() && typeof token === 'string' && token.startsWith(TOKEN_PREFIX) && Boolean(this.state.tokens?.[sha(token)]);
  }
  // 从服务器未关联时一直显示一个配对码；过期或被猜错太多次就换新的。码只放内存，重启后重新生成。
  pairingCode(renew = false) {
    if (!this.awaitingPairing()) { this.codeInfo = null; return null; }
    const now = Date.now();
    if (renew || !this.codeInfo || this.codeInfo.expiresAt <= now || this.codeInfo.fails >= SLAVE_CODE_MAX_FAILS) {
      this.codeInfo = { code: newPairingCode(), expiresAt: now + SLAVE_CODE_TTL_MS, fails: 0 };
    }
    return { code: this.codeInfo.code, expires_at: new Date(this.codeInfo.expiresAt).toISOString() };
  }
  localSpec(spec) { return this.isMaster() ? spec : this.state.pathOverrides?.[spec] || spec; }
  localPath(spec) { return resolveSpec(this.localSpec(spec), this.home); }
  removeMarker(file) {
    const marker = file + MANAGED_SUFFIX;
    try { if (fs.readFileSync(marker, 'utf8') === 't-agent-file-sync\n') fs.unlinkSync(marker); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  refreshMarkers() {
    for (const spec of this.state.files) {
      const file = this.localPath(spec);
      const marker = file + MANAGED_SUFFIX;
      try {
        if (!fs.lstatSync(file).isFile()) continue;
        const temp = `${marker}.${crypto.randomBytes(6).toString('hex')}`;
        try {
          fs.writeFileSync(temp, 't-agent-file-sync\n', { flag: 'wx', mode: 0o600 });
          fs.renameSync(temp, marker);
        } finally { try { fs.unlinkSync(temp); } catch {} }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  identity() { return this.db.prepare("SELECT value FROM engine_identity WHERE key = 'instance_id'").get()?.value; }
  status() {
    return { role: this.isMaster() ? 'master' : 'child', master_id: this.state.masterId, master_url: this.paired() ? (this.masterLink()?.url ?? null) : null, pairing: this.pairingCode(),
      files: this.state.files.map(spec => {
        const exists = Boolean(readFile(this.localSpec(spec), this.home));
        return { path: spec, local_path: this.localPath(spec), default_path: resolveSpec(spec, this.home), path_override: this.state.pathOverrides?.[spec] || null,
          path_required: !this.isMaster() && path.isAbsolute(spec) && !this.state.pathOverrides?.[spec] && !this.state.observed[spec] && !exists,
          version: this.state.versions[spec]?.revision || this.state.observed[spec]?.revision || 0, exists, backup: this.state.backups?.[spec] || null };
      }),
      children: this.isMaster() ? Object.entries(this.state.children || {}).map(([id, child]) => ({
        id, name: child.name, last_seen_at: child.lastSeenAt, last_sync_at: child.lastSyncAt || null,
        error: child.error || null, online: Date.now() - Date.parse(child.lastSeenAt) < CHILD_ONLINE_MS,
      })).sort((a, b) => a.name.localeCompare(b.name)) : [],
      error: this.state.error, registration_error: this.state.registrationError || null,
      last_sync_at: this.state.lastSyncAt || null };
  }
  registerChild({ instance_id: id, name, generation, last_sync_at: lastSyncAt, error }) {
    if (!this.isMaster()) throw fault('SYNC_NOT_MASTER', 409);
    if (generation !== this.state.generation) throw fault('SYNC_CONFLICT', 409);
    if (typeof id !== 'string' || !INSTANCE_ID.test(id) || id === this.identity()) throw fault('SYNC_CHILD_INVALID');
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw fault('SYNC_CHILD_INVALID');
    this.state.children ||= {};
    this.state.children[id] = {
      name: name.trim(), lastSeenAt: new Date().toISOString(),
      lastSyncAt: typeof lastSyncAt === 'string' && !Number.isNaN(Date.parse(lastSyncAt)) ? lastSyncAt : null,
      error: typeof error === 'string' ? error.slice(0, 200) : null,
    };
    this.save();
    return { registered: true };
  }
  unregisterChild({ instance_id: id, generation }) {
    if (!this.isMaster()) throw fault('SYNC_NOT_MASTER', 409);
    if (generation !== this.state.generation) throw fault('SYNC_CONFLICT', 409);
    if (typeof id !== 'string' || !INSTANCE_ID.test(id)) throw fault('SYNC_CHILD_INVALID');
    if (this.state.children) delete this.state.children[id];
    for (const [hash, record] of Object.entries(this.state.tokens || {})) if (record.instanceId === id) delete this.state.tokens[hash];
    this.save();
    return { removed: true };
  }
  async heartbeat() {
    if (this.isMaster() || !this.paired()) return;
    const { url, token } = this.remote();
    try {
      await this.remoteRequest(url, '/v1/file-sync/heartbeat', token, {
        method: 'POST', timeoutMs: 3000,
        body: { instance_id: this.identity(), name: os.hostname().slice(0, 80), generation: this.state.masterGeneration,
          last_sync_at: this.state.lastSyncAt || null, error: this.state.error || null },
      });
      this.state.registrationError = null;
    } catch (error) {
      // A 2.35.0 master can still synchronize files, but has no child roster endpoint.
      this.state.registrationError = error.statusCode === 404 ? null : error.message;
    }
    this.save();
  }
  async unregisterFrom(link, generation) {
    if (!link) return;
    try {
      await this.remoteRequest(link.url, '/v1/file-sync/heartbeat', link.token, {
        method: 'DELETE', timeoutMs: 2000, body: { instance_id: this.identity(), generation },
      });
    } catch { /* 离线时主服务器会把最后一次心跳标为离线。 */ }
  }
  scanMaster() {
    if (!this.isMaster()) throw fault('SYNC_NOT_MASTER', 409);
    for (const spec of this.state.files) {
      const current = readFile(spec, this.home);
      if (!current) continue;
      const previous = this.state.versions[spec];
      if (!previous || previous.hash !== current.hash) this.state.versions[spec] = { hash: current.hash, revision: ++this.state.clock };
    }
    this.save();
  }
  manifest() {
    this.scanMaster();
    return { instance_id: this.identity(),
      generation: this.state.generation,
      files: this.state.files.map(spec => ({ path: spec, revision: this.state.versions[spec]?.revision || 0, ...readFile(spec, this.home) })) };
  }
  setFiles(paths) {
    if (!this.isMaster()) throw fault('SYNC_NOT_MASTER', 409);
    if (!Array.isArray(paths) || paths.length > 100) throw fault('SYNC_FILES_INVALID');
    const files = paths.map(normalizeSpec);
    if (new Set(files.map(spec => resolveSpec(spec, this.home))).size !== files.length) throw fault('SYNC_PATH_DUPLICATE');
    for (const spec of this.state.files) if (!files.includes(spec)) this.removeMarker(this.localPath(spec));
    this.state.files = files;
    for (const spec of Object.keys(this.state.versions)) if (!files.includes(spec)) delete this.state.versions[spec];
    this.scanMaster();
    this.refreshMarkers();
    return this.status();
  }
  setPath({ path: input, local_path: inputPath }) {
    if (this.isMaster()) throw fault('SYNC_NOT_CHILD', 409);
    const spec = normalizeSpec(input);
    if (!this.state.files.includes(spec)) throw fault('SYNC_PATH_NOT_CONFIGURED', 404);
    const override = inputPath == null || inputPath === '' ? null : normalizeSpec(inputPath);
    const effective = override && resolveSpec(override, this.home) !== resolveSpec(spec, this.home) ? override : null;
    const target = resolveSpec(effective || spec, this.home);
    if (this.state.files.some(other => other !== spec && this.localPath(other) === target)) throw fault('SYNC_PATH_DUPLICATE');
    if (this.localPath(spec) !== target) {
      this.removeMarker(this.localPath(spec));
      delete this.state.observed[spec];
      this.state.error = null;
    }
    this.state.pathOverrides ||= {};
    if (effective) this.state.pathOverrides[spec] = effective;
    else delete this.state.pathOverrides[spec];
    this.save();
    return this.status();
  }
  receive({ path: input, base_revision: base, generation, content }) {
    if (!this.isMaster()) throw fault('SYNC_NOT_MASTER', 409);
    const spec = normalizeSpec(input);
    if (!this.state.files.includes(spec)) throw fault('SYNC_PATH_NOT_CONFIGURED', 404);
    this.scanMaster();
    const current = this.state.versions[spec]?.revision || 0;
    if (generation !== this.state.generation || !Number.isInteger(base) || base !== current) throw fault('SYNC_CONFLICT', 409);
    const written = writeFile(spec, content, this.home);
    this.state.versions[spec] = { hash: written.hash, revision: ++this.state.clock };
    this.save();
    return { revision: this.state.clock, hash: written.hash };
  }
  remote() {
    const link = this.masterLink();
    if (!link) throw fault('SYNC_MASTER_NOT_FOUND', 404);
    return link;
  }
  // 凭主服务器的同步配对码换取文件同步令牌，保存在本模块自己的状态里，然后立即连接并同步。
  async join({ url, code }) {
    const pairing = String(code || '').trim().toUpperCase();
    if (!PAIRING_CODE.test(pairing)) throw fault('SYNC_PAIRING_CODE_INVALID');
    const baseUrl = masterBaseUrl(url);
    const paired = await this.remoteRequest(baseUrl, '/v1/file-sync/pair', null, { method: 'POST',
      body: { code: pairing, name: os.hostname().slice(0, 80), instance_id: this.identity() } });
    const token = paired && paired.access_token;
    if (typeof token !== 'string' || !token) throw fault('SYNC_PAIRING_FAILED', 502);
    return this.connect({ url: baseUrl, token });
  }
  async connect({ url, token }) {
    const manifest = await this.remoteRequest(url, '/v1/file-sync/manifest', token, { maxBytes: 160 * 1024 * 1024 });
    if (!Array.isArray(manifest.files) || typeof manifest.generation !== 'string') throw fault('SYNC_MANIFEST_INVALID', 502);
    if (manifest.instance_id && manifest.instance_id === this.identity()) throw fault('SYNC_SELF_CONNECTION');
    const old = structuredClone(this.state);
    const oldPaths = this.state.files.map(spec => this.localPath(spec));
    const oldMaster = old.mode === 'master' ? null : this.masterLink(old);
    this.state.link = { url, tokenCipher: encryptToken(token, this.secret) };
    this.state.masterId = null;
    this.state.mode = 'slave';
    this.state.files = [];
    this.state.versions = {};
    this.state.observed = {};
    this.state.pathOverrides = {};
    this.state.masterGeneration = manifest.generation;
    try { await this.applyManifest(manifest, true); }
    catch (error) { this.state = old; this.save(); throw error; }
    this.state.lastSyncAt = new Date().toISOString();
    this.save();
    for (const file of oldPaths) if (!this.state.files.some(spec => this.localPath(spec) === file)) this.removeMarker(file);
    this.refreshMarkers();
    await this.heartbeat();
    if (oldMaster && oldMaster.url !== url) await this.unregisterFrom(oldMaster, old.masterGeneration);
    return this.status();
  }
  async disconnect() {
    const oldPaths = this.state.files.map(spec => this.localPath(spec));
    const oldMaster = this.isMaster() ? null : this.masterLink();
    const oldGeneration = this.state.masterGeneration;
    const children = this.isMaster() ? this.state.children : {};
    const tokens = this.isMaster() ? this.state.tokens : {};
    this.state = { mode: 'master', masterId: null, files: [], versions: {}, observed: {}, pathOverrides: {}, backups: this.state.backups || {}, children, tokens, generation: crypto.randomUUID(), clock: 0, error: null };
    this.codeInfo = null;
    this.save();
    for (const file of oldPaths) this.removeMarker(file);
    await this.unregisterFrom(oldMaster, oldGeneration);
    return this.status();
  }
  // 显式设置本节点是主服务器还是从服务器。切换会清空同步清单（本地文件保留）。
  async setRole(role) {
    if (role !== 'master' && role !== 'slave') throw fault('SYNC_ROLE_INVALID');
    if ((role === 'master') === this.isMaster()) return this.status();
    await this.disconnect();
    if (role === 'slave') { this.state.mode = 'slave'; this.state.children = {}; this.state.tokens = {}; this.save(); }
    return this.status();
  }
  // 从服务器解除与主服务器的关联，仍是从服务器，并生成新的配对码等待重新关联。
  async unpair() {
    if (this.isMaster()) throw fault('SYNC_NOT_CHILD', 409);
    await this.disconnect();
    this.state.mode = 'slave'; this.state.children = {};
    this.save();
    return this.status();
  }
  // 主服务器根据从服务器界面显示的配对码关联它：把主服务器地址和一次性配对码交给从服务器，
  // 从服务器用它走“加入主服务器”流程，之后仍由从服务器轮询主服务器。
  async associate({ slaveUrl, slaveCode, masterUrl }) {
    if (!this.isMaster()) throw fault('SYNC_NOT_MASTER', 409);
    const code = String(slaveCode || '').trim().toUpperCase();
    if (!PAIRING_CODE.test(code)) throw fault('SYNC_PAIRING_CODE_INVALID');
    const slave = masterBaseUrl(slaveUrl);
    const master = masterBaseUrl(masterUrl);
    await this.remoteRequest(slave, '/v1/file-sync/adopt', null, {
      method: 'POST', timeoutMs: 30_000,
      body: { code, master_url: master, master_code: this.createSyncCode() },
    });
    return this.status();
  }
  // 从服务器侧：凭自己显示的配对码接受主服务器的关联。配对码只能用一次。
  async adopt({ code, masterUrl, masterCode }) {
    const current = this.pairingCode();
    if (!current) throw fault('SYNC_NOT_AWAITING_PAIRING', 409);
    const given = Buffer.from(String(code || '').trim().toUpperCase());
    const expected = Buffer.from(this.codeInfo.code);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      this.codeInfo.fails += 1;
      throw fault('PAIRING_CODE_INVALID_OR_EXPIRED', 403);
    }
    this.codeInfo = null;
    return this.join({ url: masterUrl, code: masterCode });
  }
  backup(spec, current) {
    if (!current) return;
    const directory = path.join(this.home, '.t-agent', 'file-sync-backups');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${sha(spec).slice(0, 12)}-${crypto.randomBytes(4).toString('hex')}.bak`;
    const target = path.join(directory, name);
    fs.writeFileSync(target, Buffer.from(current.content, 'base64'), { flag: 'wx', mode: 0o600 });
    this.state.backups ||= {};
    this.state.backups[spec] = target;
  }
  async resolveConflict(input) {
    if (this.isMaster()) throw fault('SYNC_NOT_CHILD', 409);
    const spec = normalizeSpec(input);
    const { url, token } = this.remote();
    const manifest = await this.remoteRequest(url, '/v1/file-sync/manifest', token, { maxBytes: 160 * 1024 * 1024 });
    const item = manifest.files?.find(file => file.path === spec);
    if (!item || item.content == null) throw fault('SYNC_REMOTE_FILE_MISSING', 404);
    if (sha(Buffer.from(item.content, 'base64')) !== item.hash) throw fault('SYNC_MANIFEST_INVALID', 502);
    this.backup(spec, readFile(this.localSpec(spec), this.home));
    writeFile(this.localSpec(spec), item.content, this.home);
    this.state.observed[spec] = { hash: item.hash, revision: item.revision, generation: manifest.generation };
    this.state.error = null;
    this.save();
    return this.status();
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.state.error = null;
      if (this.awaitingPairing()) { this.pairingCode(); return; }
      if (this.isMaster()) this.scanMaster();
      else {
        const { url, token } = this.remote();
        await this.applyManifest(await this.remoteRequest(url, '/v1/file-sync/manifest', token, { maxBytes: 160 * 1024 * 1024 }));
      }
      this.state.lastSyncAt = new Date().toISOString();
      this.save();
      this.refreshMarkers();
      if (!this.isMaster()) await this.heartbeat();
    } catch (error) { this.state.error = error.message; this.save(); throw error; }
    finally { this.busy = false; }
  }
  async applyManifest(manifest, initial = false) {
    if (!Array.isArray(manifest.files) || manifest.files.length > 100 || typeof manifest.generation !== 'string') throw fault('SYNC_MANIFEST_INVALID', 502);
    const { url, token } = this.remote();
    const oldPaths = this.state.files.map(spec => this.localPath(spec));
    const files = [], seen = new Set();
    for (const item of manifest.files) {
      const spec = normalizeSpec(item.path);
      const localPath = this.localPath(spec);
      if (seen.has(localPath) || !Number.isInteger(item.revision) || item.revision < 0) throw fault('SYNC_MANIFEST_INVALID', 502);
      seen.add(localPath);
      if (item.content != null) {
        if (typeof item.content !== 'string' || item.content.length > Math.ceil(MAX_FILE * 4 / 3) + 4) throw fault('SYNC_MANIFEST_INVALID', 502);
        if (sha(Buffer.from(item.content, 'base64')) !== item.hash) throw fault('SYNC_MANIFEST_INVALID', 502);
      }
    }
    for (const item of manifest.files) {
      const spec = normalizeSpec(item.path);
      files.push(spec);
      if (item.content == null) continue;
      const remoteHash = sha(Buffer.from(item.content, 'base64'));
      const local = readFile(this.localSpec(spec), this.home);
      const observed = this.state.observed[spec];
      // An absolute path from another OS may point nowhere here. Wait for a local mapping
      // instead of creating, for example, /Users/name on a Linux server.
      if (path.isAbsolute(spec) && !this.state.pathOverrides?.[spec] && !observed && !local) continue;
      if (local?.hash === remoteHash) {
        this.state.observed[spec] = { hash: remoteHash, revision: item.revision, generation: manifest.generation };
        continue;
      }
      const localChanged = !initial && observed && local && local.hash !== observed.hash;
      if (localChanged && observed.revision === item.revision && observed.generation === manifest.generation) {
        try {
          const result = await this.remoteRequest(url, '/v1/file-sync/file', token, { method: 'PUT', body: { path: spec, base_revision: observed.revision, generation: manifest.generation, content: local.content } });
          this.state.observed[spec] = { hash: local.hash, revision: result.revision, generation: manifest.generation };
          continue;
        } catch (error) {
          if (error.statusCode !== 409) throw error;
          this.state.error = `SYNC_CONFLICT:${spec}`;
          continue;
        }
      }
      if (localChanged && (observed.revision !== item.revision || observed.generation !== manifest.generation)) {
        this.state.error = `SYNC_CONFLICT:${spec}`;
        continue;
      }
      if ((!observed || initial) && local && local.hash !== remoteHash) this.backup(spec, local);
      if (!local || local.hash !== remoteHash) writeFile(this.localSpec(spec), item.content, this.home);
      this.state.observed[spec] = { hash: remoteHash, revision: item.revision, generation: manifest.generation };
    }
    this.state.files = files;
    for (const spec of Object.keys(this.state.pathOverrides || {})) if (!files.includes(spec)) delete this.state.pathOverrides[spec];
    for (const file of oldPaths) if (!files.some(spec => this.localPath(spec) === file)) this.removeMarker(file);
    this.state.masterGeneration = manifest.generation;
    for (const spec of Object.keys(this.state.observed)) if (!files.includes(spec)) delete this.state.observed[spec];
    this.save();
  }
}
module.exports = { FileSync, normalizeSpec, resolveSpec, readFile, writeFile, MAX_FILE };
