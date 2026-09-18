const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function ensureClientSecret(dataDir, configured) {
  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, 'client-session-secret');
  const valid = value => typeof value === 'string' && value.length >= 32 && value !== 'your-random-secret-change-this';
  if (configured && !valid(configured)) throw new Error('CLIENT_SESSION_SECRET_INVALID');
  if (!configured && !fs.existsSync(secretPath) && fs.existsSync(path.join(dataDir, 'db.sqlite'))) {
    throw new Error('CLIENT_SESSION_SECRET_MISSING: restore the original secret before starting');
  }
  try {
    fs.writeFileSync(secretPath, configured || crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stored = fs.readFileSync(secretPath, 'utf8').trim();
  if (!valid(stored)) throw new Error('CLIENT_SESSION_SECRET_INVALID: restore client-session-secret from backup');
  if (configured && stored !== configured) throw new Error('CLIENT_SESSION_SECRET_MISMATCH: use the original secret');
  fs.chmodSync(secretPath, 0o600);
  return stored;
}

module.exports = { ensureClientSecret };
