#!/usr/bin/env node
// Bumps the version in every place a release needs (see "Releases and pushing" in AGENTS.md):
// VERSION.json (app_version and published_at), package.json, and both version fields of package-lock.json.
//
//   node scripts/release.js patch                       2.84.21 -> 2.84.22
//   node scripts/release.js minor                       2.84.21 -> 2.85.0
//   node scripts/release.js 2.90.0 "Short note"         an exact version; the note is added to DESIGN.md as "> vX.Y.Z note"
//   node scripts/release.js patch --dry-run             prints the new version and changes nothing
//
// It does not commit or push. The API, schema and remote-compatibility fields of VERSION.json are left alone.
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.RELEASE_ROOT || path.resolve(__dirname, '..'); // the override is for the test
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);

function nextVersion(current, bump) {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isInteger(part))) throw new Error(`The current version is not X.Y.Z: ${current}`);
  if (bump === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  if (bump === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  if (bump === 'major') return `${parts[0] + 1}.0.0`;
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  throw new Error('Give patch, minor, major or an exact X.Y.Z version');
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const [bump, note] = argv.filter(arg => arg !== '--dry-run');
  if (!bump) throw new Error('Usage: node scripts/release.js <patch|minor|major|X.Y.Z> ["note for DESIGN.md"] [--dry-run]');
  const info = read('VERSION.json');
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  const current = info.app_version;
  if (pkg.version !== current || lock.version !== current || (lock.packages && lock.packages[''] && lock.packages[''].version !== current)) {
    throw new Error(`The version fields disagree (VERSION.json ${current}, package.json ${pkg.version}, package-lock.json ${lock.version}); fix them first`);
  }
  const next = nextVersion(current, bump);
  if (dryRun) { console.log(`${current} -> ${next} (dry run, nothing changed)`); return; }
  info.app_version = next;
  info.published_at = new Date().toISOString();
  pkg.version = next;
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  write('VERSION.json', info);
  write('package.json', pkg);
  write('package-lock.json', lock);
  if (note) {
    const file = path.join(root, 'DESIGN.md');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${text}${text.endsWith('\n') ? '' : '\n'}> v${next} ${note}\n`);
  }
  console.log(`${current} -> ${next}`);
}

try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
