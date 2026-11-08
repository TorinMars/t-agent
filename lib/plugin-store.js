// T-Attention user plugins on disk (see "Plugin marketplace" in DESIGN.md). Node built-ins only; shared by the notifier loader
// (services/attention-notify.js), the plugin overview (services/attention-plugins.js) and the marketplace (services/attention-market.js).
//
//   <data folder>/plugins/
//     listeners/<name>/       an installed listener (the plugin's files plus .install.json)
//     notifiers/<name>/       an installed notifier
//     links.json              dev links: [{ name, kind, path, linkedAt }] (the folder stays where it is)
//     market.json             { extra: [index URL] } (extra marketplace indexes)
//     index-cache.json        the last good copy of every index, for when a fetch fails
//     .tmp/                   prepared downloads and folders being replaced (cleaned at start)
//
// <folder>/.install.json = { name, kind, version, source: { type: 'index'|'git', index?, url, ref, path, commit }, installedAt, manifestHash }.
// Built-in plugins live in the install's plugins/ folder and cannot be removed; a user plugin may not use a built-in name.
const fs = require('node:fs');
const path = require('node:path');

const BUILTIN_DIR = path.join(__dirname, '..', 'plugins');
const KINDS = Object.freeze(['listener', 'notifier']);
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const INSTALL_FILE = '.install.json';
const kindFolder = kind => `${kind}s`;

const storeRoot = dataDir => path.join(dataDir, 'plugins');
const kindDir = (dataDir, kind) => path.join(storeRoot(dataDir), kindFolder(kind));
const tmpDir = dataDir => path.join(storeRoot(dataDir), '.tmp');
const linksFile = dataDir => path.join(storeRoot(dataDir), 'links.json');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Atomic write (temp file + rename), mode 600.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

// The names used by the built-in plugins of this install (folder names and manifest names, every kind).
function builtInNames(builtInDir = BUILTIN_DIR) {
  const names = new Set();
  for (const kind of KINDS) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(builtInDir, kindFolder(kind)), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      names.add(entry.name);
      const manifest = readJson(path.join(builtInDir, kindFolder(kind), entry.name, 'manifest.json'));
      if (manifest && typeof manifest.name === 'string') names.add(manifest.name);
    }
  }
  return names;
}

function readLinks(dataDir) {
  const list = readJson(linksFile(dataDir), []);
  if (!Array.isArray(list)) return [];
  return list.filter(link => link && NAME.test(String(link.name)) && KINDS.includes(link.kind) && typeof link.path === 'string' && path.isAbsolute(link.path));
}

function writeLinks(dataDir, links) {
  writeJson(linksFile(dataDir), links.map(link => ({ name: link.name, kind: link.kind, path: link.path, linkedAt: link.linkedAt })));
}

function readInstall(folder) {
  const info = readJson(path.join(folder, INSTALL_FILE));
  return info && typeof info === 'object' && !Array.isArray(info) ? info : null;
}

// The user plugins of one kind: [{ name, kind, folder, origin: 'index'|'git'|'link', dev, install, link }]. Installed folders need a
// valid name and an .install.json (a half-written folder is ignored); a link whose name is also installed is left out.
function userFolders(dataDir, kind) {
  if (!dataDir || !KINDS.includes(kind)) return [];
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(kindDir(dataDir, kind), { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    const folder = path.join(kindDir(dataDir, kind), entry.name);
    const install = readInstall(folder);
    if (!install) continue;
    const type = install.source && install.source.type === 'index' ? 'index' : 'git';
    out.push({ name: entry.name, kind, folder, origin: type, dev: false, install, link: null });
  }
  for (const link of readLinks(dataDir)) {
    if (link.kind !== kind || out.some(item => item.name === link.name)) continue;
    out.push({ name: link.name, kind, folder: link.path, origin: 'link', dev: true, install: null, link });
  }
  return out;
}

module.exports = {
  BUILTIN_DIR, KINDS, NAME, INSTALL_FILE, kindFolder, storeRoot, kindDir, tmpDir, linksFile,
  readJson, writeJson, builtInNames, readLinks, writeLinks, readInstall, userFolders,
};
