const RemoteTasks = (() => {
  let servers = [];
  let tasksByServer = new Map();
  let selected = null;
  let activeTab = 'doc';
  let remoteTerminal = null;
  let activeEngineKey = localStorage.getItem('active-engine-key') || 'local';

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
      PAIRING_CODE_INVALID: '配对码格式不正确', PAIRING_CODE_INVALID_OR_EXPIRED: '配对码无效或已过期',
    })[code] || code || '操作失败';
  }

  async function load() {
    let loadedServers;
    try {
      loadedServers = await API.get('/api/remote-servers');
      if (!Array.isArray(loadedServers)) throw new Error('INVALID_REMOTE_SERVERS_RESPONSE');
    } catch (error) {
      console.error('[remote-tasks] 加载远程 Engine 列表失败', error);
      servers = [];
      activeEngineKey = 'local';
      render();
      activateCurrentEngine();
      return;
    }

    servers = loadedServers;
    tasksByServer = new Map(servers.map(server => [server.id, tasksByServer.get(server.id) || []]));

    // Engine 标签应在服务器列表返回后立即出现，不等待较慢的远程任务请求。
    render();
    activateCurrentEngine();

    await Promise.all(servers.map(async server => {
      try {
        tasksByServer.set(server.id, await API.get(`/api/remote-servers/${server.id}/tasks`));
      } catch (error) {
        tasksByServer.set(server.id, []);
        console.warn(`[remote-tasks] 加载 ${server.name} 的任务失败`, error);
      }
    }));
    render();
    activateCurrentEngine();
  }

  function activateCurrentEngine() {
    try {
      setActiveEngine(activeEngineKey);
    } catch (error) {
      // 已加载的服务器标签不能因为内容区初始化失败而消失。
      console.error('[remote-tasks] 初始化 Engine 视图失败', error);
      renderEngineTabs();
      applyEngineVisibility();
    }
  }

  function normalizeActiveEngine() {
    if (activeEngineKey === 'local') return;
    const id = Number(activeEngineKey.slice('remote:'.length));
    if (!activeEngineKey.startsWith('remote:') || !servers.some(server => server.id === id)) {
      activeEngineKey = 'local';
      localStorage.setItem('active-engine-key', activeEngineKey);
    }
  }

  function renderEngineTabs() {
    normalizeActiveEngine();
    const tabs = document.getElementById('engine-tabs');
    tabs.innerHTML = '';

    function appendTab(key, label, status, title) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `engine-tab${activeEngineKey === key ? ' active' : ''}`;
      button.dataset.engineKey = key;
      button.title = title || label;
      const dot = document.createElement('span');
      dot.className = `engine-tab-status ${status}`;
      const text = document.createElement('span');
      text.textContent = label;
      button.append(dot, text);
      button.addEventListener('click', () => setActiveEngine(key));
      tabs.appendChild(button);
    }

    appendTab('local', '本地', 'local', '本地 Engine');
    servers.forEach(server => appendTab(
      `remote:${server.id}`,
      server.name,
      server.status || 'unknown',
      `${server.name} · ${server.base_url}`,
    ));
  }

  function applyEngineVisibility() {
    const local = nav.querySelector('.local-sidebar-section');
    if (local) local.hidden = activeEngineKey !== 'local';
    nav.querySelectorAll('.remote-sidebar-section').forEach(section => {
      section.hidden = section.dataset.engineKey !== activeEngineKey;
    });
    document.querySelectorAll('.engine-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.engineKey === activeEngineKey);
    });
  }

  function showRemoteEmpty(server) {
    disposeRemoteTerminal();
    selected = null;
    const empty = document.getElementById('preview-empty');
    empty.style.display = 'flex';
    empty.querySelector('span').textContent = `${server.name} 暂无任务`;
    document.getElementById('preview-content').style.display = 'none';
    contentToolbar.style.display = 'none';
    contentTabs.style.display = 'none';
    terminalPane.style.display = 'none';
    previewPane.style.display = '';
    document.getElementById('toc-pane').style.display = 'none';
  }

  function setActiveEngine(key, { selectContent = true } = {}) {
    activeEngineKey = key;
    normalizeActiveEngine();
    localStorage.setItem('active-engine-key', activeEngineKey);
    renderEngineTabs();
    applyEngineVisibility();
    if (!selectContent) return;

    if (activeEngineKey === 'local') {
      clearSelection();
      if (window.Tasks) Tasks.activateLocal();
      return;
    }

    const serverId = Number(activeEngineKey.slice('remote:'.length));
    const server = servers.find(item => item.id === serverId);
    if (!server) return;
    const serverTasks = tasksByServer.get(server.id) || [];
    const cachedId = Number(localStorage.getItem(`remote-selected-task-${server.id}`));
    const task = serverTasks.find(item => item.id === cachedId) || serverTasks[0];
    if (task) select(server, task);
    else {
      if (window.Tasks) Tasks.clearSelection();
      showRemoteEmpty(server);
    }
  }

  function render() {
    nav.querySelectorAll('.remote-sidebar-section').forEach(node => node.remove());
    servers.forEach(server => {
      const section = document.createElement('div');
      section.className = 'remote-sidebar-section';
      section.dataset.engineKey = `remote:${server.id}`;
      const header = document.createElement('div');
      header.className = 'remote-server-header';
      header.innerHTML = `<span class="remote-status ${escapeHtml(server.status)}"></span><span class="remote-server-name" title="${escapeHtml(server.base_url)}">${escapeHtml(server.name)}</span><span class="sidebar-section-count">${(tasksByServer.get(server.id) || []).length}</span><button class="remote-menu" title="远程服务操作">⋯</button>`;
      header.querySelector('.remote-menu').addEventListener('click', event => {
        event.stopPropagation();
        ContextMenu.show(event.clientX, event.clientY, [
          { label: '刷新', action: () => refreshServer(server.id) },
          { separator: true },
          { label: '移除连接', danger: true, action: () => removeServer(server.id) },
        ]);
      });
      section.appendChild(header);
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
      section.appendChild(list);
      nav.appendChild(section);
    });
    renderEngineTabs();
    applyEngineVisibility();
  }

  function select(server, task) {
    if (window.Tasks) Tasks.clearSelection();
    activeEngineKey = `remote:${server.id}`;
    localStorage.setItem('active-engine-key', activeEngineKey);
    localStorage.setItem(`remote-selected-task-${server.id}`, task.id);
    selected = { serverId: server.id, server, task };
    activeTab = localStorage.getItem(`remote-task-tab-${server.id}-${task.id}`) || 'doc';
    render();
    contentTabs.style.display = 'flex';
    contentTabs.querySelectorAll('.tab-btn').forEach(button => {
      button.classList.toggle('active', button.dataset.tab === activeTab);
      button.disabled = false;
      button.title = '';
    });
    if (activeTab === 'shell') renderRemoteTerminal();
    else {
      terminalPane.style.display = 'none';
      previewPane.style.display = '';
      renderSelected();
    }
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
    if (!button) return;
    event.stopImmediatePropagation();
    activeTab = button.dataset.tab;
    localStorage.setItem(`remote-task-tab-${selected.serverId}-${selected.task.id}`, activeTab);
    contentTabs.querySelectorAll('.tab-btn').forEach(item => item.classList.toggle('active', item.dataset.tab === activeTab));
    if (activeTab === 'shell') renderRemoteTerminal();
    else {
      disposeRemoteTerminal();
      terminalPane.style.display = 'none';
      previewPane.style.display = '';
      renderSelected();
    }
  }, true);

  function disposeRemoteTerminal() {
    if (!remoteTerminal) return;
    remoteTerminal.disposed = true;
    if (remoteTerminal.ws) remoteTerminal.ws.close();
    remoteTerminal.term.dispose();
    remoteTerminal.el.remove();
    remoteTerminal = null;
  }

  function renderRemoteTerminal() {
    if (!selected) return;
    disposeRemoteTerminal();
    previewPane.style.display = 'none';
    document.getElementById('toc-pane').style.display = 'none';
    terminalPane.style.display = 'flex';
    contentToolbar.style.display = 'none';

    const container = document.getElementById('xterm-container');
    Array.from(container.children).forEach(child => { child.style.display = 'none'; });
    const el = document.createElement('div');
    el.style.cssText = 'width:100%;height:100%';
    container.appendChild(el);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1e1e1e' },
      scrollback: 5000,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    term.write(`\x1b[36m[正在连接 ${selected.server.name}...]\x1b[0m\r\n`);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/remote-servers/${selected.serverId}/terminal/ws?taskId=${selected.task.id}`);
    ws.binaryType = 'arraybuffer';
    remoteTerminal = { term, fitAddon, ws, el, disposed: false };
    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    ws.onopen = () => {
      term.write('\x1b[32m[远程 Engine 已连接]\x1b[0m\r\n');
      fitAddon.fit();
      term.focus();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = event => {
      if (event.data instanceof ArrayBuffer) term.write(new Uint8Array(event.data));
      else term.write(event.data);
    };
    ws.onclose = () => {
      if (remoteTerminal && remoteTerminal.ws === ws && !remoteTerminal.disposed) {
        term.write('\r\n\x1b[33m[远程终端连接已断开]\x1b[0m\r\n');
      }
    };
    ws.onerror = () => {};
    setTimeout(() => fitAddon.fit(), 0);
  }

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
      <div class="form-group"><label class="form-label">配对码或访问 Token</label><input class="form-input" id="remote-token" type="password" placeholder="TA-XXXX-XXXX-XXXX 或 tae_…" autocomplete="new-password"><div class="form-hint">配对码只使用一次；换取的 Token 会加密保存在 Client 服务端。</div></div>
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
    Modal.show('Engine 访问凭证', `
      <div class="form-hint">为其他 Client 创建配对码。配对码 10 分钟内有效且只能使用一次。</div>
      <div class="remote-token-list">${tokens.length ? tokens.map(token => `<div class="remote-token-row"><div><strong>${escapeHtml(token.name)}</strong><small>${escapeHtml(token.token_prefix)}… · ${escapeHtml(token.scopes)}</small></div><button class="remote-token-revoke" data-id="${token.id}">撤销</button></div>`).join('') : '<div class="remote-empty">尚未创建 Token</div>'}</div>
      <div class="form-actions"><button class="btn-cancel" id="remote-token-close">关闭</button><button class="btn-submit" id="remote-token-create">生成配对码</button></div>
    `);
    document.getElementById('remote-token-close').addEventListener('click', Modal.hide);
    document.getElementById('remote-token-create').addEventListener('click', createToken);
    document.querySelectorAll('.remote-token-revoke').forEach(button => button.addEventListener('click', async () => { if (confirm('撤销后，使用它的远程连接会立即失效。')) { await API.delete(`/api/remote-tokens/${button.dataset.id}`); showTokens(); } }));
  }

  async function createToken() {
    const created = await API.post('/api/remote-tokens/pairing', { role: 'operator' });
    Modal.show('配对码已创建', `<div class="form-hint">10 分钟内有效，只能使用一次。在另一个 Client 中输入当前 Engine 地址和此配对码。</div><div class="created-token"><code>${escapeHtml(created.code)}</code><button class="btn-cancel" id="copy-created-token">复制</button></div><div class="form-actions"><button class="btn-submit" id="created-token-done">完成</button></div>`);
    document.getElementById('copy-created-token').addEventListener('click', async event => { await navigator.clipboard.writeText(created.code); event.target.textContent = '已复制'; });
    document.getElementById('created-token-done').addEventListener('click', Modal.hide);
  }

  document.getElementById('btn-connect-remote').addEventListener('click', showConnect);

  async function createTask(serverId, payload) {
    const server = servers.find(item => item.id === Number(serverId));
    if (!server) throw new Error('REMOTE_NOT_FOUND');
    const task = await API.post(`/api/remote-servers/${server.id}/tasks`, payload);
    await load();
    const refreshedServer = servers.find(item => item.id === server.id) || server;
    const refreshedTask = (tasksByServer.get(server.id) || []).find(item => item.id === task.id) || task;
    select(refreshedServer, refreshedTask);
    return refreshedTask;
  }

  return {
    load,
    render,
    setActiveEngine,
    getActiveEngineKey: () => activeEngineKey,
    getServers: () => servers.map(server => ({ ...server })),
    createTask,
    isSelected: () => Boolean(selected),
    clearSelection: () => {
    selected = null;
    disposeRemoteTerminal();
    contentTabs.querySelectorAll('.tab-btn').forEach(button => { button.disabled = false; button.title = ''; });
    ['btn-reveal-folder', 'btn-open-vscode', 'btn-share-md'].forEach(id => { document.getElementById(id).disabled = false; });
    },
    showTokens,
  };
})();

// 供先加载的本地 Tasks 组件调用 Engine 列表和远程创建能力。
window.RemoteTasks = RemoteTasks;
