// Workspace tools: prompt about unmanaged directories and import them in bulk; open a task list to clean up unused code directories in bulk.
const WorkspaceTools = (() => {
  const importButton = document.getElementById('btn-workspace-import');
  const cleanupButton = document.getElementById('btn-workspace-cleanup');
  let unmanaged = [];

  const formatSize = bytes => {
    if (!bytes) return '—';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };
  const errorText = error => {
    let text = error.message || 'Operation failed';
    try { const data = JSON.parse(text); text = data.reason ? `${data.error}: ${data.reason}` : data.error; } catch { /* keep the original text */ }
    return text;
  };
  // Follows the current engine: local uses /api/tasks/workspace, a remote Engine goes through the proxy at /api/remote-servers/:id/workspace.
  const activeSource = () => (window.Tasks && Tasks.getSource(Tasks.getActiveKey())) || { local: true };
  const base = () => { const src = activeSource(); return src.local ? '/api/tasks/workspace' : `/api/remote-servers/${src.id}/workspace`; };
  const supported = () => { const src = activeSource(); return src.local || (src.caps && src.caps.has('workspace:manage')); };
  const UNSUPPORTED = '<p>This engine is too old to import or clean up the workspace. Please update it first.</p>';
  const refreshTasks = async () => { if (window.Tasks) await Tasks.refresh(); };

  // ---------- Import ----------
  async function loadUnmanaged() {
    const key = Tasks.getActiveKey();
    let items = [];
    if (supported()) { try { items = (await API.get(`${base()}/unmanaged`)).items; } catch { items = []; } }
    if (key !== Tasks.getActiveKey()) return unmanaged; // the engine was switched while loading; discard the stale result
    unmanaged = items;
    if (importButton) {
      const badge = document.getElementById('workspace-import-badge');
      importButton.classList.toggle('has-items', unmanaged.length > 0);
      importButton.dataset.tip = unmanaged.length ? `Import ${unmanaged.length} unmanaged directories from the workspace` : 'Import directories from the workspace (none unmanaged)';
      importButton.setAttribute('aria-label', importButton.dataset.tip);
      badge.hidden = !unmanaged.length;
      badge.textContent = unmanaged.length > 99 ? '99+' : String(unmanaged.length);
    }
    return unmanaged;
  }

  function renderImport() {
    Modal.show('Import directories from the workspace', `
      <p class="wt-intro">These directories are in the working directory but are not tasks yet. Tick them to import in bulk; only tasks are registered and no files are created in the directories.</p>
      <label class="wt-row wt-all"><input type="checkbox" id="wt-import-all" checked> <strong>Select all</strong> <span class="wt-muted" id="wt-import-count"></span></label>
      <ul class="wt-list">${unmanaged.map((item, index) => `
        <li><label class="wt-row"><input type="checkbox" class="wt-import-item" data-index="${index}" checked>
          <span><strong>${escapeHtml(item.name)}</strong>${item.is_git ? ' <span class="wt-tag">Git</span>' : ''}<br><code>${escapeHtml(item.path)}</code></span></label></li>`).join('')}
      </ul>
      <div class="wt-actions"><button class="btn-submit" id="wt-import-run" type="button">Import selected</button></div>
      <p class="wt-error" id="wt-error" role="alert"></p>`);
    const items = [...document.querySelectorAll('.wt-import-item')];
    const all = document.getElementById('wt-import-all');
    const update = () => {
      const chosen = items.filter(el => el.checked).length;
      document.getElementById('wt-import-count').textContent = `Selected ${chosen} / ${items.length}`;
      document.getElementById('wt-import-run').disabled = !chosen;
      all.checked = chosen === items.length;
    };
    all.addEventListener('change', () => { items.forEach(el => { el.checked = all.checked; }); update(); });
    items.forEach(el => el.addEventListener('change', update));
    update();
    document.getElementById('wt-import-run').addEventListener('click', async event => {
      const paths = items.filter(el => el.checked).map(el => unmanaged[Number(el.dataset.index)].path);
      event.currentTarget.disabled = true;
      try {
        await API.post(`${base()}/import`, { paths });
        await refreshTasks();
        await loadUnmanaged();
        if (unmanaged.length) renderImport(); else Modal.hide();
      } catch (error) { document.getElementById('wt-error').textContent = errorText(error); update(); }
    });
  }

  // ---------- Cleanup ----------
  async function openCleanup() {
    if (!supported()) { Modal.show('Clean up code directories', UNSUPPORTED); return; }
    Modal.show('Clean up code directories', '<p class="wt-intro">Scanning each task directory’s size and Git status; this can take tens of seconds with many directories…</p>');
    let data;
    try { data = await API.get(`${base()}/cleanup`); }
    catch (error) { Modal.show('Clean up code directories', `<p class="wt-error">${escapeHtml(errorText(error))}</p>`); return; }
    renderCleanup(data);
  }

  function renderCleanup(data) {
    // Group by task, with tasks ordered by the total size of their repos (largest first); a task directory itself is usually not a repo, what is listed are the repos inside it.
    const groups = new Map();
    for (const item of data.items) {
      if (!groups.has(item.task_id)) groups.set(item.task_id, { title: item.title, path: item.task_path, items: [], total: 0 });
      const group = groups.get(item.task_id);
      group.items.push(item);
      group.total += item.size_bytes;
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
    const rows = ordered.map(([taskId, group]) => `
      <li class="wt-group"><div class="wt-group-head"><strong>${escapeHtml(group.title)}</strong>
        <span class="wt-muted">${group.items.length} repos · ${formatSize(group.total)}</span><br><code>${escapeHtml(group.path)}</code></div>
        <ul class="wt-list wt-nested">${group.items.map(item => `
          <li><label class="wt-row${item.safe ? '' : ' wt-blocked'}">
            <input type="checkbox" class="wt-clean-item" data-task="${taskId}" data-path="${escapeHtml(item.path)}" ${item.safe ? '' : 'disabled'}>
            <span class="wt-grow"><strong>${escapeHtml(item.name)}</strong>
              ${item.safe ? '' : `<span class="wt-reason">${escapeHtml(item.reason)}</span>`}</span>
            <span class="wt-meta">${formatSize(item.size_bytes)}<br>${item.idle_days == null ? '' : `${item.idle_days} days untouched`}</span></label></li>`).join('')}
        </ul></li>`).join('');
    const archived = data.archived.map(item => `
      <li class="wt-row"><span class="wt-grow"><strong>${escapeHtml(item.title)}</strong> / ${escapeHtml(item.path.split('/').pop())}
        <span class="wt-muted">Cleaned on ${escapeHtml(String(item.cleaned_at).slice(0, 10))}, freed ${formatSize(item.size_bytes)}</span><br><code>${escapeHtml(item.restore)}</code></span>
        <button class="toolbar-btn" data-restore="${item.id}" type="button">Restore from repo</button></li>`).join('');
    Modal.show('Clean up code directories', `
      <p class="wt-intro">Task directories are usually not Git repos. This lists all repos inside each task directory (up to 3 levels deep); tick them to delete the local repo directories in bulk. Other files, tasks and to-dos in the task directory are kept. A repo can only be ticked if it has no uncommitted changes, no unpushed commits and no stash, and it can be restored from its remote address. Sorted by size, largest first; repos untouched for more than ${data.idle_days_threshold} days are suggested for cleanup first.</p>
      ${data.items.length ? `<label class="wt-row wt-all"><input type="checkbox" id="wt-clean-all"> <strong>Select all cleanable</strong> <span class="wt-muted" id="wt-clean-sum"></span></label>
      <ul class="wt-list">${rows}</ul>
      <div class="wt-actions"><button class="btn-submit" id="wt-clean-run" type="button">Clean selected</button></div>` : '<p>No Git repos were found in the task directories.</p>'}
      ${archived ? `<h4>Cleaned, restorable</h4><ul class="wt-list">${archived}</ul>` : ''}
      <p class="wt-error" id="wt-error" role="alert"></p>`);
    const boxes = [...document.querySelectorAll('.wt-clean-item')];
    const itemOf = el => data.items.find(item => item.path === el.dataset.path);
    const update = () => {
      const chosen = boxes.filter(el => el.checked);
      const sum = document.getElementById('wt-clean-sum');
      if (sum) sum.textContent = chosen.length ? `Selected ${chosen.length}, about ${formatSize(chosen.reduce((total, el) => total + itemOf(el).size_bytes, 0))}` : '';
      const run = document.getElementById('wt-clean-run');
      if (run) run.disabled = !chosen.length;
    };
    const all = document.getElementById('wt-clean-all');
    if (all) all.addEventListener('change', () => { boxes.filter(el => !el.disabled).forEach(el => { el.checked = all.checked; }); update(); });
    boxes.forEach(el => el.addEventListener('change', update));
    update();
    const fail = text => { document.getElementById('wt-error').textContent = text; };
    const run = document.getElementById('wt-clean-run');
    if (run) run.addEventListener('click', async () => {
      const chosen = boxes.filter(el => el.checked).map(itemOf);
      const total = chosen.reduce((sum, item) => sum + item.size_bytes, 0);
      if (!confirm(`Delete the local directories of ${chosen.length} repo(s), freeing about ${formatSize(total)}?\n\n${chosen.map(item => item.path).join('\n')}\n\nThe content is in the remote repositories and can be restored later.`)) return;
      run.disabled = true; run.textContent = 'Cleaning…';
      try {
        const results = await API.post(`${base()}/cleanup`, { repos: chosen.map(item => ({ task_id: item.task_id, path: item.path })), confirm: true });
        const failed = results.filter(item => !item.ok);
        await refreshTasks();
        renderCleanup(await API.get(`${base()}/cleanup`));
        const freed = results.filter(item => item.ok).reduce((sum, item) => sum + item.freed_bytes, 0);
        fail(`Cleaned ${results.length - failed.length}, freed ${formatSize(freed)}${failed.length ? `; ${failed.length} failed: ${failed.map(item => item.reason || item.error).join('; ')}` : ''}`);
      } catch (error) { run.disabled = false; run.textContent = 'Clean selected'; fail(errorText(error)); }
    });
    document.querySelectorAll('[data-restore]').forEach(el => el.addEventListener('click', async () => {
      el.disabled = true; el.textContent = 'Restoring…';
      try {
        await API.post(`${base()}/restore`, { id: Number(el.dataset.restore) });
        await refreshTasks();
        renderCleanup(await API.get(`${base()}/cleanup`));
      } catch (error) { el.disabled = false; el.textContent = 'Restore from repo'; fail(errorText(error)); }
    }));
  }

  if (importButton) importButton.addEventListener('click', async () => {
    await loadUnmanaged();
    if (!supported()) Modal.show('Import directories from the workspace', UNSUPPORTED);
    else if (unmanaged.length) renderImport();
    else Modal.show('Import directories from the workspace', '<p>There are no directories in the working directory that are not managed by tasks.</p>');
  });
  if (cleanupButton) cleanupButton.addEventListener('click', openCleanup);
  // Check shortly after the page loads so it does not compete with the task list for startup resources.
  setTimeout(loadUnmanaged, 1500);
  // After switching engine, or once engine capabilities are ready, check that machine for unmanaged directories again.
  let seen = '';
  Tasks.onSourceChange(() => {
    const mark = `${Tasks.getActiveKey()}:${supported() ? 1 : 0}`;
    if (mark === seen) return;
    seen = mark;
    unmanaged = [];
    loadUnmanaged();
  });
  return { loadUnmanaged, openCleanup };
})();

window.WorkspaceTools = WorkspaceTools;
