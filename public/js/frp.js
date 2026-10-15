// Tunnel: configure, start and stop this machine's frpc. All text is written with textContent.
const Frp = (() => {
  const $ = id => document.getElementById(id);
  const CODE_MESSAGES = {
    FRP_NOT_INSTALLED: 'frpc not found: install frp (0.52 or later) or set its path with T_AGENT_FRPC_BIN',
    FRP_SERVER_REQUIRED: 'Enter the frps server IP or domain first',
    FRP_SERVER_ADDR_INVALID: 'The server address must be an IP or domain', FRP_SERVER_PORT_INVALID: 'The server port must be an integer between 1 and 65535',
    FRP_DOMAIN_INVALID: 'Invalid domain format, e.g. app.example.com', FRP_LOCAL_PORT_INVALID: 'The local port must be an integer between 1 and 65535',
    FRP_TOKEN_INVALID: 'Token contains disallowed characters', FRP_PORT_RANGE_INVALID: 'Invalid random port range',
    FRP_ALREADY_RUNNING: 'The tunnel is already running', FRP_START_FAILED: 'Cannot start frpc', FRP_BODY_INVALID: 'Invalid request',
    FRP_REMOTE_PORT_INVALID: 'The remote port must be an integer between 1 and 65535', FRP_VERSION_UNSUPPORTED: 'frpc is too old; 0.52 or later is required', FRP_INSTALL_RUNNING: 'Installing frpc', FRP_ALREADY_INSTALLED: 'frpc is already installed',
    FRP_UNAVAILABLE: 'The tunnel service is temporarily unavailable',
  };
  const STATUS_LABELS = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', failed: 'failed' };
  let active = false, timer = null, busy = false, editing = false, last = null, remotePortEdited = false;

  const errorText = error => {
    let code = error.message;
    try { const parsed = JSON.parse(error.message); code = parsed.error || code; } catch { /* not JSON */ }
    return CODE_MESSAGES[code] || code;
  };
  const say = (text, bad) => { const node = $('frp-message'); node.textContent = text || ''; node.className = `tool-copy-status${bad ? ' ac-bad' : ''}`; };

  function renderStatus(data) {
    const line = $('frp-status-line');
    line.textContent = '';
    const badge = document.createElement('span');
    badge.className = `pm2-badge ${data.status === 'running' ? 'online' : data.status === 'failed' ? 'errored' : data.status === 'starting' ? 'launching' : ''}`;
    badge.textContent = STATUS_LABELS[data.status] || data.status;
    line.append(badge);
    const extra = [];
    if (!data.installed) extra.push(data.installing ? 'Installing frpc…' : 'frpc not detected');
    if (data.installError) extra.push(data.installError);
    if (data.error) extra.push(data.error);
    if (data.config.publicAddress) extra.push(`Public address ${data.config.publicAddress} (reverse proxy to ${data.config.serverAddr}:${data.config.remotePort})`);
    if (extra.length) line.append(document.createTextNode(extra.join(' · ')));
  }

  function renderFrpc(data) {
    const info = $('frp-frpc-info');
    if (!data.installed) { info.textContent = 'frpc not detected (searched PATH, Homebrew and the Client’s data/bin)'; return; }
    const frpc = data.frpc;
    const parts = [`frpc: ${frpc.path}`];
    if (frpc.version) parts.push(`Version ${frpc.version}`);
    if (!frpc.supported) parts.push('Version too old; 0.52 or later is required');
    if (frpc.error) parts.push(frpc.error);
    info.textContent = parts.join(' · ');
  }

  function renderRemoteHint(config) {
    $('frp-remote-port-label').textContent = config.remotePortManual ? 'Remote port (manual)' : 'Remote port (auto random)';
    $('frp-remote-hint').textContent = config.remotePortManual
      ? 'Set manually: if the port is taken it is not changed automatically, and it must be within frps allowPorts. Clear it and save to return to auto random.'
      : `Auto random (${config.portMin}-${config.portMax}); it stays stable once generated. You can also enter a fixed port.`;
  }

  function fillForm(config) {
    $('frp-domain').value = config.domain || '';
    $('frp-server-addr').value = config.serverAddr || '';
    $('frp-server-port').value = config.serverPort || 7000;
    $('frp-token').value = '';
    $('frp-token').placeholder = config.hasToken ? 'Saved (leave empty to keep)' : 'Leave empty if none';
    $('frp-local-port').value = config.localPort || '';
    $('frp-local-port').placeholder = `Default ${config.effectiveLocalPort} (this Client’s port)`;
    $('frp-remote-port').value = config.remotePort || '';
    remotePortEdited = false;
    renderRemoteHint(config);
    $('frp-auto-start').checked = Boolean(config.autoStart);
  }

  function render(data, { form = true } = {}) {
    last = data;
    renderStatus(data);
    renderFrpc(data);
    $('frp-install-row').hidden = data.installed;
    $('frp-install').disabled = Boolean(data.installing);
    $('frp-install').textContent = data.installing ? 'Installing…' : 'Install frpc';
    $('frp-start').textContent = data.status === 'running' || data.status === 'starting' ? 'Save and restart' : 'Save and start';
    if (form && !editing) fillForm(data.config);
    else if (!remotePortEdited) { $('frp-remote-port').value = data.config.remotePort || ''; renderRemoteHint(data.config); }
    const log = $('frp-log');
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.textContent = data.logs.length ? data.logs.join('\n') : '(No logs yet)';
    if (stick) log.scrollTop = log.scrollHeight;
  }

  async function refresh() {
    if (busy || !active) return;
    busy = true;
    try { render(await API.get('/api/frp')); } catch (error) { say(`Read failed: ${errorText(error)}`, true); } finally { busy = false; }
  }

  function formBody() {
    const body = {
      domain: $('frp-domain').value.trim(),
      serverAddr: $('frp-server-addr').value.trim(),
      serverPort: $('frp-server-port').value.trim(),
      localPort: $('frp-local-port').value.trim(),
      autoStart: $('frp-auto-start').checked,
    };
    const token = $('frp-token').value;
    if (token) body.token = token;
    // Only submit when this input was edited; otherwise every save would turn the auto-generated port into a "manual" one.
    if (remotePortEdited) body.remotePort = $('frp-remote-port').value.trim();
    return body;
  }

  const VERBS = { Save: { doing: 'Saving', done: 'Saved', failed: 'Save failed' }, Start: { doing: 'Starting', done: 'Started', failed: 'Start failed' } };

  async function run(action, label) {
    const verb = VERBS[label];
    busy = true;
    say(`${verb.doing}…`);
    try {
      const saved = await API.put('/api/frp/config', formBody());
      render(saved, { form: false });
      editing = false;
      if (action === 'start' && saved.status !== 'stopped') render(await API.post('/api/frp/stop', {}), { form: false });
      render(action ? await API.post(`/api/frp/${action}`, {}) : saved);
      say(verb.done);
    } catch (error) {
      say(`${verb.failed}: ${errorText(error)}`, true);
    } finally { busy = false; }
  }

  $('frp-form').addEventListener('submit', event => { event.preventDefault(); run(null, 'Save'); });
  $('frp-start').addEventListener('click', () => run('start', 'Start'));
  $('frp-form').addEventListener('input', () => { editing = true; });
  $('frp-remote-port').addEventListener('input', () => { remotePortEdited = true; });
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back to execCommand */ }
    const area = document.createElement('textarea');
    area.value = text; area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area); area.select();
    try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
  }

  async function directInstall() {
    busy = true;
    try { render(await API.post('/api/frp/install', {}), { form: false }); say('Installing frpc, please wait'); } catch (error) { say(`Install failed: ${errorText(error)}`, true); } finally { busy = false; }
  }

  $('frp-install').addEventListener('click', () => {
    const install = last && last.install;
    if (!install) return;
    Modal.show('Install frpc', '');
    const body = document.getElementById('modal-body');
    const question = document.createElement('div');
    question.className = 'update-message';
    question.textContent = 'Have an Agent install frpc for you? Choosing “Yes” copies an install prompt; paste it to an Agent (for example Claude Code / Codex in a local terminal).';
    const result = document.createElement('div');
    result.className = 'form-hint';
    result.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const make = (label, className, handler) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = className; button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    };
    actions.append(
      make('Cancel', 'btn-cancel', Modal.hide),
      make('No, let the Client download it', 'btn-cancel', () => { Modal.hide(); directInstall(); }),
      make('Yes, copy the Agent prompt', 'btn-submit', async () => {
        const ok = await copyText(FrpPrompts.frpc(install));
        result.textContent = ok ? 'Copied. Paste it to an Agent; when it is done, return to this page and wait for frpc to be detected.' : 'Copy failed. Check the browser clipboard permission';
      }),
    );
    body.append(question, result, actions);
  });

  $('frp-copy-frps').addEventListener('click', async () => {
    const install = last && last.install;
    const config = last && last.config;
    const status = $('frp-frps-message');
    if (!install || !config) return;
    const portText = $('frp-server-port').value.trim();
    const serverPort = /^\d{1,5}$/.test(portText) && Number(portText) <= 65535 && Number(portText) > 0 ? Number(portText) : config.serverPort;
    const remoteText = $('frp-remote-port').value.trim();
    const remotePort = /^\d{1,5}$/.test(remoteText) ? Number(remoteText) : config.remotePort;
    const ok = await copyText(FrpPrompts.frps({
      version: install.version, serverPort, token: $('frp-token').value, portMin: config.portMin, portMax: config.portMax, remotePort,
    }));
    status.textContent = ok ? 'Copied' : 'Copy failed. Check the browser clipboard permission';
    setTimeout(() => { status.textContent = ''; }, 2500);
  });
  $('frp-detect').addEventListener('click', async () => {
    busy = true;
    say('Detecting…');
    try {
      const data = await API.post('/api/frp/detect', {});
      render(data, { form: false });
      say(data.installed ? 'frpc detected' : 'frpc still not detected', !data.installed);
    } catch (error) { say(`Detection failed: ${errorText(error)}`, true); } finally { busy = false; }
  });
  $('frp-stop').addEventListener('click', async () => {
    busy = true;
    try { render(await API.post('/api/frp/stop', {}), { form: false }); say('Stopped'); } catch (error) { say(`Stop failed: ${errorText(error)}`, true); } finally { busy = false; }
  });
  $('frp-regenerate').addEventListener('click', async () => {
    const running = last && last.status !== 'stopped';
    if (running && !confirm('Regenerating the remote port restarts the tunnel, and your reverse proxy target must be updated to match. Continue?')) return;
    busy = true;
    remotePortEdited = false;
    try { render(await API.post('/api/frp/regenerate-port', {}), { form: false }); say('New remote port generated'); } catch (error) { say(`Operation failed: ${errorText(error)}`, true); } finally { busy = false; }
  });

  // Tunnel method: frp or SSH. The two have independent configuration and processes; the choice only decides which one is shown and polled.
  const METHOD_KEY = 'tAgentTunnelMethod';
  let method = 'frp';
  try { method = localStorage.getItem(METHOD_KEY) === 'ssh' ? 'ssh' : 'frp'; } catch { /* the browser does not allow storage */ }

  function restartPolling() {
    clearInterval(timer);
    timer = null;
    if (typeof SshTunnel !== 'undefined') SshTunnel.setActive(active && method === 'ssh');
    if (!active || method !== 'frp') return;
    editing = false;
    say('');
    refresh();
    timer = setInterval(refresh, 3000);
  }

  function applyMethod() {
    $('frp-method-frp').hidden = method !== 'frp';
    $('frp-method-ssh').hidden = method !== 'ssh';
    for (const radio of document.querySelectorAll('input[name="frp-method"]')) radio.checked = radio.value === method;
    restartPolling();
  }

  for (const radio of document.querySelectorAll('input[name="frp-method"]')) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      method = radio.value;
      try { localStorage.setItem(METHOD_KEY, method); } catch { /* the browser does not allow storage */ }
      applyMethod();
    });
  }

  function setActive(value) {
    active = value;
    applyMethod();
  }
  return { setActive };
})();
