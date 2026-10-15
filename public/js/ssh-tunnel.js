// SSH 反向隧道：配置并启停本机的 ssh -R 进程。所有文本都用 textContent 写入。
const SshTunnel = (() => {
  const $ = id => document.getElementById(id);
  const CODE_MESSAGES = {
    SSH_NOT_INSTALLED: '未找到 ssh 命令，请先安装 OpenSSH 客户端',
    SSH_HOST_REQUIRED: '请先填写服务器 IP 或域名', SSH_USER_REQUIRED: '请先填写用户名',
    SSH_HOST_INVALID: '服务器地址必须是 IP 或域名', SSH_USER_INVALID: '用户名格式不正确',
    SSH_PORT_INVALID: 'SSH 端口必须是 1-65535 的整数', SSH_REMOTE_PORT_INVALID: '远程端口必须是 1-65535 的整数',
    SSH_KEY_INVALID: '私钥路径必须是绝对路径或以 ~/ 开头', SSH_KEY_NOT_FOUND: '找不到私钥文件，请检查路径；留空则使用 ssh 默认逻辑',
    SSH_ALREADY_RUNNING: '隧道已经在运行', SSH_START_FAILED: '无法启动 ssh', SSH_BODY_INVALID: '请求内容不正确',
    SSH_UNAVAILABLE: 'SSH 隧道服务暂时不可用',
  };
  const STATUS_LABELS = { stopped: '已停止', starting: '连接中…', running: '运行中', failed: '失败' };
  let active = false, timer = null, busy = false, editing = false, last = null, remotePortEdited = false;

  const errorText = error => {
    let code = error.message;
    try { const parsed = JSON.parse(error.message); code = parsed.error || code; } catch { /* 不是 JSON */ }
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
    if (!data.installed) extra.push('未检测到 ssh 命令');
    if (data.error) extra.push(data.error);
    if (data.config.serverAddress) extra.push(`服务器上监听 ${data.config.serverAddress}，转发到本机 ${data.config.effectiveLocalPort}`);
    if (extra.length) line.append(document.createTextNode(extra.join(' · ')));
  }

  function renderRemoteHint(config) {
    $('ssh-remote-port-label').textContent = config.remotePortManual ? '远程端口（手动）' : '远程端口（自动随机）';
    $('ssh-remote-hint').textContent = config.remotePortManual
      ? '已手动指定：被占用时不会自动换端口。清空后保存恢复自动随机。'
      : '自动随机（20000-60000），生成后保持稳定；也可直接填写固定端口。';
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
    $('ssh-start').textContent = data.status === 'running' || data.status === 'starting' ? '保存并重启' : '保存并启动';
    if (form && !editing) fillForm(data.config);
    else if (!remotePortEdited) { $('ssh-remote-port').value = data.config.remotePort || ''; renderRemoteHint(data.config); }
    const log = $('ssh-log');
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.textContent = data.logs.length ? data.logs.join('\n') : '（暂无日志）';
    if (stick) log.scrollTop = log.scrollHeight;
  }

  async function refresh() {
    if (busy || !active) return;
    busy = true;
    try { render(await API.get('/api/ssh-tunnel')); } catch (error) { say(`读取失败：${errorText(error)}`, true); } finally { busy = false; }
  }

  function formBody() {
    const body = {
      host: $('ssh-host').value.trim(),
      username: $('ssh-user').value.trim(),
      // 私钥路径始终提交：清空即恢复 ssh 默认逻辑。
      keyPath: $('ssh-key').value.trim(),
      sshPort: $('ssh-port').value.trim(),
      bindAll: $('ssh-bind-all').checked,
      autoStart: $('ssh-auto-start').checked,
    };
    // 只有改过这个输入框才提交：否则每次保存都会把自动生成的端口变成“手动”。
    if (remotePortEdited) body.remotePort = $('ssh-remote-port').value.trim();
    return body;
  }

  async function run(action, label) {
    busy = true;
    say(`正在${label}…`);
    try {
      const saved = await API.put('/api/ssh-tunnel/config', formBody());
      render(saved, { form: false });
      editing = false;
      if (action === 'start' && saved.status !== 'stopped') render(await API.post('/api/ssh-tunnel/stop', {}), { form: false });
      render(action ? await API.post(`/api/ssh-tunnel/${action}`, {}) : saved);
      say(`已${label}`);
    } catch (error) {
      say(`${label}失败：${errorText(error)}`, true);
    } finally { busy = false; }
  }

  $('ssh-form').addEventListener('submit', event => { event.preventDefault(); run(null, '保存'); });
  $('ssh-start').addEventListener('click', () => run('start', '启动'));
  $('ssh-form').addEventListener('input', () => { editing = true; });
  $('ssh-remote-port').addEventListener('input', () => { remotePortEdited = true; });
  $('ssh-stop').addEventListener('click', async () => {
    busy = true;
    try { render(await API.post('/api/ssh-tunnel/stop', {}), { form: false }); say('已停止'); } catch (error) { say(`停止失败：${errorText(error)}`, true); } finally { busy = false; }
  });
  $('ssh-regenerate').addEventListener('click', async () => {
    const running = last && last.status !== 'stopped';
    if (running && !confirm('重新生成远程端口会重启隧道，之前的反向代理目标需要同步修改。继续吗？')) return;
    busy = true;
    remotePortEdited = false;
    try { render(await API.post('/api/ssh-tunnel/regenerate-port', {}), { form: false }); say('已生成新的远程端口'); } catch (error) { say(`操作失败：${errorText(error)}`, true); } finally { busy = false; }
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
