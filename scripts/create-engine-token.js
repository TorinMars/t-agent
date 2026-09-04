#!/usr/bin/env node
const db = require('../db');
const config = require('../config');
const { createAccessToken } = require('../services/engine-auth');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('用法: node scripts/create-engine-token.js [readonly|operator|owner] [名称]\n');
  process.exit(0);
}
const role = process.argv[2] || 'owner';
if (!['readonly', 'operator', 'owner'].includes(role)) {
  process.stderr.write('错误：角色只能是 readonly、operator 或 owner\n');
  process.exit(1);
}
const name = process.argv[3] || 'CLI Client';
const created = createAccessToken(db, { role, name, principalId: config.engineOwnerId });
process.stdout.write(`${created.token}\n`);
