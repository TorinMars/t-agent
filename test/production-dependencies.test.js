// The service is installed and updated without the dev dependencies (`npm ci --omit=dev` in install.sh and in services/update-manager.js), so a file
// the running service loads may only need a package listed under "dependencies" in package.json. This is a static scan of the require() and import
// of every production file. It fails when one of them needs a dev dependency (move the package to "dependencies"), and when "dependencies" lists a
// package no production file needs (a build or test tool belongs under "devDependencies": the page bundles under public/js are committed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DEPENDENCIES = new Set(Object.keys(pkg.dependencies || {}));
const DEV_DEPENDENCIES = new Set(Object.keys(pkg.devDependencies || {}));
const BUILTIN = new Set(builtinModules);

// What runs in production: the server and everything it loads, and the scripts under scripts/ that the service, an agent session, a hook or the
// person runs (tcli, t-attention, peer-mcp, the session hook, verify-node-pty, the setup helpers ...). A new file is production unless it is named here.
const PRODUCTION_DIRS = ['db', 'lib', 'middleware', 'plugins', 'routes', 'services'];
// Only for building, testing or releasing; they run in a checkout that has the dev dependencies. scripts/agent-chat, scripts/h5-shell and
// scripts/mindmap (folders) are the sources of the page bundles and are not scanned at all.
const DEV_ONLY_SCRIPTS = [
  /^test-/, // real-browser tests and the test:quick runner
  /^markdown-view-entry\.js$/, // the source of public/js/markdown-view.js
  /^fetch-vendor\.js$/,
  /^release\.js$/,
  /^sync-extension-redact\.js$/,
  /^h5-activity-stream-mock\.cjs$/,
];
const CODE = /\.(?:c|m)?js$/;

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') found.push(...walk(relative)); }
    else if (entry.isFile() && CODE.test(entry.name)) found.push(relative);
  }
  return found;
}

function productionFiles() {
  const top = fs.readdirSync(ROOT, { withFileTypes: true }).filter(entry => entry.isFile() && CODE.test(entry.name)).map(entry => entry.name);
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })
    .filter(entry => entry.isFile() && CODE.test(entry.name) && !DEV_ONLY_SCRIPTS.some(pattern => pattern.test(entry.name)))
    .map(entry => path.join('scripts', entry.name));
  return [...top, ...PRODUCTION_DIRS.flatMap(walk), ...scripts].sort();
}

// The module names a file asks for: require('x'), require.resolve('x') and import('x') anywhere, and the statements import 'x' and
// import / export ... from 'x' (which may run over several lines).
const CALL = /\b(?:require(?:\.resolve)?|import)\s*\(\s*(['"`])([^'"`\n]+)\1/g;
const BARE_IMPORT = /^\s*import\s*(['"])([^'"\n]+)\1/gm;
const FROM = /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/gm;
function specifiers(source) {
  const found = new Set();
  for (const pattern of [CALL, BARE_IMPORT, FROM]) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) found.add(match[2]);
  }
  return [...found];
}

// 'ws' -> ws, 'highlight.js/lib/common' -> highlight.js, '@xterm/headless/x' -> @xterm/headless; null for a built-in or anything that is not a package name.
function packageOf(specifier) {
  if (specifier.startsWith('node:') || !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[^\s]*)?$/i.test(specifier)) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return BUILTIN.has(name) ? null : name;
}

// A relative require of a file outside the production list makes that file production too (for example a module under public/ the server loads).
function resolveRelative(from, specifier) {
  const base = path.resolve(ROOT, path.dirname(from), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')]) {
    if (CODE.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.relative(ROOT, candidate);
  }
  return null;
}

// package name -> the production files that ask for it.
function scan() {
  const queue = productionFiles();
  const seen = new Set(queue);
  const users = new Map();
  while (queue.length) {
    const file = queue.shift();
    for (const specifier of specifiers(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier);
        if (target && !target.startsWith('..') && !target.split(path.sep).includes('node_modules') && !seen.has(target)) { seen.add(target); queue.push(target); }
        continue;
      }
      const name = packageOf(specifier);
      if (!name) continue;
      if (!users.has(name)) users.set(name, []);
      users.get(name).push(file);
    }
  }
  return { files: [...seen], users };
}

test('the scan reads the forms of require and import, and tells packages from built-ins and plain text', () => {
  assert.deepEqual(specifiers(`
    const a = require('express'); const b = require("node:fs"); const c = require.resolve('node-pty', { paths: [] });
    const load = () => import('@anthropic-ai/claude-agent-sdk');
    import hljs from 'highlight.js/lib/common';
    import { x,
      y } from './local.mjs';
    import 'side-effect';
    export { z } from '@scope/name/deep';
    // merged per site on import (last-writer-wins)
    const text = "copied from 'the old place' on import";
  `).sort(), ['./local.mjs', '@anthropic-ai/claude-agent-sdk', '@scope/name/deep', 'express', 'highlight.js/lib/common', 'node-pty', 'node:fs', 'side-effect'].sort());
  assert.equal(packageOf('express'), 'express');
  assert.equal(packageOf('highlight.js/lib/common'), 'highlight.js');
  assert.equal(packageOf('@xterm/headless/lib/x.js'), '@xterm/headless');
  assert.equal(packageOf('node:fs'), null);
  assert.equal(packageOf('fs/promises'), null);
  assert.equal(packageOf('child_process'), null);
  assert.equal(packageOf('PM2 not installed'), null);
});

test('the production files are found: the server, its folders and the scripts that run outside development', () => {
  const { files } = scan();
  for (const file of ['server.js', 'config.js', 'db/index.js', 'services/update-manager.js', 'lib/update-command.js', 'routes/terminal.js', 'middleware/auth.js',
    'plugins/notifiers/email/index.js', 'plugins/listeners/claude/hook.js', 'scripts/tcli.js', 'scripts/tcli-browser.js', 'scripts/t-attention.js',
    'scripts/peer-mcp.js', 'scripts/claude-session-hook.js', 'scripts/verify-node-pty.js', 'scripts/fs-read-child.js', 'scripts/client-auth-setup.js']) {
    assert.ok(files.includes(path.normalize(file)), `${file} is scanned`);
  }
  assert.ok(files.length > 150, `${files.length} files`);
  for (const file of files) {
    assert.ok(!/^scripts[\\/](?:test-|h5-shell[\\/]|agent-chat[\\/]|mindmap[\\/])/.test(file), `${file} is a test or the source of a page bundle, not production`);
    assert.ok(!/^test(?:-support)?[\\/]/.test(file), `${file} is test code`);
  }
});

test('no production file needs a dev dependency or a package that package.json does not list', () => {
  const { users } = scan();
  const problems = [];
  for (const [name, files] of users) {
    if (DEPENDENCIES.has(name)) continue;
    const where = [...new Set(files)].join(', ');
    problems.push(DEV_DEPENDENCIES.has(name)
      ? `${name} is a dev dependency but ${where} needs it: updates and installs leave dev dependencies out (npm ci --omit=dev), so move it to "dependencies"`
      : `${name} is needed by ${where} but is not in "dependencies"`);
  }
  assert.deepEqual(problems, []);
});

test('every package under "dependencies" is needed by a production file', () => {
  const { users } = scan();
  const unused = [...DEPENDENCIES].filter(name => !users.has(name));
  assert.deepEqual(unused, [], 'a build or test tool belongs under "devDependencies": every update installs what "dependencies" lists');
});

test('package-lock.json agrees with package.json, since npm ci refuses to install when they differ', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const root = lock.packages[''];
  assert.deepEqual(root.dependencies, pkg.dependencies);
  assert.deepEqual(root.devDependencies, pkg.devDependencies);
  for (const name of DEPENDENCIES) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} is in the lock file`);
    assert.notEqual(entry.dev, true, `${name} is installed without the dev dependencies`);
  }
});

test('install.sh and the update install the same thing, and neither builds', () => {
  const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const installs = read('install.sh').split('\n').filter(line => /^\s*npm (?:ci|install)\b/.test(line) && !/\s-g\b/.test(line));
  assert.ok(installs.length >= 1, 'install.sh installs the project dependencies');
  for (const line of installs) assert.match(line, /--omit=dev\b/, line.trim());
  const manager = read('services/update-manager.js');
  assert.match(manager, /\['ci', '--omit=dev', '--ignore-scripts=false'\]/);
  for (const file of ['install.sh', 'bootstrap.sh', 'services/update-manager.js']) {
    assert.doesNotMatch(read(file), /npm(?:\.cmd)?['", ]+run['", ]+build|npm run build/, `${file} runs no build: the bundles are committed`);
  }
});
