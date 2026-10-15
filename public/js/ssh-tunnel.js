// SSH reverse tunnel: configure, start and stop this machine's ssh -R process. All text is written with textContent.
const SshTunnel = (() => {
  const $ = id => document.getElementById(id);
  const CODE_MESSAGES = {
    SSH_NOT_INSTALLED: 'ssh command not found. Please install the OpenSSH client',
    SSH_HOST_REQUIRED: 'Enter the server IP or domain first', SSH_USER_REQUIRED: 'Enter a username first',
    SSH_HOST_INVALID: 'The server address must be an IP or domain', SSH_USER_INVALID: 'Invalid username format',
    SSH_PORT_INVALID: 'The SSH port must be an integer between 1 and 65535', SSH_REMOTE_PORT_INVALID: 'The remote port must be an integer between 1 and 65535',
    SSH_KEY_INVALID: 'The private key path must be absolute or start with ~/', SSH_KEY_NOT_FOUND: 'Private key file not found. Check the path; leave empty to use ssh defaults',
    SSH_ALREADY_RUNNING: 'The tunnel is already running', SSH_START_FAILED: 'Cannot start ssh', SSH_BODY_INVALID: 'Invalid request',
    SSH_UNAVAILABLE: 'The SSH tunnel service is temporarily unavailable',
  };
  const STATUS_LABELS = { stopped: 'Stopped', starting: 'Connecting…', running: 'Running', failed: 'failed' };
  let active = false, timer = null, busy = false, editing = false, last = null, remotePortEdited = false;

  const errorText = error => {
    let code = error.message;
    try { const parsed = JSON.parse(error.message); code = parsed.error || code; } catch { /* not JSON */ }
    return CODE_MESSAGES[code] || code;
  };
  const say = (text, bad) => { const node = $('ssh-message'); node.textContent = text || ''; node.className = `tool-copy-status${bad ? ' ac-bad' : ''}`; };

  function renderStatus(data) {
    const line = $('ssh-status-line');
    line.textContent = '';
    const badge = document.createElement('span');
    badge.className = `pm2-badge ${data.status === 'running' ? 'online' : data.status === 'failed' ? 'errored' : data.status === 'starting' ? 'launching' : ''}`;
    badge.textContent = STATUS_LABELS[data.status] || data.status;
    line.append(badge);
    const extra = [];
    if (!data.installed) extra.push('ssh command not detected');
    if (data.error) extra.push(data.error);
    if (data.config.serverAddress) extra.push(`Listening on the server at ${data.config.serverAddress}, forwarding to this machine at ${data.config.effectiveLocalPort}`);
    if (extra.length) line.append(document.createTextNode(extra.join(' · ')));
  }

  function renderRemoteHint(config) {
    $('ssh-remote-port-label').textContent = config.remotePortManual ? 'Remote port (manual)' : 'Remote port (auto random)';
    $('ssh-remote-hint').textContent = config.remotePortManual
      ? 'Set manually: if the port is taken it is not changed automatically. Clear it and save to return to auto random.'
      : 'Auto random (20000-60000); stays stable once generated. You can also enter a fixed port.';
  }

  function fillForm(config) {
    $('ssh-host').value = config.host || '';
    $('ssh-user').value = config.username || '';
    $('ssh-key').value = config.keyPath || '';
    $('ssh-port').value = config.sshPort || 22;
    $('ssh-remote-port').value = config.remotePort || '';
    remotePortEdited = false;
    renderRemoteHint(config);
    $('ssh-bind-all').checked = Boolean(config.bindAll);
    $('ssh-auto-start').checked = Boolean(config.autoStart);
  }

  function render(data, { form = true } = {}) {
    last = data;
    renderStatus(data);
    $('ssh-start').textContent = data.status === 'running' || data.status === 'starting' ? 'Save and restart' : 'Save and start';
    if (form && !editing) fillForm(data.config);
    else if (!remotePortEdited) { $('ssh-remote-port').value = data.config.remotePort || ''; renderRemoteHint(data.config); }
    const log = $('ssh-log');
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.textContent = data.logs.length ? data.logs.join('\n') : '(No logs yet)';
    if (stick) log.scrollTop = log.scrollHeight;
  }

  async function refresh() {
    if (busy || !active) return;
    busy = true;
    try { render(await API.get('/api/ssh-tunnel')); } catch (error) { say(`Read failed: ${errorText(error)}`, true); } finally { busy = false; }
  }

  function formBody() {
    const body = {
      host: $('ssh-host').value.trim(),
      username: $('ssh-user').value.trim(),
      // Always submit the private key path: clearing it restores ssh's default lookup.
      keyPath: $('ssh-key').value.trim(),
      sshPort: $('ssh-port').value.trim(),
      bindAll: $('ssh-bind-all').checked,
      autoStart: $('ssh-auto-start').checked,
    };
    // Only submit when this input was edited; otherwise every save would turn the auto-generated port into a "manual" one.
    if (remotePortEdited) body.remotePort = $('ssh-remote-port').value.trim();
    return body;
  }

  const VERBS = { Save: { doing: 'Saving', done: 'Saved', failed: 'Save failed' }, Start: { doing: 'Starting', done: 'Started', failed: 'Start failed' } };

  async function run(action, label) {
    const verb = VERBS[label];
    busy = true;
    say(`${verb.doing}…`);
    try {
      const saved = await API.put('/api/ssh-tunnel/config', formBody());
      render(saved, { form: false });
      editing = false;
      if (action === 'start' && saved.status !== 'stopped') render(await API.post('/api/ssh-tunnel/stop', {}), { form: false });
      render(action ? await API.post(`/api/ssh-tunnel/${action}`, {}) : saved);
      say(verb.done);
    } catch (error) {
      say(`${verb.failed}: ${errorText(error)}`, true);
    } finally { busy = false; }
  }

  $('ssh-form').addEventListener('submit', event => { event.preventDefault(); run(null, 'Save'); });
  $('ssh-start').addEventListener('click', () => run('start', 'Start'));
  $('ssh-form').addEventListener('input', () => { editing = true; });
  $('ssh-remote-port').addEventListener('input', () => { remotePortEdited = true; });
  $('ssh-stop').addEventListener('click', async () => {
    busy = true;
    try { render(await API.post('/api/ssh-tunnel/stop', {}), { form: false }); say('Stopped'); } catch (error) { say(`Stop failed: ${errorText(error)}`, true); } finally { busy = false; }
  });
  $('ssh-regenerate').addEventListener('click', async () => {
    const running = last && last.status !== 'stopped';
    if (running && !confirm('Regenerating the remote port restarts the tunnel, and your reverse proxy target must be updated to match. Continue?')) return;
    busy = true;
    remotePortEdited = false;
    try { render(await API.post('/api/ssh-tunnel/regenerate-port', {}), { form: false }); say('New remote port generated'); } catch (error) { say(`Operation failed: ${errorText(error)}`, true); } finally { busy = false; }
  });

  function setActive(value) {
    active = value;
    clearInterval(timer);
    timer = null;
    if (!active) return;
    editing = false;
    say('');
    refresh();
    timer = setInterval(refresh, 3000);
  }
  return { setActive };
})();
