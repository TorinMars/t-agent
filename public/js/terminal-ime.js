// iOS's Apple Chinese keyboard types spaces, punctuation and numbers as plain `insertText` input events that follow a keydown (keyCode 229).
// xterm 5.5 ignores an input event that is both composed and preceded by a keydown, so those characters never reach the shell.
// This watches the terminal for such an event and sends the character itself when xterm did not emit it.
// A plain Space takes another road: its keyCode (32) is below the range xterm sends on keydown, so xterm sends it on keypress and does not cancel the key (`cancelEvents`
// is off). The browser then still inserts the space and fires an `insertText` input event, after xterm has already sent it. A key that had a keypress is xterm's, done.
const TerminalIme = (() => {
  const SETTLE_MS = 40; // xterm emits its own data synchronously or on the next tick; wait past that before filling in
  const SPACE_PUNCTUATION_OR_NUMBER = /^[\s\p{P}\p{S}\p{N}]$/u;

  function attach(term, send, { settleMs = SETTLE_MS, schedule = setTimeout } = {}) {
    const root = term.element;
    if (!root) return () => {};
    const emitted = [];
    let pending = 0;
    let pressed = false; // the current key press had a keypress event, so xterm sent its character already
    // Chunks are only needed while an input event waits for its settle window; otherwise nothing is kept.
    const data = term.onData(chunk => { if (pending) emitted.push(chunk); });
    // On the terminal's root in the capture phase, so it runs before xterm's own handler on the textarea and `from` is taken before xterm emits.
    const onKeydown = () => { pressed = false; };
    const onKeypress = () => { pressed = true; };
    const onInput = event => {
      const text = event.data;
      if (pressed) return;
      if (event.inputType !== 'insertText' || event.isComposing || typeof text !== 'string' || !SPACE_PUNCTUATION_OR_NUMBER.test(text)) return;
      const from = emitted.length;
      pending += 1;
      schedule(() => {
        const handled = emitted.slice(from).some(chunk => chunk.includes(text));
        if (!--pending) emitted.length = 0; // nothing is waiting for the list any more; keep it from growing
        if (!handled) send(text);
      }, settleMs);
    };
    root.addEventListener('keydown', onKeydown, true);
    root.addEventListener('keypress', onKeypress, true);
    root.addEventListener('input', onInput, true);
    return () => {
      root.removeEventListener('keydown', onKeydown, true);
      root.removeEventListener('keypress', onKeypress, true);
      root.removeEventListener('input', onInput, true);
      if (data && data.dispose) data.dispose();
    };
  }

  return { attach };
})();
if (typeof module !== 'undefined') module.exports = TerminalIme;
