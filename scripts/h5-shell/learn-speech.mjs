// Speech for the Learn page: reading English aloud with the browser's speechSynthesis (an en-US voice when there is one), and hearing the person
// for "Say it": the page's own voice input (public/js/voice-input.js, `window.VoiceInput`, when it is turned on) or else the browser's
// SpeechRecognition in en-US. See "Speech" in docs/design/learn-english-page.md.

const synth = () => (typeof window !== 'undefined' && window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function' ? window.speechSynthesis : null);

// The voice to read with: en-US first, then any English voice. Null while the browser has not listed its voices yet (the language is still set).
export function pickVoice(voices) {
  const list = Array.isArray(voices) ? voices : [];
  const lang = voice => String(voice.lang || '').replace('_', '-').toLowerCase();
  return list.find(voice => lang(voice) === 'en-us' && voice.localService) || list.find(voice => lang(voice) === 'en-us')
    || list.find(voice => lang(voice).startsWith('en')) || null;
}

// Whether the page can read aloud: the API is there and, once the voices are known, one of them is English.
export function canSpeak() {
  const speech = synth();
  if (!speech) return false;
  const voices = typeof speech.getVoices === 'function' ? speech.getVoices() : [];
  return !voices.length || Boolean(pickVoice(voices));
}

// Reads `text` aloud; `slow` reads it at about two thirds of the normal rate (Dictation's "Slow"). Stops what was being read first.
export function speak(text, { slow = false } = {}) {
  const speech = synth();
  if (!speech || !text) return false;
  try {
    speech.cancel();
    const utterance = new window.SpeechSynthesisUtterance(String(text));
    utterance.lang = 'en-US';
    const voice = pickVoice(typeof speech.getVoices === 'function' ? speech.getVoices() : []);
    if (voice) utterance.voice = voice;
    utterance.rate = slow ? 0.65 : 1;
    speech.speak(utterance);
    return true;
  } catch {
    return false;
  }
}
export function stopSpeaking() { const speech = synth(); if (speech) try { speech.cancel(); } catch { /* nothing to stop */ } }

const Recognition = () => (typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition || null : null);
const pageVoice = () => (typeof window !== 'undefined' && window.VoiceInput && typeof window.VoiceInput.attach === 'function' && window.VoiceInput.enabled !== false ? window.VoiceInput : null);

// How "Say it" hears the person: 'page' (the page's voice input), 'browser' (SpeechRecognition) or null (the mode is hidden).
export function voiceWay() {
  if (pageVoice()) return 'page';
  if (Recognition()) return 'browser';
  return null;
}

// Starts listening into `box` (a text field) when `button` is pressed. Returns { stop, dispose }.
// - 'page': the page's voice input is attached to the box and the button (click to start and stop); its text is typed into the box. When the server
//   has no speech service (`onNotConfigured`) and the browser has SpeechRecognition, that is used from then on.
// - 'browser': SpeechRecognition in en-US, one phrase per press; the text replaces the box's content.
// `onText(text)` is called with the box's new text; `onState(listening)` follows the recording.
export function attachVoice({ box, button, onText, onState = () => {}, onMissing = () => {} }) {
  let fallback = !pageVoice();
  let recognition = null;
  let attached = null;
  const startBrowser = () => {
    const Impl = Recognition();
    if (!Impl) { onMissing(); return; }
    if (recognition) { try { recognition.stop(); } catch { /* already stopped */ } return; }
    recognition = new Impl();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = event => {
      const text = [...event.results].map(result => result[0] && result[0].transcript).join('').trim();
      onText(text);
    };
    recognition.onend = () => { recognition = null; onState(false); };
    recognition.onerror = () => { recognition = null; onState(false); };
    try { recognition.start(); onState(true); } catch { recognition = null; onState(false); }
  };
  const onClick = event => {
    if (!fallback) return; // the page's voice input handles its own clicks
    event.preventDefault();
    startBrowser();
  };
  button.addEventListener('click', onClick);
  if (!fallback) {
    try {
      attached = pageVoice().attach({ textarea: box, button, hold: false, onNotConfigured: () => { fallback = true; if (Recognition()) startBrowser(); else onMissing(); } });
    } catch { fallback = true; }
  }
  const onInput = () => onText(box.value);
  box.addEventListener('input', onInput);
  const watch = typeof MutationObserver === 'function' ? new MutationObserver(() => onState(button.classList.contains('listening'))) : null;
  if (watch && !fallback) watch.observe(button, { attributes: true, attributeFilter: ['class'] });
  const stop = () => {
    if (recognition) { try { recognition.stop(); } catch { /* already stopped */ } }
    if (attached && attached.state !== 'idle' && typeof attached.cancel === 'function') { try { attached.cancel(); } catch { /* already stopped */ } }
  };
  return {
    stop,
    dispose() { stop(); button.removeEventListener('click', onClick); box.removeEventListener('input', onInput); if (watch) watch.disconnect(); },
  };
}
