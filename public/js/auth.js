(() => {
  const content = document.getElementById('auth-content');
  const title = document.getElementById('auth-title');
  const description = document.getElementById('auth-description');
  const errorNode = document.getElementById('auth-error');
  const requested = new URLSearchParams(location.search).get('return_to');
  const returnTo = ['/', '/web', '/h5'].includes(requested) ? requested : (/Android|iPhone|Mobile/i.test(navigator.userAgent) ? '/h5' : '/web');
  const messages = {
    AUTH_CODE_INVALID: '验证码无效或已使用，请等待下一组验证码；也可使用未使用过的恢复码。',
    AUTHENTICATOR_BINDING_REQUIRED: '必须先绑定身份验证器才能使用。',
    AUTH_INITIALIZATION_LOCAL_ONLY: '首次绑定只能在安装 Client 的电脑上操作，请通过本机 localhost 地址打开客户端。',
    AUTH_RATE_LIMITED: '验证尝试次数过多，请 15 分钟后再试。',
    SESSION_SECRET_TOO_WEAK: '服务配置不安全：请先将 SESSION_SECRET 设置为至少 32 个字符的随机密钥并重启服务。',
    AUTH_SETUP_EXPIRED: '绑定信息已过期，请刷新页面后重新生成。',
    AUTH_SETUP_CHANGED: '绑定状态已变化，请刷新页面重新验证。',
    AUTH_REQUIRED: '请先使用现有身份验证器登录。',
    AUTH_RECENT_VERIFICATION_REQUIRED: '更换身份验证器前，请重新验证当前验证码或恢复码。',
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
    catch (error) { errorNode.textContent = messages[error.message] || '连接失败，请检查网络后重试。'; errorNode.hidden = false; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }

  function showLogin(reauthenticate = false) {
    title.textContent = reauthenticate ? '验证后更换身份验证器' : '使用身份验证器登录';
    description.textContent = '输入身份验证器中 T-Agent 的 6 位动态验证码，或一组未使用的恢复码。';
    content.innerHTML = `<form id="login-form"><label for="login-code" id="login-code-label">6 位动态验证码</label><input id="login-code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" autocapitalize="none" spellcheck="false" required autofocus><button type="submit">验证并继续</button><button type="button" class="secondary" id="toggle-recovery">使用恢复码</button></form>`;
    const form = document.getElementById('login-form');
    let recoveryMode = false;
    document.getElementById('toggle-recovery').addEventListener('click', event => {
      recoveryMode = !recoveryMode;
      const input = document.getElementById('login-code');
      input.value = '';
      input.maxLength = recoveryMode ? 17 : 6;
      input.setAttribute('inputmode', recoveryMode ? 'text' : 'numeric');
      input.setAttribute('autocomplete', recoveryMode ? 'off' : 'one-time-code');
      document.getElementById('login-code-label').textContent = recoveryMode ? '一次性恢复码' : '6 位动态验证码';
      event.target.textContent = recoveryMode ? '使用动态验证码' : '使用恢复码';
      input.focus();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(form, async () => {
        const data = await request('/auth/login', { code: document.getElementById('login-code').value.trim(), return_to: returnTo });
        if (reauthenticate) await startSetup();
        else location.replace(data.redirect);
      });
    });
  }

  function showRecovery(data) {
    title.textContent = '绑定成功，请保存恢复码';
    description.textContent = '恢复码仅在这里显示一次，每组只能使用一次。丢失身份验证器时，可用恢复码登录并重新绑定。';
    content.innerHTML = `<label for="recovery-codes">一次性恢复码</label><textarea id="recovery-codes" class="recovery-codes" readonly></textarea><button type="button" class="secondary" id="download-codes">下载恢复码</button><label class="saved-check"><input type="checkbox" id="saved-codes">我已将恢复码保存在安全的位置</label><button id="continue" type="button" disabled>进入工作台</button>`;
    document.getElementById('recovery-codes').value = data.recovery_codes.join('\n');
    document.getElementById('download-codes').addEventListener('click', () => {
      const blob = new Blob([`T-Agent 一次性恢复码\n请妥善保管，每组只能使用一次。\n\n${data.recovery_codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
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
    try { data = await request('/auth/setup/start', {}); }
    catch (error) {
      if (error.message === 'AUTH_RECENT_VERIFICATION_REQUIRED') { showLogin(true); return; }
      throw error;
    }
    title.textContent = data.replacing ? '绑定新的身份验证器' : '绑定身份验证器';
    description.textContent = '用 Google Authenticator、Microsoft Authenticator 或其他身份验证器扫描二维码。在同一部手机操作时，可点击打开验证器，或手动输入下方密钥。';
    content.innerHTML = `<img id="binding-qr" class="qr" alt="身份验证器绑定二维码"><a id="open-authenticator" class="auth-link">在身份验证器中打开</a><label>手动添加密钥（基于时间）</label><code id="binding-secret" class="secret"></code><p class="hint">账号：T-Agent；6 位数字，每 30 秒更新。绑定信息 10 分钟有效。</p><form id="binding-form"><label for="binding-code">身份验证器中的 6 位验证码</label><input id="binding-code" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required><button type="submit">验证并完成绑定</button></form>`;
    document.getElementById('binding-qr').src = data.qr;
    document.getElementById('binding-secret').textContent = data.secret;
    document.getElementById('open-authenticator').href = data.uri;
    const form = document.getElementById('binding-form');
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(form, async () => showRecovery(await request('/auth/setup/confirm', { code: document.getElementById('binding-code').value.trim(), return_to: returnTo })));
    });
  }

  async function init() {
    try {
      const status = await request('/auth/status');
      if (!status.bound) {
        title.textContent = '必须绑定身份验证器';
        description.textContent = '首次绑定只能在安装 Client 的电脑上操作。请打开本机客户端（localhost 地址），用手机身份验证器扫码绑定；完成后手机 H5 和远程 Web 即可使用。无需初始密码或初始化码。';
        content.innerHTML = '';
        if (status.local_setup_allowed) await startSetup();
      } else if (location.pathname === '/auth/setup' && status.authenticated) {
        title.textContent = '更换身份验证器';
        description.textContent = '新绑定完成后，原身份验证器和所有旧恢复码立即失效，其他设备需要重新登录。';
        content.innerHTML = '<button type="button" id="replace-authenticator">开始绑定新验证器</button><a id="cancel-setup" class="auth-link">返回工作台</a>';
        document.getElementById('cancel-setup').href = returnTo;
        document.getElementById('replace-authenticator').addEventListener('click', () => run(content, () => startSetup()));
      } else if (status.authenticated) location.replace(returnTo);
      else showLogin(location.pathname === '/auth/setup');
    } catch (error) { errorNode.textContent = messages[error.message] || '无法检查绑定状态，请刷新页面重试。'; errorNode.hidden = false; }
  }
  init();
})();
