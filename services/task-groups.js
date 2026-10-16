const { randomUUID } = require('crypto');

const INITIAL_GROUPS = Object.freeze([
  { key: 'personal', name: 'Personal tasks', sortOrder: 0, isSystem: false },
  { key: 'doing', name: 'In progress', sortOrder: 1000, isSystem: true },
  { key: 'todo', name: 'To do', sortOrder: 2000, isSystem: true },
  { key: 'done', name: 'Done', sortOrder: 3000, isSystem: true },
]);
// Names written by versions before the project became English-first (escaped to keep the source ASCII).
const LEGACY_NAMES = Object.freeze({
  personal: '\u4e2a\u4eba\u4efb\u52a1',
  doing: '\u8fdb\u884c\u4e2d',
  todo: '\u5f85\u529e',
  done: '\u5df2\u5b8c\u6210',
});
const SYSTEM_GROUPS = INITIAL_GROUPS.filter(group => group.isSystem);

function serviceError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function normalizeOwner(ownerId) {
  const value = String(ownerId || '').trim();
  if (!value) throw serviceError('GROUP_OWNER_REQUIRED');
  return value;
}

function normalizeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw serviceError('GROUP_NAME_REQUIRED');
  if (name.length > 40) throw serviceError('GROUP_NAME_TOO_LONG');
  return name;
}

function insertGroup(database, ownerId, group) {
  database.prepare(`INSERT OR IGNORE INTO task_groups
    (owner_id, group_key, name, sort_order, is_system)
    VALUES (?, ?, ?, ?, ?)`).run(ownerId, group.key, group.name, group.sortOrder, group.isSystem ? 1 : 0);
}

function ensureGroups(database, ownerId) {
  const owner = normalizeOwner(ownerId);
  database.transaction(() => {
    const count = database.prepare('SELECT COUNT(*) count FROM task_groups WHERE owner_id = ?').get(owner).count;
    const defaults = count === 0 ? INITIAL_GROUPS : SYSTEM_GROUPS;
    defaults.forEach(group => insertGroup(database, owner, group));
    // Rename untouched legacy default names; names the user chose themselves are left alone.
    INITIAL_GROUPS.forEach(group => database.prepare(
      'UPDATE OR IGNORE task_groups SET name = ? WHERE owner_id = ? AND group_key = ? AND name = ?'
    ).run(group.name, owner, group.key, LEGACY_NAMES[group.key]));
  })();
  return owner;
}

function publicGroup(row) {
  return {
    id: Number(row.id),
    key: row.group_key,
    name: row.name,
    sort_order: Number(row.sort_order),
    is_system: Boolean(row.is_system),
    task_count: Number(row.task_count || 0),
  };
}

function listGroups(database, ownerId) {
  const owner = ensureGroups(database, ownerId);
  return database.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.user_id = g.owner_id AND t.status = g.group_key) task_count
    FROM task_groups g WHERE g.owner_id = ?
    ORDER BY g.sort_order ASC, g.created_at ASC, g.id ASC`).all(owner).map(publicGroup);
}

function getGroup(database, ownerId, id) {
  const owner = ensureGroups(database, ownerId);
  return database.prepare('SELECT * FROM task_groups WHERE id = ? AND owner_id = ?').get(id, owner);
}

function assertGroupKey(database, ownerId, key) {
  const owner = ensureGroups(database, ownerId);
  const group = database.prepare('SELECT * FROM task_groups WHERE owner_id = ? AND group_key = ?').get(owner, String(key || ''));
  if (!group) throw serviceError('TASK_GROUP_NOT_FOUND', 404);
  return publicGroup(group);
}

function createGroup(database, ownerId, input = {}) {
  const owner = ensureGroups(database, ownerId);
  const name = normalizeName(input.name);
  const nextOrder = database.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 10 value
    FROM task_groups WHERE owner_id = ? AND is_system = 0 AND sort_order < 1000`).get(owner).value;
  const key = `group_${randomUUID().replace(/-/g, '')}`;
  try {
    const result = database.prepare(`INSERT INTO task_groups
      (owner_id, group_key, name, sort_order, is_system) VALUES (?, ?, ?, ?, 0)`)
      .run(owner, key, name, nextOrder);
    return listGroups(database, owner).find(group => group.id === Number(result.lastInsertRowid));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw serviceError('GROUP_NAME_ALREADY_EXISTS', 409);
    throw error;
  }
}

function updateGroup(database, ownerId, id, input = {}) {
  const owner = ensureGroups(database, ownerId);
  const group = getGroup(database, owner, id);
  if (!group) throw serviceError('TASK_GROUP_NOT_FOUND', 404);
  if (group.is_system) throw serviceError('SYSTEM_GROUP_IMMUTABLE', 400);
  const name = normalizeName(input.name);
  try {
    database.prepare(`UPDATE task_groups SET name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_id = ?`).run(name, group.id, owner);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw serviceError('GROUP_NAME_ALREADY_EXISTS', 409);
    throw error;
  }
  return listGroups(database, owner).find(item => item.id === Number(group.id));
}

function deleteGroup(database, ownerId, id) {
  const owner = ensureGroups(database, ownerId);
  database.transaction(() => {
    const group = database.prepare('SELECT * FROM task_groups WHERE id = ? AND owner_id = ?').get(id, owner);
    if (!group) throw serviceError('TASK_GROUP_NOT_FOUND', 404);
    if (group.is_system) throw serviceError('SYSTEM_GROUP_IMMUTABLE', 400);
    const taskCount = database.prepare('SELECT COUNT(*) count FROM tasks WHERE user_id = ? AND status = ?')
      .get(owner, group.group_key).count;
    if (taskCount > 0) throw serviceError('TASK_GROUP_NOT_EMPTY', 409);
    database.prepare('DELETE FROM task_groups WHERE id = ? AND owner_id = ?').run(group.id, owner);
  })();
}

module.exports = {
  INITIAL_GROUPS,
  ensureGroups,
  listGroups,
  assertGroupKey,
  createGroup,
  updateGroup,
  deleteGroup,
};
