// 工作目录体检：提示不合法内容，并建议清理长期闲置、内容已全部推送到远程的项目（可从仓库恢复）。
const WorkspaceHealth = (() => {
  const button = document.getElementById('btn-workspace-health');
  let report = null;

  const formatSize = bytes => {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  function updateButton() {
    if (!button) return;
    const count = report ? report.issues.length + report.stale.length : 0;
    button.hidden = !count;
    button.textContent = `⚠ 工作目录有 ${count} 项建议处理`;
  }

  async function load() {
    try { report = await API.get('/api/tasks/workspace/health'); } catch { report = null; }
    updateButton();
    return report;
  }

  function render() {
    const issues = report.issues.map((issue, index) => `
      <li class="wh-item">
        <div><strong>${escapeHtml(issue.name)}</strong> <span class="wh-msg">${escapeHtml(issue.message)}</span></div>
        <code>${escapeHtml(issue.path)}</code>
        <div class="wh-hint">${escapeHtml(issue.suggestion)}</div>
        ${issue.type === 'missing-project' ? `<button class="toolbar-btn" data-remove-project="${index}">移除这条记录</button>` : ''}
      </li>`).join('');
    const stale = report.stale.map(item => `
      <li class="wh-item">
        <div><strong>${escapeHtml(item.title)}</strong> <span class="wh-msg">${item.idle_days} 天没有动，占用 ${formatSize(item.size_bytes)}</span></div>
        <code>${escapeHtml(item.path)}</code>
        <div class="wh-hint">内容已全部推送到 ${escapeHtml(item.remote)} 的 ${escapeHtml(item.branch)} 分支，删除本地文件后可以从仓库恢复。</div>
        <button class="toolbar-btn wh-danger" data-remove-repo="${item.task_id}">删除本地文件</button>
      </li>`).join('');
    const archived = report.archived.map(item => `
      <li class="wh-item">
        <div><strong>${escapeHtml(item.title)}</strong> <span class="wh-msg">已于 ${escapeHtml(item.deleted_at.slice(0, 10))} 清理，释放 ${formatSize(item.size_bytes)}</span></div>
        <code>${escapeHtml(item.restore)}</code>
        <button class="toolbar-btn" data-restore="${item.id}">从仓库恢复</button>
      </li>`).join('');
    Modal.show('工作目录整理', `
      <p class="wh-intro">工作目录根下只应放任务目录。以下内容需要你决定怎么处理，文件类问题我们不会自动删除。</p>
      ${issues ? `<h4>不合法的内容</h4><ul class="wh-list">${issues}</ul>` : ''}
      ${stale ? `<h4>建议清理（超过 ${report.idle_days_threshold} 天没动）</h4><ul class="wh-list">${stale}</ul>` : ''}
      ${archived ? `<h4>已清理，可恢复</h4><ul class="wh-list">${archived}</ul>` : ''}
      ${issues || stale || archived ? '' : '<p>没有需要处理的内容。</p>'}
      <p class="wh-error" id="wh-error" role="alert"></p>`);
    const body = document.getElementById('modal-body');
    const fail = error => {
      let text = error.message || '操作失败';
      try { const data = JSON.parse(text); text = data.reason ? `${data.error}：${data.reason}` : data.error; } catch { /* 保持原文 */ }
      document.getElementById('wh-error').textContent = text;
    };
    const done = async () => { await load(); if (window.Tasks) await Tasks.refresh(); render(); };
    body.querySelectorAll('[data-remove-project]').forEach(el => el.addEventListener('click', async () => {
      try { await API.post('/api/tasks/workspace/projects/remove', { path: report.issues[Number(el.dataset.removeProject)].path }); await done(); } catch (error) { fail(error); }
    }));
    body.querySelectorAll('[data-remove-repo]').forEach(el => el.addEventListener('click', async () => {
      const item = report.stale.find(entry => entry.task_id === Number(el.dataset.removeRepo));
      if (!confirm(`确认删除「${item.title}」的本地文件？\n\n${item.path}\n\n内容保留在 ${item.remote}（${item.branch}），之后可以恢复。`)) return;
      el.disabled = true;
      try { await API.post('/api/tasks/workspace/remove-repository', { task_id: item.task_id, confirm: true }); await done(); } catch (error) { el.disabled = false; fail(error); }
    }));
    body.querySelectorAll('[data-restore]').forEach(el => el.addEventListener('click', async () => {
      el.disabled = true; el.textContent = '恢复中…';
      try { await API.post('/api/tasks/workspace/restore', { id: Number(el.dataset.restore) }); await done(); } catch (error) { el.disabled = false; el.textContent = '从仓库恢复'; fail(error); }
    }));
  }

  if (button) button.addEventListener('click', async () => { if (await load()) render(); });
  // 页面加载后稍等再检查，避免和任务列表抢启动资源。
  setTimeout(load, 1500);
  return { load };
})();

window.WorkspaceHealth = WorkspaceHealth;
