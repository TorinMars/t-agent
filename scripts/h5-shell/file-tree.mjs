// The data side of the read-only file tree (FileTree.jsx): one folder of the task's working directory per request, through the list endpoint of the
// task file API (`GET <tasksBase>/<task>/files?path=<rel>&offset=<n>`, local, Engine `/v1` and the remote proxy alike; 200 entries a page, folders
// first, `nextOffset` while there are more). Items are keyed by their path relative to the working directory; the root is ROOT_ID. Two kinds of rows
// are made here and are not files: a "Load more" row at the end of a folder that has more pages, and a note (an empty folder, an error).
export const ROOT_ID = '/';
const MORE = '\u0000more'; // ids of the made rows: the folder's id + this suffix (a NUL can never be in a file name)
const NOTE = '\u0000note';

export const moreId = parentId => `${parentId}${MORE}`;
export const noteId = parentId => `${parentId}${NOTE}`;
const folderPath = parentId => (parentId === ROOT_ID ? '' : parentId);

// The list address of one page of a folder; the root is listed without `path`.
export function listUrl(base, parentId, offset = 0) {
  const folder = folderPath(parentId);
  const query = [];
  if (folder) query.push(`path=${encodeURIComponent(folder)}`);
  query.push(`offset=${Number(offset) || 0}`);
  return `${base}?${query.join('&')}`;
}

// The note shown in a folder whose listing failed, by the server's error code.
const ERROR_NOTES = {
  FILE_NOT_FOUND: 'This folder no longer exists',
  FILE_NOT_DIRECTORY: 'This is not a folder',
  TASK_ROOT_UNAVAILABLE: 'This task has no working directory',
  FILE_FORBIDDEN: 'This folder cannot be read',
  FILE_UNSUPPORTED: 'Symbolic links are not opened',
  FILE_PATH_CHANGED: 'The folder changed while it was read. Reload to try again.',
};
export const errorNote = code => ERROR_NOTES[code] || 'Could not list this folder';

// One entry of the server (`{ name, path, type }`, type directory | file | symlink | other) as the data of a tree item.
export function entryItem(entry) {
  const kind = entry.type === 'directory' ? 'dir' : entry.type === 'file' ? 'file' : 'other';
  return { id: entry.path, data: { kind, name: entry.name, path: entry.path, link: entry.type === 'symlink' } };
}

// The children of a folder after a page arrived: the entries loaded so far, then a "Load more" row while the server has more (`nextOffset`).
// `previous` are the children shown before (the earlier pages, maybe with their "Load more" row, which is dropped); an entry already listed is
// not listed twice (the folder may have changed between two pages).
export function mergePage(parentId, page, previous = []) {
  const kept = previous.filter(child => child.data.kind !== 'more' && child.data.kind !== 'note');
  const seen = new Set(kept.map(child => child.id));
  const added = (page && Array.isArray(page.entries) ? page.entries : []).map(entryItem).filter(child => !seen.has(child.id) && seen.add(child.id));
  const children = [...kept, ...added];
  const next = page && Number.isSafeInteger(page.nextOffset) ? page.nextOffset : null;
  if (next !== null) children.push({ id: moreId(parentId), data: { kind: 'more', parent: parentId, offset: next } });
  if (!children.length) children.push({ id: noteId(parentId), data: { kind: 'note', message: 'Empty folder' } });
  return children;
}

// Reads one page; a failure becomes a note row (the tree's loader must never throw, or the folder would stay "loading").
export async function loadPage(api, base, parentId, offset = 0, previous = []) {
  try {
    const page = await api('GET', listUrl(base, parentId, offset));
    return mergePage(parentId, page, previous);
  } catch (error) {
    const kept = previous.filter(child => child.data.kind !== 'more' && child.data.kind !== 'note');
    const note = { id: noteId(parentId), data: { kind: 'note', message: errorNote(error && error.message), error: true } };
    // A later page that failed keeps what was shown and offers the page again.
    if (kept.length && offset > 0) return [...kept, { id: moreId(parentId), data: { kind: 'more', parent: parentId, offset, failed: true } }];
    return [note];
  }
}
