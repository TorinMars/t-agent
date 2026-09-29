// PM2 进程管理：只在“实用工具”页可见时轮询；所有文本都用 textContent 写入，避免注入。
const pm2 = (() => {
  const table = document.getElementById('pm2-table');
  const body = document.getElementById('pm2-body');
  const hint = document.getElementById('pm2-hint');
  const statusText = document.getElementById('pm2-status');
  const logsBox = document.getElementById('pm2-logs');
  const logText = document.getElementById('pm2-log-text');
  const logStream = document.getElementById('pm2-logs-stream');
  const logLines = document.getElementById('pm2-logs-lines');
  const defaultHint = hint.textContent;
  let active = false, listTimer = null, logTimer = null, logTarget = null, busy = false;

  const errorMessage = error => {
    try { return JSON.parse(error.message).error || error.message; } catch { return error.message; }
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
      await API.post(`/api/pm2/${proc.id}/${action}`, {});
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
      hint.textContent = '这台机器上未检测到 PM2。运行下方“安装开发环境”的安装命令即可安装（需要 Node.js，缺少时会自动安装到用户目录）。';
      return;
    }
    if (!data.running) {
      table.hidden = true;
      hint.textContent = 'PM2 已安装，但守护进程没有运行（还没有启动过任何进程）。用 pm2 start 启动第一个服务后这里会显示。';
      return;
    }
    hint.textContent = defaultHint;
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
    if (busy) return;
    busy = true;
    try {
      render(await API.get('/api/pm2/status'));
      if (!statusText.textContent.startsWith('正在')) statusText.textContent = `更新于 ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      statusText.textContent = `读取失败：${errorMessage(error)}`;
    } finally { busy = false; }
  }

  async function loadLogs() {
    if (!logTarget) return;
    try {
      const data = await API.get(`/api/pm2/${logTarget.id}/logs?stream=${logStream.value}&lines=${logLines.value}`);
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

  document.getElementById('pm2-refresh').addEventListener('click', () => { statusText.textContent = ''; refresh(); });
  document.getElementById('pm2-logs-close').addEventListener('click', closeLogs);
  logStream.addEventListener('change', loadLogs);
  logLines.addEventListener('change', loadLogs);
  return { setActive };
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
  const timers = new WeakMap();

  function show(tools) {
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
