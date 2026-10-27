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
  const HIGH_PASS_HZ = 100;
  const HOLD_MS = 350; // a press shorter than this is a tap, not a long press
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
  function createRecognizer({ url, token, model, language, noiseThreshold, vocabularyId, hotwords, WebSocketImpl = WebSocket, callbacks }) {
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
      if (typeof noiseThreshold === 'number') parameters.speech_noise_threshold = noiseThreshold; // how sure the service must be that a sound is speech, not noise
      if (vocabularyId) parameters.vocabulary_id = vocabularyId; // a hot word list made in advance
      // Words to favor go in as context: a user message of type input_text (the service reads at most 400 characters).
      const input = hotwords ? { context: [{ role: 'user', content: [{ type: 'input_text', text: hotwords }] }] } : {};
      ws.send(frame('run-task', { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters, input }));
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

  // A small sound wave that floats above the microphone button while a recording runs, so the person sees the voice is heard.
  // The hold-to-talk phone page has its own meter (voice-overlay.js) and does not use this.
  const WAVE_BARS = 16;
  function createWave(button) {
    let root, bars, levels = new Array(WAVE_BARS).fill(0);
    function build() {
      if (!document.getElementById('vi-wave-style')) {
        const style = document.createElement('style');
        style.id = 'vi-wave-style';
        style.textContent = '.vi-wave{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:2px;height:32px;padding:0 10px;border-radius:16px;background:rgba(30,30,30,.92);box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none}.vi-wave[hidden]{display:none}.vi-wave i{display:block;width:3px;min-height:3px;border-radius:2px;background:#e5484d;transition:height 60ms linear}';
        document.head.append(style);
      }
      root = document.createElement('div');
      root.className = 'vi-wave';
      root.hidden = true;
      root.setAttribute('aria-hidden', 'true');
      bars = Array.from({ length: WAVE_BARS }, () => { const bar = document.createElement('i'); root.append(bar); return bar; });
      document.body.append(root);
    }
    function paint() { bars.forEach((bar, index) => { bar.style.height = `${Math.max(3, Math.round(levels[index] * 24))}px`; }); }
    function place() {
      const box = button.getBoundingClientRect();
      const width = root.offsetWidth || 90;
      root.style.left = `${Math.max(4, Math.min(window.innerWidth - width - 4, box.left + box.width / 2 - width / 2))}px`;
      root.style.top = `${Math.max(4, box.top - 38)}px`;
    }
    return {
      show() { // cosmetic only: a failure here must never stop the recording
        try { if (!root) build(); levels = new Array(WAVE_BARS).fill(0); paint(); root.hidden = false; place(); } catch { root = null; }
      },
      hide() { if (root) root.hidden = true; },
      // `rms` is the loudness of one audio block, 0 to 1.
      level(rms) {
        if (!root || root.hidden) return;
        levels.shift();
        levels.push(Math.min(1, Math.sqrt(rms) * 1.6));
        paint();
      },
    };
  }

  // textarea: the box to fill; button: the microphone toggle; onNotConfigured: called when the server has no speech key yet.
  // readySound: play a short chime once the recording is ready (the speech service answered and the microphone is connected), so the person knows when to speak.
  function attach({ textarea, button, onNotConfigured, hold = false, overlay = null, onSend = null, readySound = false }) {
    let state = 'idle'; // idle → connecting → listening → stopping → idle
    let recognizer, stream, context, node, silent, resampler, stopTimer, limitTimer;
    let base = '', committed = '', partial = '';
    let frame = new Int16Array(FRAME_SAMPLES);
    let filled = 0;
    let afterStop = null; // 'send': when the recognition ends, hand the text to onSend (released over the send zone)
    let run = 0; // identifies the current start; an older start that is still waiting must not touch a newer one
    const wave = overlay ? null : createWave(button);
    let early = [], earlyBytes = 0, stopAfterToken = false; // audio recorded before the recognizer exists (the token is still being fetched)
    let recognizerReady = false, graphReady = false, announced = false, mutedUntil = 0;
    const waiters = []; // finish() calls that wait for the recording to be over
    // The chime comes out of the speakers, so the microphone is not listened to while it plays and the chime is not recognized as speech.
    function chime() {
      try {
        const at = context.currentTime;
        const tone = context.createOscillator();
        const gain = context.createGain();
        tone.type = 'sine';
        tone.frequency.setValueAtTime(880, at);
        tone.frequency.setValueAtTime(1320, at + 0.09);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.25, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
        tone.connect(gain);
        gain.connect(context.destination);
        tone.start(at);
        tone.stop(at + 0.22);
        mutedUntil = Date.now() + 350;
      } catch { /* no sound: the recording still works */ }
    }
    function announce() {
      if (!readySound || announced || !recognizerReady || !graphReady || !context) return;
      announced = true;
      chime();
    }

    function render() {
      const active = state === 'listening' || state === 'connecting';
      button.classList.toggle('listening', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = state === 'stopping';
      if (hold) button.title = 'Voice input: hold to speak, release to stop';
      else button.title = state === 'idle' ? 'Voice input: click to start speaking' : 'Voice input: click to stop';
    }
    function show() {
      textarea.value = compose(base, committed, partial);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function release() { // stop the microphone and the audio graph
      if (wave) wave.hide();
      if (node) { node.port.onmessage = null; try { node.disconnect(); } catch { /* already disconnected */ } }
      if (silent) { try { silent.disconnect(); } catch { /* already disconnected */ } }
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (context && context.state !== 'closed') context.close().catch(() => {});
      node = silent = stream = context = null;
    }
    function reset() {
      run += 1;
      afterStop = null;
      clearTimeout(stopTimer);
      clearTimeout(limitTimer);
      release();
      if (recognizer) recognizer.close();
      recognizer = null;
      early = []; earlyBytes = 0; stopAfterToken = false;
      state = 'idle';
      render();
      while (waiters.length) waiters.shift()();
    }
    function fail(message) {
      reset();
      tell(message, 'error');
      if (/not configured/i.test(message) && onNotConfigured) onNotConfigured();
    }
    function finishText() { committed += partial; partial = ''; show(); }
    // The recognition ended normally: keep the text and, when released over the send zone, send it.
    function settle() {
      const wants = afterStop;
      finishText();
      reset();
      if (wants === 'send' && onSend) onSend();
    }
    // Throw away what this recording recognized and put the box back as it was.
    function cancel() {
      if (state === 'idle') return;
      committed = ''; partial = '';
      show();
      reset();
    }
    // Recording starts at the click; until the token has arrived and the recognizer exists, the audio waits here (at most 10 seconds).
    function emit(chunk) {
      if (recognizer) recognizer.sendAudio(chunk);
      else if (earlyBytes + chunk.byteLength <= MAX_PENDING_BYTES) { early.push(chunk); earlyBytes += chunk.byteLength; }
    }
    function send(samples) {
      for (let i = 0; i < samples.length; i += 1) {
        frame[filled] = samples[i];
        filled += 1;
        if (filled === FRAME_SAMPLES) {
          emit(frame.buffer.slice(0));
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
      filled = 0; early = []; earlyBytes = 0; stopAfterToken = false;
      recognizerReady = graphReady = announced = false; mutedUntil = 0;
      render();
      // Create the audio context inside the click, before any await, so iOS Safari lets it run.
      const Context = window.AudioContext || window.webkitAudioContext;
      context = new Context();
      context.resume().catch(() => {});
      try {
        // Everything slow runs at the same time: the microphone permission, the audio worklet and the token. The microphone is recording
        // as soon as the first two are ready, without waiting for the token.
        let tokenAt = Date.now();
        const tokenRequest = requestToken();
        tokenRequest.catch(() => {}); // handled when it is awaited below
        const moduleLoaded = context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
        moduleLoaded.catch(() => {});
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (mine !== run) { release(); return; }
        await moduleLoaded;
        if (mine !== run) { release(); return; }
        resampler = createResampler(context.sampleRate);
        node = new AudioWorkletNode(context, 'pcm-capture');
        if (wave) wave.show();
        node.port.onmessage = event => {
          if (overlay || wave) {
            let sum = 0;
            for (let i = 0; i < event.data.length; i += 1) sum += event.data[i] * event.data[i];
            const rms = Math.sqrt(sum / (event.data.length || 1));
            if (overlay) overlay.level(rms); else wave.level(rms);
          }
          if (Date.now() < mutedUntil) return; // the chime is playing
          send(resampler.push(event.data));
        };
        silent = context.createGain();
        silent.gain.value = 0; // keeps the graph pulled without playing the microphone back
        // A high-pass filter at 100 Hz takes out the rumble of fans, traffic and handling noise, which carries no speech.
        const source = context.createMediaStreamSource(stream);
        if (context.createBiquadFilter) {
          const filter = context.createBiquadFilter();
          filter.type = 'highpass';
          filter.frequency.value = HIGH_PASS_HZ;
          source.connect(filter);
          filter.connect(node);
        } else source.connect(node);
        node.connect(silent);
        silent.connect(context.destination);
        limitTimer = setTimeout(stop, MAX_SESSION_MS);
        graphReady = true;
        announce();
        // The token is valid for about a minute: when the permission prompt took longer than that, ask for a new one.
        const grant = Date.now() - tokenAt > 40000 ? await requestToken() : await tokenRequest;
        if (mine !== run) return;
        recognizer = createRecognizer({
          url: grant.url, token: grant.token, model: grant.model, language: grant.language, noiseThreshold: grant.noiseThreshold, vocabularyId: grant.vocabularyId, hotwords: grant.hotwords,
          callbacks: {
            onReady() { if (mine === run) { if (state === 'connecting') state = 'listening'; recognizerReady = true; render(); announce(); } },
            onResult(result) {
              if (mine !== run) return;
              if (result.final) { committed += result.text; partial = ''; } else partial = result.text;
              show();
            },
            onDone() { if (mine !== run) return; settle(); if (!onSend) textarea.focus(); },
            onError(message) { if (mine === run) fail(message); },
          },
        });
        for (const chunk of early) recognizer.sendAudio(chunk);
        early = []; earlyBytes = 0;
        if (stopAfterToken) { stopAfterToken = false; recognizer.finish(); }
      } catch (error) {
        if (mine !== run) return;
        const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
        fail(denied ? 'Microphone access was denied; allow it in the browser settings' : (error && error.name ? `Cannot start the microphone: ${errorText(error)}` : errorText(error)));
      }
    }

    function stop() {
      if (state !== 'listening' && state !== 'connecting') return;
      if (!recognizer && !early.length && !filled) { reset(); return; } // nothing was recorded yet
      state = 'stopping';
      clearTimeout(limitTimer);
      render();
      release(); // no more audio after this point
      if (filled) emit(frame.slice(0, filled).buffer); // the last partial frame
      filled = 0;
      if (recognizer) recognizer.finish(); else stopAfterToken = true; // the token has not arrived: finish as soon as the recognizer exists
      stopTimer = setTimeout(settle, STOP_TIMEOUT_MS); // the service did not answer: keep what was recognized so far
    }

    // Ends the recording like a second click on the button and resolves when the recognition is over and the text is in the box (at once when idle). Used when
    // something else needs the final text while the person is still recording, for example the send button.
    function finish() {
      if (state === 'idle') return Promise.resolve();
      const done = new Promise(resolve => waiters.push(resolve));
      stop();
      return done;
    }

    if (hold) {
      // Hold to speak: pressing starts the recording (inside the touch, so iOS lets the audio context run) and letting go ends the
      // recognition, keeping the text. A tap shorter than HOLD_MS is not a long press and is discarded. Keyboard activation
      // (click without a pointer, detail 0) still toggles, because a keyboard cannot hold a button.
      let pressedAt = 0;
      let zone = 'send';
      button.addEventListener('pointerdown', event => {
        if (event.button || state !== 'idle') return;
        pressedAt = Date.now();
        zone = 'send';
        if (button.setPointerCapture) { try { button.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ } }
        if (overlay) overlay.show();
        void start();
      });
      // Sliding onto the Cancel or Convert to Text pill chooses what letting go does.
      button.addEventListener('pointermove', event => {
        if (!pressedAt || !overlay) return;
        const next = overlay.zoneAt(event.clientX, event.clientY);
        if (next !== zone) { zone = next; overlay.zone(zone); }
      });
      const release = () => {
        if (!pressedAt) return;
        const held = Date.now() - pressedAt;
        pressedAt = 0;
        if (overlay) overlay.hide();
        if (held < HOLD_MS || zone === 'cancel') { cancel(); return; }
        afterStop = zone === 'send' && onSend ? 'send' : null;
        stop();
      };
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('contextmenu', event => event.preventDefault());
      button.addEventListener('click', event => { if (event.detail === 0) { if (state === 'idle') void start(); else stop(); } });
    } else {
      button.addEventListener('click', () => { if (state === 'idle') void start(); else stop(); });
    }
    render();
    return { start, stop, finish, cancel, get state() { return state; } };
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
      <div class="form-group"><label class="form-label" for="vi-noise">Noise filter (-1 to 1, optional)</label>
        <input class="form-input" id="vi-noise" type="number" min="-1" max="1" step="0.1" value="${config.noiseThreshold === null ? '' : escapeHtml(String(config.noiseThreshold))}" placeholder="Service default">
        <div class="form-hint">How sure the service must be that a sound is speech and not noise. Closer to 1 filters more noise (try 0.2 to 0.5 in a noisy room) but can cut quiet speech. It cannot tell your voice from other people talking nearby.</div></div>
      <div class="form-group"><label class="form-label" for="vi-hotwords">Hot words (optional)</label>
        <textarea class="form-input" id="vi-hotwords" rows="3" maxlength="400" placeholder="One per line: names, product and code terms">${escapeHtml(config.hotwords)}</textarea></div>
      <div class="form-group"><label class="form-label" for="vi-vocab">Hot word list ID (optional)</label>
        <input class="form-input" id="vi-vocab" value="${escapeHtml(config.vocabularyId)}" placeholder="A list made in advance on Alibaba Cloud"></div>
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
        await API.put('/api/speech/config', { apiKey: field('vi-key').value.trim(), region: field('vi-region').value, language: field('vi-language').value, model: field('vi-model').value.trim(), endpoint: field('vi-url').value.trim(), noiseThreshold: field('vi-noise').value.trim(), hotwords: field('vi-hotwords').value, vocabularyId: field('vi-vocab').value.trim() });
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
  if (h5Input && h5Mic) attach({ textarea: h5Input, button: h5Mic, onNotConfigured: () => tell('Set up voice input on the desktop page', 'info'), hold: true,
    overlay: typeof VoiceOverlay !== 'undefined' ? VoiceOverlay.create() : null,
    onSend: () => { const form = document.getElementById('h5-translate'); if (form && form.requestSubmit) form.requestSubmit(); } });

  return { attach, showSettings, createResampler, createRecognizer, compose };
})();
if (typeof window !== 'undefined') window.VoiceInput = VoiceInput;
if (typeof module !== 'undefined' && module.exports) module.exports = VoiceInput;
