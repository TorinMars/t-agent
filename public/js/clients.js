(() => {
  'use strict';
  const STORAGE_KEY = 't-agent:clients:v1';

  function normalizeAddress(value, pageProtocol = 'https:') {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 2048) throw new Error('请填写有效的 Client 地址');
    // Bare host:port addresses inherit the switcher's protocol.
    const candidate = /^https?:\/\//i.test(raw) ? raw
      : raw.startsWith('//') ? `${pageProtocol}${raw}` : `${pageProtocol}//${raw}`;
    let url;
    try { url = new URL(candidate); } catch { throw new Error('地址格式不正确，请填写 HTTP 或 HTTPS 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || /[\s\\]/.test(raw) || /^(javascript|data|file|ftp):/i.test(raw)) {
      throw new Error('请填写不含账号密码的 HTTP 或 HTTPS 地址');
    }
    if (!['/', '/web', '/web/', '/index.html', '/h5'].includes(url.pathname) || url.search || url.hash) {
      throw new Error('请填写 Client 根地址或 /web 地址，不包含参数或其他路径');
    }
    if (pageProtocol === 'https:' && url.protocol === 'http:') {
      throw new Error('HTTPS 工作台不能内嵌 HTTP Client，请使用 HTTPS 地址');
    }
    return url.origin;
  }

  function readState(raw, pageProtocol) {
    const state = { clients: [], selectedId: null };
    if (!raw) return state;
    try {
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.clients)) return state;
      for (const client of data.clients.slice(0, 100)) {
        try {
          if (typeof client.id !== 'string' || !client.id || typeof client.name !== 'string'
            || !client.name.trim() || typeof client.address !== 'string') continue;
          const address = normalizeAddress(client.address, pageProtocol);
          if (state.clients.some(item => item.id === client.id || item.address === address)) continue;
          state.clients.push({ id: client.id, name: client.name.trim().slice(0, 80), address });
        } catch { /* Skip invalid saved entries without losing the rest. */ }
      }
      state.selectedId = state.clients.some(client => client.id === data.selectedId)
        ? data.selectedId : state.clients[0]?.id || null;
    } catch { /* A damaged browser preference must not prevent page startup. */ }
    return state;
  }

  // Pure helpers are also used by the regression suite.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeAddress, readState, STORAGE_KEY };
    return;
  }

  const el = id => document.getElementById(id);
  const frames = new Map();
  let storageError = false;
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { storageError = true; }
  const state = readState(raw, location.protocol);
  if (raw === null) {
    state.clients.push({ id: 'local', name: '当前 Client', address: location.origin });
    state.selectedId = 'local';
  }
  let editingId = null;
  let formReturnFocus = null;

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...state }));
      storageError = false;
    } catch { storageError = true; }
  }

  function selected() { return state.clients.find(client => client.id === state.selectedId); }

  function updateToolbar() {
    const client = selected();
    el('client-toolbar').hidden = !client;
    el('hub-empty').hidden = Boolean(client);
    let notice = storageError ? '浏览器无法保存地址，当前修改仅在本次页面打开期间有效。' : '';
    if (client) {
      const status = frames.get(client.id)?.status || 'loading';
      el('client-address').textContent = client.address;
      el('client-open').href = `${client.address}/web`;
      el('client-status').textContent = ({ loading: '正在载入…', ready: '页面已载入', 'auth-required': '需要登录', unconfirmed: '等待页面响应' })[status];
      const explanation = status === 'auth-required'
        ? '请点击“打开并登录”完成身份验证，再点击“刷新”。已登录仍无法载入时，请检查跨站 Cookie 和内嵌配置。'
        : status === 'unconfirmed'
          ? '尚未收到页面响应。请打开 Client 检查连接和登录状态；如页面空白，请检查目标版本、内嵌配置、第三方 Cookie 及反向代理设置。'
          : '';
      if (explanation) notice += `${notice ? ' ' : ''}${explanation}`;
    }
    el('hub-notice').textContent = notice;
    el('hub-notice').hidden = !notice;
  }

  function loadFrame(client) {
    let entry = frames.get(client.id);
    if (entry) return entry;
    const frame = document.createElement('iframe');
    frame.title = client.name;
    frame.referrerPolicy = 'origin';
    frame.setAttribute('allow', 'clipboard-write; fullscreen');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads');
    entry = { frame, status: 'loading', timer: null };
    frames.set(client.id, entry);
    // onload alone cannot distinguish a blocked iframe from a working Client.
    entry.timer = setTimeout(() => {
      if (entry.status === 'loading') { entry.status = 'unconfirmed'; updateToolbar(); }
    }, 12000);
    frame.src = `${client.address}/web`;
    el('client-workspace').appendChild(frame);
    return entry;
  }

  function disposeFrame(id) {
    const entry = frames.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.frame.remove();
    frames.delete(id);
  }

  function render() {
    const tabs = el('client-tabs');
    tabs.replaceChildren();
    for (const client of state.clients) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'client-tab';
      button.textContent = client.name;
      button.title = `${client.name} · ${client.address}`;
      button.setAttribute('aria-current', String(client.id === state.selectedId));
      button.addEventListener('click', () => {
        if (state.selectedId === client.id) return;
        state.selectedId = client.id;
        persist();
        render();
        [...tabs.children].find(tab => tab.getAttribute('aria-current') === 'true')?.focus();
      });
      tabs.appendChild(button);
    }
    const client = selected();
    if (client) loadFrame(client);
    for (const [id, entry] of frames) entry.frame.hidden = id !== state.selectedId;
    updateToolbar();
  }

  function showForm(client = null) {
    editingId = client?.id || null;
    formReturnFocus = document.activeElement;
    el('client-dialog-title').textContent = client ? '编辑 Client' : '添加 Client';
    el('client-name').value = client?.name || '';
    el('client-url').value = client?.address || '';
    el('client-form-error').textContent = '';
    el('frame-origin-example').textContent = `CLIENT_FRAME_ORIGINS=${location.origin}`;
    el('client-dialog').showModal();
    el('client-name').focus();
  }

  el('add-client').addEventListener('click', () => showForm());
  el('empty-add-client').addEventListener('click', () => showForm());
  el('client-edit').addEventListener('click', () => showForm(selected()));
  el('client-cancel').addEventListener('click', () => el('client-dialog').close());
  el('client-dialog').addEventListener('close', () => {
    if (formReturnFocus?.isConnected) formReturnFocus.focus();
    else el('add-client').focus();
  });
  el('client-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const name = el('client-name').value.trim();
      if (!name || name.length > 80) throw new Error('请填写 1–80 个字符的名称');
      const address = normalizeAddress(el('client-url').value, location.protocol);
      if (state.clients.some(client => client.id !== editingId && client.address === address)) {
        throw new Error('这个 Client 地址已经添加');
      }
      let client = state.clients.find(client => client.id === editingId);
      if (client) {
        if (client.address !== address) disposeFrame(client.id);
        client.name = name;
        client.address = address;
        const entry = frames.get(client.id);
        if (entry) entry.frame.title = name;
      } else {
        if (state.clients.length >= 100) throw new Error('最多可保存 100 个 Client');
        client = { id: window.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`, name, address };
        state.clients.push(client);
      }
      state.selectedId = client.id;
      persist();
      el('client-dialog').close();
      render();
    } catch (error) { el('client-form-error').textContent = error.message; }
  });

  el('client-remove').addEventListener('click', () => {
    const client = selected();
    if (!client || !confirm(`移除“${client.name}”？页面连接会关闭，服务端正在运行的终端程序会保留。`)) return;
    const index = state.clients.indexOf(client);
    disposeFrame(client.id);
    state.clients.splice(index, 1);
    state.selectedId = state.clients[Math.min(index, state.clients.length - 1)]?.id || null;
    persist();
    render();
  });

  el('client-reload').addEventListener('click', () => {
    const client = selected();
    if (!client) return;
    disposeFrame(client.id);
    render();
  });

  window.addEventListener('message', event => {
    if (event.data?.type !== 't-agent:client-frame' || !['ready', 'auth-required'].includes(event.data.status)) return;
    for (const client of state.clients) {
      const entry = frames.get(client.id);
      if (!entry || event.origin !== client.address || event.source !== entry.frame.contentWindow) continue;
      clearTimeout(entry.timer);
      entry.status = event.data.status;
      updateToolbar();
      break;
    }
  });

  persist();
  render();
})();
