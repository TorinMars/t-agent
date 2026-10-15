// 内网穿透：配置并启停本机的 frpc。所有文本都用 textContent 写入。
const Frp = (() => {
  const $ = id => document.getElementById(id);
  const CODE_MESSAGES = {
    FRP_NOT_INSTALLED: '未找到 frpc：请先安装 frp（0.52 及以上），或用 T_AGENT_FRPC_BIN 指定路径',
    FRP_SERVER_REQUIRED: '请先填写 frps 服务器 IP 或域名',
    FRP_SERVER_ADDR_INVALID: '服务器地址必须是 IP 或域名', FRP_SERVER_PORT_INVALID: '服务端口必须是 1-65535 的整数',
    FRP_DOMAIN_INVALID: '域名格式不正确，例如 app.example.com', FRP_LOCAL_PORT_INVALID: '本地端口必须是 1-65535 的整数',
    FRP_TOKEN_INVALID: 'Token 含有不允许的字符', FRP_PORT_RANGE_INVALID: '随机端口范围不正确',
    FRP_ALREADY_RUNNING: '隧道已经在运行', FRP_START_FAILED: '无法启动 frpc', FRP_BODY_INVALID: '请求内容不正确',
    FRP_REMOTE_PORT_INVALID: '远程端口必须是 1-65535 的整数', FRP_VERSION_UNSUPPORTED: 'frpc 版本过旧，需要 0.52 及以上', FRP_INSTALL_RUNNING: '正在安装 frpc', FRP_ALREADY_INSTALLED: '已经安装了 frpc',
    FRP_UNAVAILABLE: '内网穿透服务暂时不可用',
  };
  const STATUS_LABELS = { stopped: '已停止', starting: '启动中…', running: '运行中', failed: '失败' };
  let active = false, timer = null, busy = false, editing = false, last = null, remotePortEdited = false;

  const errorText = error => {
    let code = error.message;
    try { const parsed = JSON.parse(error.message); code = parsed.error || code; } catch { /* 不是 JSON */ }
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
    if (!data.installed) extra.push(data.installing ? '正在安装 frpc…' : '未检测到 frpc');
    if (data.installError) extra.push(data.installError);
    if (data.error) extra.push(data.error);
    if (data.config.publicAddress) extra.push(`公网地址 ${data.config.publicAddress}（反向代理到 ${data.config.serverAddr}:${data.config.remotePort}）`);
    if (extra.length) line.append(document.createTextNode(extra.join(' · ')));
  }

  function renderFrpc(data) {
    const info = $('frp-frpc-info');
    if (!data.installed) { info.textContent = '未检测到 frpc（已查找 PATH、Homebrew 和 Client 的 data/bin）'; return; }
    const frpc = data.frpc;
    const parts = [`frpc：${frpc.path}`];
    if (frpc.version) parts.push(`版本 ${frpc.version}`);
    if (!frpc.supported) parts.push('版本过旧，需要 0.52 及以上');
    if (frpc.error) parts.push(frpc.error);
    info.textContent = parts.join(' · ');
  }

  function renderRemoteHint(config) {
    $('frp-remote-port-label').textContent = config.remotePortManual ? '远程端口（手动）' : '远程端口（自动随机）';
    $('frp-remote-hint').textContent = config.remotePortManual
      ? '已手动指定：被占用时不会自动换端口，且需在 frps 的 allowPorts 内。清空后保存恢复自动随机。'
      : `自动随机（${config.portMin}-${config.portMax}），生成后保持稳定；也可直接填写固定端口。`;
  }

  function fillForm(config) {
    $('frp-domain').value = config.domain || '';
    $('frp-server-addr').value = config.serverAddr || '';
    $('frp-server-port').value = config.serverPort || 7000;
    $('frp-token').value = '';
    $('frp-token').placeholder = config.hasToken ? '已保存（留空保持不变）' : '没有则留空';
    $('frp-local-port').value = config.localPort || '';
    $('frp-local-port').placeholder = `默认 ${config.effectiveLocalPort}（本 Client 端口）`;
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
    $('frp-install').textContent = data.installing ? '正在安装…' : '安装 frpc';
    $('frp-start').textContent = data.status === 'running' || data.status === 'starting' ? '保存并重启' : '保存并启动';
    if (form && !editing) fillForm(data.config);
    else if (!remotePortEdited) { $('frp-remote-port').value = data.config.remotePort || ''; renderRemoteHint(data.config); }
    const log = $('frp-log');
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.textContent = data.logs.length ? data.logs.join('\n') : '（暂无日志）';
    if (stick) log.scrollTop = log.scrollHeight;
  }

  async function refresh() {
    if (busy || !active) return;
    busy = true;
    try { render(await API.get('/api/frp')); } catch (error) { say(`读取失败：${errorText(error)}`, true); } finally { busy = false; }
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
    // 只有改过这个输入框才提交：否则每次保存都会把自动生成的端口变成“手动”。
    if (remotePortEdited) body.remotePort = $('frp-remote-port').value.trim();
    return body;
  }

  async function run(action, label) {
    busy = true;
    say(`正在${label}…`);
    try {
      const saved = await API.put('/api/frp/config', formBody());
      render(saved, { form: false });
      editing = false;
      if (action === 'start' && saved.status !== 'stopped') render(await API.post('/api/frp/stop', {}), { form: false });
      render(action ? await API.post(`/api/frp/${action}`, {}) : saved);
      say(`已${label}`);
    } catch (error) {
      say(`${label}失败：${errorText(error)}`, true);
    } finally { busy = false; }
  }

  $('frp-form').addEventListener('submit', event => { event.preventDefault(); run(null, '保存'); });
  $('frp-start').addEventListener('click', () => run('start', '启动'));
  $('frp-form').addEventListener('input', () => { editing = true; });
  $('frp-remote-port').addEventListener('input', () => { remotePortEdited = true; });
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* 退回 execCommand */ }
    const area = document.createElement('textarea');
    area.value = text; area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area); area.select();
    try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
  }

  async function directInstall() {
    busy = true;
    try { render(await API.post('/api/frp/install', {}), { form: false }); say('开始安装 frpc，请稍候'); } catch (error) { say(`安装失败：${errorText(error)}`, true); } finally { busy = false; }
  }

  $('frp-install').addEventListener('click', () => {
    const install = last && last.install;
    if (!install) return;
    Modal.show('安装 frpc', '');
    const body = document.getElementById('modal-body');
    const question = document.createElement('div');
    question.className = 'update-message';
    question.textContent = '是否让 Agent 帮你安装 frpc？选“是”会复制安装提示词，粘贴给 Agent（例如本机终端里的 Claude Code / Codex）即可。';
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
      make('取消', 'btn-cancel', Modal.hide),
      make('否，由 Client 直接下载', 'btn-cancel', () => { Modal.hide(); directInstall(); }),
      make('是，复制 Agent 提示词', 'btn-submit', async () => {
        const ok = await copyText(FrpPrompts.frpc(install));
        result.textContent = ok ? '已复制。粘贴给 Agent 执行，完成后回到本页等待自动检测到 frpc。' : '复制失败，请检查浏览器剪贴板权限';
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
    status.textContent = ok ? '已复制' : '复制失败，请检查浏览器剪贴板权限';
    setTimeout(() => { status.textContent = ''; }, 2500);
  });
  $('frp-detect').addEventListener('click', async () => {
    busy = true;
    say('正在检测…');
    try {
      const data = await API.post('/api/frp/detect', {});
      render(data, { form: false });
      say(data.installed ? '已检测到 frpc' : '仍未检测到 frpc', !data.installed);
    } catch (error) { say(`检测失败：${errorText(error)}`, true); } finally { busy = false; }
  });
  $('frp-stop').addEventListener('click', async () => {
    busy = true;
    try { render(await API.post('/api/frp/stop', {}), { form: false }); say('已停止'); } catch (error) { say(`停止失败：${errorText(error)}`, true); } finally { busy = false; }
  });
  $('frp-regenerate').addEventListener('click', async () => {
    const running = last && last.status !== 'stopped';
    if (running && !confirm('重新生成远程端口会重启隧道，之前的反向代理目标需要同步修改。继续吗？')) return;
    busy = true;
    remotePortEdited = false;
    try { render(await API.post('/api/frp/regenerate-port', {}), { form: false }); say('已生成新的远程端口'); } catch (error) { say(`操作失败：${errorText(error)}`, true); } finally { busy = false; }
  });

  // 穿透方式：frp 或 SSH。两种方式的配置和进程互相独立，选择只决定页面显示哪一个、轮询哪一个。
  const METHOD_KEY = 'tAgentTunnelMethod';
  let method = 'frp';
  try { method = localStorage.getItem(METHOD_KEY) === 'ssh' ? 'ssh' : 'frp'; } catch { /* 浏览器不允许存储 */ }

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
      try { localStorage.setItem(METHOD_KEY, method); } catch { /* 浏览器不允许存储 */ }
      applyMethod();
    });
  }

  function setActive(value) {
    active = value;
    applyMethod();
  }
  return { setActive };
})();
