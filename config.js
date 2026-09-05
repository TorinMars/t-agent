require('dotenv').config();

const authUsers = (process.env.AUTH_USERS || '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean)
  .reduce((acc, entry) => {
    const [username, salt, hash] = entry.split(':');
    if (username && salt && hash) acc[username] = { salt, hash };
    return acc;
  }, {});

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  port:          parseInt(process.env.PORT || '3000', 10),
  host:          process.env.HOST || '0.0.0.0',
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  // AUTH_USERS 格式: "user1:salt:hash,user2:salt:hash"
  authUsers,
  githubVersionUrl: process.env.GITHUB_VERSION_URL || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  gitRemote: process.env.UPDATE_GIT_REMOTE || 'origin',
  gitBranch: process.env.UPDATE_GIT_BRANCH || 'main',
  updateRepository: process.env.UPDATE_GITHUB_REPOSITORY || 'TorinMars/t-agent',
  updateRef: process.env.UPDATE_GITHUB_REF || process.env.UPDATE_GIT_BRANCH || 'main',
  updateCheckEnabled: process.env.UPDATE_CHECK_ENABLED !== 'false',
  updateCheckIntervalMs: positiveInteger(process.env.UPDATE_CHECK_INTERVAL_SECONDS, 1800) * 1000,
  updateCheckStartupDelayMs: positiveInteger(process.env.UPDATE_CHECK_STARTUP_DELAY_SECONDS, 30) * 1000,
  updateAdminUsers: (process.env.UPDATE_ADMIN_USERS || Object.keys(authUsers)[0] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  engineName: process.env.ENGINE_NAME || require('os').hostname(),
  engineOwnerId: process.env.ENGINE_OWNER_ID || Object.keys(authUsers)[0] || 'engine',
  engineWorkspaceRoots: (process.env.ENGINE_WORKSPACE_ROOTS || process.env.TASKS_BASE_DIR || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
};
