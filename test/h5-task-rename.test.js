// The rules of the task Rename dialog (scripts/h5-shell/task-rename.mjs): the slug matches the server's, folder paths split and join, names are checked
// as the server checks them.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/task-rename.mjs');

test('titleToSlug is the server rule of a new task folder', async () => {
  const { titleToSlug } = await load();
  const server = title => title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_.]/g, '').replace(/^-+|-+$/g, '') || 'task';
  for (const title of ['New title', '  spaced  out ', 'a/b\\c', '\u65b0\u4efb\u52a1 v2', '!!!', 'dots.and_under-score']) assert.equal(titleToSlug(title), server(title));
  assert.equal(titleToSlug(''), 'task');
});

test('folderParts and joinFolder keep the parent and swap the name', async () => {
  const { folderParts, joinFolder } = await load();
  assert.deepEqual(folderParts('/home/me/tasks/Old/'), { parent: '/home/me/tasks', name: 'Old', separator: '/' });
  assert.equal(joinFolder(folderParts('/home/me/tasks/Old'), 'New'), '/home/me/tasks/New');
  assert.equal(joinFolder(folderParts('/top'), 'next'), '/next');
  assert.equal(joinFolder(folderParts('C:\\work\\Old'), 'New'), 'C:\\work\\New');
  assert.equal(folderParts(''), null);
  assert.equal(folderParts('relative'), null);
});

test('folderFollowsTitle: the folder still has its title\'s name', async () => {
  const { folderFollowsTitle } = await load();
  assert.equal(folderFollowsTitle('/t/My-task', 'My task'), true);
  assert.equal(folderFollowsTitle('/t/custom', 'My task'), false);
  assert.equal(folderFollowsTitle('', 'My task'), false);
});

test('folderNameProblem accepts one plain segment only', async () => {
  const { folderNameProblem } = await load();
  assert.equal(folderNameProblem('New-name'), '');
  assert.equal(folderNameProblem('\u65b0\u540d'), '');
  for (const name of ['', '  ', ' x', 'x ', '.', '..', 'a/b', 'a\\b', 'tab\there', 'x'.repeat(256)]) assert.notEqual(folderNameProblem(name), '', JSON.stringify(name));
});
