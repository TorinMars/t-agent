#!/usr/bin/env node
// Usage: node scripts/gen-password.js <username> <password>
// Prints one line that can be pasted directly into AUTH_USERS in .env

const crypto = require('crypto');
const [,, username, password] = process.argv;

if (!username || !password) {
  console.error('Usage: node scripts/gen-password.js <username> <password>');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
console.log(`${username}:${salt}:${hash}`);
