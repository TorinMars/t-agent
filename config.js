require('dotenv').config();

module.exports = {
  port:          parseInt(process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  // AUTH_USERS 格式: "user1:salt:hash,user2:salt:hash"
  authUsers: (process.env.AUTH_USERS || '')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean)
    .reduce((acc, entry) => {
      const [username, salt, hash] = entry.split(':');
      if (username && salt && hash) acc[username] = { salt, hash };
      return acc;
    }, {}),
};
