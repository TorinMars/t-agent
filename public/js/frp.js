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
    FRP_INSTALL_RUNNING: '正在安装 frpc', FRP_ALREADY_INSTALLED: '已经安装了 frpc',
    FRP_UNAVAILABLE: '内网穿透服务暂时不可用',
  };
  const STATUS_LABELS = { stopped: '已停止', starting: '启动中…', running: '运行中', failed: '失败' };
  let active = false, timer = null, busy = false, editing = false, last = null;

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

  function fillForm(config) {
    $('frp-domain').value = config.domain || '';
    $('frp-server-addr').value = config.serverAddr || '';
    $('frp-server-port').value = config.serverPort || 7000;
    $('frp-token').value = '';
    $('frp-token').placeholder = config.hasToken ? '已保存（留空保持不变）' : '没有则留空';
    $('frp-local-port').value = config.localPort || '';
    $('frp-local-port').placeholder = `默认 ${config.effectiveLocalPort}（本 Client 端口）`;
    $('frp-remote-port').value = config.remotePort || '';
    $('frp-auto-start').checked = Boolean(config.autoStart);
  }

  function render(data, { form = true } = {}) {
    last = data;
    renderStatus(data);
    $('frp-install-row').hidden = data.installed;
    $('frp-install').disabled = Boolean(data.installing);
    $('frp-install').textContent = data.installing ? '正在安装…' : '安装 frpc';
    if (form && !editing) fillForm(data.config);
    else $('frp-remote-port').value = data.config.remotePort || '';
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
    return body;
  }

  async function run(action, label) {
    busy = true;
    say(`正在${label}…`);
    try {
      const saved = await API.put('/api/frp/config', formBody());
      render(saved, { form: false });
      editing = false;
      render(action ? await API.post(`/api/frp/${action}`, {}) : saved);
      say(`已${label}`);
    } catch (error) {
      say(`${label}失败：${errorText(error)}`, true);
    } finally { busy = false; }
  }

  $('frp-form').addEventListener('submit', event => { event.preventDefault(); run(null, '保存'); });
  $('frp-start').addEventListener('click', () => run('start', '启动'));
  $('frp-form').addEventListener('input', () => { editing = true; });
  $('frp-install').addEventListener('click', async () => {
    busy = true;
    try { render(await API.post('/api/frp/install', {}), { form: false }); say('开始安装 frpc，请稍候'); } catch (error) { say(`安装失败：${errorText(error)}`, true); } finally { busy = false; }
  });
  $('frp-stop').addEventListener('click', async () => {
    busy = true;
    try { render(await API.post('/api/frp/stop', {}), { form: false }); say('已停止'); } catch (error) { say(`停止失败：${errorText(error)}`, true); } finally { busy = false; }
  });
  $('frp-regenerate').addEventListener('click', async () => {
    const running = last && last.status !== 'stopped';
    if (running && !confirm('重新生成远程端口会重启隧道，之前的反向代理目标需要同步修改。继续吗？')) return;
    busy = true;
    try { render(await API.post('/api/frp/regenerate-port', {}), { form: false }); say('已生成新的远程端口'); } catch (error) { say(`操作失败：${errorText(error)}`, true); } finally { busy = false; }
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
