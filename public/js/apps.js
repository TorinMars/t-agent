// 应用列表：登记“有哪些服务、怎么访问”。数据来自当前引擎（本地走 /api/apps，远程 Engine 经 Client 代理走 /api/remote-servers/:id/apps）。
// 关联了 PM2 的应用可以直接启动/停止/重启/reload 和看日志。所有文本都用 textContent 写入；链接只接受 http(s) 地址。
const Apps = (() => {
  const $ = id => document.getElementById(id);
  const table = $('apps-table');
  const body = $('apps-body');
  const hint = $('apps-hint');
  const statusText = $('apps-status');
  const restoreButton = $('apps-restore');
  const defaultHint = '这台机器上的服务清单。PM2 里的进程会自动登记；其他服务可以手动新增，也可以让程序启动时通过接口自注册（见下方说明）。端口和 IP 尽量自动检测，域名需要手动填写。';
  let active = false, timer = null, busy = false, generation = 0;
  let base = '/api/apps', pm2Base = null, blocked = null, last = null;

  // 错误码 → 中文。本机路由同时返回 message，远程代理只透传错误码。
  const CODE_MESSAGES = {
    APP_NOT_FOUND: '找不到这个应用', APP_NAME_TAKEN: '已有同名应用', APP_PM2_LINKED: '这个 PM2 进程已经关联了别的应用',
    APP_FIELD_REQUIRED: '名称不能为空', APP_FIELD_TOO_LONG: '内容太长', APP_FIELD_INVALID: '内容含有不允许的字符',
    APP_PORT_INVALID: '端口必须是 1-65535 的整数', APP_HOST_INVALID: 'IP 格式不正确', APP_DOMAIN_INVALID: '域名格式不正确，例如 app.example.com',
    APP_URL_INVALID: '地址只支持不含账号密码的 http:// 或 https://', APP_SCHEME_INVALID: '协议只能是 http 或 https', APP_PATH_INVALID: '路径必须以 / 开头且不含空白',
    APP_BODY_INVALID: '请求内容不正确', APPS_UNSUPPORTED: '该引擎版本过旧，暂不支持应用列表，请先升级该引擎', APPS_UNAVAILABLE: '应用列表服务暂时不可用',
    PM2_NOT_INSTALLED: '未检测到 pm2', PM2_NOT_RUNNING: 'PM2 守护进程没有运行', PM2_UNSUPPORTED: '该引擎版本过旧，暂不支持 PM2 管理',
    PM2_COMMAND_FAILED: 'pm2 命令执行失败', PM2_UNAVAILABLE: 'PM2 管理服务暂时不可用',
    REMOTE_NOT_FOUND: '这个远程连接已不存在', REMOTE_HTTP_401: '该引擎的认证已失效', REMOTE_CONNECTION_FAILED: '无法连接该引擎', REMOTE_TIMEOUT: '连接该引擎超时',
  };
  function errorMessage(error) {
    let code = error.message;
    let message = null;
    try { const parsed = JSON.parse(error.message); code = parsed.error || code; message = parsed.message || null; } catch { /* 不是 JSON */ }
    return CODE_MESSAGES[code] || message || code;
  }

  const safeHref = url => (/^https?:\/\//i.test(url) ? url : null);
  const formatMemory = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);
  function formatUptime(startedAt) {
    if (!startedAt) return '-';
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
    return `${Math.floor(seconds / 86400)} 天`;
  }
  const SOURCE_LABELS = { pm2: 'PM2', manual: '手动', api: '程序注册' };

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
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = `在新标签页打开 ${url}`;
    if (extra) a.append(' ', el('span', 'apps-tag', extra));
    return a;
  }

  // ── 行渲染 ──
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
        td.append(el('small', 'apps-sub', `CPU ${app.pm2.cpu}% · ${formatMemory(app.pm2.memory)} · ${formatUptime(app.pm2.startedAt)} · 重启 ${app.pm2.restarts}`));
      }
    } else if (app.pm2_state === 'missing') {
      td.append(el('span', 'pm2-badge errored', '进程不存在'), el('small', 'apps-sub', `PM2 里没有「${app.pm2_name}」`));
    } else if (app.pm2_state === 'unavailable') {
      td.append(el('span', 'pm2-badge', 'PM2 不可用'));
    } else {
      td.append(el('span', 'apps-sub', '未关联 PM2'));
    }
    return td;
  }

  function portCell(app) {
    const td = el('td');
    if (app.effective_port) {
      td.append(String(app.effective_port));
      if (app.port) td.append(' ', el('span', 'apps-tag', '已设置'));
      const others = (app.ports || []).filter(item => item.port !== app.effective_port).map(item => item.port);
      if (others.length) { td.append(el('small', 'apps-sub', `另有 ${others.join('、')}`)); }
    } else {
      td.append(el('span', 'apps-sub', '未检测到'));
    }
    return td;
  }

  function addressCell(app) {
    const td = el('td', 'apps-links');
    const links = app.links || {};
    const nodes = [];
    if (links.custom) nodes.push(link(links.custom.url, links.custom.url, '自定义'));
    if (links.domain) nodes.push(link(links.domain.url, links.domain.url, '域名'));
    if (links.ip) nodes.push(link(links.ip.url, links.ip.url, links.ip.local_only ? 'IP · 仅本机监听' : 'IP'));
    const shown = nodes.filter(Boolean);
    if (!shown.length) td.append(el('span', 'apps-sub', '暂无（可编辑补充端口或域名）'));
    for (const node of shown) { const line = el('div'); line.append(node); td.append(line); }
    return td;
  }

  function actionCell(app) {
    const td = el('td');
    const group = el('div', 'pm2-actions');
    const proc = app.pm2;
    if (proc && pm2Base) {
      if (proc.status !== 'online') group.append(button('启动', () => pm2Action(app, 'start')));
      else group.append(button('重启', () => pm2Action(app, 'restart')), button('Reload', () => pm2Action(app, 'reload')), button('停止', () => pm2Action(app, 'stop')));
      group.append(button('日志', () => openLogs(app)));
    }
    group.append(button('编辑', () => openForm(app)), button('删除', () => remove(app)));
    td.append(group);
    return td;
  }

  function render(data) {
    last = data;
    body.textContent = '';
    restoreButton.hidden = !data.hidden_count;
    restoreButton.textContent = `恢复已隐藏的 ${data.hidden_count} 个`;
    table.hidden = data.apps.length === 0;
    hint.textContent = data.apps.length === 0 ? '还没有应用。点击“新增应用”手动登记，或让程序通过接口自注册；PM2 里的进程会自动出现在这里。' : defaultHint;
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
        if (!statusText.textContent.startsWith('正在')) statusText.textContent = `更新于 ${new Date().toLocaleTimeString()}`;
      }
    } catch (error) {
      if (mine === generation) statusText.textContent = `读取失败：${errorMessage(error)}`;
    } finally { busy = false; }
  }

  // ── PM2 操作（沿用 PM2 面板同样的接口） ──
  async function pm2Action(app, action) {
    const proc = app.pm2;
    const label = { start: '启动', stop: '停止', restart: '重启', reload: 'reload' }[action];
    let question = null;
    if (action === 'stop') question = `确定停止 ${app.name}？`;
    if (proc.self && action !== 'start') question = `${app.name} 就是当前正在提供本页面的 t-agent。${label}后页面会中断${action === 'stop' ? '，并且需要在这台机器上手动启动才能恢复' : '几秒'}。继续吗？`;
    if (question && !confirm(question)) return;
    statusText.textContent = `正在${label} ${app.name}…`;
    try {
      await API.post(`${pm2Base}/${proc.id}/${action}`, {});
      statusText.textContent = `已${label} ${app.name}`;
    } catch (error) {
      statusText.textContent = proc.self ? '请求已发出，页面可能会短暂断开' : `${label}失败：${errorMessage(error)}`;
    }
    await refresh();
  }

  function openLogs(app) {
    const proc = app.pm2;
    Modal.show(`${app.name} 的日志`, '');
    const content = $('modal-body');
    const bar = el('div', 'pm2-logs-bar');
    const stream = el('select');
    stream.setAttribute('aria-label', '日志类型');
    for (const [value, text] of [['out', '标准输出'], ['err', '错误输出']]) { const o = el('option', '', text); o.value = value; stream.append(o); }
    const lines = el('select');
    lines.setAttribute('aria-label', '行数');
    for (const [value, text] of [['100', '最近 100 行'], ['300', '最近 300 行'], ['1000', '最近 1000 行']]) { const o = el('option', '', text); o.value = value; if (value === '300') o.selected = true; lines.append(o); }
    bar.append(stream, lines, button('关闭', Modal.hide));
    const pre = el('pre', 'apps-log', '加载中…');
    pre.id = 'apps-log-text';
    content.append(bar, pre);
    const load = async () => {
      try {
        const data = await API.get(`${pm2Base}/${proc.id}/logs?stream=${stream.value}&lines=${lines.value}`);
        const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = data.lines.length ? data.lines.join('\n') : '（暂无日志）';
        if (stick) pre.scrollTop = pre.scrollHeight;
      } catch (error) { pre.textContent = `读取日志失败：${errorMessage(error)}`; }
    };
    stream.addEventListener('change', load); lines.addEventListener('change', load);
    load().then(() => { pre.scrollTop = pre.scrollHeight; });
    const logTimer = setInterval(() => {
      // 弹窗关闭或被别的内容替换后停止刷新
      if (!pre.isConnected || $('modal-overlay').style.display === 'none') return clearInterval(logTimer);
      if (!document.hidden) load();
    }, 2000);
  }

  // ── 新增 / 编辑 ──
  // 表单只回显已保存的值；自动检测到的值只作为占位符显示，不会因为打开编辑框就被保存成固定值。
  function openForm(app) {
    const editing = Boolean(app);
    Modal.show(editing ? `编辑应用：${app.name}` : '新增应用', '');
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
    const detectedPort = app && !app.port && app.effective_port ? `自动：${app.effective_port}` : '留空则自动检测';
    const detectedIp = app && app.links && app.links.ip && !app.host ? `自动：${app.links.ip.host}` : '留空则使用本机局域网 IP';
    text('name', '名称', a.name, '例如 博客', null).maxLength = 64;
    text('description', '说明', a.description, '这个服务是做什么的（可选）', null).maxLength = 500;
    text('pm2_name', 'PM2 进程名', a.pm2_name, '关联 PM2 进程（可选）', '填写后可以在这里直接启动、停止、重启和看日志。名称与 PM2 进程同名时会自动关联。');
    text('port', '端口', a.port, detectedPort, '手动填写会覆盖自动检测到的端口。', 'number');
    text('host', '访问地址（IP）', a.host, detectedIp, '其他设备访问时用的 IP；IPv6 不要加方括号。');
    text('domain', '访问地址（域名）', a.domain, 'app.example.com 或 https://app.example.com', '有域名才填；可以直接写完整地址。');
    const scheme = el('select');
    for (const value of ['http', 'https']) { const o = el('option', '', value); o.value = value; scheme.append(o); }
    scheme.value = a.scheme || 'http';
    group('scheme', '协议', scheme, '用于“IP:端口”访问；域名只写主机名时也用它。域名写成完整地址（如 https://app.example.com）则以写的为准，这样 IP 走 http、域名走 https 也可以。');
    text('path', '路径', a.path && a.path !== '/' ? a.path : '', '/（默认）', '例如 /admin，点击访问时会带上。');
    text('url', '自定义完整地址', a.url, 'http://10.0.0.5:9000/dashboard', '填了就优先用它作为点击跳转的地址（可选）。');
    const error = el('div', 'form-hint error');
    const actions = el('div', 'form-actions');
    const cancel = button('取消', Modal.hide, 'btn-cancel');
    const save = el('button', 'btn-submit', '保存');
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
        statusText.textContent = editing ? `已保存 ${payload.name}` : `已新增 ${payload.name}`;
        await refresh();
      } catch (failure) {
        error.textContent = errorMessage(failure);
        save.disabled = false;
      }
    });
  }

  async function remove(app) {
    const pm2Hint = app.source === 'pm2' && app.pm2 ? '\n（只是从列表里移除，PM2 进程本身不会被停止或删除；之后可以用“恢复已隐藏”找回。）' : '';
    if (!confirm(`确定删除应用「${app.name}」？${pm2Hint}`)) return;
    try {
      const result = await API.delete(`${base}/${app.id}`);
      statusText.textContent = result.hidden ? `已从列表隐藏 ${app.name}（PM2 进程未受影响）` : `已删除 ${app.name}`;
    } catch (error) { statusText.textContent = `删除失败：${errorMessage(error)}`; }
    await refresh();
  }

  async function restoreHidden() {
    try {
      const result = await API.post(`${base}/restore-hidden`, {});
      statusText.textContent = `已恢复 ${result.restored} 个`;
    } catch (error) { statusText.textContent = `恢复失败：${errorMessage(error)}`; }
    await refresh();
  }

  // ── 页面生命周期（由 Tools 调度） ──
  function setActive(value) {
    active = value;
    clearInterval(timer); timer = null;
    if (active && !blocked) {
      refresh();
      timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    }
  }

  // 切换引擎：换请求地址，清掉上一个引擎的数据。blocked 非空表示当前引擎不能用应用列表，只显示原因。
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

  // 程序自注册的示例命令：本地引擎知道地址；远程引擎只能提示在那台机器上执行。
  function renderExample(example) {
    const box = $('apps-register-example');
    box.textContent = example || '（选中远程引擎时，请在该引擎所在机器上，用它自己的地址调用同样的接口）';
    $('apps-register-copy').disabled = !example;
  }

  $('apps-add').addEventListener('click', () => openForm(null));
  $('apps-refresh').addEventListener('click', () => { statusText.textContent = ''; refresh(); });
  restoreButton.addEventListener('click', restoreHidden);
  $('apps-register-copy').addEventListener('click', async event => {
    const text = $('apps-register-example').textContent;
    try { await navigator.clipboard.writeText(text); event.target.textContent = '已复制'; } catch { event.target.textContent = '复制失败'; }
    setTimeout(() => { event.target.textContent = '复制示例命令'; }, 2000);
  });
  return { setActive, setEngine, refresh, errorMessage };
})();
