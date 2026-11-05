// File path detection for terminal links (public/js/terminal-file-links.js): which text in a terminal line is a file link, what it points to, and
// whether it is inside the task's working directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const { findFileLinks, toRelative } = require('../public/js/terminal-file-links.js');

const found = line => findFileLinks(line).map(link => {
  const entry = { text: link.text, path: link.path };
  if (link.line) entry.line = link.line;
  if (link.column) entry.column = link.column;
  assert.equal(line.slice(link.index, link.index + link.length), link.text, 'index and length point at the link text');
  return entry;
});

test('relative, dot and absolute paths are found', () => {
  assert.deepEqual(found('edited src/app.js and ./docs/HANDOFF.md, then /abs/path/file.ts'), [
    { text: 'src/app.js', path: 'src/app.js' },
    { text: './docs/HANDOFF.md', path: './docs/HANDOFF.md' },
    { text: '/abs/path/file.ts', path: '/abs/path/file.ts' },
  ]);
  assert.deepEqual(found('../shared/util.js'), [{ text: '../shared/util.js', path: '../shared/util.js' }]);
  assert.deepEqual(found('see lib/'), [{ text: 'lib/', path: 'lib/' }], 'a folder with a trailing slash');
  assert.ok(findFileLinks('see lib/')[0].directory);
  assert.deepEqual(found('src/lib/parser'), [{ text: 'src/lib/parser', path: 'src/lib/parser' }], 'a path without an extension');
});

test('line and column suffixes', () => {
  assert.deepEqual(found('path/file.py:42'), [{ text: 'path/file.py:42', path: 'path/file.py', line: 42 }]);
  assert.deepEqual(found('path/file.py:42:7: error'), [{ text: 'path/file.py:42:7', path: 'path/file.py', line: 42, column: 7 }]);
  assert.deepEqual(found('at src/a.js:10:3.'), [{ text: 'src/a.js:10:3', path: 'src/a.js', line: 10, column: 3 }]);
  assert.deepEqual(found('src/a.js:42-50'), [{ text: 'src/a.js:42-50', path: 'src/a.js', line: 42 }], 'a line range opens at its first line');
  assert.deepEqual(found('src/a.js#L12'), [{ text: 'src/a.js#L12', path: 'src/a.js', line: 12 }]);
  assert.deepEqual(found('src/a.js#L12-L20'), [{ text: 'src/a.js#L12-L20', path: 'src/a.js', line: 12 }]);
  assert.deepEqual(found('app.js:0'), [{ text: 'app.js:0', path: 'app.js' }], 'line 0 is no line');
});

test('quotes, brackets and trailing punctuation are not part of the path', () => {
  assert.deepEqual(found('\u25cf Read(src/x.js)'), [{ text: 'src/x.js', path: 'src/x.js' }], 'Claude Code tool line');
  assert.deepEqual(found('\u23bf Update(docs/DESIGN.md:12)'), [{ text: 'docs/DESIGN.md:12', path: 'docs/DESIGN.md', line: 12 }]);
  assert.deepEqual(found('[the handoff](docs/HANDOFF.md)'), [{ text: 'docs/HANDOFF.md', path: 'docs/HANDOFF.md' }], 'markdown link');
  assert.deepEqual(found('"src/app.js" `lib/x.js` \'a/b.md\''), [
    { text: 'src/app.js', path: 'src/app.js' }, { text: 'lib/x.js', path: 'lib/x.js' }, { text: 'a/b.md', path: 'a/b.md' },
  ]);
  assert.deepEqual(found('<src/a.js> {src/b.js} [src/c.js]'), [
    { text: 'src/a.js', path: 'src/a.js' }, { text: 'src/b.js', path: 'src/b.js' }, { text: 'src/c.js', path: 'src/c.js' },
  ]);
  assert.deepEqual(found('Done: README.md, package.json; src/z.js! ok? src/y.js...'), [
    { text: 'README.md', path: 'README.md' }, { text: 'package.json', path: 'package.json' }, { text: 'src/z.js', path: 'src/z.js' }, { text: 'src/y.js', path: 'src/y.js' },
  ]);
  assert.deepEqual(found('mention @src/app.js'), [{ text: 'src/app.js', path: 'src/app.js' }]);
  assert.deepEqual(found("it's in a file's src/a.js"), [{ text: 'src/a.js', path: 'src/a.js' }], 'apostrophes are not quotes of a path');
});

test('spaces are part of a path only inside quotes', () => {
  assert.deepEqual(found('open "my notes/plan.md" now'), [{ text: 'my notes/plan.md', path: 'my notes/plan.md' }]);
  assert.deepEqual(found("open 'my notes/plan.md:3'"), [{ text: 'my notes/plan.md:3', path: 'my notes/plan.md', line: 3 }]);
  assert.deepEqual(found('open my notes/plan.md'), [{ text: 'notes/plan.md', path: 'notes/plan.md' }], 'unquoted, a space ends the path');
  assert.deepEqual(found('"just some words"'), [], 'quoted text that is no path');
});

test('Chinese file names and Chinese punctuation', () => {
  assert.deepEqual(found('\u6253\u5f00 docs/\u8bbe\u8ba1\u8bf4\u660e.md\uff1a\u7b2c3\u884c'), [{ text: 'docs/\u8bbe\u8ba1\u8bf4\u660e.md', path: 'docs/\u8bbe\u8ba1\u8bf4\u660e.md' }]);
  assert.deepEqual(found('\u5df2\u4fee\u6539\uff08src/\u6a21\u5757.js\uff09\u3002'), [{ text: 'src/\u6a21\u5757.js', path: 'src/\u6a21\u5757.js' }]);
  assert.deepEqual(found('\u300c\u7b14\u8bb0/\u8ba1\u5212.md\u300d'), [{ text: '\u7b14\u8bb0/\u8ba1\u5212.md', path: '\u7b14\u8bb0/\u8ba1\u5212.md' }]);
  assert.deepEqual(found('\u8bf7\u770b \u8bf4\u660e.md'), [{ text: '\u8bf4\u660e.md', path: '\u8bf4\u660e.md' }]);
});

test('URLs stay URLs; file:// URLs are file links', () => {
  assert.deepEqual(found('https://example.com/a/b.js and http://x.test/docs/README.md'), [], 'web links are left to the web links addon');
  assert.deepEqual(found('see https://github.com/o/r/blob/main/src/app.js.'), []);
  assert.deepEqual(found('file:///abs/my%20dir/a.md'), [{ text: 'file:///abs/my%20dir/a.md', path: '/abs/my dir/a.md' }]);
  assert.deepEqual(found('file://localhost/abs/a.md:9'), [{ text: 'file://localhost/abs/a.md:9', path: '/abs/a.md', line: 9 }]);
  assert.deepEqual(found('file://other-host/abs/a.md'), [], 'a file on another host');
  assert.deepEqual(found('ssh://git@host/repo.git mailto:me@x.test'), []);
});

test('text that is no path', () => {
  for (const line of ['e.g. this', 'example.com', 'github.com/owner/repo', 'www.example.org/page.html', '2026/11/05', '1/2', 'v2.87.10',
    '/', '.', '..', './', '~/notes.md', 'C:\\dir\\a.txt', 'origin:main', 'HEAD:src/a.js', 'a//b.js', '//cdn.test/x.js', 'version.10', 'Mr.Smith']) {
    assert.deepEqual(found(line), [], line);
  }
});

test('toRelative keeps paths inside the working directory', () => {
  const root = '/work/proj';
  assert.equal(toRelative('src/app.js', root), 'src/app.js');
  assert.equal(toRelative('./src/../lib/a.js', root), 'lib/a.js');
  assert.equal(toRelative('/work/proj/src/app.js', root), 'src/app.js');
  assert.equal(toRelative('/work/proj/src/', root), 'src');
  assert.equal(toRelative('/work/proj', root), '', 'the root itself');
  assert.equal(toRelative('/work/proj/a.js', '/work/proj/'), 'a.js', 'a root with a trailing slash');
  assert.equal(toRelative('docs/\u8bbe\u8ba1.md', root), 'docs/\u8bbe\u8ba1.md');
  assert.equal(toRelative('/work/project2/a.js', root), null, 'a sibling folder with the same prefix');
  assert.equal(toRelative('/etc/hosts', root), null);
  assert.equal(toRelative('../outside.md', root), null);
  assert.equal(toRelative('src/../../outside.md', root), null);
  assert.equal(toRelative('/work/proj/../other/a.js', root), null);
  assert.equal(toRelative('/abs/a.js', null), null, 'absolute paths need a known root');
  assert.equal(toRelative('src/a.js', null), 'src/a.js', 'relative paths are resolved by the server');
});

test('parseOsc7 reads the directory of an OSC 7 report', () => {
  const { parseOsc7 } = require('../public/js/terminal-file-links.js');
  assert.equal(parseOsc7('file://mac.local/Users/me/proj'), '/Users/me/proj', 'any host: the shell names the Engine machine');
  assert.equal(parseOsc7('file:///work/proj/'), '/work/proj', 'no host, trailing slash dropped');
  assert.equal(parseOsc7('file://localhost/work/my%20dir'), '/work/my dir', 'percent escapes are decoded');
  assert.equal(parseOsc7('file://h/work/%E8%AE%BE%E8%AE%A1/%E6%96%87%E6%A1%A3'), '/work/设计/文档', 'UTF-8 Chinese folder names');
  assert.equal(parseOsc7('file://h/work/设计'), '/work/设计', 'unescaped Chinese is kept');
  assert.equal(parseOsc7('FILE://h/a/./b/../c'), '/a/c', 'dot parts are folded');
  assert.equal(parseOsc7('file://h/'), '/');
  for (const bad of ['', null, undefined, '/work/proj', 'file://hostonly', 'http://h/work', 'file://h/work/%E8%AE', 'file://h/a%0Ab', 'file://h/a\\b',
    `file://h/${'a'.repeat(1100)}`, 'kitty-shell-cwd://h/work']) {
    assert.equal(parseOsc7(bad), null, String(bad));
  }
});

test('resolvePath takes relative paths from the live directory and keeps the root as the limit', () => {
  const { resolvePath } = require('../public/js/terminal-file-links.js');
  const root = '/work/proj';
  assert.equal(resolvePath('a.js', root, '/work/proj/sub'), 'sub/a.js');
  assert.equal(resolvePath('../b.js', root, '/work/proj/sub'), 'b.js');
  assert.equal(resolvePath('./x/设计.md', root, '/work/proj/子/'), '子/x/设计.md');
  assert.equal(resolvePath('a.js', root, null), 'a.js', 'unknown cwd: the root');
  assert.equal(resolvePath('a.js', root, '/elsewhere'), null, 'a cwd outside the root');
  assert.equal(resolvePath('../../c.js', root, '/work/proj/sub'), null, 'climbing past the root');
  assert.equal(resolvePath('/work/proj/d.js', root, '/elsewhere'), 'd.js', 'absolute paths do not use the cwd');
  assert.equal(resolvePath('/etc/hosts', root, '/work/proj'), null);
});

// A headless xterm gives the real parser (BEL and ST terminators, split writes) and buffer; the link provider is captured instead of rendered.
function headlessTerm() {
  const { Terminal } = require('@xterm/headless');
  const real = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
  let provider = null;
  const term = { parser: real.parser, buffer: real.buffer, registerLinkProvider(p) { provider = p; return { dispose() { provider = null; } }; } };
  const write = data => new Promise(resolve => real.write(data, resolve));
  const links = row => new Promise(resolve => provider.provideLinks(row, resolve));
  return { real, term, write, links, provider: () => provider };
}

test('attach tracks the OSC 7 directory with BEL and ST terminators and resolves links from it', async () => {
  const { attach } = require('../public/js/terminal-file-links.js');
  const { real, term, write, links } = headlessTerm();
  const activated = [];
  let asked = 0;
  const handle = attach(term, { root: () => '/work/proj', liveCwd: async () => { asked += 1; return { cwd: '/work/proj', relative: '' }; }, activate: link => activated.push(link) });
  assert.equal(handle.cwd(), null);
  await write('\x1b]7;file://host/work/proj/sub\x07');
  assert.equal(handle.cwd(), '/work/proj/sub', 'BEL');
  await write('\x1b]7;file://host/work/proj/%E5%AD%90\x1b\\');
  assert.equal(handle.cwd(), '/work/proj/子', 'ST');
  await write('\x1b]7;not a url\x07');
  assert.equal(handle.cwd(), '/work/proj/子', 'a bad report keeps the last directory');
  await write('\x1b]7;file://host/work/');
  await write('proj/sub/deep\x07');
  assert.equal(handle.cwd(), '/work/proj/sub/deep', 'a report split over two writes');
  await write('\x1b]7;file://host/work/proj/sub\x07see a.js\r\n');
  const [link] = await links(1);
  assert.equal(link.text, 'a.js');
  link.activate({});
  assert.equal(activated[0].relative, 'sub/a.js');
  assert.equal(await activated[0].resolve(), 'sub/a.js');
  assert.equal(asked, 0, 'a reported directory needs no request');
  await write('\x1b]7;file://host/elsewhere\x07');
  assert.equal(await links(1), undefined, 'a cwd outside the root: relative paths are no links');
  handle.resetCwd();
  assert.equal(handle.cwd(), null);
  handle.dispose();
  await write('\x1b]7;file://host/work/proj/sub\x07');
  assert.equal(handle.cwd(), null, 'disposed: no more tracking');
  real.dispose();
});

test('without an OSC 7 report a link asks the server for the live directory', async () => {
  const { attach } = require('../public/js/terminal-file-links.js');
  const { real, term, write, links } = headlessTerm();
  let live = { cwd: '/real/work/proj/sub', relative: 'sub' };
  const activated = [];
  attach(term, { root: () => '/work/proj', liveCwd: async () => (live instanceof Error ? Promise.reject(live) : live), activate: link => activated.push(link) });
  await write('src/a.js /work/proj/b.js\r\n');
  const found = await links(1);
  found.forEach(link => link.activate({}));
  const [relative, absolute] = activated;
  assert.equal(relative.relative, 'src/a.js', 'while hovering: the work dir');
  assert.equal(await relative.resolve(), 'sub/src/a.js', 'activated: the server directory');
  assert.equal(await absolute.resolve(), 'b.js', 'absolute paths ask nothing');
  live = { cwd: '/real/work/proj', relative: '' };
  assert.equal(await relative.resolve(), 'src/a.js');
  live = { cwd: '/elsewhere', relative: null };
  assert.equal(await relative.resolve(), null, 'the shell is outside the root: open nothing');
  live = { cwd: null, relative: null };
  assert.equal(await relative.resolve(), 'src/a.js', 'no shell: the work dir');
  live = null;
  assert.equal(await relative.resolve(), 'src/a.js', 'an older Engine: the work dir');
  live = new Error('offline');
  assert.equal(await relative.resolve(), 'src/a.js', 'a failed request: the work dir');
  live = { cwd: '/real/work/proj/sub', relative: 'sub' };
  await write('../../up.js\r\n');
  const [up] = await links(2) || [];
  assert.equal(up, undefined, 'past the root from the work dir: no link');
  real.dispose();
});
