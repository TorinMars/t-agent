// A task as it was made before tasks stopped getting a terminal by themselves: it has the implicit `default` terminal. For the tests of that terminal.
function asOlderTask(db, task) {
  db.prepare('DELETE FROM task_default_terminal_removed WHERE task_id = ?').run(task.id);
  return task;
}

// The task service, but createTask makes such an older task.
function olderTasks(engine, db) {
  return { ...engine, createTask: (...args) => asOlderTask(db, engine.createTask(...args)) };
}

module.exports = { asOlderTask, olderTasks };
