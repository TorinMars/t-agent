// Initial ANSI snapshots belong to xterm; archive pages only belong to this viewer.
const TerminalHistory = (() => {
  const button = document.getElementById('btn-terminal-history');
  let active = null, viewer = null, sequence = 0;
  const MAX_TEXT = 8 * 1024 * 1024;

  function refresh() {
    if (!button) return;
    button.disabled = (typeof TerminalControls !== 'undefined' && !!TerminalControls.busy) || !active || !active.available();
    button.title = active?.legacy ? '此 Engine 不支持分页历史，请升级 Engine' : '查看已保存的终端历史记录';
  }
  function close() {
    if (!viewer) return;
    viewer.owner.cancel();
    viewer.dialog.close?.();
    viewer.dialog.remove();
    viewer = null;
  }
  function activate(instance) {
    const next = instance?.history || null;
    if (active !== next) close();
    active = next;
    refresh();
  }
  function open() {
    if (!active?.available()) return;
    close();
    const owner = active;
    const dialog = document.createElement('dialog');
    dialog.className = 'terminal-history-dialog';
    dialog.setAttribute('aria-labelledby', 'terminal-history-title');
    dialog.innerHTML = '<div class="terminal-history-heading"><h2 id="terminal-history-title">历史记录</h2><button type="button" id="terminal-history-close">关闭</button></div><p>本次连接前的只读历史记录；新输出请在主终端查看。</p><button type="button" id="terminal-history-earlier">加载更早记录</button><span id="terminal-history-status" role="status"></span><pre id="terminal-history-text" tabindex="0" aria-label="终端历史记录"></pre>';
    document.body.appendChild(dialog);
    viewer = { owner, dialog, text: dialog.querySelector('pre'), status: dialog.querySelector('[role="status"]'),
      earlier: dialog.querySelector('#terminal-history-earlier'), before: owner.archive.before, hasMore: owner.archive.hasMore, loaded: false };
    dialog.querySelector('#terminal-history-close').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    viewer.earlier.addEventListener('click', () => owner.load());
    dialog.showModal?.();
    owner.load();
  }
  button?.addEventListener('click', open);

  function attach(instance) {
    let socket = null, pending = null, generation = 0;
    function current(ws) { return !instance.disposed && socket === ws && instance.ws === ws; }
    function cancel() {
      if (pending) clearTimeout(pending.timer);
      pending = null;
    }
    function status(message) {
      if (viewer?.owner !== api) return;
      viewer.status.textContent = message;
      viewer.earlier.disabled = !api.available() || !!pending || !viewer.hasMore;
    }
    const api = {
      archive: null, legacy: false, cancel,
      available: () => current(socket) && socket?.readyState === WebSocket.OPEN && !!api.archive,
      bind(ws) {
        cancel(); generation++;
        if (viewer?.owner === api) close();
        socket = ws; api.archive = null; api.legacy = false;
        instance.paused = false; instance.restoringHistory = false;
        refresh();
      },
      disconnect(ws) {
        if (socket !== ws) return;
        cancel(); generation++; api.archive = null;
        status('连接已断开，请重新连接后打开历史记录'); refresh();
      },
      dispose() {
        cancel(); generation++; socket = null;
        if (active === api) activate(null);
      },
      load() {
        if (viewer?.owner !== api || !api.available() || pending || !viewer.hasMore) {
          if (viewer?.owner === api && !viewer.hasMore) status('已加载全部保存记录');
          return;
        }
        if (viewer.text.textContent.length >= MAX_TEXT) { viewer.hasMore = false; status('已达到历史显示上限'); return; }
        const requestId = `history-${++sequence}`;
        pending = { requestId, before: viewer.before, timer: setTimeout(() => {
          pending = null; status('加载超时，请重试');
        }, 15000) };
        status('加载中…');
        try { socket.send(JSON.stringify({ type: 'history-page', id: api.archive.id, before: viewer.before, requestId })); }
        catch { cancel(); status('加载失败，请重试'); }
      },
      handle(data, ws) {
        if (typeof data !== 'string' || !data.startsWith('{')) return false;
        let message;
        try { message = JSON.parse(data); } catch { return false; }
        if (!['history', 'history-page'].includes(message?.type)) return false;
        if (!current(ws)) return true;
        if (message.type === 'history') {
          cancel();
          if (viewer?.owner === api) close();
          const archive = message.archive;
          api.archive = archive && typeof archive.id === 'string' && Number.isSafeInteger(archive.before) && archive.before >= 0 ? archive : null;
          api.legacy = !api.archive;
          refresh();
          instance.paused = true;
          instance.restoringHistory = true;
          const replay = ++generation;
          if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 1000 && message.rows >= 1 && message.rows <= 1000) {
            instance.term.resize(message.cols, message.rows);
          }
          instance.clipboard.writeHistory(typeof message.data === 'string' ? message.data : '', () => {
            if (!current(ws) || generation !== replay) return;
            if (instance.fitAddon && instance.el) TerminalViewport.fit(instance.term, instance.fitAddon, instance.el);
            TerminalViewport.restore(instance.term, instance.reconnectScroll || { bottom: true });
            instance.reconnectScroll = null;
            instance.restoringHistory = false;
            if (ws.readyState === WebSocket.OPEN && instance.term.cols && instance.term.rows) {
              ws.send(JSON.stringify({ type: 'resize', cols: instance.term.cols, rows: instance.term.rows }));
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (current(ws) && generation === replay) instance.paused = false;
            }));
          });
          return true;
        }
        if (!pending || viewer?.owner !== api || message.requestId !== pending.requestId || message.id !== api.archive?.id) return true;
        const before = pending.before;
        cancel();
        if (message.error || typeof message.data !== 'string' || !Number.isSafeInteger(message.before) || message.before < 0 || message.before >= before) {
          status('加载失败，请重试或重新打开终端'); return true;
        }
        if (message.data.length > 128 * 1024 || viewer.text.textContent.length + message.data.length > MAX_TEXT) {
          viewer.hasMore = false; status('已达到历史显示上限'); return true;
        }
        const { text } = viewer;
        const height = text.scrollHeight, top = text.scrollTop;
        text.textContent = message.data + text.textContent;
        text.scrollTop = viewer.loaded ? top + text.scrollHeight - height : text.scrollHeight;
        viewer.loaded = true; viewer.before = message.before; viewer.hasMore = Boolean(message.hasMore);
        status(viewer.hasMore ? '每次加载最多 500 行' : '已加载全部保存记录');
        return true;
      },
    };
    return api;
  }
  refresh();
  return { attach, activate, refresh };
})();
