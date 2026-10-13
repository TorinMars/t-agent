// Agent 配置：为 Claude Code / Codex 维护一份全局默认，并推送到本机和所有已连接的服务器；每台服务器可单独覆盖。
// 页面本身不属于某个引擎：服务器列表就是“本机 + 连接远程里的全部引擎”。文本都经 escapeHtml 或 textContent 写入。
const AgentConfig = (() => {
  const $ = id => document.getElementById(id);
  const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' };
  const SKIP = '__skip';
  const CODE_MESSAGES = {
    AGENT_CONFIG_UNSUPPORTED: '该服务器的 Engine 版本过旧，请先升级',
    CONFIG_INVALID: '该机器上的配置文件格式不对，已跳过',
    REMOTE_TIMEOUT: '连接超时', REMOTE_CONNECTION_FAILED: '无法连接', REMOTE_HTTP_401: '令牌无效或已被撤销',
  };
  let data = null, tool = 'claude', draft = { claude: {}, codex: {} }, active = false, busy = false;

  const errorText = error => {
    let text = error.message || '操作失败';
    try { const parsed = JSON.parse(text); text = parsed.message || parsed.error || text; } catch { /* 保持原文 */ }
    return CODE_MESSAGES[text] || text;
  };
  const say = (text, bad) => { const node = $('agent-config-status'); node.textContent = text || ''; node.className = `tool-copy-status${bad ? ' ac-bad' : ''}`; };

  // ---------- 表单 ----------
  // mode: 'default' 填全局默认；'override' 填某台服务器的覆盖（空 = 跟随全局默认，SKIP = 这台不管）。
  function fieldHtml(field, value, mode) {
    const override = mode === 'override';
    const id = `ac-${mode}-${field.key}`;
    let control;
    if (field.type === 'enum') {
      const head = override
        ? `<option value="">跟随全局默认</option><option value="${SKIP}">这台不管</option>`
        : '<option value="">不设置（保持原样）</option>';
      const options = field.options.map(([option, label]) => `<option value="${escapeHtml(option)}">${escapeHtml(label)}</option>`).join('');
      control = `<select id="${id}" data-key="${field.key}">${head}${options}</select>`;
    } else {
      const presets = (field.presets || []).length
        ? `<div class="ac-presets">常用：${field.presets.map(([label, preset]) => `<button type="button" class="ac-preset" data-preset-for="${field.key}" data-preset="${escapeHtml(preset)}">${escapeHtml(label)}</button>`).join('')}</div>` : '';
      const skip = override ? `<label class="ac-skip"><input type="checkbox" data-skip="${field.key}"> 这台不管</label>` : '';
      control = `<input type="text" id="${id}" data-key="${field.key}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(field.placeholder || (override ? '留空 = 跟随全局默认' : '留空 = 不设置'))}">${presets}${skip}`;
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

  // ---------- 全局默认 ----------
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

  // ---------- 服务器列表 ----------
  function renderServers() {
    const body = $('agent-config-servers');
    body.replaceChildren();
    for (const server of data.servers) {
      const row = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = server.local ? '本机（运行 Client 的这台）' : server.name;
      const status = document.createElement('td');
      const last = data.status[server.key];
      if (!last) status.textContent = '尚未推送';
      else {
        const time = new Date(last.at).toLocaleString();
        status.textContent = last.ok ? `${time} · 成功` : `${time} · 失败：${CODE_MESSAGES[last.error] || last.error || ''}`;
        status.className = last.ok ? 'ac-ok' : 'ac-bad';
      }
      const overrides = document.createElement('td');
      const own = data.overrides[server.key] || {};
      const count = Object.values(own).reduce((sum, values) => sum + Object.keys(values || {}).length, 0);
      overrides.textContent = count ? `${count} 项` : '—';
      const actions = document.createElement('td');
      actions.className = 'tool-card-actions';
      actions.style.margin = '0';
      for (const [label, handler] of [['覆盖', () => editOverride(server)], ['查看当前', () => showCurrent(server)], ['推送', () => push([server.key])]]) {
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
    const title = `${server.local ? '本机' : server.name} 的覆盖`;
    const toolButtons = ['claude', 'codex'].map((name, index) => `<button type="button" class="agent-config-tab${index ? '' : ' active'}" data-ovr-tool="${name}">${TOOL_NAMES[name]}</button>`).join('');
    Modal.show(title, `<div class="form-hint">只填这台服务器需要不同的项；留空的项沿用全局默认。选“这台不管”表示推送时不改这台的该项。</div>
      <div class="agent-config-tabs">${toolButtons}</div><div id="ac-override-form"></div>
      <div class="form-actions"><button class="btn-submit" id="ac-override-save">保存覆盖</button><button class="btn-logout" id="ac-override-cancel">取消</button></div>`);
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
        say('覆盖已保存，推送后生效');
      } catch (error) { say(errorText(error), true); }
    });
  }

  async function showCurrent(server) {
    Modal.show(`${server.local ? '本机' : server.name} 的当前配置`, '<p>正在读取…</p>');
    let current;
    try { current = await API.get(`/api/agent-config/servers/${encodeURIComponent(server.key)}/current`); }
    catch (error) { Modal.show(`${server.local ? '本机' : server.name} 的当前配置`, `<p class="ac-bad">${escapeHtml(errorText(error))}</p>`); return; }
    const sections = ['claude', 'codex'].map(name => {
      if (current.errors && current.errors[name]) return `<h4>${TOOL_NAMES[name]}</h4><p class="ac-bad">${escapeHtml(CODE_MESSAGES[current.errors[name]] || current.errors[name])}</p>`;
      const rows = data.schema[name].map(field => `<tr><td>${escapeHtml(field.label)}</td><td>${escapeHtml((current[name] || {})[field.key] || '—')}</td></tr>`).join('');
      return `<h4>${TOOL_NAMES[name]}</h4><div class="form-hint">${escapeHtml((current.paths || {})[name] || '')}</div><div class="pm2-table-wrap"><table class="pm2-table ac-current"><tbody>${rows}</tbody></table></div>`;
    }).join('');
    Modal.show(`${server.local ? '本机' : server.name} 的当前配置`, `${sections}<div class="form-actions"><button class="btn-logout" id="ac-current-close">关闭</button></div>`);
    document.getElementById('ac-current-close').addEventListener('click', Modal.hide);
  }

  // ---------- 保存 / 推送 ----------
  async function saveDefaults() {
    captureDraft();
    for (const name of ['claude', 'codex']) await API.put('/api/agent-config/defaults', { tool: name, values: draft[name] });
    data.defaults = { claude: { ...draft.claude }, codex: { ...draft.codex } };
  }
  async function push(servers) {
    if (busy) return;
    busy = true; say('正在推送…');
    try {
      if (!servers) await saveDefaults();
      const { results } = await API.post('/api/agent-config/push', servers ? { servers } : {});
      await load();
      const failed = results.filter(item => !item.ok);
      say(failed.length ? `已推送 ${results.length - failed.length} 台，${failed.length} 台失败（见列表）` : `已推送到 ${results.length} 台服务器`, failed.length > 0);
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
    try { await saveDefaults(); say('全局默认已保存，推送后才会写到各服务器'); } catch (error) { say(errorText(error), true); }
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
