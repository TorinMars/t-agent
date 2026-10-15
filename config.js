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
const singleUserId = process.env.SINGLE_USER_ID || '';
const clientSessionCookieName = process.env.CLIENT_SESSION_COOKIE_NAME || 'connect.sid';
if (!/^[A-Za-z0-9_.-]+$/.test(clientSessionCookieName)) throw new Error('INVALID_CLIENT_SESSION_COOKIE_NAME');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  port:         parseInt(process.env.PORT || '3000', 10),
  // Listen on this machine only by default; set HOST=0.0.0.0 explicitly to allow phone access.
  host:         process.env.HOST || '127.0.0.1',
  // Initial access mode for a fresh install (local / remote); leave empty to choose on first page load. A choice that was already saved takes precedence.
  accessMode:   ['local', 'remote'].includes(process.env.ACCESS_MODE) ? process.env.ACCESS_MODE : '',
  // Explicit opt-in for trusted intranet HTTP; HTTPS cookies remain Secure.
  clientAllowHttp: process.env.CLIENT_ALLOW_HTTP === 'true',
  clientFrameOrigins: require('./lib/client-embedding').parseFrameOrigins(process.env.CLIENT_FRAME_ORIGINS),
  // The only login entrance visible when logged out; every other address returns 404.
  loginPath: require('./lib/login-gate').resolveLoginPath(process.env.CLIENT_LOGIN_PATH, message => console.warn(message)),
  clientSessionCookieName,
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  // AUTH_USERS format: "user1:salt:hash,user2:salt:hash"
  authUsers,
  singleUserId,
  githubVersionUrl: process.env.GITHUB_VERSION_URL || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  gitRemote: process.env.UPDATE_GIT_REMOTE || 'origin',
  gitBranch: process.env.UPDATE_GIT_BRANCH || 'main',
  updateRepository: process.env.UPDATE_GITHUB_REPOSITORY || 'TorinMars/t-agent',
  updateRef: process.env.UPDATE_GITHUB_REF || process.env.UPDATE_GIT_BRANCH || 'main',
  updateCheckEnabled: process.env.UPDATE_CHECK_ENABLED !== 'false',
  updateCheckIntervalMs: positiveInteger(process.env.UPDATE_CHECK_INTERVAL_SECONDS, 1800) * 1000,
  updateCheckStartupDelayMs: positiveInteger(process.env.UPDATE_CHECK_STARTUP_DELAY_SECONDS, 30) * 1000,
  updateAdminUsers: (process.env.UPDATE_ADMIN_USERS || singleUserId || Object.keys(authUsers)[0] || 'local')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  engineName: process.env.ENGINE_NAME || require('os').hostname(),
  engineOwnerId: process.env.ENGINE_OWNER_ID || singleUserId || Object.keys(authUsers)[0] || 'engine',
};
