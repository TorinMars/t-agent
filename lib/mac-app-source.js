// The hash of the build inputs of T-Agent.app (the shell code): every apps/macos/*.swift sorted by name, scripts/build-mac-app.js and
// scripts/mac-app/make-icon.swift. scripts/build-mac-app.js writes it into the bundle's Info.plist (TAgentSourceHash), and
// services/mac-app-autobuild.js compares the installed app's value with the current source after an update.
// See "Automatic rebuild after an update" in docs/design/mac-app.md.
//
// The hash is SHA-256 (hex) over, for each input in that order, its label (the path inside the install folder, so a test folder gives the
// same value for the same files), its length in bytes and its bytes. Any change of a file's content, a file added, removed or renamed
// changes it; the time stamps and the install folder do not.
const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INFO_KEY = 'TAgentSourceHash';

// The inputs as [{ label, file }]; `sources` are the absolute paths of the app's Swift files (any order).
function sourceInputs({ sources, buildScript, iconSource }) {
  const swift = sources.slice().sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : path.basename(a) > path.basename(b) ? 1 : 0))
    .map(file => ({ label: `apps/macos/${path.basename(file)}`, file }));
  return [...swift, { label: 'scripts/build-mac-app.js', file: buildScript }, { label: 'scripts/mac-app/make-icon.swift', file: iconSource }];
}

// The hash of the given files. Throws when one of them cannot be read.
function hashInputs({ sources, buildScript, iconSource, fs = nodeFs }) {
  const hash = crypto.createHash('sha256');
  for (const { label, file } of sourceInputs({ sources, buildScript, iconSource })) {
    const bytes = fs.readFileSync(file);
    hash.update(`${label}\n${bytes.length}\n`);
    hash.update(bytes);
    hash.update('\n');
  }
  return hash.digest('hex');
}

// The Swift files of the app in `dir`: every *.swift, sorted by name, as absolute paths (the list scripts/build-mac-app.js compiles).
function appSources(dir, fs = nodeFs) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(name => name.endsWith('.swift')).sort().map(name => path.join(dir, name));
}

// The hash of the install folder `root`, or null when the app source is not complete there (no main.swift, a file that cannot be read).
function macAppSourceHash({ root = ROOT, fs = nodeFs } = {}) {
  const sources = appSources(path.join(root, 'apps', 'macos'), fs);
  if (!sources.some(file => path.basename(file) === 'main.swift')) return null;
  try {
    return hashInputs({ sources, buildScript: path.join(root, 'scripts', 'build-mac-app.js'), iconSource: path.join(root, 'scripts', 'mac-app', 'make-icon.swift'), fs });
  } catch { return null; }
}

module.exports = { INFO_KEY, sourceInputs, hashInputs, appSources, macAppSourceHash };
