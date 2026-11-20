// The page's ES module bundles (scripts/build-page-bundles.js): public/js/h5-shell.js and public/js/agent-chat-ui.js with their chunks in
// public/js/chunks. What the first screen downloads stays small, the screens that open on demand are not part of it, React and highlight.js exist
// once, and lib/static-assets.js preloads and caches the chunks by name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStaticAssets } = require('../lib/static-assets');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const CHUNKS = path.join(PUBLIC, 'js', 'chunks');
const LONG = 'public, max-age=31536000, immutable';
const read = urlPath => fs.readFileSync(path.join(PUBLIC, urlPath), 'utf8');
// The /js/ URLs a module imports: statically (import … from "…" / import "…") and dynamically (import("…")).
const importsOf = source => ({
  statics: [...source.matchAll(/(?:^|;)\s*import\s*(?:[^"'();]*?from\s*)?"(\/js\/[^"]+)"/g)].map(match => match[1]),
  dynamics: [...source.matchAll(/\bimport\("(\/js\/[^"]+)"\)/g)].map(match => match[1]),
});
// The files a module needs before it runs: itself and its static imports, followed through.
function eagerFiles(urlPath) {
  const seen = new Set();
  const visit = url => { if (seen.has(url)) return; seen.add(url); importsOf(read(url)).statics.forEach(visit); };
  visit(urlPath);
  return [...seen];
}

test('the first screen loads the shell and a few chunks, much less than the old single bundle, without the screens that open on demand', () => {
  const eager = eagerFiles('/js/h5-shell.js');
  assert.ok(eager.length <= 4, `the shell and at most three chunks: ${eager}`);
  const bytes = eager.reduce((sum, url) => sum + fs.statSync(path.join(PUBLIC, url)).size, 0);
  // The single bundle was 1,067 KB (2026-11-18); the split moved Settings, T-Attention, the design and file sheets into chunks of their own.
  assert.ok(bytes < 760 * 1024, `the first screen is ${bytes} bytes`);
  const text = eager.map(read).join('\n');
  for (const [marker, screen] of [['h5-usage-layout', 'the Usage data group'], ['.MuiSwitch-switchBase,.MuiCheckbox-root', 'the usage data recorder'], ['h5-settings-tabs', 'Settings'], ['h5-attention-reject', 'the T-Attention panel'], ['h5-design-outline', 'the design sheet'], ['h5-files-tree', 'the file tree'], ['registerAttentionSettings needs', 'the T-Attention settings slots'], ['h5-learn-pool', 'the Learn page']]) {
    assert.ok(!text.includes(marker), `${screen} is not in the first download`);
  }
  // React (react-dom) is there once, in a chunk; the chat imports the same chunk.
  const reactDom = eager.filter(url => read(url).includes('__reactContainer'));
  assert.equal(reactDom.length, 1, 'react-dom is in one file of the first download');
  assert.match(reactDom[0], /^\/js\/chunks\//);
  assert.ok(eagerFiles('/js/agent-chat-ui.js').includes(reactDom[0]), 'the chat takes React from the same chunk');
});

test('React and highlight.js exist once among the bundles, and every chunk on disk belongs to the current build', () => {
  const files = ['/js/h5-shell.js', '/js/agent-chat-ui.js', ...fs.readdirSync(CHUNKS).map(name => `/js/chunks/${name}`)];
  const holding = marker => files.filter(url => read(url).includes(marker));
  assert.equal(holding('__reactContainer').length, 1, 'one react-dom');
  const hljs = holding('Falling back to no-highlight mode');
  assert.equal(hljs.length, 1, 'one highlight.js, shared by the chat and the design sheet');
  assert.ok(eagerFiles('/js/agent-chat-ui.js').includes(hljs[0]), 'the chat imports it');
  assert.ok(!eagerFiles('/js/h5-shell.js').includes(hljs[0]), 'the first screen does not');
  // Every chunk is reached from an entry (no file of an older build was left behind), and every chunk a module names exists.
  const reached = new Set();
  const visit = url => {
    if (reached.has(url)) return;
    assert.ok(fs.existsSync(path.join(PUBLIC, url)), `${url} exists`);
    reached.add(url);
    const { statics, dynamics } = importsOf(read(url));
    [...statics, ...dynamics].forEach(visit);
  };
  visit('/js/h5-shell.js');
  visit('/js/agent-chat-ui.js');
  assert.deepEqual(files.filter(url => !reached.has(url)), [], 'no stale chunk');
  for (const url of files.slice(2)) assert.match(url, /^\/js\/chunks\/[\w.-]+-[A-Z0-9]{8}\.js$/, `${url} is named by its hash`);
  // The screens (and the Recent tab of the task list) are chunks the shell imports when they open; usage-recorder is the recorder of usage data (usage-track.mjs), loaded when recording is on;
  // key-feedback is the haptic tick and the key bubble of the page's own keyboard (Osk.jsx), loaded at the first key press.
  const dynamic = new Set(files.flatMap(url => importsOf(read(url)).dynamics).map(url => url.replace(/-[A-Z0-9]{8}\.js$/, '').replace('/js/chunks/', '')));
  assert.deepEqual([...dynamic].sort(), ['key-feedback', 'markdown-view-entry', 'screen-attention', 'screen-design', 'screen-files', 'screen-learn', 'screen-recent', 'screen-settings', 'screen-switcher', 'screen-task-dialog', 'usage-recorder']);
});

test('shell-core.mjs names every module entry.jsx imports, so the first screen stays in one shared chunk', () => {
  const dir = path.join(ROOT, 'scripts', 'h5-shell');
  const specifiers = source => [...source.matchAll(/^import\s+(?:[^'";]*?\s+from\s+)?'([^']+)';/gm)].map(match => match[1]);
  const core = new Set(specifiers(fs.readFileSync(path.join(dir, 'shell-core.mjs'), 'utf8')));
  const entry = specifiers(fs.readFileSync(path.join(dir, 'entry.jsx'), 'utf8'));
  assert.ok(entry.length > 5);
  assert.deepEqual(entry.filter(name => !core.has(name)), []);
  for (const name of fs.readdirSync(dir).filter(file => /^screen-.*\.jsx$/.test(file))) {
    assert.match(fs.readFileSync(path.join(dir, name), 'utf8'), /^import '\.\/shell-core\.mjs';$/m, `${name} imports shell-core.mjs`);
  }
});

test('a module script of a page gets a modulepreload link for each chunk it imports; chunks are cached for a year by name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-chunks-'));
  try {
    const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), content); };
    write('js/app.js', 'import{a as x}from"/js/chunks/chunk-AAAAAAAA.js";import"/js/chunks/chunk-BBBBBBBB.js";console.log(x);const later=()=>import("/js/chunks/lazy-CCCCCCCC.js");');
    write('js/chunks/chunk-AAAAAAAA.js', 'import"/js/chunks/chunk-DDDDDDDD.js";export const a=1;');
    write('js/chunks/chunk-BBBBBBBB.js', 'import"/js/chunks/chunk-DDDDDDDD.js";');
    write('js/chunks/chunk-DDDDDDDD.js', 'export const d=1;');
    write('js/chunks/lazy-CCCCCCCC.js', 'export default 1;');
    write('js/chunks/notes.js', 'console.log("no hash in the name");');
    write('js/lazy-ui.js', 'console.log("lazy");');
    const page = '<html><head><style></style>\n<link rel="stylesheet" href="/css/x.css"></head><body>\n  <script type="module" src="/js/app.js"></script>\n  <script defer src="/js/other.js"></script>\n</body></html>';
    const assets = createStaticAssets({ publicDir: dir, listTtlMs: 0 });
    const html = assets.rewritePage(page);
    const links = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(match => match[1]);
    assert.deepEqual(links, ['/js/chunks/chunk-AAAAAAAA.js', '/js/chunks/chunk-DDDDDDDD.js', '/js/chunks/chunk-BBBBBBBB.js'], 'the static imports, followed through, each once; not the dynamic import');
    assert.ok(html.indexOf('chunk-BBBBBBBB') < html.indexOf('<script type="module" src="/js/app.js?v='), 'before the module script, which carries its hash');
    assert.match(html, /<body>\n {2}<link rel="modulepreload" href="\/js\/chunks\/chunk-AAAAAAAA\.js">\n {2}<link rel="modulepreload" href="\/js\/chunks\/chunk-DDDDDDDD\.js">\n {2}<link rel="modulepreload" href="\/js\/chunks\/chunk-BBBBBBBB\.js">\n {2}<script type="module"/, 'with the indent of its tag');
    const map = JSON.parse(/window\.TAAssets=(\{[^;<]*\});/.exec(html)[1]);
    assert.deepEqual(Object.keys(map), ['/js/lazy-ui.js'], 'chunks are not among the hashes a loader uses');
    const chunk = name => path.join(dir, 'js', 'chunks', name);
    assert.equal(assets.cacheControl({ query: {} }, chunk('chunk-AAAAAAAA.js')), LONG, 'a chunk is cached for a year by its name');
    assert.equal(assets.cacheControl({ query: {} }, chunk('notes.js')), 'no-cache', 'a file without a hash in its name is not');
    assert.equal(assets.cacheControl({ query: {} }, path.join(dir, 'js', 'chunk-AAAAAAAA.js')), 'no-cache', 'nor a hashed-looking name outside the chunks folder');
    assert.deepEqual(assets.modulePreloads('/js/other.js'), [], 'a missing module has none');
    // A chunk that is gone is not preloaded (the import fails as it would without the link).
    fs.rmSync(chunk('chunk-BBBBBBBB.js'));
    assert.deepEqual(assets.modulePreloads('/js/app.js'), ['/js/chunks/chunk-AAAAAAAA.js', '/js/chunks/chunk-DDDDDDDD.js']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
