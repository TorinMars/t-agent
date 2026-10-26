#!/usr/bin/env node
// A fast check while developing: the unit tests in test/, without the installer tests (they run shell scripts and take about a minute)
// and without the real-browser tests in scripts/. Pass file names to run only those, for example:
//   npm run test:quick -- test/agent-chat-service.test.js
// Run the full `npm test` once before a release.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const SLOW = /^install-/;
const given = process.argv.slice(2);
const files = given.length ? given : fs.readdirSync(path.join(root, 'test'))
  .filter(name => name.endsWith('.js') && !SLOW.test(name))
  .map(name => path.join('test', name));

const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
