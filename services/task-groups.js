// 任务分组：现在保存在工作目录的 .t-agent/groups.json（见 task-store.js），不再使用数据库表。
// 保留 (database, ownerId, ...) 的调用形式，database 仅用于查账号的工作目录设置。
const taskStore = require('./task-store');

const INITIAL_GROUPS = taskStore.INITIAL_GROUPS;
const storeOf = (database, ownerId) => {
  const owner = String(ownerId || '').trim();
  if (!owner) throw Object.assign(new Error('GROUP_OWNER_REQUIRED'), { statusCode: 400 });
  return taskStore.forOwner(database, owner);
};

module.exports = {
  INITIAL_GROUPS,
  ensureGroups: (database, ownerId) => { storeOf(database, ownerId).listGroups(); return String(ownerId).trim(); },
  listGroups: (database, ownerId) => storeOf(database, ownerId).listGroups(),
  assertGroupKey: (database, ownerId, key) => storeOf(database, ownerId).assertGroupKey(key),
  createGroup: (database, ownerId, input) => storeOf(database, ownerId).createGroup(input),
  updateGroup: (database, ownerId, id, input) => storeOf(database, ownerId).updateGroup(id, input),
  deleteGroup: (database, ownerId, id) => storeOf(database, ownerId).deleteGroup(id),
};
