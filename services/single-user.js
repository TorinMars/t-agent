const STATE_KEY = 'single_user_id';

function normalizeId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('INVALID_SINGLE_USER_ID');
  return id;
}

function discoverExistingId(database) {
  const user = database.prepare('SELECT username FROM users ORDER BY id ASC LIMIT 1').get();
  if (user) return user.username;

  const taskOwner = database.prepare(`SELECT user_id value, COUNT(*) count FROM tasks
    WHERE user_id IS NOT NULL AND user_id != '' GROUP BY user_id ORDER BY count DESC LIMIT 1`).get();
  if (taskOwner) return taskOwner.value;

  const remoteOwner = database.prepare(`SELECT owner_id value, COUNT(*) count FROM remote_servers
    WHERE owner_id IS NOT NULL AND owner_id != '' GROUP BY owner_id ORDER BY count DESC LIMIT 1`).get();
  return remoteOwner ? remoteOwner.value : '';
}

function ensureSingleUser(database, preferredId) {
  const activeDatabase = database || require('../db');
  const configuredId = preferredId === undefined ? require('../config').singleUserId : preferredId;
  const preferred = normalizeId(configuredId);
  const saved = activeDatabase.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
  const id = preferred || normalizeId(saved && saved.value) || normalizeId(discoverExistingId(activeDatabase)) || 'local';

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
    name: '本地用户',
    avatar_url: '',
    work_dir: user.work_dir || null,
  };
}

module.exports = { STATE_KEY, ensureSingleUser };
