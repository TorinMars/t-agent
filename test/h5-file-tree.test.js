// The data side of the read-only file tree (scripts/h5-shell/file-tree.mjs): list addresses, pages with "Load more", notes for empty folders and errors.
// Chinese file names are written with \u escapes (see test/i18n.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/file-tree.mjs');
const DESIGN = '\u8bbe\u8ba1.md'; // a Chinese file name

test('list addresses: the root has no path, other folders are encoded, the offset is always sent', async () => {
  const { ROOT_ID, listUrl } = await load();
  assert.equal(listUrl('/api/tasks/1/files', ROOT_ID), '/api/tasks/1/files?offset=0');
  assert.equal(listUrl('/api/tasks/1/files', 'docs/a b', 200), '/api/tasks/1/files?path=docs%2Fa%20b&offset=200');
  assert.equal(listUrl('/api/remote-servers/7/tasks/5/files', `docs/${DESIGN}`), `/api/remote-servers/7/tasks/5/files?path=${encodeURIComponent(`docs/${DESIGN}`)}&offset=0`);
});

test('entries become items keyed by their path; folders, files and the rest', async () => {
  const { entryItem } = await load();
  assert.deepEqual(entryItem({ name: 'src', path: 'src', type: 'directory' }), { id: 'src', data: { kind: 'dir', name: 'src', path: 'src', link: false } });
  assert.deepEqual(entryItem({ name: DESIGN, path: `docs/${DESIGN}`, type: 'file' }).data, { kind: 'file', name: DESIGN, path: `docs/${DESIGN}`, link: false });
  assert.deepEqual(entryItem({ name: 'l', path: 'l', type: 'symlink' }).data, { kind: 'other', name: 'l', path: 'l', link: true });
  assert.equal(entryItem({ name: 'p', path: 'p', type: 'other' }).data.kind, 'other');
});

test('pages: a "Load more" row while there are more, replaced by the next page; no entry twice', async () => {
  const { ROOT_ID, mergePage, moreId } = await load();
  const first = mergePage(ROOT_ID, { entries: [{ name: 'a', path: 'a', type: 'directory' }, { name: 'b', path: 'b', type: 'file' }], nextOffset: 2 });
  assert.deepEqual(first.map(child => child.id), ['a', 'b', moreId(ROOT_ID)]);
  assert.deepEqual(first[2].data, { kind: 'more', parent: ROOT_ID, offset: 2 });
  const second = mergePage(ROOT_ID, { entries: [{ name: 'b', path: 'b', type: 'file' }, { name: 'c', path: 'c', type: 'file' }], nextOffset: null }, first);
  assert.deepEqual(second.map(child => child.id), ['a', 'b', 'c']);
});

test('an empty folder shows a note', async () => {
  const { mergePage, noteId } = await load();
  assert.deepEqual(mergePage('docs', { entries: [], nextOffset: null }), [{ id: noteId('docs'), data: { kind: 'note', message: 'Empty folder' } }]);
  assert.notEqual(noteId('docs'), 'docs');
  assert.ok(noteId('docs').includes('\u0000'), 'made rows can never be a file path');
});

test('loadPage reads through the api and never throws: errors become notes, a failed later page keeps the rows', async () => {
  const { ROOT_ID, loadPage, errorNote, moreId } = await load();
  const asked = [];
  const ok = async (method, url) => { asked.push(`${method} ${url}`); return { entries: [{ name: 'x', path: 'src/x', type: 'file' }], nextOffset: null, root: '/w' }; };
  assert.deepEqual((await loadPage(ok, '/b', 'src')).map(child => child.id), ['src/x']);
  assert.deepEqual(asked, ['GET /b?path=src&offset=0']);

  const fail = code => async () => { throw new Error(code); };
  const missing = await loadPage(fail('FILE_NOT_FOUND'), '/b', 'gone');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].data.kind, 'note');
  assert.equal(missing[0].data.error, true);
  assert.equal(missing[0].data.message, 'This folder no longer exists');
  assert.equal((await loadPage(fail('TASK_ROOT_UNAVAILABLE'), '/b', ROOT_ID))[0].data.message, 'This task has no working directory');
  assert.equal(errorNote('FILE_NOT_DIRECTORY'), 'This is not a folder');
  assert.equal(errorNote('SOMETHING_ELSE'), 'Could not list this folder');

  const shown = [{ id: 'a', data: { kind: 'file', name: 'a', path: 'a' } }, { id: moreId(ROOT_ID), data: { kind: 'more', parent: ROOT_ID, offset: 200 } }];
  const again = await loadPage(fail('HTTP 502'), '/b', ROOT_ID, 200, shown);
  assert.deepEqual(again.map(child => child.id), ['a', moreId(ROOT_ID)]);
  assert.deepEqual(again[1].data, { kind: 'more', parent: ROOT_ID, offset: 200, failed: true });
});
