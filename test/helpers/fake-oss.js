// A fake ali-oss client for the tcli / oss-files tests: objects in memory, the SDK's answer shapes, and failures on demand. Never talks to Aliyun.
const { Readable } = require('node:stream');
const crypto = require('node:crypto');

const SECRET = 'SECRET-never-shown-9f3a';
const KEY_ID = 'LTAI-test-key-id';

function notFound() {
  return Object.assign(new Error('Object not exists'), { name: 'NoSuchKeyError', status: 404, code: 'NoSuchKey' });
}

function createFakeOss() {
  const objects = new Map(); // key -> { body, type, disposition, meta, etag, modified }
  const calls = [];
  const options = [];
  let failNext = null;
  const maybeFail = () => {
    if (!failNext) return;
    const error = failNext;
    failNext = null;
    throw error;
  };
  const store = (key, body, { type = 'application/octet-stream', disposition = null, meta = {} } = {}) => {
    const etag = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
    objects.set(key, { body, type, disposition, meta, etag, modified: new Date('2026-11-12T08:30:00Z') });
  };
  const headersOf = object => ({
    'content-length': String(object.body.length), 'content-type': object.type, etag: `"${object.etag}"`, 'last-modified': object.modified.toUTCString(),
    ...(object.disposition ? { 'content-disposition': object.disposition } : {}),
    ...Object.fromEntries(Object.entries(object.meta).map(([name, value]) => [`x-oss-meta-${name}`, value])),
  });
  const client = {
    async list(query) {
      calls.push(['list', query]);
      maybeFail();
      const prefix = query.prefix || '';
      const max = query['max-keys'] || 100;
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix) && (!query.marker || key > query.marker)).sort();
      const found = [];
      const prefixes = new Set();
      let last = null;
      for (const key of keys) {
        if (found.length + prefixes.size >= max) break;
        const rest = key.slice(prefix.length);
        const cut = query.delimiter ? rest.indexOf(query.delimiter) : -1;
        if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
        else found.push(key);
        last = key;
      }
      const truncated = keys.length > 0 && last !== null && keys[keys.length - 1] > last;
      return {
        objects: found.map(key => {
          const object = objects.get(key);
          return { name: key, size: object.body.length, lastModified: object.modified.toISOString(), etag: `"${object.etag}"`, storageClass: 'Standard', owner: { id: '1', displayName: '1' } };
        }),
        prefixes: prefixes.size ? [...prefixes] : null,
        nextMarker: truncated ? last : null,
        isTruncated: truncated,
      };
    },
    async head(key) {
      calls.push(['head', key]);
      maybeFail();
      const object = objects.get(key);
      if (!object) throw notFound();
      return { status: 200, meta: Object.keys(object.meta).length ? { ...object.meta } : null, res: { headers: headersOf(object) } };
    },
    async getStream(key) {
      calls.push(['getStream', key]);
      maybeFail();
      const object = objects.get(key);
      if (!object) throw notFound();
      const chunks = [];
      for (let at = 0; at < object.body.length; at += 64 * 1024) chunks.push(object.body.subarray(at, at + 64 * 1024));
      return { stream: Readable.from(chunks), res: { status: 200, headers: headersOf(object) } };
    },
    async putStream(key, stream, putOptions = {}) {
      calls.push(['putStream', key, { contentLength: putOptions.contentLength, headers: { ...(putOptions.headers || {}) } }]);
      maybeFail();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const headers = putOptions.headers || {};
      store(key, Buffer.concat(chunks), { type: headers['Content-Type'], disposition: headers['Content-Disposition'] || null });
      return { name: key, res: { status: 200, headers: { etag: `"${objects.get(key).etag}"` } } };
    },
    async copy(dst, src, copyOptions = {}) {
      calls.push(['copy', dst, src, copyOptions]);
      maybeFail();
      const object = objects.get(src);
      if (!object) throw notFound();
      const headers = copyOptions.headers || {};
      store(dst, Buffer.from(object.body), {
        type: headers['Content-Type'] || object.type,
        disposition: headers['Content-Type'] ? headers['Content-Disposition'] || null : object.disposition,
        meta: copyOptions.meta || object.meta,
      });
      return { data: { etag: `"${objects.get(dst).etag}"`, lastModified: new Date().toISOString() }, res: { status: 200 } };
    },
    async delete(key) {
      calls.push(['delete', key]);
      maybeFail();
      objects.delete(key);
      return { res: { status: 204 } };
    },
    async deleteMulti(keys, deleteOptions) {
      calls.push(['deleteMulti', keys, deleteOptions]);
      maybeFail();
      // A key named "locked/..." is refused, the way a bucket policy would refuse it.
      const deleted = keys.filter(key => !key.startsWith('locked/'));
      for (const key of deleted) objects.delete(key);
      return { deleted: deleted.map(Key => ({ Key })), res: { status: 200 } };
    },
    async signatureUrlV4(method, expires, request, key) {
      calls.push(['signatureUrlV4', method, expires, key]);
      maybeFail();
      return `https://tcli-bucket.oss-cn-hangzhou.aliyuncs.com/${key.split('/').map(encodeURIComponent).join('/')}?x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-expires=${expires}&x-oss-signature=abc123`;
    },
  };
  return {
    client, objects, calls, options, store,
    createClient(given) { options.push(given); return client; },
    failWith(error) { failNext = error; },
  };
}

// A database with the one table the OSS services read.
function memoryDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  return db;
}

const CONFIG = { enabled: true, region: 'oss-cn-hangzhou', bucket: 'tcli-bucket', accessKeyId: KEY_ID, accessKeySecret: SECRET, prefix: 'uploads' };

module.exports = { createFakeOss, memoryDb, CONFIG, SECRET, KEY_ID };
