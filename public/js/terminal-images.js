// Images are uploaded by this Client, regardless of the terminal's Engine.
const TerminalImages = (() => {
  const instances = new Set();
  let enabled = false;
  let configRevision = 0;
  let busy = false;
  let uploadCard = null;
  const pane = document.getElementById('terminal-pane');
  const container = document.getElementById('xterm-container');
  const bar = document.createElement('div');
  bar.className = 'terminal-image-actions';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'terminal-toolbar-btn'; button.textContent = '上传图片';
  const picker = document.createElement('input');
  picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/gif,image/webp'; picker.hidden = true;
  bar.append(button, picker); pane.append(bar);
  function active() {
    if (pane.style.display === 'none' || container.style.display === 'none') return null;
    return [...instances].find(item => item.el.isConnected && item.el.style.display !== 'none') || null;
  }
  function layoutUploadCard() {
    const view = window.visualViewport;
    if (!uploadCard || !view) return;
    const scale = view.scale || 1;
    uploadCard.style.cssText = `position:absolute;left:${view.offsetLeft + view.width / 2}px;top:${view.offsetTop + view.height / 2}px;width:${Math.min(380, view.width * scale * .85)}px;transform:translate(-50%,-50%) scale(${1 / scale})`;
  }
  function render() { bar.hidden = !active(); button.disabled = busy; }
  window.visualViewport?.addEventListener('resize', layoutUploadCard);
  window.visualViewport?.addEventListener('scroll', layoutUploadCard);
  async function load() {
    const revision = ++configRevision;
    let timer;
    try {
      const config = await Promise.race([
        API.get('/api/oss/config'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取 OSS 设置超时')), 15000); }),
      ]);
      if (revision === configRevision) { enabled = Boolean(config.enabled); render(); }
      return config;
    } finally { clearTimeout(timer); }
  }
  // Installed app windows can stay alive while another window changes settings.
  const refreshConfig = () => { if (!busy) void load().catch(() => {}); };
  window.addEventListener('focus', refreshConfig);
  window.addEventListener('pageshow', refreshConfig);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshConfig();
  });
  function lockPage() {
    busy = true; render();
    const previous = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'terminal-image-upload-overlay'; overlay.tabIndex = -1;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', '正在上传图片');
    const card = document.createElement('div'); card.className = 'terminal-image-upload-card';
    const status = document.createElement('p'); status.className = 'terminal-image-upload-status'; status.setAttribute('role', 'status');
    status.textContent = '正在传送图片到 Client…';
    const progress = document.createElement('progress'); progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', '浏览器传送进度');
    card.append(status, progress); overlay.append(card);
    const inert = [...document.body.children].map(el => [el, el.inert]);
    for (const [el] of inert) el.inert = true;
    const stdin = [...instances].map(item => [item.term, item.term.options.disableStdin]);
    for (const [term] of stdin) term.options.disableStdin = true;
    document.body.append(overlay);
    uploadCard = card; layoutUploadCard();
    const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const focus = event => { if (!overlay.contains(event.target)) { event.stopImmediatePropagation(); overlay.focus({ preventScroll: true }); } };
    const events = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut', 'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchmove', 'wheel', 'dragstart', 'drop'];
    for (const name of events) window.addEventListener(name, block, { capture: true, passive: false });
    window.addEventListener('focusin', focus, true);
    overlay.focus({ preventScroll: true });
    return { progress, status, unlock() {
      for (const name of events) window.removeEventListener(name, block, true);
      window.removeEventListener('focusin', focus, true);
      for (const [el, value] of inert) el.inert = value;
      for (const [term, value] of stdin) term.options.disableStdin = value;
      overlay.remove(); uploadCard = null; busy = false; render();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    } };
  }
  function transfer(file, ui) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/oss/images'); xhr.timeout = 120000;
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) {
          ui.progress.value = Math.min(100, Math.round(event.loaded / event.total * 100));
          ui.status.textContent = `正在传送图片到 Client：${ui.progress.value}%`;
        } else ui.progress.removeAttribute('value');
      };
      xhr.upload.onload = () => { ui.progress.removeAttribute('value'); ui.status.textContent = 'Client 已接收图片，正在上传到 OSS…'; };
      xhr.onload = () => {
        let result;
        try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('上传失败：服务器返回无效响应')); return; }
        if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(result.error || '图片上传失败')); return; }
        try {
          const url = new URL(result.url);
          if (url.protocol !== 'https:' || /[\s\x00-\x1f\x7f]/.test(result.url)) throw new Error();
          resolve(result);
        } catch { reject(new Error('上传失败：服务器返回无效图片链接')); }
      };
      xhr.onerror = () => reject(new Error('图片上传失败，请检查网络后重试'));
      xhr.ontimeout = () => reject(new Error('图片上传超时，请重试'));
      xhr.onabort = () => reject(new Error('图片上传已取消'));
      xhr.send(file);
    });
  }
  function retain(url) {
    // A permanent, selectable result survives changing/disconnecting terminals.
    const result = document.createElement('div'); result.className = 'terminal-image-result';
    const label = document.createElement('label'); label.textContent = '图片已上传；原终端已切换或断开，请手动复制链接：';
    const field = document.createElement('input'); field.readOnly = true; field.value = url; field.setAttribute('aria-label', '已上传图片链接');
    field.addEventListener('click', () => field.select());
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.addEventListener('click', () => result.remove());
    label.append(field); result.append(label, close); document.body.append(result);
  }
  async function upload(item, file, socket = item?.connection()) {
    if (busy || !file || !item) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size <= 0 || file.size > 10 * 1024 * 1024) { alert('请选择不超过 10 MiB 的 PNG、JPEG、GIF 或 WebP 图片'); return; }
    if (active() !== item || !socket || socket.readyState !== 1 || item.connection() !== socket) { alert('原终端未连接，请连接后重试'); return; }
    const ui = lockPage();
    let result; let error;
    try {
      if (!enabled) {
        ui.status.textContent = '正在读取 OSS 配置…';
        try { await load(); }
        catch { throw new Error('读取 OSS 设置失败，请检查连接后重试'); }
        if (!enabled) throw new Error('请先在当前客户端的设置中启用阿里云 OSS 图片上传');
        if (!instances.has(item) || active() !== item || item.connection() !== socket || socket.readyState !== 1) {
          throw new Error('原终端已切换或断开，请连接后重试');
        }
      }
      result = await transfer(file, ui);
    } catch (failure) { error = failure; } finally { ui.unlock(); }
    if (error) { alert(error.message); return; }
    if (instances.has(item) && active() === item && item.connection() === socket && socket.readyState === 1) {
      // xterm's paste keeps bracketed-paste semantics and never adds Enter.
      item.term.paste(result.url); item.term.focus();
    } else retain(result.url);
  }
  let picked = null;
  button.addEventListener('click', () => { const item = active(); if (!item || busy) return; picked = { item, socket: item.connection() }; picker.value = ''; picker.click(); });
  picker.addEventListener('change', () => { const target = picked; picked = null; if (target) void upload(target.item, picker.files[0], target.socket); picker.value = ''; });
  function attach(term, el, connection) {
    const item = { term, el, connection }; instances.add(item);
    const paste = event => {
      if (active() !== item) return;
      const images = [...(event.clipboardData?.items || [])].filter(entry => entry.kind === 'file' && entry.type.startsWith('image/'));
      if (!images.length) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (images.length !== 1) { alert('请一次上传一张图片'); return; }
      void upload(item, images[0].getAsFile());
    };
    el.addEventListener('paste', paste, true); render();
    return { dispose() { instances.delete(item); el.removeEventListener('paste', paste, true); render(); } };
  }
  async function showSettings() {
    let config;
    try { config = await load(); } catch (error) { alert('读取 OSS 设置失败：' + error.message); return; }
    const fields = [['region', '地域（例如 oss-cn-hangzhou）'], ['bucket', 'Bucket'], ['accessKeyId', 'AccessKey ID'], ['accessKeySecret', 'AccessKey Secret'], ['prefix', '对象路径前缀'], ['publicBaseUrl', '公开 HTTPS 地址（可选）']];
    Modal.show('阿里云 OSS 图片上传', `<div class="form-group"><label><input id="oss-enabled" type="checkbox" ${config.enabled ? 'checked' : ''}> 启用图片上传</label></div>${fields.map(([key, label]) => `<div class="form-group"><label class="form-label" for="oss-${key}">${label}</label><input class="form-input" id="oss-${key}" type="${key === 'accessKeySecret' ? 'password' : 'text'}" autocomplete="${key === 'accessKeySecret' ? 'new-password' : 'off'}" value="${key === 'accessKeySecret' ? '' : escapeHtml(config[key] || '')}"></div>`).join('')}<div class="form-hint">${config.hasAccessKeySecret ? '已保存密钥；留空保持原密钥。' : '首次配置需填写密钥。'}默认生成 24 小时有效的私有链接；公开地址仅用于已允许公开读取的 Bucket 或域名。图片最大 10 MiB。</div><p id="oss-feedback" role="status"></p><div class="form-actions"><button class="btn-cancel" id="oss-clear">删除配置</button><button class="btn-cancel" id="oss-cancel">取消</button><button class="btn-submit" id="oss-save">保存</button></div>`);
    document.getElementById('oss-cancel').addEventListener('click', Modal.hide);
    const save = document.getElementById('oss-save'); const clear = document.getElementById('oss-clear'); const feedback = document.getElementById('oss-feedback');
    async function persist(remove) {
      save.disabled = clear.disabled = true;
      configRevision++;
      const payload = { enabled: document.getElementById('oss-enabled').checked };
      for (const [key] of fields) payload[key] = document.getElementById('oss-' + key).value.trim();
      try {
        const saved = remove ? await API.delete('/api/oss/config') : await API.put('/api/oss/config', payload);
        configRevision++; enabled = Boolean(saved.enabled); render();
        if (!remove && !enabled) {
          feedback.textContent = '配置已保存，但图片上传尚未启用。请勾选上方“启用图片上传”后再次保存。';
          save.disabled = clear.disabled = false;
          return;
        }
        Modal.hide();
      }
      catch (error) { feedback.textContent = '保存失败：' + error.message; save.disabled = clear.disabled = false; }
    }
    save.addEventListener('click', () => void persist(false)); clear.addEventListener('click', () => void persist(true));
  }
  const observer = new MutationObserver(render);
  observer.observe(container, { attributes: true, attributeFilter: ['style'], subtree: true, childList: true });
  observer.observe(pane, { attributes: true, attributeFilter: ['style'] }); render();
  return { attach, load, showSettings, get busy() { return busy; } };
})();
