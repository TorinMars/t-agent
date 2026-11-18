// Scripts and styles of the pages: content-hash URLs with a long cache, one request for a run of small page scripts, and brotli / gzip copies made
// once and kept in memory.
//
// - `rewritePage(html)` names every /js, /css and /vendor script or style of a page as `<path>?v=<hash of that file's content>`. A request whose `v`
//   is the file's current hash is answered with `Cache-Control: public, max-age=31536000, immutable`: the URL names content that can never change, and
//   any change to the file (a release, an update, a local edit) gives it a new URL in the next page. Any other request (no `v`, an old or a wrong one)
//   keeps `no-cache`, so it is revalidated with its ETag as before. The pages themselves stay `no-store`.
// - Files the page loads later (the chat and mind map bundles, the Markdown renderer, mermaid, the chat's style sheet, the Chinese dictionaries of an
//   English page) get the same long cache: `rewritePage` puts a small inline script before the page's first style sheet with the hash of every script
//   and style under /js, /css and /vendor that the page does not load itself, and `window.TAAsset(path)`, which answers `<path>?v=<hash>`. Every
//   loader builds its URL through it and falls back to the plain path when it is not there (a page served without `rewritePage`, as most browser
//   tests do), which is revalidated each time as before.
// - Combined scripts: consecutive `<script defer src="/js/….js" data-combine></script>` tags of a page (two or more, nothing but white space between
//   them) become one tag, `/js/combined-<id>.js?v=<hash of the combined content>`, built in memory here and rebuilt when one of its files changes.
//   The combined script holds each file as a string and runs them in the page's order, each as a classic script element of its own
//   (`script.text = source`, appended to the head: the browser runs it at once). That keeps what separate tags give: the top-level `const` / `let` /
//   `function` of a file are global, a file's syntax error or exception is reported and the files after it still run, and a `'use strict'` stays
//   inside its file. `//# sourceURL=` names each part by its own address, so errors and the debugger show the file and its own line numbers.
//   Two things differ, so only files that are fine with them carry `data-combine`: `document.currentScript` is an element without `src` (its
//   `data-src` has the path), and the parts are inline scripts: if the page ever gets a `script-src` policy, it must allow them (today the page's
//   only policy is `frame-ancestors`). The files themselves are still served one by one, as before.
// - `precompressed` answers /js, /css and /vendor scripts and styles with a brotli (quality 11) or gzip (level 9) copy when the browser accepts one.
//   The copies are made in the background, one file at a time, the first time a file is asked for (or when a page names it), and are kept in memory
//   next to the file's size and modification time; until a copy is ready, the request falls through to the `compression` middleware (fast default
//   quality). Nothing is written to disk. Brotli at quality 11 is too slow to run on every request, which is why it is done once per file.
//   A combined script is answered here too (it is no file): its gzip copy is made when it is built, its brotli copy in the same background queue.
// - Chunks of the page's ES module bundles (scripts/build-page-bundles.js): `/js/chunks/<name>-<HASH>.js`, where HASH is esbuild's hash of the
//   content. The modules import each other by those plain names (no `?v=`), so a chunk name IS a content hash: they are cached for a year by name
//   (`isChunk`), and are left out of `window.TAAssets` (no loader builds their URL). For each `<script type="module" src="/js/….js">` of a page,
//   `rewritePage` puts a `<link rel="modulepreload">` before the tag for every chunk the module imports statically (followed through the chunks),
//   so the browser fetches them all at once instead of finding each only after the file that imports it has arrived.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSET_URL = /(src|href)="(\/(?:js|css|vendor)\/[^"?#]+\.(?:js|css))"/g;
const ZH_DICTIONARY = /[ \t]*<script\b[^>]*\bsrc="\/js\/i18n-zh-[\w-]+\.js"[^>]*><\/script>[ \t]*\r?\n?/g;
// A script that may go into a combined request: exactly this tag (a tag with anything else on it stays as it is), with the white space around it.
const COMBINE_TAG = /([ \t]*)<script defer src="(\/js\/[\w.-]+\.js)" data-combine><\/script>[ \t]*(\r?\n)?/g;
const COMBINED_URL = /^\/js\/combined-[0-9a-f]{12}\.js$/;
// Where the inline script with the hashes goes: before the first style sheet or script, so it never waits for a style sheet to load.
const FIRST_LOADED = /[ \t]*<(?:link\b[^>]*\brel="stylesheet"|script\b)/;
const ASSET_FOLDERS = ['js', 'css', 'vendor'];
const MAPPED_NAME = /^[\w.-]+$/;
const COMPRESSIBLE = /\.(?:js|mjs|css)$/i;
const CHUNK_DIR = 'chunks'; // under /js
const CHUNK_NAME = /^[\w.-]+-[A-Z0-9]{8}\.js$/; // esbuild's `[name]-[hash]`
// A module script of a page (exactly this tag, after the ?v= of rewritePage), and the static imports at the top of an ES module: `import{…}from"…";`,
// `import"…";` (minified as esbuild writes them; a dynamic `import(` is not one).
const MODULE_TAG = /([ \t]*)<script type="module" src="(\/js\/[\w.-]+\.js)(?:\?v=[0-9a-f]{16})?"><\/script>/g;
const STATIC_IMPORT = /\s*import(?!\s*\()\s*([^"';]*?)\s*["']([^"']+)["']\s*;?/y;
const LONG_CACHE = 'public, max-age=31536000, immutable';
const MIN_COMPRESS_BYTES = 1024;
const MAX_COMBINED = 16; // combined scripts remembered (a page has one per run of tags)
const LIST_TTL_MS = 5000; // how long the list of files under /js, /css and /vendor is kept (their hashes are checked on every page)

const sha16 = content => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

// The text of a combined script: the files as strings, run in order as script elements of their own (see the top of this file).
function combinedSource(parts) {
  const literal = source => JSON.stringify(source).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return [
    `// ${parts.length} scripts of the page in one request, put together by lib/static-assets.js: ${parts.map(part => part.urlPath.slice(4)).join(', ')}.`,
    '// Each runs as a classic script of its own, in this order: its top-level names are global, and an error in one does not stop the next.',
    '(function (parts) {',
    '  var parent = document.head || document.documentElement;',
    '  for (var i = 0; i < parts.length; i += 2) {',
    "    var script = document.createElement('script');",
    "    script.setAttribute('data-src', parts[i]);",
    "    script.text = parts[i + 1] + '\\n//# sourceURL=' + location.origin + parts[i];",
    '    parent.appendChild(script); // runs now',
    '    parent.removeChild(script);',
    '  }',
    '})([',
    parts.map(part => `${JSON.stringify(part.urlPath)},\n${literal(part.source)}`).join(',\n'),
    ']);',
    '',
  ].join('\n');
}

function createStaticAssets({ publicDir, maxFileBytes = 8 * 1024 * 1024, maxCacheBytes = 48 * 1024 * 1024, listTtlMs = LIST_TTL_MS } = {}) {
  const root = path.resolve(publicDir);
  const hashes = new Map(); // absolute path -> { mtimeMs, size, hash }
  const copies = new Map(); // absolute path -> { mtimeMs, size, br, gzip }
  const combined = new Map(); // '/js/combined-<id>.js' -> { urlPath, members: [{ urlPath, file }], build: { stamp, body, hash, mtime, gzip, br } }
  const queue = []; // files (absolute paths) and builds of combined scripts that wait for their copies
  const queued = new Set();
  let listed = null; // { at, paths }: the last listAssets()
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
  const chunkDir = path.join(root, 'js', CHUNK_DIR);
  // A chunk of an ES module bundle: its name carries the hash of its content (see the top of this file).
  const isChunk = file => path.dirname(file) === chunkDir && CHUNK_NAME.test(path.basename(file));
  const imported = new Map(); // absolute path -> { mtimeMs, size, urls }: the /js/ URLs a module imports statically

  // The first 16 hex digits of the SHA-256 of the file's content; recomputed only when its size or modification time changes.
  function hashOf(file, stat = statFile(file)) {
    if (!stat) return null;
    const known = hashes.get(file);
    if (same(known, stat)) return known.hash;
    let hash;
    try { hash = sha16(fs.readFileSync(file)); } catch { return null; }
    hashes.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    return hash;
  }

  // `<path>?v=<hash>`, or the plain path when the file does not exist.
  function assetUrl(urlPath) {
    const file = fileOf(urlPath);
    const hash = file && hashOf(file);
    return hash ? `${urlPath}?v=${hash}` : urlPath;
  }

  // The /js/ URL paths a module file imports statically (the import statements at its top), read again only when the file changed.
  function staticImports(file, stat = statFile(file)) {
    if (!stat) return [];
    const known = imported.get(file);
    if (same(known, stat)) return known.urls;
    let source = '';
    try { source = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const urls = [];
    STATIC_IMPORT.lastIndex = 0;
    for (let match = STATIC_IMPORT.exec(source); match; match = STATIC_IMPORT.exec(source)) if (/^\/js\/[\w./-]+\.js$/.test(match[2])) urls.push(match[2]);
    imported.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, urls });
    return urls;
  }

  // Every chunk a module script needs before it runs: its static imports, followed through the chunks, in the order they are found.
  function modulePreloads(urlPath) {
    const found = [];
    const seen = new Set([urlPath]);
    const visit = from => {
      const file = fileOf(from);
      for (const next of file ? staticImports(file) : []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const target = fileOf(next);
        if (!target || !isChunk(target) || !statFile(target)) continue; // only the bundles' own chunks, and only ones that exist
        found.push(next);
        visit(next);
      }
    };
    visit(urlPath);
    return found;
  }

  // A `<link rel="modulepreload">` for each chunk a module script of the page imports, right before its tag. The chunks are named and compressed like
  // the page's other files.
  function preloadModules(html, named) {
    return html.replace(MODULE_TAG, (tag, indent, urlPath) => {
      const links = modulePreloads(urlPath).map(chunk => {
        named.add(chunk);
        schedule(fileOf(chunk));
        return `${indent}<link rel="modulepreload" href="${chunk}">\n`;
      });
      return `${links.join('')}${tag}`;
    });
  }

  // The combined script of an entry, built again only when the size or modification time of one of its files changed. A file that is gone or cannot be
  // read is left out, as a script tag that fails to load would be.
  function buildOf(entry, stats = entry.members.map(member => statFile(member.file))) {
    const stamp = stats.map(stat => (stat ? `${stat.mtimeMs}:${stat.size}` : '-')).join('|');
    if (entry.build && entry.build.stamp === stamp) return entry.build;
    const parts = [];
    entry.members.forEach((member, index) => {
      if (!stats[index]) return;
      try { parts.push({ urlPath: member.urlPath, source: fs.readFileSync(member.file, 'utf8') }); } catch { /* unreadable now */ }
    });
    const body = Buffer.from(combinedSource(parts));
    const mtime = new Date(Math.max(0, ...stats.filter(Boolean).map(stat => stat.mtimeMs)));
    // gzip now (a few milliseconds), so there is a compressed answer from the first request; brotli in the background, like the files.
    entry.build = { stamp, body, hash: sha16(body), mtime, gzip: zlib.gzipSync(body, { level: 9 }), br: null };
    enqueue(entry.build);
    return entry.build;
  }

  // Runs of `data-combine` script tags become one tag each. `named` collects the paths of the files that went into one.
  function combineScripts(html, named) {
    const tags = [...html.matchAll(COMBINE_TAG)].map(match => {
      const file = fileOf(match[2]);
      const stat = file ? statFile(file) : null;
      return { start: match.index, end: match.index + match[0].length, indent: match[1], eol: match[3] || '', urlPath: match[2], file: stat ? file : null, stat };
    });
    let out = '';
    let at = 0;
    for (let first = 0; first < tags.length;) {
      let next = first;
      if (tags[first].file) { next += 1; while (next < tags.length && tags[next].file && tags[next].start === tags[next - 1].end) next += 1; }
      const run = tags.slice(first, next);
      first = Math.max(next, first + 1);
      if (run.length < 2) continue; // a single script, or a file that does not exist: the tag stays
      const id = crypto.createHash('sha256').update(run.map(tag => tag.urlPath).join('\n')).digest('hex').slice(0, 12);
      const urlPath = `/js/combined-${id}.js`;
      let entry = combined.get(urlPath);
      if (!entry) {
        entry = { urlPath, members: run.map(tag => ({ urlPath: tag.urlPath, file: tag.file })), build: null };
        combined.set(urlPath, entry);
        if (combined.size > MAX_COMBINED) combined.delete(combined.keys().next().value);
      }
      for (const tag of run) named.add(tag.urlPath);
      const { hash } = buildOf(entry, run.map(tag => tag.stat));
      out += `${html.slice(at, run[0].start)}${run[0].indent}<script defer src="${urlPath}?v=${hash}"></script>${run[run.length - 1].eol}`;
      at = run[run.length - 1].end;
    }
    return out + html.slice(at);
  }

  // Every script and style under /js, /css and /vendor, as URL paths in a fixed order. The list is kept for a few seconds: a file that was just added
  // is only missing from the page's hashes until then (it is asked for by its plain address, which is revalidated), and one that is gone has no hash.
  function listAssets() {
    if (listed && Date.now() - listed.at < listTtlMs) return listed.paths;
    const found = [];
    const walk = (dir, prefix) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!MAPPED_NAME.test(entry.name) || entry.name.startsWith('.')) continue;
        if (entry.isDirectory() && prefix === '/js' && entry.name === CHUNK_DIR) continue; // chunks are named by their hash already
        if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
        else if (entry.isFile() && COMPRESSIBLE.test(entry.name)) found.push(`${prefix}/${entry.name}`);
      }
    };
    for (const folder of ASSET_FOLDERS) walk(path.join(root, folder), `/${folder}`);
    listed = { at: Date.now(), paths: found.sort() };
    return listed.paths;
  }

  // The inline script with the hash of every script and style the page does not load itself (`named`: the ones it does), for what it loads later.
  function withAssetMap(html, named) {
    const map = {};
    for (const urlPath of listAssets()) {
      if (named.has(urlPath)) continue;
      const hash = hashOf(path.join(root, urlPath));
      if (hash) map[urlPath] = hash;
    }
    const at = html.search(FIRST_LOADED);
    if (at < 0 || !Object.keys(map).length) return html;
    const indent = /^[ \t]*/.exec(html.slice(at))[0];
    const script = `<script>window.TAAssets=${JSON.stringify(map).replace(/</g, '\\u003c')};window.TAAsset=function(p){var v=window.TAAssets[p];return typeof v==="string"?p+"?v="+v:p};</script>`;
    return `${html.slice(0, at)}${indent}${script}\n${html.slice(at)}`;
  }

  // `zh`: the person reads the Chinese page (the `ta-lang=zh` cookie that public/js/i18n.js keeps); without it the Chinese dictionaries are left out
  // of the page, so English readers do not download them (i18n.js still fetches them itself if Chinese turns out to be wanted).
  function rewritePage(html, { zh = true } = {}) {
    if (!zh) html = html.replace(ZH_DICTIONARY, '');
    const named = new Set();
    html = combineScripts(html, named);
    html = html.replace(ASSET_URL, (all, attr, urlPath) => {
      named.add(urlPath);
      const file = fileOf(urlPath);
      const stat = file ? statFile(file) : null; // read once, for the copy and for the hash
      if (!stat) return all; // a missing file keeps its plain URL
      if (COMPRESSIBLE.test(file)) schedule(file, stat);
      const hash = hashOf(file, stat);
      return hash ? `${attr}="${urlPath}?v=${hash}"` : all;
    });
    html = preloadModules(html, named);
    return withAssetMap(html, named);
  }

  // The Cache-Control of a static file: a long cache only when the request names the file's current content hash, or when the file is a chunk
  // (its name is the hash of its content).
  function cacheControl(req, file) {
    if (isChunk(file)) return LONG_CACHE;
    const version = req && req.query ? req.query.v : undefined;
    if (typeof version === 'string' && /^[0-9a-f]{16}$/.test(version) && COMPRESSIBLE.test(file) && version === hashOf(file)) return LONG_CACHE;
    return 'no-cache';
  }
  const setHeaders = (res, file) => res.setHeader('Cache-Control', cacheControl(res.req, file));

  function schedule(file, stat) {
    if (queued.has(file)) return;
    if (!stat) stat = statFile(file);
    if (!stat || stat.size < MIN_COMPRESS_BYTES || stat.size > maxFileBytes || same(copies.get(file), stat)) return;
    enqueue(file);
  }
  function enqueue(item) {
    queued.add(item);
    queue.push(item);
    if (!working) void work();
  }
  const brotli = raw => new Promise((resolve, reject) => zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } }, (error, out) => (error ? reject(error) : resolve(out))));
  async function compressFile(file) {
    const stat = statFile(file);
    if (!stat || same(copies.get(file), stat)) return;
    const raw = await fs.promises.readFile(file);
    const [br, gzip] = await Promise.all([
      brotli(raw),
      new Promise((resolve, reject) => zlib.gzip(raw, { level: 9 }, (error, out) => (error ? reject(error) : resolve(out)))),
    ]);
    const after = statFile(file);
    if (!after || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) return; // changed while it was being compressed: done again on the next request
    const old = copies.get(file);
    if (old) cacheBytes -= old.br.length + old.gzip.length;
    if (cacheBytes + br.length + gzip.length > maxCacheBytes) { copies.delete(file); return; } // full: this file keeps the on-the-fly compression
    copies.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, br, gzip });
    cacheBytes += br.length + gzip.length;
  }
  async function work() {
    working = true;
    while (queue.length) {
      const item = queue.shift();
      try {
        if (typeof item === 'string') await compressFile(item);
        else item.br = await brotli(item.body); // a build of a combined script (a later build is another object, with its own turn)
      } catch { /* unreadable now: the compression middleware serves it (a combined script keeps its gzip copy) */ } finally { queued.delete(item); }
    }
    working = false;
  }

  // The encoding to send: brotli when accepted, else gzip, else none. A coding given with q=0 is refused. `has(name)`: whether that copy exists.
  function pickEncoding(header, has = () => true) {
    const accepted = new Map();
    for (const part of String(header || '').split(',')) {
      const [name, ...params] = part.trim().toLowerCase().split(';');
      if (!name) continue;
      const q = params.map(item => item.trim()).find(item => item.startsWith('q='));
      accepted.set(name, q ? Number(q.slice(2)) : 1);
    }
    const ok = name => (accepted.has(name) ? accepted.get(name) > 0 : accepted.has('*') && accepted.get('*') > 0);
    if (ok('br') && has('br')) return 'br';
    if (ok('gzip') && has('gzip')) return 'gzip';
    return null;
  }

  // A combined script by its URL path: `{ body, hash, files }` (the current content, its hash, the paths of its files), or null when no page named it.
  function combinedScript(urlPath) {
    const entry = COMBINED_URL.test(urlPath) ? combined.get(urlPath) : null;
    if (!entry) return null;
    const build = buildOf(entry);
    return { body: build.body, hash: build.hash, files: entry.members.map(member => member.urlPath) };
  }

  function sendCombined(req, res, entry) {
    const build = buildOf(entry);
    const encoding = pickEncoding(req.headers['accept-encoding'], name => Boolean(build[name]));
    const body = encoding ? build[encoding] : build.body;
    const version = req.query ? req.query.v : undefined;
    res.type('.js');
    if (encoding) res.setHeader('Content-Encoding', encoding);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', typeof version === 'string' && version === build.hash ? LONG_CACHE : 'no-cache');
    res.setHeader('ETag', `"${build.hash}${encoding ? `-${encoding}` : ''}"`);
    res.setHeader('Last-Modified', build.mtime.toUTCString());
    if (req.fresh) { res.removeHeader('Content-Type'); res.removeHeader('Content-Encoding'); res.statusCode = 304; return res.end(); }
    res.setHeader('Content-Length', body.length);
    return req.method === 'HEAD' ? res.end() : res.end(body);
  }

  function precompressed(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const urlPath = `${req.baseUrl}${req.path}`;
    const entry = COMBINED_URL.test(urlPath) ? combined.get(urlPath) : null;
    if (entry) return sendCombined(req, res, entry);
    if (req.headers.range) return next();
    const file = fileOf(urlPath);
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

  return { assetUrl, rewritePage, cacheControl, setHeaders, precompressed, pickEncoding, hashOf, combinedScript, modulePreloads, idle, LONG_CACHE };
}

// Whether a request comes from someone who reads the Chinese page (see rewritePage).
const wantsChinese = req => /(?:^|;\s*)ta-lang=zh(?:;|$)/.test(String((req && req.headers && req.headers.cookie) || ''));

module.exports = { createStaticAssets, wantsChinese, combinedSource };
