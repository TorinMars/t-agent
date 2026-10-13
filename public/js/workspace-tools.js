// 工作目录工具：自动提示未管理的目录并批量导入；弹出任务列表批量清理不用的代码目录。
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
    let text = error.message || '操作失败';
    try { const data = JSON.parse(text); text = data.reason ? `${data.error}：${data.reason}` : data.error; } catch { /* 保持原文 */ }
    return text;
  };
  const refreshTasks = async () => { if (window.Tasks) await Tasks.refresh(); };

  // ---------- 导入 ----------
  async function loadUnmanaged() {
    try { unmanaged = (await API.get('/api/tasks/workspace/unmanaged')).items; } catch { unmanaged = []; }
    if (importButton) {
      importButton.hidden = !unmanaged.length;
      importButton.textContent = `📁 工作目录下有 ${unmanaged.length} 个目录未被管理 · 导入`;
    }
    return unmanaged;
  }

  function renderImport() {
    Modal.show('导入工作目录下的目录', `
      <p class="wt-intro">以下目录在工作目录里，但还不是任务。勾选后批量导入，只登记任务，不会在目录里创建文件。</p>
      <label class="wt-row wt-all"><input type="checkbox" id="wt-import-all" checked> <strong>全选</strong> <span class="wt-muted" id="wt-import-count"></span></label>
      <ul class="wt-list">${unmanaged.map((item, index) => `
        <li><label class="wt-row"><input type="checkbox" class="wt-import-item" data-index="${index}" checked>
          <span><strong>${escapeHtml(item.name)}</strong>${item.is_git ? ' <span class="wt-tag">Git</span>' : ''}<br><code>${escapeHtml(item.path)}</code></span></label></li>`).join('')}
      </ul>
      <div class="wt-actions"><button class="btn-submit" id="wt-import-run" type="button">导入所选</button></div>
      <p class="wt-error" id="wt-error" role="alert"></p>`);
    const items = [...document.querySelectorAll('.wt-import-item')];
    const all = document.getElementById('wt-import-all');
    const update = () => {
      const chosen = items.filter(el => el.checked).length;
      document.getElementById('wt-import-count').textContent = `已选 ${chosen} / ${items.length}`;
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
        await API.post('/api/tasks/workspace/import', { paths });
        await refreshTasks();
        await loadUnmanaged();
        if (unmanaged.length) renderImport(); else Modal.hide();
      } catch (error) { document.getElementById('wt-error').textContent = errorText(error); update(); }
    });
  }

  // ---------- 清理 ----------
  async function openCleanup() {
    Modal.show('清理代码目录', '<p class="wt-intro">正在扫描各任务的目录大小和 Git 状态，目录多时可能要几十秒…</p>');
    let data;
    try { data = await API.get('/api/tasks/workspace/cleanup'); }
    catch (error) { Modal.show('清理代码目录', `<p class="wt-error">${escapeHtml(errorText(error))}</p>`); return; }
    renderCleanup(data);
  }

  function renderCleanup(data) {
    const rows = data.items.map(item => `
      <li><label class="wt-row${item.safe ? '' : ' wt-blocked'}">
        <input type="checkbox" class="wt-clean-item" data-id="${item.task_id}" ${item.safe ? '' : 'disabled'}>
        <span class="wt-grow"><strong>${escapeHtml(item.title)}</strong>
          ${item.safe ? '' : `<span class="wt-reason">${escapeHtml(item.reason)}</span>`}<br><code>${escapeHtml(item.path)}</code></span>
        <span class="wt-meta">${formatSize(item.size_bytes)}<br>${item.idle_days == null ? '' : `${item.idle_days} 天没动`}</span></label></li>`).join('');
    const archived = data.archived.map(item => `
      <li class="wt-row"><span class="wt-grow"><strong>${escapeHtml(item.title)}</strong>
        <span class="wt-muted">已于 ${escapeHtml(String(item.cleaned_at).slice(0, 10))} 清理，释放 ${formatSize(item.size_bytes)}</span><br><code>${escapeHtml(item.restore)}</code></span>
        <button class="toolbar-btn" data-restore="${item.task_id}" type="button">从仓库恢复</button></li>`).join('');
    Modal.show('清理代码目录', `
      <p class="wt-intro">只删除本地文件，任务、待办保留。只有目录是 Git 仓库根、没有未提交修改、没有未推送提交时才能勾选，删除后可凭仓库地址恢复。按占用空间从大到小排列，超过 ${data.idle_days_threshold} 天没动的建议优先清理。</p>
      ${data.items.length ? `<label class="wt-row wt-all"><input type="checkbox" id="wt-clean-all"> <strong>全选可清理的</strong> <span class="wt-muted" id="wt-clean-sum"></span></label>
      <ul class="wt-list">${rows}</ul>
      <div class="wt-actions"><button class="btn-submit" id="wt-clean-run" type="button">清理所选</button></div>` : '<p>没有带目录的任务。</p>'}
      ${archived ? `<h4>已清理，可恢复</h4><ul class="wt-list">${archived}</ul>` : ''}
      <p class="wt-error" id="wt-error" role="alert"></p>`);
    const boxes = [...document.querySelectorAll('.wt-clean-item')];
    const sizeOf = id => (data.items.find(item => item.task_id === id) || {}).size_bytes || 0;
    const update = () => {
      const chosen = boxes.filter(el => el.checked);
      const sum = document.getElementById('wt-clean-sum');
      if (sum) sum.textContent = chosen.length ? `已选 ${chosen.length} 个，预计释放 ${formatSize(chosen.reduce((total, el) => total + sizeOf(Number(el.dataset.id)), 0))}` : '';
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
      const chosen = boxes.filter(el => el.checked).map(el => data.items.find(item => item.task_id === Number(el.dataset.id)));
      const total = chosen.reduce((sum, item) => sum + item.size_bytes, 0);
      if (!confirm(`确认删除 ${chosen.length} 个目录的本地文件，释放约 ${formatSize(total)}？\n\n${chosen.map(item => item.path).join('\n')}\n\n任务会保留，内容在远程仓库里，之后可以恢复。`)) return;
      run.disabled = true; run.textContent = '清理中…';
      try {
        const results = await API.post('/api/tasks/workspace/cleanup', { task_ids: chosen.map(item => item.task_id), confirm: true });
        const failed = results.filter(item => !item.ok);
        await refreshTasks();
        data = await API.get('/api/tasks/workspace/cleanup');
        renderCleanup(data);
        const freed = results.filter(item => item.ok).reduce((sum, item) => sum + item.freed_bytes, 0);
        fail(`已清理 ${results.length - failed.length} 个，释放 ${formatSize(freed)}${failed.length ? `；${failed.length} 个失败：${failed.map(item => item.reason || item.error).join('；')}` : ''}`);
      } catch (error) { run.disabled = false; run.textContent = '清理所选'; fail(errorText(error)); }
    });
    document.querySelectorAll('[data-restore]').forEach(el => el.addEventListener('click', async () => {
      el.disabled = true; el.textContent = '恢复中…';
      try {
        await API.post('/api/tasks/workspace/restore', { task_id: Number(el.dataset.restore) });
        await refreshTasks();
        renderCleanup(await API.get('/api/tasks/workspace/cleanup'));
      } catch (error) { el.disabled = false; el.textContent = '从仓库恢复'; fail(errorText(error)); }
    }));
  }

  if (importButton) importButton.addEventListener('click', async () => { await loadUnmanaged(); if (unmanaged.length) renderImport(); });
  if (cleanupButton) cleanupButton.addEventListener('click', openCleanup);
  // 页面加载后稍等再检查，避免和任务列表抢启动资源。
  setTimeout(loadUnmanaged, 1500);
  return { loadUnmanaged, openCleanup };
})();

window.WorkspaceTools = WorkspaceTools;
