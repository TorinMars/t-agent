#!/usr/bin/env node

const path = require('path');
const { verifyNodePty } = require('../lib/node-pty-runtime');

const projectRoot = path.resolve(__dirname, '..');

verifyNodePty(projectRoot).then(() => {
  process.stdout.write('node-pty OK\n');
}).catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
