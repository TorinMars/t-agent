// Peer file access (read only): what a linked Engine may see of this machine through /v1/peer-fs (routes/peer-fs.js). See "Peer file access" in
// DESIGN.md.
//
// Scope: the home folder of the terminal user (lib/terminal-user.js; the service's own home when there is no drop), without sensitive paths
// (DENIED_* below, the T-Agent data folder and its database). A path is checked twice: as written (so ~/.ssh/x is refused before anything is read,
// and a missing file under a denied folder is not told apart from an existing one) and after realpath (so a symbolic link cannot point out of the
// home folder or into a denied path). A listing leaves denied entries out; a search skips them, `.git`, `node_modules` and binary files.
//
// When the service runs as root and drops the terminal to TERMINAL_USER, list and read run in a child process with that uid/gid
// (scripts/peer-fs-child.js), so nothing that user cannot read is returned. A search always runs in a child (with the uid/gid when there is a drop):
// a regular expression that backtracks without end, or a slow disk, can then be stopped by killing it, and the matches found until then are kept.
//
// This module does not open the database: the child process requires it too.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LIST_MAX_ENTRIES = 1000;
const LIST_SCAN_MAX = 20_000;
const READ_DEFAULT_LIMIT = 256 * 1024;
const READ_MAX_LIMIT = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_FILES = 20_000;
const SEARCH_TIME_MS = 10_000;
const SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024;
const SEARCH_LINE_CHARS = 400;
const PATTERN_MAX = 200;
const OP_TIMEOUT_MS = 10_000;
const CHILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'peer-fs-child.js');
const CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';

// Error codes, their status and the English message (Chinese in public/js/i18n-zh-server.js).
const ERRORS = {
  INVALID_PATH: [400, 'The path must be absolute or start with ~'],
  INVALID_PATTERN: [400, 'The search pattern is empty, longer than 200 characters or not a valid regular expression'],
  INVALID_ARGUMENT: [400, 'offset and limit must be whole numbers, and limit at least 1'],
  IS_DIRECTORY: [400, 'This path is a folder'],
  NOT_A_DIRECTORY: [400, 'This path is not a folder'],
  NOT_A_REGULAR_FILE: [400, 'Only regular files can be opened'],
  PATH_NOT_ALLOWED: [403, 'Linked engines cannot read this path: it is outside the home folder or holds sensitive data'],
  PERMISSION_DENIED: [403, 'Permission denied: the terminal user cannot read this file'],
  PEER_FS_DISABLED: [403, 'File access for linked engines is turned off on that engine'],
  NOT_FOUND: [404, 'The file or folder does not exist'],
  BINARY_FILE: [415, 'This is a binary file, not text'],
  PEER_FS_READ_FAILED: [500, 'The file or folder could not be read'],
  READ_TIMEOUT: [504, 'Reading the file took longer than 10 seconds'],
};

function failure(code, cause) {
  const known = ERRORS[code] ? code : 'PEER_FS_READ_FAILED';
  const error = new Error(known);
  error.statusCode = ERRORS[known][0];
  if (cause) error.cause = cause;
  return error;
}

function mapFsError(error) {
  if (error && error.statusCode && ERRORS[error.message]) return error;
  const code = error && error.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return failure('NOT_FOUND', error);
  if (code === 'EACCES' || code === 'EPERM') return failure('PERMISSION_DENIED', error);
  if (code === 'EISDIR') return failure('IS_DIRECTORY', error);
  if (code === 'ENAMETOOLONG') return failure('INVALID_PATH', error);
  return failure('PEER_FS_READ_FAILED', error);
}

function errorBody(error) {
  const code = error && ERRORS[error.message] ? error.message : 'PEER_FS_READ_FAILED';
  return { status: ERRORS[code][0], body: { error: code, message: ERRORS[code][1] } };
}

// \u2500\u2500 The denylist \u2500\u2500
// A path is denied when any of its segments (below the home folder, compared without regard to case) is one of these names, ...
const DENIED_NAMES = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.password-store', '.tagent',
  '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.env',
]);
// ... matches one of these name patterns, ...
const DENIED_PATTERNS = [/^\.env\./, /\.pem$/, /\.key$/, /^id_rsa/, /^id_ed25519/, /\.p12$/, /\.pfx$/, /\.keystore$/];
// ... or when these segments follow each other anywhere in it.
const DENIED_SEQUENCES = [['.config', 'gh'], ['library', 'keychains'], ['.claude', '.credentials.json'], ['.codex', 'auth.json']];

const deniedName = name => {
  const lower = String(name).toLowerCase();
  return DENIED_NAMES.has(lower) || DENIED_PATTERNS.some(pattern => pattern.test(lower));
};

function deniedSegments(segments) {
  const lower = segments.map(part => part.toLowerCase());
  if (lower.some(deniedName)) return true;
  return DENIED_SEQUENCES.some(sequence => lower.some((part, index) => sequence.every((name, offset) => lower[index + offset] === name)));
}

// The same rules as ripgrep globs (case-insensitive), so rg does not even open what would be thrown away.
const RG_DENY_GLOBS = [
  ...[...DENIED_NAMES].map(name => `!${name}`),
  '!.env.*', '!*.pem', '!*.key', '!id_rsa*', '!id_ed25519*', '!*.p12', '!*.pfx', '!*.keystore',
  ...DENIED_SEQUENCES.map(sequence => `!**/${sequence.join('/')}`),
  '!.git', '!node_modules',
];

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

function realOr(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

// The policy of one request, made where the files are read: { home, homes (the home as written and after realpath), deniedRoots (each as written
// and after realpath) }. `spec` is { home, deniedRoots } (plain strings, so it can be handed to the child as JSON).
function makePolicy(spec) {
  const home = path.resolve(spec.home);
  const homes = [...new Set([home, realOr(home)])];
  const deniedRoots = [...new Set((spec.deniedRoots || []).filter(Boolean).flatMap(root => [path.resolve(root), realOr(root)]))];
  return { home, homes, deniedRoots };
}

// 'outside', 'denied' or null for an absolute, normalised path.
function verdict(policy, absolute) {
  const home = policy.homes.find(candidate => inside(absolute, candidate));
  if (!home) return 'outside';
  if (policy.deniedRoots.some(root => inside(absolute, root))) return 'denied';
  const relative = absolute === home ? '' : absolute.slice(home.length).replace(/^\/+/, '');
  if (relative && deniedSegments(relative.split('/'))) return 'denied';
  return null;
}

const allowed = (policy, absolute) => verdict(policy, absolute) === null;

// The absolute path a request names: an absolute path, or '~' / '~/...'. Nothing given means the home folder.
function requestedPath(policy, value) {
  if (value === undefined || value === null || value === '') return policy.home;
  if (typeof value !== 'string' || value.includes('\0') || value.length > 4096) throw failure('INVALID_PATH');
  if (value === '~' || value.startsWith('~/')) return path.posix.resolve(path.posix.join(policy.home, value.slice(1)));
  if (value.startsWith('/')) return path.posix.resolve(value);
  throw failure('INVALID_PATH');
}

// { requested, real } of an allowed path, or throws PATH_NOT_ALLOWED / NOT_FOUND. The written path is checked before anything is read.
async function resolveAllowed(policy, value) {
  const requested = requestedPath(policy, value);
  if (!allowed(policy, requested)) throw failure('PATH_NOT_ALLOWED');
  let real;
  try { real = await fs.promises.realpath(requested); } catch (error) { throw mapFsError(error); }
  if (!allowed(policy, real)) throw failure('PATH_NOT_ALLOWED');
  return { requested, real };
}

// \u2500\u2500 List \u2500\u2500
const typeOf = entry => (entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other');

async function list(policy, value) {
  const { requested, real } = await resolveAllowed(policy, value);
  let stat;
  try { stat = await fs.promises.stat(real); } catch (error) { throw mapFsError(error); }
  if (!stat.isDirectory()) throw failure('NOT_A_DIRECTORY');
  const names = [];
  let truncated = false;
  let dir;
  try {
    dir = await fs.promises.opendir(real);
    for await (const entry of dir) {
      if (names.length >= LIST_SCAN_MAX) { truncated = true; break; }
      if (deniedName(entry.name) || !allowed(policy, path.join(real, entry.name)) || !allowed(policy, path.join(requested, entry.name))) continue;
      names.push({ name: entry.name, type: typeOf(entry) });
    }
  } catch (error) {
    throw mapFsError(error);
  } finally {
    // A `for await` that ran to the end closed the folder itself; closing it again throws.
    if (dir) await dir.close().catch(() => {});
  }
  names.sort((a, b) => ((a.type === 'dir') === (b.type === 'dir') ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'dir' ? -1 : 1));
  const entries = [];
  for (const item of names) {
    if (entries.length >= LIST_MAX_ENTRIES) { truncated = true; break; }
    const full = path.join(real, item.name);
    if (item.type === 'symlink') {
      // A link that leads out of the home folder or into a denied path is left out like the path itself.
      let target;
      try { target = await fs.promises.realpath(full); } catch { target = null; }
      if (target && !allowed(policy, target)) continue;
    }
    let info = null;
    try { info = await fs.promises.lstat(full); } catch { /* removed meanwhile */ }
    if (!info) continue;
    entries.push({ name: item.name, type: item.type, size: info.size, mtime: info.mtime.toISOString() });
  }
  return { path: requested, entries, truncated };
}

// \u2500\u2500 Read \u2500\u2500
function wholeNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (!/^\d{1,16}$/.test(text)) throw failure('INVALID_ARGUMENT');
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw failure('INVALID_ARGUMENT');
  return number;
}

// How many bytes at the end of `buffer` start a UTF-8 character that is not complete (0 to 3).
function incompleteTail(buffer) {
  for (let back = 1; back <= Math.min(3, buffer.length); back += 1) {
    const byte = buffer[buffer.length - back];
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: look further back
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

const isPseudoFile = (real, stat) => stat.size === 0 && /^\/(proc|sys)(\/|$)/.test(real);

async function read(policy, value, { offset: rawOffset, limit: rawLimit } = {}) {
  const offset = wholeNumber(rawOffset, 0);
  const limit = Math.min(wholeNumber(rawLimit, READ_DEFAULT_LIMIT), READ_MAX_LIMIT);
  if (limit < 1) throw failure('INVALID_ARGUMENT');
  const { requested, real } = await resolveAllowed(policy, value);
  let stat;
  try { stat = await fs.promises.stat(real); } catch (error) { throw mapFsError(error); }
  if (stat.isDirectory()) throw failure('IS_DIRECTORY');
  if (!stat.isFile() || isPseudoFile(real, stat)) throw failure('NOT_A_REGULAR_FILE');
  let handle;
  try {
    // O_NONBLOCK: a FIFO put in the file's place after the check must not make the open wait for a writer.
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw failure('NOT_A_REGULAR_FILE');
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, opened.size));
    const { bytesRead: sniffed } = sniff.length ? await handle.read(sniff, 0, sniff.length, 0) : { bytesRead: 0 };
    if (sniff.subarray(0, sniffed).includes(0)) throw failure('BINARY_FILE');
    const size = opened.size;
    const want = Math.max(0, Math.min(limit, size - offset));
    const buffer = Buffer.alloc(want);
    let length = 0;
    while (length < want) {
      const { bytesRead } = await handle.read(buffer, length, want - length, offset + length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    let data = buffer.subarray(0, length);
    let truncated = offset + length < size;
    // A cut in the middle of a character is moved back to its start, so the next read (at next_offset) begins with it.
    if (truncated) {
      const tail = incompleteTail(data);
      if (tail && tail < data.length) data = data.subarray(0, data.length - tail);
    }
    truncated = offset + data.length < size;
    return {
      path: requested, content: data.toString('utf8'), size, offset, truncated, encoding: 'utf8',
      next_offset: truncated ? offset + data.length : null,
    };
  } catch (error) {
    throw mapFsError(error);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// \u2500\u2500 Search \u2500\u2500
const flag = value => value === true || value === '1' || value === 'true';

// Checked where the request arrives, so a bad pattern is a 400 before any process starts. Returns the normalised search options.
function searchOptions({ pattern, glob, ignore_case: ignoreCase, regex } = {}) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > PATTERN_MAX || pattern.includes('\0')) throw failure('INVALID_PATTERN');
  const options = { pattern, regex: flag(regex), ignoreCase: flag(ignoreCase), glob: null };
  if (options.regex) {
    try { new RegExp(pattern, options.ignoreCase ? 'iu' : 'u'); } catch { throw failure('INVALID_PATTERN'); }
  }
  if (glob !== undefined && glob !== null && glob !== '') {
    if (typeof glob !== 'string' || glob.length > PATTERN_MAX || glob.includes('\0')) throw failure('INVALID_PATTERN');
    try { globToRegExp(glob); } catch { throw failure('INVALID_PATTERN'); }
    options.glob = glob;
  }
  return options;
}

// A glob as ripgrep reads one: without a slash it is matched against the file name, with one against the path below the searched folder.
// `*` and `?` stay within one segment, `**` crosses them, `{a,b}` is a choice and `[...]` a character class.
function globToRegExp(glob) {
  let out = '';
  let depth = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') { index += 1; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else if (char === '{') { depth += 1; out += '(?:'; }
    else if (char === '}' && depth) { depth -= 1; out += ')'; }
    else if (char === ',' && depth) out += '|';
    else if (char === '[') {
      const end = glob.indexOf(']', index + 2);
      if (end < 0) { out += '\\['; continue; }
      let body = glob.slice(index + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      index = end;
    } else out += char.replace(/[.+^$()|\\/]/g, '\\$&');
  }
  if (depth) throw new Error('unbalanced');
  return new RegExp(`^${out}$`, 'i');
}

const trimLine = text => {
  const line = String(text).replace(/\r?\n$/, '');
  return line.length > SEARCH_LINE_CHARS ? `${line.slice(0, SEARCH_LINE_CHARS)}\u2026` : line;
};

function lineMatcher(options) {
  if (options.regex) {
    const expression = new RegExp(options.pattern, options.ignoreCase ? 'iu' : 'u');
    return line => expression.test(line);
  }
  if (options.ignoreCase) {
    const needle = options.pattern.toLowerCase();
    return line => line.toLowerCase().includes(needle);
  }
  return line => line.includes(options.pattern);
}

// The search in this process (normally the child): `emit(match)` for each match; resolves { truncated }.
async function runSearch(policy, value, rawOptions, { emit, rgPath = null, deadline = Date.now() + SEARCH_TIME_MS } = {}) {
  const options = searchOptions(rawOptions);
  const { requested, real } = await resolveAllowed(policy, value);
  let stat;
  try { stat = await fs.promises.stat(real); } catch (error) { throw mapFsError(error); }
  const state = { count: 0, emit };
  if (rgPath && !options.regex) {
    const result = await searchWithRg(policy, requested, real, stat.isDirectory(), options, state, { rgPath, deadline });
    if (result) return result;
  }
  return searchWithNode(policy, requested, real, stat, options, state, deadline);
}

// The path a match is reported under: below the folder as it was asked for (a path through a symbolic link to the home folder stays readable).
const reported = (requested, real, file) => (file === real ? requested : path.join(requested, path.relative(real, file)));

function globAccepts(globRegExp, glob, relative) {
  if (!globRegExp) return true;
  return globRegExp.test(glob.includes('/') ? relative : path.basename(relative));
}

async function searchWithNode(policy, requested, real, rootStat, options, state, deadline) {
  const match = lineMatcher(options);
  const globRegExp = options.glob ? globToRegExp(options.glob) : null;
  let files = 0;
  let truncated = false;
  const scanFile = async (file, size) => {
    if (size > SEARCH_MAX_FILE_BYTES) return;
    let data;
    try { data = await fs.promises.readFile(file); } catch { return; }
    if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return;
    const lines = data.toString('utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!match(lines[index])) continue;
      if (state.count >= SEARCH_MAX_MATCHES) { truncated = true; return; }
      state.count += 1;
      state.emit({ path: reported(requested, real, file), line: index + 1, text: trimLine(lines[index]) });
    }
  };
  if (!rootStat.isDirectory()) {
    if (rootStat.isFile()) await scanFile(real, rootStat.size);
    return { truncated };
  }
  const queue = [real];
  while (queue.length && !truncated) {
    const dir = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (Date.now() > deadline || files >= SEARCH_MAX_FILES) { truncated = true; break; }
      const lower = entry.name.toLowerCase();
      if (lower === '.git' || lower === 'node_modules' || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (!allowed(policy, full) || !allowed(policy, reported(requested, real, full))) continue;
      if (entry.isDirectory()) { queue.push(full); continue; }
      if (!entry.isFile() || !globAccepts(globRegExp, options.glob || '', path.relative(real, full))) continue;
      files += 1;
      let info;
      try { info = await fs.promises.stat(full); } catch { continue; }
      await scanFile(full, info.size);
      if (truncated) break;
    }
  }
  return { truncated };
}

// ripgrep for a literal pattern: --no-config (no settings file of the user changes the output), JSON output, fixed strings, hidden files
// included but the denylist, .git and node_modules excluded as globs; .gitignore files are honoured. Every match is checked against the
// policy again. Resolves { truncated }, or null when rg could not run (the Node walk takes over).
function searchWithRg(policy, requested, real, isDirectory, options, state, { rgPath, deadline }) {
  const args = ['--no-config', '--json', '--hidden', '--no-messages', '--fixed-strings', '--max-filesize', String(SEARCH_MAX_FILE_BYTES),
    options.ignoreCase ? '--ignore-case' : '--case-sensitive'];
  if (options.glob) args.push('--glob', options.glob);
  for (const glob of RG_DENY_GLOBS) args.push('--iglob', glob);
  args.push('--regexp', options.pattern, '--', real);
  return new Promise(resolve => {
    let child;
    try { child = spawn(rgPath, args, { cwd: isDirectory ? real : path.dirname(real), stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve(null); return; }
    let truncated = false;
    let started = false;
    let pending = '';
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const stop = () => { truncated = true; if (child.exitCode === null) child.kill('SIGKILL'); };
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    const onLine = line => {
      if (!line || truncated) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || message.type !== 'match' || !message.data) return;
      const file = message.data.path && message.data.path.text;
      const text = message.data.lines && message.data.lines.text;
      if (typeof file !== 'string' || typeof text !== 'string') return;
      const absolute = path.resolve(real, file);
      if (!allowed(policy, absolute) || !allowed(policy, reported(requested, real, absolute)) || absolute.split('/').some(part => part === '.git' || part.toLowerCase() === 'node_modules')) return;
      if (state.count >= SEARCH_MAX_MATCHES) { stop(); return; }
      state.count += 1;
      state.emit({ path: reported(requested, real, absolute), line: message.data.line_number, text: trimLine(text) });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      started = true;
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    });
    child.on('error', () => finish(started ? { truncated } : null));
    child.on('close', code => {
      if (pending) onLine(pending);
      // 0: matches, 1: none, 2: some files could not be read (the matches stand). Anything else without output: rg is not usable.
      if (!started && code !== 0 && code !== 1 && code !== 2 && !truncated) finish(null);
      else finish({ truncated });
    });
  });
}

// \u2500\u2500 Running it as the terminal user \u2500\u2500
// Resolves { code, signal, stdout, timedOut, overflow } or { error }; the shape of services/fs-read.js spawnRunner.
function defaultRunner(options) {
  return require('./fs-read').spawnRunner(options);
}

function defaultTerminalUser() {
  return require('../lib/terminal-user').resolveTerminalUser().user;
}

// The T-Agent data folder and its database (and the old <install>/data folder), never readable by a peer.
function defaultDeniedRoots() {
  const roots = [path.join(__dirname, '..', 'data')];
  try {
    const paths = require('../lib/data-home').paths();
    roots.push(paths.root, paths.dbPath, paths.secretPath);
  } catch { /* a test process without a data folder */ }
  for (const name of ['TAGENT_HOME', 'T_AGENT_DATA_DIR', 'T_AGENT_DB_PATH']) {
    if (process.env[name]) roots.push(path.resolve(process.env[name]));
  }
  return roots;
}

let rgFinder = null;
function defaultRgPath() {
  if (!rgFinder) rgFinder = require('../lib/find-program').makeFinder('rg', { envVar: 'RG_PATH' });
  return rgFinder.executablePath();
}

function childEnv(user) {
  const base = { PATH: CHILD_PATH };
  return user ? require('../lib/terminal-user').terminalEnvFor(user, base) : { ...base, HOME: process.env.HOME || os.homedir() };
}

// Parses the child's output: JSON lines, `{ match }` for each search match, then `{ result }` or `{ error }`.
function parseChild(result, { partialOnTimeout = false } = {}) {
  if (!result || result.error) throw failure('PEER_FS_READ_FAILED', result && result.error);
  const text = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : '';
  const matches = [];
  let final = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message && message.match) matches.push(message.match);
    else if (message && (message.result || message.error)) final = message;
  }
  if (final && final.error) throw failure(String(final.error));
  if (result.timedOut || result.overflow) {
    if (partialOnTimeout) return { matches, truncated: true };
    throw failure(result.timedOut ? 'READ_TIMEOUT' : 'PEER_FS_READ_FAILED');
  }
  if (!final || result.code !== 0) throw failure('PEER_FS_READ_FAILED');
  return partialOnTimeout ? { matches, truncated: Boolean(final.result.truncated) } : final.result;
}

// `terminalUser()` gives the dropped terminal user ({ name, uid, gid, home }) or null; `homeDir()` the home folder without a drop.
function createPeerFs({
  terminalUser = defaultTerminalUser,
  homeDir = () => process.env.HOME || os.homedir(),
  deniedRoots = defaultDeniedRoots,
  runner = defaultRunner,
  rgPath = defaultRgPath,
  timeoutMs = OP_TIMEOUT_MS,
  searchTimeMs = SEARCH_TIME_MS,
} = {}) {
  const spec = () => {
    const user = terminalUser();
    return { user, policy: { home: path.resolve(user ? user.home : homeDir()), deniedRoots: deniedRoots() } };
  };

  async function inChild(user, op, value, options, { partialOnTimeout = false, limitMs = timeoutMs } = {}) {
    const payload = JSON.stringify({ policy: spec().policy, value: value === undefined ? null : value, options });
    const result = await runner({
      command: process.execPath,
      args: [CHILD_SCRIPT, op, payload],
      ...(user ? { uid: user.uid, gid: user.gid } : {}),
      cwd: '/',
      env: childEnv(user),
      timeoutMs: limitMs,
      maxBytes: 8 * 1024 * 1024,
    });
    return parseChild(result, { partialOnTimeout });
  }

  const withLimit = (promise, limitMs) => {
    let timer;
    return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(failure('READ_TIMEOUT')), limitMs); })])
      .finally(() => clearTimeout(timer));
  };

  return {
    home: () => spec().policy.home,
    async list(value) {
      const { user, policy } = spec();
      if (user) return inChild(user, 'list', value, {});
      return withLimit(list(makePolicy(policy), value), timeoutMs);
    },
    async read(value, options = {}) {
      const { user, policy } = spec();
      const clean = { offset: options.offset, limit: options.limit };
      if (user) return inChild(user, 'read', value, clean);
      return withLimit(read(makePolicy(policy), value, clean), timeoutMs);
    },
    async search(value, rawOptions = {}) {
      const options = searchOptions(rawOptions); // a 400 before any process starts
      const { user } = spec();
      const childOptions = { pattern: options.pattern, glob: options.glob, ignore_case: options.ignoreCase, regex: options.regex, rgPath: rgPath(), timeMs: searchTimeMs };
      const { matches, truncated } = await inChild(user, 'search', value, childOptions, { partialOnTimeout: true, limitMs: searchTimeMs + 2000 });
      return { matches: matches.slice(0, SEARCH_MAX_MATCHES), truncated: truncated || matches.length > SEARCH_MAX_MATCHES };
    },
  };
}

module.exports = {
  ERRORS, LIST_MAX_ENTRIES, LIST_SCAN_MAX, READ_DEFAULT_LIMIT, READ_MAX_LIMIT, SEARCH_MAX_MATCHES, SEARCH_MAX_FILES, SEARCH_LINE_CHARS, PATTERN_MAX,
  CHILD_SCRIPT, RG_DENY_GLOBS,
  failure, mapFsError, errorBody, makePolicy, verdict, deniedName, requestedPath, resolveAllowed, globToRegExp, searchOptions,
  list, read, runSearch, createPeerFs, defaultDeniedRoots, defaultRgPath,
};
