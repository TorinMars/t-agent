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
  } catch { throw new OssImageError('The public address must be an HTTPS URL without credentials, query parameters or control characters'); }
}
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const POLICY_SECONDS = 5 * 60;
// OSS signature V4 of a POST policy: a chain of HMAC-SHA256 keys derived from the secret, the day, the region and the service.
function signPolicy(accessKeySecret, day, region, encodedPolicy) {
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const key = ['oss', 'aliyun_v4_request'].reduce((current, part) => hmac(current, part), hmac(hmac(`aliyun_v4${accessKeySecret}`, day), region));
  return crypto.createHmac('sha256', key).update(encodedPolicy).digest('hex');
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
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OssImageError('Invalid OSS configuration');
      const old = read(owner);
      const next = {
        enabled: body.enabled === true, region: text(body.region), bucket: text(body.bucket),
        accessKeyId: text(body.accessKeyId), accessKeySecret: text(body.accessKeySecret) || old.accessKeySecret,
        prefix: text(body.prefix).replace(/^\/+|\/+$/g, ''), publicBaseUrl: publicUrl(body.publicBaseUrl || ''),
      };
      if (!/^oss-[a-z]{2,}(?:-[a-z0-9]+)+$/.test(next.region) || next.region.length > 80) throw new OssImageError('Invalid region format, e.g. oss-cn-hangzhou');
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(next.bucket)) throw new OssImageError('Invalid bucket name');
      if (!next.accessKeyId || !next.accessKeySecret || controls.test(next.accessKeyId) || controls.test(next.accessKeySecret) || next.accessKeyId.length > 256 || next.accessKeySecret.length > 256) throw new OssImageError('Enter the AccessKey ID and secret');
      if (next.prefix.length > 256 || !/^[a-zA-Z0-9_\-/]*$/.test(next.prefix) || next.prefix.split('/').some(part => part === '..')) throw new OssImageError('The path prefix only supports letters, digits, underscores, hyphens and slashes');
      if (next.prefix) next.prefix += '/';
      db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key(owner), encryptToken(JSON.stringify(next), sessionSecret));
      return safe(next);
    },
    clearConfig(owner) {
      db.prepare('DELETE FROM system_state WHERE key = ?').run(key(owner));
      return safe(defaults());
    },
    // The browser uploads the image straight to OSS with a form POST; this only signs what that POST may contain (one object key, one
    // content type, exactly the announced size, valid for a few minutes), so the AccessKey secret never leaves the server and the image
    // bytes never pass through it.
    async signUpload(owner, body) {
      const config = read(owner);
      if (!config.enabled) throw new OssImageError('OSS image upload is not enabled yet');
      const mime = text(body && body.type).toLowerCase();
      const size = body && body.size;
      if (!IMAGE_TYPES[mime]) throw new OssImageError('Only PNG, JPEG, GIF and WebP images are supported', 415);
      if (!Number.isSafeInteger(size) || size <= 0) throw new OssImageError('The image is empty');
      if (size > MAX_IMAGE_BYTES) throw new OssImageError('The image cannot exceed 10 MiB', 413);
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261026T120000Z
      const region = config.region.replace(/^oss-/, '');
      const objectKey = `${config.prefix}${now.toISOString().slice(0, 10)}/${crypto.randomUUID()}.${IMAGE_TYPES[mime]}`;
      const credential = `${config.accessKeyId}/${stamp.slice(0, 8)}/${region}/oss/aliyun_v4_request`;
      const policy = {
        expiration: new Date(now.getTime() + POLICY_SECONDS * 1000).toISOString(),
        conditions: [
          { bucket: config.bucket }, { 'x-oss-signature-version': 'OSS4-HMAC-SHA256' }, { 'x-oss-credential': credential }, { 'x-oss-date': stamp },
          ['eq', '$key', objectKey], ['eq', '$Content-Type', mime], ['eq', '$Content-Disposition', 'inline'], ['eq', '$success_action_status', '200'],
          ['content-length-range', size, size],
        ],
      };
      const encoded = Buffer.from(JSON.stringify(policy)).toString('base64');
      const fields = {
        key: objectKey, 'Content-Type': mime, 'Content-Disposition': 'inline', success_action_status: '200', policy: encoded,
        'x-oss-signature-version': 'OSS4-HMAC-SHA256', 'x-oss-credential': credential, 'x-oss-date': stamp,
        'x-oss-signature': signPolicy(config.accessKeySecret, stamp.slice(0, 8), region, encoded),
      };
      const host = `https://${config.bucket}.${config.region}.aliyuncs.com`;
      try {
        if (config.publicBaseUrl) return { host, fields, url: `${config.publicBaseUrl}/${objectKey}`, expiresAt: null };
        const client = createClient({ region: config.region, bucket: config.bucket, accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, secure: true, authorizationV4: true });
        const url = await client.signatureUrlV4('GET', LINK_SECONDS, {}, objectKey);
        if (new URL(url).protocol !== 'https:' || controls.test(url)) throw Error('Invalid download URL');
        return { host, fields, url, expiresAt: new Date(Date.now() + LINK_SECONDS * 1000).toISOString() };
      } catch { throw new OssImageError('Could not prepare the OSS upload; check the configuration', 502); }
    },
  };
}
module.exports = { createOssImages, OssImageError, MAX_IMAGE_BYTES, signPolicy };
