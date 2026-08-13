const crypto = require('crypto');

function keyFromSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptToken(token, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}

function decryptToken(value, secret) {
  const [ivText, tagText, encryptedText] = String(value).split('.');
  if (!ivText || !tagText || !encryptedText) throw new Error('INVALID_TOKEN_CIPHER');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(secret), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { decryptToken, encryptToken };
