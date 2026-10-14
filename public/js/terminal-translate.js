// 终端底部的中译英输入框：中文 → DeepSeek 翻译成英文 → 键入当前终端并回车。翻译在 Client 上进行，远程终端同样可用。
const TerminalTranslate = (() => {
  const SUBMIT_DELAY_MS = 120; // 先写入文字，稍等再回车，避免被 TUI 当成粘贴里的换行

  // 译文里的控制字符（含 ESC）不能原样送进终端，否则翻译结果可以注入按键序列；多行压成一行，避免提前提交。
  const CONTROLS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');
  const sanitize = value => String(value).replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  const errorText = error => {
    let message = (error && error.message) || '翻译失败';
    try { message = JSON.parse(message).error || message; } catch { /* 保持原文 */ }
    return message;
  };

  if (typeof document === 'undefined') return { sanitize };
  const form = document.getElementById('terminal-translate');
  const input = document.getElementById('terminal-translate-input');
  const send = document.getElementById('terminal-translate-send');
  const status = document.getElementById('terminal-translate-status');
  const settingsButton = document.getElementById('terminal-translate-settings');
  let busy = false;

  function say(message, isError = false, translated = '') {
    status.className = `terminal-translate-status${isError ? ' error' : ''}`;
    status.textContent = '';
    if (translated) {
      status.append('已发送：');
      const code = document.createElement('code');
      code.textContent = translated;
      status.append(code);
    } else status.textContent = message;
  }
  function setBusy(value) {
    busy = value;
    input.disabled = send.disabled = value;
    send.textContent = value ? '翻译中…' : '翻译并发送';
  }

  async function submit() {
    const source = input.value.trim();
    if (busy || !source) return;
    setBusy(true);
    say('正在翻译…');
    try {
      const result = await API.post('/api/translate', { text: source });
      const text = sanitize(result.text);
      if (!text) throw new Error('翻译结果为空');
      if (!window.Tasks || !Tasks.sendTerminalInput(text)) throw new Error('终端未连接，译文未发送');
      setTimeout(() => { Tasks.sendTerminalInput('\r'); input.focus(); }, SUBMIT_DELAY_MS);
      say('', false, text);
      input.value = '';
    } catch (error) {
      const message = errorText(error);
      say(message, true);
      if (message.includes('尚未配置')) showSettings();
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  async function showSettings() {
    let config;
    try { config = await API.get('/api/translate/config'); } catch (error) { alert('读取翻译设置失败：' + errorText(error)); return; }
    Modal.show('翻译设置（DeepSeek）', `
      <div class="form-group"><label class="form-label" for="tr-key">DeepSeek API Key</label>
        <input class="form-input" id="tr-key" type="password" autocomplete="new-password" placeholder="${config.hasApiKey ? '已保存，留空保持不变' : 'sk-…'}"></div>
      <div class="form-group"><label class="form-label" for="tr-url">接口地址</label>
        <input class="form-input" id="tr-url" value="${escapeHtml(config.baseUrl || '')}"></div>
      <div class="form-group"><label class="form-label" for="tr-model">模型</label>
        <input class="form-input" id="tr-model" value="${escapeHtml(config.model || '')}"></div>
      <div class="form-hint">密钥加密保存在 Client 上，不会发给浏览器或远程引擎。只翻译含中文的输入，纯英文原样发送。翻译在 Client 上进行，远程引擎的终端同样可用。</div>
      <p id="tr-feedback" role="status"></p>
      <div class="form-actions"><button class="btn-cancel" id="tr-clear" type="button">删除配置</button><button class="btn-cancel" id="tr-cancel" type="button">取消</button><button class="btn-submit" id="tr-save" type="button">保存</button></div>`);
    document.getElementById('tr-cancel').addEventListener('click', Modal.hide);
    const feedback = document.getElementById('tr-feedback');
    document.getElementById('tr-save').addEventListener('click', async () => {
      try {
        await API.put('/api/translate/config', { apiKey: document.getElementById('tr-key').value.trim(), baseUrl: document.getElementById('tr-url').value.trim(), model: document.getElementById('tr-model').value.trim() });
        Modal.hide();
        say('翻译设置已保存');
      } catch (error) { feedback.textContent = '保存失败：' + errorText(error); }
    });
    document.getElementById('tr-clear').addEventListener('click', async () => {
      try { await API.delete('/api/translate/config'); Modal.hide(); say('翻译设置已删除'); }
      catch (error) { feedback.textContent = '删除失败：' + errorText(error); }
    });
  }

  if (form) {
    form.addEventListener('submit', event => { event.preventDefault(); if (!event.isComposing) submit(); });
    // 输入法选词时的回车不能当成提交。
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.stopPropagation();
    });
    settingsButton.addEventListener('click', showSettings);
  }
  return { sanitize, submit, showSettings };
})();
window.TerminalTranslate = TerminalTranslate;
