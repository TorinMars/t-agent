// Phone page settings: the same configuration as the desktop "Settings" dialog (working directory, image upload, remote service,
// access mode and authenticator), as folding groups in the phone settings sheet. A group loads its data the first time it is opened.
// Everything the server sends is put in with textContent / value, never as markup.
(() => {
  const $ = id => document.getElementById(id);
  const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
  const OSS_FIELDS = ['region', 'bucket', 'accessKeyId', 'accessKeySecret', 'prefix', 'publicBaseUrl'];

  async function api(method, url, body) {
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* plain-text error */ }
    if (!res.ok) { const error = new Error((data && data.error) || text || `HTTP ${res.status}`); error.data = data; throw error; }
    return data;
  }
  const say = (id, message, isError = false) => {
    const node = $(id);
    node.hidden = !message;
    node.textContent = message ? tr(message) : '';
    node.style.color = isError ? '#ff7b72' : '';
  };
  const failure = error => `${tr('Failed')}: ${error.message}`;

  // ── Working directory ──
  let workDir = { saved: '', custom: null };
  async function loadWorkdir() {
    const user = await api('GET', '/auth/me');
    workDir = { saved: user.work_dir || user.effective_work_dir || '', custom: user.work_dir || null };
    $('h5-workdir').value = workDir.saved;
  }
  async function saveWorkdir() {
    const value = $('h5-workdir').value.trim();
    // An unchanged default path keeps inheriting the default; clearing the field restores it.
    const work_dir = value === workDir.saved ? workDir.custom : value || null;
    const button = $('h5-workdir-save');
    button.disabled = true;
    try { await api('PUT', '/auth/settings', { work_dir }); say('h5-workdir-feedback', 'Saved'); await loadWorkdir(); }
    catch (error) { say('h5-workdir-feedback', failure(error), true); }
    finally { button.disabled = false; }
  }

  // ── Image upload (Alibaba Cloud OSS) ──
  async function loadOss() {
    const config = await api('GET', '/api/oss/config');
    $('h5-oss-enabled').checked = Boolean(config.enabled);
    for (const key of OSS_FIELDS) $(`h5-oss-${key}`).value = key === 'accessKeySecret' ? '' : config[key] || '';
    $('h5-oss-secret-hint').textContent = tr(config.hasAccessKeySecret ? 'Secret saved; leave empty to keep it.' : 'The secret is required for first-time setup.');
  }
  async function persistOss(remove) {
    const save = $('h5-oss-save');
    const clear = $('h5-oss-clear');
    if (remove && !confirm(tr('Delete the image upload settings?'))) return;
    save.disabled = clear.disabled = true;
    const payload = { enabled: $('h5-oss-enabled').checked };
    for (const key of OSS_FIELDS) payload[key] = $(`h5-oss-${key}`).value.trim();
    try {
      const saved = remove ? await api('DELETE', '/api/oss/config') : await api('PUT', '/api/oss/config', payload);
      await loadOss();
      say('h5-oss-feedback', !remove && !saved.enabled ? 'Settings saved, but image upload is not enabled. Tick “Enable image upload” above and save again.' : remove ? 'Deleted' : 'Saved');
    } catch (error) { say('h5-oss-feedback', failure(error), true); }
    finally { save.disabled = clear.disabled = false; }
  }

  // ── Remote service: pairing codes and the tokens already issued ──
  async function loadRemote() {
    $('h5-remote-origin').textContent = location.origin;
    const tokens = await api('GET', '/api/remote-tokens');
    const list = $('h5-token-list');
    list.replaceChildren();
    if (!tokens.length) { const empty = document.createElement('p'); empty.className = 'h5-setting-hint'; empty.textContent = tr('No tokens created yet'); list.append(empty); return; }
    for (const token of tokens) {
      const row = document.createElement('div');
      row.className = 'h5-token-row';
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = token.name;
      const meta = document.createElement('small');
      meta.textContent = `${token.token_prefix}… · ${token.scopes}`;
      info.append(name, meta);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'h5-header-button';
      revoke.textContent = tr('Revoke');
      revoke.addEventListener('click', async () => {
        if (!confirm(tr('Once revoked, remote connections using it stop working immediately.'))) return;
        revoke.disabled = true;
        try { await api('DELETE', `/api/remote-tokens/${token.id}`); await loadRemote(); }
        catch (error) { say('h5-remote-feedback', failure(error), true); revoke.disabled = false; }
      });
      row.append(info, revoke);
      list.append(row);
    }
  }
  async function createPairing() {
    const button = $('h5-token-create');
    button.disabled = true;
    try {
      const created = await api('POST', '/api/remote-tokens/pairing', {});
      $('h5-token-code').textContent = created.code;
      $('h5-token-created').hidden = false;
      say('h5-remote-feedback', 'Pairing code created. Valid for 10 minutes, single use.');
    } catch (error) { say('h5-remote-feedback', failure(error), true); }
    finally { button.disabled = false; }
  }
  async function copyPairing() {
    const button = $('h5-token-copy');
    const code = $('h5-token-code').textContent;
    try { await navigator.clipboard.writeText(code); button.textContent = tr('Copied'); }
    catch {
      const range = document.createRange();
      range.selectNodeContents($('h5-token-code'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = tr('Press and hold to copy');
    }
  }

  // ── Access mode ──
  let access = { local: false };
  async function loadAccess() {
    const user = await api('GET', '/auth/me');
    const local = user.access_mode === 'local';
    const loopbackOnly = ['127.0.0.1', '::1', 'localhost'].includes(user.listen_host);
    access = { local };
    $('h5-access-title').textContent = tr(local ? 'Local access only' : 'Authenticator + allow external access');
    let hint = tr(local
      ? 'Only access from this machine is accepted, with no code; other devices and remote clients cannot reach this client.'
      : 'An authenticator login is required; phones, other computers and remote clients can connect.');
    if (!local && loopbackOnly) hint += ` ${tr('Note: the service currently listens only on')} ${user.listen_host}. ${tr('To let other devices connect, set HOST=0.0.0.0 in .env and restart the service.')}`;
    $('h5-access-hint').textContent = hint;
    $('h5-access-code-row').hidden = !(local && user.authenticator_bound);
    $('h5-access-switch').textContent = tr(local ? 'Switch to: authenticator + external access' : 'Switch to: local access only (no verification)');
  }
  async function switchAccess() {
    const button = $('h5-access-switch');
    if (!access.local && !confirm(tr('After switching to “local access only”, no code is needed, and phones, other computers and remote clients (including connections that use this Client as an engine) can no longer reach it.\n\nSessions on other devices end immediately. Switch?'))) return;
    button.disabled = true;
    say('h5-access-feedback', '');
    try {
      const body = access.local ? { mode: 'remote', code: $('h5-access-code').value.trim() } : { mode: 'local' };
      const result = await api('POST', '/auth/mode', body);
      // A phone is not the local machine: switching to local access only locks this page out too.
      if (result.locked_out) { say('h5-access-feedback', 'Switched to local access only. This device is not the local machine and can no longer connect; use the browser on the server itself.'); return; }
      location.replace('/h5');
    } catch (error) {
      const data = error.data || {};
      if (data.error === 'AUTHENTICATOR_BINDING_REQUIRED') { location.href = (data.redirect || '/auth/setup?return_to=/web').replace('return_to=/web', 'return_to=/h5'); return; }
      const known = { AUTH_CODE_INVALID: 'The code is invalid or already used. Wait for the next code.', AUTH_RATE_LIMITED: 'Too many attempts. Try again in 15 minutes.' }[data.error];
      say('h5-access-feedback', known || `${tr('Switch failed')}: ${error.message}`, true);
    } finally { button.disabled = false; }
  }

  const loaders = { workdir: loadWorkdir, oss: loadOss, remote: loadRemote, access: loadAccess };
  const FEEDBACK = { workdir: 'h5-workdir-feedback', oss: 'h5-oss-feedback', remote: 'h5-remote-feedback', access: 'h5-access-feedback' };
  document.querySelectorAll('.h5-setting-group').forEach(group => {
    group.addEventListener('toggle', async () => {
      if (!group.open) return;
      const key = group.dataset.load;
      try { await loaders[key](); say(FEEDBACK[key], ''); }
      catch (error) { say(FEEDBACK[key], failure(error), true); }
    });
  });
  $('h5-workdir-save').addEventListener('click', () => void saveWorkdir());
  $('h5-oss-save').addEventListener('click', () => void persistOss(false));
  $('h5-oss-clear').addEventListener('click', () => void persistOss(true));
  $('h5-token-create').addEventListener('click', () => void createPairing());
  $('h5-token-copy').addEventListener('click', () => void copyPairing());
  $('h5-access-switch').addEventListener('click', () => void switchAccess());
})();
