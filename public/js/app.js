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
    Modal.show('设置', `
      <div class="form-group">
        <label class="form-label">工作目录</label>
        <input class="form-input" id="settings-work-dir" value="${user.work_dir || ''}" placeholder="例如 /Users/yourname/tasks">
        <div class="form-hint">新建任务时 md 文件的根目录，目录不存在会自动创建</div>
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="settings-cancel">取消</button>
        <button class="btn-submit" id="settings-save">保存</button>
      </div>
    `);
    document.getElementById('settings-cancel').addEventListener('click', Modal.hide);
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
  ]);
}

init();
