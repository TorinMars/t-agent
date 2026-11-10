// Task archiving (schema 10). tasks.archived_at is the moment a task was archived (ISO 8601 UTC) and NULL while the task is in use.
// Archiving is reversible and destroys nothing: the working directory, documents, to-dos, terminal rows (with their agent session bindings), chats,
// the share link and the group all stay. What ends is what runs: the live terminals are closed and running chat turns are stopped, and until the
// task is restored its terminals and chats refuse to start (409 TASK_ARCHIVED, see routes/terminal.js and services/agent-chat.js).
// Lists of tasks leave archived ones out unless asked; lists that protect directories (services/workspace-tools.js) must keep them.

// The sort_order a new task gets on every path that makes one, so a restored task is ordered like a new one.
const NEW_TASK_SORT_ORDER = 0;

const fail = (code, statusCode) => Object.assign(new Error(code), { statusCode });

function owned(database, owner, id) {
  return database.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, owner);
}

// Rows of one owner: the tasks in use in their list order, or (`archived`) only the archived ones, the most recently archived first.
function listTasks(database, owner, { status, archived = false } = {}) {
  const filters = ['user_id = ?', archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const values = [owner];
  if (status) { filters.push('status = ?'); values.push(status); }
  const order = archived ? 'archived_at DESC, id DESC' : 'sort_order ASC, created_at DESC';
  return database.prepare(`SELECT * FROM tasks WHERE ${filters.join(' AND ')} ORDER BY ${order}`).all(...values);
}

// The ids behind the run state, sub-agent and next-session views.
function activeTaskIds(database, owner) {
  return database.prepare('SELECT id FROM tasks WHERE user_id = ? AND archived_at IS NULL').all(owner).map(row => row.id);
}

// Idempotent: an archived task keeps its archived_at. The terminals and chats are closed on every call, so a repeated request also ends anything that
// an earlier one could not. The column is written first: nothing can start again once it is set.
function archiveTask(database, owner, id) {
  const task = owned(database, owner, id);
  if (!task) throw fail('TASK_NOT_FOUND', 404);
  if (!task.archived_at) {
    database.prepare('UPDATE tasks SET archived_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .run(new Date().toISOString(), task.id, owner);
  }
  require('../routes/terminal').closeTaskTerminals(task.id);
  require('./agent-chat').getAgentChat().stopTask(task.id);
  return owned(database, owner, task.id);
}

// Idempotent: a task that is not archived is left exactly as it is. Nothing is started; terminals and chats wait until the person opens them.
function restoreTask(database, owner, id) {
  const task = owned(database, owner, id);
  if (!task) throw fail('TASK_NOT_FOUND', 404);
  if (task.archived_at) {
    database.prepare('UPDATE tasks SET archived_at = NULL, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .run(NEW_TASK_SORT_ORDER, task.id, owner);
  }
  return owned(database, owner, task.id);
}

module.exports = { NEW_TASK_SORT_ORDER, listTasks, activeTaskIds, archiveTask, restoreTask };
