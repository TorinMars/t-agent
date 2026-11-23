// Auto-paired punctuation of input methods ("Auto-paired punctuation of input methods" in docs/design/page-terminal-and-bottom-bar.md).
// WeType on macOS answers one press of " with the whole pair “” in one insertion and then a Left arrow key that puts the caret between the two. In a
// text field that is right; in the terminal the Left key reaches the program (Claude Code then draws its cursor on ”), xterm sends the pair after the
// Left (its keyCode-229 text comes from a setTimeout diff of its helper textarea) and the caret, moved inside that textarea, makes the next diff send
// more than was typed. Here such a pair followed by a Left key (in either order, within PAIR_WINDOW_MS) becomes ONE character and the Left key is
// dropped: quotes alternate opening / closing per terminal since the last Enter, Ctrl+C or Ctrl+U; brackets give the opening one only. A pair without a
// Left key (a paste, an input method that does not move the caret) is sent unchanged, a moment later.
const TerminalImePairs = (() => {
  const PAIR_WINDOW_MS = 100;
  // Pair -> quote (alternates) or bracket (opening only). Written with \u escapes: “” ‘’ （） 《》 〈〉 「」 『』 【】 〔〕 ［］ ｛｝.
  const QUOTES = ['\u201C\u201D', '\u2018\u2019'];
  const BRACKETS = ['\uFF08\uFF09', '\u300A\u300B', '\u3008\u3009', '\u300C\u300D', '\u300E\u300F', '\u3010\u3011', '\u3014\u3015', '\uFF3B\uFF3D', '\uFF5B\uFF5D'];
  const LEFT_SEQUENCE = /^\x1b[[O]D$/; // what xterm sends for a plain Left key (normal and application cursor mode)
  const RESETS = /[\r\x03\x15]/; // Enter, Ctrl+C, Ctrl+U start a new line of input: the next quote opens again

  const isPair = text => typeof text === 'string' && (QUOTES.includes(text) || BRACKETS.includes(text));

  // The rules without the DOM. `emit` gets what the terminal should send; `forward` takes what xterm emitted; `observe` sees everything the terminal sent.
  function createPairs(emit, { windowMs = PAIR_WINDOW_MS, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
    const closing = new Set(); // quote pairs whose next press gives the closing quote
    let pending = null; // { pair, timer }: a pair waiting for its Left key
    let heldLeft = null; // { data, timer }: a Left key that came first, waiting for its pair
    let imeKeyAt = -Infinity; // when the last keydown of an input method (keyCode 229) came, before any insertion
    let holdArmed = false;

    function out(data) { observe(data); emit(data); }
    function observe(data) { if (typeof data === 'string' && RESETS.test(data)) closing.clear(); }
    function choose(pair) {
      if (!QUOTES.includes(pair)) return pair[0];
      const close = closing.has(pair);
      if (close) closing.delete(pair); else closing.add(pair);
      return pair[close ? 1 : 0];
    }
    function flush() {
      if (pending) { const { pair, timer } = pending; pending = null; cancel(timer); out(pair); }
      if (heldLeft) { const { data, timer } = heldLeft; heldLeft = null; cancel(timer); out(data); }
    }
    return {
      // An input method inserted `text` in one go. True when it is a pair this takes (the caller keeps it out of the textarea and from xterm).
      pairInserted(text) {
        imeKeyAt = -Infinity;
        if (!isPair(text)) return false;
        if (heldLeft) { cancel(heldLeft.timer); heldLeft = null; out(choose(text)); return true; } // the Left came first (WebKit)
        flush();
        const entry = { pair: text, timer: null };
        entry.timer = schedule(() => { if (pending === entry) { pending = null; out(text); } }, windowMs);
        pending = entry;
        return true;
      },
      inserted() { imeKeyAt = -Infinity; }, // any other insertion: the input method's key got its text
      imeKey() { imeKeyAt = now(); },
      // A plain Left key: 'drop' (it belongs to the pair before it, which is sent now), 'hold' (an input method's key is still waiting for its text: the
      // Left xterm emits next is held for the pair) or 'pass'.
      leftKey() {
        if (pending) { const { pair, timer } = pending; pending = null; cancel(timer); out(choose(pair)); return 'drop'; }
        if (now() - imeKeyAt <= windowMs) { holdArmed = true; return 'hold'; }
        return 'pass';
      },
      disarm() { holdArmed = false; },
      forward(data) {
        if (holdArmed && LEFT_SEQUENCE.test(data)) {
          holdArmed = false;
          flush();
          const entry = { data, timer: null };
          entry.timer = schedule(() => { if (heldLeft === entry) { heldLeft = null; out(data); } }, windowMs);
          heldLeft = entry;
          return;
        }
        flush();
        out(data);
      },
      flush,
      observe,
      dispose() { if (pending) cancel(pending.timer); if (heldLeft) cancel(heldLeft.timer); pending = null; heldLeft = null; },
    };
  }

  const plainLeft = event => (event.key === 'ArrowLeft' || event.keyCode === 37) && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing;

  // Listens on the terminal's root in the capture phase, so it runs before xterm's own listeners on its helper textarea. Returns the controller: h5.js
  // sends xterm's data through `forward` and every sent chunk through `observe`.
  function attach(term, send, options = {}) {
    const pairs = createPairs(send, options);
    const root = term.element;
    if (!root) return pairs;
    let took = null; // the pair a cancelled beforeinput took, so a stray input event for it is not taken twice
    // xterm reads its helper textarea as "old value + what was typed at the end": the caret must stay at the end.
    const caretToEnd = () => {
      const textarea = term.textarea;
      if (!textarea) return;
      const end = textarea.value.length;
      if (textarea.selectionStart !== end || textarea.selectionEnd !== end) textarea.setSelectionRange(end, end);
    };
    const onKeydown = event => {
      if (event.keyCode === 229 || event.key === 'Process') { if (!event.isComposing) pairs.imeKey(); return; }
      if (!plainLeft(event)) return;
      const verdict = pairs.leftKey();
      if (verdict === 'drop') {
        event.preventDefault();
        event.stopImmediatePropagation(); // xterm never sees it: no ESC[D, the caret stays put
        caretToEnd();
        setTimeout(caretToEnd, 0);
      } else if (verdict === 'hold') {
        setTimeout(() => pairs.disarm(), 0); // xterm emits the Left synchronously in this same dispatch
      }
    };
    const onBeforeInput = event => {
      if (event.isComposing || event.inputType !== 'insertText') return;
      if (!isPair(event.data)) { pairs.inserted(); return; }
      if (!event.cancelable) return; // left to the input event below
      if (!pairs.pairInserted(event.data)) return;
      event.preventDefault(); // nothing reaches the textarea, so xterm's diff and its input handler see no change
      took = event.data;
      setTimeout(() => { took = null; }, 0);
      caretToEnd();
    };
    // Where the insertion could not be cancelled: take the pair back out of the textarea and keep the event from xterm.
    const onInput = event => {
      if (event.isComposing || event.inputType !== 'insertText' || !isPair(event.data)) return;
      const textarea = event.target;
      const first = took !== event.data;
      took = null;
      if (first && !pairs.pairInserted(event.data)) return;
      event.stopImmediatePropagation();
      if (textarea && typeof textarea.value === 'string') {
        const end = textarea.selectionStart;
        const start = end - event.data.length;
        if (start >= 0 && textarea.value.slice(start, end) === event.data) textarea.value = textarea.value.slice(0, start) + textarea.value.slice(end);
      }
      caretToEnd();
    };
    const onCompositionStart = () => { pairs.inserted(); pairs.flush(); }; // a composition: its text is not a pair of this kind
    root.addEventListener('keydown', onKeydown, true);
    root.addEventListener('beforeinput', onBeforeInput, true);
    root.addEventListener('input', onInput, true);
    root.addEventListener('compositionstart', onCompositionStart, true);
    const dispose = pairs.dispose;
    pairs.dispose = () => {
      dispose();
      root.removeEventListener('keydown', onKeydown, true);
      root.removeEventListener('beforeinput', onBeforeInput, true);
      root.removeEventListener('input', onInput, true);
      root.removeEventListener('compositionstart', onCompositionStart, true);
    };
    return pairs;
  }

  return { attach, createPairs, isPair, PAIR_WINDOW_MS };
})();
if (typeof module !== 'undefined') module.exports = TerminalImePairs;
