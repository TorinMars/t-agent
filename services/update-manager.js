const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { logUpdate, recentLog, clearLog, runUpdateCommand, runWithProgress } = require('../lib/update-command');
const { requiresRestart } = require('../lib/update-impact');
const db = require('../db');
const config = require('../config');
const {
  compareSemver,
  githubVersionUrlFromRemote,
  githubVersionUrlFromRepository,
  validateGithubVersionUrl,
  validateVersionManifest,
} = require('../lib/version-utils');
const { copyRelease, stageGithubArchive } = require('./archive-updater');
const { prepareWorkspace, trackedChanges, dirtyError } = require('../lib/git-update-workspace');

const projectRoot = path.resolve(__dirname, '..');
const runningCommit = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
})();
const versionPath = path.join(projectRoot, 'VERSION.json');
const stateKey = 'update_state';
const MAX_RESPONSE_BYTES = 16 * 1024;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

function defaultState() {
  return {
    status: 'idle',
    local_version: null,
    remote_version: null,
    last_checked_at: null,
    error: null,
    error_details: null,
    notice_version: null,
    manifest_etag: null,
    manifest_last_modified: null,
    remote_manifest: null,
    stage: null,
    message: null,
    restart_pending: false,
    running_version: null,
    updated_at: new Date().toISOString(),
  };
}

function readPersistedState() {
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(stateKey);
  if (!row) return defaultState();
  try {
    const persisted = JSON.parse(row.value);
    if (persisted.status === 'updating') {
      persisted.status = persisted.stage === 'restarting' ? 'current' : 'failed';
      persisted.message = persisted.stage === 'restarting' ? 'Update complete' : 'The last update was interrupted unexpectedly';
      persisted.error = persisted.stage === 'restarting' ? null : 'UPDATE_INTERRUPTED';
      persisted.stage = null;
    }
    if (persisted.status === 'restart_pending') {
      persisted.status = 'current';
      persisted.restart_pending = false;
      persisted.message = 'Already up to date';
    }
    return { ...defaultState(), ...persisted };
  }
  catch { return defaultState(); }
}

let state = readPersistedState();
let checkPromise = null;
let applyPromise = null;
let timer = null;

function saveState(patch) {
  if (patch.stage && patch.stage !== state.stage) logUpdate(patch.stage, patch.message || patch.status);
  if (patch.error) logUpdate('failed', `${patch.error}: ${patch.error_details || patch.message || ''}`);
  state = { ...state, ...patch, updated_at: new Date().toISOString() };
  db.prepare(`
    INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(stateKey, JSON.stringify(state));
  return publicState();
}

function readLocalManifest() {
  const manifest = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  return validateVersionManifest(manifest);
}

// The version on disk when the process started, i.e. the version this process is actually running.
// Update checks compare the remote version with the on-disk VERSION.json: after a manual git pull or an update that failed halfway, the on-disk code can be newer than the in-memory one,
// and then "restart needed" must be reported separately instead of "up to date".
// Generated once at every process start. The page uses it to tell "the old process has not exited yet" from "the new process is up": the on-disk version is already new before the restart, so it cannot be used for that.
const bootId = crypto.randomUUID();

const runningVersion = (() => {
  try { return readLocalManifest().app_version; } catch { return null; }
})();

function configuredVersionUrl() {
  if (config.githubVersionUrl) {
    const configured = validateGithubVersionUrl(config.githubVersionUrl).toString();
    const canonical = githubVersionUrlFromRepository(config.updateRepository, config.updateRef);
    const rawBase = `https://raw.githubusercontent.com/${config.updateRepository}`;
    const legacyRaw = `${rawBase}/${config.updateRef}/VERSION.json`;
    const explicitRaw = `${rawBase}/refs/heads/${config.updateRef}/VERSION.json`;
    return configured === legacyRaw || configured === explicitRaw ? canonical : configured;
  }
  let remote = '';
  try {
    remote = execFileSync('git', ['config', '--get', `remote.${config.gitRemote}.url`], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
  } catch {}
  const derived = githubVersionUrlFromRemote(remote, config.gitBranch)
    || githubVersionUrlFromRepository(config.updateRepository, config.updateRef);
  if (!derived) throw new Error('VERSION_URL_NOT_CONFIGURED');
  return validateGithubVersionUrl(derived).toString();
}

function installationType() {
  return fs.existsSync(path.join(projectRoot, '.git')) ? 'git' : 'archive';
}

function executablePath() {
  return [
    path.dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    process.env.PATH,
  ].filter(Boolean).join(path.delimiter);
}

function requestManifest(urlValue, headers = {}, redirects = 0) {
  const url = validateGithubVersionUrl(urlValue);
  return new Promise((resolve, reject) => {
    const requestHeaders = {
      Accept: 'application/vnd.github.raw+json',
      'Cache-Control': 'no-cache',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'torin-x-web-update-checker',
      ...headers,
    };
    if (config.githubToken) requestHeaders.Authorization = `Bearer ${config.githubToken}`;
    const req = https.get(url, { headers: requestHeaders, timeout: HTTP_TIMEOUT_MS }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location || redirects >= MAX_REDIRECTS) return reject(new Error('TOO_MANY_REDIRECTS'));
        let next;
        try { next = validateGithubVersionUrl(new URL(res.headers.location, url).toString()).toString(); }
        catch (error) { return reject(error); }
        return resolve(requestManifest(next, headers, redirects + 1));
      }
      if (res.statusCode === 304) {
        res.resume();
        return resolve({ notModified: true, etag: res.headers.etag, lastModified: res.headers['last-modified'] });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GITHUB_HTTP_${res.statusCode}`));
      }
      const chunks = [];
      let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('VERSION_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const manifest = validateVersionManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          resolve({ manifest, etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null });
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('VERSION_REQUEST_TIMEOUT')));
    req.on('error', reject);
  });
}

function safeError(error) {
  const message = String(error && error.message || 'UPDATE_CHECK_FAILED');
  return /^[A-Z0-9_]+$/.test(message) ? message : 'UPDATE_CHECK_FAILED';
}

async function runCheck({ force = false } = {}) {
  const local = readLocalManifest();
  const gitInstall = installationType() === 'git';
  const url = gitInstall ? null : configuredVersionUrl();
  saveState({ status: 'checking', stage: gitInstall ? 'fetching' : 'checking_version', error: null, error_details: null, local_version: local.app_version, message: null });
  let result;
  let restartRequired = true;
  let restartPending = false;
  if (gitInstall) {
    await execGit(['fetch', config.gitRemote, `refs/heads/${config.gitBranch}:refs/remotes/${config.gitRemote}/${config.gitBranch}`], 120_000);
    const target = `${config.gitRemote}/${config.gitBranch}`;
    const manifestText = await execGit(['show', `${target}:VERSION.json`]);
    result = { manifest: validateVersionManifest(JSON.parse(manifestText)) };
    restartRequired = await requiresRestart(execGit, runningCommit, target);
    // Whether the workspace code is already newer than the running process (and the change needs a restart to take effect). Auxiliary information; a failure does not affect the check itself.
    if (runningCommit) {
      try { restartPending = await requiresRestart(execGit, runningCommit, 'HEAD'); }
      catch (error) { logUpdate('checking', `Cannot tell whether a restart is needed: ${error.message}`); }
    }
  } else {
    restartPending = Boolean(runningVersion) && runningVersion !== local.app_version;
    const headers = {};
    if (!force && state.manifest_etag) headers['If-None-Match'] = state.manifest_etag;
    if (!force && state.manifest_last_modified) headers['If-Modified-Since'] = state.manifest_last_modified;
    const requestUrl = new URL(url);
    if (force) requestUrl.searchParams.set('_update_check', String(Date.now()));
    result = await requestManifest(requestUrl.toString(), headers);
  }
  const remote = result.notModified ? state.remote_manifest : result.manifest;
  if (!remote) throw new Error('VERSION_CACHE_EMPTY');
  validateVersionManifest(remote);
  const comparison = compareSemver(remote.app_version, local.app_version);
  // When an update exists it stays available; when versions match but the running code is older than disk it is restart_pending, not "up to date".
  const status = comparison > 0 ? 'available' : comparison < 0 ? 'local_newer' : (restartPending ? 'restart_pending' : 'current');
  return saveState({
    status,
    stage: null,
    local_version: local.app_version,
    remote_version: remote.app_version,
    restart_required: restartRequired,
    restart_pending: restartPending,
    running_version: runningVersion,
    remote_manifest: remote,
    manifest_etag: gitInstall ? null : result.etag || state.manifest_etag,
    manifest_last_modified: gitInstall ? null : result.lastModified || state.manifest_last_modified,
    last_checked_at: new Date().toISOString(),
    error: null,
    error_details: null,
    version_url: url || `${config.gitRemote}/${config.gitBranch}:VERSION.json`,
    message: status === 'available' ? 'Update available'
      : status === 'restart_pending' ? `Code was updated to ${local.app_version}, but the service is still running ${runningVersion && runningVersion !== local.app_version ? ` the ${runningVersion}` : 'old'} code; restart the service for it to take effect`
        : status === 'current' ? 'Already up to date' : 'Local version is newer',
  });
}

async function check(options) {
  if (applyPromise) throw new Error('UPDATE_IN_PROGRESS');
  if (checkPromise) return checkPromise;
  checkPromise = runCheck(options).catch(error => {
    saveState({ status: 'failed', stage: null, error: safeError(error), error_details: error.details || null, last_checked_at: new Date().toISOString(), message: 'Update check failed' });
    throw error;
  }).finally(() => { checkPromise = null; });
  return checkPromise;
}

function execGit(args, timeout = 60_000) {
  return runUpdateCommand('git', args, {
    cwd: projectRoot,
    env: { ...process.env, PATH: executablePath() },
    timeout,
    maxBuffer: 1024 * 1024,
  }, { stage: `git:${args[0]}`, errorCode: `GIT_${String(args[0]).toUpperCase()}_FAILED` });
}

// npm network requests during an update: few retries and a short timeout, so an unreachable network errors within a minute or two instead of waiting the full 10 minutes.
// Values the user already set in the environment are not overridden. The http log level prints a line for every download so the UI can see it is still moving.
const NPM_UPDATE_ENV = {
  npm_config_fetch_retries: '1',
  npm_config_fetch_retry_mintimeout: '2000',
  npm_config_fetch_retry_maxtimeout: '10000',
  npm_config_fetch_timeout: '60000',
  npm_config_loglevel: 'http',
};

function npmEnv() {
  const env = { ...process.env, PATH: executablePath() };
  for (const [key, value] of Object.entries(NPM_UPDATE_ENV)) if (env[key] === undefined) env[key] = value;
  return env;
}

function execNpm(args, stage) {
  const label = stage === 'installing' ? 'Installing dependencies' : 'Building frontend assets';
  return runWithProgress(
    label,
    onOutput => runUpdateCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: projectRoot,
      env: npmEnv(),
      timeout: 10 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
    }, { stage, errorCode: `NPM_${stage.toUpperCase()}_FAILED`, streamOutput: true, onOutput }),
    message => saveState({ status: 'updating', stage, message }),
  );
}

async function runApply({ force = false } = {}) {
  clearLog();
  saveState({ status: 'updating', stage: 'refreshing_version', error: null, message: 'Confirming the remote version' });
  const checked = await runCheck({ force: true });
  if (checked.status !== 'available') throw new Error('NO_UPDATE_AVAILABLE');

  let restartRequired = true;
  if (installationType() === 'archive') await applyArchiveUpdate(checked);
  else restartRequired = await applyGitUpdate(checked, force);

  if (!restartRequired) {
    logUpdate('completed', 'Frontend update finished; dependency install, build and service restart skipped, existing shell connections kept');
    return saveState({ status: 'current', stage: 'completed', restart_required: false,
      local_version: checked.remote_version, error: null, error_details: null,
      message: 'Frontend update finished; the service was not restarted and existing shell connections stay open. Refresh the page later to load the new UI.' });
  }

  await execNpm(['ci', '--ignore-scripts=false'], 'installing');
  await verifyNodePty();
  await execNpm(['run', 'build:monaco'], 'building');
  saveState({ status: 'updating', stage: 'restarting', message: 'Update finished, restarting the service' });
  // A non-zero exit code makes both systemd Restart=on-failure and macOS KeepAlive bring the new version up.
  setTimeout(() => process.exit(75), 750).unref();
  return publicState();
}

function verifyNodePty() {
  return runUpdateCommand(process.execPath, [path.join(projectRoot, 'scripts', 'verify-node-pty.js')], {
    cwd: projectRoot,
    env: { ...process.env, PATH: executablePath() },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }, { stage: 'verifying_terminal', errorCode: 'NODE_PTY_LOAD_FAILED', streamOutput: true });
}

async function backupDatabase(metadata = {}) {
  const backupDir = path.join(projectRoot, 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `db-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  saveState({
    status: 'updating',
    stage: 'backing_up',
    message: 'Backing up the database',
    backup_path: backupPath,
    ...metadata,
  });
  const started = Date.now();
  await db.backup(backupPath);
  logUpdate('backing_up', `Backup finished in ${Date.now() - started}ms: ${backupPath}`);
  return backupPath;
}

async function applyGitUpdate(checked, force = false) {
  saveState({ status: 'updating', stage: 'checking_workspace', message: 'Checking the Git workspace' });
  const changes = await trackedChanges(execGit);
  if (changes.length && !force) throw dirtyError(changes);

  saveState({ status: 'updating', stage: 'fetching', message: 'Fetching Git updates' });
  await execGit(['fetch', config.gitRemote, `refs/heads/${config.gitBranch}:refs/remotes/${config.gitRemote}/${config.gitBranch}`]);
  const target = `${config.gitRemote}/${config.gitBranch}`;
  const remoteVersionText = await execGit(['show', `${target}:VERSION.json`]);
  const targetManifest = validateVersionManifest(JSON.parse(remoteVersionText));
  if (targetManifest.app_version !== checked.remote_version) throw new Error('VERSION_SOURCE_MISMATCH');
  const restartRequired = await requiresRestart(execGit, runningCommit, target);
  saveState({ restart_required: restartRequired });
  const counts = (await execGit(['rev-list', '--left-right', '--count', `HEAD...${target}`])).split(/\s+/).map(Number);
  if (counts[0] > 0) throw new Error('BRANCH_DIVERGED');
  if (!counts[1]) throw new Error('NO_GIT_CHANGES');

  const previousCommit = await execGit(['rev-parse', 'HEAD']);
  await backupDatabase({ previous_commit: previousCommit, install_type: 'git' });
  const codeBackup = await prepareWorkspace(execGit, force);
  if (codeBackup) saveState({ code_backup: codeBackup, message: 'Local changes were backed up to a Git stash' });

  saveState({ status: 'updating', stage: 'merging', message: 'Fast-forwarding the code' });
  await execGit(['merge', '--ff-only', '--no-overwrite-ignore', target]);
  return restartRequired;
}

async function applyArchiveUpdate(checked) {
  saveState({ status: 'updating', stage: 'downloading', message: 'Downloading the update package', install_type: 'archive' });
  const staged = await stageGithubArchive({
    repository: config.updateRepository,
    ref: config.updateRef,
    expectedVersion: checked.remote_version,
  });
  try {
    await backupDatabase({ previous_version: checked.local_version, install_type: 'archive' });
    saveState({ status: 'updating', stage: 'copying', message: 'Installing the update files' });
    copyRelease(staged.sourceRoot, projectRoot);
  } finally {
    staged.cleanup();
  }
}

async function apply(options = {}) {
  if (applyPromise) return applyPromise;
  applyPromise = runApply(options).catch(error => {
    saveState({
      status: 'blocked',
      stage: null,
      error: safeError(error),
      error_details: error.details || null,
      message: error.message === 'WORKTREE_DIRTY' ? 'Local uncommitted changes prevent updating' : 'Update blocked',
    });
    throw error;
  }).finally(() => { applyPromise = null; });
  return applyPromise;
}

function publicState() {
  let localManifest = null;
  try { localManifest = readLocalManifest(); } catch {}
  return {
    ...state,
    // After the update files are written, and when recovering after a restart, use the actual manifest version, so a state cache never keeps showing the old version.
    local_version: (localManifest && localManifest.app_version) || state.local_version,
    local_manifest: localManifest,
    boot_id: bootId,
    version_url: state.version_url || (() => { try { return configuredVersionUrl(); } catch { return null; } })(),
    install_type: installationType(),
    update_repository: config.updateRepository,
    update_ref: config.updateRef,
    check_interval_seconds: config.updateCheckIntervalMs / 1000,
    log: recentLog(),
  };
}

function markNotified(version) {
  if (version && version === state.remote_version) saveState({ notice_version: version });
  return publicState();
}

function start() {
  if (!config.updateCheckEnabled || timer) return;
  const schedule = () => check().catch(error => console.error('[update-check]', safeError(error)));
  setTimeout(schedule, Math.min(config.updateCheckStartupDelayMs, config.updateCheckIntervalMs)).unref();
  timer = setInterval(schedule, config.updateCheckIntervalMs);
  timer.unref();
}

module.exports = { apply, check, markNotified, publicState, readLocalManifest, start, npmEnv, bootId };
