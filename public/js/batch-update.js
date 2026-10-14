// 侧栏“一键更新全部”：先并行升级所有已连接的远程引擎，再升级本机 Client（本机更新会重启服务并刷新页面，所以放最后）。
const BatchUpdate = (() => {
  const button = document.getElementById('btn-batch-update');
  const ENGINE_TIMEOUT_MS = 5 * 60 * 1000;
  let running = false;

  const codeOf = error => {
    let text = (error && error.message) || '失败';
    try { text = JSON.parse(text).error || text; } catch { /* 保持原文 */ }
    return Updates.errorLabel(text) || text;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const versionOf = status => status.local_version || (status.local_manifest && status.local_manifest.app_version) || '';

  const rows = [];
  function addRow(name) {
    const row = { name, text: '等待中…', cls: '' };
    rows.push(row);
    return row;
  }
  function render(footer = '') {
    const body = rows.map(row => `
      <div class="update-detail-row"><span>${escapeHtml(row.name)}</span><strong class="${row.cls}">${escapeHtml(row.text)}</strong></div>`).join('');
    Modal.show('一键更新全部', `${body}${footer}`);
    const close = document.getElementById('batch-update-close');
    if (close) close.addEventListener('click', Modal.hide);
  }
  const set = (row, text, cls = '') => { row.text = text; row.cls = cls; if (running) render(); };

  async function upgradeEngine(server) {
    const row = addRow(`${server.name}（远程）`);
    try {
      set(row, '正在检查更新…');
      const status = await API.post(`/api/remote-servers/${server.id}/check-update`, {});
      if (status.status === 'restart_pending') return set(row, '代码已更新，需在该机器上重启服务', 'error');
      if (status.status !== 'available') return set(row, status.status === 'current' ? `已是最新 ${versionOf(status)}` : (status.message || Updates.statusLabel(status.status)), status.status === 'blocked' || status.status === 'failed' ? 'error' : '');
      const target = status.remote_version;
      set(row, `正在更新 ${versionOf(status)} → ${target}…`);
      await API.post(`/api/remote-servers/${server.id}/apply-update`, {});
      const deadline = Date.now() + ENGINE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(2000);
        let current;
        try { current = await API.get(`/api/remote-servers/${server.id}/update-status`); }
        catch { set(row, '正在重启，等待恢复…'); continue; }
        if (current.status === 'blocked' || current.status === 'failed') return set(row, `更新失败：${Updates.errorLabel(current.error) || current.message || ''}${current.error_details ? `（${current.error_details}）` : ''}`, 'error');
        if (versionOf(current) === target && current.status !== 'updating') { Tasks.disposeSourceTerminals(`remote:${server.id}`); return set(row, `已更新到 ${target}`, 'ok'); }
        if (current.message) set(row, current.message);
      }
      set(row, '等待恢复超时，请检查该机器上的服务和日志', 'error');
    } catch (error) { set(row, `失败：${codeOf(error)}`, 'error'); }
  }

  async function run() {
    if (running) return;
    running = true;
    rows.length = 0;
    button.disabled = true;
    try {
      let servers = [];
      try { servers = await API.get('/api/remote-servers'); } catch { servers = []; }
      const localRow = addRow('本机 Client');
      render();
      await Promise.all(servers.map(upgradeEngine));
      localRow.text = '正在检查更新…';
      render();
      let local;
      try { local = await API.post('/api/system/check-update', {}); }
      catch (error) { set(localRow, `失败：${codeOf(error)}`, 'error'); return finish(); }
      if (local.status === 'available' && local.is_update_admin) {
        running = false;
        button.disabled = false;
        await Updates.apply(); // 交给本机更新流程：显示进度、等待重启并刷新页面
        return;
      }
      if (local.status === 'available') set(localRow, Updates.errorLabel('UPDATE_ADMIN_REQUIRED'), 'error');
      else if (local.status === 'restart_pending') set(localRow, '代码已更新，需重启本机服务', 'error');
      else set(localRow, local.status === 'current' ? `已是最新 ${local.local_version || ''}` : (local.message || Updates.statusLabel(local.status)), local.status === 'blocked' || local.status === 'failed' ? 'error' : '');
      finish();
    } finally { if (running) { running = false; button.disabled = false; } }
  }
  function finish() {
    running = false;
    button.disabled = false;
    render('<div class="form-actions"><button class="btn-submit" id="batch-update-close" type="button">关闭</button></div>');
  }

  if (button) button.addEventListener('click', () => {
    if (!confirm('检查并更新本机 Client 和所有已连接的远程引擎？\n更新会重启服务，中断各机器上的终端会话；本机最后更新并自动刷新页面。')) return;
    run();
  });
  return { run };
})();
window.BatchUpdate = BatchUpdate;
