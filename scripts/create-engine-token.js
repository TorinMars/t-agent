#!/usr/bin/env node
const db = require('../db');
const config = require('../config');
const { createAccessToken } = require('../services/engine-auth');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: node scripts/create-engine-token.js [name]\nEvery connection token has admin rights.\n');
  process.exit(0);
}
const name = process.argv[2] || 'CLI Client';
const created = createAccessToken(db, { name, principalId: config.engineOwnerId });
process.stdout.write(`${created.token}\n`);
