// Remote Engine connection management: connection list, pairing, status and updates, plus the "cannot connect" notice.
// Tasks, documents, to-dos, terminals and the rest of the UI are shared with the local Client in tasks.js and are not reimplemented here.
const Engines = (() => {
  let servers = [];
  let localEngineVersion = null;
  let lastVersionRefreshAt = 0;
  const VERSION_REFRESH_INTERVAL_MS = 60_000;

  const previewPane = document.getElementById('preview-pane');

  function errorLabel(code) {
    return ({
      INVALID_REMOTE_URL: 'Invalid URL format', INVALID_REMOTE_PORT: 'Invalid port', TOKEN_REQUIRED: 'Enter a token',
      REMOTE_TIMEOUT: 'Connection timed out', REMOTE_HTTP_401: 'Token is invalid or has been revoked', REMOTE_ALREADY_EXISTS: 'This remote service is already connected',
      REMOTE_CONNECTION_FAILED: 'Failed to connect to the remote service', REMOTE_URL_MUST_NOT_HAVE_PATH: 'Enter only the scheme and host in the URL, without a path',
      PAIRING_CODE_INVALID: 'Invalid pairing code format', PAIRING_CODE_INVALID_OR_EXPIRED: 'The pairing code is invalid or has expired',
      GROUP_NAME_REQUIRED: 'Enter a group name', GROUP_NAME_TOO_LONG: 'Group name cannot exceed 40 characters',
      GROUP_NAME_ALREADY_EXISTS: 'A group with this name already exists', TASK_GROUP_NOT_FOUND: 'Task group does not exist',
      SYSTEM_GROUP_IMMUTABLE: 'The default group cannot be modified or deleted', TASK_GROUP_NOT_EMPTY: 'The group still has tasks and cannot be deleted',
      ENGINE_SCOPE_REQUIRED: 'This connection token has no engine management permission. Use an owner token instead',
      ENGINE_ROUTE_NOT_FOUND: 'The remote engine is too old and needs one manual upgrade first',
      VERSION_URL_NOT_CONFIGURED: 'The remote engine has no version source configured', WORKTREE_DIRTY: 'The remote engine workspace has uncommitted changes',
      BRANCH_DIVERGED: 'The remote engine’s Git branch has diverged', NO_UPDATE_AVAILABLE: 'The remote engine is already up to date',
      UPDATE_IN_PROGRESS: 'The remote engine is running another update', UPDATE_CHECK_FAILED: 'The remote engine failed to check for updates',
      NPM_INSTALLING_FAILED: 'The remote engine failed to install dependencies', NPM_BUILDING_FAILED: 'The remote engine failed to build assets',
      NODE_PTY_LOAD_FAILED: 'The remote engine’s terminal native module check failed',
      DOCKER_MANAGED_UPDATE: 'This engine is managed by Docker. Update the image on the host',
    })[code] || code || 'Operation failed';
  }

  async function load() {
    let loadedServers;
    const localVersionRequest = API.get('/api/system/version')
      .then(manifest => manifest.app_version || null)
      .catch(error => {
        console.warn('[engines] failed to load the local engine version', error);
        return localEngineVersion;
      });
    try {
      loadedServers = await API.get('/api/remote-servers');
      if (!Array.isArray(loadedServers)) throw new Error('INVALID_REMOTE_SERVERS_RESPONSE');
    } catch (error) {
      console.error('[engines] failed to load the remote engine list', error);
      servers = [];
      localEngineVersion = await localVersionRequest;
      Tasks.syncSources([]);
      renderTabs();
      Tasks.restoreActiveSource();
      return;
    }

    localEngineVersion = await localVersionRequest;
    servers = loadedServers;
    // Engine tabs should appear as soon as the server list returns, without waiting for the slower remote task requests.
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
          .catch(error => console.warn(`[engines] failed to refresh the version of ${server.name}`, error))
        : Promise.resolve();
      // Role and capabilities decide UI features (read-only connections and features missing from an old Engine are disabled).
      const accessRequest = API.get(`/api/remote-servers/${server.id}/info`)
        .then(info => Tasks.setSourceAccess(key, info))
        .catch(error => console.warn(`[engines] failed to read the capabilities of ${server.name}`, error));
      await Tasks.reloadSource(key);
      // Even if the task request fails, wait for the independent version probe to finish before refreshing the tab.
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
      const versionLabel = version ? (String(version).startsWith('v') ? String(version) : `v${version}`) : 'Unknown version';
      button.title = `${title || label} · ${versionLabel}`;
      const dot = document.createElement('span');
      dot.className = `engine-tab-status ${status}`;
      const text = document.createElement('span');
      text.textContent = label;
      const versionText = document.createElement('span');
      versionText.className = `engine-tab-version${version ? '' : ' unknown'}`;
      versionText.textContent = versionLabel;
      button.append(dot, text, versionText);
      // A terminal on this Engine is running or has finished and awaits review, which must be visible before switching.
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

    appendTab('local', 'Default', 'local', 'Default engine', null, localEngineVersion);
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
      { label: 'Refresh', action: () => refreshServer(server.id) },
      { label: 'Check for updates', action: () => showEngineUpdate(server.id) },
      { label: 'Edit connection', action: () => showEdit(server.id) },
      { separator: true },
      { label: 'Remove connection', danger: true, action: () => removeServer(server.id) },
    ]);
  }

  function hideUnavailable() {
    document.getElementById('engine-unavailable')?.remove();
  }

  // When the connection fails, show no tasks, documents or terminals, only a hint to check the service.
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
    add('h3', `Cannot connect to “${server.name || src.label}”`);
    add('p', `${problem.unauthorized ? 'Authentication expired' : 'No response from the service'}: ${errorLabel(problem.code)}`, 'engine-unavailable-reason');
    add('p', `Address: ${server.base_url || ''}${server.last_checked_at ? ` · last checked ${server.last_checked_at}` : ''}`, 'engine-unavailable-address');
    add('p', 'Check the service status:');
    const list = document.createElement('ul');
    const steps = problem.unauthorized
      ? ['The token used by this connection has expired or been revoked. Generate a new pairing code under “Settings” on the target Client', 'then click “Edit connection” and enter the new pairing code or token']
      : ['whether the target Client / Engine service is running', 'whether the address and port are correct and the firewall, security group or reverse proxy allows it', 'on the target machine, check that the service is reachable, for example: curl ' + (server.base_url || '') + '/v1/health'];
    steps.forEach(text => { const li = document.createElement('li'); li.textContent = text; list.appendChild(li); });
    panel.appendChild(list);
    const actions = document.createElement('div');
    actions.className = 'engine-unavailable-actions';
    [['Retry connection', () => refreshServer(server.id)], ['Edit connection', () => showEdit(server.id)], ['Remove connection', () => removeServer(server.id)]].forEach(([label, action]) => {
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
      idle: 'Not checked yet', checking: 'Checking', current: 'Up to date', available: 'Update available',
      local_newer: 'Current version is newer', updating: 'Updating', blocked: 'Update blocked', failed: 'Update failed',
      restart_pending: 'Service restart needed',
    })[status] || status || 'Unknown';
  }

  function updateVersion(status, remote = false) {
    if (!status) return 'Unknown';
    if (remote) return status.remote_version || 'Not fetched yet';
    return status.local_version || (status.local_manifest && status.local_manifest.app_version) || 'Unknown';
  }

  function updateInstallTypeLabel(type) {
    return ({ archive: 'Package update', git: 'Git fast-forward update', docker: 'Docker image update' })[type] || 'Unknown';
  }

  function showEngineUpdateResult(server, status) {
    const hasUpdate = status.status === 'available';
    const canApply = hasUpdate && status.install_type !== 'docker';
    const releaseUrl = status.remote_manifest && status.remote_manifest.release_url;
    Modal.show(`${server.name} · Engine update`, `
      <div class="update-hero">
        <span class="update-version">${escapeHtml(updateVersion(status))}</span>
        <span class="update-arrow">→</span>
        <span class="update-version${hasUpdate ? ' new' : ''}">${escapeHtml(updateVersion(status, true))}</span>
      </div>
      <div class="update-detail-row"><span>Status</span><strong class="update-status ${escapeHtml(status.status)}">${escapeHtml(updateStatusLabel(status.status))}</strong></div>
      <div class="update-detail-row"><span>Install type</span><span>${updateInstallTypeLabel(status.install_type)}</span></div>
      <div class="update-detail-row"><span>Target branch</span><code>${escapeHtml(status.update_ref || 'Not configured')}</code></div>
      ${releaseUrl ? `<div class="update-detail-row"><span>Release notes</span><a href="${escapeHtml(releaseUrl)}" target="_blank" rel="noopener noreferrer">GitHub Release ↗</a></div>` : ''}
      ${status.install_type === 'docker' && hasUpdate ? '<div class="form-hint">The host update script will pull a new image and recreate the Docker engine container.</div>' : ''}
      ${status.error ? `<div class="form-hint error update-error">${escapeHtml(errorLabel(status.error))}${status.error_details ? `: ${escapeHtml(status.error_details)}` : ''}</div>` : ''}
      <div class="form-actions">
        <button class="btn-cancel" id="remote-update-close">Close</button>
        <button class="btn-cancel" id="remote-update-check">Check again</button>
        ${canApply ? '<button class="btn-submit" id="remote-update-apply">Update now</button>' : ''}
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
    Modal.show(`${server.name} · Check for updates`, '<div class="update-progress"><span class="update-spinner"></span><span>Asking the remote engine to check GitHub for updates…</span></div>');
    try {
      showEngineUpdateResult(server, await API.post(`/api/remote-servers/${server.id}/check-update`, {}));
    } catch (error) {
      const code = parseApiError(error);
      Modal.show(`${server.name} · Engine update`, `
        <div class="form-hint error update-error">${escapeHtml(errorLabel(code))}</div>
        <div class="form-actions"><button class="btn-cancel" id="remote-update-close">Close</button></div>
      `);
      document.getElementById('remote-update-close').addEventListener('click', Modal.hide);
    }
  }

  function confirmEngineUpdate(server, status) {
    const targetVersion = updateVersion(status, true);
    Modal.show(`Update ${server.name}`, `
      <div class="update-warning">Remote terminals disconnect during the update. The engine restarts automatically after installing dependencies, and the Client waits for it to come back.</div>
      <div class="update-detail-row"><span>Current version</span><strong>${escapeHtml(updateVersion(status))}</strong></div>
      <div class="update-detail-row"><span>Target version</span><strong>${escapeHtml(targetVersion)}</strong></div>
      <div class="form-actions"><button class="btn-cancel" id="remote-update-cancel">Cancel</button><button class="btn-submit" id="remote-update-confirm">Confirm update</button></div>
    `);
    document.getElementById('remote-update-cancel').addEventListener('click', Modal.hide);
    document.getElementById('remote-update-confirm').addEventListener('click', () => applyEngineUpdate(server, targetVersion));
  }

  async function applyEngineUpdate(server, targetVersion) {
    Modal.show(`Updating ${server.name}`, UpdateLog.markup('remote-update-progress', 'remote-update-error', 'Starting the remote update…'));
    try {
      await API.post(`/api/remote-servers/${server.id}/apply-update`, {});
    } catch (error) {
      const spinner = document.querySelector('.update-spinner');
      if (spinner) spinner.style.display = 'none';
      document.getElementById('remote-update-progress').textContent = 'Update did not start';
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
          if (message) message.textContent = 'Remote engine update failed';
          if (errorOutput) {
            errorOutput.className = 'form-hint error';
            errorOutput.textContent = errorLabel(status.error) + (status.error_details ? `: ${status.error_details}` : '');
          }
          return;
        }
        UpdateLog.render(document.getElementById('remote-update-progress-log'), status.log);
        if (updateVersion(status) === targetVersion && status.status !== 'updating') {
          Tasks.disposeSourceTerminals(`remote:${server.id}`);
          if (message) message.textContent = `${server.name} upgraded to ${targetVersion}, refreshing the page…`;
          const spinner = document.querySelector('.update-spinner');
          if (spinner) spinner.remove();
          setTimeout(() => window.location.reload(), 1500);
          return;
        }
        if (message) message.textContent = status.message ? (Array.isArray(status.log) && status.log.length ? UpdateLog.headline(status.message) : status.message) : (status.stage === 'restarting' ? 'Engine restarting…' : 'Engine updating…');
      } catch {
        if (message) message.textContent = 'Engine is offline for now, waiting for it to restart…';
      }
      if (Date.now() >= deadline) {
        const spinner = document.querySelector('.update-spinner');
        if (spinner) spinner.style.display = 'none';
        if (message) message.textContent = 'Timed out waiting for the engine to recover';
        if (errorOutput) {
          errorOutput.className = 'form-hint error';
          errorOutput.textContent = 'Check the remote service process and logs; the update may still be running in the background.';
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
    if (!confirm('Remove this remote connection? Remote data is not deleted.')) return;
    Tasks.disposeSourceTerminals(key);
    await API.delete(`/api/remote-servers/${id}`);
    await load();
  }

  function showConnect() {
    Modal.show('Connect remote service', `
      <div class="form-group"><label class="form-label">URL</label><input class="form-input" id="remote-url" placeholder="e.g. http://192.168.1.20" autocomplete="off"></div>
      <div class="form-group"><label class="form-label">Port</label><input class="form-input" id="remote-port" type="number" min="1" max="65535" placeholder="e.g. 14002"></div>
      <div class="form-group"><label class="form-label">Pairing code or access token</label><input class="form-input" id="remote-token" type="password" placeholder="TA-XXXX-XXXX-XXXX or tae_…" autocomplete="new-password"><div class="form-hint">A pairing code is single-use; the token obtained is stored encrypted on the Client server.</div></div>
      <div class="form-hint error" id="remote-connect-error"></div>
      <div class="form-actions"><button class="btn-cancel" id="remote-connect-cancel">Cancel</button><button class="btn-cancel" id="remote-connect-test">Test connection</button><button class="btn-submit" id="remote-connect-save">Connect</button></div>
    `);
    document.getElementById('remote-connect-cancel').addEventListener('click', Modal.hide);
    const values = () => ({ url: document.getElementById('remote-url').value.trim(), port: document.getElementById('remote-port').value, token: document.getElementById('remote-token').value.trim() });
    document.getElementById('remote-connect-test').addEventListener('click', async event => {
      event.target.disabled = true;
      try { await API.post('/api/remote-servers/test', values()); document.getElementById('remote-connect-error').className = 'form-hint ok'; document.getElementById('remote-connect-error').textContent = 'Connected'; }
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
    Modal.show('Edit remote connection', `
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="remote-edit-name" maxlength="80" value="${escapeHtml(server.name)}" autocomplete="off"></div>
      <div class="form-group"><label class="form-label">URL</label><input class="form-input" id="remote-edit-url" value="${escapeHtml(address.url)}" placeholder="e.g. https://tasks.example.com" autocomplete="off"></div>
      <div class="form-group"><label class="form-label">Port</label><input class="form-input" id="remote-edit-port" type="number" min="1" max="65535" value="${escapeHtml(address.port)}" placeholder="May be left empty for HTTPS"></div>
      <div class="form-hint">The token saved for this connection is reused, so you do not need to enter it again. The new address is saved only after it verifies successfully.</div>
      <div class="form-hint error" id="remote-edit-error"></div>
      <div class="form-actions"><button class="btn-cancel" id="remote-edit-cancel">Cancel</button><button class="btn-cancel" id="remote-edit-test">Test connection</button><button class="btn-submit" id="remote-edit-save">Save</button></div>
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
        showError('Connected; the token is valid', true);
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
    Modal.show('Allow other clients to connect to this machine', `
      <div class="form-hint">On the other client choose “Connect remote” and enter this client’s address and the pairing code. No separate engine install is needed; only this machine’s tasks are exposed, and other connected engines are not forwarded. The pairing code is valid for 10 minutes and can be used once.<br>Connect address:<code>${escapeHtml(location.origin)}</code><br>If the address is localhost or 127.0.0.1, replace it with an IP or domain the other client can reach, and make sure remote access is enabled.</div>
      <div class="remote-token-list">${tokens.length ? tokens.map(token => `<div class="remote-token-row"><div><strong>${escapeHtml(token.name)}</strong><small>${escapeHtml(token.token_prefix)}… · ${escapeHtml(token.scopes)}</small></div><button class="remote-token-revoke" data-id="${token.id}">Revoke</button></div>`).join('') : '<div class="remote-empty">No tokens created yet</div>'}</div>
      <div class="form-actions"><button class="btn-cancel" id="remote-token-close">Close</button><button class="btn-submit" id="remote-token-create">Generate pairing code</button></div>
    `);
    document.getElementById('remote-token-close').addEventListener('click', Modal.hide);
    document.getElementById('remote-token-create').addEventListener('click', createToken);
    document.querySelectorAll('.remote-token-revoke').forEach(button => button.addEventListener('click', async () => { if (confirm('Once revoked, remote connections using it stop working immediately.')) { await API.delete(`/api/remote-tokens/${button.dataset.id}`); showTokens(); } }));
  }

  async function createToken() {
    const created = await API.post('/api/remote-tokens/pairing', {});
    Modal.show('Pairing code created', `<div class="form-hint">Valid for 10 minutes, single use. On the other client, enter the address <code>${escapeHtml(location.origin)}</code> and this pairing code under “Connect remote”. Replace a loopback address with a reachable IP or domain.</div><div class="created-token"><code>${escapeHtml(created.code)}</code><button class="btn-cancel" id="copy-created-token">Copy</button></div><div class="form-actions"><button class="btn-submit" id="created-token-done">Finish</button></div>`);
    document.getElementById('copy-created-token').addEventListener('click', async event => { await navigator.clipboard.writeText(created.code); event.target.textContent = 'Copied'; });
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
