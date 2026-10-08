const os = require('node:os');
const { createAppsRegistry, AppsError } = require('./apps-registry');
const { createPortDetector } = require('./port-detector');
const { Pm2Error } = require('./pm2-manager');

// 这台机器上可以被其他设备访问的 IPv4 地址（局域网/内网），排除回环、链路本地地址和 Docker/虚拟机之类的虚拟网卡；
// 物理网卡（en*/eth*/wl* 等）排在前面，因为链接默认用第一个地址。
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
  // Array.prototype.sort 是稳定排序，同一优先级保持系统给出的顺序。
  return [...new Set(found.sort((a, b) => a.rank - b.rank).map(item => item.address))];
}

const hostForUrl = host => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

// 生成访问链接。优先级：自定义地址 > 域名 > IP:端口。仅本机监听的端口只给 127.0.0.1，并标出来。
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
    // 域名没写路径时补上应用路径。
    const hasPath = /^https?:\/\/[^/]+\/./.test(full);
    domain = { url: hasPath || path === '/' ? full : full.replace(/\/$/, '') + path };
  }
  const custom = app.url ? { url: app.url } : null;
  const primary = (custom || domain || ip || {}).url || null;
  return { ip, domain, custom, primary };
}

function createAppsService({ db, pm2Manager, portDetector = createPortDetector(), interfaces = os.networkInterfaces } = {}) {
  const registry = createAppsRegistry({ db });

  // PM2 不可用（没装、没运行、命令失败）不影响应用列表，只是没有运行状态。
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
    // 自动登记：PM2 里的每个进程都有一条应用记录（已被用户隐藏的不会再登记）。
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

  // 删除：自动登记的 PM2 服务在 PM2 里还存在时只隐藏。
  async function remove(id) {
    const app = registry.get(id);
    if (!app) throw new AppsError('APP_NOT_FOUND', '找不到这个应用', 404);
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
