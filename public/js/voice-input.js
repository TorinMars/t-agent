// Voice input for the text box above the terminal. The microphone is captured in the browser, resampled to 16 kHz mono 16-bit PCM and streamed over the browser's own WebSocket straight to Alibaba Cloud real-time speech recognition (Fun-ASR), so the audio uses no bandwidth of the Client server.
// The server only keeps the settings and mints a short-lived token (POST /api/speech/token); the real API key never reaches the browser.
// The recognized text is typed into the box (live while speaking); the user reads it and presses Enter as usual, so nothing is translated or sent to the terminal without a review.
const VoiceInput = (() => {
  const TARGET_RATE = 16000;
  const FRAME_SAMPLES = 1600; // 100 ms per WebSocket frame
  const MAX_SESSION_MS = 5 * 60 * 1000; // a forgotten microphone must not run up the bill
  const MAX_PENDING_BYTES = TARGET_RATE * 2 * 10; // audio kept while the task is starting: at most 10 seconds
  const FINISH_TIMEOUT_MS = 8000;
  const STOP_TIMEOUT_MS = 10000;
  const WORKLET = 'registerProcessor("pcm-capture", class extends AudioWorkletProcessor { process(inputs) { const channel = inputs[0] && inputs[0][0]; if (channel) this.port.postMessage(channel.slice()); return true; } });';

  // Converts a stream of Float32 microphone blocks at inRate into Int16 samples at outRate (linear interpolation); the tail of a block is kept for the next call.
  function createResampler(inRate, outRate = TARGET_RATE) {
    const ratio = inRate / outRate;
    let rest = new Float32Array(0);
    let position = 0;
    return {
      push(input) {
        const joined = new Float32Array(rest.length + input.length);
        joined.set(rest);
        joined.set(input, rest.length);
        const out = [];
        while (position + 1 < joined.length) {
          const index = Math.floor(position);
          const fraction = position - index;
          const value = Math.max(-1, Math.min(1, joined[index] * (1 - fraction) + joined[index + 1] * fraction));
          out.push(value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff));
          position += ratio;
        }
        // The next output position can lie beyond this block; keep it relative to the next block instead of losing the samples in between.
        const drop = Math.min(Math.floor(position), joined.length);
        rest = joined.slice(drop);
        position -= drop;
        return Int16Array.from(out);
      },
    };
  }

  // Text shown in the box: what was there before recording, the finished sentences and the sentence still being recognized.
  const compose = (base, committed, partial) => base + committed + partial;

  // One recognition task on the speech service (run-task → task-started → audio → finish-task → task-finished).
  // callbacks: onReady(), onResult({ text, sentenceId, final }), onDone(), onError(message). Returns { sendAudio, finish, close }.
  function createRecognizer({ url, token, model, language, WebSocketImpl = WebSocket, callbacks }) {
    const taskId = crypto.randomUUID();
    const frame = (action, payload) => JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload });
    let state = 'connecting'; // connecting → starting → ready → finishing → closed
    let pending = [];
    let pendingBytes = 0;
    let finishRequested = false;
    let finishTimer;
    // The browser cannot set an Authorization header on a WebSocket, so the service accepts the token as a query parameter.
    const ws = new WebSocketImpl(`${url}?api_key=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';

    function close() {
      if (state === 'closed') return;
      state = 'closed';
      clearTimeout(finishTimer);
      pending = [];
      try { ws.close(); } catch { /* already closed */ }
    }
    function fail(message) {
      if (state === 'closed') return;
      const wasConnecting = state === 'connecting' || state === 'starting';
      close();
      callbacks.onError(wasConnecting && !message ? 'Cannot reach the speech recognition service' : message);
    }
    function sendFinish() {
      state = 'finishing';
      ws.send(frame('finish-task', { input: {} }));
      finishTimer = setTimeout(() => fail('Speech recognition did not finish in time'), FINISH_TIMEOUT_MS);
    }

    ws.onopen = () => {
      if (state !== 'connecting') return;
      state = 'starting';
      const parameters = { format: 'pcm', sample_rate: TARGET_RATE };
      if (language) parameters.language_hints = [language];
      ws.send(frame('run-task', { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters, input: {} }));
    };
    ws.onmessage = event => {
      if (typeof event.data !== 'string' || state === 'closed') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const name = message && message.header && message.header.event;
      if (name === 'task-started') {
        state = 'ready';
        for (const chunk of pending) ws.send(chunk);
        pending = []; pendingBytes = 0;
        callbacks.onReady();
        if (finishRequested) sendFinish();
      } else if (name === 'result-generated') {
        const sentence = message.payload && message.payload.output && message.payload.output.sentence;
        if (!sentence || sentence.heartbeat || typeof sentence.text !== 'string') return;
        callbacks.onResult({ text: sentence.text, sentenceId: sentence.sentence_id, final: sentence.sentence_end === true });
      } else if (name === 'task-finished') {
        close();
        callbacks.onDone();
      } else if (name === 'task-failed') {
        const reason = String(message.header.error_message || message.header.error_code || 'unknown error').slice(0, 200);
        fail(`Speech recognition failed: ${reason}`);
      }
    };
    ws.onerror = () => fail('Cannot reach the speech recognition service; check the network');
    ws.onclose = () => fail('The speech recognition connection closed unexpectedly');

    return {
      sendAudio(chunk) {
        if (state === 'ready') ws.send(chunk);
        else if ((state === 'connecting' || state === 'starting') && pendingBytes + chunk.byteLength <= MAX_PENDING_BYTES) { pending.push(chunk); pendingBytes += chunk.byteLength; }
      },
      finish() {
        if (finishRequested || state === 'closed') return;
        finishRequested = true;
        if (state === 'ready') sendFinish();
      },
      close,
    };
  }

  if (typeof document === 'undefined') return { createResampler, createRecognizer, compose };

  const tell = (message, type) => (typeof notify === 'function' ? notify(message, type) : (typeof alert === 'function' ? alert(message) : undefined));
  // The phone page does not load app.js (where API lives), so the recording asks for its token with its own request.
  async function requestToken() {
    const res = await fetch('/api/speech/token', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: '{}' });
    const body = await res.text();
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch { /* plain-text error */ }
    if (!res.ok) throw new Error((data && data.error) || body || `HTTP ${res.status}`);
    return data;
  }
  const errorText = error => {
    let message = (error && error.message) || 'Voice input failed';
    try { message = JSON.parse(message).error || message; } catch { /* keep the original text */ }
    return message;
  };

  // textarea: the box to fill; button: the microphone toggle; onNotConfigured: called when the server has no speech key yet.
  function attach({ textarea, button, onNotConfigured }) {
    let state = 'idle'; // idle → connecting → listening → stopping → idle
    let recognizer, stream, context, node, silent, resampler, stopTimer, limitTimer;
    let base = '', committed = '', partial = '';
    let frame = new Int16Array(FRAME_SAMPLES);
    let filled = 0;
    let run = 0; // identifies the current start; an older start that is still waiting must not touch a newer one

    function render() {
      const active = state === 'listening' || state === 'connecting';
      button.classList.toggle('listening', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = state === 'stopping';
      button.title = state === 'idle' ? 'Voice input: click to start speaking' : 'Voice input: click to stop';
    }
    function show() {
      textarea.value = compose(base, committed, partial);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function release() { // stop the microphone and the audio graph
      if (node) { node.port.onmessage = null; try { node.disconnect(); } catch { /* already disconnected */ } }
      if (silent) { try { silent.disconnect(); } catch { /* already disconnected */ } }
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (context && context.state !== 'closed') context.close().catch(() => {});
      node = silent = stream = context = null;
    }
    function reset() {
      run += 1;
      clearTimeout(stopTimer);
      clearTimeout(limitTimer);
      release();
      if (recognizer) recognizer.close();
      recognizer = null;
      state = 'idle';
      render();
    }
    function fail(message) {
      reset();
      tell(message, 'error');
      if (/not configured/i.test(message) && onNotConfigured) onNotConfigured();
    }
    function finishText() { committed += partial; partial = ''; show(); }
    function send(samples) {
      for (let i = 0; i < samples.length; i += 1) {
        frame[filled] = samples[i];
        filled += 1;
        if (filled === FRAME_SAMPLES) {
          if (recognizer) recognizer.sendAudio(frame.buffer.slice(0));
          filled = 0;
        }
      }
    }

    async function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
        tell('Voice input needs a secure page: open this page over HTTPS or at localhost', 'error');
        return;
      }
      state = 'connecting';
      run += 1;
      const mine = run;
      base = textarea.value; committed = ''; partial = '';
      filled = 0;
      render();
      // Create the audio context inside the click, before any await, so iOS Safari lets it run.
      const Context = window.AudioContext || window.webkitAudioContext;
      context = new Context();
      context.resume().catch(() => {});
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        if (mine !== run) { release(); return; }
        // Fetch the token only now: it is valid for a minute, and the permission prompt can take longer than that.
        const grant = await requestToken();
        if (mine !== run) { release(); return; }
        recognizer = createRecognizer({
          url: grant.url, token: grant.token, model: grant.model, language: grant.language,
          callbacks: {
            onReady() { if (mine === run) { state = 'listening'; render(); } },
            onResult(result) {
              if (mine !== run) return;
              if (result.final) { committed += result.text; partial = ''; } else partial = result.text;
              show();
            },
            onDone() { if (mine !== run) return; finishText(); reset(); textarea.focus(); },
            onError(message) { if (mine === run) fail(message); },
          },
        });
        await context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
        if (mine !== run) { release(); return; }
        resampler = createResampler(context.sampleRate);
        node = new AudioWorkletNode(context, 'pcm-capture');
        node.port.onmessage = event => send(resampler.push(event.data));
        silent = context.createGain();
        silent.gain.value = 0; // keeps the graph pulled without playing the microphone back
        context.createMediaStreamSource(stream).connect(node);
        node.connect(silent);
        silent.connect(context.destination);
        limitTimer = setTimeout(stop, MAX_SESSION_MS);
      } catch (error) {
        if (mine !== run) return;
        const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
        fail(denied ? 'Microphone access was denied; allow it in the browser settings' : (error && error.name ? `Cannot start the microphone: ${errorText(error)}` : errorText(error)));
      }
    }

    function stop() {
      if (state !== 'listening' && state !== 'connecting') return;
      if (state === 'connecting' || !recognizer) { reset(); return; }
      state = 'stopping';
      clearTimeout(limitTimer);
      render();
      release(); // no more audio after this point
      if (filled) recognizer.sendAudio(frame.slice(0, filled).buffer); // the last partial frame
      filled = 0;
      recognizer.finish();
      stopTimer = setTimeout(() => { finishText(); reset(); }, STOP_TIMEOUT_MS); // the service did not answer: keep what was recognized so far
    }

    button.addEventListener('click', () => { if (state === 'idle') void start(); else stop(); });
    render();
    return { start, stop, get state() { return state; } };
  }

  async function showSettings() {
    let config;
    try { config = await API.get('/api/speech/config'); } catch (error) { tell('Could not read voice input settings: ' + errorText(error), 'error'); return; }
    const options = (map, selected) => Object.entries(map).map(([id, item]) => `<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(typeof item === 'string' ? item : item.label)}</option>`).join('');
    const keyHint = config.keySource === 'saved' ? 'Saved; leave empty to keep it' : (config.keySource === 'environment' ? 'Using DASHSCOPE_API_KEY from the server; enter a key here to override it' : 'API Key');
    Modal.show('Voice input settings', `
      <div class="form-group"><label class="form-label" for="vi-key">Alibaba Cloud API Key</label>
        <input class="form-input" id="vi-key" type="password" autocomplete="new-password" placeholder="${escapeHtml(keyHint)}"></div>
      <div class="form-group"><label class="form-label" for="vi-region">Region</label>
        <select class="form-input" id="vi-region">${options(config.regions, config.region)}</select></div>
      <div class="form-group"><label class="form-label" for="vi-language">Language</label>
        <select class="form-input" id="vi-language">${options(config.languages, config.language)}</select></div>
      <div class="form-group"><label class="form-label" for="vi-model">Model</label>
        <input class="form-input" id="vi-model" value="${escapeHtml(config.model)}"></div>
      <div class="form-group"><label class="form-label" for="vi-url">Endpoint (optional)</label>
        <input class="form-input" id="vi-url" value="${escapeHtml(config.endpoint)}"></div>
      <div class="form-hint" id="vi-effective"></div>
      <div class="form-hint">The key is stored encrypted on the client. The browser never receives it: it gets a one-minute token and sends the audio straight to Alibaba Cloud Model Studio, so no audio goes through the client server. Keys are specific to a region, so choose the region the key was created in. Leave the endpoint empty to use the region’s address.</div>
      <p id="vi-feedback" role="status"></p>
      <div class="form-actions"><button class="btn-cancel" id="vi-clear" type="button">Delete all settings</button><button class="btn-cancel" id="vi-cancel" type="button">Cancel</button><button class="btn-submit" id="vi-save" type="button">Save</button></div>`);
    const field = id => document.getElementById(id);
    const effective = () => {
      const custom = field('vi-url').value.trim();
      field('vi-effective').textContent = 'Address in use: ' + (custom || config.regions[field('vi-region').value].endpoint);
    };
    effective();
    field('vi-region').addEventListener('change', effective);
    field('vi-url').addEventListener('input', effective);
    field('vi-cancel').addEventListener('click', Modal.hide);
    const feedback = field('vi-feedback');
    field('vi-save').addEventListener('click', async () => {
      try {
        await API.put('/api/speech/config', { apiKey: field('vi-key').value.trim(), region: field('vi-region').value, language: field('vi-language').value, model: field('vi-model').value.trim(), endpoint: field('vi-url').value.trim() });
        Modal.hide();
        tell('Voice input settings saved', 'info');
      } catch (error) { feedback.textContent = 'Save failed: ' + errorText(error); }
    });
    field('vi-clear').addEventListener('click', async () => {
      try { await API.delete('/api/speech/config'); Modal.hide(); tell('Voice input settings deleted', 'info'); }
      catch (error) { feedback.textContent = 'Delete failed: ' + errorText(error); }
    });
  }

  // Desktop page: the microphone and settings buttons next to the Chinese input box.
  const input = document.getElementById('terminal-translate-input');
  const mic = document.getElementById('terminal-voice');
  const settings = document.getElementById('terminal-voice-settings');
  if (input && mic) attach({ textarea: input, button: mic, onNotConfigured: showSettings });
  if (settings) settings.addEventListener('click', showSettings);
  // Phone page: settings live on the desktop page, like the translation settings.
  const h5Input = document.getElementById('h5-translate-input');
  const h5Mic = document.getElementById('h5-voice');
  if (h5Input && h5Mic) attach({ textarea: h5Input, button: h5Mic, onNotConfigured: () => tell('Set up voice input on the desktop page', 'info') });

  return { attach, showSettings, createResampler, createRecognizer, compose };
})();
if (typeof window !== 'undefined') window.VoiceInput = VoiceInput;
if (typeof module !== 'undefined' && module.exports) module.exports = VoiceInput;
