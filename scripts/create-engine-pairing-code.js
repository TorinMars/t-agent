#!/usr/bin/env node
const db = require('../db');
const config = require('../config');
const { createPairingCode } = require('../services/engine-auth');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: node scripts/create-engine-pairing-code.js\nA connection obtained by pairing has admin rights.\n');
  process.exit(0);
}
const created = createPairingCode(db, { principalId: config.engineOwnerId });
process.stdout.write(`${created.code}\n`);
