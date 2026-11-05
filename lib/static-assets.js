// Scripts and styles of the pages: content-hash URLs with a long cache, and brotli / gzip copies made once and kept in memory.
//
// - `rewritePage(html)` names every /js, /css and /vendor script or style of a page as `<path>?v=<hash of that file's content>`. A request whose `v`
//   is the file's current hash is answered with `Cache-Control: public, max-age=31536000, immutable`: the URL names content that can never change, and
//   any change to the file (a release, an update, a local edit) gives it a new URL in the next page. Any other request (no `v`, an old or a wrong one)
//   keeps `no-cache`, so it is revalidated with its ETag as before. The pages themselves stay `no-store`.
// - `precompressed` answers /js, /css and /vendor scripts and styles with a brotli (quality 11) or gzip (level 9) copy when the browser accepts one.
//   The copies are made in the background, one file at a time, the first time a file is asked for (or when a page names it), and are kept in memory
//   next to the file's size and modification time; until a copy is ready, the request falls through to the `compression` middleware (fast default
//   quality). Nothing is written to disk. Brotli at quality 11 is too slow to run on every request, which is why it is done once per file.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSET_URL = /(src|href)="(\/(?:js|css|vendor)\/[^"?#]+\.(?:js|css))"/g;
const ZH_DICTIONARY = /[ \t]*<script\b[^>]*\bsrc="\/js\/i18n-zh-[\w-]+\.js"[^>]*><\/script>[ \t]*\r?\n?/g;
const COMPRESSIBLE = /\.(?:js|mjs|css)$/i;
const LONG_CACHE = 'public, max-age=31536000, immutable';
const MIN_COMPRESS_BYTES = 1024;

function createStaticAssets({ publicDir, maxFileBytes = 8 * 1024 * 1024, maxCacheBytes = 48 * 1024 * 1024 } = {}) {
  const root = path.resolve(publicDir);
  const hashes = new Map(); // absolute path -> { mtimeMs, size, hash }
  const copies = new Map(); // absolute path -> { mtimeMs, size, br, gzip }
  const queue = [];
  const queued = new Set();
  let cacheBytes = 0;
  let working = false;

  const fileOf = urlPath => {
    let decoded;
    try { decoded = decodeURIComponent(urlPath); } catch { return null; }
    if (decoded.includes('\0') || decoded.split(/[\\/]/).includes('..')) return null;
    const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
    if (!file.startsWith(`${root}${path.sep}`)) return null;
    if (file.slice(root.length).split(path.sep).some(part => part.startsWith('.') && part.length > 1)) return null; // no dotfiles, like express.static
    return file;
  };
  const statFile = file => { try { const stat = fs.statSync(file); return stat.isFile() ? stat : null; } catch { return null; } };
  const same = (entry, stat) => entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;

  // The first 16 hex digits of the SHA-256 of the file's content; recomputed only when its size or modification time changes.
  function hashOf(file, stat = statFile(file)) {
    if (!stat) return null;
    const known = hashes.get(file);
    if (same(known, stat)) return known.hash;
    let hash;
    try { hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); } catch { return null; }
    hashes.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    return hash;
  }

  // `<path>?v=<hash>`, or the plain path when the file does not exist.
  function assetUrl(urlPath) {
    const file = fileOf(urlPath);
    const hash = file && hashOf(file);
    return hash ? `${urlPath}?v=${hash}` : urlPath;
  }

  // `zh`: the person reads the Chinese page (the `ta-lang=zh` cookie that public/js/i18n.js keeps); without it the Chinese dictionaries are left out
  // of the page, so English readers do not download them (i18n.js still fetches them itself if Chinese turns out to be wanted).
  function rewritePage(html, { zh = true } = {}) {
    if (!zh) html = html.replace(ZH_DICTIONARY, '');
    return html.replace(ASSET_URL, (all, attr, urlPath) => {
      const file = fileOf(urlPath);
      if (file && COMPRESSIBLE.test(file)) schedule(file);
      return `${attr}="${assetUrl(urlPath)}"`;
    });
  }

  // The Cache-Control of a static file: a long cache only when the request names the file's current content hash.
  function cacheControl(req, file) {
    const version = req && req.query ? req.query.v : undefined;
    if (typeof version === 'string' && /^[0-9a-f]{16}$/.test(version) && COMPRESSIBLE.test(file) && version === hashOf(file)) return LONG_CACHE;
    return 'no-cache';
  }
  const setHeaders = (res, file) => res.setHeader('Cache-Control', cacheControl(res.req, file));

  function schedule(file) {
    if (queued.has(file)) return;
    const stat = statFile(file);
    if (!stat || stat.size < MIN_COMPRESS_BYTES || stat.size > maxFileBytes || same(copies.get(file), stat)) return;
    queued.add(file);
    queue.push(file);
    if (!working) void work();
  }
  async function work() {
    working = true;
    while (queue.length) {
      const file = queue.shift();
      try {
        const stat = statFile(file);
        if (!stat || same(copies.get(file), stat)) continue;
        const raw = await fs.promises.readFile(file);
        const [br, gzip] = await Promise.all([
          new Promise((resolve, reject) => zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } }, (error, out) => (error ? reject(error) : resolve(out)))),
          new Promise((resolve, reject) => zlib.gzip(raw, { level: 9 }, (error, out) => (error ? reject(error) : resolve(out)))),
        ]);
        const after = statFile(file);
        if (!after || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) continue; // changed while it was being compressed: done again on the next request
        const old = copies.get(file);
        if (old) cacheBytes -= old.br.length + old.gzip.length;
        if (cacheBytes + br.length + gzip.length > maxCacheBytes) { copies.delete(file); continue; } // full: this file keeps the on-the-fly compression
        copies.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, br, gzip });
        cacheBytes += br.length + gzip.length;
      } catch { /* unreadable now: the compression middleware serves it */ } finally { queued.delete(file); }
    }
    working = false;
  }

  // The encoding to send: brotli when accepted, else gzip, else none. A coding given with q=0 is refused.
  function pickEncoding(header) {
    const accepted = new Map();
    for (const part of String(header || '').split(',')) {
      const [name, ...params] = part.trim().toLowerCase().split(';');
      if (!name) continue;
      const q = params.map(item => item.trim()).find(item => item.startsWith('q='));
      accepted.set(name, q ? Number(q.slice(2)) : 1);
    }
    const ok = name => (accepted.has(name) ? accepted.get(name) > 0 : accepted.has('*') && accepted.get('*') > 0);
    if (ok('br')) return 'br';
    if (ok('gzip')) return 'gzip';
    return null;
  }

  function precompressed(req, res, next) {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.headers.range) return next();
    const file = fileOf(`${req.baseUrl}${req.path}`);
    if (!file || !COMPRESSIBLE.test(file)) return next();
    const stat = statFile(file);
    if (!stat) return next();
    const encoding = pickEncoding(req.headers['accept-encoding']);
    if (!encoding) return next();
    const copy = copies.get(file);
    if (!same(copy, stat)) { schedule(file); return next(); }
    const body = copy[encoding];
    const hash = hashOf(file, stat);
    res.type(path.extname(file));
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', cacheControl(req, file));
    res.setHeader('ETag', `"${hash}-${encoding}"`);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    if (req.fresh) { res.removeHeader('Content-Type'); res.removeHeader('Content-Encoding'); res.statusCode = 304; return res.end(); }
    res.setHeader('Content-Length', body.length);
    return req.method === 'HEAD' ? res.end() : res.end(body);
  }

  // For tests: waits until every scheduled copy is made.
  async function idle() { while (working || queue.length) await new Promise(resolve => setTimeout(resolve, 10)); }

  return { assetUrl, rewritePage, cacheControl, setHeaders, precompressed, pickEncoding, hashOf, idle, LONG_CACHE };
}

// Whether a request comes from someone who reads the Chinese page (see rewritePage).
const wantsChinese = req => /(?:^|;\s*)ta-lang=zh(?:;|$)/.test(String((req && req.headers && req.headers.cookie) || ''));

module.exports = { createStaticAssets, wantsChinese };
