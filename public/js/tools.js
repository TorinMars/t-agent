// 实用工具和应用列表都和“任务”并列，切换只是显示/隐藏，终端连接保持不断。
const Tools = (() => {
  const SCRIPT_BASE_URL = 'https://raw.githubusercontent.com/TorinMars/t-agent/main/scripts/';
  const commandFor = button => {
    const args = button.dataset.args;
    return `curl -fsSL ${SCRIPT_BASE_URL}${button.dataset.script} | bash${args ? ` -s -- ${args}` : ''}`;
  };
  const tabs = { tasks: document.getElementById('tab-tasks'), tools: document.getElementById('tab-tools'), apps: document.getElementById('tab-apps') };
  const toolsPanel = document.getElementById('tools-panel');
  const appsPanel = document.getElementById('apps-panel');
  const appsEngineLabel = document.getElementById('apps-engine');
  const timers = new WeakMap();
  let page = 'tasks';

  // 应用列表属于当前引擎：本地引擎用 Client 自己的接口，远程引擎经代理访问其 /v1 接口。
  // 所有引擎连接都是管理权限，所以远程引擎只看是否声明了对应能力（旧版 Engine 没有）。
  // pm2 只用于应用列表里的 PM2 操作（启动/停止/重启/reload/日志），不再有单独的面板。
  const FEATURES = {
    pm2: { capability: 'pm2:manage', local: '/api/pm2', suffix: 'pm2', missing: '该引擎版本过旧，暂不支持 PM2 管理，请先升级该引擎。' },
    apps: { capability: 'apps:manage', local: '/api/apps', suffix: 'apps', missing: '该引擎版本过旧，暂不支持应用列表，请先升级该引擎。' },
  };
  function engineState(feature) {
    const tasks = typeof Tasks === 'undefined' ? null : Tasks;
    const src = tasks && tasks.getSource(tasks.getActiveKey());
    if (!src || src.local) return { label: src ? src.label : '默认', local: true, endpoint: feature.local, unavailable: null };
    const state = { label: src.label, local: false, endpoint: `/api/remote-servers/${src.id}/${feature.suffix}`, unavailable: null };
    if (tasks.problemOf(src.key)) state.unavailable = '该引擎当前无法连接，请先在顶部引擎栏处理连接问题。';
    else if (!src.role) state.unavailable = '正在读取该引擎的能力…';
    else if (!src.caps || !src.caps.has(feature.capability)) state.unavailable = feature.missing;
    return state;
  }
  function describeEngine(node, state) {
    node.replaceChildren('当前引擎：');
    const name = document.createElement('strong');
    name.textContent = state.label;
    node.append(name, state.local ? '（运行 Client 的这台机器）' : '（远程引擎所在机器）');
  }
  const registerExample = () => [
    `curl -X POST ${location.origin}/v1/apps/register \\`,
    '  -H "Authorization: Bearer <访问令牌>" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"name":"my-service","port":8080,"domain":"my.example.com","description":"服务说明"}\'',
  ].join('\n');

  function applyEngine() {
    const pm2State = engineState(FEATURES.pm2);
    const appsState = engineState(FEATURES.apps);
    describeEngine(appsEngineLabel, appsState);
    Apps.setEngine({
      endpoint: appsState.endpoint,
      // 应用列表里的 PM2 操作沿用 PM2 接口；该引擎不支持 PM2 时只隐藏这些按钮。
      pm2Endpoint: pm2State.unavailable ? null : pm2State.endpoint,
      unavailable: appsState.unavailable,
      example: appsState.local ? registerExample() : null,
    });
  }

  function showPage(name) {
    page = name;
    if (name !== 'tasks') applyEngine();
    Apps.setActive(name === 'apps');
    document.body.classList.toggle('tools-open', name === 'tools');
    document.body.classList.toggle('apps-open', name === 'apps');
    toolsPanel.hidden = name !== 'tools';
    appsPanel.hidden = name !== 'apps';
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
      status.textContent = (await copy(commandFor(button))) ? '已复制' : '复制失败，请检查浏览器剪贴板权限';
      clearTimeout(timers.get(status)); timers.set(status, setTimeout(() => { status.textContent = ''; }, 2500));
    });
  });
  return { show, showPage, commandFor };
})();
