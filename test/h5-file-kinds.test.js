// How the file sheet reads and shows a file (scripts/h5-shell/file-kinds.mjs, file-formats.mjs) and the line splitting of highlighted code
// (file-view.mjs splitHighlighted, with the highlight.js the page bundles into public/js/markdown-view.js).
const test = require('node:test');
const assert = require('node:assert/strict');

test('kindOf names the kind of a file by its extension or name, case-insensitive', async () => {
  const { kindOf, RAW_KINDS } = await import('../scripts/h5-shell/file-kinds.mjs');
  const cases = {
    'README.md': 'markdown', 'docs/Guide.MDX': 'markdown',
    'a.png': 'image', 'b.JPEG': 'image', 'c.svg': 'image', 'icons/favicon.ico': 'image', 'd.avif': 'image', 'e.bmp': 'image', 'f.webp': 'image',
    'paper.PDF': 'pdf', 'song.mp3': 'audio', 'voice.m4a': 'audio', 'x.flac': 'audio', 'y.opus': 'audio',
    'clip.mp4': 'video', 'clip.MOV': 'video', 'clip.webm': 'video',
    'package.json': 'json', 'tsconfig.jsonc': 'json', 'map.geojson': 'json', '.babelrc': 'json', 'cfg/.eslintrc': 'json',
    'data.csv': 'csv', 'data.TSV': 'csv', 'index.html': 'html', 'old.htm': 'html',
    'app.js': 'code', 'main.py': 'code', 'Dockerfile': 'code', 'notes.txt': 'code', 'no-extension': 'code', 'archive.zip': 'code',
    '/abs/path/to/photo.jpg': 'image', '~/x.pdf': 'pdf', '\u56fe\u7247.png': 'image',
  };
  for (const [file, kind] of Object.entries(cases)) assert.equal(kindOf(file), kind, file);
  assert.equal(kindOf('.png'), 'code', 'a dot file named like an extension is not an image');
  assert.equal(kindOf(''), 'code');
  assert.deepEqual([...RAW_KINDS].sort(), ['audio', 'pdf', 'video']);
});

test('languageOf picks the highlight.js language by extension or file name', async () => {
  const { languageOf } = await import('../scripts/h5-shell/file-kinds.mjs');
  const cases = {
    'a.js': 'javascript', 'a.mjs': 'javascript', 'a.cjs': 'javascript', 'a.jsx': 'javascript', 'a.ts': 'typescript', 'a.tsx': 'typescript',
    'a.py': 'python', 'run.sh': 'bash', 'main.go': 'go', 'lib.rs': 'rust', 'A.java': 'java', 'x.c': 'c', 'x.h': 'c', 'x.cpp': 'cpp',
    'x.rb': 'ruby', 'x.php': 'php', 'x.css': 'css', 'x.scss': 'scss', 'x.yaml': 'yaml', 'x.yml': 'yaml', 'x.toml': 'ini', 'x.ini': 'ini',
    'x.sql': 'sql', 'x.xml': 'xml', 'App.vue': 'xml', 'x.swift': 'swift', 'x.kt': 'kotlin', 'x.json': 'json', 'x.html': 'xml',
    Dockerfile: 'dockerfile', 'Dockerfile.dev': 'dockerfile', 'api.dockerfile': 'dockerfile', Makefile: 'makefile', GNUmakefile: 'makefile',
    '.env': 'bash', '.env.local': 'bash', 'Gemfile': 'ruby', 'src/deep/PATH.PY': 'python',
  };
  for (const [file, language] of Object.entries(cases)) assert.equal(languageOf(file), language, file);
  assert.equal(languageOf('notes.txt'), null, 'plain text');
  assert.equal(languageOf('LICENSE'), null);
});

test('every language languageOf names is bundled in markdown-view.js', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'markdown-view.js'), 'utf8');
  const sandbox = {};
  vm.runInNewContext(`${source};this.MarkdownView = MarkdownView;`, sandbox);
  const { languageOf } = await import('../scripts/h5-shell/file-kinds.mjs');
  const files = ['a.js', 'a.ts', 'a.py', 'a.sh', 'a.go', 'a.rs', 'a.java', 'a.kt', 'a.swift', 'a.c', 'a.cpp', 'a.cs', 'a.m', 'a.rb', 'a.php', 'a.pl', 'a.lua', 'a.r',
    'a.css', 'a.scss', 'a.less', 'a.json', 'a.yaml', 'a.toml', 'a.sql', 'a.xml', 'a.md', 'a.diff', 'a.graphql', 'Makefile', 'Dockerfile', 'nginx.conf', 'a.vb'];
  for (const file of files) assert.equal(typeof sandbox.MarkdownView.highlight('x', languageOf(file)), 'string', file);
  assert.equal(sandbox.MarkdownView.highlight('x', 'no-such-language'), null);
  assert.equal(sandbox.MarkdownView.highlight('x', null), null);
});

test('highlighted HTML is split into lines that are each complete, with spans across lines closed and opened again', async () => {
  const { splitHighlighted, splitLines } = await import('../scripts/h5-shell/file-view.mjs');
  const html = '<span class="hljs-comment">/* one\ntwo\nthree */</span>\n<span class="hljs-keyword">const</span> a = <span class="hljs-string">`x\n<span class="hljs-subst">${b}</span>\n`</span>;\n';
  assert.deepEqual(splitHighlighted(html), [
    '<span class="hljs-comment">/* one</span>',
    '<span class="hljs-comment">two</span>',
    '<span class="hljs-comment">three */</span>',
    '<span class="hljs-keyword">const</span> a = <span class="hljs-string">`x</span>',
    '<span class="hljs-string"><span class="hljs-subst">${b}</span></span>',
    '<span class="hljs-string">`</span>;',
  ]);
  assert.deepEqual(splitHighlighted(''), ['']);
  assert.deepEqual(splitHighlighted('a\n\n'), ['a', ''], 'one empty last line is dropped, as splitLines does');
  assert.deepEqual(splitHighlighted('&lt;b&gt; &amp;'), ['&lt;b&gt; &amp;'], 'escaped text is kept as it is');

  // With the real highlighter: as many lines as splitLines gives, and the text of each line is the source line.
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const sandbox = {};
  vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'markdown-view.js'), 'utf8')};this.MarkdownView = MarkdownView;`, sandbox);
  const decode = text => text.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const samples = {
    javascript: 'const s = `a\n${1 + 2}\nb`;\n/* block\n comment */\nfunction f() { return "<x>"; }\n',
    python: 'def f():\n    """Doc\n    string"""\n    return 1  # \u4e2d\u6587\n',
    xml: '<!-- a\nb -->\n<div class="x">\n  <p>Hi &amp; bye</p>\n</div>',
  };
  for (const [language, source] of Object.entries(samples)) {
    const lines = splitHighlighted(sandbox.MarkdownView.highlight(source, language));
    const plain = splitLines(source);
    assert.equal(lines.length, plain.length, language);
    lines.forEach((line, i) => {
      assert.equal(decode(line), plain[i], `${language} line ${i + 1}`);
      assert.equal((line.match(/<span\b/g) || []).length, (line.match(/<\/span>/g) || []).length, `${language} line ${i + 1} is balanced`);
    });
  }
});

test('formatJson indents valid JSON, keeps every token as written, and refuses what is not JSON', async () => {
  const { formatJson, JSON_FORMAT_LIMIT } = await import('../scripts/h5-shell/file-formats.mjs');
  assert.equal(formatJson('{"a":1,"b":[true,null,{"c":"x, y: {z}"}],"e":{},"f":[]}'),
    '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    {\n      "c": "x, y: {z}"\n    }\n  ],\n  "e": {},\n  "f": []\n}\n');
  assert.equal(formatJson('{"big": 12345678901234567890, "esc": "a\\"b\\\\", "u": "\\u4e2d"}'),
    '{\n  "big": 12345678901234567890,\n  "esc": "a\\"b\\\\",\n  "u": "\\u4e2d"\n}\n', 'big numbers and escapes are not changed');
  assert.equal(formatJson('\ufeff [ 1 , 2 ] '), '[\n  1,\n  2\n]\n', 'a BOM and spaces');
  assert.equal(formatJson('"just a string"'), '"just a string"\n');
  assert.equal(formatJson('{"name": "\u4e2d\u6587"}', 4), '{\n    "name": "\u4e2d\u6587"\n}\n');
  assert.equal(formatJson('{ "a": [ ] }'), '{\n  "a": []\n}\n');
  assert.equal(formatJson('{"a": 1, // comment\n}'), null, 'JSONC with comments is shown as it is');
  assert.equal(formatJson('{a: 1}'), null);
  assert.equal(formatJson(''), null);
  assert.equal(formatJson(`[${'1,'.repeat(JSON_FORMAT_LIMIT / 2)}1]`), null, 'too large');
});

test('parseDelimited reads CSV with quotes, embedded separators and line ends, and TSV', async () => {
  const { parseDelimited, separatorOf } = await import('../scripts/h5-shell/file-formats.mjs');
  assert.deepEqual(parseDelimited('a,b,c\n1,2,3\n').rows, [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parseDelimited('name,note\r\n"Smith, J","said ""hi""\r\nthen left"\r\nx,\r\n').rows,
    [['name', 'note'], ['Smith, J', 'said "hi"\r\nthen left'], ['x', '']]);
  assert.deepEqual(parseDelimited('\ufeffa,b\n,\n"",""').rows, [['a', 'b'], ['', ''], ['', '']], 'a BOM, empty fields, no last line end');
  assert.deepEqual(parseDelimited('a\n\nb\n').rows, [['a'], ['b']], 'an empty line is no row');
  assert.deepEqual(parseDelimited('a\rb').rows, [['a'], ['b']], 'old Mac line ends');
  assert.deepEqual(parseDelimited('k\tv\n"x\ty"\t2\n\u4e2d\t\u6587\n', '\t').rows, [['k', 'v'], ['x\ty', '2'], ['\u4e2d', '\u6587']]);
  assert.deepEqual(parseDelimited('a,"b\nc').rows, [['a', 'b\nc']], 'an unclosed quote runs to the end');
  const many = parseDelimited(Array.from({ length: 5000 }, (_, i) => `r${i},${i}`).join('\n'), ',', 2001);
  assert.equal(many.rows.length, 2001);
  assert.equal(many.total, 5000);
  assert.deepEqual(many.rows[2000], ['r2000', '2000']);
  assert.equal(separatorOf('x/data.TSV'), '\t');
  assert.equal(separatorOf('data.csv'), ',');
});
