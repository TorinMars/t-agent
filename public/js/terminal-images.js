// Images are uploaded by this Client, regardless of the terminal's Engine.
const TerminalImages = (() => {
  const tell = (message, type) => (typeof notify === 'function' ? notify(message, type) : (typeof alert === 'function' ? alert(message) : undefined)); // floating notice; falls back to alert where toast.js is not loaded
  const instances = new Set();
  let enabled = false;
  let configRevision = 0;
  let busy = false;
  let uploadCard = null;
  const pane = document.getElementById('terminal-pane');
  const container = document.getElementById('xterm-container');
  const keys = document.getElementById('terminal-keys');
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'terminal-image-upload'; button.textContent = 'Upload image';
  const picker = document.createElement('input');
  picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/gif,image/webp'; picker.hidden = true;
  keys.append(button, picker);
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
  function render() { button.hidden = !active(); button.disabled = busy; }
  window.visualViewport?.addEventListener('resize', layoutUploadCard);
  window.visualViewport?.addEventListener('scroll', layoutUploadCard);
  async function load() {
    const revision = ++configRevision;
    let timer;
    try {
      const config = await Promise.race([
        API.get('/api/oss/config'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out reading OSS settings')), 15000); }),
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
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Uploading image');
    const card = document.createElement('div'); card.className = 'terminal-image-upload-card';
    const status = document.createElement('p'); status.className = 'terminal-image-upload-status'; status.setAttribute('role', 'status');
    status.textContent = 'Preparing the upload…';
    const progress = document.createElement('progress'); progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', 'Upload progress');
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
  // The image goes from this browser straight to OSS (oss-direct.js); the Client only signs the upload.
  const transfer = (file, ui) => OssDirect.upload(file, {
    status: text => { ui.status.textContent = text; },
    progress: value => { if (value === null) ui.progress.removeAttribute('value'); else ui.progress.value = value; },
  });
  function retain(url) {
    // A permanent, selectable result survives changing/disconnecting terminals.
    const result = document.createElement('div'); result.className = 'terminal-image-result';
    const label = document.createElement('label'); label.textContent = 'Image uploaded; the original terminal was switched or disconnected. Copy the link manually: ';
    const field = document.createElement('input'); field.readOnly = true; field.value = url; field.setAttribute('aria-label', 'Uploaded image link');
    field.addEventListener('click', () => field.select());
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.addEventListener('click', () => result.remove());
    label.append(field); result.append(label, close); document.body.append(result);
  }
  async function upload(item, file, socket = item?.connection()) {
    if (busy || !file || !item) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size <= 0 || file.size > 10 * 1024 * 1024) { tell('Choose a PNG, JPEG, GIF or WebP image up to 10 MiB', 'error'); return; }
    if (active() !== item || !socket || socket.readyState !== 1 || item.connection() !== socket) { tell('The original terminal is not connected. Reconnect and retry', 'error'); return; }
    const ui = lockPage();
    let result; let error;
    try {
      if (!enabled) {
        ui.status.textContent = 'Reading OSS settings…';
        try { await load(); }
        catch { throw new Error('Could not read OSS settings. Check the connection and retry'); }
        if (!enabled) throw new Error('Enable Alibaba Cloud OSS image upload in this client’s settings first');
        if (!instances.has(item) || active() !== item || item.connection() !== socket || socket.readyState !== 1) {
          throw new Error('The original terminal was switched or disconnected. Reconnect and retry');
        }
      }
      result = await transfer(file, ui);
    } catch (failure) { error = failure; } finally { ui.unlock(); }
    if (error) { tell(error.message, 'error'); return; }
    if (instances.has(item) && active() === item && item.connection() === socket && socket.readyState === 1) {
      // xterm's paste keeps bracketed-paste semantics and never adds Enter.
      // Add a space after the link so typing can continue right away; no Enter is sent.
      item.term.paste(`${result.url} `); item.term.focus();
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
      if (images.length !== 1) { tell('Upload one image at a time', 'error'); return; }
      void upload(item, images[0].getAsFile());
    };
    el.addEventListener('paste', paste, true); render();
    return { dispose() { instances.delete(item); el.removeEventListener('paste', paste, true); render(); } };
  }
  async function showSettings() {
    let config;
    try { config = await load(); } catch (error) { tell('Could not read OSS settings: ' + error.message, 'error'); return; }
    const fields = [['region', 'Region (e.g. oss-cn-hangzhou)'], ['bucket', 'Bucket'], ['accessKeyId', 'AccessKey ID'], ['accessKeySecret', 'AccessKey Secret'], ['prefix', 'Object path prefix'], ['publicBaseUrl', 'Public HTTPS address (optional)']];
    Modal.show('Alibaba Cloud OSS image upload', `<div class="form-group"><label><input id="oss-enabled" type="checkbox" ${config.enabled ? 'checked' : ''}> Enable image upload</label></div>${fields.map(([key, label]) => `<div class="form-group"><label class="form-label" for="oss-${key}">${label}</label><input class="form-input" id="oss-${key}" type="${key === 'accessKeySecret' ? 'password' : 'text'}" autocomplete="${key === 'accessKeySecret' ? 'new-password' : 'off'}" value="${key === 'accessKeySecret' ? '' : escapeHtml(config[key] || '')}"></div>`).join('')}<div class="form-hint">${config.hasAccessKeySecret ? 'Secret saved; leave empty to keep it.' : 'The secret is required for first-time setup.'} Private links valid for 24 hours are generated by default; the public address is only for buckets or domains that allow public reads. Images are limited to 10 MiB and are uploaded from your browser straight to OSS, so the bucket needs a CORS rule that allows POST from this page’s address.</div><p id="oss-feedback" role="status"></p><div class="form-actions"><button class="btn-cancel" id="oss-clear">Delete settings</button><button class="btn-cancel" id="oss-cancel">Cancel</button><button class="btn-submit" id="oss-save">Save</button></div>`);
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
          feedback.textContent = 'Settings saved, but image upload is not enabled. Tick “Enable image upload” above and save again.';
          save.disabled = clear.disabled = false;
          return;
        }
        Modal.hide();
      }
      catch (error) { feedback.textContent = 'Save failed: ' + error.message; save.disabled = clear.disabled = false; }
    }
    save.addEventListener('click', () => void persist(false)); clear.addEventListener('click', () => void persist(true));
  }
  const observer = new MutationObserver(render);
  observer.observe(container, { attributes: true, attributeFilter: ['style'], subtree: true, childList: true });
  observer.observe(pane, { attributes: true, attributeFilter: ['style'] }); render();
  return { attach, load, showSettings, get busy() { return busy; } };
})();
