// Objects of the bucket configured in "Image and file upload" (services/oss-images.js), for `tcli oss` in agent sessions (routes/tcli.js) and for
// linked services (/v1/oss/files). Keys are relative to the bucket root (the upload prefix is not added). The AccessKey secret stays in the
// ali-oss client made by oss-images.js: no answer, error or log line of this module holds it, and upstream error messages are never passed on
// (only the OSS error code, such as AccessDenied). See "tcli (agent command line)" in DESIGN.md.
const { Transform, pipeline } = require('stream');
const { createOssImages, fileType, ACTIVE_TYPE } = require('./oss-images');

const KEY_BYTES = 1023;
const MAX_PUT_BYTES = 1024 * 1024 * 1024; // one PutObject from a stream (ali-oss multipart needs a file or buffer, not a stream)
const MAX_GET_BYTES = 2 * 1024 * 1024 * 1024;
const LIST_DEFAULT = 100;
const LIST_MAX = 1000;
const REMOVE_MAX = 1000;
const SIGN_DEFAULT = 3600;
const SIGN_MIN = 60;
const SIGN_MAX = 7 * 24 * 3600; // the longest an OSS V4 signed URL may be valid
const UPLOAD_LINK_SECONDS = 3600;
const META_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 6 * 60 * 60 * 1000; // ali-oss's own limit for one transfer; tcli itself waits without a limit
const SIGN_METHODS = new Set(['GET', 'HEAD']);

// Codes of this module and of the routes in front of it (routes/tcli.js): [status, message]. A linked service's answer with one of these codes
// passes through unchanged.
const ERRORS = {
  OSS_NOT_CONFIGURED: [409, 'OSS is not set up on this engine; configure "Image and file upload" in Settings'],
  OSS_AGENT_ACCESS_OFF: [403, 'OSS access for agent sessions is turned off on this engine'],
  INVALID_KEY: [400, 'Invalid object key'],
  INVALID_ARGUMENT: [400, 'Invalid argument'],
  CONFIRM_REQUIRED: [400, 'Removing objects needs "confirm": true'],
  LENGTH_REQUIRED: [411, 'The upload needs a Content-Length header'],
  INCOMPLETE_BODY: [400, 'The upload ended before the announced size'],
  NOT_FOUND: [404, 'The object does not exist'],
  TOO_LARGE: [413, 'The object is too large'],
  OSS_FILES_UNSUPPORTED: [501, 'The linked service that provides OSS is too old for tcli; update it first'],
  OSS_REQUEST_FAILED: [502, 'The OSS request failed'],
  LINKED_PROVIDER_OFFLINE: [502, 'The linked service that provides OSS cannot be reached'],
  LINKED_PROVIDER_UNAUTHORIZED: [502, 'The linked service that provides OSS did not accept the token of this engine'],
};

class OssFilesError extends Error {
  constructor(code, message) {
    super(message || ERRORS[code][1]);
    this.name = 'OssFilesError';
    this.code = code;
    this.statusCode = ERRORS[code][0];
    this.ossCode = null;
  }
}

// { status, body: { error, message, oss_code? } } for any error; an unknown one is a 502 with no detail.
function errorBody(error) {
  const known = error instanceof OssFilesError ? error : new OssFilesError('OSS_REQUEST_FAILED');
  return { status: known.statusCode, body: { error: known.code, message: known.message, ...(known.ossCode ? { oss_code: known.ossCode } : {}) } };
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// The rules of a key (and, without the empty and trailing rules, of a prefix or marker): 1 to 1023 bytes of well-formed UTF-8, no leading '/',
// no '..' segment, no control characters.
function checkPath(value, { what = 'key', empty = false } = {}) {
  const code = /key$/.test(what) ? 'INVALID_KEY' : 'INVALID_ARGUMENT';
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new OssFilesError(code, `The ${what} must be text`);
  if (!value) {
    if (empty) return '';
    throw new OssFilesError(code, `The ${what} is empty`);
  }
  if (Buffer.byteLength(value, 'utf8') > KEY_BYTES) throw new OssFilesError(code, `The ${what} is longer than ${KEY_BYTES} bytes`);
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw new OssFilesError(code, `The ${what} is not valid UTF-8`);
  if (CONTROL.test(value)) throw new OssFilesError(code, `The ${what} contains control characters`);
  if (value.startsWith('/')) throw new OssFilesError(code, `The ${what} must not start with "/" (keys are relative to the bucket root)`);
  if (value.split('/').includes('..')) throw new OssFilesError(code, `The ${what} must not contain ".." segments`);
  return value;
}
const checkKey = key => checkPath(key);

function wholeNumber(value, { name, min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new OssFilesError('INVALID_ARGUMENT', `${name} must be a whole number from ${min} to ${max}`);
  return number;
}

const etagOf = value => (typeof value === 'string' ? value.replace(/^"|"$/g, '') : null);
const mediaType = value => String(value || '').split(';')[0].trim().toLowerCase();
const isoDate = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
// A key as a URL path: every segment percent-encoded, the slashes kept.
const encodeKey = key => key.split('/').map(part => encodeURIComponent(part)).join('/');

// An error of the SDK or the network, as one of ours. Only the OSS error code (letters and digits) is kept, never the message: messages of
// some OSS errors repeat the request, including the AccessKey ID and the string that was signed.
function upstream(error) {
  if (error instanceof OssFilesError) return error;
  const code = error && typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.code) ? error.code : null;
  if (code !== 'NoSuchBucket' && (code === 'NoSuchKey' || (error && error.status === 404))) return new OssFilesError('NOT_FOUND');
  const failed = new OssFilesError('OSS_REQUEST_FAILED', code ? `The OSS request failed (${code})` : undefined);
  failed.ossCode = code;
  return failed;
}

function createOssFiles({ db, sessionSecret, createClient, images } = {}) {
  const store = images || createOssImages({ db, sessionSecret, ...(createClient ? { createClient } : {}) });

  function open(owner) {
    const opened = store.openClient(owner);
    if (!opened) throw new OssFilesError('OSS_NOT_CONFIGURED');
    return opened;
  }
  async function call(run) {
    try { return await run(); } catch (error) { throw upstream(error); }
  }
  const publicLink = (opened, key) => (opened.publicBaseUrl ? `${opened.publicBaseUrl}/${encodeKey(key)}` : null);
  async function signed(opened, key, expires, method = 'GET') {
    const url = await call(() => opened.client.signatureUrlV4(method, expires, {}, key));
    if (typeof url !== 'string' || CONTROL.test(url) || new URL(url).protocol !== 'https:') throw new OssFilesError('OSS_REQUEST_FAILED', 'OSS gave no valid signed URL');
    return url;
  }
  // The address of an object: the public address when one is set, else a signed URL valid for an hour.
  async function linkOf(opened, key) {
    const url = publicLink(opened, key);
    if (url) return { url, url_expires_at: null };
    return { url: await signed(opened, key, UPLOAD_LINK_SECONDS), url_expires_at: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000).toISOString() };
  }
  async function head(opened, key) {
    const result = await call(() => opened.client.head(key, { timeout: META_TIMEOUT_MS }));
    const headers = (result && result.res && result.res.headers) || {};
    return { headers, meta: (result && result.meta) || {} };
  }

  const api = {
    isConfigured(owner) { return store.isConfigured(owner); },

    async list(owner, { prefix, delimiter = '/', marker, max } = {}) {
      const wantedPrefix = checkPath(prefix, { what: 'prefix', empty: true });
      const wantedMarker = checkPath(marker, { what: 'marker', empty: true });
      if (delimiter === undefined || delimiter === null) delimiter = '/';
      if (delimiter !== '' && delimiter !== '/') throw new OssFilesError('INVALID_ARGUMENT', 'delimiter must be "/" or empty');
      const maxKeys = wholeNumber(max, { name: 'max', min: 1, max: LIST_MAX, fallback: LIST_DEFAULT });
      const opened = open(owner);
      const query = { 'max-keys': maxKeys };
      if (wantedPrefix) query.prefix = wantedPrefix;
      if (delimiter) query.delimiter = delimiter;
      if (wantedMarker) query.marker = wantedMarker;
      const result = await call(() => opened.client.list(query, { timeout: META_TIMEOUT_MS }));
      return {
        objects: ((result && result.objects) || []).map(object => ({
          key: object.name, size: Number(object.size) || 0, last_modified: isoDate(object.lastModified), etag: etagOf(object.etag), storage_class: object.storageClass || null,
        })),
        prefixes: ((result && result.prefixes) || []).filter(item => typeof item === 'string'),
        next_marker: (result && result.nextMarker) || null,
        truncated: Boolean(result && result.isTruncated),
      };
    },

    async stat(owner, key) {
      checkKey(key);
      const opened = open(owner);
      const { headers, meta } = await head(opened, key);
      return {
        key, size: Number(headers['content-length']) || 0, last_modified: isoDate(headers['last-modified']), etag: etagOf(headers.etag),
        content_type: headers['content-type'] || null, content_disposition: headers['content-disposition'] || null, meta,
      };
    },

    // { stream, size, content_type, etag, last_modified }: the caller pipes the stream and destroys it when its own side goes away.
    async get(owner, key) {
      checkKey(key);
      const opened = open(owner);
      const result = await call(() => opened.client.getStream(key, { timeout: TRANSFER_TIMEOUT_MS }));
      const headers = (result.res && result.res.headers) || {};
      const size = headers['content-length'] === undefined ? null : Number(headers['content-length']);
      if (size !== null && size > MAX_GET_BYTES) {
        result.stream.destroy();
        throw new OssFilesError('TOO_LARGE', 'Objects over 2 GiB cannot be downloaded with tcli');
      }
      return {
        stream: result.stream, size, content_type: headers['content-type'] || 'application/octet-stream',
        etag: etagOf(headers.etag), last_modified: headers['last-modified'] || null,
      };
    },

    // Streams `stream` to the object. `size` (when known) must match the bytes that arrive; without it at most MAX_PUT_BYTES are taken.
    async put(owner, key, stream, { size, contentType, contentDisposition } = {}) {
      checkKey(key);
      const known = size !== undefined && size !== null;
      if (known && (!Number.isSafeInteger(size) || size < 0)) throw new OssFilesError('INVALID_ARGUMENT', 'size must be a whole number');
      if (known && size > MAX_PUT_BYTES) throw new OssFilesError('TOO_LARGE', 'tcli uploads at most 1 GiB per object');
      if (contentDisposition !== undefined && contentDisposition !== null
        && (typeof contentDisposition !== 'string' || contentDisposition.length > 1024 || /[^\x20-\x7e]/.test(contentDisposition))) {
        throw new OssFilesError('INVALID_ARGUMENT', 'Invalid content disposition');
      }
      const opened = open(owner);
      // A type a browser would run or render as a page from the bucket's domain is stored as plain bytes, as for the page's uploads.
      const mime = fileType(contentType);
      const limit = known ? size : MAX_PUT_BYTES;
      let bytes = 0;
      let failure = null;
      const counter = new Transform({
        transform(chunk, encoding, done) {
          bytes += chunk.length;
          if (bytes > limit) {
            failure = known ? new OssFilesError('INVALID_ARGUMENT', 'The upload is longer than the announced size') : new OssFilesError('TOO_LARGE', 'tcli uploads at most 1 GiB per object');
            return done(failure);
          }
          done(null, chunk);
        },
        flush(done) {
          if (known && bytes !== size) { failure = new OssFilesError('INCOMPLETE_BODY'); return done(failure); }
          done();
        },
      });
      // A source that fails (the caller went away) is an incomplete upload; the counter closed by the SDK is the SDK's own error, kept below.
      pipeline(stream, counter, error => {
        if (error && !failure && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') failure = new OssFilesError('INCOMPLETE_BODY');
      });
      const headers = { 'Content-Type': mime };
      if (contentDisposition) headers['Content-Disposition'] = contentDisposition;
      let result;
      try {
        result = await opened.client.putStream(key, counter, { ...(known && size > 0 ? { contentLength: size } : {}), headers, timeout: TRANSFER_TIMEOUT_MS });
      } catch (error) {
        throw failure || upstream(error);
      }
      if (failure) throw failure;
      const answerHeaders = (result && result.res && result.res.headers) || {};
      return { key, etag: etagOf(answerHeaders.etag), size: bytes, content_type: mime, ...(await linkOf(opened, key)) };
    },

    async copy(owner, src, dst) {
      checkPath(src, { what: 'source key' });
      checkPath(dst, { what: 'destination key' });
      if (src === dst) throw new OssFilesError('INVALID_ARGUMENT', 'The source and the destination are the same');
      const opened = open(owner);
      const { headers, meta } = await head(opened, src);
      const options = { timeout: META_TIMEOUT_MS };
      // An object stored with an active type before (not by tcli) gets plain bytes in its copy, so a copy never makes a new page URL.
      if (ACTIVE_TYPE.test(mediaType(headers['content-type']))) {
        options.headers = { 'Content-Type': 'application/octet-stream', ...(headers['content-disposition'] ? { 'Content-Disposition': headers['content-disposition'] } : {}) };
        options.meta = meta;
      }
      const result = await call(() => opened.client.copy(dst, src, options));
      return { src, dst, etag: etagOf(result && result.data && result.data.etag) };
    },

    async move(owner, src, dst) {
      const copied = await api.copy(owner, src, dst);
      const opened = open(owner);
      await call(() => opened.client.delete(src, { timeout: META_TIMEOUT_MS }));
      return { ...copied, moved: true };
    },

    // { deleted: [key], failed: [key] }: OSS also reports a key that did not exist as deleted.
    async remove(owner, keys) {
      if (!Array.isArray(keys) || keys.length < 1 || keys.length > REMOVE_MAX) throw new OssFilesError('INVALID_ARGUMENT', `keys must list 1 to ${REMOVE_MAX} keys`);
      const wanted = [...new Set(keys.map(key => checkKey(key)))];
      const opened = open(owner);
      const result = await call(() => opened.client.deleteMulti(wanted, { quiet: false, timeout: META_TIMEOUT_MS }));
      const gone = new Set(((result && result.deleted) || []).map(item => (item && typeof item === 'object' ? item.Key : item)).filter(item => typeof item === 'string'));
      return { deleted: wanted.filter(key => gone.has(key)), failed: wanted.filter(key => !gone.has(key)) };
    },

    async sign(owner, key, { expires, method } = {}) {
      checkKey(key);
      const seconds = wholeNumber(expires, { name: 'expires', min: SIGN_MIN, max: SIGN_MAX, fallback: SIGN_DEFAULT });
      const verb = method === undefined || method === null || method === '' ? 'GET' : String(method).toUpperCase();
      // Only reads: a signed PUT would let anyone holding it store any type, past the active-content rule.
      if (!SIGN_METHODS.has(verb)) throw new OssFilesError('INVALID_ARGUMENT', 'method must be GET or HEAD');
      const opened = open(owner);
      const url = await signed(opened, key, seconds, verb);
      return { key, method: verb, url, expires_at: new Date(Date.now() + seconds * 1000).toISOString() };
    },

    // The public address of an object, or null when no public address is set.
    publicUrl(owner, key) {
      checkKey(key);
      return { key, url: publicLink(open(owner), key) };
    },
  };
  return api;
}

let shared = null;
function ossFiles() {
  if (!shared) shared = createOssFiles({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  return shared;
}

module.exports = {
  createOssFiles, ossFiles, OssFilesError, ERRORS, errorBody, checkKey, encodeKey,
  MAX_PUT_BYTES, MAX_GET_BYTES, LIST_MAX, REMOVE_MAX, SIGN_MIN, SIGN_MAX,
};
