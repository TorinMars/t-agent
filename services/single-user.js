const STATE_KEY = 'single_user_id';

function normalizeId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('INVALID_SINGLE_USER_ID');
  return id;
}

function discoverDataOwner(database) {
  const row = database.prepare(`
    SELECT owner_id value, SUM(item_count) item_count
    FROM (
      SELECT user_id owner_id, COUNT(*) item_count
      FROM tasks
      WHERE user_id IS NOT NULL AND user_id != ''
      GROUP BY user_id
      UNION ALL
      SELECT owner_id, COUNT(*) item_count
      FROM remote_servers
      WHERE owner_id IS NOT NULL AND owner_id != ''
      GROUP BY owner_id
    ) owners
    GROUP BY owner_id
    ORDER BY item_count DESC, owner_id ASC
    LIMIT 1
  `).get();
  return row ? row.value : '';
}

function ownsVisibleData(database, id) {
  if (!id) return false;
  const row = database.prepare(`
    SELECT
      EXISTS(SELECT 1 FROM tasks WHERE user_id = ? LIMIT 1)
      OR EXISTS(SELECT 1 FROM remote_servers WHERE owner_id = ? LIMIT 1) owns_data
  `).get(id, id);
  return Boolean(row && row.owns_data);
}

function discoverExistingUser(database) {
  const user = database.prepare('SELECT username FROM users ORDER BY id ASC LIMIT 1').get();
  return user ? user.username : '';
}

function ensureSingleUser(database, preferredId) {
  const activeDatabase = database || require('../db');
  const configuredId = preferredId === undefined ? require('../config').singleUserId : preferredId;
  const preferred = normalizeId(configuredId);
  const saved = activeDatabase.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
  const savedId = normalizeId(saved && saved.value);
  const dataOwner = normalizeId(discoverDataOwner(activeDatabase));

  // On upgrade .env may already contain the default local, or local may have been saved on first start.
  // If that account owns no data, go back to the account that really owns the old tasks/remote connections, so the data is not hidden by the query condition.
  const id = (ownsVisibleData(activeDatabase, preferred) && preferred)
    || (ownsVisibleData(activeDatabase, savedId) && savedId)
    || dataOwner
    || preferred
    || savedId
    || normalizeId(discoverExistingUser(activeDatabase))
    || 'local';

  const existingUser = activeDatabase.prepare('SELECT username FROM users WHERE username = ?').get(id);
  if (!existingUser) {
    activeDatabase.prepare(`INSERT INTO users (username, salt, hash)
      VALUES (?, 'single-user', 'password-auth-disabled')`).run(id);
  }
  if (!saved || saved.value !== id) {
    activeDatabase.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, id);
  }

  const user = activeDatabase.prepare('SELECT username, work_dir FROM users WHERE username = ?').get(id);
  return {
    login: user.username,
    name: 'Local user',
    avatar_url: '',
    work_dir: user.work_dir || null,
  };
}

module.exports = { STATE_KEY, ensureSingleUser };
