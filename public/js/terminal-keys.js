// Virtual keys send terminal input, never operating-system shortcuts.
const TerminalKeys = (() => {
  function encode(key, mods = {}) {
    const modifier = 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0) + (mods.meta ? 8 : 0);
    const arrows = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
    if (arrows[key]) return `\x1b[${modifier === 1 ? '' : `1;${modifier}`}${arrows[key]}`;
    const tilde = { Delete: 3, PageUp: 5, PageDown: 6 };
    if (tilde[key]) return `\x1b[${tilde[key]}${modifier === 1 ? '' : `;${modifier}`}~`;
    const special = { Escape: '\x1b', Tab: '\t', Enter: '\r', Backspace: '\x7f', Space: ' ' };
    let text = special[key] ?? (Array.from(key).length === 1 ? key : null);
    if (text === null) return null;
    if (key === 'Tab' && mods.shift && modifier === 2) return '\x1b[Z';
    // Command is Super in the extended terminal keyboard protocol.
    if (mods.meta) return `\x1b[${text.codePointAt(0)};${modifier}u`;
    if (mods.ctrl) {
      const code = text.toUpperCase().charCodeAt(0);
      if (text === ' ' || text === '@') text = '\x00';
      else if (code >= 65 && code <= 95) text = String.fromCharCode(code & 31);
      else if (text === '?') text = '\x7f';
      else return `\x1b[${text.codePointAt(0)};${modifier}u`;
    } else if (mods.shift && !special[key]) text = text.toUpperCase();
    return (mods.alt ? '\x1b' : '') + text;
  }

  if (typeof document !== 'undefined') {
    const bar = document.getElementById('terminal-keys');
    const pane = document.getElementById('terminal-pane');
    let mods = {};
    function render() {
      bar.querySelectorAll('[data-modifier]').forEach(button => {
        button.setAttribute('aria-pressed', String(Boolean(mods[button.dataset.modifier])));
      });
    }
    function clear() { mods = {}; render(); }
    function send(key, override) {
      const data = encode(key, override || mods);
      if (data === null) return false;
      const target = window.RemoteTasks?.getActiveEngineKey() !== 'local' && window.RemoteTasks
        ? window.RemoteTasks : window.Tasks;
      target?.sendTerminalInput(data);
      clear();
      return true;
    }
    if (bar && pane) {
      bar.addEventListener('mousedown', event => event.preventDefault());
      bar.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.modifier) {
          const name = button.dataset.modifier;
          mods[name] = !mods[name];
          render();
        } else if (button.dataset.shortcut === 'option-up') send('ArrowUp', { alt: true });
        else if (button.dataset.key) send(button.dataset.key);
      });
      document.addEventListener('keydown', event => {
        if (!pane.contains(event.target) || pane.style.display === 'none' || event.isComposing || !Object.values(mods).some(Boolean)) return;
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
        const combined = { shift: mods.shift || event.shiftKey, ctrl: mods.ctrl || event.ctrlKey,
          alt: mods.alt || event.altKey, meta: mods.meta || event.metaKey };
        if (send(event.key, combined)) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
      document.addEventListener('click', event => {
        if (!bar.contains(event.target) && !event.target.closest('#xterm-container')) clear();
      });
      window.addEventListener('blur', clear);
    }
  }
  return { encode };
})();
if (typeof module !== 'undefined') module.exports = TerminalKeys;
