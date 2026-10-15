// 终端底部的中译英输入框：中文 → DeepSeek / 智谱 GLM 翻译成英文 → 键入当前终端并回车。翻译在 Client 上进行，远程终端同样可用。
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

  function say(message, isError = false) {
    status.className = `terminal-translate-status${isError ? ' error' : ''}`;
    status.textContent = message;
  }
  function setBusy(value) {
    busy = value;
    // 翻译中：输入框只读（保持焦点）并呼吸闪烁，指示就在输入框这一行，不再另起一行文字。
    input.readOnly = send.disabled = value;
    input.classList.toggle('translating', value);
    input.setAttribute('aria-busy', String(value));
  }

  async function submit() {
    const source = input.value.trim();
    if (busy || !source) return;
    setBusy(true);
    say('');
    try {
      const result = await API.post('/api/translate', { text: source });
      const text = sanitize(result.text);
      if (!text) throw new Error('翻译结果为空');
      if (!window.Tasks || !Tasks.sendTerminalInput(text)) throw new Error('终端未连接，译文未发送');
      setTimeout(() => { Tasks.sendTerminalInput('\r'); input.focus(); }, SUBMIT_DELAY_MS);
      say(''); // 成功时不显示译文，终端里已经能看到
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
    const providers = config.providers || {};
    const ids = Object.keys(providers);
    const drafts = {}; // 切换服务商时保留已输入但尚未保存的内容
    let current = config.provider || ids[0];
    Modal.show('翻译设置', `
      <div class="form-group"><label class="form-label" for="tr-provider">翻译服务</label>
        <select class="form-input" id="tr-provider">${ids.map(id => `<option value="${escapeHtml(id)}"${id === current ? ' selected' : ''}>${escapeHtml(providers[id].label)}${providers[id].hasApiKey ? '（已保存 Key）' : ''}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label" for="tr-key">API Key</label>
        <input class="form-input" id="tr-key" type="password" autocomplete="new-password"></div>
      <div class="form-group"><label class="form-label" for="tr-url">接口地址</label>
        <input class="form-input" id="tr-url"></div>
      <div class="form-group"><label class="form-label" for="tr-model">模型</label>
        <input class="form-input" id="tr-model"></div>
      <div class="form-hint">每个服务商的 Key 分别加密保存在 Client 上，切换服务商不会丢失已保存的 Key，也不会发给浏览器或远程引擎。保存后使用当前选中的服务商。只翻译含中文的输入，纯英文原样发送。翻译在 Client 上进行，远程引擎的终端同样可用。</div>
      <p id="tr-feedback" role="status"></p>
      <div class="form-actions"><button class="btn-cancel" id="tr-clear" type="button">删除全部配置</button><button class="btn-cancel" id="tr-cancel" type="button">取消</button><button class="btn-submit" id="tr-save" type="button">保存</button></div>`);
    const field = id => document.getElementById(id);
    const fill = id => {
      const saved = providers[id] || {};
      const draft = drafts[id] || {};
      field('tr-key').value = draft.apiKey || '';
      field('tr-key').placeholder = saved.hasApiKey ? '已保存，留空保持不变' : 'API Key';
      field('tr-url').value = draft.baseUrl !== undefined ? draft.baseUrl : (saved.baseUrl || '');
      field('tr-model').value = draft.model !== undefined ? draft.model : (saved.model || '');
    };
    const remember = () => { drafts[current] = { apiKey: field('tr-key').value, baseUrl: field('tr-url').value, model: field('tr-model').value }; };
    fill(current);
    field('tr-provider').addEventListener('change', () => { remember(); current = field('tr-provider').value; fill(current); });
    field('tr-cancel').addEventListener('click', Modal.hide);
    const feedback = field('tr-feedback');
    field('tr-save').addEventListener('click', async () => {
      try {
        await API.put('/api/translate/config', { provider: current, apiKey: field('tr-key').value.trim(), baseUrl: field('tr-url').value.trim(), model: field('tr-model').value.trim() });
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
