// What the T-Agent macOS app (apps/macos) needs to find and drive this server, and the web addresses it is reachable at
// (see "Server and floating window integration" in docs/design/mac-app.md).
//
//   <data home>/app.json   { url, version, pid, install_dir, supervisor, pm2_name, launchd_label, updated_at, addresses: [{ kind, label, url }] }
//
// Written at listen time and again when anything in it changes (checked every minute and on GET /api/system/app-info), atomically
// (a temporary file and a rename) with mode 0600. It is not deleted on exit: the app tells a running server by `pid` and a health
// check. It holds no secrets: every URL is an http(s) address without credentials, query or fragment.
//
// The build of the object is pure (buildAppInfo, listenUrl, lanAddresses, remoteAddresses); the writer and the publisher take
// their inputs as functions, so tests run them on a temporary folder.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');

const FILE_NAME = 'app.json';
const FILE_MODE = 0o600;
const REFRESH_MS = 60 * 1000;
const APP_CACHE_MS = 30 * 1000;
const APP_NAME = 'T-Agent.app';

const ANY_HOSTS = new Set(['0.0.0.0', '::', '']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const hostPart = host => (net.isIPv6(host) ? `[${host}]` : host);

// The address this server answers on from this machine: loopback when it listens on every interface or on localhost.
function listenUrl({ host, port }) {
  const value = String(host == null ? '' : host).trim();
  const target = ANY_HOSTS.has(value) || value === 'localhost' ? '127.0.0.1' : value;
  return `http://${hostPart(target)}:${port}`;
}

// RFC 1918 addresses: the ones a phone on the same network can reach.
function privateIPv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// The LAN addresses of this server: each private IPv4 of the machine when it listens on every interface, or only the one it
// listens on. Nothing when it listens on loopback.
function lanAddresses({ host, port, interfaces = {} }) {
  const value = String(host == null ? '' : host).trim();
  if (LOOPBACK_HOSTS.has(value)) return [];
  const all = ANY_HOSTS.has(value);
  const found = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const entry of list || []) {
      const family = entry && (entry.family === 4 ? 'IPv4' : entry.family);
      if (!entry || family !== 'IPv4' || entry.internal || !privateIPv4(entry.address)) continue;
      if (!all && entry.address !== value) continue;
      found.push({ kind: 'lan', label: `Local network (${name})`, url: `http://${entry.address}:${port}` });
    }
  }
  return found;
}

// An address that may be shown and written: http(s), a host, no user name or password, no query or fragment (where a token
// could hide). Returns the URL without a trailing slash, or null.
function cleanUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, '');
}

const validPort = port => Number.isInteger(port) && port > 0 && port <= 65535;

// The public addresses the remote-access features of this server know:
//   frp:  a running tunnel is reachable at http://<domain or server>:<remote port> (services/frp.js publicAddress);
//   ssh:  a running reverse tunnel bound on all interfaces of the server (bindAll) at http://<server>:<remote port>; bound to the
//         server's loopback it is reachable only through a proxy there, which is not known here;
//   publicUrl: the page address of the T-Attention notifier rules (services/attention-notify.js), the one messages link to.
function remoteAddresses({ frp = null, ssh = null, publicUrl = '' } = {}) {
  const found = [];
  const add = (label, url) => { const clean = cleanUrl(url); if (clean) found.push({ kind: 'remote', label, url: clean }); };
  const frpConfig = frp && frp.config;
  const frpHost = frpConfig && (frpConfig.domain || frpConfig.serverAddr);
  if (frp && frp.status === 'running' && frpHost && validPort(frpConfig.remotePort)) add('Remote (frp)', `http://${hostPart(frpHost)}:${frpConfig.remotePort}`);
  const sshConfig = ssh && ssh.config;
  if (ssh && ssh.status === 'running' && sshConfig && sshConfig.bindAll && sshConfig.host && validPort(sshConfig.remotePort)) {
    add('Remote (SSH tunnel)', `http://${hostPart(sshConfig.host)}:${sshConfig.remotePort}`);
  }
  if (publicUrl) add('Remote (public page address)', publicUrl);
  return found;
}

function uniqueByUrl(list) {
  const seen = new Set();
  return list.filter(entry => (seen.has(entry.url) ? false : (seen.add(entry.url), true)));
}

// Every web address: this machine, the LAN, the remote ones; each URL once (the first label wins).
function buildAddresses({ host, port, interfaces = {}, remote = [] }) {
  const local = { kind: 'local', label: 'This computer', url: listenUrl({ host, port }) };
  return uniqueByUrl([local, ...lanAddresses({ host, port, interfaces }), ...remote]);
}

// The PM2 process name: PM2 copies its process record into the environment of the process it starts (`name`, `pm_id`).
function pm2Name(env, supervisor) {
  if (supervisor !== 'pm2') return null;
  const name = String(env.name || '').trim();
  if (name) return name;
  const id = String(env.pm_id == null ? '' : env.pm_id).trim();
  return id || null;
}

// The label of the launchd job that runs the server: launchd puts it in XPC_SERVICE_NAME (lib/update-supervisor.js accepts launchd only
// with that label and launchd as the parent). The app uses it for launchctl kickstart / bootout.
function launchdLabel(env, supervisor) {
  if (supervisor !== 'launchd') return null;
  const label = String(env.XPC_SERVICE_NAME || '').trim();
  return label && label !== '0' && !label.startsWith('application.') ? label : null;
}

function buildAppInfo({ host, port, version = null, pid, installDir, supervisor = null, pm2Name: name = null, launchdLabel: label = null, addresses = [], now = new Date() }) {
  return {
    url: listenUrl({ host, port }),
    version: version || null,
    pid,
    install_dir: installDir,
    supervisor: supervisor || null,
    pm2_name: name || null,
    launchd_label: label || null,
    updated_at: now.toISOString(),
    addresses: (addresses || []).map(({ kind, label, url }) => ({ kind, label, url })),
  };
}

// Same content apart from the time it was written.
const sameContent = (a, b) => Boolean(a && b) && JSON.stringify({ ...a, updated_at: null }) === JSON.stringify({ ...b, updated_at: null });

function writeAppInfo(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(info, null, 2)}\n`, { mode: FILE_MODE });
  fs.chmodSync(temp, FILE_MODE);
  fs.renameSync(temp, file);
}

// collect() -> the input of buildAppInfo without `now`. start() writes the file and checks it again every REFRESH_MS;
// refresh() builds it now and writes it only when something changed. A failing write is logged once and never throws.
function createAppInfoPublisher({ file, collect, now = () => new Date(), write = writeAppInfo, schedule = setInterval, cancel = clearInterval, intervalMs = REFRESH_MS, warn = message => console.warn(message) }) {
  let written = null;
  let timer = null;
  let warned = false;
  function refresh() {
    let info;
    try { info = buildAppInfo({ ...collect(), now: now() }); } catch (error) {
      if (!warned) { warned = true; warn(`[app-info] could not build ${FILE_NAME}: ${error.message}`); }
      return written;
    }
    if (sameContent(info, written)) return written;
    try {
      write(file, info);
      written = info;
      warned = false;
    } catch (error) {
      if (!warned) { warned = true; warn(`[app-info] could not write ${file}: ${error.message}`); }
      return info;
    }
    return written;
  }
  function start() {
    refresh();
    if (!timer) {
      timer = schedule(refresh, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return written;
  }
  function stop() { if (timer) cancel(timer); timer = null; }
  return { start, stop, refresh, current: () => written, file };
}

// Reads Contents/Info.plist of an app bundle as JSON with plutil (part of macOS).
function readPlistWithPlutil(file) {
  return new Promise((resolve, reject) => {
    execFile('plutil', ['-convert', 'json', '-o', '-', file], { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
  });
}

// The T-Agent app installed on this Mac: ~/Applications/T-Agent.app, then /Applications/T-Agent.app. Only on macOS (null elsewhere).
// { installed, path, version, matches_server, shell_current }; the answer is kept for APP_CACHE_MS, and read again when `refreshKey()` changes
// (the automatic rebuild installed a new copy). `shell_current` is whether the app's TAgentSourceHash equals `sourceHash()`, the hash of the
// current shell code (lib/mac-app-source.js): an app built from the same shell code is current even when its version is older. Null when either
// is not known (not installed, or no hash for the current source).
function createMacAppProbe({ platform = process.platform, homedir = require('node:os').homedir, exists = fs.existsSync, readPlist = readPlistWithPlutil, serverVersion = () => null, sourceHash = () => null, refreshKey = () => null, now = Date.now, cacheMs = APP_CACHE_MS } = {}) {
  let cached = null;
  async function look() {
    for (const dir of [path.join(homedir(), 'Applications'), '/Applications']) {
      const bundle = path.join(dir, APP_NAME);
      const plist = path.join(bundle, 'Contents', 'Info.plist');
      if (!exists(plist)) continue;
      let version = null;
      let hash = null;
      try {
        const info = await readPlist(plist);
        const value = info && (info.CFBundleShortVersionString || info.CFBundleVersion);
        version = typeof value === 'string' && value.trim() ? value.trim() : null;
        hash = info && typeof info.TAgentSourceHash === 'string' ? info.TAgentSourceHash : null;
      } catch { version = null; }
      return { installed: true, path: bundle, version, hash };
    }
    return { installed: false, path: null, version: null, hash: null };
  }
  async function probe() {
    if (platform !== 'darwin') return null;
    const time = now();
    const key = refreshKey();
    if (!cached || time - cached.at >= cacheMs || cached.key !== key) cached = { at: time, key, value: await look() };
    const server = serverVersion();
    const { hash, ...value } = cached.value;
    let current = null;
    try { current = sourceHash(); } catch { current = null; }
    return {
      ...value,
      matches_server: Boolean(value.installed && value.version && server && value.version === server),
      shell_current: value.installed && current ? hash === current : null,
    };
  }
  return { probe };
}

let shared = null;
const setSharedPublisher = publisher => { shared = publisher; };
const sharedPublisher = () => shared;

module.exports = {
  FILE_NAME, FILE_MODE, REFRESH_MS, APP_CACHE_MS,
  listenUrl, privateIPv4, lanAddresses, cleanUrl, remoteAddresses, buildAddresses, pm2Name, launchdLabel, buildAppInfo, sameContent,
  writeAppInfo, createAppInfoPublisher, readPlistWithPlutil, createMacAppProbe, setSharedPublisher, sharedPublisher,
};
