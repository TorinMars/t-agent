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
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-overlay').style.display = 'flex';
  },
  hide() {
    document.getElementById('modal-overlay').style.display = 'none';
    document.getElementById('modal-body').innerHTML = '';
  },
};

const Updates = {
  pollTimer: null,
  restartTimer: null,
  latestStatus: null,

  statusLabel(status) {
    return ({
      idle: '尚未检查', checking: '正在检查', current: '已是最新', available: '发现新版本',
      local_newer: '本地版本较新', blocked: '更新被阻断', updating: '正在更新', failed: '检查失败',
    })[status] || status || '未知';
  },

  formatTime(value) {
    if (!value) return '尚未检查';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
  },

  errorLabel(code) {
    return ({
      VERSION_REQUEST_TIMEOUT: '访问 GitHub 超时', VERSION_RESPONSE_TOO_LARGE: '版本文件超过大小限制',
      INVALID_APP_VERSION: '远程版本号不符合 SemVer', INVALID_MANIFEST: '远程版本文件格式错误',
      UNTRUSTED_VERSION_URL: '版本链接不受信任', VERSION_URL_NOT_CONFIGURED: '未配置 GitHub 版本链接',
      WORKTREE_DIRTY: '本地有未提交修改', BRANCH_DIVERGED: '本地分支已分叉',
      VERSION_SOURCE_MISMATCH: 'GitHub 版本与 Git 分支不一致', UPDATE_ADMIN_REQUIRED: '只有更新管理员可以执行更新',
      INVALID_UPDATE_REPOSITORY: '更新仓库配置不正确', INVALID_UPDATE_REF: '更新分支配置不正确',
      INVALID_UPDATE_ARCHIVE: '下载的更新包结构不正确', UNSAFE_UPDATE_ARCHIVE: '更新包包含不安全的文件',
      ARCHIVE_CURL_FAILED: '更新包下载失败', ARCHIVE_TAR_FAILED: '更新包解压失败',
    })[code] || code || '';
  },

  async load({ notify = true } = {}) {
    try {
      const status = await API.get('/api/system/update-status');
      this.latestStatus = status;
      const hasUnread = status.status === 'available' && status.remote_version !== status.notice_version;
      document.getElementById('update-dot').style.display = status.status === 'available' ? 'block' : 'none';
      if (notify && hasUnread) this.showAvailable(status);
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
    Modal.show('发现新版本', `
      <div class="update-hero">
        <span class="update-version">${escapeHtml(status.local_version || '未知')}</span>
        <span class="update-arrow">→</span>
        <span class="update-version new">${escapeHtml(status.remote_version)}</span>
      </div>
      <div class="update-message">GitHub 上已有新版本${status.remote_manifest && status.remote_manifest.published_at ? `，发布于 ${escapeHtml(this.formatTime(status.remote_manifest.published_at))}` : ''}。请点击“立即更新”完成升级。</div>
      ${release ? `<a class="update-release-link" href="${escapeHtml(release)}" target="_blank" rel="noopener noreferrer">查看 GitHub 发布说明 ↗</a>` : ''}
      <div class="form-actions">
        <button class="btn-cancel" id="update-later">稍后提醒</button>
        ${status.is_update_admin ? '<button class="btn-submit" id="update-apply">立即更新</button>' : '<span class="form-hint">请联系更新管理员执行更新</span>'}
      </div>
    `);
    document.getElementById('update-later').addEventListener('click', Modal.hide);
    const apply = document.getElementById('update-apply');
    if (apply) apply.addEventListener('click', () => this.confirmApply(status));
  },

  confirmApply(status) {
    const archiveInstall = status.install_type === 'archive';
    Modal.show('确认更新本地服务', `
      <div class="update-warning">${archiveInstall ? '更新将下载官方安装包，保留配置、数据库、日志和任务目录' : '更新将检查 Git 工作区并快进代码'}，随后安装依赖并重启服务。</div>
      <div class="update-detail-row"><span>目标版本</span><strong>${escapeHtml(status.remote_version)}</strong></div>
      <div class="update-detail-row"><span>安装方式</span><strong>${archiveInstall ? '安装包更新' : 'Git 快进更新'}</strong></div>
      <div class="update-detail-row"><span>GitHub 版本源</span><code title="${escapeHtml(status.version_url || '')}">${escapeHtml(status.version_url || '未配置')}</code></div>
      <div class="form-hint">更新前会自动备份 SQLite 数据库；账号、Token、任务和工作目录不会被覆盖。</div>
      <div class="form-actions">
        <button class="btn-cancel" id="update-confirm-cancel">取消</button>
        <button class="btn-submit" id="update-confirm-apply">确认更新并重启</button>
      </div>
    `);
    document.getElementById('update-confirm-cancel').addEventListener('click', Modal.hide);
    document.getElementById('update-confirm-apply').addEventListener('click', () => this.apply());
  },

  async apply() {
    Modal.show('正在更新', '<div class="update-progress"><span class="update-spinner"></span><span id="update-progress-message">正在启动更新流程…</span></div><div class="form-hint" id="update-progress-error"></div>');
    try {
      await API.post('/api/system/apply-update', { confirm: true });
      this.monitorApply();
    } catch (error) {
      let status = null;
      try { status = await API.get('/api/system/update-status'); } catch {}
      const code = status && status.error;
      document.getElementById('update-progress-message').textContent = '更新未执行';
      const errorNode = document.getElementById('update-progress-error');
      errorNode.className = 'form-hint error';
      errorNode.textContent = this.errorLabel(code) || error.message;
      const spinner = document.querySelector('.update-spinner');
      if (spinner) spinner.remove();
    }
  },

  monitorApply() {
    clearInterval(this.restartTimer);
    this.restartTimer = setInterval(async () => {
      let status;
      try { status = await API.get('/api/system/update-status'); } catch { return; }
      const message = document.getElementById('update-progress-message');
      if (message && status.message) message.textContent = status.message;
      if (status.status === 'blocked' || status.status === 'failed') {
        clearInterval(this.restartTimer);
        if (message) message.textContent = '更新未执行';
        const errorNode = document.getElementById('update-progress-error');
        if (errorNode) {
          errorNode.className = 'form-hint error';
          errorNode.textContent = this.errorLabel(status.error) || status.message || '更新失败';
        }
        const spinner = document.querySelector('.update-spinner');
        if (spinner) spinner.remove();
      } else if (status.stage === 'restarting') {
        clearInterval(this.restartTimer);
        this.waitForRestart(status.remote_version);
      }
    }, 1000);
  },

  waitForRestart(targetVersion) {
    document.getElementById('update-progress-message').textContent = '服务正在重启，恢复后页面会自动刷新…';
    clearInterval(this.restartTimer);
    this.restartTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/system/version', { cache: 'no-store', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        if (!res.ok) return;
        const version = await res.json();
        if (!targetVersion || version.app_version === targetVersion) window.location.reload();
      } catch {}
    }, 1500);
  },

  renderSettings(status) {
    const remote = status.remote_manifest || {};
    return `
      <div class="settings-section">
        <div class="settings-section-title">检查更新</div>
        <div class="update-detail-row"><span>状态</span><strong class="update-status ${escapeHtml(status.status)}">${escapeHtml(this.statusLabel(status.status))}</strong></div>
        <div class="update-detail-row"><span>当前版本</span><strong>${escapeHtml(status.local_version || '未知')}</strong></div>
        <div class="update-detail-row"><span>远程版本</span><strong>${escapeHtml(status.remote_version || '尚未获取')}</strong></div>
        <div class="update-detail-row"><span>上次检查</span><span>${escapeHtml(this.formatTime(status.last_checked_at))}</span></div>
        <div class="update-detail-row"><span>检查间隔</span><span>${escapeHtml(String(status.check_interval_seconds / 60))} 分钟</span></div>
        <div class="update-detail-row"><span>安装方式</span><span>${status.install_type === 'archive' ? '安装包更新' : 'Git 快进更新'}</span></div>
        <div class="update-detail-row update-url-row"><span>GitHub 版本源</span><code title="${escapeHtml(status.version_url || '')}">${escapeHtml(status.version_url || '未配置')}</code></div>
        ${remote.release_url ? `<div class="update-detail-row"><span>发布说明</span><a href="${escapeHtml(remote.release_url)}" target="_blank" rel="noopener noreferrer">GitHub Release ↗</a></div>` : ''}
        ${status.error ? `<div class="form-hint error update-error">${escapeHtml(this.errorLabel(status.error))}</div>` : ''}
        <div class="settings-inline-actions">
          <button class="btn-cancel" id="settings-check-update">立即检查</button>
          ${status.status === 'available' && status.is_update_admin ? '<button class="btn-submit" id="settings-apply-update">立即更新</button>' : ''}
        </div>
      </div>
    `;
  },

  bindSettings(status) {
    const check = document.getElementById('settings-check-update');
    check.addEventListener('click', async () => {
      check.disabled = true;
      check.textContent = '检查中…';
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
        alert(next ? this.errorLabel(next.error) : '检查更新失败');
        Modal.hide();
      }
    });
    const apply = document.getElementById('settings-apply-update');
    if (apply) apply.addEventListener('click', () => this.confirmApply(status));
  },

  async start() {
    const status = await this.load();
    if (status && (status.status === 'idle' || status.status === 'failed')) {
      try {
        const next = await API.post('/api/system/check-update', {});
        this.latestStatus = next;
        document.getElementById('update-dot').style.display = next.status === 'available' ? 'block' : 'none';
        if (next.status === 'available' && next.remote_version !== next.notice_version) this.showAvailable(next);
      } catch {}
    }
    this.pollTimer = setInterval(() => this.load(), 60_000);
  },
};

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

async function init() {
  try {
    const user = await API.get('/auth/me');
    if (user && user.login) {
      const avatar = document.getElementById('user-avatar');
      avatar.src = user.avatar_url;
      avatar.alt = user.login;
      avatar.style.display = 'inline-block';
      document.getElementById('user-name').textContent = user.login;
    }
  } catch (e) {}

  document.getElementById('btn-settings').addEventListener('click', async () => {
    let user = {};
    try { user = await API.get('/auth/me'); } catch(e) {}
    const updateStatus = await Updates.load({ notify: false });
    Modal.show('设置', `
      <div class="form-group">
        <label class="form-label">工作目录</label>
        <input class="form-input" id="settings-work-dir" value="${user.work_dir || ''}" placeholder="例如 /Users/yourname/tasks">
        <div class="form-hint">新建任务时 md 文件的根目录，目录不存在会自动创建</div>
      </div>
      <div class="settings-section"><div class="settings-section-title">远程服务</div><div class="form-hint">管理允许其他 torin-x-web 读取当前账号任务的访问 Token。</div><div class="settings-inline-actions"><button class="btn-cancel" id="settings-remote-tokens">管理访问 Token</button></div></div>
      ${updateStatus ? Updates.renderSettings(updateStatus) : ''}
      <div class="form-actions">
        <button class="btn-cancel" id="settings-cancel">取消</button>
        <button class="btn-submit" id="settings-save">保存</button>
      </div>
    `);
    document.getElementById('settings-cancel').addEventListener('click', Modal.hide);
    document.getElementById('settings-remote-tokens').addEventListener('click', () => RemoteTasks.showTokens());
    if (updateStatus) Updates.bindSettings(updateStatus);
    document.getElementById('settings-save').addEventListener('click', async () => {
      const work_dir = document.getElementById('settings-work-dir').value.trim() || null;
      try {
        await API.put('/auth/settings', { work_dir });
        Modal.hide();
      } catch(e) {
        alert('保存失败: ' + e.message);
      }
    });
  });

  await Promise.all([
    Bookmarks.load(),
    Tasks.load(),
    RemoteTasks.load(),
  ]);
  Updates.start();
}

init();
