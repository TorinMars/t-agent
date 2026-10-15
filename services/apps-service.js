const os = require('node:os');
const { createAppsRegistry, AppsError } = require('./apps-registry');
const { createPortDetector } = require('./port-detector');
const { Pm2Error } = require('./pm2-manager');

// IPv4 addresses of this machine that other devices can reach (LAN/intranet), excluding loopback, link-local addresses and virtual NICs such as Docker/VM ones;
// physical NICs (en*/eth*/wl* etc.) come first, because links use the first address by default.
const VIRTUAL_INTERFACE = /^(lo|docker|veth|br-|virbr|vmnet|vboxnet|bridge|utun|awdl|llw|ap\d|gif|stf|anpi)/i;
const PHYSICAL_INTERFACE = /^(en|eth|wl|wlan|eno|ens|enp|wlp)/i;

function localIps(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const item of addresses || []) {
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) {
        found.push({ address: item.address, rank: PHYSICAL_INTERFACE.test(name) ? 0 : 1 });
      }
    }
  }
  // Array.prototype.sort is stable, so entries of equal priority keep the order the system gave.
  return [...new Set(found.sort((a, b) => a.rank - b.rank).map(item => item.address))];
}

const hostForUrl = host => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

// Build the access link. Priority: custom address > domain > IP:port. A port that only listens locally gets 127.0.0.1 only, and is flagged.
function buildLinks(app, ports, hostIps) {
  const path = app.path || '/';
  const detected = ports.find(item => item.port === app.port) || ports[0] || null;
  const port = app.port || (detected && detected.port) || null;
  const localOnly = Boolean(app.port ? (ports.find(item => item.port === app.port) || {}).local_only : detected && detected.local_only);

  let ip = null;
  if (port) {
    const host = app.host || (localOnly ? '127.0.0.1' : hostIps[0] || '127.0.0.1');
    ip = { url: `${app.scheme}://${hostForUrl(host)}:${port}${path}`, host, port, local_only: localOnly && !app.host };
  }
  let domain = null;
  if (app.domain) {
    const full = /^https?:\/\//i.test(app.domain) ? app.domain : `${app.scheme}://${app.domain}`;
    // When the domain has no path, append the app path.
    const hasPath = /^https?:\/\/[^/]+\/./.test(full);
    domain = { url: hasPath || path === '/' ? full : full.replace(/\/$/, '') + path };
  }
  const custom = app.url ? { url: app.url } : null;
  const primary = (custom || domain || ip || {}).url || null;
  return { ip, domain, custom, primary };
}

function createAppsService({ db, pm2Manager, portDetector = createPortDetector(), interfaces = os.networkInterfaces } = {}) {
  const registry = createAppsRegistry({ db });

  // PM2 being unavailable (not installed, not running, command failed) does not affect the app list; there is just no run status.
  async function pm2State() {
    try {
      const status = await pm2Manager.status();
      return { installed: status.installed, running: status.running, processes: status.processes || [], error: null };
    } catch (error) {
      return { installed: true, running: false, processes: [], error: error instanceof Pm2Error ? error.code : 'PM2_UNAVAILABLE' };
    }
  }

  async function list() {
    const pm2 = await pm2State();
    // Auto-register: every PM2 process has an app record (ones the user hid are not registered again).
    for (const proc of pm2.processes) registry.ensurePm2(proc.name);

    const online = pm2.processes.filter(proc => proc.status === 'online' && proc.pid);
    const ports = online.length ? await portDetector.detect(online.map(proc => proc.pid)) : new Map();
    const hostIps = localIps(interfaces());
    const byName = new Map(pm2.processes.map(proc => [proc.name, proc]));

    const apps = registry.list().map(app => {
      const proc = app.pm2_name ? byName.get(app.pm2_name) || null : null;
      const detected = proc && proc.pid ? ports.get(proc.pid) || [] : [];
      let state = 'unlinked';
      if (app.pm2_name) state = proc ? proc.status : (pm2.installed && pm2.running ? 'missing' : 'unavailable');
      const links = buildLinks(app, detected, hostIps);
      return { ...app, pm2: proc, pm2_state: state, ports: detected, effective_port: links.ip ? links.ip.port : null, links };
    });
    return {
      pm2: { installed: pm2.installed, running: pm2.running, error: pm2.error },
      host_ips: hostIps,
      hidden_count: registry.hiddenCount(),
      apps,
    };
  }

  // Delete: an auto-registered PM2 service is only hidden while it still exists in PM2.
  async function remove(id) {
    const app = registry.get(id);
    if (!app) throw new AppsError('APP_NOT_FOUND', 'App not found', 404);
    let pm2Present = false;
    if (app.source === 'pm2' && app.pm2_name) {
      const pm2 = await pm2State();
      pm2Present = pm2.processes.some(proc => proc.name === app.pm2_name);
    }
    return registry.remove(id, { pm2Present });
  }

  return { registry, list, remove, localIps: () => localIps(interfaces()) };
}

module.exports = { createAppsService, buildLinks, localIps };
