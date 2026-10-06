#!/usr/bin/env node
const db = require('../db');
const config = require('../config');
const { createAccessToken } = require('../services/engine-auth');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('用法: node scripts/create-engine-token.js [名称]\n所有连接令牌都是管理权限。\n');
  process.exit(0);
}
const name = process.argv[2] || 'CLI Client';
const created = createAccessToken(db, { name, principalId: config.engineOwnerId });
process.stdout.write(`${created.token}\n`);
