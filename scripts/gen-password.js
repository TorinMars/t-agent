#!/usr/bin/env node
// 用法: node scripts/gen-password.js <username> <password>
// 输出一行可直接粘贴到 .env AUTH_USERS 的字符串

const crypto = require('crypto');
const [,, username, password] = process.argv;

if (!username || !password) {
  console.error('用法: node scripts/gen-password.js <username> <password>');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
console.log(`${username}:${salt}:${hash}`);
