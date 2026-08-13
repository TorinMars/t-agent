const RemoteTasks = (() => {
  let servers = [];
  let tasksByServer = new Map();
  let selected = null;
  let activeTab = 'doc';

  const nav = document.getElementById('task-nav');
  const previewPane = document.getElementById('preview-pane');
  const contentToolbar = document.getElementById('content-toolbar');
  const contentTabs = document.getElementById('content-tabs');
  const terminalPane = document.getElementById('terminal-pane');

  function errorLabel(code) {
    return ({
      INVALID_REMOTE_URL: 'URL 格式不正确', INVALID_REMOTE_PORT: '端口不正确', TOKEN_REQUIRED: '请输入 Token',
      REMOTE_TIMEOUT: '连接超时', REMOTE_HTTP_401: 'Token 无效或已撤销', REMOTE_ALREADY_EXISTS: '该远程服务已连接',
      REMOTE_CONNECTION_FAILED: '远程服务连接失败', REMOTE_URL_MUST_NOT_HAVE_PATH: 'URL 只填写协议和主机，不要包含路径',
    })[code] || code || '操作失败';
  }

  async function load() {
    try {
      servers = await API.get('/api/remote-servers');
      await Promise.all(servers.map(async server => {
        try { tasksByServer.set(server.id, await API.get(`/api/remote-servers/${server.id}/tasks`)); }
        catch { tasksByServer.set(server.id, []); }
      }));
      render();
    } catch {}
  }

  function render() {
    nav.querySelectorAll('.remote-sidebar-section').forEach(node => node.remove());
    const section = document.createElement('div');
    section.className = 'remote-sidebar-section';
    const heading = document.createElement('div');
    heading.className = 'sidebar-section-heading remote-heading';
    heading.innerHTML = `<span>远程服务</span><span class="sidebar-section-count">${servers.length}</span>`;
    section.appendChild(heading);

    if (!servers.length) {
      const empty = document.createElement('div');
      empty.className = 'remote-empty';
      empty.textContent = '尚未连接远程服务';
      section.appendChild(empty);
    }

    servers.forEach(server => {
      const group = document.createElement('div');
      group.className = 'remote-server-group';
      const header = document.createElement('div');
      header.className = 'remote-server-header';
      header.innerHTML = `<span class="remote-status ${escapeHtml(server.status)}"></span><span class="remote-server-name" title="${escapeHtml(server.base_url)}">${escapeHtml(server.name)}</span><button class="remote-menu" title="远程服务操作">⋯</button>`;
      header.querySelector('.remote-menu').addEventListener('click', event => {
        event.stopPropagation();
        ContextMenu.show(event.clientX, event.clientY, [
          { label: '刷新', action: () => refreshServer(server.id) },
          { separator: true },
          { label: '移除连接', danger: true, action: () => removeServer(server.id) },
        ]);
      });
      group.appendChild(header);
      const list = document.createElement('div');
      list.className = 'remote-task-list';
      (tasksByServer.get(server.id) || []).forEach(task => {
        const item = document.createElement('div');
        item.className = `task-nav-item remote-task-item${selected && selected.serverId === server.id && selected.task.id === task.id ? ' active' : ''}`;
        item.innerHTML = `<span class="task-status-btn ${escapeHtml(task.status)}"></span><span class="task-nav-title${task.status === 'done' ? ' done' : ''}">${escapeHtml(task.title)}</span>`;
        item.addEventListener('click', () => select(server, task));
        list.appendChild(item);
      });
      if (!(tasksByServer.get(server.id) || []).length) {
        const noTasks = document.createElement('div');
        noTasks.className = 'remote-empty small';
        noTasks.textContent = server.status === 'online' ? '没有任务' : errorLabel(server.last_error) || '离线';
        list.appendChild(noTasks);
      }
      group.appendChild(list);
      section.appendChild(group);
    });
    nav.appendChild(section);
  }

  function select(server, task) {
    if (window.Tasks) Tasks.clearSelection();
    selected = { serverId: server.id, server, task };
    activeTab = localStorage.getItem(`remote-task-tab-${server.id}-${task.id}`) || 'doc';
    if (activeTab === 'shell') activeTab = 'doc';
    render();
    contentTabs.style.display = 'flex';
    contentTabs.querySelectorAll('.tab-btn').forEach(button => {
      button.classList.toggle('active', button.dataset.tab === activeTab);
      button.disabled = button.dataset.tab === 'shell';
      if (button.dataset.tab === 'shell') button.title = '远程终端将在后续版本开放';
    });
    terminalPane.style.display = 'none';
    previewPane.style.display = '';
    renderSelected();
  }

  async function renderSelected() {
    if (!selected) return;
    const content = document.getElementById('preview-content');
    document.getElementById('preview-empty').style.display = 'none';
    content.style.display = 'block';
    document.getElementById('toc-pane').style.display = 'none';
    contentToolbar.style.display = 'flex';
    document.getElementById('btn-reveal-folder').disabled = true;
    document.getElementById('btn-open-vscode').disabled = true;
    document.getElementById('btn-share-md').disabled = true;
    document.getElementById('btn-edit-md').disabled = true;
    content.innerHTML = '<div class="preview-loading">正在从远程服务加载…</div>';
    try {
      if (activeTab === 'todos') {
        const todos = await API.get(`/api/remote-servers/${selected.serverId}/tasks/${selected.task.id}/todos`);
        content.innerHTML = `<section class="todo-page remote-readonly"><div class="todo-heading"><div><h2>待办清单</h2><p>远程只读</p></div></div><div class="todo-list">${todos.length ? todos.map(todo => `<div class="todo-item${todo.completed ? ' completed' : ''}"><label class="todo-check-wrap"><input type="checkbox" ${todo.completed ? 'checked' : ''} disabled><span class="todo-checkmark"></span></label><span class="todo-content">${escapeHtml(todo.content)}</span></div>`).join('') : '<div class="todo-empty">还没有待办事项</div>'}</div></section>`;
        return;
      }
      const kind = activeTab === 'readme' ? 'readme' : activeTab === 'agent' ? 'agent' : 'technical';
      const response = await fetch(`/api/remote-servers/${selected.serverId}/tasks/${selected.task.id}/document/${kind}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (response.status === 404) { content.innerHTML = '<div class="document-empty">远程文档不存在</div>'; return; }
      if (!response.ok) throw new Error('REMOTE_DOCUMENT_FAILED');
      const source = await response.text();
      content.innerHTML = `<div class="remote-readonly-banner">${escapeHtml(selected.server.name)} · 只读</div>${marked.parse(source)}`;
      for (const node of content.querySelectorAll('.mermaid')) {
        try { await mermaid.run({ nodes: [node] }); } catch {}
      }
    } catch (error) {
      content.innerHTML = `<div class="preview-loading">远程内容加载失败：${escapeHtml(errorLabel(error.message))}</div>`;
    }
  }

  contentTabs.addEventListener('click', event => {
    if (!selected) return;
    const button = event.target.closest('.tab-btn');
    if (!button || button.dataset.tab === 'shell') return;
    event.stopImmediatePropagation();
    activeTab = button.dataset.tab;
    localStorage.setItem(`remote-task-tab-${selected.serverId}-${selected.task.id}`, activeTab);
    contentTabs.querySelectorAll('.tab-btn').forEach(item => item.classList.toggle('active', item.dataset.tab === activeTab));
    renderSelected();
  }, true);

  async function refreshServer(id) {
    try { await API.post(`/api/remote-servers/${id}/check`, {}); } catch {}
    await load();
  }

  async function removeServer(id) {
    if (!confirm('确认移除这个远程连接？远程数据不会被删除。')) return;
    await API.delete(`/api/remote-servers/${id}`);
    if (selected && selected.serverId === id) { selected = null; location.reload(); return; }
    await load();
  }

  function showConnect() {
    Modal.show('连接远程服务', `
      <div class="form-group"><label class="form-label">URL</label><input class="form-input" id="remote-url" placeholder="例如 http://192.168.1.20" autocomplete="off"></div>
      <div class="form-group"><label class="form-label">端口</label><input class="form-input" id="remote-port" type="number" min="1" max="65535" placeholder="例如 14002"></div>
      <div class="form-group"><label class="form-label">Token</label><input class="form-input" id="remote-token" type="password" placeholder="txw_…" autocomplete="new-password"><div class="form-hint">Token 加密保存在本机，之后不会返回浏览器。</div></div>
      <div class="form-hint error" id="remote-connect-error"></div>
      <div class="form-actions"><button class="btn-cancel" id="remote-connect-cancel">取消</button><button class="btn-cancel" id="remote-connect-test">测试连接</button><button class="btn-submit" id="remote-connect-save">连接</button></div>
    `);
    document.getElementById('remote-connect-cancel').addEventListener('click', Modal.hide);
    const values = () => ({ url: document.getElementById('remote-url').value.trim(), port: document.getElementById('remote-port').value, token: document.getElementById('remote-token').value.trim() });
    document.getElementById('remote-connect-test').addEventListener('click', async event => {
      event.target.disabled = true;
      try { await API.post('/api/remote-servers/test', values()); document.getElementById('remote-connect-error').className = 'form-hint ok'; document.getElementById('remote-connect-error').textContent = '连接成功'; }
      catch (error) { document.getElementById('remote-connect-error').textContent = errorLabel(parseApiError(error)); }
      event.target.disabled = false;
    });
    document.getElementById('remote-connect-save').addEventListener('click', async event => {
      event.target.disabled = true;
      try { await API.post('/api/remote-servers', values()); Modal.hide(); await load(); }
      catch (error) { document.getElementById('remote-connect-error').textContent = errorLabel(parseApiError(error)); event.target.disabled = false; }
    });
  }

  function parseApiError(error) {
    try { return JSON.parse(error.message).error; } catch { return error.message; }
  }

  async function showTokens() {
    const tokens = await API.get('/api/remote-tokens');
    Modal.show('远程访问 Token', `
      <div class="form-hint">将 Token 提供给另一台 torin-x-web，即可只读访问当前账号的任务、文档和待办。</div>
      <div class="remote-token-list">${tokens.length ? tokens.map(token => `<div class="remote-token-row"><div><strong>${escapeHtml(token.name)}</strong><small>${escapeHtml(token.token_prefix)}… · ${escapeHtml(token.scopes)}</small></div><button class="remote-token-revoke" data-id="${token.id}">撤销</button></div>`).join('') : '<div class="remote-empty">尚未创建 Token</div>'}</div>
      <div class="form-actions"><button class="btn-cancel" id="remote-token-close">关闭</button><button class="btn-submit" id="remote-token-create">创建 Token</button></div>
    `);
    document.getElementById('remote-token-close').addEventListener('click', Modal.hide);
    document.getElementById('remote-token-create').addEventListener('click', createToken);
    document.querySelectorAll('.remote-token-revoke').forEach(button => button.addEventListener('click', async () => { if (confirm('撤销后，使用它的远程连接会立即失效。')) { await API.delete(`/api/remote-tokens/${button.dataset.id}`); showTokens(); } }));
  }

  async function createToken() {
    const created = await API.post('/api/remote-tokens', { name: '远程连接' });
    Modal.show('Token 已创建', `<div class="form-hint">只显示这一次，请立即复制并妥善保存。</div><div class="created-token"><code>${escapeHtml(created.token)}</code><button class="btn-cancel" id="copy-created-token">复制</button></div><div class="form-actions"><button class="btn-submit" id="created-token-done">完成</button></div>`);
    document.getElementById('copy-created-token').addEventListener('click', async event => { await navigator.clipboard.writeText(created.token); event.target.textContent = '已复制'; });
    document.getElementById('created-token-done').addEventListener('click', Modal.hide);
  }

  document.getElementById('btn-connect-remote').addEventListener('click', showConnect);

  return { load, render, isSelected: () => Boolean(selected), clearSelection: () => {
    selected = null;
    contentTabs.querySelectorAll('.tab-btn').forEach(button => { button.disabled = false; button.title = ''; });
    ['btn-reveal-folder', 'btn-open-vscode', 'btn-share-md'].forEach(id => { document.getElementById(id).disabled = false; });
  }, showTokens };
})();
