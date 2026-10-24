(() => {
  // The login page may live at /auth or under a hidden login entrance; API and page share the same prefix.
  const base = location.pathname.replace(/\/+$/, '').replace(/\/setup$/, '').replace(/^\/auth\/login$/, '/auth');
  const isSetupPage = /\/setup\/?$/.test(location.pathname);
  const content = document.getElementById('auth-content');
  const title = document.getElementById('auth-title');
  const description = document.getElementById('auth-description');
  const errorNode = document.getElementById('auth-error');
  const requested = new URLSearchParams(location.search).get('return_to');
  const returnTo = ['/', '/web', '/h5'].includes(requested) ? requested : '/'; // "/" picks the phone or desktop page
  const messages = {
    AUTH_CODE_INVALID: 'The code is invalid or already used. Wait for the next code, or use an unused recovery code.',
    AUTHENTICATOR_BINDING_REQUIRED: 'You must bind an authenticator before using this.',
    AUTH_RATE_LIMITED: 'Too many attempts. Try again in 15 minutes.',
    SESSION_SECRET_TOO_WEAK: 'Insecure configuration: set SESSION_SECRET to a random key of at least 32 characters and restart the service.',
    AUTH_SETUP_EXPIRED: 'The binding info has expired. Refresh the page to generate it again.',
    AUTH_SETUP_CHANGED: 'The binding state changed. Refresh the page and verify again.',
    AUTH_REQUIRED: 'Log in with your current authenticator first.',
    LOCAL_ACCESS_REQUIRED: '“Local access only” can only be chosen on the server itself: open http://127.0.0.1:PORT/ in a browser on that machine, then choose it.',
    AUTH_RECENT_VERIFICATION_REQUIRED: 'Before replacing the authenticator, verify with the current code or a recovery code.',
  };

  async function request(url, body) {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AUTH_OPERATION_FAILED');
    return data;
  }
  async function run(form, action) {
    const buttons = form.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    errorNode.hidden = true;
    try { await action(); }
    catch (error) { errorNode.textContent = messages[error.message] || 'Connection failed. Check your network and retry.'; errorNode.hidden = false; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }

  function showLogin(reauthenticate = false) {
    title.textContent = reauthenticate ? 'Verify, then replace the authenticator' : 'Log in with your authenticator';
    description.textContent = 'Enter the 6-digit code for T-Agent from your authenticator, or an unused recovery code.';
    content.innerHTML = `<form id="login-form"><label for="login-code" id="login-code-label">6-digit code</label><input id="login-code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" autocapitalize="none" spellcheck="false" required autofocus><button type="submit">Verify and continue</button><button type="button" class="secondary" id="toggle-recovery">Use recovery code</button></form>`;
    const form = document.getElementById('login-form');
    let recoveryMode = false;
    document.getElementById('toggle-recovery').addEventListener('click', event => {
      recoveryMode = !recoveryMode;
      const input = document.getElementById('login-code');
      input.value = '';
      input.maxLength = recoveryMode ? 17 : 6;
      input.setAttribute('inputmode', recoveryMode ? 'text' : 'numeric');
      input.setAttribute('autocomplete', recoveryMode ? 'off' : 'one-time-code');
      document.getElementById('login-code-label').textContent = recoveryMode ? 'One-time recovery code' : '6-digit code';
      event.target.textContent = recoveryMode ? 'Use authenticator code' : 'Use recovery code';
      input.focus();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(form, async () => {
        const data = await request(base + '/login', { code: document.getElementById('login-code').value.trim(), return_to: returnTo });
        if (reauthenticate) await startSetup();
        else location.replace(data.redirect);
      });
    });
  }

  function showRecovery(data) {
    title.textContent = 'Bound. Please save your recovery codes';
    description.textContent = 'Recovery codes are shown only once and each can be used once. If you lose your authenticator, use a recovery code to log in and bind again.';
    content.innerHTML = `<label for="recovery-codes">One-time recovery code</label><textarea id="recovery-codes" class="recovery-codes" readonly></textarea><button type="button" class="secondary" id="download-codes">Download recovery codes</button><label class="saved-check"><input type="checkbox" id="saved-codes">I have saved the recovery codes somewhere safe</label><button id="continue" type="button" disabled>Open workspace</button>`;
    document.getElementById('recovery-codes').value = data.recovery_codes.join('\n');
    document.getElementById('download-codes').addEventListener('click', () => {
      const blob = new Blob([`${typeof I18n !== 'undefined' ? I18n.t('T-Agent one-time recovery codes\nKeep them safe; each code can be used only once.') : 'T-Agent one-time recovery codes\nKeep them safe; each code can be used only once.'}\n\n${data.recovery_codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 't-agent-recovery-codes.txt';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    document.getElementById('saved-codes').addEventListener('change', event => { document.getElementById('continue').disabled = !event.target.checked; });
    document.getElementById('continue').addEventListener('click', () => location.replace(data.redirect));
  }

  async function startSetup() {
    let data;
    try { data = await request(base + '/setup/start', {}); }
    catch (error) {
      if (error.message === 'AUTH_RECENT_VERIFICATION_REQUIRED') { showLogin(true); return; }
      throw error;
    }
    title.textContent = data.replacing ? 'Bind a new authenticator' : 'Bind an authenticator';
    description.textContent = 'Scan the QR code with Google Authenticator, Microsoft Authenticator or another authenticator. On the same phone, tap to open your authenticator or enter the key below manually.';
    content.innerHTML = `<img id="binding-qr" class="qr" alt="Authenticator binding QR code"><a id="open-authenticator" class="auth-link">Open in authenticator</a><label>Add key manually (time-based)</label><code id="binding-secret" class="secret"></code><p class="hint">Account: T-Agent; 6 digits, refreshed every 30 seconds. The binding info is valid for 10 minutes.</p><form id="binding-form"><label for="binding-code">6-digit code from your authenticator</label><input id="binding-code" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required><button type="submit">Verify and finish binding</button></form>`;
    document.getElementById('binding-qr').src = data.qr;
    document.getElementById('binding-secret').textContent = data.secret;
    document.getElementById('open-authenticator').href = data.uri;
    const form = document.getElementById('binding-form');
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(form, async () => showRecovery(await request(base + '/setup/confirm', { code: document.getElementById('binding-code').value.trim(), return_to: returnTo })));
    });
  }

  // First open after a fresh install: choose the access mode.
  function showModeChoice() {
    title.textContent = 'Choose an access mode';
    description.textContent = 'Installation is done. Choose how to access T-Agent; you can change it any time under Settings → Access mode.';
    content.innerHTML = `<div class="mode-options">
      <button type="button" class="mode-option" id="mode-remote"><strong>Authenticator + allow external access</strong><span>Log in with authenticator codes; phones, other computers and remote clients can connect. Requires binding an authenticator first.</span></button>
      <button type="button" class="mode-option" id="mode-local"><strong>Local access only · no verification</strong><span>Only accepts access from this machine (127.0.0.1) with no code; other devices and remote clients cannot connect.</span></button>
    </div>`;
    const choose = mode => run(content, async () => {
      const data = await request(base + '/mode', { mode });
      if (mode === 'remote') await startSetup();
      else location.replace(data.redirect || '/');
    });
    document.getElementById('mode-remote').addEventListener('click', () => choose('remote'));
    document.getElementById('mode-local').addEventListener('click', () => choose('local'));
  }

  async function init() {
    try {
      const status = await request(base + '/status');
      if (status.mode === 'unset') showModeChoice();
      else if (!status.bound) {
        title.textContent = 'An authenticator is required';
        description.textContent = 'Scan the QR code below with your authenticator to bind it for the first time, or run node scripts/client-auth-setup.js in a terminal on the Client server. Works locally or remotely; no initial password or setup code is needed.';
        content.innerHTML = '';
        await startSetup();
      } else if (isSetupPage && status.authenticated) {
        title.textContent = 'Replace authenticator';
        description.textContent = 'Once the new binding completes, the old authenticator and all old recovery codes stop working, and other devices must log in again.';
        content.innerHTML = '<button type="button" id="replace-authenticator">Start binding a new authenticator</button><a id="cancel-setup" class="auth-link">Back to workspace</a>';
        document.getElementById('cancel-setup').href = returnTo;
        document.getElementById('replace-authenticator').addEventListener('click', () => run(content, () => startSetup()));
      } else if (status.authenticated) location.replace(returnTo);
      else showLogin(isSetupPage);
    } catch (error) { errorNode.textContent = messages[error.message] || 'Could not check the binding status. Refresh and retry.'; errorNode.hidden = false; }
  }
  init();
})();
