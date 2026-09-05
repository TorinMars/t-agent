const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, execFileSync } = require('child_process');
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

const projectRoot = path.resolve(__dirname, '..');
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
    notice_version: null,
    manifest_etag: null,
    manifest_last_modified: null,
    remote_manifest: null,
    stage: null,
    message: null,
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
      persisted.message = persisted.stage === 'restarting' ? '更新完成' : '上次更新意外中断';
      persisted.error = persisted.stage === 'restarting' ? null : 'UPDATE_INTERRUPTED';
      persisted.stage = null;
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

function configuredVersionUrl() {
  if (config.githubVersionUrl) {
    const configured = validateGithubVersionUrl(config.githubVersionUrl).toString();
    const canonical = githubVersionUrlFromRepository(config.updateRepository, config.updateRef);
    const legacy = canonical && canonical.replace('/refs/heads/', '/');
    return configured === legacy ? canonical : configured;
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

function requestManifest(urlValue, headers = {}, redirects = 0) {
  const url = validateGithubVersionUrl(urlValue);
  return new Promise((resolve, reject) => {
    const requestHeaders = {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
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
  const url = configuredVersionUrl();
  saveState({ status: 'checking', stage: 'checking_version', error: null, local_version: local.app_version, message: null });
  const headers = {};
  if (!force && state.manifest_etag) headers['If-None-Match'] = state.manifest_etag;
  if (!force && state.manifest_last_modified) headers['If-Modified-Since'] = state.manifest_last_modified;
  const requestUrl = new URL(url);
  if (force) requestUrl.searchParams.set('_update_check', String(Date.now()));
  const result = await requestManifest(requestUrl.toString(), headers);
  const remote = result.notModified ? state.remote_manifest : result.manifest;
  if (!remote) throw new Error('VERSION_CACHE_EMPTY');
  validateVersionManifest(remote);
  const comparison = compareSemver(remote.app_version, local.app_version);
  const status = comparison > 0 ? 'available' : comparison < 0 ? 'local_newer' : 'current';
  return saveState({
    status,
    stage: null,
    local_version: local.app_version,
    remote_version: remote.app_version,
    remote_manifest: remote,
    manifest_etag: result.etag || state.manifest_etag,
    manifest_last_modified: result.lastModified || state.manifest_last_modified,
    last_checked_at: new Date().toISOString(),
    error: null,
    version_url: url,
    message: status === 'available' ? '发现新版本' : status === 'current' ? '已是最新版本' : '本地版本较新',
  });
}

async function check(options) {
  if (applyPromise) throw new Error('UPDATE_IN_PROGRESS');
  if (checkPromise) return checkPromise;
  checkPromise = runCheck(options).catch(error => {
    saveState({ status: 'failed', stage: null, error: safeError(error), last_checked_at: new Date().toISOString(), message: '检查更新失败' });
    throw error;
  }).finally(() => { checkPromise = null; });
  return checkPromise;
}

function execGit(args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: projectRoot, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(`GIT_${String(args[0]).toUpperCase()}_FAILED`);
        wrapped.details = String(stderr || stdout || '').trim().slice(0, 1000);
        return reject(wrapped);
      }
      resolve(String(stdout).trim());
    });
  });
}

function execNpm(args, stage) {
  saveState({ status: 'updating', stage, message: stage === 'installing' ? '正在安装依赖' : '正在构建前端资源' });
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: projectRoot,
      timeout: 10 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(`NPM_${stage.toUpperCase()}_FAILED`);
        wrapped.details = String(stderr || stdout || '').trim().slice(-2000);
        return reject(wrapped);
      }
      resolve();
    });
  });
}

async function runApply() {
  saveState({ status: 'updating', stage: 'refreshing_version', error: null, message: '正在确认远程版本' });
  const checked = await runCheck({ force: true });
  if (checked.status !== 'available') throw new Error('NO_UPDATE_AVAILABLE');

  if (installationType() === 'archive') await applyArchiveUpdate(checked);
  else await applyGitUpdate(checked);

  await execNpm(['ci'], 'installing');
  await execNpm(['run', 'build:monaco'], 'building');
  saveState({ status: 'updating', stage: 'restarting', message: '更新完成，正在重启服务' });
  // 非 0 退出码可让 systemd Restart=on-failure 和 macOS KeepAlive 都拉起新版本。
  setTimeout(() => process.exit(75), 750).unref();
  return publicState();
}

async function backupDatabase(metadata = {}) {
  const backupDir = path.join(projectRoot, 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `db-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  saveState({
    status: 'updating',
    stage: 'backing_up',
    message: '正在备份数据库',
    backup_path: backupPath,
    ...metadata,
  });
  await db.backup(backupPath);
  return backupPath;
}

async function applyGitUpdate(checked) {
  saveState({ status: 'updating', stage: 'checking_workspace', message: '正在检查 Git 工作区' });
  const dirty = await execGit(['status', '--porcelain']);
  if (dirty) throw new Error('WORKTREE_DIRTY');

  saveState({ status: 'updating', stage: 'fetching', message: '正在获取 Git 更新' });
  await execGit(['fetch', '--prune', config.gitRemote, config.gitBranch]);
  const target = `${config.gitRemote}/${config.gitBranch}`;
  const remoteVersionText = await execGit(['show', `${target}:VERSION.json`]);
  const targetManifest = validateVersionManifest(JSON.parse(remoteVersionText));
  if (targetManifest.app_version !== checked.remote_version) throw new Error('VERSION_SOURCE_MISMATCH');
  const counts = (await execGit(['rev-list', '--left-right', '--count', `HEAD...${target}`])).split(/\s+/).map(Number);
  if (counts[0] > 0) throw new Error('BRANCH_DIVERGED');
  if (!counts[1]) throw new Error('NO_GIT_CHANGES');

  const previousCommit = await execGit(['rev-parse', 'HEAD']);
  await backupDatabase({ previous_commit: previousCommit, install_type: 'git' });

  saveState({ status: 'updating', stage: 'merging', message: '正在快进代码' });
  await execGit(['merge', '--ff-only', target]);
}

async function applyArchiveUpdate(checked) {
  saveState({ status: 'updating', stage: 'downloading', message: '正在下载更新包', install_type: 'archive' });
  const staged = await stageGithubArchive({
    repository: config.updateRepository,
    ref: config.updateRef,
    expectedVersion: checked.remote_version,
  });
  try {
    await backupDatabase({ previous_version: checked.local_version, install_type: 'archive' });
    saveState({ status: 'updating', stage: 'copying', message: '正在安装更新文件' });
    copyRelease(staged.sourceRoot, projectRoot);
  } finally {
    staged.cleanup();
  }
}

async function apply() {
  if (applyPromise) return applyPromise;
  applyPromise = runApply().catch(error => {
    saveState({ status: 'blocked', stage: null, error: safeError(error), message: error.message === 'WORKTREE_DIRTY' ? '本地有未提交修改，无法更新' : '更新已阻断' });
    throw error;
  }).finally(() => { applyPromise = null; });
  return applyPromise;
}

function publicState() {
  let localManifest = null;
  try { localManifest = readLocalManifest(); } catch {}
  return {
    ...state,
    local_manifest: localManifest,
    version_url: state.version_url || (() => { try { return configuredVersionUrl(); } catch { return null; } })(),
    install_type: installationType(),
    update_repository: config.updateRepository,
    update_ref: config.updateRef,
    check_interval_seconds: config.updateCheckIntervalMs / 1000,
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

module.exports = { apply, check, markNotified, publicState, readLocalManifest, start };
