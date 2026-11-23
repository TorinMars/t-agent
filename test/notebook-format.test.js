// The file side of Shell notebooks (lib/notebook-format.js): the output normaliser, reading and writing .ipynb files (also ones Jupyter made), slugs
// and the safe paths of notebook files. Only temporary folders are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const format = require('../lib/notebook-format');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-notebook-format-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const lines = (text, options) => format.normaliseText(text, options).lines;

test('output: line ends, a bare \\r overwrites the line, \\b deletes one character', () => {
  assert.deepEqual(lines('one\r\ntwo\nthree'), ['one', 'two', 'three']);
  assert.deepEqual(lines('Downloading 10%\rDownloading 55%\rDownloading 100%\r\ndone\r\n'), ['Downloading 100%', 'done']);
  assert.deepEqual(lines('long text\rshort'), ['shorttext'], 'later text overwrites, the rest stays (as a terminal shows it)');
  assert.deepEqual(lines('abc\b\bX\n'), ['aX'], 'each \\b at the end deletes one character');
  assert.deepEqual(lines('abcd\r12\bZ\n'), ['1Zcd'], 'a \\b in the middle of an overwritten line moves back one place');
  assert.deepEqual(lines('abc\b\n'), ['ab'], 'a \\b at the end deletes the character');
  assert.deepEqual(lines('spin |\b/\b-\b\\\n'), ['spin \\']);
  assert.deepEqual(lines('a\n\nb\n'), ['a', '', 'b'], 'empty lines in the middle are kept');
  assert.deepEqual(lines('tab\there\n'), ['tab\there'], 'a tab is kept');
});

test('output: SGR colours are kept, every other escape sequence and control character is dropped', () => {
  assert.deepEqual(lines('\x1b[1;31mred\x1b[0m plain\n'), ['\x1b[1;31mred\x1b[0m plain']);
  assert.deepEqual(lines('\x1b[38;5;208m256\x1b[38;2;10;20;30mtrue\x1b[0m\n'), ['\x1b[38;5;208m256\x1b[38;2;10;20;30mtrue\x1b[0m']);
  assert.deepEqual(lines('a\x1b[2Jb\x1b[10;5Hc\x1b[?25ld\x1b[?2004he\n'), ['abcde'], 'other CSI sequences are dropped');
  assert.deepEqual(lines('x\x1b]0;window title\x07y\x1b]8;;https://example.com\x1b\\z\n'), ['xyz'], 'OSC with BEL or ST is dropped');
  assert.deepEqual(lines('p\x1bPdcs data\x1b\\q\x1b(Br\x1b=s\x1b7t\n'), ['pqrst'], 'DCS, charset and two-byte escapes are dropped');
  assert.deepEqual(lines('bell\x07\x00\x0e\x7f!\n'), ['bell!'], 'other control characters are dropped');
  assert.deepEqual(lines('progress 99%\r\x1b[Kok\n'), ['ok'], 'ESC [ K erases the rest of the line');
  assert.deepEqual(lines('\u4e2d\u6587 \ud83d\ude00 ok\n'), ['\u4e2d\u6587 \ud83d\ude00 ok'], 'any script and emoji');
});

test('output: sequences split across chunks', () => {
  const out = format.createOutput();
  for (const part of ['a\x1b', '[3', '1mred\x1b]0;ti', 'tle\x07\x1b', '[0m\r', '\nnext \ud83d', '\ude00\n']) out.write(part);
  out.finish();
  assert.deepEqual(out.view(), ['a\x1b[31mred\x1b[0m', 'next \ud83d\ude00']);
});

test('output: long lines wrap at 4000 characters, and only the last lines and bytes are kept', () => {
  const wrapped = lines(`${'x'.repeat(9000)}\n`);
  assert.deepEqual(wrapped.map(line => line.length), [4000, 4000, 1000]);
  const many = format.normaliseText(Array.from({ length: 10050 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(many.lines.length, 10000);
  assert.equal(many.dropped, 50);
  assert.equal(many.lines[0], 'line 50');
  const big = format.normaliseText(`${'y'.repeat(1000)}\n`.repeat(3000));
  assert.ok(big.lines.reduce((sum, line) => sum + line.length + 1, 0) <= format.MAX_OUTPUT_BYTES, 'at most 2 MB');
  assert.equal(big.lines.length + big.dropped, 3000);
  const small = format.normaliseText('a\nb\nc\nd\n', { maxLines: 2 });
  assert.deepEqual([small.lines, small.dropped], [['c', 'd'], 2]);
});

test('output changes: from the first changed line; everything after lines were cut from the front', () => {
  const out = format.createOutput({ maxLines: 3 });
  out.write('one\ntwo');
  assert.deepEqual(out.takeChange(), { from: 0, lines: ['one', 'two'] });
  assert.equal(out.takeChange(), null, 'nothing new');
  out.write(' more\nthree\n');
  assert.deepEqual(out.takeChange(), { from: 1, lines: ['two more', 'three'] });
  out.write('50%\r100%');
  assert.deepEqual(out.takeChange(), { from: 3, lines: ['100%'] });
  assert.equal(out.partial, true);
  out.write('\nfour\n');
  assert.equal(out.cutSinceTake, true);
  assert.deepEqual(out.takeChange(), { from: 0, lines: ['three', '100%', 'four'] });
  assert.equal(out.dropped, 2);
});

test('a file Jupyter made: array sources, ids missing, other outputs, raw cells, unknown fields; written back as nbformat 4.5', () => {
  const jupyter = {
    nbformat: 4, nbformat_minor: 2,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, authors: ['someone'] },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Title\n', 'text'] },
      { cell_type: 'code', execution_count: 7, metadata: { collapsed: false }, source: ['ls\n', 'echo hi'], outputs: [
        { output_type: 'stream', name: 'stdout', text: ['a.txt\n', 'b.txt\n'] },
        { output_type: 'execute_result', execution_count: 7, data: { 'text/plain': ['42'] }, metadata: {} },
        { output_type: 'display_data', data: { 'image/png': 'iVBOR', 'text/plain': ['<Figure>'] }, metadata: {} },
        { output_type: 'error', ename: 'E', evalue: 'bad', traceback: ['\x1b[31mTraceback\x1b[0m', 'line 1'] },
      ], custom_field: { kept: true } },
      { cell_type: 'raw', metadata: {}, source: 'raw text' },
      { cell_type: 'code', id: 'same', metadata: {}, source: '', outputs: [], execution_count: null },
      { cell_type: 'code', id: 'same', metadata: {}, source: 'dup', outputs: [], execution_count: null },
    ],
  };
  const nb = format.parseNotebook(JSON.stringify(jupyter));
  assert.equal(nb.cells.length, 5);
  assert.ok(nb.cells.every(cell => /^[a-zA-Z0-9_-]{1,64}$/.test(cell.id)), 'every cell has an id');
  assert.equal(new Set(nb.cells.map(cell => cell.id)).size, 5, 'a repeated id is replaced');
  assert.deepEqual(nb.cells.map(cell => cell.type), ['markdown', 'code', 'markdown', 'code', 'code'], 'raw is shown as markdown');
  assert.equal(nb.cells[0].source, '# Title\ntext');
  const code = nb.cells[1];
  assert.equal(code.source, 'ls\necho hi');
  assert.equal(code.count, 7);
  assert.equal(code.state, 'done');
  assert.deepEqual(code.lines, ['a.txt', 'b.txt', '42', '<Figure>', '\x1b[31mTraceback\x1b[0m', 'line 1']);

  const written = JSON.parse(format.serializeNotebook(nb));
  assert.equal(written.nbformat, 4);
  assert.equal(written.nbformat_minor, 5);
  assert.deepEqual(written.metadata.kernelspec, { name: 'bash', display_name: 'Bash', language: 'bash' });
  assert.deepEqual(written.metadata.language_info, { name: 'bash' });
  assert.deepEqual(written.metadata.authors, ['someone'], 'other notebook metadata is kept');
  assert.deepEqual(written.cells[1].custom_field, { kept: true }, 'unknown cell fields are kept');
  assert.deepEqual(written.cells[1].metadata, { collapsed: false }, 'a cell that did not run here gets no metadata of ours');
  assert.equal(written.cells[1].outputs.length, 4, 'outputs of a cell that did not run here are kept as they were (pictures too)');
  assert.equal(written.cells[2].cell_type, 'raw', 'a raw cell stays raw');
  assert.deepEqual(written.cells[0].source, ['# Title\n', 'text']);
  assert.equal(written.cells[0].outputs, undefined);
  assert.equal(written.cells[3].execution_count, null);
  assert.deepEqual(written.cells[3].source, []);

  // A cell that ran here: one stream output with the normalised lines, and our metadata.
  Object.assign(nb.cells[3], { source: 'echo x', count: 1, state: 'failed', exit: 2, duration_ms: 15, started_at: 1000, ended_at: 1015, lines: ['\x1b[32mx\x1b[0m', 'y'], dropped: 3 });
  const again = format.parseNotebook(format.serializeNotebook(nb));
  const cell = again.cells[3];
  assert.deepEqual([cell.count, cell.state, cell.exit, cell.duration_ms, cell.started_at, cell.ended_at, cell.dropped], [1, 'failed', 2, 15, 1000, 1015, 3]);
  assert.deepEqual(cell.lines, ['\x1b[32mx\x1b[0m', 'y']);
  const raw = JSON.parse(format.serializeNotebook(nb)).cells[3];
  assert.deepEqual(raw.outputs, [{ output_type: 'stream', name: 'stdout', text: ['\x1b[32mx\x1b[0m\n', 'y\n'] }]);
  assert.equal(raw.metadata['t-agent'].state, 'failed');
});

test('a cell saved while it ran reads back as interrupted; bad files are refused', () => {
  const nb = format.emptyNotebook();
  Object.assign(nb.cells[0], { state: 'running', count: 1, started_at: 5, lines: ['half'] });
  assert.equal(format.parseNotebook(format.serializeNotebook(nb)).cells[0].state, 'interrupted');
  assert.equal(format.parseNotebook('').cells.length, 1, 'an empty file is a new notebook');
  for (const bad of ['{not json', '[]', JSON.stringify({ nbformat: 3, worksheets: [] }), JSON.stringify({ nbformat: 4 })]) {
    assert.throws(() => format.parseNotebook(bad), error => error.message === 'NOTEBOOK_FILE_UNREADABLE' && error.statusCode === 422);
  }
  const huge = path.join(root, 'huge.ipynb');
  fs.writeFileSync(huge, '');
  fs.truncateSync(huge, format.MAX_FILE_BYTES + 1);
  assert.throws(() => format.readNotebookFile(huge), error => error.message === 'NOTEBOOK_TOO_LARGE' && error.statusCode === 413);
});

test('writing is atomic and ends with a newline; the text is 2-space JSON with sorted keys', () => {
  const file = path.join(root, 'atomic', 'nb.ipynb');
  format.writeFileAtomic(file, format.serializeNotebook(format.emptyNotebook()));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.match(text, /^\{\n  "cells": \[/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['nb.ipynb'], 'no temporary file is left');
});

test('slugs keep any script and replace unsafe characters', () => {
  assert.equal(format.notebookSlug('Release check'), 'Release-check');
  assert.equal(format.notebookSlug('  a/b\\c:d*e?f"g<h>i|j  '), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(format.notebookSlug('\u53d1\u5e03 \u68c0\u67e5'), '\u53d1\u5e03-\u68c0\u67e5');
  assert.equal(format.notebookSlug('..hidden'), 'hidden');
  assert.equal(format.notebookSlug(''), 'notebook');
  assert.equal(format.notebookSlug('???'), 'notebook');
  assert.equal(Array.from(format.notebookSlug('\u4e2d'.repeat(80))).length, 60);
});

test('notebook paths stay in the folder, also through symbolic links; new files are numbered', () => {
  const folder = path.join(root, 'task');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(folder, 'notebooks'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.ipynb'), '');
  fs.writeFileSync(path.join(folder, 'top.ipynb'), '');
  fs.symlinkSync(path.join(outside, 'secret.ipynb'), path.join(folder, 'notebooks', 'link.ipynb'));
  fs.symlinkSync(outside, path.join(folder, 'away'));
  const refused = value => assert.throws(() => format.resolveNotebookPath(folder, value), error => error.message === 'INVALID_NOTEBOOK_PATH' && error.statusCode === 400, String(value));
  for (const value of ['../outside/secret.ipynb', path.join(outside, 'secret.ipynb'), 'notebooks/link.ipynb', 'away/secret.ipynb', 'top.txt', 'missing.ipynb', '', null, 'notebooks/../../outside/secret.ipynb']) refused(value);
  assert.equal(format.resolveNotebookPath(folder, './top.ipynb').relative, 'top.ipynb');
  assert.throws(() => format.resolveNotebookPath(path.join(root, 'nope'), 'x.ipynb'), error => error.message === 'TASK_HAS_NO_FOLDER');

  const first = format.createNotebookFile(folder, 'Daily check');
  const second = format.createNotebookFile(folder, 'Daily check');
  const plain = format.createNotebookFile(folder, '');
  assert.deepEqual([first.relative, second.relative, plain.relative], ['notebooks/Daily-check.ipynb', 'notebooks/Daily-check-2.ipynb', 'notebooks/notebook.ipynb']);
  const made = format.parseNotebook(fs.readFileSync(first.file, 'utf8'));
  assert.deepEqual(made.cells.map(cell => [cell.type, cell.source]), [['code', '']], 'one empty code cell');

  fs.utimesSync(path.join(folder, 'top.ipynb'), new Date(1000), new Date(1000));
  const listed = format.listNotebookFiles(folder);
  assert.deepEqual(listed.map(row => row.id).sort(), ['notebooks/Daily-check-2.ipynb', 'notebooks/Daily-check.ipynb', 'notebooks/notebook.ipynb', 'top.ipynb'], 'the link out of the folder is not listed');
  assert.equal(listed[listed.length - 1].id, 'top.ipynb', 'newest first');
  assert.deepEqual(Object.keys(listed[0]).sort(), ['id', 'title', 'updated_at']);
  assert.equal(listed.find(row => row.id === 'top.ipynb').title, 'top');
  assert.equal(format.notebookFolder({ work_dir: null, md_path: '/a/b/task.md' }, null), '/a/b');
  assert.equal(format.notebookFolder({ work_dir: '/w' }, { work_dir: '/own' }), '/own');
  assert.equal(format.notebookFolder({ work_dir: null, md_path: null }, null), null);
});
