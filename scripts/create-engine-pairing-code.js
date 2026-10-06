#!/usr/bin/env node
const db = require('../db');
const config = require('../config');
const { createPairingCode } = require('../services/engine-auth');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('用法: node scripts/create-engine-pairing-code.js\n配对得到的连接是管理权限。\n');
  process.exit(0);
}
const created = createPairingCode(db, { principalId: config.engineOwnerId });
process.stdout.write(`${created.code}\n`);
