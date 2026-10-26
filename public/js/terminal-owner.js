// A terminal has one owner at a time. The server refuses a second client (close code 4009) and tells the
// previous owner when someone took over (4010). This helper holds the client id and the "use it here" prompt.
const TerminalOwner = (() => {
  const IN_USE = 4009;
  const TAKEN = 4010;
  let id = null;

  function t(text) { return typeof I18n !== 'undefined' ? I18n.t(text) : text; }

  // One id per browser tab: a refresh keeps it, so it never fights with its own old socket.
  function clientId() {
    if (id) return id;
    try { id = sessionStorage.getItem('terminal-client-id'); } catch { /* storage may be blocked */ }
    if (!id) {
      id = (globalThis.crypto?.randomUUID?.() || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).slice(0, 36);
      try { sessionStorage.setItem('terminal-client-id', id); } catch { /* keep it in memory */ }
    }
    return id;
  }

  function query(takeover) {
    return `&clientId=${encodeURIComponent(clientId())}${takeover ? '&takeover=1' : ''}`;
  }

  const isBlocked = code => code === IN_USE || code === TAKEN;

  // Shows the notice over `host` with a button that runs `onTake`. Returns a function that removes it.
  function prompt(host, code, onTake) {
    host.querySelector(':scope > .terminal-owner-prompt')?.remove();
    const box = host.ownerDocument.createElement('div');
    box.className = 'terminal-owner-prompt';
    box.setAttribute('role', 'alert');
    const text = host.ownerDocument.createElement('p');
    text.textContent = t(code === TAKEN
      ? 'This terminal is now used by another device.'
      : 'This terminal is in use on another device.');
    const button = host.ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = t('Use this terminal here');
    const remove = () => box.remove();
    button.addEventListener('click', () => { remove(); onTake(); });
    box.append(text, button);
    host.appendChild(box);
    return remove;
  }

  return { IN_USE, TAKEN, clientId, query, isBlocked, prompt };
})();
if (typeof module !== 'undefined') module.exports = TerminalOwner;
