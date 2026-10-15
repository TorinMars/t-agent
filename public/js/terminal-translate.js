// Chinese-to-English input at the bottom of the terminal: Chinese → DeepSeek / Zhipu GLM translates it to English → typed into the current terminal followed by Enter. Translation runs on the Client, so remote terminals work too.
const TerminalTranslate = (() => {
  const tell = (message, type) => (typeof notify === 'function' ? notify(message, type) : (typeof alert === 'function' ? alert(message) : undefined)); // floating notice; falls back to alert where toast.js is not loaded
  const SUBMIT_DELAY_MS = 120; // Write the text first, then press Enter after a short delay so a TUI does not treat it as a newline inside a paste.

  // Control characters (including ESC) in the translation must not go into the terminal as-is, otherwise a translation result could inject key sequences; multiple lines are collapsed into one so nothing is submitted early.
  const CONTROLS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');
  const sanitize = value => String(value).replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  const errorText = error => {
    let message = (error && error.message) || 'Translation failed';
    try { message = JSON.parse(message).error || message; } catch { /* keep the original text */ }
    return message;
  };

  if (typeof document === 'undefined') return { sanitize };
  const form = document.getElementById('terminal-translate');
  const input = document.getElementById('terminal-translate-input');
  const send = document.getElementById('terminal-translate-send');
  const settingsButton = document.getElementById('terminal-translate-settings');
  let busy = false;

  // All messages use floating notices and take no toolbar space; empty text (clearing the message) needs no action.
  function say(message, isError = false) {
    if (message) tell(message, isError ? 'error' : 'info');
  }
  function setBusy(value) {
    busy = value;
    // While translating: the input is read-only (keeping focus) and pulses; the indication is on the input row itself instead of an extra line of text.
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
      if (!text) throw new Error('Translation result is empty');
      if (!window.Tasks || !Tasks.sendTerminalInput(text)) throw new Error('Terminal not connected; translation was not sent');
      setTimeout(() => { Tasks.sendTerminalInput('\r'); input.focus(); }, SUBMIT_DELAY_MS);
      say(''); // on success the translation is not shown, it is already visible in the terminal
      input.value = '';
    } catch (error) {
      const message = errorText(error);
      say(message, true);
      if (/not configured/i.test(message)) showSettings();
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  async function showSettings() {
    let config;
    try { config = await API.get('/api/translate/config'); } catch (error) { tell('Could not read translation settings: ' + errorText(error), 'error'); return; }
    const providers = config.providers || {};
    const ids = Object.keys(providers);
    const drafts = {}; // keep input that has not been saved yet when switching providers
    let current = config.provider || ids[0];
    Modal.show('Translation settings', `
      <div class="form-group"><label class="form-label" for="tr-provider">Translation service</label>
        <select class="form-input" id="tr-provider">${ids.map(id => `<option value="${escapeHtml(id)}"${id === current ? ' selected' : ''}>${escapeHtml(providers[id].label)}${providers[id].hasApiKey ? '(Key saved)' : ''}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label" for="tr-key">API Key</label>
        <input class="form-input" id="tr-key" type="password" autocomplete="new-password"></div>
      <div class="form-group"><label class="form-label" for="tr-url">Endpoint</label>
        <input class="form-input" id="tr-url"></div>
      <div class="form-group"><label class="form-label" for="tr-model">Model</label>
        <input class="form-input" id="tr-model"></div>
      <div class="form-hint">Each provider’s key is stored encrypted on the client. Switching providers keeps saved keys, and they are never sent to the browser or remote engines. The selected provider is used after saving. Only input containing Chinese is translated; plain English is sent as-is. Translation runs on the client, so terminals on remote engines work too.</div>
      <p id="tr-feedback" role="status"></p>
      <div class="form-actions"><button class="btn-cancel" id="tr-clear" type="button">Delete all settings</button><button class="btn-cancel" id="tr-cancel" type="button">Cancel</button><button class="btn-submit" id="tr-save" type="button">Save</button></div>`);
    const field = id => document.getElementById(id);
    const fill = id => {
      const saved = providers[id] || {};
      const draft = drafts[id] || {};
      field('tr-key').value = draft.apiKey || '';
      field('tr-key').placeholder = saved.hasApiKey ? 'Saved; leave empty to keep it' : 'API Key';
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
        say('Translation settings saved');
      } catch (error) { feedback.textContent = 'Save failed: ' + errorText(error); }
    });
    document.getElementById('tr-clear').addEventListener('click', async () => {
      try { await API.delete('/api/translate/config'); Modal.hide(); say('Translation settings deleted'); }
      catch (error) { feedback.textContent = 'Delete failed: ' + errorText(error); }
    });
  }

  if (form) {
    form.addEventListener('submit', event => { event.preventDefault(); if (!event.isComposing) submit(); });
    // Enter pressed while picking an IME candidate must not count as a submit.
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.stopPropagation();
    });
    settingsButton.addEventListener('click', showSettings);
  }
  return { sanitize, submit, showSettings };
})();
window.TerminalTranslate = TerminalTranslate;
