// iOS's Apple Chinese keyboard types spaces, punctuation and numbers as plain `insertText` input events that follow a keydown (keyCode 229).
// xterm 5.5 ignores an input event that is both composed and preceded by a keydown, so those characters never reach the shell.
// This watches the terminal for such an event and sends the character itself when xterm did not emit it.
const TerminalIme = (() => {
  const SETTLE_MS = 40; // xterm emits its own data synchronously or on the next tick; wait past that before filling in
  const SPACE_PUNCTUATION_OR_NUMBER = /^[\s\p{P}\p{S}\p{N}]$/u;

  function attach(term, send, { settleMs = SETTLE_MS, schedule = setTimeout } = {}) {
    const root = term.element;
    if (!root) return () => {};
    const emitted = [];
    let pending = 0;
    const data = term.onData(chunk => emitted.push(chunk));
    // On the terminal's root in the capture phase, so it runs before xterm's own handler on the textarea and `from` is taken before xterm emits.
    const onInput = event => {
      const text = event.data;
      if (event.inputType !== 'insertText' || event.isComposing || typeof text !== 'string' || !SPACE_PUNCTUATION_OR_NUMBER.test(text)) return;
      const from = emitted.length;
      pending += 1;
      schedule(() => {
        const handled = emitted.slice(from).some(chunk => chunk.includes(text));
        if (!--pending) emitted.length = 0; // nothing is waiting for the list any more; keep it from growing
        if (!handled) send(text);
      }, settleMs);
    };
    root.addEventListener('input', onInput, true);
    return () => { root.removeEventListener('input', onInput, true); if (data && data.dispose) data.dispose(); };
  }

  return { attach };
})();
if (typeof module !== 'undefined') module.exports = TerminalIme;
