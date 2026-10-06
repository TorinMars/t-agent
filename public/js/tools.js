// PM2 进程管理：管理“当前引擎”所在机器上的进程（本地走 /api/pm2，远程 Engine 经 Client 代理走 /api/remote-servers/:id/pm2）。
// 只在“实用工具”页可见时轮询；所有文本都用 textContent 写入，避免注入。
const pm2 = (() => {
  const table = document.getElementById('pm2-table');
  const body = document.getElementById('pm2-body');
  const hint = document.getElementById('pm2-hint');
  const statusText = document.getElementById('pm2-status');
  const logsBox = document.getElementById('pm2-logs');
  const logText = document.getElementById('pm2-log-text');
  const logStream = document.getElementById('pm2-logs-stream');
  const logLines = document.getElementById('pm2-logs-lines');
  const defaultHintFor = place => `管理${place}上的 PM2 进程。可以启动、停止、重启、reload 和查看日志；停止或重启前会确认。`;
  let active = false, listTimer = null, logTimer = null, logTarget = null, busy = false;
  let base = '/api/pm2', where = '运行 Client 的这台机器', blocked = null, generation = 0;

  // 远程请求只返回错误码，这里转成中文；本机路由本身返回中文。
  const CODE_MESSAGES = {
    PM2_NOT_INSTALLED: '未检测到 pm2', PM2_NOT_RUNNING: 'PM2 守护进程没有运行',
    PM2_UNSUPPORTED: '该引擎版本过旧，暂不支持 PM2 管理，请先升级该引擎',
    PM2_COMMAND_FAILED: 'pm2 命令执行失败', PM2_UNAVAILABLE: 'PM2 管理服务暂时不可用',
    REMOTE_NOT_FOUND: '这个远程连接已不存在', REMOTE_HTTP_401: '该引擎的认证已失效',
    REMOTE_CONNECTION_FAILED: '无法连接该引擎', REMOTE_TIMEOUT: '连接该引擎超时',
  };
  const errorMessage = error => {
    let message = error.message;
    try { message = JSON.parse(error.message).error || error.message; } catch { /* 不是 JSON */ }
    return CODE_MESSAGES[message] || message;
  };
  const formatMemory = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);
  function formatUptime(startedAt) {
    if (!startedAt) return '-';
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
    return `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`;
  }
  const cell = (row, text) => { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; };

  function button(label, handler) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn-logout'; b.textContent = label;
    b.addEventListener('click', handler);
    return b;
  }

  async function act(proc, action) {
    const label = { start: '启动', stop: '停止', restart: '重启', reload: 'reload' }[action];
    let question = null;
    if (action === 'stop') question = `确定停止 ${proc.name}？`;
    if (proc.self && action !== 'start') question = `${proc.name} 就是当前正在提供本页面的 t-agent。${label}后页面会中断${action === 'stop' ? '，并且需要在这台机器上手动启动才能恢复' : '几秒'}。继续吗？`;
    if (question && !confirm(question)) return;
    statusText.textContent = `正在${label} ${proc.name}…`;
    try {
      await API.post(`${base}/${proc.id}/${action}`, {});
      statusText.textContent = `已${label} ${proc.name}`;
    } catch (error) {
      statusText.textContent = proc.self ? '请求已发出，页面可能会短暂断开' : `${label}失败：${errorMessage(error)}`;
    }
    await refresh();
  }

  function render(data) {
    body.textContent = '';
    if (!data.installed) {
      table.hidden = true;
      hint.textContent = `${where}上未检测到 PM2。在该机器上运行下方“安装开发环境”的安装命令即可安装（需要 Node.js，缺少时会自动安装到用户目录）。`;
      return;
    }
    if (!data.running) {
      table.hidden = true;
      hint.textContent = 'PM2 已安装，但守护进程没有运行（还没有启动过任何进程）。用 pm2 start 启动第一个服务后这里会显示。';
      return;
    }
    hint.textContent = defaultHintFor(where);
    table.hidden = data.processes.length === 0;
    if (data.processes.length === 0) hint.textContent = 'PM2 正在运行，但当前没有任何进程。';
    for (const proc of data.processes) {
      const row = document.createElement('tr');
      const name = cell(row, `${proc.name}`);
      name.className = 'pm2-name';
      const detail = document.createElement('small');
      detail.textContent = `#${proc.id} · ${proc.script || '-'}${proc.self ? ' · 当前页面所在服务' : ''}`;
      detail.title = proc.cwd || '';
      name.append(detail);
      const badgeCell = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `pm2-badge ${proc.status}`; badge.textContent = proc.status;
      badgeCell.append(badge); row.append(badgeCell);
      cell(row, `${proc.cpu}%`);
      cell(row, proc.status === 'online' ? formatMemory(proc.memory) : '-');
      cell(row, formatUptime(proc.startedAt));
      cell(row, proc.unstableRestarts ? `${proc.restarts}（不稳定 ${proc.unstableRestarts}）` : String(proc.restarts));
      const actions = document.createElement('td');
      const group = document.createElement('div'); group.className = 'pm2-actions';
      if (proc.status !== 'online') group.append(button('启动', () => act(proc, 'start')));
      if (proc.status === 'online') {
        group.append(button('重启', () => act(proc, 'restart')), button('Reload', () => act(proc, 'reload')), button('停止', () => act(proc, 'stop')));
      }
      group.append(button('日志', () => openLogs(proc)));
      actions.append(group); row.append(actions);
      body.append(row);
    }
  }

  async function refresh() {
    if (busy || blocked) return;
    busy = true;
    const mine = generation;
    try {
      const data = await API.get(`${base}/status`);
      if (mine !== generation) return; // 已切换到别的引擎，丢弃过期结果
      render(data);
      if (!statusText.textContent.startsWith('正在')) statusText.textContent = `更新于 ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (mine === generation) statusText.textContent = `读取失败：${errorMessage(error)}`;
    } finally { busy = false; }
  }

  async function loadLogs() {
    if (!logTarget) return;
    const mine = generation;
    try {
      const data = await API.get(`${base}/${logTarget.id}/logs?stream=${logStream.value}&lines=${logLines.value}`);
      if (mine !== generation) return;
      const stick = logText.scrollTop + logText.clientHeight >= logText.scrollHeight - 30;
      logText.textContent = data.lines.length ? data.lines.join('\n') : '（暂无日志）';
      if (stick) logText.scrollTop = logText.scrollHeight;
    } catch (error) {
      logText.textContent = `读取日志失败：${errorMessage(error)}`;
    }
  }
  function openLogs(proc) {
    logTarget = proc;
    document.getElementById('pm2-logs-title').textContent = `${proc.name} 的日志`;
    logsBox.hidden = false;
    logText.textContent = '加载中…';
    loadLogs().then(() => { logText.scrollTop = logText.scrollHeight; });
    clearInterval(logTimer);
    logTimer = setInterval(() => { if (active && !document.hidden) loadLogs(); }, 2000);
  }
  function closeLogs() {
    logTarget = null; logsBox.hidden = true; clearInterval(logTimer); logTimer = null;
  }

  function setActive(value) {
    active = value;
    clearInterval(listTimer); listTimer = null;
    if (active) {
      refresh();
      listTimer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    } else {
      closeLogs();
    }
  }

  // 切换引擎：换请求地址，清掉上一个引擎的进程表和日志。blocked 非空时说明当前引擎不能用 PM2，只显示原因。
  function setEngine({ endpoint = '/api/pm2', label = '', local = true, unavailable = null } = {}) {
    const changed = endpoint !== base || unavailable !== blocked;
    base = endpoint;
    where = local ? '运行 Client 的这台机器' : `引擎「${label}」所在机器`;
    blocked = unavailable;
    if (!changed) return;
    generation += 1;
    busy = false;
    closeLogs();
    body.textContent = '';
    table.hidden = true;
    statusText.textContent = '';
    document.getElementById('pm2-refresh').disabled = Boolean(blocked);
    hint.textContent = blocked || defaultHintFor(where);
    if (active && !blocked) refresh();
  }

  document.getElementById('pm2-refresh').addEventListener('click', () => { statusText.textContent = ''; refresh(); });
  document.getElementById('pm2-logs-close').addEventListener('click', closeLogs);
  logStream.addEventListener('change', loadLogs);
  logLines.addEventListener('change', loadLogs);
  return { setActive, setEngine };
})();

// Utility tools live beside Tasks; switching only toggles visibility so terminals stay connected.
const Tools = (() => {
  const SCRIPT_BASE_URL = 'https://raw.githubusercontent.com/TorinMars/t-agent/main/scripts/';
  const commandFor = button => {
    const args = button.dataset.args;
    return `curl -fsSL ${SCRIPT_BASE_URL}${button.dataset.script} | bash${args ? ` -s -- ${args}` : ''}`;
  };
  const tabTasks = document.getElementById('tab-tasks');
  const tabTools = document.getElementById('tab-tools');
  const panel = document.getElementById('tools-panel');
  const engineLabel = document.getElementById('tools-engine');
  const timers = new WeakMap();

  // 工具属于当前引擎：本地引擎用 Client 自己的接口，远程引擎经代理访问其 /v1 接口。
  // 所有引擎连接都是管理权限，所以远程引擎只看是否声明了 pm2:manage 能力（旧版 Engine 没有）。
  function engineState() {
    const tasks = typeof Tasks === 'undefined' ? null : Tasks;
    const src = tasks && tasks.getSource(tasks.getActiveKey());
    if (!src || src.local) return { label: src ? src.label : '默认', local: true, endpoint: '/api/pm2', unavailable: null };
    const state = { label: src.label, local: false, endpoint: `/api/remote-servers/${src.id}/pm2`, unavailable: null };
    if (tasks.problemOf(src.key)) state.unavailable = '该引擎当前无法连接，请先在顶部引擎栏处理连接问题。';
    else if (!src.role) state.unavailable = '正在读取该引擎的能力…';
    else if (!src.caps || !src.caps.has('pm2:manage')) state.unavailable = '该引擎版本过旧，暂不支持 PM2 管理，请先升级该引擎。';
    return state;
  }
  function applyEngine() {
    const state = engineState();
    engineLabel.replaceChildren('当前引擎：');
    const name = document.createElement('strong');
    name.textContent = state.label;
    engineLabel.append(name, state.local ? '（运行 Client 的这台机器）' : '（远程引擎所在机器）');
    pm2.setEngine(state);
  }

  function show(tools) {
    if (tools) applyEngine();
    pm2.setActive(tools);
    document.body.classList.toggle('tools-open', tools);
    panel.hidden = !tools;
    tabTasks.classList.toggle('active', !tools); tabTasks.setAttribute('aria-pressed', String(!tools));
    tabTools.classList.toggle('active', tools); tabTools.setAttribute('aria-pressed', String(tools));
    if (!tools) window.dispatchEvent(new Event('resize'));
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const area = document.createElement('textarea');
    area.value = text; area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area); area.select();
    try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
  }
  if (typeof Tasks !== 'undefined') Tasks.onSourceChange(() => { if (!panel.hidden) applyEngine(); });
  tabTasks.addEventListener('click', () => show(false));
  tabTools.addEventListener('click', () => show(true));
  document.querySelectorAll('.tool-copy-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const status = button.closest('.tool-card-actions').querySelector('.tool-copy-status');
      status.textContent = (await copy(commandFor(button))) ? '已复制' : '复制失败，请检查浏览器剪贴板权限';
      clearTimeout(timers.get(status)); timers.set(status, setTimeout(() => { status.textContent = ''; }, 2500));
    });
  });
  return { show, commandFor };
})();
