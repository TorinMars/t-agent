// "Update all" in the sidebar: first upgrade all connected remote engines in parallel, then this Client (updating it restarts the service and reloads the page, so it goes last).
const BatchUpdate = (() => {
  const button = document.getElementById('btn-batch-update');
  const ENGINE_TIMEOUT_MS = 5 * 60 * 1000;
  let running = false;

  const codeOf = error => {
    let text = (error && error.message) || 'failed';
    try { text = JSON.parse(text).error || text; } catch { /* keep the original text */ }
    return Updates.errorLabel(text) || text;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const versionOf = status => status.local_version || (status.local_manifest && status.local_manifest.app_version) || '';

  const rows = [];
  function addRow(name) {
    const row = { name, text: 'Waiting…', cls: '' };
    rows.push(row);
    return row;
  }
  function render(footer = '') {
    const body = rows.map(row => `
      <div class="update-detail-row"><span>${escapeHtml(row.name)}</span><strong class="${row.cls}">${escapeHtml(row.text)}</strong></div>`).join('');
    Modal.show('Update all', `${body}${footer}`);
    const close = document.getElementById('batch-update-close');
    if (close) close.addEventListener('click', Modal.hide);
  }
  const set = (row, text, cls = '') => { row.text = text; row.cls = cls; if (running) render(); };

  async function upgradeEngine(server) {
    const row = addRow(`${server.name} (remote)`);
    try {
      set(row, 'Checking for updates…');
      const status = await API.post(`/api/remote-servers/${server.id}/check-update`, {});
      if (status.status === 'restart_pending') return set(row, 'Code updated; restart the service on that machine', 'error');
      if (status.status !== 'available') return set(row, status.status === 'current' ? `Up to date ${versionOf(status)}` : (status.message || Updates.statusLabel(status.status)), status.status === 'blocked' || status.status === 'failed' ? 'error' : '');
      const target = status.remote_version;
      set(row, `Updating ${versionOf(status)} → ${target}…`);
      await API.post(`/api/remote-servers/${server.id}/apply-update`, {});
      const deadline = Date.now() + ENGINE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(2000);
        let current;
        try { current = await API.get(`/api/remote-servers/${server.id}/update-status`); }
        catch { set(row, 'Restarting, waiting for recovery…'); continue; }
        if (current.status === 'blocked' || current.status === 'failed') return set(row, `Update failed: ${Updates.errorLabel(current.error) || current.message || ''}${current.error_details ? ` (${current.error_details})` : ''}`, 'error');
        if (versionOf(current) === target && current.status !== 'updating') { Tasks.disposeSourceTerminals(`remote:${server.id}`); return set(row, `Updated to ${target}`, 'ok'); }
        if (current.message) set(row, current.message);
      }
      set(row, 'Timed out waiting for recovery. Check the service and logs on that machine', 'error');
    } catch (error) { set(row, `failed: ${codeOf(error)}`, 'error'); }
  }

  async function run() {
    if (running) return;
    running = true;
    rows.length = 0;
    button.disabled = true;
    try {
      let servers = [];
      try { servers = await API.get('/api/remote-servers'); } catch { servers = []; }
      const localRow = addRow('This client');
      render();
      await Promise.all(servers.map(upgradeEngine));
      localRow.text = 'Checking for updates…';
      render();
      let local;
      try { local = await API.post('/api/system/check-update', {}); }
      catch (error) { set(localRow, `failed: ${codeOf(error)}`, 'error'); return finish(); }
      if (local.status === 'available' && local.is_update_admin) {
        running = false;
        button.disabled = false;
        await Updates.apply(); // hand over to the local update flow: it shows progress, waits for the restart and reloads the page
        return;
      }
      if (local.status === 'available') set(localRow, Updates.errorLabel('UPDATE_ADMIN_REQUIRED'), 'error');
      else if (local.status === 'restart_pending') set(localRow, 'Code updated; restart the local service', 'error');
      else set(localRow, local.status === 'current' ? `Up to date ${local.local_version || ''}` : (local.message || Updates.statusLabel(local.status)), local.status === 'blocked' || local.status === 'failed' ? 'error' : '');
      finish();
    } finally { if (running) { running = false; button.disabled = false; } }
  }
  function finish() {
    running = false;
    button.disabled = false;
    render('<div class="form-actions"><button class="btn-submit" id="batch-update-close" type="button">Close</button></div>');
  }

  if (button) button.addEventListener('click', () => {
    if (!confirm('Check and update this Client and all connected remote engines?\nUpdating restarts the services and interrupts terminal sessions on each machine; this machine is updated last and the page refreshes automatically.')) return;
    run();
  });
  return { run };
})();
window.BatchUpdate = BatchUpdate;
