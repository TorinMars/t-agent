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
  // The worklet posts the microphone blocks only while it is on (a message `false` turns it off): a microphone that is only kept ready costs nothing.
  const WORKLET = 'registerProcessor("pcm-capture", class extends AudioWorkletProcessor { constructor() { super(); this.on = true; this.port.onmessage = event => { this.on = event.data !== false; }; } process(inputs) { if (!this.on) return true; const channel = inputs[0] && inputs[0][0]; if (channel) this.port.postMessage(channel.slice()); return true; } });';
  const MIC_CONSTRAINTS = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
  const KEEP_KEY = 'voice-keep-mic';
  const ENABLED_KEY = 'voice-enabled';

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

  // The recognized text is one segment of the box, [start, start + length), placed at the caret when the recording starts. The person may type while
  // speaking: before each update the box is compared with what was last written there, and the segment follows the edit. An edit before the segment (or
  // right at its start) moves it, one after it changes nothing, and an edit inside it makes the text so far the person's own (`inside`: the segment
  // starts again, empty, where that edit ended). Returns { start, length, inside }.
  function follow(shown, current, start, length) {
    if (shown === current) return { start, length, inside: false };
    const tail = shown.slice(start); // the segment and everything after it
    if (current.endsWith(tail)) return { start: current.length - tail.length, length, inside: false };
    if (current.startsWith(shown.slice(0, start + length))) return { start, length, inside: false };
    let suffix = 0; // the end that is still as it was written: the segment starts again just before it
    const room = Math.min(shown.length, current.length);
    while (suffix < room && shown[shown.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix += 1;
    return { start: Math.max(0, current.length - Math.min(suffix, shown.length - start - length)), length: 0, inside: true };
  }

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

  if (typeof document === 'undefined') return { createResampler, createRecognizer, compose, follow };

  const tell = (message, type) => (typeof notify === 'function' ? notify(message, type) : (typeof alert === 'function' ? alert(message) : undefined));
  // The page has no shared API helper, so the recording asks for its token with its own request.
  async function requestToken() {
    const res = await fetch('/api/speech/token', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: '{}' });
    const body = await res.text();
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch { /* plain-text error */ }
    // `linked`: nothing is wrong with the microphone, so the message is shown as it is.
    if (!res.ok) throw Object.assign(new Error((typeof I18n !== 'undefined' ? I18n.errorOf(data) : data && data.error) || body || `HTTP ${res.status}`), { linked: Boolean(data && data.error === 'LINKED_PROVIDER_OFFLINE') });
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

  // The audio graph that connects a microphone stream to the capture worklet; it ends in a muted gain so the graph is pulled without playing the microphone back.
  function connectGraph(context, stream, node) {
    const silent = context.createGain();
    silent.gain.value = 0;
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
    return silent;
  }

  // ── The "Voice input" setting (Settings, Voice input; saved on this device like keeping the microphone ready; on by default) ──
  // Off: `data-voice-off` on <html> hides every microphone button and the keep-ready switch (h5.css). The buttons stay in the page, because the terminal's
  // is attached only once, here. Nothing can start a recording (`start` and the press handler ask first), a running recording ends and keeps its text, and
  // a kept microphone is let go. The keep-ready choice itself is kept, so it comes back with voice input.
  const voice = { enabled: true, listeners: new Set(), recordings: new Set() };
  try { voice.enabled = localStorage.getItem(ENABLED_KEY) !== '0'; } catch { /* storage blocked: on */ }
  function markPage() {
    const page = document.documentElement;
    if (page && page.toggleAttribute) page.toggleAttribute('data-voice-off', !voice.enabled);
  }
  markPage();

  // Asking for the microphone and loading the audio worklet take the most of the time between the tap and the start of the recording. With this on, the
  // page gets the microphone once and keeps the whole audio graph running but off (the worklet posts nothing), and a recording just switches it on.
  // The price: the browser shows its microphone indicator all the time and other audio on the device may be affected, so it is off by default, and the
  // microphone is let go when the page is hidden and taken again when it is shown.
  const warm = { wanted: false, graph: null, building: null, listeners: new Set() };
  try { warm.wanted = localStorage.getItem(KEEP_KEY) === '1'; } catch { /* storage blocked: off */ }
  const warmAvailable = () => Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext));
  const tracksEnded = graph => graph.stream.getTracks().some(track => track.readyState !== 'live') || graph.context.state === 'closed';
  function dropWarm() {
    const graph = warm.graph;
    warm.graph = null;
    if (!graph) return;
    graph.node.port.onmessage = null;
    try { graph.node.disconnect(); } catch { /* already disconnected */ }
    try { graph.silent.disconnect(); } catch { /* already disconnected */ }
    for (const track of graph.stream.getTracks()) { track.onended = null; track.stop(); }
    if (graph.context.state !== 'closed') graph.context.close().catch(() => {});
  }
  // `manual`: the person has just turned it on; a refusal is then said and the option turns itself off. A later attempt (the page is shown again) fails quietly.
  function buildWarm(manual = false) {
    if (!warm.wanted || !voice.enabled || warm.graph || warm.building || !warmAvailable() || (typeof document !== 'undefined' && document.hidden)) return warm.building || Promise.resolve();
    const Context = window.AudioContext || window.webkitAudioContext;
    const context = new Context();
    context.resume().catch(() => {}); // a context made outside a tap may stay suspended; the next tap (the recording) resumes it
    let stream = null;
    warm.building = (async () => {
      try {
        const loaded = context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
        loaded.catch(() => {});
        stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        await loaded;
        if (!warm.wanted || !voice.enabled) throw Object.assign(new Error('no longer wanted'), { quiet: true });
        const node = new AudioWorkletNode(context, 'pcm-capture');
        node.port.postMessage(false);
        const graph = { context, stream, node, silent: connectGraph(context, stream, node), inUse: false };
        for (const track of stream.getTracks()) track.onended = () => { if (warm.graph === graph && !graph.inUse) dropWarm(); }; // the system took the microphone away
        warm.graph = graph;
      } catch (error) {
        if (stream) for (const track of stream.getTracks()) track.stop();
        if (context.state !== 'closed') context.close().catch(() => {});
        if (manual && !(error && error.quiet)) {
          const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
          setKeepWarm(false);
          tell(denied ? 'Microphone access was denied; allow it in the browser settings' : `Cannot keep the microphone ready: ${errorText(error)}`, 'error');
        }
      } finally { warm.building = null; }
    })();
    return warm.building;
  }
  // A graph a recording can use now (the microphone is live and the context is open), taken from the pool; null when there is none.
  function takeWarm() {
    const graph = warm.graph;
    if (!graph || graph.inUse) return null;
    if (tracksEnded(graph)) { dropWarm(); return null; }
    graph.inUse = true;
    return graph;
  }
  function setKeepWarm(on) {
    const value = Boolean(on) && warmAvailable();
    warm.wanted = value;
    try { localStorage.setItem(KEEP_KEY, value ? '1' : '0'); } catch { /* storage blocked: kept until the page closes */ }
    if (value) void buildWarm(true);
    else if (warm.graph && !warm.graph.inUse) dropWarm();
    for (const listener of warm.listeners) listener(value);
  }
  function applyEnabled(value) {
    if (value === voice.enabled) return;
    voice.enabled = value;
    markPage();
    if (value) void buildWarm();
    else {
      for (const recording of voice.recordings) recording.halt();
      if (warm.graph && !warm.graph.inUse) dropWarm(); // a microphone that is still being requested is let go when it arrives (buildWarm)
    }
    for (const listener of voice.listeners) listener(value);
  }
  function setEnabled(on) {
    const value = Boolean(on);
    try { localStorage.setItem(ENABLED_KEY, value ? '1' : '0'); } catch { /* storage blocked: kept until the page closes */ }
    applyEnabled(value);
  }
  if (typeof document !== 'undefined' && document.addEventListener && typeof window !== 'undefined' && window.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (warm.graph && !warm.graph.inUse) dropWarm(); } else void buildWarm();
    });
    window.addEventListener('pagehide', () => { if (warm.graph && !warm.graph.inUse) dropWarm(); });
    // Turned off in another tab of this browser: this tab must not keep the microphone either.
    window.addEventListener('storage', event => { if (event.key === ENABLED_KEY) applyEnabled(event.newValue !== '0'); });
  }

  // textarea: the box to fill; button: the microphone toggle; onNotConfigured: called when the server has no speech key yet.
  // readySound: play a short chime once the recording is ready (the speech service answered and the microphone is connected), so the person knows when to speak.
  // hold: true (hold to talk), false (click to start, click to stop), or a function that answers at each press (the MUI page: hold on a touch screen,
  // click on a computer, following its input mode). The overlay (voice-overlay.js) belongs to hold to talk; click mode shows the small wave instead.
  function attach({ textarea, button, onNotConfigured, hold = false, overlay = null, onSend = null, readySound = false }) {
    const holding = () => (typeof hold === 'function' ? Boolean(hold()) : hold);
    const canHold = typeof hold === 'function' || hold;
    let state = 'idle'; // idle → connecting → listening → stopping → idle
    let recognizer, stream, context, node, silent, resampler, stopTimer, limitTimer;
    let warmGraph = null; // the kept-ready graph this recording uses (it is not stopped when the recording ends)
    let committed = '', partial = '';
    // Where the recognized text goes (see follow): the segment's start and length, the box as last written, and the part of the sentence being
    // recognized that the person has already taken over by editing inside it (it is not written twice).
    let segStart = 0, segLength = 0, written = null, taken = '';
    let frame = new Int16Array(FRAME_SAMPLES);
    let filled = 0;
    let afterStop = null; // 'send': when the recognition ends, hand the text to onSend (released over the send zone)
    let run = 0; // identifies the current start; an older start that is still waiting must not touch a newer one
    const wave = overlay && typeof hold !== 'function' ? null : createWave(button);
    let meter = null; // the level display of the running recording: the overlay (hold to talk) or the wave
    void buildWarm(); // when the person has kept the microphone ready on this device, it is ready as soon as a microphone button exists
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
      if (holding()) button.title = 'Voice input: hold to speak, release to stop';
      else button.title = state === 'idle' ? 'Voice input: click to start speaking' : 'Voice input: click to stop';
    }
    // Takes in what the person changed in the box since it was last written (see follow). Run before a new result is added.
    function track() {
      const current = String(textarea.value ?? '');
      if (written === null || current === written) return current;
      const moved = follow(written, current, segStart, segLength);
      segStart = Math.min(moved.start, current.length);
      segLength = moved.length;
      if (moved.inside) { committed = ''; taken = partial; partial = ''; }
      written = current;
      return current;
    }
    function show() {
      const current = track();
      const text = committed + partial;
      const before = segLength; // the segment's length in the box now
      const next = current.slice(0, segStart) + text + current.slice(segStart + before);
      segLength = text.length;
      written = next;
      if (next === current) return;
      // The caret stays where the person was typing: before the segment it stays, after it it moves with it, inside it it goes to its end.
      const caret = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : null;
      const focused = typeof document !== 'undefined' && document.activeElement === textarea;
      textarea.value = next;
      if (focused && caret !== null && typeof textarea.setSelectionRange === 'function') {
        const at = caret <= segStart ? caret : caret >= segStart + before ? caret + text.length - before : segStart + text.length;
        try { textarea.setSelectionRange(at, at); } catch { /* not a text box */ }
      }
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function release() { // stop the microphone and the audio graph (a kept-ready one is only switched off and given back)
      if (wave) wave.hide();
      if (warmGraph) {
        const graph = warmGraph;
        warmGraph = null;
        graph.inUse = false;
        graph.node.port.onmessage = null;
        graph.node.port.postMessage(false);
        node = silent = stream = context = null;
        if (!warm.wanted || !voice.enabled || tracksEnded(graph)) dropWarm();
        return;
      }
      if (node) { node.port.onmessage = null; try { node.disconnect(); } catch { /* already disconnected */ } }
      if (silent) { try { silent.disconnect(); } catch { /* already disconnected */ } }
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (context && context.state !== 'closed') context.close().catch(() => {});
      node = silent = stream = context = null;
      if (warm.wanted && !warm.graph) void buildWarm(); // the first recording is also what gets the permission: keep the microphone ready from here on
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
    // Throw away what this recording recognized; what the person typed meanwhile stays.
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
      if (!voice.enabled) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
        tell('Voice input needs a secure page: open this page over HTTPS or at localhost', 'error');
        return;
      }
      state = 'connecting';
      run += 1;
      const mine = run;
      committed = ''; partial = ''; taken = '';
      // The recognized text goes in at the caret (at the end when the box has no caret), not after everything that is there.
      written = String(textarea.value ?? '');
      segStart = typeof textarea.selectionEnd === 'number' ? Math.min(textarea.selectionEnd, written.length) : written.length;
      segLength = 0;
      filled = 0; early = []; earlyBytes = 0; stopAfterToken = false;
      recognizerReady = graphReady = announced = false; mutedUntil = 0;
      render();
      // Create the audio context inside the click, before any await, so iOS Safari lets it run. A kept-ready graph has its context already.
      const Context = window.AudioContext || window.webkitAudioContext;
      warmGraph = takeWarm();
      context = warmGraph ? warmGraph.context : new Context();
      context.resume().catch(() => {});
      try {
        // Everything slow runs at the same time: the microphone permission, the audio worklet and the token. The microphone is recording
        // as soon as the first two are ready, without waiting for the token. With the microphone kept ready the first two are done already.
        let tokenAt = Date.now();
        const tokenRequest = requestToken();
        tokenRequest.catch(() => {}); // handled when it is awaited below
        if (warmGraph) {
          stream = warmGraph.stream;
          node = warmGraph.node;
          silent = warmGraph.silent;
        } else {
          const moduleLoaded = context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
          moduleLoaded.catch(() => {});
          stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
          if (mine !== run) { release(); return; }
          await moduleLoaded;
          if (mine !== run) { release(); return; }
          node = new AudioWorkletNode(context, 'pcm-capture');
        }
        resampler = createResampler(context.sampleRate);
        meter = overlay && holding() ? overlay : wave;
        if (meter === wave && wave) wave.show();
        node.port.onmessage = event => {
          if (meter) {
            let sum = 0;
            for (let i = 0; i < event.data.length; i += 1) sum += event.data[i] * event.data[i];
            const rms = Math.sqrt(sum / (event.data.length || 1));
            meter.level(rms);
          }
          if (Date.now() < mutedUntil) return; // the chime is playing
          send(resampler.push(event.data));
        };
        if (warmGraph) node.port.postMessage(true); // switch the kept-ready graph on
        else silent = connectGraph(context, stream, node);
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
              track();
              let text = result.text;
              if (taken) { if (text.startsWith(taken)) text = text.slice(taken.length); if (result.final) taken = ''; }
              if (result.final) { committed += text; partial = ''; } else partial = text;
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
        fail(denied ? 'Microphone access was denied; allow it in the browser settings' : (error && error.name && !error.linked ? `Cannot start the microphone: ${errorText(error)}` : errorText(error)));
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

    let pressedAt = 0; // while a hold to talk is pressed: when it began
    // The setting was turned off: end the recording like a second click (the text so far is kept) and close the hold-to-talk screen.
    function halt() {
      if (pressedAt) { pressedAt = 0; if (overlay) overlay.hide(); }
      stop();
    }

    if (canHold) {
      // Hold to speak: pressing starts the recording (inside the touch, so iOS lets the audio context run) and letting go ends the
      // recognition, keeping the text. A tap shorter than HOLD_MS is not a long press and is discarded. Keyboard activation
      // (click without a pointer, detail 0) still toggles, because a keyboard cannot hold a button.
      let zone = 'send';
      button.addEventListener('pointerdown', event => {
        if (event.button || state !== 'idle' || !holding() || !voice.enabled) return;
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
      button.addEventListener('contextmenu', event => { if (holding()) event.preventDefault(); });
      button.addEventListener('click', event => { if (holding() && event.detail === 0) { if (state === 'idle') void start(); else stop(); } });
    }
    button.addEventListener('click', () => { if (holding()) return; if (state === 'idle') void start(); else stop(); });
    render();
    // A chat's microphone leaves with its chat: forget those, so the list does not grow while the page stays open.
    for (const recording of voice.recordings) if (recording.button.isConnected === false) voice.recordings.delete(recording);
    voice.recordings.add({ button, halt });
    return { start, stop, finish, cancel, get state() { return state; } };
  }

  // The page: the microphone next to the draft box. Voice input is set up in the page's Settings (scripts/h5-shell/Settings.jsx `VoiceGroup`).
  const h5Input = document.getElementById('h5-translate-input');
  const h5Mic = document.getElementById('h5-voice');
  // Hold to talk on a touch screen, click to start and stop on a computer (the shell's input mode, `H5UI` in scripts/h5-shell/entry.jsx).
  const h5Hold = () => !(window.H5UI && window.H5UI.get().input === 'pointer');
  if (h5Input && h5Mic) attach({ textarea: h5Input, button: h5Mic, onNotConfigured: () => tell('Set up voice input in Settings', 'info'), hold: h5Hold,
    overlay: typeof VoiceOverlay !== 'undefined' ? VoiceOverlay.create() : null,
    onSend: () => { const form = document.getElementById('h5-translate'); if (form && form.requestSubmit) form.requestSubmit(); } });

  return {
    attach, createResampler, createRecognizer, compose, follow,
    // Keeping the microphone ready: the switch of the chat options reads and sets it; `onKeepWarm` follows changes (several chats can be open).
    setKeepWarm, get keepWarm() { return warm.wanted; }, canKeepWarm: warmAvailable,
    onKeepWarm(listener) { warm.listeners.add(listener); return () => warm.listeners.delete(listener); },
    // The "Voice input" setting (Settings.jsx): `onEnabled` follows changes.
    setEnabled, get enabled() { return voice.enabled; },
    onEnabled(listener) { voice.listeners.add(listener); return () => voice.listeners.delete(listener); },
  };
})();
if (typeof window !== 'undefined') window.VoiceInput = VoiceInput;
if (typeof module !== 'undefined' && module.exports) module.exports = VoiceInput;
