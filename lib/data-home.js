// The data folder ("data home"): where this machine's runtime data lives, outside the install directory, so that every
// installed version of the app reads the same data. Every path to runtime data comes from here (see "Data directory" in DESIGN.md).
//
//   ~/.tagent/                 the default root (0700); TAGENT_HOME overrides it, T_AGENT_DATA_DIR is the old name and still works
//     db.sqlite (-wal, -shm)   the SQLite database (0600); T_AGENT_DB_PATH still overrides only this file
//     session-secret           the key that encrypts stored tokens and the authenticator (0600)
//     backups/                 database backups taken before an update
//     bin/frpc, frpc.toml      the tunnel client and its config (0600)
//     mindmaps/                one JSON file per mind map, and trash/ for deleted ones (0700, files 0600; not in the database backups)
//     browser-recordings/      recordings of the browser extension, JSON lines and a summary each (0700, files 0600; 14 days)
//     server.lock              the running server: pid, port, version, start time (one writer per folder)
//     migrated-from.json       written once when the data was copied from the old <install>/data folder
//
// The layout is the same as the old <install>/data folder, so an older version pointed at this folder with
// T_AGENT_DATA_DIR reads the same data.
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INSTALL_DIR = path.resolve(__dirname, '..');
const LEGACY_DIR = path.join(INSTALL_DIR, 'data');
const LEGACY_SECRET = 'dev-secret-change-me';
const DIR_MODE = 0o700;
const SECRET_MODE = 0o600;
// Not copied by the one-time move: old update backups (often gigabytes) stay where they are.
const NOT_COPIED = new Set(['backups']);
const STARTUP_ERRORS = new Set(['DATA_HOME_IN_TEST', 'DATA_SCHEMA_NEWER', 'DATA_LOCKED', 'DATA_COPY_FAILED']);

function startupError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function isStartupError(error) {
  return Boolean(error && STARTUP_ERRORS.has(error.code));
}

function expandHome(value, homedir) {
  return value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

// Pure: which folder holds the data. TAGENT_HOME wins over the old name T_AGENT_DATA_DIR.
function resolveDataHome({ env = process.env, homedir = os.homedir } = {}) {
  for (const name of ['TAGENT_HOME', 'T_AGENT_DATA_DIR']) {
    const value = String(env[name] || '').trim();
    if (value) return { root: path.resolve(expandHome(value, homedir)), source: name, explicit: true };
  }
  return { root: path.join(homedir(), '.tagent'), source: 'default', explicit: false };
}

function layout(root, env = process.env) {
  return {
    root,
    dbPath: env.T_AGENT_DB_PATH ? path.resolve(env.T_AGENT_DB_PATH) : path.join(root, 'db.sqlite'),
    backupsDir: path.join(root, 'backups'),
    mindmapsDir: path.join(root, 'mindmaps'),
    frpDir: root,
    secretPath: path.join(root, 'session-secret'),
    lockPath: path.join(root, 'server.lock'),
    markerPath: path.join(root, 'migrated-from.json'),
  };
}

// A test process (node --test, or a test file run directly) must never use the real ~/.tagent.
function runningTests(env = process.env, argv = process.argv) {
  return Boolean(env.NODE_TEST_CONTEXT) || /(\.test\.js|[\\/]test-[^\\/]*\.cjs)$/.test(String(argv[1] || ''));
}

function paths({ env = process.env, homedir = os.homedir, argv = process.argv } = {}) {
  const home = resolveDataHome({ env, homedir });
  if (!home.explicit && runningTests(env, argv)) {
    throw startupError('DATA_HOME_IN_TEST', 'Tests must set TAGENT_HOME (or T_AGENT_DATA_DIR) to a temporary folder; they must never use the real ~/.tagent.');
  }
  return { ...layout(home.root, env), source: home.source, explicit: home.explicit };
}

function manifest() {
  try { return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'VERSION.json'), 'utf8')); } catch { return {}; }
}

// The database schema generation this code writes (VERSION.json schema_version).
function codeSchemaVersion() {
  const value = Number(manifest().schema_version);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function newerSchemaError(dbPath, stored, supported) {
  return startupError('DATA_SCHEMA_NEWER',
    `The database ${dbPath} was written by a newer T-Agent (database schema ${stored}; this version supports up to ${supported}). `
    + 'Upgrade T-Agent to the latest version. To run this older version anyway, point TAGENT_HOME at another folder (it starts with empty data).',
    { stored, supported });
}

// Tighten a path that is open to the group or others. Returns true when it was changed.
function tighten(file, mode, log) {
  if (process.platform === 'win32') return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if ((stat.mode & 0o777 & ~mode) === 0) return false;
  fs.chmodSync(file, mode);
  if (log) log(`Data folder: ${file} was open to other users (mode ${(stat.mode & 0o777).toString(8)}); changed it to ${mode.toString(8)}.`);
  return true;
}

function secureDatabaseFiles(dbPath, log) {
  for (const suffix of ['', '-wal', '-shm']) tighten(dbPath + suffix, SECRET_MODE, log);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const stamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

// Size and modification time of the files a running writer changes; equal before and after a copy means the copy is consistent.
function signature(dir) {
  return ['db.sqlite', 'db.sqlite-wal'].map(name => {
    try { const s = fs.statSync(path.join(dir, name)); return `${name}:${s.size}:${s.mtimeMs}`; } catch { return `${name}:-`; }
  }).join('|');
}

function copyTree(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true, mode: DIR_MODE });
  for (const entry of fs.readdirSync(from)) {
    if (NOT_COPIED.has(entry) || skip(entry)) continue;
    fs.cpSync(path.join(from, entry), path.join(to, entry), { recursive: true, preserveTimestamps: true });
  }
}

// Remove half-finished copies left by a process that died (names end in -<pid>).
function removeStale(parent, prefix) {
  let entries = [];
  try { entries = fs.readdirSync(parent); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number(entry.slice(entry.lastIndexOf('-') + 1));
    if (!pidAlive(pid)) fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
  }
}

// One-time copy of the old <install>/data folder into the data home. The old folder is never changed: it is first copied as it is
// to <old>.backup-<time>, and the new folder is built from that copy in a temporary folder next to the target, so a crash leaves
// either nothing or a complete database. Returns { status: 'copied' | 'exists' | 'none' }.
// What a database holds that a person made (see "Data directory" in DESIGN.md). A fresh start fills some tables by itself
// (default groups, the single user, sessions, PM2 apps, the instance id, the unbound authenticator row, update and empty
// file-sync state, the access mode); those do not count. Returns a list like ['tasks: 3'], empty when there is no user data.
const DEFAULT_GROUPS = ['personal', 'doing', 'todo', 'done'];
const AUTOMATIC_STATE = ['update_state', 'single_user_id', 'file_sync_v1'];
const USER_DATA_QUERIES = [
  ['tasks', 'SELECT COUNT(*) FROM tasks'],
  ['task groups', `SELECT COUNT(*) FROM task_groups WHERE group_key NOT IN (${DEFAULT_GROUPS.map(() => '?').join(',')})`, DEFAULT_GROUPS],
  ['to-dos', 'SELECT COUNT(*) FROM task_todos'],
  ['terminals', 'SELECT COUNT(*) FROM task_terminals'],
  ['agent chats', 'SELECT COUNT(*) FROM agent_conversations'],
  ['quick links', 'SELECT COUNT(*) FROM bookmarks'],
  ['cleaned repositories', 'SELECT COUNT(*) FROM repo_cleanups'],
  ['remote Engines', 'SELECT COUNT(*) FROM remote_servers'],
  ['Engine access tokens', 'SELECT COUNT(*) FROM engine_access_tokens'],
  ['pairing codes', 'SELECT COUNT(*) FROM engine_pairing_codes'],
  ['remote API tokens', 'SELECT COUNT(*) FROM remote_access_tokens'],
  ['T-Attention items', 'SELECT COUNT(*) FROM attention_items'],
  ['T-Attention tokens', 'SELECT COUNT(*) FROM attention_tokens'],
  ['bound authenticator', 'SELECT COUNT(*) FROM client_auth WHERE secret_cipher IS NOT NULL'],
  ['working directory settings', 'SELECT COUNT(*) FROM users WHERE work_dir IS NOT NULL AND work_dir <> \'\''],
  ['settings', `SELECT COUNT(*) FROM system_state WHERE key NOT IN (${AUTOMATIC_STATE.map(() => '?').join(',')})`, AUTOMATIC_STATE],
  ['file sync', "SELECT COUNT(*) FROM system_state WHERE key = 'file_sync_v1' AND (json_extract(value, '$.masterId') IS NOT NULL OR json_array_length(json_extract(value, '$.files')) > 0)"],
];

function userDataIn(db) {
  const found = [];
  for (const [label, sql, params = []] of USER_DATA_QUERIES) {
    let count = 0;
    try { count = db.prepare(sql).pluck().get(...params); } catch { continue; } // a table an older database does not have yet
    if (count > 0) found.push(`${label}: ${count}`);
  }
  return found;
}

// Reads the user data of a database without opening the file itself: the database and its WAL are copied to a temporary folder
// first, so the old folder is never touched by SQLite.
function userDataOfCopy(dir, Database) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-inspect-'));
  try {
    for (const name of ['db.sqlite', 'db.sqlite-wal']) {
      if (fs.existsSync(path.join(dir, name))) fs.copyFileSync(path.join(dir, name), path.join(temp, name));
    }
    const db = new Database(path.join(temp, 'db.sqlite'));
    try { return userDataIn(db); } finally { db.close(); }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

// The result of the last check in this process, for the environment check: { status, root, legacy, rootData, legacyData }.
let lastCheck = { status: 'unknown' };
const dataHomeCheck = () => lastCheck;

// One-time copy of the old <install>/data folder into the data home. The old folder is never changed: it is first copied as it is
// to <old>.backup-<time>, and the new folder is built from that copy in a temporary folder next to the target, so a crash leaves
// either nothing or a complete database. Returns { status: 'copied' | 'exists' | 'conflict' | 'none' }.
//
// The data home already has a database, but it was not made by this copy (no migrated-from.json):
//   - it holds no user data and the old folder does: it was made by a server that started without the old data (for example a
//     development checkout). It is moved aside to <root>/empty-start-<time>/ and the old data is copied in as usual;
//   - both hold user data: nothing is guessed. The data home is used and a loud warning names both folders ('conflict').
function migrateLegacyData({ from, to, log = console.log, warn = console.warn, now = () => new Date(), Database = require('better-sqlite3'), attempts = 3 } = {}) {
  const target = layout(to, {});
  lastCheck = { status: 'none', root: to, legacy: from };
  if (fs.existsSync(target.dbPath)) {
    lastCheck.status = 'exists';
    if (!fs.existsSync(path.join(from, 'db.sqlite'))) return { status: 'exists' };
    if (fs.existsSync(target.markerPath)) {
      log(`Data folder: using ${to}. The old folder ${from} also has data; it is ignored and not changed.`);
      return { status: 'exists' };
    }
    const lock = readLock(target.lockPath);
    if (lock && lock.pid !== process.pid && pidAlive(lock.pid)) return { status: 'exists' }; // in use: the lock refuses this start
    const rootData = (() => { const db = new Database(target.dbPath, { readonly: true, fileMustExist: true }); try { return userDataIn(db); } finally { db.close(); } })();
    const legacyData = userDataOfCopy(from, Database);
    Object.assign(lastCheck, { rootData, legacyData });
    if (!legacyData.length) {
      log(`Data folder: using ${to}. The old folder ${from} has no user data; it is ignored and not changed.`);
      return { status: 'exists' };
    }
    if (rootData.length) {
      lastCheck.status = 'conflict';
      warn([
        '==================== T-Agent data folder warning ====================',
        `Two folders hold data and it is not known which one is yours:`,
        `  in use:  ${to} (${rootData.join(', ')})`,
        `  ignored: ${from} (${legacyData.join(', ')})`,
        `To use the old data instead: stop the server, move ${to} away (for example to ${to}.old), and start again; the old data is then copied in.`,
        `To keep both: set TAGENT_HOME=${from} in .env to use the old folder directly.`,
        '======================================================================',
      ].join('\n'));
      return { status: 'conflict' };
    }
    const aside = path.join(to, `empty-start-${stamp(now())}`);
    fs.mkdirSync(aside, { mode: DIR_MODE });
    for (const name of ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm', 'session-secret']) {
      if (fs.existsSync(path.join(to, name))) fs.renameSync(path.join(to, name), path.join(aside, name));
    }
    secrets.delete(target.secretPath);
    log(`Data folder: ${to} had a database without user data that was not copied from ${from} (made by a start without the old data); moved it to ${aside} and copying the old data in.`);
  }
  if (!fs.existsSync(path.join(from, 'db.sqlite'))) return { status: 'none' };

  const time = stamp(now());
  const parent = path.dirname(to);
  fs.mkdirSync(parent, { recursive: true });
  removeStale(parent, `${path.basename(to)}.partial-`);
  removeStale(path.dirname(from), `${path.basename(from)}.backup-`);
  const backup = `${from}.backup-${time}`;
  const backupPartial = `${backup}.partial-${process.pid}`;
  const stage = `${to}.partial-${time}-${process.pid}`;
  log(`Data folder: copying the data from ${from} to ${to} (one time; the old folder is kept unchanged).`);
  try {
    // 1. Backup copy of the old folder as it is. Retried when a running server changed the database during the copy.
    let stable = false;
    for (let attempt = 0; attempt < attempts && !stable; attempt += 1) {
      fs.rmSync(backupPartial, { recursive: true, force: true });
      const before = signature(from);
      copyTree(from, backupPartial);
      stable = before === signature(from);
    }
    if (!stable) throw new Error(`the database in ${from} kept changing while it was copied; stop the server that uses it and start again`);
    fs.renameSync(backupPartial, backup);

    // 2. Build the new folder from the backup. The -shm index is not copied (SQLite rebuilds it from the WAL).
    copyTree(backup, stage, entry => entry === 'db.sqlite-shm');
    const db = new Database(path.join(stage, 'db.sqlite'));
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      const check = db.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`the copied database failed its check (${check})`);
    } finally { db.close(); }
    const record = {
      source: from, backup, copied_at: now().toISOString(),
      app_version: manifest().app_version || null, schema_version: codeSchemaVersion(),
    };
    fs.writeFileSync(path.join(stage, 'migrated-from.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: SECRET_MODE });
    fs.chmodSync(stage, DIR_MODE);
    for (const name of ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm', 'frpc.toml']) tighten(path.join(stage, name), SECRET_MODE);

    // 3. Publish. A missing target is one atomic rename. Otherwise (the folder exists, but has no database) move the other
    // entries first and link the database last: link fails when another process published a database in the meantime.
    let published = false;
    if (!fs.existsSync(to)) {
      try { fs.renameSync(stage, to); published = true; } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error; }
    }
    if (!published) {
      for (const entry of fs.readdirSync(stage)) {
        if (entry === 'db.sqlite' || fs.existsSync(path.join(to, entry))) continue;
        fs.renameSync(path.join(stage, entry), path.join(to, entry));
      }
      try { fs.linkSync(path.join(stage, 'db.sqlite'), target.dbPath); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        log(`Data folder: another process already copied the data to ${to}; using that copy.`);
      }
      fs.rmSync(stage, { recursive: true, force: true });
    }
    lastCheck.status = 'copied';
    log(`Data folder: copied ${from} to ${to}. A backup of the old data is in ${backup}. The old folder is not used any more and was not changed.`);
    return { status: 'copied', backup };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(backupPartial, { recursive: true, force: true });
    throw startupError('DATA_COPY_FAILED', `Could not copy the data from ${from} to ${to}: ${error.message}. Nothing was changed in ${from}.`);
  }
}

const prepared = new Map();
const secrets = new Map();

// Makes the data folder ready: the one-time copy (only for the default folder), the folder itself (0700) and the modes of the
// secret files. Idempotent; runs once per folder in a process.
// T_AGENT_LEGACY_DATA_DIR only exists so that tests can point the one-time copy at a temporary old folder.
function prepare({ env = process.env, log = message => console.log(message), warn = message => console.warn(message), legacyDir = env.T_AGENT_LEGACY_DATA_DIR || LEGACY_DIR } = {}) {
  const info = paths({ env });
  if (prepared.has(info.root)) return prepared.get(info.root);
  if (!info.explicit && !env.T_AGENT_DB_PATH) migrateLegacyData({ from: legacyDir, to: info.root, log, warn });
  fs.mkdirSync(info.root, { recursive: true, mode: DIR_MODE });
  tighten(info.root, DIR_MODE, warn);
  for (const file of [info.secretPath, path.join(info.root, 'frpc.toml'), info.lockPath]) tighten(file, SECRET_MODE, warn);
  secureDatabaseFiles(info.dbPath, warn);
  fs.mkdirSync(path.dirname(info.dbPath), { recursive: true });
  prepared.set(info.root, info);
  return info;
}

// The session secret lives with the data, because the stored tokens and the authenticator are encrypted with it.
// First start: the SESSION_SECRET of .env is saved there (so existing encrypted data stays readable); without one, existing
// data keeps the old built-in default and a new folder gets a random secret. Later, the file wins over .env.
function sessionSecret({ env = process.env, warn = message => console.warn(message) } = {}) {
  const info = prepare({ env });
  const fromEnv = String(env.SESSION_SECRET || '');
  const cached = secrets.get(info.secretPath);
  if (cached !== undefined) return cached;
  let value = '';
  try { value = fs.readFileSync(info.secretPath, 'utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!value) {
    const created = fromEnv || (fs.existsSync(info.dbPath) ? LEGACY_SECRET : crypto.randomBytes(32).toString('hex'));
    try {
      fs.writeFileSync(info.secretPath, `${created}\n`, { mode: SECRET_MODE, flag: 'wx' });
      value = created;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      value = fs.readFileSync(info.secretPath, 'utf8').trim();
    }
  } else if (fromEnv && fromEnv !== value) {
    warn(`Data folder: SESSION_SECRET in .env is ignored; the secret saved in ${info.secretPath} is used, because the data in this folder is encrypted with it.`);
  }
  secrets.set(info.secretPath, value);
  return value;
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function lockedError(file, other, root) {
  const who = other
    ? `pid ${other.pid}, port ${other.port ?? '?'}, version ${other.version || '?'}, started ${other.started_at || '?'}, from ${other.install_dir || '?'}`
    : 'a server that is starting now';
  return startupError('DATA_LOCKED',
    `Another T-Agent server is already using the data folder ${root} (${who}). Stop it first (for example: pm2 stop t-agent), `
    + `or start this one with TAGENT_HOME set to another folder. If no such server is running, delete ${file}.`, { other });
}

// One server per data folder. The lock file is created with O_EXCL ('wx'); a lock whose pid is no longer running is taken over.
// Returns { file, update(fields), release() }; the lock is released when the process exits.
function acquireServerLock({ env = process.env, port = null, host = null, isAlive = pidAlive, log = message => console.log(message), now = () => new Date() } = {}) {
  const info = prepare({ env });
  const file = info.lockPath;
  let record = {
    pid: process.pid, port, host, version: manifest().app_version || null,
    started_at: now().toISOString(), install_dir: INSTALL_DIR,
  };
  const write = () => {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: SECRET_MODE });
    fs.renameSync(temp, file);
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: SECRET_MODE, flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const other = readLock(file);
    if (other && other.pid === process.pid) { write(); break; }
    if (other && isAlive(other.pid)) throw lockedError(file, other, info.root);
    if (!other) {
      // Unreadable: a server may be writing it right now. Only a file older than a few seconds counts as left over.
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      if (age < 5000) throw lockedError(file, null, info.root);
    }
    // Move the stale lock aside and check that it is still the stale one (another starting server may have replaced it).
    const aside = `${file}.stale-${process.pid}`;
    try { fs.renameSync(file, aside); } catch { continue; }
    const moved = readLock(aside);
    if (moved && other && moved.pid !== other.pid && isAlive(moved.pid)) {
      try { fs.linkSync(aside, file); } catch {}
      fs.rmSync(aside, { force: true });
      throw lockedError(file, moved, info.root);
    }
    fs.rmSync(aside, { force: true });
    log(`Data folder: removed a stale lock ${file} (${other ? `pid ${other.pid} is not running` : 'unreadable'}).`);
    if (attempt === 2) throw lockedError(file, null, info.root);
  }
  const release = () => {
    const current = readLock(file);
    if (current && current.pid === process.pid) fs.rmSync(file, { force: true });
  };
  process.on('exit', release);
  return {
    file,
    update(fields) { record = { ...record, ...fields }; write(); },
    release() { process.removeListener('exit', release); release(); },
  };
}

module.exports = {
  INSTALL_DIR, LEGACY_DIR, LEGACY_SECRET,
  resolveDataHome, layout, paths, prepare, migrateLegacyData, sessionSecret, acquireServerLock,
  codeSchemaVersion, newerSchemaError, userDataIn, dataHomeCheck, secureDatabaseFiles, tighten, pidAlive, runningTests, isStartupError,
};
