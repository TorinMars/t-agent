const crypto = require('crypto');
const OSS = require('ali-oss');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const LINK_SECONDS = 24 * 60 * 60;
class OssImageError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}
const defaults = () => ({ enabled: false, region: '', bucket: '', accessKeyId: '', accessKeySecret: '', prefix: 'terminal-images/', publicBaseUrl: '' });
const text = value => typeof value === 'string' ? value.trim() : '';
const controls = /[\x00-\x20\x7f]/;
function publicUrl(value) {
  if (!value) return '';
  try {
    if (typeof value !== 'string' || controls.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) throw Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#') || value.includes('\\')) throw Error();
    return url.href.replace(/\/+$/, '');
  } catch { throw new OssImageError('公共地址必须是无凭据、查询参数或控制字符的 HTTPS URL'); }
}
function imageType(body) {
  if (body.length >= 24 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && body.toString('ascii', 12, 16) === 'IHDR' && body.readUInt32BE(16) && body.readUInt32BE(20)) return ['image/png', 'png'];
  if (body.length >= 4 && body[0] === 255 && body[1] === 216 && body[2] === 255 && body[body.length - 2] === 255 && body[body.length - 1] === 217) return ['image/jpeg', 'jpg'];
  if (body.length >= 14 && /^GIF8[79]a$/.test(body.toString('ascii', 0, 6)) && body.readUInt16LE(6) && body.readUInt16LE(8) && body[body.length - 1] === 59) return ['image/gif', 'gif'];
  if (body.length >= 20 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(body.toString('ascii', 12, 16)) && body.readUInt32LE(4) + 8 === body.length) return ['image/webp', 'webp'];
  throw new OssImageError('仅支持 PNG、JPEG、GIF 和 WebP 图片', 415);
}
function createOssImages({ db, sessionSecret, createClient = options => new OSS(options) }) {
  const key = owner => `oss-images:${owner}`;
  function read(owner) {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key(owner));
    return row ? JSON.parse(decryptToken(row.value, sessionSecret)) : defaults();
  }
  function safe(config) {
    const { accessKeySecret, ...visible } = config;
    return { ...visible, hasAccessKeySecret: Boolean(accessKeySecret) };
  }
  return {
    getConfig(owner) { return safe(read(owner)); },
    saveConfig(owner, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OssImageError('OSS 配置无效');
      const old = read(owner);
      const next = {
        enabled: body.enabled === true, region: text(body.region), bucket: text(body.bucket),
        accessKeyId: text(body.accessKeyId), accessKeySecret: text(body.accessKeySecret) || old.accessKeySecret,
        prefix: text(body.prefix).replace(/^\/+|\/+$/g, ''), publicBaseUrl: publicUrl(body.publicBaseUrl || ''),
      };
      if (!/^oss-[a-z]{2,}(?:-[a-z0-9]+)+$/.test(next.region) || next.region.length > 80) throw new OssImageError('Region 格式无效，例如 oss-cn-hangzhou');
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(next.bucket)) throw new OssImageError('Bucket 名称无效');
      if (!next.accessKeyId || !next.accessKeySecret || controls.test(next.accessKeyId) || controls.test(next.accessKeySecret) || next.accessKeyId.length > 256 || next.accessKeySecret.length > 256) throw new OssImageError('请填写 AccessKey ID 和 Secret');
      if (next.prefix.length > 256 || !/^[a-zA-Z0-9_\-/]*$/.test(next.prefix) || next.prefix.split('/').some(part => part === '..')) throw new OssImageError('路径前缀仅支持字母、数字、下划线、短横线和斜杠');
      if (next.prefix) next.prefix += '/';
      db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key(owner), encryptToken(JSON.stringify(next), sessionSecret));
      return safe(next);
    },
    clearConfig(owner) {
      db.prepare('DELETE FROM system_state WHERE key = ?').run(key(owner));
      return safe(defaults());
    },
    async upload(owner, body, contentType) {
      const config = read(owner);
      if (!config.enabled) throw new OssImageError('尚未启用 OSS 图片上传');
      if (!Buffer.isBuffer(body) || !body.length) throw new OssImageError('图片内容为空');
      if (body.length > MAX_IMAGE_BYTES) throw new OssImageError('图片不能超过 10 MiB', 413);
      const [mime, extension] = imageType(body);
      if (text(contentType).split(';')[0].toLowerCase() !== mime) throw new OssImageError('图片内容与类型不匹配', 415);
      const objectKey = `${config.prefix}${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
      try {
        const client = createClient({ region: config.region, bucket: config.bucket, accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, secure: true, authorizationV4: true, timeout: 60000 });
        await client.put(objectKey, body, { headers: { 'Content-Type': mime, 'Content-Disposition': 'inline' } });
        if (config.publicBaseUrl) return { url: `${config.publicBaseUrl}/${objectKey}`, expiresAt: null };
        const url = await client.signatureUrlV4('GET', LINK_SECONDS, {}, objectKey);
        if (new URL(url).protocol !== 'https:' || controls.test(url)) throw Error('Invalid download URL');
        return { url, expiresAt: new Date(Date.now() + LINK_SECONDS * 1000).toISOString() };
      } catch { throw new OssImageError('OSS 图片上传失败，请检查配置和 Bucket 权限', 502); }
    },
  };
}
module.exports = { createOssImages, OssImageError, MAX_IMAGE_BYTES };
