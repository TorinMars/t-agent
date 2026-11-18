// The T-Attention desktop window (macOS): its settings and the launcher that builds and starts the native window (widgets/macos/*.swift, entry point
// in main.swift).
// See "T-Attention desktop window (macOS)" in DESIGN.md.
//
// Settings (system_state, one key, nothing secret): `enabled` (default true), `language` ('auto' | 'en' | 'zh', default 'auto') and the window
// preferences `hotkeys`, `dim_when_idle`, `show_activity` (booleans, default true; the window reads them at GET /prefs). 'auto' follows the
// language of this person's T-Agent page, which the server learns from the page's `ta-lang` cookie (lib/static-assets.js wantsChinese) each time the page
// or the window settings are loaded, and keeps in system_state; before the page was ever opened it is English.
//
// Launcher, on macOS only and when the switch is on: after the server listens, `start({ url })` finds swiftc (`xcode-select -p`, then `xcrun --find
// swiftc`, so a Mac without the command line tools never shows the system's install dialog), builds the window from every widgets/macos/*.swift file
// (sorted by name) into <data folder>/widget/ when the binary is missing, older than the newest source file, made from another set of files or by
// another T-Agent version (to a temporary name, then renamed; 600 s at most), and spawns it with
// `--parent-pid <server pid>`, TA_WIDGET_URL and a new TA_WIDGET_TOKEN (32 random bytes, base64url, kept only in memory; the widget API checks it). It
// never blocks the start and never throws: a failure is one log line and `last_error`. A window that exits on its own (the person quit it, or it
// crashed) is not started again until the switch is turned off and on, or the server restarts. Turning the switch off sends SIGTERM; so does the
// server's shutdown (the window also exits when its parent process is gone). Never started with NODE_ENV=test, TA_WIDGET_DISABLED=1, in CI, or inside a
// T-Agent terminal (a server started by an agent there is a test or development copy).
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const nodeFs = require('node:fs');
const path = require('node:path');
const syncStore = require('./settings-sync-store');

const SETTINGS_KEY = 'attention_widget_settings_v1';
const PAGE_LANGUAGE_KEY = 'attention_widget_page_language_v1';
const LANGUAGES = ['auto', 'en', 'zh'];
// The window's preferences (booleans, default true): global shortcuts, fading when idle, the working agents section.
const PREFS = ['hotkeys', 'dim_when_idle', 'show_activity'];
const BINARY = 't-attention-widget';
const BUILD_TIMEOUT_MS = 600 * 1000;
const LOOKUP_TIMEOUT_MS = 10 * 1000;
const MISSING_TOOLS_MS = 30 * 1000; // a missing swiftc is looked for again after this (the person may have installed the tools meanwhile)
const STDERR_KEEP = 2048;
const SOURCE_DIR = path.join(__dirname, '..', 'widgets', 'macos');
// Source files of older versions. An archive update copies the new files over the old ones and deletes nothing, so the single-file source of v2.132.0
// and older stays next to the new files there; built together with them it would define everything twice (and a second entry point).
const RETIRED_SOURCES = new Set(['TAttentionWidget.swift']);

class WidgetError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function createWidgetSettings({ db }) {
  const readKey = key => {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  };
  const writeKey = (key, value) => db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, JSON.stringify(value));
  let pageLanguageSeen;

  function read() {
    const stored = readKey(SETTINGS_KEY) || {};
    return {
      enabled: stored.enabled !== false,
      language: LANGUAGES.includes(stored.language) ? stored.language : 'auto',
      ...Object.fromEntries(PREFS.map(name => [name, stored[name] !== false])),
    };
  }
  // The preferences the window reads (GET /api/attention/widget/prefs).
  const prefs = () => { const current = read(); return Object.fromEntries(PREFS.map(name => [name, current[name]])); };
  // { enabled?, language?, hotkeys?, dim_when_idle?, show_activity? } -> the saved settings. Anything else in the body is ignored.
  function save(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WidgetError('VALIDATION_FAILED', 'The request body must be a JSON object');
    const next = read();
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new WidgetError('VALIDATION_FAILED', 'enabled must be true or false');
      next.enabled = body.enabled;
    }
    for (const name of PREFS) {
      if (body[name] === undefined) continue;
      if (typeof body[name] !== 'boolean') throw new WidgetError('VALIDATION_FAILED', `${name} must be true or false`);
      next[name] = body[name];
    }
    if (body.language !== undefined) {
      if (!LANGUAGES.includes(body.language)) throw new WidgetError('VALIDATION_FAILED', `language must be one of: ${LANGUAGES.join(', ')}`);
      next.language = body.language;
    }
    writeKey(SETTINGS_KEY, next);
    if (body.language !== undefined) syncStore.settingChanged(SYNC_GROUP);
    return next;
  }
  // The language of the page this person last loaded (true: Chinese). Written only when it changes.
  function notePageLanguage(zh) {
    const value = zh ? 'zh' : 'en';
    if (pageLanguageSeen === undefined) pageLanguageSeen = readKey(PAGE_LANGUAGE_KEY);
    if (pageLanguageSeen === value) return;
    pageLanguageSeen = value;
    try { writeKey(PAGE_LANGUAGE_KEY, value); } catch { /* remembered in memory only */ }
  }
  function pageLanguage() {
    if (pageLanguageSeen === undefined) pageLanguageSeen = readKey(PAGE_LANGUAGE_KEY);
    return pageLanguageSeen === 'zh' ? 'zh' : 'en';
  }
  // The language the window shows: the setting, or the page's for 'auto'.
  const language = () => { const { language: chosen } = read(); return chosen === 'auto' ? pageLanguage() : chosen; };

  return { read, prefs, save, notePageLanguage, pageLanguage, language };
}

// Why the window is never started in this process, or null. A platform other than macOS is `platform_supported: false`, not a reason here.
function blockedReason(env) {
  if (env.NODE_ENV === 'test') return 'Not started: the server runs in test mode';
  if (env.TA_WIDGET_DISABLED === '1') return 'Not started: TA_WIDGET_DISABLED=1';
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return 'Not started: the server runs in CI';
  // A server an agent started by hand inside a T-Agent terminal is a development copy. A server under PM2 (`pm_id`) is the real service even
  // when the PM2 daemon was first started from a T-Agent terminal and handed that terminal's variables on to everything it starts.
  if ((env.TA_PEER_TASK || env.TA_HOOK_TOKEN) && env.pm_id === undefined) return 'Not started: the server runs inside a T-Agent terminal';
  return null;
}

// The window's source files in `dir`: every *.swift file but the retired ones, sorted by name (a stable order for swiftc), as absolute paths.
function widgetSources(dir = SOURCE_DIR, fs = nodeFs) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(name => name.endsWith('.swift') && !RETIRED_SOURCES.has(name)).sort().map(name => path.join(dir, name));
}

function createWidgetLauncher({
  settings,
  dataDir,
  sourceDir = SOURCE_DIR,
  sourcePath = null, // one file instead of the folder (it then needs no main.swift)
  version = require('../VERSION.json').app_version,
  platform = process.platform,
  env = process.env,
  pid = process.pid,
  spawn = childProcess.spawn,
  execFile = childProcess.execFile,
  fs = nodeFs,
  randomToken = () => crypto.randomBytes(32).toString('base64url'),
  log = message => console.warn(message),
  now = Date.now,
} = {}) {
  if (!settings) throw new Error('createWidgetLauncher needs the settings');
  if (!dataDir) throw new Error('createWidgetLauncher needs the data folder');
  const folder = path.join(dataDir, 'widget');
  const binary = path.join(folder, BINARY);
  const stampFile = path.join(folder, `${BINARY}.json`);
  const supported = platform === 'darwin';
  const blocked = blockedReason(env);
  let url = null; // set by start(): nothing is launched before the server listens
  let child = null;
  let token = null;
  let quit = false; // the window exited on its own: not started again until the switch goes off and on
  let pending = null; // the running find / build / launch
  let lastError = null;
  let swiftc; // undefined: not looked for yet; null: missing (looked for at `swiftcCheckedAt`); else its path
  let swiftcCheckedAt = 0;
  let sdkRoot = null; // the macOS SDK path from xcrun, passed to swiftc as SDKROOT

  const run = (file, args, options) => new Promise(resolve => {
    try {
      execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch (error) { resolve({ error, stdout: '', stderr: '' }); }
  });
  const firstLine = text => String(text || '').split('\n').map(line => line.trim()).find(Boolean) || '';

  // The path of swiftc, or null. Never runs /usr/bin/swiftc itself: on a Mac without the command line tools that stub opens the install dialog.
  async function findSwiftc() {
    if (!supported) return null;
    if (swiftc) return swiftc;
    if (swiftc === null && now() - swiftcCheckedAt < MISSING_TOOLS_MS) return null;
    swiftcCheckedAt = now();
    swiftc = null;
    const developer = await run('/usr/bin/xcode-select', ['-p'], { timeout: LOOKUP_TIMEOUT_MS });
    if (developer.error || !firstLine(developer.stdout)) return null;
    const found = await run('/usr/bin/xcrun', ['--find', 'swiftc'], { timeout: LOOKUP_TIMEOUT_MS });
    const file = firstLine(found.stdout);
    if (found.error || !path.isAbsolute(file)) return null;
    // swiftc run by its own path (not through the xcrun shim) does not know where the macOS SDK is and fails with "unable to load standard
    // library for target ..."; xcrun tells it through SDKROOT, so the build passes the SDK path the same way.
    const sdk = await run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { timeout: LOOKUP_TIMEOUT_MS });
    const sdkPath = firstLine(sdk.stdout);
    sdkRoot = !sdk.error && path.isAbsolute(sdkPath) ? sdkPath : null;
    swiftc = file;
    return swiftc;
  }

  // The files swiftc compiles, read again each time (an update may add or remove files).
  const sources = () => (sourcePath ? [sourcePath] : widgetSources(sourceDir, fs));
  // Whether the install has a complete source: with several files, Swift runs top-level code only from main.swift.
  const sourceComplete = files => files.length > 0 && files.every(file => fs.existsSync(file)) && (Boolean(sourcePath) || files.some(file => path.basename(file) === 'main.swift'));
  const sourceNames = files => files.map(file => path.basename(file));

  function readStamp() {
    try { return JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { return null; }
  }
  // Why the binary must be built, or null when the one there is current: missing, older than the newest source file, made by another version, or
  // made from another set of files (a file removed by an update leaves the newest time of the others as it was).
  function rebuildReason() {
    let binaryStat;
    try { binaryStat = fs.statSync(binary); } catch { return 'missing'; }
    const files = sources();
    let newest = 0;
    try { for (const file of files) newest = Math.max(newest, fs.statSync(file).mtimeMs); } catch { return 'source changed'; }
    if (!files.length || binaryStat.mtimeMs < newest) return 'source changed';
    const stamp = readStamp();
    if (!stamp || stamp.version !== version) return 'version changed';
    if (Array.isArray(stamp.sources) && stamp.sources.join('\n') !== sourceNames(files).join('\n')) return 'source changed';
    return null;
  }

  async function build(compiler, files) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const temporary = path.join(folder, `${BINARY}.${pid}.tmp`);
    const result = await run(compiler, ['-O', '-swift-version', '5', '-framework', 'AppKit', ...files, '-o', temporary], {
      timeout: BUILD_TIMEOUT_MS, env: { ...env, ...(sdkRoot ? { SDKROOT: sdkRoot } : {}) },
    });
    if (result.error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* nothing was written */ }
      const reason = result.error.killed ? 'timed out after 600 s' : firstLine(result.stderr.split('\n').find(line => /error/i.test(line)) || result.stderr) || result.error.message;
      throw new WidgetError('BUILD_FAILED', `The build failed: ${reason}`);
    }
    fs.renameSync(temporary, binary);
    fs.writeFileSync(stampFile, `${JSON.stringify({ version, built_at: new Date(now()).toISOString(), sources: sourceNames(files) })}\n`);
  }

  function launch() {
    const own = randomToken();
    let stderr = '';
    let started;
    try {
      started = spawn(binary, ['--parent-pid', String(pid)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: env.PATH || '/usr/bin:/bin', HOME: env.HOME || '', TA_WIDGET_URL: url, TA_WIDGET_TOKEN: own },
      });
    } catch (error) {
      throw new WidgetError('LAUNCH_FAILED', `The window could not start: ${error.message}`);
    }
    child = started;
    token = own;
    started.killedByServer = false;
    if (started.stderr) {
      started.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-STDERR_KEEP); });
      if (typeof started.stderr.unref === 'function') started.stderr.unref();
    }
    if (typeof started.unref === 'function') started.unref();
    const ended = (code, signal, error) => {
      if (child !== started) return;
      child = null;
      token = null;
      if (started.killedByServer) return;
      quit = true;
      if (error) lastError = `The window could not start: ${error.message}`;
      else if (code) lastError = `The window stopped (exit code ${code})${firstLine(stderr) ? `: ${firstLine(stderr.split('\n').slice(-3).join('\n'))}` : ''}`;
      else if (signal) lastError = `The window stopped (${signal})`;
      if (lastError && (error || code || signal)) log(`T-Attention desktop window: ${lastError}`);
    };
    started.on('error', error => ended(null, null, error));
    started.on('exit', (code, signal) => ended(code, signal, null));
  }

  // Builds when needed and starts the window, unless it must not run now. Returns the promise of that work (one at a time).
  function ensure() {
    if (!supported || blocked || !url || child || quit || pending || !settings.read().enabled) return pending || Promise.resolve();
    pending = (async () => {
      const compiler = await findSwiftc();
      if (!compiler) { lastError = 'Xcode command line tools needed: xcode-select --install'; return; }
      const files = sources();
      if (!sourceComplete(files)) { lastError = 'The window source is missing from this install'; return; }
      const reason = rebuildReason();
      if (reason) await build(compiler, files);
      if (!settings.read().enabled || child || quit) return;
      launch();
      lastError = null;
    })().catch(error => {
      lastError = error instanceof WidgetError ? error.message : `The window could not start: ${error.message}`;
      log(`T-Attention desktop window: ${lastError}`);
    }).finally(() => { pending = null; });
    return pending;
  }

  function kill() {
    if (!child) return;
    const running = child;
    running.killedByServer = true;
    child = null;
    token = null;
    try { running.kill('SIGTERM'); } catch { /* already gone */ }
  }

  // After the server listens: url is the loopback address of this server (http://127.0.0.1:<port>).
  function start({ url: serverUrl }) {
    url = serverUrl;
    if (blocked && supported) lastError = blocked;
    return ensure();
  }

  // The switch. Off kills the window and forgets that it was quit; on starts it (a build may run first).
  function setEnabled(on) {
    if (!on) { quit = false; kill(); return Promise.resolve(); }
    return ensure();
  }

  // The status line of the settings card.
  async function status() {
    const compiler = supported ? await findSwiftc() : null;
    return { platform_supported: supported, swiftc: Boolean(compiler), running: Boolean(child), building: Boolean(pending), last_error: supported ? lastError : null };
  }

  // The widget API's credential: the token of the window that runs now (none while nothing runs). Compared in constant time.
  function verifyToken(value) {
    if (!token || typeof value !== 'string' || !value) return false;
    const given = Buffer.from(value);
    const own = Buffer.from(token);
    return given.length === own.length && crypto.timingSafeEqual(given, own);
  }

  // What the widget notifier reads at every message (services/widget-notices.js setWidgetState): synchronous, no lookup. `url` is the address the
  // window talks to (null before the server listens).
  function state() {
    let enabled = false;
    try { enabled = settings.read().enabled === true; } catch { enabled = false; }
    return { supported, blocked: Boolean(blocked), enabled, running: Boolean(child), url };
  }

  return { start, ensure, setEnabled, status, state, verifyToken, stop: kill, paths: { folder, binary, stampFile, sourceDir, sourcePath }, sources, rebuildReason, blocked: () => blocked, idle: () => pending || Promise.resolve() };
}

// Settings sync across linked devices (services/settings-sync.js): only the language of the window ('en' | 'zh'; null is 'auto', the default).
// The switch (`enabled`) stays per device.
const SYNC_GROUP = 'widget-language';
function exportForSync({ db }) {
  const stored = syncStore.readState(db, SETTINGS_KEY);
  return stored && ['en', 'zh'].includes(stored.language) ? stored.language : null;
}
function importFromSync({ db }, owner, value) {
  if (value !== null && !['en', 'zh'].includes(value)) throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 });
  const stored = syncStore.readState(db, SETTINGS_KEY);
  const next = syncStore.isPlainObject(stored) ? { ...stored } : {};
  next.language = value || 'auto';
  syncStore.writeState(db, SETTINGS_KEY, next);
}

module.exports = { SYNC_GROUP, exportForSync, importFromSync, createWidgetSettings, createWidgetLauncher, widgetSources, RETIRED_SOURCES, blockedReason, WidgetError, SETTINGS_KEY, PAGE_LANGUAGE_KEY, LANGUAGES, PREFS };
