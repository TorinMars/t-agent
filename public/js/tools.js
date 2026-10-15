// Utilities and the app list sit alongside "Tasks"; switching only shows/hides them, so terminal connections stay up.
const Tools = (() => {
  const SCRIPT_BASE_URL = 'https://raw.githubusercontent.com/TorinMars/t-agent/main/scripts/';
  const commandFor = button => {
    const args = button.dataset.args;
    return `curl -fsSL ${SCRIPT_BASE_URL}${button.dataset.script} | bash${args ? ` -s -- ${args}` : ''}`;
  };
  const tabs = { tasks: document.getElementById('tab-tasks'), tools: document.getElementById('tab-tools'), apps: document.getElementById('tab-apps'), 'agent-config': document.getElementById('tab-agent-config'), frp: document.getElementById('tab-frp'), 'file-sync': document.getElementById('tab-file-sync') };
  const toolsPanel = document.getElementById('tools-panel');
  const appsPanel = document.getElementById('apps-panel');
  const agentConfigPanel = document.getElementById('agent-config-panel');
  const frpPanel = document.getElementById('frp-panel');
  const fileSyncPanel = document.getElementById('file-sync-panel');
  const appsEngineLabel = document.getElementById('apps-engine');
  const timers = new WeakMap();
  let page = 'tasks';

  // The app list belongs to the current engine: a local engine uses the Client's own endpoints, a remote engine goes through the proxy to its /v1 endpoints.
  // Every engine connection has admin rights, so for a remote engine we only check whether it declares the capability (old Engines do not).
  // pm2 is only used for the PM2 actions in the app list (start/stop/restart/reload/logs); there is no separate panel any more.
  const FEATURES = {
    pm2: { capability: 'pm2:manage', local: '/api/pm2', suffix: 'pm2', missing: 'This engine is too old to support PM2 management. Please upgrade it.' },
    apps: { capability: 'apps:manage', local: '/api/apps', suffix: 'apps', missing: 'This engine is too old to support the app list. Please upgrade it.' },
    fileSync: { capability: 'file-sync:manage', local: '/api/file-sync', suffix: 'file-sync', missing: 'This engine is too old to support file sync. Please upgrade it.' },
  };
  function engineState(feature) {
    const tasks = typeof Tasks === 'undefined' ? null : Tasks;
    const src = tasks && tasks.getSource(tasks.getActiveKey());
    if (!src || src.local) return { label: src ? src.label : 'Default', local: true, endpoint: feature.local, unavailable: null };
    const state = { label: src.label, local: false, endpoint: `/api/remote-servers/${src.id}/${feature.suffix}`, unavailable: null };
    if (tasks.problemOf(src.key)) state.unavailable = 'This engine cannot be reached right now. Fix the connection in the engine bar at the top first.';
    else if (!src.role) state.unavailable = 'Reading this engine’s capabilities…';
    else if (!src.caps || !src.caps.has(feature.capability)) state.unavailable = feature.missing;
    return state;
  }
  function describeEngine(node, state) {
    node.replaceChildren('Current engine: ');
    const name = document.createElement('strong');
    name.textContent = state.label;
    node.append(name, state.local ? '(the machine running the Client)' : '(the machine running the remote engine)');
  }
  const registerExample = () => [
    `curl -X POST ${location.origin}/v1/apps/register \\`,
    '  -H "Authorization: Bearer <access-token>" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"name":"my-service","port":8080,"domain":"my.example.com","description":"service description"}\'',
  ].join('\n');

  function applyEngine() {
    const pm2State = engineState(FEATURES.pm2);
    const appsState = engineState(FEATURES.apps);
    describeEngine(appsEngineLabel, appsState);
    Apps.setEngine({
      endpoint: appsState.endpoint,
      // PM2 actions in the app list reuse the PM2 endpoints; if the engine does not support PM2 only those buttons are hidden.
      pm2Endpoint: pm2State.unavailable ? null : pm2State.endpoint,
      unavailable: appsState.unavailable,
      example: appsState.local ? registerExample() : null,
    });
    const syncState = engineState(FEATURES.fileSync);
    FileSyncUI.setEngine({ base: syncState.endpoint, label: syncState.label, unavailable: syncState.unavailable });
  }

  function showPage(name) {
    page = name;
    if (name !== 'tasks') applyEngine();
    Apps.setActive(name === 'apps');
    AgentConfig.setActive(name === 'agent-config');
    Frp.setActive(name === 'frp');
    FileSyncUI.setActive(name === 'file-sync');
    document.body.classList.toggle('tools-open', name === 'tools');
    document.body.classList.toggle('apps-open', name === 'apps');
    document.body.classList.toggle('agent-config-open', name === 'agent-config');
    document.body.classList.toggle('frp-open', name === 'frp');
    document.body.classList.toggle('file-sync-open', name === 'file-sync');
    toolsPanel.hidden = name !== 'tools';
    appsPanel.hidden = name !== 'apps';
    agentConfigPanel.hidden = name !== 'agent-config';
    frpPanel.hidden = name !== 'frp';
    fileSyncPanel.hidden = name !== 'file-sync';
    for (const [key, tab] of Object.entries(tabs)) {
      tab.classList.toggle('active', key === name);
      tab.setAttribute('aria-pressed', String(key === name));
    }
    if (name === 'tasks') window.dispatchEvent(new Event('resize'));
  }
  const show = tools => showPage(tools ? 'tools' : 'tasks');

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const area = document.createElement('textarea');
    area.value = text; area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area); area.select();
    try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
  }
  if (typeof Tasks !== 'undefined') Tasks.onSourceChange(() => { if (page !== 'tasks') applyEngine(); });
  for (const [name, tab] of Object.entries(tabs)) tab.addEventListener('click', () => showPage(name));
  document.querySelectorAll('.tool-copy-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const status = button.closest('.tool-card-actions').querySelector('.tool-copy-status');
      status.textContent = (await copy(commandFor(button))) ? 'Copied' : 'Copy failed. Check the browser clipboard permission';
      clearTimeout(timers.get(status)); timers.set(status, setTimeout(() => { status.textContent = ''; }, 2500));
    });
  });
  return { show, showPage, commandFor };
})();
