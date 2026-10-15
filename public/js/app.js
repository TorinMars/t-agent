const API = {
  async get(url) {
    const res = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async post(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async put(url, data) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async delete(url) {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
};

const Modal = {
  show(title, bodyHtml) {
    document.getElementById('modal-title').textContent = title;
    const content = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');
    footer.replaceChildren();
    footer.hidden = true;
    content.innerHTML = bodyHtml;
    const settingsActions = content.querySelector('#settings-save')?.closest('.form-actions');
    document.getElementById('modal').classList.toggle('settings-modal', Boolean(settingsActions));
    if (settingsActions) {
      footer.appendChild(settingsActions);
      footer.hidden = false;
    }
    content.scrollTop = 0;
    document.getElementById('modal-overlay').style.display = 'flex';
  },
  hide() {
    document.getElementById('modal-overlay').style.display = 'none';
    document.getElementById('modal-body').innerHTML = '';
    document.getElementById('modal-footer').replaceChildren();
    document.getElementById('modal-footer').hidden = true;
  },
};

const TerminalControls = {
  controller() {
    return window.Tasks || null;
  },

  showMessage(message) {
    const empty = document.getElementById('terminal-empty');
    const container = document.getElementById('xterm-container');
    empty.textContent = message;
    empty.style.display = 'flex';
    container.style.display = 'none';
  },

  clearMessage() {
    document.getElementById('terminal-empty').style.display = 'none';
    document.getElementById('xterm-container').style.display = '';
  },

  async run(method, confirmation = '', ...args) {
    if (this.busy) return;
    const controller = this.controller();
    if (!controller || typeof controller[method] !== 'function') return;
    if (confirmation && !confirm(confirmation)) return;
    this.busy = true;
    const buttons = document.querySelectorAll('.terminal-toolbar-btn');
    buttons.forEach(button => { button.disabled = true; });
    try {
      await controller[method](...args);
    } catch (error) {
      alert(`Terminal action failed: ${error.message}`);
    } finally {
      this.busy = false;
      document.querySelectorAll('.terminal-toolbar-btn').forEach(button => { button.disabled = false; });
      if (typeof TerminalHistory !== 'undefined') TerminalHistory.refresh();
    }
  },
};

document.getElementById('btn-terminal-new').addEventListener('click', () => {
  TerminalControls.run('newTerminal');
});

document.getElementById('btn-terminal-reopen').addEventListener('click', () => {
  TerminalControls.run('reopenTerminal');
});
document.getElementById('btn-terminal-close').addEventListener('click', () => {
  TerminalControls.run('closeTerminal', 'Closing the terminal ends the programs running in it. Continue?');
});
document.getElementById('btn-terminal-restart-workdir').addEventListener('click', () => {
  TerminalControls.run('restartTerminalFromWorkDir', 'This ends the current terminal, clears its history and reopens it from the task working directory. Continue?');
});

const Updates = {
  pollTimer: null,
  restartTimer: null,
  latestStatus: null,
  busy: false,

  setBusy(busy) {
    this.busy = busy;
    const button = document.getElementById('btn-one-click-update');
    if (button) {
      button.disabled = busy;
      button.textContent = busy ? 'Updating…' : '↻ Update';
    }
  },

  showResult(title, message) {
    this.setBusy(false);
    Modal.show(title, `<div class="update-message">${escapeHtml(message)}</div><div class="form-actions"><button class="btn-submit" id="update-result-close">Close</button></div>`);
    document.getElementById('update-result-close').addEventListener('click', Modal.hide);
  },

  async oneClick() {
    if (this.busy) return;
    this.setBusy(true);
    Modal.show('Checking for updates', '<div class="update-progress"><span class="update-spinner"></span><span>Checking for the latest version…</span></div>');
    try {
      const status = await API.post('/api/system/check-update', {});
      this.latestStatus = status;
      document.getElementById('update-dot').style.display = this.needsAttention(status) ? 'block' : 'none';
      if (status.status === 'updating') {
        Modal.show('Updating', UpdateLog.markup('update-progress-message', 'update-progress-error', 'Reading update progress…'));
        this.monitorApply();
      } else if (status.status === 'available') {
        if (!status.is_update_admin) this.showResult('Update not run', this.errorLabel('UPDATE_ADMIN_REQUIRED'));
        else await this.apply();
      } else {
        const restartHint = status.status === 'restart_pending' ? `. Restart for your install type: ${this.restartHelp}. Restarting interrupts programs running in terminals.` : '';
        this.showResult(this.statusLabel(status.status), status.error
          ? `${this.errorLabel(status.error)}${status.error_details ? `: ${status.error_details}` : ''}`
          : `${status.message || this.statusLabel(status.status)}${restartHint}`);
      }
    } catch (error) {
      this.showResult('Update check failed', error.message || 'Please retry later');
    }
  },

  statusLabel(status) {
    return ({
      idle: 'Not checked yet', checking: 'Checking', current: 'Up to date', available: 'Update available',
      local_newer: 'Local version is newer', blocked: 'Update blocked', updating: 'Updating', failed: 'Check failed',
      restart_pending: 'Service restart needed',
    })[status] || status || 'Unknown';
  },

  // There is a new version, or the code is already updated but the service still runs the old code (a restart is needed).
  needsAttention(status) {
    return status.status === 'available' || status.status === 'restart_pending';
  },

  restartHelp: 'PM2: pm2 restart t-agent; macOS login service: launchctl kickstart -k gui/$(id -u)/com.tagent.client; Linux systemd: sudo systemctl restart t-agent',


  formatTime(value) {
    if (!value) return 'Not checked yet';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
  },

  errorLabel(code) {
    return ({
      VERSION_REQUEST_TIMEOUT: 'GitHub request timed out', VERSION_RESPONSE_TOO_LARGE: 'Version file exceeds the size limit',
      INVALID_APP_VERSION: 'Remote version is not valid SemVer', INVALID_MANIFEST: 'Remote version file is malformed',
      UNTRUSTED_VERSION_URL: 'Version link is not trusted', VERSION_URL_NOT_CONFIGURED: 'No GitHub version link configured',
      WORKTREE_DIRTY: 'Local uncommitted changes', BRANCH_DIVERGED: 'Local branch has diverged',
      TRACKED_RUNTIME_FILES: 'Config or data files are tracked by Git; forced update stopped to protect data',
      VERSION_SOURCE_MISMATCH: 'GitHub version does not match the Git branch', UPDATE_ADMIN_REQUIRED: 'Only the update administrator can run updates',
      INVALID_UPDATE_REPOSITORY: 'Update repository is misconfigured', INVALID_UPDATE_REF: 'Update branch is misconfigured',
      INVALID_UPDATE_ARCHIVE: 'Downloaded update package has an invalid structure', UNSAFE_UPDATE_ARCHIVE: 'Update package contains unsafe files',
      ARCHIVE_CURL_FAILED: 'Update package download failed', ARCHIVE_TAR_FAILED: 'Update package extraction failed',
      NPM_INSTALLING_FAILED: 'Dependency install failed. Check the Node/npm environment',
      NPM_BUILDING_FAILED: 'Frontend build failed',
      NODE_PTY_LOAD_FAILED: 'Terminal native module install failed',
    })[code] || code || '';
  },

  async load({ notify = true } = {}) {
    try {
      const status = await API.get('/api/system/update-status');
      this.latestStatus = status;
      const hasUnread = status.status === 'available' && status.remote_version !== status.notice_version;
      document.getElementById('update-dot').style.display = this.needsAttention(status) ? 'block' : 'none';
      if (notify && hasUnread && !this.busy) this.showAvailable(status);
      return status;
    } catch {
      return null;
    }
  },

  async markNotified(status) {
    try { await API.post('/api/system/update-notified', { version: status.remote_version }); } catch {}
    if (this.latestStatus) this.latestStatus.notice_version = status.remote_version;
  },

  showAvailable(status) {
    this.markNotified(status);
    const release = status.remote_manifest && status.remote_manifest.release_url;
    Modal.show('Update available', `
      <div class="update-hero">
        <span class="update-version">${escapeHtml(status.local_version || 'Unknown')}</span>
        <span class="update-arrow">→</span>
        <span class="update-version new">${escapeHtml(status.remote_version)}</span>
      </div>
      <div class="update-message">A new version is available on GitHub${status.remote_manifest && status.remote_manifest.published_at ? `, published ${escapeHtml(this.formatTime(status.remote_manifest.published_at))}` : ''}. Click “Update now” to upgrade.</div>
      ${release ? `<a class="update-release-link" href="${escapeHtml(release)}" target="_blank" rel="noopener noreferrer">View GitHub release notes ↗</a>` : ''}
      <div class="form-actions">
        <button class="btn-cancel" id="update-later">Remind me later</button>
        ${status.is_update_admin ? '<button class="btn-submit" id="update-apply">Update now</button>' : '<span class="form-hint">Ask the update administrator to run the update</span>'}
      </div>
    `);
    document.getElementById('update-later').addEventListener('click', Modal.hide);
    const apply = document.getElementById('update-apply');
    if (apply) apply.addEventListener('click', () => this.confirmApply(status));
  },

  confirmApply(status) {
    const archiveInstall = status.install_type === 'archive';
    const noRestart = status.restart_required === false;
    Modal.show('Confirm local service update', `
      <div class="update-warning">${noRestart ? 'Only frontend assets are updated; the service will not restart and existing shells stay connected. Refresh the page manually afterwards.' : `${archiveInstall ? 'The update downloads the official install package' : 'The update checks the Git workspace and fast-forwards the code'}, then installs dependencies and restarts the service. Existing shell connections will be interrupted.`}</div>
      <div class="update-detail-row"><span>Target version</span><strong>${escapeHtml(status.remote_version)}</strong></div>
      <div class="update-detail-row"><span>Install type</span><strong>${archiveInstall ? 'Package update' : 'Git fast-forward update'}</strong></div>
      <div class="update-detail-row"><span>GitHub version source</span><code title="${escapeHtml(status.version_url || '')}">${escapeHtml(status.version_url || 'Not configured')}</code></div>
      <div class="form-hint">The SQLite database is backed up before updating; accounts, tokens, tasks and working directories are not overwritten.</div>
      ${archiveInstall ? '' : '<label class="form-hint"><input type="checkbox" id="update-force"> Force update: back up local uncommitted code and untracked files to a Git stash, then use the remote code; ignored config and task data are kept. The backup is not restored automatically, and committed divergence still blocks the update.</label>'}
      <div class="form-actions">
        <button class="btn-cancel" id="update-confirm-cancel">Cancel</button>
        <button class="btn-submit" id="update-confirm-apply">${noRestart ? 'Confirm update (no restart)' : 'Confirm update and restart'}</button>
      </div>
    `);
    document.getElementById('update-confirm-cancel').addEventListener('click', Modal.hide);
    document.getElementById('update-confirm-apply').addEventListener('click', () => this.apply(document.getElementById('update-force')?.checked === true));
  },

  async apply(force = false) {
    this.setBusy(true);
    Modal.show('Updating', UpdateLog.markup('update-progress-message', 'update-progress-error'));
    try {
      this.updateServerDown = false;
      this.restartSeenAt = null;
      // Remember the current process start ID first: a changed ID after the restart proves the new process is up.
      this.updateBootId = await this.currentBootId();
      const response = await API.post('/api/system/apply-update', { confirm: true, force });
      // The endpoint returns { accepted, status: {...} }; early versions and tests may return the status itself.
      const status = response && typeof response.status === 'object' && response.status ? response.status : response;
      if (!this.updateBootId) this.updateBootId = status.boot_id || null;
      if (status.stage === 'completed') { this.showCompleted(status); return; }
      this.monitorApply();
    } catch (error) {
      let status = null;
      try { status = await API.get('/api/system/update-status'); } catch {}
      const code = status && status.error;
      this.setBusy(false);
      if (!document.getElementById('update-progress-message')) {
        this.showResult('Update not run', `${this.errorLabel(code) || error.message}${status?.error_details ? `: ${status.error_details}` : ''}`);
        return;
      }
      document.getElementById('update-progress-message').textContent = 'Update not run';
      const errorNode = document.getElementById('update-progress-error');
      errorNode.className = 'form-hint error';
      errorNode.textContent = `${this.errorLabel(code) || error.message}${status && status.error_details ? `: ${status.error_details}` : ''}`;
      const spinner = document.querySelector('.update-spinner');
      if (spinner) spinner.remove();
    }
  },

  monitorApply() {
    clearInterval(this.restartTimer);
    this.restartTimer = setInterval(async () => {
      let status;
      try { status = await API.get('/api/system/update-status'); } catch { this.updateServerDown = true; return; }
      const message = document.getElementById('update-progress-message');
      if (message && status.message) message.textContent = Array.isArray(status.log) && status.log.length ? UpdateLog.headline(status.message) : status.message;
      UpdateLog.render(document.getElementById('update-progress-message-log'), status.log);
      if (status.status === 'blocked' || status.status === 'failed') {
        this.setBusy(false);
        clearInterval(this.restartTimer);
        if (message) message.textContent = 'Update not run';
        const errorNode = document.getElementById('update-progress-error');
        if (errorNode) {
          errorNode.className = 'form-hint error';
          errorNode.textContent = `${this.errorLabel(status.error) || status.message || 'Update failed'}${status.error_details ? `: ${status.error_details}` : ''}`;
        }
        const spinner = document.querySelector('.update-spinner');
        if (spinner) spinner.remove();
        if (status.error === 'WORKTREE_DIRTY' && errorNode) {
          const retry = document.createElement('button');
          retry.className = 'btn-submit';
          retry.textContent = 'Choose force update…';
          retry.addEventListener('click', () => this.confirmApply(status));
          errorNode.after(retry);
        }
      } else if (status.stage === 'completed') {
        clearInterval(this.restartTimer);
        this.showCompleted(status);
      } else if (status.stage === 'restarting') {
        clearInterval(this.restartTimer);
        this.waitForRestart();
      } else if (status.status !== 'updating' && this.isNewProcess(status.boot_id, { trustUnknown: true })) {
        // The service finished restarting between two polls: the new process no longer reports updating, so reload to load the new UI.
        // The new process must be confirmed; the old process may also report a non-updating status before it exits, and reloading then would only fetch the old UI.
        clearInterval(this.restartTimer);
        this.showCompleted(status);
      }
    }, 1000);
  },

  showCompleted(status) {
    this.setBusy(false);
    document.getElementById('update-dot').style.display = 'none';
    const message = document.getElementById('update-progress-message');
    if (message) {
      // Keep the terminal log, show a notice, then refresh the page to load the new UI.
      message.textContent = 'Update complete, refreshing the page…';
      const title = document.getElementById('modal-title');
      if (title) title.textContent = 'Update complete';
      const spinner = document.querySelector('.update-spinner');
      if (spinner) spinner.remove();
      UpdateLog.render(document.getElementById('update-progress-message-log'), status.log);
    } else {
      Modal.show('Update complete', '<div class="update-message">Update complete, refreshing the page…</div>');
    }
    setTimeout(() => window.location.reload(), 1500);
  },

  async currentBootId() {
    try {
      const version = await API.get('/api/system/version');
      return (version && version.boot_id) || null;
    } catch { return null; }
  },

  // Restart finished = the page is talking to the new process. The on-disk version number is already new before the restart, so it cannot be used; check whether the process start ID changed instead.
  // Fallback (does not depend on any single poll hitting the outage): the old process exits about 0.75 s after writing "restarting", so a request that succeeds
  // after RESTART_GRACE_MS from seeing "restarting" must come from the new process.
  RESTART_GRACE_MS: 4000,
  restartGraceElapsed() {
    return Boolean(this.restartSeenAt) && Date.now() - this.restartSeenAt > this.RESTART_GRACE_MS;
  },
  isNewProcess(bootId, { trustUnknown = false } = {}) {
    if (this.restartGraceElapsed()) return true;
    if (this.updateBootId) return Boolean(bootId) && bootId !== this.updateBootId;
    return trustUnknown || Boolean(this.updateServerDown);
  },

  showManualRefresh() {
    const note = document.getElementById('update-progress-error');
    if (!note || note.querySelector('button')) return;
    note.className = 'form-hint';
    note.textContent = 'The page refreshes automatically once the service is back; if it takes too long, refresh manually: ';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-submit';
    button.textContent = 'Refresh now';
    button.addEventListener('click', () => window.location.reload());
    note.append(button);
  },

  waitForRestart() {
    this.restartSeenAt = this.restartSeenAt || Date.now();
    const message = document.getElementById('update-progress-message');
    if (message) message.textContent = 'The service is restarting; the page refreshes automatically when it is back…';
    clearInterval(this.restartTimer);
    const startedAt = Date.now();
    this.restartTimer = setInterval(async () => {
      if (Date.now() - startedAt > 20000) this.showManualRefresh();
      try {
        const res = await fetch('/api/system/version', { cache: 'no-store', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        if (!res.ok) { this.updateServerDown = true; return; }
        const version = await res.json();
        if (this.isNewProcess(version.boot_id)) { clearInterval(this.restartTimer); window.location.reload(); }
      } catch { this.updateServerDown = true; }
    }, 1500);
  },

  renderSettings(status) {
    const remote = status.remote_manifest || {};
    return `
      <div class="settings-section">
        <div class="settings-section-title">Check for updates</div>
        <div class="update-detail-row"><span>Status</span><strong class="update-status ${escapeHtml(status.status)}">${escapeHtml(this.statusLabel(status.status))}</strong></div>
        <div class="update-detail-row"><span>Current version</span><strong>${escapeHtml(status.local_version || 'Unknown')}</strong></div>
        <div class="update-detail-row"><span>Remote version</span><strong>${escapeHtml(status.remote_version || 'Not fetched yet')}</strong></div>
        <div class="update-detail-row"><span>Last checked</span><span>${escapeHtml(this.formatTime(status.last_checked_at))}</span></div>
        <div class="update-detail-row"><span>Check interval</span><span>${escapeHtml(String(status.check_interval_seconds / 60))} min</span></div>
        <div class="update-detail-row"><span>Install type</span><span>${({ archive: 'Package update', git: 'Git fast-forward update' })[status.install_type] || 'Unknown'}</span></div>
        <div class="update-detail-row update-url-row"><span>GitHub version source</span><code title="${escapeHtml(status.version_url || '')}">${escapeHtml(status.version_url || 'Not configured')}</code></div>
        ${remote.release_url ? `<div class="update-detail-row"><span>Release notes</span><a href="${escapeHtml(remote.release_url)}" target="_blank" rel="noopener noreferrer">GitHub Release ↗</a></div>` : ''}
        ${status.status === 'restart_pending' ? `<div class="form-hint update-restart-hint"><strong>${escapeHtml(status.message || 'Code updated; restart the service to apply it')}</strong><br>Restart for your install type: ${escapeHtml(this.restartHelp)}. Restarting interrupts programs running in terminals.</div>` : ''}
        ${status.error ? `<div class="form-hint error update-error">${escapeHtml(this.errorLabel(status.error))}${status.error_details ? `: ${escapeHtml(status.error_details)}` : ''}</div>` : ''}
        <div class="settings-inline-actions">
          <button class="btn-cancel" id="settings-check-update">Check now</button>
          ${status.status === 'available' && status.is_update_admin ? '<button class="btn-submit" id="settings-apply-update">Update now</button>' : ''}
        </div>
      </div>
    `;
  },

  bindSettings(status) {
    const check = document.getElementById('settings-check-update');
    check.addEventListener('click', async () => {
      check.disabled = true;
      check.textContent = 'Checking…';
      try {
        const next = await API.post('/api/system/check-update', {});
        this.latestStatus = next;
        if (next.status === 'available') {
          this.showAvailable(next);
        } else {
          alert(this.statusLabel(next.status));
          Modal.hide();
        }
      } catch {
        const next = await this.load({ notify: false });
        alert(next ? this.errorLabel(next.error) : 'Update check failed');
        Modal.hide();
      }
    });
    const apply = document.getElementById('settings-apply-update');
    if (apply) apply.addEventListener('click', () => this.confirmApply(status));
  },

  async start() {
    const status = await this.load();
    if (status && (status.status === 'idle' || status.status === 'failed' || status.status === 'blocked')) {
      try {
        const next = await API.post('/api/system/check-update', {});
        this.latestStatus = next;
        document.getElementById('update-dot').style.display = this.needsAttention(next) ? 'block' : 'none';
        if (!this.busy && next.status === 'available' && next.remote_version !== next.notice_version) this.showAvailable(next);
      } catch {}
    }
    this.pollTimer = setInterval(() => this.load(), 60_000);
  },
};

document.getElementById('btn-one-click-update')?.addEventListener('click', () => Updates.oneClick());

// Theme picker: a click applies immediately and is remembered (in this browser).
function showThemePicker() {
  const cards = Theme.list().map(theme => `
    <button type="button" class="theme-card${theme.id === Theme.get() ? ' active' : ''}" data-theme-id="${theme.id}" role="radio" aria-checked="${theme.id === Theme.get()}">
      <span class="theme-swatch theme-swatch-${theme.id}" aria-hidden="true"><i></i><i></i><i></i></span>
      <strong>${escapeHtml(theme.label)}</strong><span class="theme-hint">${escapeHtml(theme.hint)}</span>
    </button>`).join('');
  Modal.show('Switch theme', `<div class="theme-grid" role="radiogroup" aria-label="Theme">${cards}</div>
    <div class="form-hint">Saved in this browser.</div>`);
  document.querySelectorAll('.theme-card').forEach(card => card.addEventListener('click', () => {
    Theme.set(card.dataset.themeId);
    document.querySelectorAll('.theme-card').forEach(item => {
      const active = item === card;
      item.classList.toggle('active', active);
      item.setAttribute('aria-checked', String(active));
    });
  }));
}
document.getElementById('btn-theme')?.addEventListener('click', showThemePicker);

const ContextMenu = {
  show(x, y, items) {
    const menu = document.getElementById('context-menu');
    const list = document.getElementById('context-menu-list');
    list.innerHTML = '';
    items.forEach(item => {
      if (item.separator) {
        const li = document.createElement('li');
        li.className = 'separator';
        list.appendChild(li);
        return;
      }
      const li = document.createElement('li');
      li.textContent = item.label;
      if (item.danger) li.className = 'danger';
      li.addEventListener('click', () => { ContextMenu.hide(); item.action(); });
      list.appendChild(li);
    });
    menu.style.display = 'block';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
      if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
    });
  },
  hide() {
    document.getElementById('context-menu').style.display = 'none';
  },
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('click', () => ContextMenu.hide());
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { Modal.hide(); ContextMenu.hide(); }
});
document.getElementById('modal-close').addEventListener('click', Modal.hide);
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) Modal.hide();
});

// ---- Access mode: authenticator + allow external access / local access only (no verification) ----
function accessModeSection(user) {
  const local = user.access_mode === 'local';
  const loopbackOnly = ['127.0.0.1', '::1', 'localhost'].includes(user.listen_host);
  return `<div class="settings-section"><div class="settings-section-title">Access mode · ${local ? 'Local access only' : 'Authenticator + allow external access'}</div>
    <div class="form-hint">${local
      ? 'Only access from this machine is accepted, with no code; other devices and remote clients cannot reach this client.'
      : 'An authenticator login is required; phones, other computers and remote clients can connect.'}${!local && loopbackOnly ? ` Note: the service currently listens only on ${escapeHtml(user.listen_host)}. To let other devices connect, set HOST=0.0.0.0 in .env and restart the service.` : ''}</div>
    ${local && user.authenticator_bound ? '<div class="form-group"><label class="form-label" for="settings-mode-code">6-digit authenticator code (verified when switching back to external access)</label><input class="form-input" id="settings-mode-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>' : ''}
    <div class="settings-inline-actions"><button class="btn-cancel" id="settings-mode-switch">${local ? 'Switch to: authenticator + external access' : 'Switch to: local access only (no verification)'}</button></div>
    <p class="form-hint" id="settings-mode-feedback" role="status"></p></div>`;
}

function bindAccessMode(user) {
  const button = document.getElementById('settings-mode-switch');
  const feedback = document.getElementById('settings-mode-feedback');
  const local = user.access_mode === 'local';
  button.addEventListener('click', async () => {
    const loginPath = window.TAgentLoginPath || '/auth/login';
    if (!local && !confirm('After switching to “local access only”, no code is needed, and phones, other computers and remote clients (including connections that use this Client as an engine) can no longer reach it.\n\nSessions on other devices end immediately. Switch?')) return;
    button.disabled = true;
    feedback.textContent = '';
    try {
      const body = local ? { mode: 'remote', code: (document.getElementById('settings-mode-code')?.value || '').trim() } : { mode: 'local' };
      const result = await API.post('/auth/mode', body);
      if (result.locked_out) { feedback.textContent = 'Switched to local access only. This device is not the local machine and can no longer connect; use the browser on the server itself.'; return; }
      location.replace(result.redirect || '/web');
    } catch (error) {
      let code = error.message;
      try { code = JSON.parse(error.message); } catch { /* keep the original text */ }
      const data = code && typeof code === 'object' ? code : { error: String(code) };
      if (data.error === 'AUTHENTICATOR_BINDING_REQUIRED') { location.href = data.redirect || `${loginPath}/setup?return_to=/web`; return; }
      feedback.textContent = ({ AUTH_CODE_INVALID: 'The code is invalid or already used. Wait for the next code.', AUTH_RATE_LIMITED: 'Too many attempts. Try again in 15 minutes.' })[data.error] || `Switch failed: ${data.error}`;
    } finally { button.disabled = false; }
  });
}

async function init() {
  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (!confirm('Logging out disconnects local and remote terminals, but tasks running on the server keep running. Log out?')) return;
    try { await API.post('/auth/logout', {}); location.replace(`${window.TAgentLoginPath || '/auth/login'}?return_to=/web`); }
    catch { alert('Log out failed. Please retry later.'); }
  });
  document.getElementById('btn-settings').addEventListener('click', async () => {
    let user = {};
    try { user = await API.get('/auth/me'); }
    catch(e) { alert('Could not load settings: ' + e.message); return; }
    const initialWorkDir = user.work_dir || user.effective_work_dir || '';
    const updateStatus = await Updates.load({ notify: false });
    Modal.show('Settings', `
      <div class="form-group">
        <label class="form-label">Working directory</label>
        <input class="form-input" id="settings-work-dir" value="${escapeHtml(initialWorkDir)}" placeholder="e.g. /Users/yourname/tasks">
        <div class="form-hint">Root directory for md files of new tasks; created if missing. Clear it to restore the default.</div>
      </div>
      <div class="settings-section"><div class="settings-section-title">Image upload</div><div class="form-hint">After configuring Alibaba Cloud OSS on the client, you can paste images into local and remote terminals or use the upload button at the bottom of the terminal.</div><div class="settings-inline-actions"><button class="btn-cancel" id="settings-oss">Configure Alibaba Cloud OSS</button></div></div>
      <div class="settings-section"><div class="settings-section-title">Remote service</div><div class="form-hint">This client can also act as an engine so other clients can reach its tasks, files and terminals.</div><div class="settings-inline-actions"><button class="btn-cancel" id="settings-remote-tokens">Allow other clients to connect as an engine</button></div></div>
      ${accessModeSection(user)}
      <div class="settings-section"><div class="settings-section-title">Authenticator · bound</div><div class="form-hint">Computer and phone share the same page and binding. Logins last 30 days and renew while in use; after 30 days of inactivity you must verify again. After replacing, the old authenticator, recovery codes and other devices’ logins stop working immediately.</div><a class="toolbar-btn" href="/auth/setup?return_to=/web">Replace authenticator</a></div>
      ${updateStatus ? Updates.renderSettings(updateStatus) : ''}
      <div class="form-actions">
        <button class="btn-cancel" id="settings-cancel">Cancel</button>
        <button class="btn-submit" id="settings-save">Save</button>
      </div>
    `);
    document.getElementById('settings-cancel').addEventListener('click', Modal.hide);
    document.getElementById('settings-oss').addEventListener('click', () => TerminalImages.showSettings());
    document.getElementById('settings-remote-tokens').addEventListener('click', () => Engines.showTokens());
    bindAccessMode(user);
    if (updateStatus) Updates.bindSettings(updateStatus);
    document.getElementById('settings-save').addEventListener('click', async () => {
      const value = document.getElementById('settings-work-dir').value.trim();
      const work_dir = value === initialWorkDir ? user.work_dir || null : value || null;
      try {
        await API.put('/auth/settings', { work_dir });
        Modal.hide();
      } catch(e) {
        alert('Save failed: ' + e.message);
      }
    });
  });

  await Promise.all([
    TerminalImages.load().catch(() => {}),
    Bookmarks.load(),
    Tasks.load(),
    Engines.load(),
  ]);
  Updates.start();
}

// app.js loads before the other feature scripts so that it can provide shared objects such as API, Modal and ContextMenu.
// Start on DOMContentLoaded so that bookmarks.js, tasks.js and engines.js (loaded later)
// have finished declaring. Now that single-user mode no longer makes a login request, we cannot rely on an async request to yield implicitly.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
