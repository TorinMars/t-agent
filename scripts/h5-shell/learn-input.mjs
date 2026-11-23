// English input while spelling (pure functions, no DOM; "English input" in docs/design/learn-spell-practice.md).
// - A browser cannot switch the system's input method, so on the Spell answer field and the "Type it yourself" row the keys typed while an input
//   method composes count as letters: the Latin letters of the composition (compositionupdate data), else the letters of the keys pressed (the
//   keydown `code`, KeyA..KeyZ), and the text the input method commits (Chinese characters) is dropped. `createComposer` follows one composition,
//   `cleanTyped` mends a field value an input method changed without a composition.
// - In the T-Agent Mac app the page asks the app to select an English input source while such a field has the focus and to put the person's own
//   back when it loses it (`inputSourceBridge`, the `tagentInputSource` script message; "English input while spelling" in docs/design/mac-app.md).
//   Outside the app there is no such handler and nothing is sent.

// Full-width Latin letters (an input method's full-width mode) as ASCII ones.
export const halfWidth = text => String(text || '').replace(/[\uff21-\uff3a\uff41-\uff5a]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
// The Latin letters of a composition: separators an input method puts in (spaces, apostrophes) and everything else left out.
export const latinLetters = text => halfWidth(text).replace(/[^A-Za-z]/g, '');
// Text an input method produces that is never part of an English word: CJK punctuation, kana, Han characters, Hangul and full-width forms.
const IME_TEXT = /[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3100-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
const IME_RUN = new RegExp(`${IME_TEXT.source}+`, 'g');
export const hasImeText = text => IME_TEXT.test(halfWidth(text));

// A keydown that belongs to an input method: during a composition, or the "Process" key (keyCode 229) a browser reports while one handles it.
export const isImeKey = event => Boolean(event && (event.isComposing || event.keyCode === 229 || event.key === 'Process'));
// The letter of a key, from its physical place (`code` KeyA..KeyZ, the same with any input method on) or a plain Latin `key`; '' for other keys.
export function keyLetter(event) {
  if (!event) return '';
  const code = /^Key([A-Z])$/.exec(String(event.code || ''));
  if (code) return event.shiftKey ? code[1] : code[1].toLowerCase();
  const key = String(event.key || '');
  return /^[A-Za-z]$/.test(key) ? key : '';
}

// One composition in a field whose value was `value` with the selection start..end when it began. `keys`: letters of the keys pressed before the
// composition started (the keydown that starts it comes first). `update(data)` / `end(data)` return the field's text with the letters in place of
// the composition: the composition's own Latin letters when it has only those (pinyin as typed, the input method's edits and separators taken
// out); when it shows other text (a candidate, or a part already turned into Chinese) the longest of what was seen, so letters are never lost.
export function createComposer(value = '', start = null, end = null, keys = '') {
  const text = String(value || '');
  const from = start === null || start === undefined ? text.length : Math.max(0, Math.min(text.length, start));
  const to = end === null || end === undefined ? from : Math.max(from, Math.min(text.length, end));
  const before = text.slice(0, from);
  const after = text.slice(to);
  let latin = '';
  let pressed = String(keys || '');
  const longest = (...list) => list.reduce((best, item) => (item.length > best.length ? item : best), '');
  const take = data => {
    const raw = String(data === null || data === undefined ? '' : data);
    const letters = latinLetters(raw);
    if (!raw) { latin = ''; pressed = ''; } else if (hasImeText(raw)) latin = longest(letters, latin, pressed); else latin = letters;
    return before + latin + after;
  };
  return {
    // A key pressed during the composition: its letter, or Backspace.
    key({ letter = '', back = false } = {}) {
      if (back) pressed = pressed.slice(0, -1); else if (letter) pressed += letter;
    },
    update: take,
    end: data => (data ? take(data) : before + longest(latin, pressed) + after),
    get value() { return before + latin + after; },
  };
}

// A field value changed without a composition (an input method that inserts its text at once): the input method's text is left out and, when
// keys of an input method were pressed just before (`keys`), their letters stand in its place. `ime`: such text was there.
export function cleanTyped(value, keys = '') {
  const text = halfWidth(value);
  if (!IME_TEXT.test(text)) return { text, ime: false };
  let first = true;
  const cleaned = text.replace(IME_RUN, () => {
    const out = first ? String(keys || '') : '';
    first = false;
    return out;
  });
  return { text: cleaned, ime: true };
}

// The Mac app's input source switch. `focus()` asks for English, `blur()` for the person's own input source back a moment later (so moving from the
// answer field to the practice row does not switch twice), `close()` at once (Learn closes). Each state is sent once; nothing without the handler.
export function inputSourceBridge(win = (typeof window === 'undefined' ? null : window), { delay = 150, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const handler = () => {
    const handlers = win && win.webkit && win.webkit.messageHandlers;
    const found = handlers && handlers.tagentInputSource;
    return found && typeof found.postMessage === 'function' ? found : null;
  };
  let sent = 'restore';
  let timer = null;
  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const post = what => {
    const target = handler();
    if (!target || sent === what) return;
    sent = what;
    try { target.postMessage(what); } catch { /* the app went away: nothing to switch */ }
  };
  return {
    available: () => Boolean(handler()),
    focus() { stop(); post('english'); },
    blur() { stop(); timer = setTimer(() => { timer = null; post('restore'); }, delay); },
    close() { stop(); post('restore'); },
  };
}
