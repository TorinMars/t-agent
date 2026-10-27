// Shared audio capture helpers and a fail-closed, sentence-level iFlytek speaker gate.
const SpeakerFilter = (() => {
  const RATE = 16000;
  function pcmWav(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    const label = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
    label(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    label(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
    return new Uint8Array(buffer);
  }
  function base64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  function createGate({ verify, onAccepted, onRejected = () => {}, onError }) {
    const audio = new Int16Array(RATE * 300); // the same five-minute bound as VoiceInput
    let length = 0, active = true, pending = Promise.resolve(), controller = null;
    const seen = new Set();
    return {
      push(samples) {
        if (!active) return;
        if (length + samples.length > audio.length) { active = false; onError('The recording is too long'); return; }
        audio.set(samples, length); length += samples.length;
      },
      enqueue(result) {
        if (!active || !result.final) return;
        const id = result.sentenceId ?? `${result.beginTime}:${result.endTime}`;
        if (seen.has(id)) return;
        seen.add(id);
        // Snapshot exactly the ASR sentence's audio, never use an unrelated speaker's earlier segment.
        const { beginTime, endTime } = result;
        const start = Math.floor(beginTime * RATE / 1000), end = Math.ceil(endTime * RATE / 1000);
        if (!Number.isFinite(beginTime) || !Number.isFinite(endTime) || beginTime < 0 || endTime <= beginTime || end > length) {
          active = false; onError('Cannot verify speech without valid audio timestamps'); return;
        }
        if (end - start < RATE / 2 || end - start > RATE * 60) { onRejected('Speak for at least half a second and keep each sentence under one minute'); return; }
        const clip = audio.slice(start, end);
        pending = pending.then(async () => {
          if (!active) return;
          controller = new AbortController();
          try {
            const response = await verify(base64(pcmWav(clip)), controller.signal);
            if (!active) return;
            if (response?.matched === true) onAccepted(result.text);
            else if (response?.matched === false) onRejected('Speech from another speaker was ignored');
            else throw new Error('Invalid speaker verification response');
          } catch (error) {
            if (active) { active = false; onError(error.message || 'Could not verify the speaker'); }
          } finally { controller = null; }
        });
      },
      finish: () => pending,
      close() { active = false; if (controller) controller.abort(); audio.fill(0); },
    };
  }
  async function request(path, { method = 'GET', body, signal } = {}) {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 20000);
    try {
      const response = await fetch(`/api/speech/speaker/${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Speaker verification failed');
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Speaker verification timed out or was cancelled');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  if (typeof document === 'undefined') return { pcmWav, base64, createGate };
  const t = text => typeof I18n !== 'undefined' ? I18n.t(text) : text;
  let opened = null;
  async function showSettings() {
    if (opened) return;
    const host = document.createElement('div'); opened = host;
    host.className = 'sf-overlay';
    host.innerHTML = `<section class="sf-dialog" role="dialog" aria-modal="true" aria-labelledby="sf-title">
      <h2 id="sf-title">Speaker filter settings</h2>
      <p>Alibaba Cloud transcribes speech. iFlytek verifies each completed sentence against your registered voice before it appears in the input.</p>
      <label>iFlytek App ID<input id="sf-app" autocomplete="off"></label>
      <label>iFlytek API Key<input id="sf-key" type="password" autocomplete="new-password"></label>
      <label>iFlytek API Secret<input id="sf-secret" type="password" autocomplete="new-password"></label>
      <label>Voice match threshold<input id="sf-threshold" type="number" min="0" max="1" step="0.01"></label>
      <p>Higher thresholds reject more voices but may also reject yours. Test with your microphone. Simultaneous speakers may still be misidentified.</p>
      <label class="sf-enable"><input id="sf-enabled" type="checkbox">Only accept my voice</label>
      <button id="sf-save" type="button">Save credentials and settings</button>
      <hr><p>Record 10 to 60 seconds alone in a quiet room, or choose a 16 kHz mono 16-bit PCM WAV. Registration sends the sample to iFlytek; verification sends each sentence's audio through this server. Audio is not saved by T-Agent.</p>
      <button id="sf-record" type="button">Record a 12-second voice sample</button>
      <label>Voice sample<input id="sf-file" type="file" accept=".wav,audio/wav"></label>
      <button id="sf-enroll" type="button">Register my voice</button>
      <p id="sf-feedback" role="status"></p>
      <div class="sf-actions"><button id="sf-delete" type="button">Delete voiceprint and settings</button><button id="sf-close" type="button">Close</button></div>
    </section>`;
    const previous = document.activeElement;
    document.body.append(host);
    const field = name => host.querySelector(`#sf-${name}`);
    const feedback = message => { field('feedback').textContent = t(message); };
    let config, sample = '', context = null, stream = null, node = null, timer = null, saving = false, alive = true;
    function stopCapture() {
      clearTimeout(timer);
      if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
      if (stream) { for (const track of stream.getTracks()) track.stop(); stream = null; }
      if (context) { context.close().catch(() => {}); context = null; }
    }
    const close = () => { alive = false; stopCapture(); host.remove(); opened = null; previous?.focus(); };
    field('close').onclick = close;
    host.addEventListener('click', event => { if (event.target === host) close(); });
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const controls = [...host.querySelectorAll('input,button')].filter(node => !node.disabled);
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
      }
    });
    function fill(next) {
      config = next;
      field('app').value = config.appId;
      field('key').value = field('secret').value = '';
      field('key').placeholder = config.hasApiKey ? t('Saved; leave empty to keep it') : '';
      field('secret').placeholder = config.hasApiSecret ? t('Saved; leave empty to keep it') : '';
      field('threshold').value = config.threshold;
      field('enabled').checked = config.enabled;
      field('enabled').disabled = !config.enrolled;
      feedback(config.enrolled ? 'Voice registered. You can enable the speaker filter.' : 'Save credentials, then register your voice.');
    }
    const save = async () => {
      const next = await request('config', { method: 'PUT', body: { appId: field('app').value, apiKey: field('key').value, apiSecret: field('secret').value, threshold: field('threshold').value, enabled: field('enabled').checked } });
      if (alive) fill(next);
    };
    const action = callback => async () => {
      if (saving) return;
      saving = true;
      for (const name of ['save', 'enroll', 'delete', 'record']) field(name).disabled = true;
      try { await callback(); } catch (error) { if (alive) feedback(error.message); }
      finally { saving = false; if (alive) for (const name of ['save', 'enroll', 'delete', 'record']) field(name).disabled = false; }
    };
    field('save').onclick = action(save);
    field('file').onchange = async () => {
      const file = field('file').files[0];
      if (!file) return;
      if (file.size > 1920044) { feedback('The voice sample is too large'); return; }
      sample = base64(new Uint8Array(await file.arrayBuffer())); feedback('Voice sample ready. Register it to continue.');
    };
    field('enroll').onclick = action(async () => {
      if (stream) throw new Error('Wait for the voice sample recording to finish');
      if (!sample) throw new Error('Record or choose a voice sample first');
      await save();
      const next = await request('enroll', { method: 'POST', body: { audio: sample } });
      sample = '';
      if (alive) { field('file').value = ''; fill(next); }
    });
    field('delete').onclick = action(async () => { const next = await request('config', { method: 'DELETE' }); sample = ''; if (alive) fill(next); });
    field('record').onclick = async () => {
      if (stream || context || saving) return;
      sample = '';
      field('record').disabled = true;
      try {
        const Context = window.AudioContext || window.webkitAudioContext;
        context = new Context(); await context.resume();
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (!alive) { stopCapture(); return; }
        const url = URL.createObjectURL(new Blob(['registerProcessor("voiceprint-capture",class extends AudioWorkletProcessor{process(inputs){const c=inputs[0]&&inputs[0][0];if(c)this.port.postMessage(c.slice());return true;}})'], { type: 'text/javascript' }));
        try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        if (!alive) { stopCapture(); return; }
        const resampler = VoiceInput.createResampler(context.sampleRate), pieces = []; let size = 0;
        node = new AudioWorkletNode(context, 'voiceprint-capture');
        node.port.onmessage = event => { const part = resampler.push(event.data); pieces.push(part); size += part.length; };
        const gain = context.createGain(); gain.gain.value = 0;
        context.createMediaStreamSource(stream).connect(node); node.connect(gain); gain.connect(context.destination);
        feedback('Recording for 12 seconds. Speak alone and keep talking.');
        timer = setTimeout(() => {
          stopCapture();
          const samples = new Int16Array(size); let at = 0;
          for (const piece of pieces) { samples.set(piece, at); at += piece.length; }
          sample = base64(pcmWav(samples));
          if (alive) { field('record').disabled = false; feedback('Voice sample ready. Register it to continue.'); }
        }, 12000);
      } catch { stopCapture(); if (alive) { field('record').disabled = false; feedback('Could not record the voice sample. Check microphone permission.'); } }
    };
    field('close').focus();
    try { const current = await request('config'); if (alive) { fill(current); field('app').focus(); } }
    catch (error) { if (alive) feedback(error.message); }
  }
  return { pcmWav, base64, createGate, request, showSettings };
})();
if (typeof window !== 'undefined') window.SpeakerFilter = SpeakerFilter;
if (typeof module !== 'undefined' && module.exports) module.exports = SpeakerFilter;
