// App list: records which services exist and how to reach them. Data comes from the current engine (local uses /api/apps, a remote Engine is proxied by the Client at /api/remote-servers/:id/apps).
// Apps linked to PM2 can be started/stopped/restarted/reloaded and have their logs viewed directly. All text is written with textContent; links accept http(s) addresses only.
const Apps = (() => {
  const $ = id => document.getElementById(id);
  const table = $('apps-table');
  const body = $('apps-body');
  const hint = $('apps-hint');
  const statusText = $('apps-status');
  const restoreButton = $('apps-restore');
  const defaultHint = 'Services on this machine. PM2 processes are registered automatically; other services can be added manually or register themselves through the API at startup (see below). Ports and IPs are detected automatically where possible; domains must be entered by hand.';
  let active = false, timer = null, busy = false, actionPending = false, generation = 0;
  let base = '/api/apps', pm2Base = null, blocked = null, last = null;

  // Error code → message. Local routes also return a message; the remote proxy only passes the error code through.
  const CODE_MESSAGES = {
    APP_NOT_FOUND: 'App not found', APP_NAME_TAKEN: 'An app with this name already exists', APP_PM2_LINKED: 'This PM2 process is already linked to another app',
    APP_FIELD_REQUIRED: 'Name cannot be empty', APP_FIELD_TOO_LONG: 'Content is too long', APP_FIELD_INVALID: 'Content contains disallowed characters',
    APP_PORT_INVALID: 'Port must be an integer between 1 and 65535', APP_HOST_INVALID: 'Invalid IP format', APP_DOMAIN_INVALID: 'Invalid domain format, e.g. app.example.com',
    APP_URL_INVALID: 'Only http:// or https:// addresses without credentials are supported', APP_SCHEME_INVALID: 'Protocol must be http or https', APP_PATH_INVALID: 'Path must start with / and contain no whitespace',
    APP_BODY_INVALID: 'Invalid request', APPS_UNSUPPORTED: 'This engine is too old to support the app list. Please upgrade it', APPS_UNAVAILABLE: 'The app list service is temporarily unavailable',
    PM2_NOT_INSTALLED: 'pm2 not detected', PM2_NOT_RUNNING: 'The PM2 daemon is not running', PM2_UNSUPPORTED: 'This engine is too old to support PM2 management',
    PM2_COMMAND_FAILED: 'pm2 command failed', PM2_UNAVAILABLE: 'PM2 management is temporarily unavailable',
    REMOTE_NOT_FOUND: 'This remote connection no longer exists', REMOTE_HTTP_401: 'This engine’s authentication has expired', REMOTE_CONNECTION_FAILED: 'Cannot connect to this engine', REMOTE_TIMEOUT: 'Connecting to this engine timed out',
  };
  function errorMessage(error) {
    let code = error.message;
    let message = null;
    try { const parsed = JSON.parse(error.message); code = parsed.error || code; message = parsed.message || null; } catch { /* not JSON */ }
    return CODE_MESSAGES[code] || message || code;
  }

  const safeHref = url => (/^https?:\/\//i.test(url) ? url : null);
  const formatMemory = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);
  function formatUptime(startedAt) {
    if (!startedAt) return '-';
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
    return `${Math.floor(seconds / 86400)} d`;
  }
  const SOURCE_LABELS = { pm2: 'PM2', manual: 'Manual', api: 'Self-registered' };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, handler, className = 'btn-logout') {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', handler);
    return b;
  }
  function link(url, label, extra) {
    const href = safeHref(url);
    if (!href) return null;
    const a = el('a', 'apps-link', label || url);
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = `Open ${url} in a new tab`;
    if (extra) a.append(' ', el('span', 'apps-tag', extra));
    return a;
  }

  // ── Row rendering ──
  function nameCell(app) {
    const td = el('td', 'apps-name');
    const primary = app.links && app.links.primary ? link(app.links.primary, app.name) : null;
    td.append(primary || el('strong', '', app.name));
    td.append(' ', el('span', `apps-source apps-source-${app.source}`, SOURCE_LABELS[app.source] || app.source));
    if (app.description) td.append(el('small', '', app.description));
    return td;
  }

  function statusCell(app) {
    const td = el('td');
    if (app.pm2) {
      td.append(el('span', `pm2-badge ${app.pm2.status}`, app.pm2.status));
      if (app.pm2.status === 'online') {
        td.append(el('small', 'apps-sub', `CPU ${app.pm2.cpu}% · ${formatMemory(app.pm2.memory)} · ${formatUptime(app.pm2.startedAt)} · ${app.pm2.restarts} restarts`));
      }
    } else if (app.pm2_state === 'missing') {
      td.append(el('span', 'pm2-badge errored', 'Process not found'), el('small', 'apps-sub', `PM2 has no process “${app.pm2_name}”`));
    } else if (app.pm2_state === 'unavailable') {
      td.append(el('span', 'pm2-badge', 'PM2 unavailable'));
    } else {
      td.append(el('span', 'apps-sub', 'Not linked to PM2'));
    }
    return td;
  }

  function portCell(app) {
    const td = el('td');
    if (app.effective_port) {
      td.append(String(app.effective_port));
      if (app.port) td.append(' ', el('span', 'apps-tag', 'Set'));
      const others = (app.ports || []).filter(item => item.port !== app.effective_port).map(item => item.port);
      if (others.length) { td.append(el('small', 'apps-sub', `Also: ${others.join(', ')}`)); }
    } else {
      td.append(el('span', 'apps-sub', 'Not detected'));
    }
    return td;
  }

  function addressCell(app) {
    const td = el('td', 'apps-links');
    const links = app.links || {};
    const nodes = [];
    if (links.custom) nodes.push(link(links.custom.url, links.custom.url, 'Custom'));
    if (links.domain) nodes.push(link(links.domain.url, links.domain.url, 'Domain'));
    if (links.ip) nodes.push(link(links.ip.url, links.ip.url, links.ip.local_only ? 'IP · listening on localhost only' : 'IP'));
    const shown = nodes.filter(Boolean);
    if (!shown.length) td.append(el('span', 'apps-sub', 'None (edit to add a port or domain)'));
    for (const node of shown) { const line = el('div'); line.append(node); td.append(line); }
    return td;
  }

  function actionCell(app) {
    const td = el('td');
    const group = el('div', 'pm2-actions');
    const proc = app.pm2;
    if (proc && pm2Base) {
      if (proc.status !== 'online') group.append(button('Start', () => pm2Action(app, 'start')));
      else group.append(button('Restart', () => pm2Action(app, 'restart')), button('Reload', () => pm2Action(app, 'reload')), button('Stop', () => pm2Action(app, 'stop')));
      group.append(button('Logs', () => openLogs(app)));
    }
    group.append(button('Edit', () => openForm(app)), button('Delete', () => remove(app)));
    td.append(group);
    return td;
  }

  function render(data) {
    last = data;
    body.textContent = '';
    restoreButton.hidden = !data.hidden_count;
    restoreButton.textContent = `Restore ${data.hidden_count} hidden`;
    table.hidden = data.apps.length === 0;
    hint.textContent = data.apps.length === 0 ? 'No apps yet. Click “Add app” to register one manually, or let programs register themselves through the API; PM2 processes appear here automatically.' : defaultHint;
    for (const app of data.apps) {
      const row = el('tr');
      row.dataset.appId = String(app.id);
      row.append(nameCell(app), statusCell(app), portCell(app), addressCell(app), actionCell(app));
      body.append(row);
    }
  }

  async function refresh() {
    if (busy || blocked) return;
    busy = true;
    const mine = generation;
    try {
      const data = await API.get(base);
      if (mine === generation) {
        render(data);
        if (!actionPending) statusText.textContent = `Updated at ${new Date().toLocaleTimeString()}`;
      }
    } catch (error) {
      if (mine === generation) statusText.textContent = `Read failed: ${errorMessage(error)}`;
    } finally { busy = false; }
  }

  // ── PM2 actions (call the current engine's /pm2 endpoint: start, stop, restart, reload, logs) ──
  async function pm2Action(app, action) {
    const proc = app.pm2;
    const verb = { start: ['Starting', 'Started', 'Start failed'], stop: ['Stopping', 'Stopped', 'Stop failed'], restart: ['Restarting', 'Restarted', 'Restart failed'], reload: ['Reloading', 'Reloaded', 'Reload failed'] }[action];
    let question = null;
    if (action === 'stop') question = `Stop ${app.name}?`;
    if (proc.self && action !== 'start') question = `${app.name} is the t-agent currently serving this page. ${verb[0]} it will interrupt the page${action === 'stop' ? ' and you will need to start it manually on this machine to recover' : ' for a few seconds'}. Continue?`;
    if (question && !confirm(question)) return;
    statusText.textContent = `${verb[0]} ${app.name}…`;
    actionPending = true;
    try {
      await API.post(`${pm2Base}/${proc.id}/${action}`, {});
      statusText.textContent = `${verb[1]} ${app.name}`;
    } catch (error) {
      statusText.textContent = proc.self ? 'Request sent; the page may disconnect briefly' : `${verb[2]}: ${errorMessage(error)}`;
    }
    actionPending = false;
    await refresh();
  }

  function openLogs(app) {
    const proc = app.pm2;
    Modal.show(`${app.name} logs`, '');
    const content = $('modal-body');
    const bar = el('div', 'pm2-logs-bar');
    const stream = el('select');
    stream.setAttribute('aria-label', 'Log type');
    for (const [value, text] of [['out', 'Standard output'], ['err', 'Error output']]) { const o = el('option', '', text); o.value = value; stream.append(o); }
    const lines = el('select');
    lines.setAttribute('aria-label', 'Lines');
    for (const [value, text] of [['100', 'Last 100 lines'], ['300', 'Last 300 lines'], ['1000', 'Last 1000 lines']]) { const o = el('option', '', text); o.value = value; if (value === '300') o.selected = true; lines.append(o); }
    bar.append(stream, lines, button('Close', Modal.hide));
    const pre = el('pre', 'apps-log', 'Loading…');
    pre.id = 'apps-log-text';
    content.append(bar, pre);
    const load = async () => {
      try {
        const data = await API.get(`${pm2Base}/${proc.id}/logs?stream=${stream.value}&lines=${lines.value}`);
        const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = data.lines.length ? data.lines.join('\n') : '(No logs yet)';
        if (stick) pre.scrollTop = pre.scrollHeight;
      } catch (error) { pre.textContent = `Could not read logs: ${errorMessage(error)}`; }
    };
    stream.addEventListener('change', load); lines.addEventListener('change', load);
    load().then(() => { pre.scrollTop = pre.scrollHeight; });
    const logTimer = setInterval(() => {
      // stop refreshing once the dialog is closed or replaced by other content
      if (!pre.isConnected || $('modal-overlay').style.display === 'none') return clearInterval(logTimer);
      if (!document.hidden) load();
    }, 2000);
  }

  // ── Add / edit ──
  // The form only echoes saved values; auto-detected values are shown as placeholders only, so merely opening the editor never saves them as fixed values.
  function openForm(app) {
    const editing = Boolean(app);
    Modal.show(editing ? `Edit app: ${app.name}` : 'Add app', '');
    const form = el('form');
    const fields = {};
    const group = (key, label, input, hintText) => {
      const wrap = el('div', 'form-group');
      wrap.append(el('label', 'form-label', label));
      input.classList.add('form-input');
      input.id = `app-f-${key}`;
      fields[key] = input;
      wrap.append(input);
      if (hintText) wrap.append(el('div', 'form-hint', hintText));
      form.append(wrap);
      return input;
    };
    const text = (key, label, value, placeholder, hintText, type = 'text') => {
      const input = el('input');
      input.type = type; input.value = value == null ? '' : String(value); input.placeholder = placeholder || ''; input.autocomplete = 'off';
      return group(key, label, input, hintText);
    };
    const a = app || {};
    const detectedPort = app && !app.port && app.effective_port ? `Auto: ${app.effective_port}` : 'Leave empty to auto-detect';
    const detectedIp = app && app.links && app.links.ip && !app.host ? `Auto: ${app.links.ip.host}` : 'Leave empty to use this machine’s LAN IP';
    text('name', 'Name', a.name, 'e.g. Blog', null).maxLength = 64;
    text('description', 'Description', a.description, 'What this service does (optional)', null).maxLength = 500;
    text('pm2_name', 'PM2 process name', a.pm2_name, 'Link a PM2 process (optional)', 'Once set, you can start, stop, restart and view logs here. The app is linked automatically when its name matches a PM2 process.');
    text('port', 'Port', a.port, detectedPort, 'A manual value overrides the auto-detected port.', 'number');
    text('host', 'Address (IP)', a.host, detectedIp, 'IP used when other devices connect; do not add brackets for IPv6.');
    text('domain', 'Address (domain)', a.domain, 'app.example.com or https://app.example.com', 'Only if you have a domain; a full address is fine.');
    const scheme = el('select');
    for (const value of ['http', 'https']) { const o = el('option', '', value); o.value = value; scheme.append(o); }
    scheme.value = a.scheme || 'http';
    group('scheme', 'Protocol', scheme, 'Used for “IP:port” access, and also when the domain is just a hostname. If the domain is a full address (such as https://app.example.com), that wins, so IP over http and domain over https works too.');
    text('path', 'Path', a.path && a.path !== '/' ? a.path : '', '/ (default)', 'e.g. /admin; appended when you click to open.');
    text('url', 'Custom full address', a.url, 'http://10.0.0.5:9000/dashboard', 'If set, this address is used first when clicking through (optional).');
    const error = el('div', 'form-hint error');
    const actions = el('div', 'form-actions');
    const cancel = button('Cancel', Modal.hide, 'btn-cancel');
    const save = el('button', 'btn-submit', 'Save');
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(error, actions);
    $('modal-body').append(form);
    fields.name.focus();

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const payload = {};
      for (const [key, input] of Object.entries(fields)) payload[key] = input.value.trim();
      error.textContent = '';
      save.disabled = true;
      try {
        if (editing) await API.put(`${base}/${app.id}`, payload);
        else await API.post(base, payload);
        Modal.hide();
        statusText.textContent = editing ? `Saved ${payload.name}` : `Added ${payload.name}`;
        await refresh();
      } catch (failure) {
        error.textContent = errorMessage(failure);
        save.disabled = false;
      }
    });
  }

  async function remove(app) {
    const pm2Hint = app.source === 'pm2' && app.pm2 ? '\n(This only removes it from the list; the PM2 process itself is not stopped or deleted. You can bring it back with “Restore hidden”.)' : '';
    if (!confirm(`Delete app “${app.name}”? ${pm2Hint}`)) return;
    try {
      const result = await API.delete(`${base}/${app.id}`);
      statusText.textContent = result.hidden ? `Hidden ${app.name} from the list (the PM2 process is unaffected)` : `Deleted ${app.name}`;
    } catch (error) { statusText.textContent = `Delete failed: ${errorMessage(error)}`; }
    await refresh();
  }

  async function restoreHidden() {
    try {
      const result = await API.post(`${base}/restore-hidden`, {});
      statusText.textContent = `Restored ${result.restored}`;
    } catch (error) { statusText.textContent = `Restore failed: ${errorMessage(error)}`; }
    await refresh();
  }

  // ── Page lifecycle (driven by Tools) ──
  function setActive(value) {
    active = value;
    clearInterval(timer); timer = null;
    if (active && !blocked) {
      refresh();
      timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    }
  }

  // Switch engine: change the request address and clear the previous engine's data. A non-empty blocked means the current engine cannot use the app list; only the reason is shown.
  function setEngine({ endpoint = '/api/apps', pm2Endpoint = null, unavailable = null, example = null } = {}) {
    const changed = endpoint !== base || unavailable !== blocked || pm2Endpoint !== pm2Base;
    base = endpoint; pm2Base = pm2Endpoint; blocked = unavailable;
    renderExample(example);
    if (!changed) return;
    generation += 1; busy = false; last = null;
    body.textContent = '';
    table.hidden = true;
    restoreButton.hidden = true;
    statusText.textContent = '';
    for (const id of ['apps-refresh', 'apps-add']) $(id).disabled = Boolean(blocked);
    hint.textContent = blocked || defaultHint;
    if (active && !blocked) { refresh(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000); }
    if (blocked) { clearInterval(timer); timer = null; }
  }

  // Example command for self-registering programs: a local engine knows its address; for a remote engine we can only tell the user to run it on that machine.
  function renderExample(example) {
    const box = $('apps-register-example');
    box.textContent = example || '(With a remote engine selected, call the same endpoint on that engine’s machine using its own address)';
    $('apps-register-copy').disabled = !example;
  }

  $('apps-add').addEventListener('click', () => openForm(null));
  $('apps-refresh').addEventListener('click', () => { statusText.textContent = ''; refresh(); });
  restoreButton.addEventListener('click', restoreHidden);
  $('apps-register-copy').addEventListener('click', async event => {
    const text = $('apps-register-example').textContent;
    try { await navigator.clipboard.writeText(text); event.target.textContent = 'Copied'; } catch { event.target.textContent = 'Copy failed'; }
    setTimeout(() => { event.target.textContent = 'Copy example command'; }, 2000);
  });
  return { setActive, setEngine, refresh, errorMessage };
})();
