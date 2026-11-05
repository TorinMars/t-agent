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
