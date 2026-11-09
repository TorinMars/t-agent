// A task made since tasks stopped getting a terminal by themselves has no implicit `default` terminal: the person creates the first one
// (New Terminal, Claude session, Codex session). It is recorded in the table of a deleted default terminal, so a new task and a task whose default
// was deleted behave the same: not listed, not connectable, no shell. A task without a row (made before this change) keeps its default terminal.
function startWithoutDefaultTerminal(database, taskId) {
  database.prepare('INSERT OR IGNORE INTO task_default_terminal_removed (task_id) VALUES (?)').run(taskId);
}

module.exports = { startWithoutDefaultTerminal };
