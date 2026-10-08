// 远程 Engine 的连接管理：连接列表、配对、状态与更新，以及“无法连接”提示。
// 任务、文档、待办、终端等界面与本地 Client 共用 tasks.js，这里不重复实现。
const Engines = (() => {
  let servers = [];
  let localEngineVersion = null;
  let lastVersionRefreshAt = 0;
  const VERSION_REFRESH_INTERVAL_MS = 60_000;

  const previewPane = document.getElementById('preview-pane');

  function errorLabel(code) {
    return ({
      INVALID_REMOTE_URL: 'URL 格式不正确', INVALID_REMOTE_PORT: '端口不正确', TOKEN_REQUIRED: '请输入 Token',
      REMOTE_TIMEOUT: '连接超时', REMOTE_HTTP_401: 'Token 无效或已撤销', REMOTE_ALREADY_EXISTS: '该远程服务已连接',
      REMOTE_CONNECTION_FAILED: '远程服务连接失败', REMOTE_URL_MUST_NOT_HAVE_PATH: 'URL 只填写协议和主机，不要包含路径',
      PAIRING_CODE_INVALID: '配对码格式不正确', PAIRING_CODE_INVALID_OR_EXPIRED: '配对码无效或已过期',
      GROUP_NAME_REQUIRED: '请输入分组名称', GROUP_NAME_TOO_LONG: '分组名称不能超过 40 个字符',
      GROUP_NAME_ALREADY_EXISTS: '已有同名分组', TASK_GROUP_NOT_FOUND: '任务分组不存在',
      SYSTEM_GROUP_IMMUTABLE: '默认分组不能修改或删除', TASK_GROUP_NOT_EMPTY: '分组内还有任务，不能删除',
      ENGINE_SCOPE_REQUIRED: '当前连接 Token 没有 Engine 管理权限，请改用 owner Token',
      ENGINE_ROUTE_NOT_FOUND: '远程 Engine 版本过旧，需要先手动升级一次',
      VERSION_URL_NOT_CONFIGURED: '远程 Engine 未配置版本来源', WORKTREE_DIRTY: '远程 Engine 工作区有未提交修改',
      BRANCH_DIVERGED: '远程 Engine 的 Git 分支已经分叉', NO_UPDATE_AVAILABLE: '远程 Engine 已经是最新版本',
      UPDATE_IN_PROGRESS: '远程 Engine 正在执行其他更新', UPDATE_CHECK_FAILED: '远程 Engine 检查更新失败',
      NPM_INSTALLING_FAILED: '远程 Engine 安装依赖失败', NPM_BUILDING_FAILED: '远程 Engine 构建资源失败',
      NODE_PTY_LOAD_FAILED: '远程 Engine 的终端原生模块校验失败',
      DOCKER_MANAGED_UPDATE: '该 Engine 由 Docker 管理，请在宿主机更新镜像',
    })[code] || code || '操作失败';
  }

  async function load() {
    let loadedServers;
    const localVersionRequest = API.get('/api/system/version')
      .then(manifest => manifest.app_version || null)
      .catch(error => {
        console.warn('[engines] 加载本地 Engine 版本失败', error);
        return localEngineVersion;
      });
    try {
      loadedServers = await API.get('/api/remote-servers');
      if (!Array.isArray(loadedServers)) throw new Error('INVALID_REMOTE_SERVERS_RESPONSE');
    } catch (error) {
      console.error('[engines] 加载远程 Engine 列表失败', error);
      servers = [];
      localEngineVersion = await localVersionRequest;
      Tasks.syncSources([]);
      renderTabs();
      Tasks.restoreActiveSource();
      return;
    }

    localEngineVersion = await localVersionRequest;
    servers = loadedServers;
    // Engine 标签应在服务器列表返回后立即出现，不等待较慢的远程任务请求。
    Tasks.syncSources(servers);
    renderTabs();
    Tasks.restoreActiveSource();

    const refreshVersions = Date.now() - lastVersionRefreshAt >= VERSION_REFRESH_INTERVAL_MS;
    if (refreshVersions) lastVersionRefreshAt = Date.now();

    await Promise.all(servers.map(async server => {
      const key = `remote:${server.id}`;
      const versionRequest = refreshVersions
        ? API.post(`/api/remote-servers/${server.id}/check`, {})
          .then(refreshed => Object.assign(server, refreshed))
          .catch(error => console.warn(`[engines] 刷新 ${server.name} 的版本失败`, error))
        : Promise.resolve();
      // 角色和能力决定界面功能（只读连接、旧版 Engine 缺少的功能会被禁用）。
      const accessRequest = API.get(`/api/remote-servers/${server.id}/info`)
        .then(info => Tasks.setSourceAccess(key, info))
        .catch(error => console.warn(`[engines] 读取 ${server.name} 的能力失败`, error));
      await Tasks.reloadSource(key);
      // 即使任务接口失败，也等待独立的版本探测完成后再刷新 Tab。
      await Promise.all([versionRequest, accessRequest]);
    }));
    renderTabs();
    Tasks.restoreActiveSource();
  }

  function renderTabs() {
    const tabs = document.getElementById('engine-tabs');
    const activeKey = Tasks.getActiveKey();
    tabs.innerHTML = '';

    function appendTab(key, label, status, title, server = null, version = null) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `engine-tab${activeKey === key ? ' active' : ''}`;
      button.dataset.engineKey = key;
      button.setAttribute("aria-label", label);
      const versionLabel = version ? (String(version).startsWith('v') ? String(version) : `v${version}`) : '版本未知';
      button.title = `${title || label} · ${versionLabel}`;
      const dot = document.createElement('span');
      dot.className = `engine-tab-status ${status}`;
      const text = document.createElement('span');
      text.textContent = label;
      const versionText = document.createElement('span');
      versionText.className = `engine-tab-version${version ? '' : ' unknown'}`;
      versionText.textContent = versionLabel;
      button.append(dot, text, versionText);
      // 该 Engine 上有终端在执行或已完成待查看，切换前也能看到。
      const activity = TerminalActivity.sourceState(key);
      if (activity !== 'idle') button.classList.add(`term-${activity}`);
      button.addEventListener('click', () => Tasks.activateSource(key));
      if (server) {
        button.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          showServerMenu(event.clientX, event.clientY, server);
        });
      }
      tabs.appendChild(button);
    }

    appendTab('local', '默认', 'local', '默认 Engine', null, localEngineVersion);
    servers.forEach(server => appendTab(
      `remote:${server.id}`,
      server.name,
      Tasks.problemOf(`remote:${server.id}`) && server.status === 'online' ? 'offline' : (server.status || 'unknown'),
      `${server.name} · ${server.base_url}`,
      server,
      server.remote_version,
    ));
  }

  function showServerMenu(x, y, server) {
    ContextMenu.show(x, y, [
      { label: '刷新', action: () => refreshServer(server.id) },
      { label: '检查更新', action: () => showEngineUpdate(server.id) },
      { label: '编辑连接', action: () => showEdit(server.id) },
      { separator: true },
      { label: '移除连接', danger: true, action: () => removeServer(server.id) },
    ]);
  }

  function hideUnavailable() {
    document.getElementById('engine-unavailable')?.remove();
  }

  // 连接失败时不显示任务、文档和终端，只提示检查服务状态。
  function showUnavailable(src) {
    const server = src.server || {};
    const problem = Tasks.problemOf(src.key) || { code: 'REMOTE_CONNECTION_FAILED' };
    hideUnavailable();
    const panel = document.createElement('div');
    panel.id = 'engine-unavailable';
    panel.className = 'engine-unavailable';
    const add = (tag, text, className) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = text;
      panel.appendChild(node);
      return node;
    };
    add('h3', `无法连接「${server.name || src.label}」`);
    add('p', `${problem.unauthorized ? '认证失效' : '服务无响应'}：${errorLabel(problem.code)}`, 'engine-unavailable-reason');
    add('p', `地址：${server.base_url || ''}${server.last_checked_at ? ` · 上次检查 ${server.last_checked_at}` : ''}`, 'engine-unavailable-address');
    add('p', '请检查服务状态：');
    const list = document.createElement('ul');
    const steps = problem.unauthorized
      ? ['连接使用的 Token 已失效或被撤销，请在目标 Client 的“设置”中重新生成配对码', '然后点击“编辑连接”，填入新的配对码或 Token']
      : ['目标 Client / Engine 服务是否正在运行', '地址和端口是否正确，防火墙、安全组或反向代理是否放行', '在目标机器上确认服务可访问，例如：curl ' + (server.base_url || '') + '/v1/health'];
    steps.forEach(text => { const li = document.createElement('li'); li.textContent = text; list.appendChild(li); });
    panel.appendChild(list);
    const actions = document.createElement('div');
    actions.className = 'engine-unavailable-actions';
    [['重试连接', () => refreshServer(server.id)], ['编辑连接', () => showEdit(server.id)], ['移除连接', () => removeServer(server.id)]].forEach(([label, action]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'document-create-btn';
      button.textContent = label;
      button.addEventListener('click', action);
      actions.appendChild(button);
    });
    panel.appendChild(actions);
    previewPane.appendChild(panel);
  }

  async function refreshServer(id) {
    try { await API.post(`/api/remote-servers/${id}/check`, {}); } catch {}
    await load();
  }

  function updateStatusLabel(status) {
    return ({
      idle: '尚未检查', checking: '正在检查', current: '已是最新', available: '发现新版本',
      local_newer: '当前版本较新', updating: '正在更新', blocked: '更新被阻断', failed: '更新失败',
      restart_pending: '需要重启服务',
    })[status] || status || '未知';
  }

  function updateVersion(status, remote = false) {
    if (!status) return '未知';
    if (remote) return status.remote_version || '尚未获取';
    return status.local_version || (status.local_manifest && status.local_manifest.app_version) || '未知';
  }

  function updateInstallTypeLabel(type) {
    return ({ archive: '安装包更新', git: 'Git 快进更新', docker: 'Docker 镜像更新' })[type] || '未知';
  }

  function showEngineUpdateResult(server, status) {
    const hasUpdate = status.status === 'available';
    const canApply = hasUpdate && status.install_type !== 'docker';
    const releaseUrl = status.remote_manifest && status.remote_manifest.release_url;
    Modal.show(`${server.name} · Engine 更新`, `
      <div class="update-hero">
        <span class="update-version">${escapeHtml(updateVersion(status))}</span>
        <span class="update-arrow">→</span>
        <span class="update-version${hasUpdate ? ' new' : ''}">${escapeHtml(updateVersion(status, true))}</span>
      </div>
      <div class="update-detail-row"><span>状态</span><strong class="update-status ${escapeHtml(status.status)}">${escapeHtml(updateStatusLabel(status.status))}</strong></div>
      <div class="update-detail-row"><span>安装方式</span><span>${updateInstallTypeLabel(status.install_type)}</span></div>
      <div class="update-detail-row"><span>目标分支</span><code>${escapeHtml(status.update_ref || '未配置')}</code></div>
      ${releaseUrl ? `<div class="update-detail-row"><span>发布说明</span><a href="${escapeHtml(releaseUrl)}" target="_blank" rel="noopener noreferrer">GitHub Release ↗</a></div>` : ''}
      ${status.install_type === 'docker' && hasUpdate ? '<div class="form-hint">Docker Engine 将由宿主机更新脚本拉取新镜像并重建容器。</div>' : ''}
      ${status.error ? `<div class="form-hint error update-error">${escapeHtml(errorLabel(status.error))}${status.error_details ? `：${escapeHtml(status.error_details)}` : ''}</div>` : ''}
      <div class="form-actions">
        <button class="btn-cancel" id="remote-update-close">关闭</button>
        <button class="btn-cancel" id="remote-update-check">重新检查</button>
        ${canApply ? '<button class="btn-submit" id="remote-update-apply">立即更新</button>' : ''}
      </div>
    `);
    document.getElementById('remote-update-close').addEventListener('click', Modal.hide);
    document.getElementById('remote-update-check').addEventListener('click', () => showEngineUpdate(server.id));
    const applyButton = document.getElementById('remote-update-apply');
    if (applyButton) applyButton.addEventListener('click', () => confirmEngineUpdate(server, status));
  }

  async function showEngineUpdate(serverId) {
    const server = servers.find(item => item.id === Number(serverId));
    if (!server) return;
    Modal.show(`${server.name} · 检查更新`, '<div class="update-progress"><span class="update-spinner"></span><span>正在让远程 Engine 检查 GitHub 更新…</span></div>');
    try {
      showEngineUpdateResult(server, await API.post(`/api/remote-servers/${server.id}/check-update`, {}));
    } catch (error) {
      const code = parseApiError(error);
      Modal.show(`${server.name} · Engine 更新`, `
        <div class="form-hint error update-error">${escapeHtml(errorLabel(code))}</div>
        <div class="form-actions"><button class="btn-cancel" id="remote-update-close">关闭</button></div>
      `);
      document.getElementById('remote-update-close').addEventListener('click', Modal.hide);
    }
  }

  function confirmEngineUpdate(server, status) {
    const targetVersion = updateVersion(status, true);
    Modal.show(`更新 ${server.name}`, `
      <div class="update-warning">更新期间远程终端会断开。Engine 完成依赖安装后将自动重启，Client 会等待它恢复。</div>
      <div class="update-detail-row"><span>当前版本</span><strong>${escapeHtml(updateVersion(status))}</strong></div>
      <div class="update-detail-row"><span>目标版本</span><strong>${escapeHtml(targetVersion)}</strong></div>
      <div class="form-actions"><button class="btn-cancel" id="remote-update-cancel">取消</button><button class="btn-submit" id="remote-update-confirm">确认更新</button></div>
    `);
    document.getElementById('remote-update-cancel').addEventListener('click', Modal.hide);
    document.getElementById('remote-update-confirm').addEventListener('click', () => applyEngineUpdate(server, targetVersion));
  }

  async function applyEngineUpdate(server, targetVersion) {
    Modal.show(`正在更新 ${server.name}`, '<div class="update-progress"><span class="update-spinner"></span><span id="remote-update-progress">正在启动远程更新流程…</span></div><div class="form-hint" id="remote-update-error"></div>');
    try {
      await API.post(`/api/remote-servers/${server.id}/apply-update`, {});
    } catch (error) {
      const spinner = document.querySelector('.update-spinner');
      if (spinner) spinner.style.display = 'none';
      document.getElementById('remote-update-progress').textContent = '更新未启动';
      const output = document.getElementById('remote-update-error');
      output.className = 'form-hint error';
      output.textContent = errorLabel(parseApiError(error));
      return;
    }
    waitForEngineRestart(server, targetVersion);
  }

  function waitForEngineRestart(server, targetVersion) {
    const deadline = Date.now() + 12 * 60_000;
    const poll = async () => {
      const message = document.getElementById('remote-update-progress');
      const errorOutput = document.getElementById('remote-update-error');
      try {
        const status = await API.get(`/api/remote-servers/${server.id}/update-status`);
        if (status.status === 'blocked' || status.status === 'failed') {
          const spinner = document.querySelector('.update-spinner');
          if (spinner) spinner.style.display = 'none';
          if (message) message.textContent = '远程 Engine 更新失败';
          if (errorOutput) {
            errorOutput.className = 'form-hint error';
            errorOutput.textContent = errorLabel(status.error) + (status.error_details ? `：${status.error_details}` : '');
          }
          return;
        }
        if (updateVersion(status) === targetVersion && status.status !== 'updating') {
          Tasks.disposeSourceTerminals(`remote:${server.id}`);
          await load();
          Modal.show('Engine 更新完成', `<div class="update-message">${escapeHtml(server.name)} 已升级到 ${escapeHtml(targetVersion)} 并恢复连接。</div><div class="form-actions"><button class="btn-submit" id="remote-update-done">完成</button></div>`);
          document.getElementById('remote-update-done').addEventListener('click', Modal.hide);
          return;
        }
        if (message) message.textContent = status.message || (status.stage === 'restarting' ? 'Engine 正在重启…' : 'Engine 正在更新…');
      } catch {
        if (message) message.textContent = 'Engine 暂时离线，正在等待重启…';
      }
      if (Date.now() >= deadline) {
        const spinner = document.querySelector('.update-spinner');
        if (spinner) spinner.style.display = 'none';
        if (message) message.textContent = '等待 Engine 恢复超时';
        if (errorOutput) {
          errorOutput.className = 'form-hint error';
          errorOutput.textContent = '请检查远程服务进程和日志；更新可能仍在后台执行。';
        }
        return;
      }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 1000);
  }

  async function removeServer(id) {
    const key = `remote:${id}`;
    if (Tasks.getActiveKey() === key && window.FilePanel?.isOpen() && !await FilePanel.beforeContextChange()) return;
    if (!confirm('确认移除这个远程连接？远程数据不会被删除。')) return;
    Tasks.disposeSourceTerminals(key);
    await API.delete(`/api/remote-servers/${id}`);
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

  function splitRemoteAddress(baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      return {
        url: `${parsed.protocol}//${parsed.hostname}`,
        port: parsed.port,
      };
    } catch {
      return { url: baseUrl, port: '' };
    }
  }

  function showEdit(serverId) {
    const server = servers.find(item => item.id === Number(serverId));
    if (!server) return;
    const address = splitRemoteAddress(server.base_url);
    Modal.show('编辑远程连接', `
      <div class="form-group"><label class="form-label">名称</label><input class="form-input" id="remote-edit-name" maxlength="80" value="${escapeHtml(server.name)}" autocomplete="off"></div>
      <div class="form-group"><label class="form-label">URL</label><input class="form-input" id="remote-edit-url" value="${escapeHtml(address.url)}" placeholder="例如 https://tasks.example.com" autocomplete="off"></div>
      <div class="form-group"><label class="form-label">端口</label><input class="form-input" id="remote-edit-port" type="number" min="1" max="65535" value="${escapeHtml(address.port)}" placeholder="HTTPS 默认可留空"></div>
      <div class="form-hint">将沿用当前连接已保存的 Token，无需重新输入。新地址验证成功后才会保存。</div>
      <div class="form-hint error" id="remote-edit-error"></div>
      <div class="form-actions"><button class="btn-cancel" id="remote-edit-cancel">取消</button><button class="btn-cancel" id="remote-edit-test">测试连接</button><button class="btn-submit" id="remote-edit-save">保存</button></div>
    `);
    document.getElementById('remote-edit-cancel').addEventListener('click', Modal.hide);
    const values = () => ({
      name: document.getElementById('remote-edit-name').value.trim(),
      url: document.getElementById('remote-edit-url').value.trim(),
      port: document.getElementById('remote-edit-port').value,
    });
    const showError = (message, ok = false) => {
      const output = document.getElementById('remote-edit-error');
      output.className = `form-hint ${ok ? 'ok' : 'error'}`;
      output.textContent = message;
    };
    document.getElementById('remote-edit-test').addEventListener('click', async event => {
      event.target.disabled = true;
      try {
        await API.post(`/api/remote-servers/${server.id}/test`, values());
        showError('连接成功，Token 有效', true);
      } catch (error) {
        showError(errorLabel(parseApiError(error)));
      } finally {
        event.target.disabled = false;
      }
    });
    document.getElementById('remote-edit-save').addEventListener('click', async event => {
      if (window.FilePanel?.isOpen() && !await FilePanel.beforeContextChange()) return;
      event.target.disabled = true;
      try {
        await API.put(`/api/remote-servers/${server.id}`, values());
        Tasks.disposeSourceTerminals(`remote:${server.id}`);
        Modal.hide();
        await load();
      } catch (error) {
        showError(errorLabel(parseApiError(error)));
        event.target.disabled = false;
      }
    });
  }

  function parseApiError(error) {
    try { return JSON.parse(error.message).error; } catch { return error.message; }
  }

  async function showTokens() {
    const tokens = await API.get('/api/remote-tokens');
    Modal.show('允许其他客户端连接本机', `
      <div class="form-hint">在另一客户端选择“连接远程”，填写本客户端的地址和配对码。无需另装 Engine；仅开放本机任务，不转发已连接的其他引擎。配对码 10 分钟内有效且只能使用一次。<br>连接地址：<code>${escapeHtml(location.origin)}</code><br>若地址为 localhost 或 127.0.0.1，请换成其他客户端可访问的 IP 或域名，并确保已开启远程访问。</div>
      <div class="remote-token-list">${tokens.length ? tokens.map(token => `<div class="remote-token-row"><div><strong>${escapeHtml(token.name)}</strong><small>${escapeHtml(token.token_prefix)}… · ${escapeHtml(token.scopes)}</small></div><button class="remote-token-revoke" data-id="${token.id}">撤销</button></div>`).join('') : '<div class="remote-empty">尚未创建 Token</div>'}</div>
      <div class="form-actions"><button class="btn-cancel" id="remote-token-close">关闭</button><button class="btn-submit" id="remote-token-create">生成配对码</button></div>
    `);
    document.getElementById('remote-token-close').addEventListener('click', Modal.hide);
    document.getElementById('remote-token-create').addEventListener('click', createToken);
    document.querySelectorAll('.remote-token-revoke').forEach(button => button.addEventListener('click', async () => { if (confirm('撤销后，使用它的远程连接会立即失效。')) { await API.delete(`/api/remote-tokens/${button.dataset.id}`); showTokens(); } }));
  }

  async function createToken() {
    const created = await API.post('/api/remote-tokens/pairing', {});
    Modal.show('配对码已创建', `<div class="form-hint">10 分钟内有效，只能使用一次。在另一客户端的“连接远程”中填写地址 <code>${escapeHtml(location.origin)}</code> 和此配对码。本机回环地址需替换为可访问的 IP 或域名。</div><div class="created-token"><code>${escapeHtml(created.code)}</code><button class="btn-cancel" id="copy-created-token">复制</button></div><div class="form-actions"><button class="btn-submit" id="created-token-done">完成</button></div>`);
    document.getElementById('copy-created-token').addEventListener('click', async event => { await navigator.clipboard.writeText(created.code); event.target.textContent = '已复制'; });
    document.getElementById('created-token-done').addEventListener('click', Modal.hide);
  }

  document.getElementById('btn-connect-remote').addEventListener('click', showConnect);
  Tasks.onSourceChange(renderTabs);

  return {
    load,
    renderTabs,
    showUnavailable,
    hideUnavailable,
    showTokens,
    getServers: () => servers.map(server => ({ ...server })),
  };
})();

window.Engines = Engines;
