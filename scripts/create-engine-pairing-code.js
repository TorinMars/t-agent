#!/usr/bin/env node
const db = require('../db');
const config = require('../config');
const { createPairingCode } = require('../services/engine-auth');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('用法: node scripts/create-engine-pairing-code.js [readonly|operator|owner]\n');
  process.exit(0);
}
const role = process.argv[2] || 'operator';
if (!['readonly', 'operator', 'owner'].includes(role)) {
  process.stderr.write('错误：角色只能是 readonly、operator 或 owner\n');
  process.exit(1);
}
const created = createPairingCode(db, { role, principalId: config.engineOwnerId });
process.stdout.write(`${created.code}\n`);
