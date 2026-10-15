// Agent config: maintain one global default for Claude Code / Codex, push it to this machine and every connected server; each server can override it.
// The page does not belong to a single engine: the server list is "this machine + every engine under Connect remote". All text is written through escapeHtml or textContent.
const AgentConfig = (() => {
  const $ = id => document.getElementById(id);
  const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' };
  const SKIP = '__skip';
  const CODE_MESSAGES = {
    AGENT_CONFIG_UNSUPPORTED: 'This server’s engine is too old. Please upgrade it first',
    CONFIG_INVALID: 'The configuration file on that machine has an invalid format; skipped',
    REMOTE_TIMEOUT: 'Connection timed out', REMOTE_CONNECTION_FAILED: 'Cannot connect', REMOTE_HTTP_401: 'Token is invalid or has been revoked',
  };
  let data = null, tool = 'claude', draft = { claude: {}, codex: {} }, active = false, busy = false;

  const errorText = error => {
    let text = error.message || 'Operation failed';
    try { const parsed = JSON.parse(text); text = parsed.message || parsed.error || text; } catch { /* keep the original text */ }
    return CODE_MESSAGES[text] || text;
  };
  const say = (text, bad) => { const node = $('agent-config-status'); node.textContent = text || ''; node.className = `tool-copy-status${bad ? ' ac-bad' : ''}`; };

  // ---------- Form ----------
  // mode: 'default' edits the global default; 'override' edits one server's override (empty = follow the global default, SKIP = leave this server alone).
  function fieldHtml(field, value, mode) {
    const override = mode === 'override';
    const id = `ac-${mode}-${field.key}`;
    let control;
    if (field.type === 'enum') {
      const head = override
        ? `<option value="">Follow global default</option><option value="${SKIP}">Leave unmanaged on this server</option>`
        : '<option value="">Not set (keep as is)</option>';
      const options = field.options.map(([option, label]) => `<option value="${escapeHtml(option)}">${escapeHtml(label)}</option>`).join('');
      control = `<select id="${id}" data-key="${field.key}">${head}${options}</select>`;
    } else {
      const presets = (field.presets || []).length
        ? `<div class="ac-presets">Common: ${field.presets.map(([label, preset]) => `<button type="button" class="ac-preset" data-preset-for="${field.key}" data-preset="${escapeHtml(preset)}">${escapeHtml(label)}</button>`).join('')}</div>` : '';
      const skip = override ? `<label class="ac-skip"><input type="checkbox" data-skip="${field.key}"> Leave unmanaged on this server</label>` : '';
      control = `<input type="text" id="${id}" data-key="${field.key}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(field.placeholder || (override ? 'Empty = follow global default' : 'Empty = not set'))}">${presets}${skip}`;
    }
    const hint = field.hint ? `<div class="ac-hint">${escapeHtml(field.hint)}</div>` : '';
    return `<div class="ac-field"><label class="ac-label" for="${id}">${escapeHtml(field.label)}</label><div class="ac-control">${control}${hint}</div></div>`;
  }
  function formHtml(toolName, mode) {
    let html = '';
    let group = null;
    for (const field of data.schema[toolName]) {
      if (field.group !== group) { group = field.group; html += `<div class="ac-group">${escapeHtml(group)}</div>`; }
      html += fieldHtml(field, '', mode);
    }
    return html;
  }
  function fillForm(root, toolName, values, mode) {
    for (const field of data.schema[toolName]) {
      const input = root.querySelector(`[data-key="${field.key}"]`);
      if (!input) continue;
      const has = Object.prototype.hasOwnProperty.call(values, field.key);
      const value = has ? values[field.key] : '';
      if (mode === 'override' && has && value === '') {
        if (field.type === 'enum') input.value = SKIP;
        else { const box = root.querySelector(`[data-skip="${field.key}"]`); if (box) { box.checked = true; input.disabled = true; } }
      } else input.value = value;
    }
  }
  function readForm(root, toolName, mode) {
    const values = {};
    for (const field of data.schema[toolName]) {
      const input = root.querySelector(`[data-key="${field.key}"]`);
      if (!input) continue;
      let value = input.value.trim();
      if (mode === 'override') {
        const box = root.querySelector(`[data-skip="${field.key}"]`);
        if (value === SKIP || (box && box.checked)) { values[field.key] = ''; continue; }
        if (value === '') continue;
      }
      values[field.key] = value;
    }
    return values;
  }
  function wireForm(root) {
    root.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
      const input = root.querySelector(`[data-key="${button.dataset.presetFor}"]`);
      input.value = button.dataset.preset; input.disabled = false;
      const box = root.querySelector(`[data-skip="${button.dataset.presetFor}"]`); if (box) box.checked = false;
    }));
    root.querySelectorAll('[data-skip]').forEach(box => box.addEventListener('change', () => {
      root.querySelector(`[data-key="${box.dataset.skip}"]`).disabled = box.checked;
    }));
  }

  // ---------- Global defaults ----------
  function renderDefaults() {
    const root = $('agent-config-defaults');
    root.innerHTML = formHtml(tool, 'default');
    wireForm(root);
    fillForm(root, tool, draft[tool], 'default');
    document.querySelectorAll('#agent-config-panel .agent-config-tab[data-tool]').forEach(button => {
      const on = button.dataset.tool === tool;
      button.classList.toggle('active', on);
      button.setAttribute('aria-selected', String(on));
    });
  }
  const captureDraft = () => { draft[tool] = readForm($('agent-config-defaults'), tool, 'default'); };

  // ---------- Server list ----------
  function renderServers() {
    const body = $('agent-config-servers');
    body.replaceChildren();
    for (const server of data.servers) {
      const row = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = server.local ? 'This machine (running the Client)' : server.name;
      const status = document.createElement('td');
      const last = data.status[server.key];
      if (!last) status.textContent = 'Not pushed yet';
      else {
        const time = new Date(last.at).toLocaleString();
        status.textContent = last.ok ? `${time} · succeeded` : `${time} · failed: ${CODE_MESSAGES[last.error] || last.error || ''}`;
        status.className = last.ok ? 'ac-ok' : 'ac-bad';
      }
      const overrides = document.createElement('td');
      const own = data.overrides[server.key] || {};
      const count = Object.values(own).reduce((sum, values) => sum + Object.keys(values || {}).length, 0);
      overrides.textContent = count ? `${count} item(s)` : '—';
      const actions = document.createElement('td');
      actions.className = 'tool-card-actions';
      actions.style.margin = '0';
      for (const [label, handler] of [['Override', () => editOverride(server)], ['View current', () => showCurrent(server)], ['Push', () => push([server.key])]]) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn-logout'; button.textContent = label;
        button.addEventListener('click', handler);
        actions.append(button);
      }
      row.append(name, status, overrides, actions);
      body.append(row);
    }
  }

  function editOverride(server) {
    const title = `${server.local ? 'This machine' : server.name} override`;
    const toolButtons = ['claude', 'codex'].map((name, index) => `<button type="button" class="agent-config-tab${index ? '' : ' active'}" data-ovr-tool="${name}">${TOOL_NAMES[name]}</button>`).join('');
    Modal.show(title, `<div class="form-hint">Only fill in items that should differ on this server; empty items use the global default. “Leave unmanaged” means that item is not changed on this server when pushing.</div>
      <div class="agent-config-tabs">${toolButtons}</div><div id="ac-override-form"></div>
      <div class="form-actions"><button class="btn-submit" id="ac-override-save">Save override</button><button class="btn-logout" id="ac-override-cancel">Cancel</button></div>`);
    const holder = document.getElementById('ac-override-form');
    const edits = { claude: { ...(data.overrides[server.key] || {}).claude }, codex: { ...(data.overrides[server.key] || {}).codex } };
    let current = 'claude';
    const show = name => {
      holder.innerHTML = formHtml(name, 'override');
      wireForm(holder);
      fillForm(holder, name, edits[name], 'override');
      document.querySelectorAll('[data-ovr-tool]').forEach(button => button.classList.toggle('active', button.dataset.ovrTool === name));
      current = name;
    };
    show('claude');
    document.querySelectorAll('[data-ovr-tool]').forEach(button => button.addEventListener('click', () => {
      edits[current] = readForm(holder, current, 'override');
      show(button.dataset.ovrTool);
    }));
    document.getElementById('ac-override-cancel').addEventListener('click', Modal.hide);
    document.getElementById('ac-override-save').addEventListener('click', async () => {
      edits[current] = readForm(holder, current, 'override');
      try {
        for (const name of ['claude', 'codex']) await API.put(`/api/agent-config/servers/${encodeURIComponent(server.key)}`, { tool: name, values: edits[name] });
        Modal.hide();
        await load();
        say('Override saved; it takes effect after pushing');
      } catch (error) { say(errorText(error), true); }
    });
  }

  async function showCurrent(server) {
    Modal.show(`${server.local ? 'This machine' : server.name} current configuration`, '<p>Reading…</p>');
    let current;
    try { current = await API.get(`/api/agent-config/servers/${encodeURIComponent(server.key)}/current`); }
    catch (error) { Modal.show(`${server.local ? 'This machine' : server.name} current configuration`, `<p class="ac-bad">${escapeHtml(errorText(error))}</p>`); return; }
    const sections = ['claude', 'codex'].map(name => {
      if (current.errors && current.errors[name]) return `<h4>${TOOL_NAMES[name]}</h4><p class="ac-bad">${escapeHtml(CODE_MESSAGES[current.errors[name]] || current.errors[name])}</p>`;
      const rows = data.schema[name].map(field => `<tr><td>${escapeHtml(field.label)}</td><td>${escapeHtml((current[name] || {})[field.key] || '—')}</td></tr>`).join('');
      return `<h4>${TOOL_NAMES[name]}</h4><div class="form-hint">${escapeHtml((current.paths || {})[name] || '')}</div><div class="pm2-table-wrap"><table class="pm2-table ac-current"><tbody>${rows}</tbody></table></div>`;
    }).join('');
    Modal.show(`${server.local ? 'This machine' : server.name} current configuration`, `${sections}<div class="form-actions"><button class="btn-logout" id="ac-current-close">Close</button></div>`);
    document.getElementById('ac-current-close').addEventListener('click', Modal.hide);
  }

  // ---------- Save / push ----------
  async function saveDefaults() {
    captureDraft();
    for (const name of ['claude', 'codex']) await API.put('/api/agent-config/defaults', { tool: name, values: draft[name] });
    data.defaults = { claude: { ...draft.claude }, codex: { ...draft.codex } };
  }
  async function push(servers) {
    if (busy) return;
    busy = true; say('Pushing…');
    try {
      if (!servers) await saveDefaults();
      const { results } = await API.post('/api/agent-config/push', servers ? { servers } : {});
      await load();
      const failed = results.filter(item => !item.ok);
      say(failed.length ? `Pushed to ${results.length - failed.length} server(s), ${failed.length} failed (see the list)` : `Pushed to ${results.length} server(s)`, failed.length > 0);
    } catch (error) { say(errorText(error), true); }
    finally { busy = false; }
  }

  async function load() {
    data = await API.get('/api/agent-config');
    for (const name of ['claude', 'codex']) draft[name] = { ...(data.defaults[name] || {}) };
    renderDefaults();
    renderServers();
  }

  document.querySelectorAll('.agent-config-tab[data-tool]').forEach(button => button.addEventListener('click', () => {
    if (!data || button.dataset.tool === tool) return;
    captureDraft(); tool = button.dataset.tool; renderDefaults();
  }));
  $('agent-config-save').addEventListener('click', async () => {
    if (!data) return;
    try { await saveDefaults(); say('Global defaults saved; they reach each server only after pushing'); } catch (error) { say(errorText(error), true); }
  });
  $('agent-config-push-all').addEventListener('click', () => { if (data) push(null); });

  async function setActive(on) {
    active = on;
    if (!on) return;
    say('');
    try { await load(); } catch (error) { say(errorText(error), true); }
  }
  return { setActive, isActive: () => active };
})();
