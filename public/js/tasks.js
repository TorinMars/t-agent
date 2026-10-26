const Tasks = (() => {
  // ── Data sources ──
  // The local Client and each remote Engine is a "data source" sharing one UI; only the request base path,
  // terminal address and capabilities differ. The sidebar shows the tasks of the current source only.
  const STATUS_LABEL = { doing: 'In progress', todo: 'To do', done: 'Done', personal: 'Personal tasks' };
  const STATUS_NEXT = { todo: 'doing', doing: 'done', done: 'personal', personal: 'todo' };
  const DEFAULT_GROUPS = [
    { id: null, key: 'personal', name: 'Personal tasks', sort_order: 0, is_system: false },
    { id: null, key: 'doing', name: 'In progress', sort_order: 1000, is_system: true },
    { id: null, key: 'todo', name: 'To do', sort_order: 2000, is_system: true },
    { id: null, key: 'done', name: 'Done', sort_order: 3000, is_system: true },
  ];
  const sources = new Map();
  const sourceListeners = new Set();

  function makeSource(desc) {
    return {
      key: 'local', label: 'Default', local: false, tasksBase: '/api/tasks', groupsBase: '/api/task-groups',
      wsPath: '/terminal/ws', activityUrl: null,
      caps: null,       // null = everything available (local); otherwise the capability set declared by the Engine
      role: null, problem: null, loaded: false,
      tasks: [], groups: DEFAULT_GROUPS.map(group => ({ ...group })), selectedId: null,
      ...desc,
    };
  }
  sources.set('local', makeSource({ local: true }));
  let source = sources.get('local');
  let tasks = [];       // tasks of the current source (kept in sync with source.tasks)
  let selectedId = null; // task selected in the current source

  const can = capability => source.caps === null || source.caps.has(capability);
  const taskUrl = (id, suffix = '') => `${source.tasksBase}/${id}${suffix}`;
  // localStorage keys: local keeps the original key names, remote ones get a source prefix so equal task ids on different Engines do not collide.
  const storageId = (id, src = source) => (src.local ? String(id) : `${src.key}:${id}`);
  const selectedStorageKey = (src = source) => (src.local ? 'selectedTaskId' : `remote-selected-task-${src.id}`);
  const terminalScope = (taskId, src = source) => `${src.tasksBase}/${taskId}`;
  const activeKeyPreference = () => localStorage.getItem('active-engine-key') || 'local';
  const notifySourceChange = () => sourceListeners.forEach(listener => { try { listener(); } catch {} });

  function groupsFor(src, list) {
    return Array.isArray(list) && list.length ? list : fallbackGroups(src.tasks);
  }

  // When the Engine returns no groups (old version), derive them from the statuses tasks have.
  function fallbackGroups(taskList = []) {
    const groups = DEFAULT_GROUPS.map(group => ({ ...group }));
    const known = new Set(groups.map(group => group.key));
    taskList.forEach(task => {
      if (!known.has(task.status)) {
        known.add(task.status);
        groups.splice(groups.length - 3, 0, { id: null, key: task.status, name: task.status, sort_order: 500, is_system: false });
      }
    });
    return groups;
  }
  const PRIORITY_LABEL = { high: 'High', normal: 'Medium', low: 'Low' };
  const collapsedGroups = {};
  let tocObserver = null;
  let mdWatcher = null;
  let mdRenderRevision = 0;
  let editorState = null;

  // ── Tab & Terminal state ──
  const VALID_TABS = ['doc', 'readme', 'agent', 'todos', 'shell'];
  let activeTab = 'doc';

  function getTaskTab(id) {
    const tab = localStorage.getItem(`task-tab-${storageId(id)}`) || 'doc';
    return VALID_TABS.includes(tab) ? tab : 'doc';
  }
  function saveTaskTab(id, tab) {
    localStorage.setItem(`task-tab-${storageId(id)}`, tab);
  }
  let term = null;
  let fitAddon = null;
  let termWs = null;
  let termTaskId = null;   // taskId the current terminal is bound to

  // mermaid is about 5 MB and is loaded on the first diagram render; a failed load clears the cache so the next render retries.
  const MERMAID_SRC = '/vendor/mermaid/mermaid-12.1.0.min.js';
  let mermaidReady = null;
  function ensureMermaid() {
    if (!mermaidReady) {
      const loaded = typeof mermaid !== 'undefined' ? Promise.resolve() : new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = MERMAID_SRC;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Mermaid failed to load'));
        document.head.appendChild(script);
      });
      mermaidReady = loaded
        .then(() => mermaid.initialize({ startOnLoad: false, theme: typeof Theme === 'undefined' ? 'default' : Theme.mermaidTheme(), gantt: { useWidth: undefined }, locale: 'zh-CN' }))
        .catch(error => { mermaidReady = null; throw error; });
    }
    return mermaidReady;
  }

  const previewPane = document.getElementById('preview-pane');
  const contentToolbar = document.getElementById('content-toolbar');
  const contentTabs = document.getElementById('content-tabs');
  const terminalPane = document.getElementById('terminal-pane');

  // ── Tab switching ──
  contentTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === activeTab) return;
    if (!confirmDiscardEditor()) return;
    const previousTab = activeTab;
    activeTab = tab;
    if (selectedId) saveTaskTab(selectedId, tab);
    contentTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab !== 'shell') {
      previewPane.style.display = '';
      TerminalHistory.activate(null);
      terminalPane.style.display = 'none';
      const task = tasks.find(t => t.id === selectedId);
      if (task) renderPreview(task);
    } else {
      const task = tasks.find(t => t.id === selectedId);
      contentToolbar.style.visibility = 'visible';
      contentToolbar.style.pointerEvents = '';
      contentToolbar.style.display = task ? 'flex' : 'none';
      document.getElementById('btn-share-md').style.display = task && task.md_path ? '' : 'none';
      setEditButtonState(false);
      previewPane.style.display = 'none';
      hideToc();
      stopWatcher();
      terminalPane.style.display = 'flex';
      // clear the "finished, awaiting review" state when switching to the terminal
      acknowledgeCurrentTerminal();
      if (task) {
        connectTerminal(task);
        // connectTerminal is async (onopen); an existing instance is simply focused
        const inst = termInstances.get(terminalKey(task.id));
        if (inst) setTimeout(() => { if (!inst.disposed && term === inst.term && selectedId === task.id && activeTab === 'shell') inst.term.focus(); }, 0);
      }
    }
  });

  // ── Every terminal of every task is cached independently; switching tabs only hides the view ──
  const termInstances = new Map(); // [sourceKey, taskId, terminalId] -> live terminal instance
  function terminalKey(taskId, terminalId, sourceKey = source.key) {
    const src = sources.get(sourceKey) || source;
    return JSON.stringify([sourceKey, taskId, terminalId ?? TerminalTabs.current(terminalScope(taskId, src))]);
  }

  // Terminal state is decided by the server from the PTY foreground process (running / done); this code only displays it.
  // A task item on the left shows the aggregate state of all its terminals; each terminal tab shows its own.
  function applyTermState(item, state) {
    item.classList.toggle('term-running', state === 'running');
    item.classList.toggle('term-done', state === 'done');
  }

  function refreshTermIndicators() {
    document.querySelectorAll('.task-nav-item[data-id]').forEach(item => {
      applyTermState(item, TerminalActivity.taskState(Number(item.dataset.id), source.key));
    });
    TerminalTabs.refresh();
    notifySourceChange(); // the engine tab aggregates the terminal states of its tasks
  }

  // If the user is looking at a task's current terminal, treat the completion as acknowledged.
  function viewingTerminal(taskId) {
    return selectedId === taskId && activeTab === 'shell' && !document.hidden;
  }

  function acknowledgeCurrentTerminal() {
    if (!selectedId || activeTab !== 'shell') return;
    TerminalActivity.acknowledge(selectedId, TerminalTabs.current(terminalScope(selectedId)), source.key);
  }

  TerminalActivity.onChange(refreshTermIndicators);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) acknowledgeCurrentTerminal(); });
  TerminalActivity.start();

  function disposeTerminalInstance(taskId, terminalId, sourceKey = source.key) {
    const key = terminalKey(taskId, terminalId, sourceKey);
    const inst = termInstances.get(key);
    if (!inst) return;
    inst.disposed = true;
    if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
    if (inst.resizeObserver) inst.resizeObserver.disconnect();
    if (inst.onWindowResize) window.removeEventListener('resize', inst.onWindowResize);
    if (inst.ws) inst.ws.close();
    inst.history.dispose();
    inst.images.dispose();
    inst.clipboard.dispose();
    inst.term.dispose();
    inst.el.remove();
    termInstances.delete(key);
    if (term === inst.term) {
      term = null;
      fitAddon = null;
      termWs = null;
      termTaskId = null;
    }
  }

  function scheduleReconnect(task, inst) {
    if (inst.disposed || termInstances.get(terminalKey(task.id, inst.terminalId, inst.sourceKey)) !== inst || inst.reconnectTimer) return;
    const delay = Math.min(1000 * (2 ** inst.reconnectAttempts), 30000);
    inst.reconnectAttempts += 1;
    inst.reconnectTimer = setTimeout(() => {
      inst.reconnectTimer = null;
      if (!inst.disposed && termInstances.get(terminalKey(task.id, inst.terminalId, inst.sourceKey)) === inst) connectWebSocket(task, inst);
    }, delay);
    inst.term.write(typeof I18n !== 'undefined' ? I18n.t(`\r\n\x1b[33m[Connection lost, reconnecting in ${Math.ceil(delay / 1000)}s...]\x1b[0m\r\n`) : `\r\n\x1b[33m[Connection lost, reconnecting in ${Math.ceil(delay / 1000)}s...]\x1b[0m\r\n`);
  }

  function connectWebSocket(task, inst, takeover = false) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${inst.wsPath}?taskId=${task.id}&terminalId=${encodeURIComponent(inst.terminalId)}${TerminalOwner.query(takeover)}`);
    ws.binaryType = 'arraybuffer';
    inst.ws = ws;
    inst.history.bind(ws);
    if (term === inst.term) termWs = ws;

    ws.onopen = () => {
      const reconnecting = inst.reconnectAttempts > 0;
      if (reconnecting) {
        inst.reconnectScroll = TerminalViewport.capture(inst.term);
        inst.term.reset();
      }
      inst.reconnectAttempts = 0;
      TerminalViewport.fit(inst.term, inst.fitAddon, inst.el);
      if (!reconnecting && term === inst.term && activeTab === 'shell' && selectedId === task.id && source.key === inst.sourceKey) inst.term.focus();
      ws.send(JSON.stringify({ type: 'resize', cols: inst.term.cols, rows: inst.term.rows }));
    };

    ws.onmessage = (e) => {
      if (inst.disposed || inst.ws !== ws) return;
      if (inst.history.handle(e.data, ws)) return;
      if (e.data instanceof ArrayBuffer) {
        inst.term.write(new Uint8Array(e.data));
      } else {
        inst.term.write(e.data);
      }
    };

    ws.onclose = (event) => {
      if (inst.ws !== ws || inst.disposed || termInstances.get(terminalKey(task.id, inst.terminalId, inst.sourceKey)) !== inst) return;
      inst.history.disconnect(ws);
      inst.ws = null;
      if (TerminalOwner.isBlocked(event.code)) {
        TerminalOwner.prompt(inst.el, event.code, () => { inst.reconnectAttempts = 0; connectWebSocket(task, inst, true); });
        return;
      }
      if (event.code === 1000 || event.code === 1008) {
        inst.term.write(typeof I18n !== 'undefined' ? I18n.t('\r\n[Terminal disconnected. Click “Reopen” to reconnect]\r\n') : '\r\n[Terminal disconnected. Click “Reopen” to reconnect]\r\n');
        return;
      }
      scheduleReconnect(task, inst);
    };

    ws.onerror = () => {};
  }

  function connectTerminal(task) {
    const container = document.getElementById('xterm-container');
    TerminalControls.clearMessage();
    const terminalId = TerminalTabs.show(terminalScope(task.id), () => connectTerminal(task), {
      taskId: task.id,
      sourceKey: source.key,
      viewing: () => viewingTerminal(task.id),
    });
    if (terminalId == null) {
      // Every terminal of the task was deleted: show a hint instead of a shell.
      Array.from(container.children).forEach(el => { el.style.display = 'none'; });
      term = null;
      fitAddon = null;
      termWs = null;
      TerminalControls.showMessage('This task has no terminal. Click “+” to start one.');
      return;
    }
    const key = terminalKey(task.id, terminalId);

    if (termInstances.has(key)) {
      const inst = termInstances.get(key);
      if ((inst.ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(inst.ws.readyState)) || inst.reconnectTimer) {
        Array.from(container.children).forEach(el => { el.style.display = el === inst.el ? '' : 'none'; });
        TerminalHistory.activate(inst);
        term = inst.term;
        fitAddon = inst.fitAddon;
        termWs = inst.ws;
        termTaskId = task.id;
        setTimeout(() => { if (term !== inst.term || inst.disposed || activeTab !== 'shell') return; TerminalViewport.fit(inst.term, inst.fitAddon, inst.el); inst.term.focus(); }, 0);
        return;
      }
      disposeTerminalInstance(task.id);
    }

    Array.from(container.children).forEach(el => { el.style.display = 'none'; });

    const el = document.createElement('div');
    el.className = 'xterm-host';
    container.appendChild(el);

    const t = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: typeof Theme === 'undefined' ? { background: '#1e1e1e' } : Theme.terminal(),
      scrollback: 5000,
      // Hyperlinks printed by programs with OSC 8 (Claude Code etc.; the visible text may differ from the real address): they also need Cmd/Ctrl-click,
      // confirm the real address first and only open http(s). xterm's default is a confirm box on a single click.
      linkHandler: {
        activate(event, uri) {
          if (!(event.metaKey || event.ctrlKey) || !/^https?:\/\//i.test(uri)) return;
          if (confirm(`Open link?\n\n${uri}`)) window.open(uri, '_blank', 'noopener,noreferrer');
        },
      },
    });
    const fa = new FitAddon.FitAddon();
    t.loadAddon(fa);
    // Cmd (macOS) / Ctrl + click opens a link from the terminal in a new tab; without a modifier it is ordinary selection, avoiding accidental clicks.
    t.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    t.open(el);
    const clipboard = TerminalClipboard.attach(t, el);

    const inst = {
      clipboard,
      sourceKey: source.key,
      wsPath: source.wsPath,
      taskId: task.id,
      terminalId,
      term: t,
      fitAddon: fa,
      ws: null,
      el,
      paused: false,
      disposed: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      resizeObserver: null,
    };
    inst.history = TerminalHistory.attach(inst);
    TerminalHistory.activate(inst);
    inst.images = TerminalImages.attach(t, el, () => !inst.disposed && !inst.paused ? inst.ws : null);
    inst.resizeObserver = TerminalViewport.observe(t, fa, el);
    termInstances.set(key, inst);
    termTaskId = task.id;
    term = t;
    fitAddon = fa;

    t.onData(data => {
      if (inst.paused || TerminalImages.busy) return;
      if (inst.ws && inst.ws.readyState === WebSocket.OPEN) inst.ws.send(data);
    });

    t.onResize(({ cols, rows }) => {
      if (inst.restoringHistory) return;
      if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
        inst.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    connectWebSocket(task, inst);

    inst.onWindowResize = () => {
      if (activeTab === 'shell' && term === inst.term) TerminalViewport.fit(t, fa, el);
    };
    window.addEventListener('resize', inst.onWindowResize);
  }

  function selectedTerminalTask() {
    const task = tasks.find(item => item.id === selectedId);
    if (!task) throw new Error('Select a task first');
    return task;
  }

  function currentTerminalId(task) {
    const id = TerminalTabs.current(terminalScope(task.id));
    if (id == null) throw new Error('This task has no terminal. Click “+” to start one.');
    return id;
  }

  async function reopenTerminal() {
    const task = selectedTerminalTask();
    currentTerminalId(task);
    disposeTerminalInstance(task.id);
    TerminalControls.clearMessage();
    connectTerminal(task);
  }

  async function controlTerminal(action) {
    const task = selectedTerminalTask();
    currentTerminalId(task);
    disposeTerminalInstance(task.id);
    try {
      await API.post(`${terminalScope(task.id)}/terminal/control`, { action, terminal_id: TerminalTabs.current(terminalScope(task.id)) });
    } catch (error) {
      // If the control request fails, restore the original server session so no invisible running process is left behind.
      connectTerminal(task);
      throw error;
    }
    TerminalActivity.refresh(source.key);
    if (action === 'restart-workdir') {
      TerminalControls.clearMessage();
      connectTerminal(task);
    } else {
      TerminalControls.showMessage('The terminal is closed. Click “Reopen” to start a new one in the task working directory.');
    }
  }

  async function deleteTerminal(requestedId) {
    const task = selectedTerminalTask();
    const scope = terminalScope(task.id);
    const terminalId = requestedId || TerminalTabs.current(scope);
    await API.post(`${scope}/terminal/control`, { action: 'delete', terminal_id: terminalId });
    disposeTerminalInstance(task.id, terminalId);
    TerminalTabs.remove(scope, terminalId);
  }

  function closeTerminal() {
    return controlTerminal('close');
  }

  function restartTerminalFromWorkDir() {
    return controlTerminal('restart-workdir');
  }



  async function openFileBrowser() {
    const task = tasks.find(item => item.id === selectedId);
    if (!task || !confirmDiscardEditor()) return;
    stopWatcher();
    if (activeTab !== 'shell') contentTabs.querySelector('[data-tab="shell"]').click();
    if (activeTab !== 'shell') return;
    return FilePanel.open({ key: `${source.key}:${task.id}`, baseUrl: taskUrl(task.id, '/files'), title: task.title, root: task.work_dir });
  }

  document.querySelector('.content-area')?.addEventListener('file-panel:layout', event => {
    document.getElementById('btn-file-browser')?.setAttribute('aria-expanded', String(Boolean(event.detail.open)));
  });

  document.getElementById('btn-file-browser')?.addEventListener('click', async () => {
    try {
      if (FilePanel.isOpen()) { await FilePanel.close(); return; }
      await openFileBrowser();
    } catch (error) { alert('Could not open the file browser: ' + error.message); }
  });

  // Opening in Finder / VS Code and creating share links depend on the local file system, so remote tasks do not offer them.
  document.getElementById('btn-reveal-folder').addEventListener('click', async () => {
    if (!selectedId || !source.local) return;
    await API.post(`/api/tasks/${selectedId}/reveal`, {});
  });

  document.getElementById('btn-open-vscode').addEventListener('click', async () => {
    if (!selectedId || !source.local) return;
    await API.post(`/api/tasks/${selectedId}/vscode`, {});
  });

  document.getElementById('btn-share-md').addEventListener('click', async () => {
    if (!selectedId || !source.local) return;
    try {
      const { url } = await API.post(`/api/tasks/${selectedId}/share`, {});
      let base = location.origin;
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        try {
          const { ip, port } = await API.get('/api/local-ip');
          base = `http://${ip}:${port}`;
        } catch (e) {}
      }
      const fullUrl = `${base}${url}`;
      await navigator.clipboard.writeText(fullUrl);
      const btn = document.getElementById('btn-share-md');
      const orig = btn.innerHTML;
      btn.textContent = 'Copied ✓';
      btn.style.color = 'var(--accent)';
      setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 2000);
    } catch (e) {
      alert('Could not create share link: ' + e.message);
    }
  });

  document.getElementById('btn-edit-md').addEventListener('click', () => {
    if (!selectedId || !['doc', 'readme', 'agent'].includes(activeTab)) return;
    const task = tasks.find(t => t.id === selectedId);
    if (task) openDocumentEditor(task, activeTab);
  });

  let scrollSaveTimer = null;
  previewPane.addEventListener('scroll', () => {
    if (!selectedId) return;
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      if (['doc', 'readme', 'agent'].includes(activeTab)) {
        localStorage.setItem(`mdScroll_${storageId(selectedId)}_${activeTab}`, previewPane.scrollTop);
      }
    }, 150);
  });

  // Base renderer (without relative-path rewriting; the taskId has to be passed at run time)
  function makeRenderer(taskId) {
    const isRelativeSrc = src => src && !src.startsWith('http') && !src.startsWith('/') && !src.startsWith('data:');
    // Relative images/links are read through the current data source; left as-is when the Engine does not support it.
    const fileUrl = href => `${taskUrl(taskId, '/file')}?path=${encodeURIComponent(href)}`;
    const rewrites = Boolean(taskId) && can('files:assets');
    const renderer = {
      code({ text, lang }) {
        if (lang === 'mermaid') {
          return `<div class="mermaid">${text}</div>`;
        }
        return false;
      },
      link({ href, title, text }) {
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        if (rewrites && isRelativeSrc(href) && !href.startsWith('#') && !href.startsWith('mailto:')) {
          return `<a href="${fileUrl(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
        }
        return `<a href="${href}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
      image({ href, title, text }) {
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        const alt = text ? ` alt="${escapeHtml(text)}"` : '';
        const src = (rewrites && isRelativeSrc(href)) ? fileUrl(href) : href;
        return `<img src="${src}"${alt}${t} style="max-width:100%">`;
      },
    };
    return renderer;
  }

  function renderMd(content, taskId) {
    // Create a separate instance each time to inject the renderer for the current taskId, avoiding global state pollution
    const m = new marked.Marked({ renderer: makeRenderer(taskId) });
    return m.parse(content);
  }

  // After a theme change, redraw the diagrams already shown with the new theme (source kept in data-mermaid-source).
  async function rerenderMermaid() {
    const nodes = [...document.querySelectorAll('.mermaid[data-mermaid-source]')];
    if (!nodes.length || typeof mermaid === 'undefined') return;
    for (const node of nodes) {
      node.textContent = node.dataset.mermaidSource;
      node.removeAttribute('data-processed');
      try {
        await mermaid.run({ nodes: [node] });
        const svg = node.querySelector('svg');
        if (svg) { svg.style.width = '100%'; svg.style.height = 'auto'; }
      } catch { /* keep the source text; the next time the document is opened it is rendered again */ }
    }
  }
  // The terminals follow the theme too: their background is part of the same set of colours as the tabs around them.
  if (typeof Theme !== 'undefined') Theme.onChange(() => { rerenderMermaid(); for (const inst of termInstances.values()) inst.term.options.theme = Theme.terminal(); });

  // Add a zoom button to rendered mermaid SVGs; clicking it opens a modal
  function wrapMermaidDiagrams(container) {
    container.querySelectorAll('.mermaid').forEach(el => {
      if (el.dataset.zoomBound) return;
      el.dataset.zoomBound = '1';

      const wrap = document.createElement('div');
      wrap.className = 'mermaid-wrap';
      // each actor renders 2 g.actor elements (top + bottom), so divide by 2 for the real count
      const actorCount = el.querySelectorAll('g.actor').length / 2;
      const svg = el.querySelector('svg');
      if (actorCount > 0 && actorCount <= 3) {
        wrap.style.width = '50%';
        if (svg) { svg.style.width = '100%'; svg.style.height = 'auto'; }
      } else {
        if (svg) { svg.style.width = '100%'; svg.style.height = 'auto'; }
      }
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);

      const btn = document.createElement('button');
      btn.className = 'mermaid-expand-btn';
      btn.title = 'Zoom';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
      wrap.appendChild(btn);

      btn.addEventListener('click', () => openMermaidModal(el));
    });
  }

  // Modal zoom view
  let mermaidModal = null;
  function openMermaidModal(el) {
    if (!mermaidModal) {
      mermaidModal = document.createElement('div');
      mermaidModal.className = 'mermaid-modal';
      mermaidModal.innerHTML = `
        <div class="mermaid-modal-backdrop"></div>
        <div class="mermaid-modal-box">
          <button class="mermaid-modal-close" title="Close">✕</button>
          <div class="mermaid-modal-hint">Pinch to zoom · drag to pan · double-click to reset</div>
          <div class="mermaid-modal-viewport">
            <div class="mermaid-modal-canvas"></div>
          </div>
        </div>`;
      document.body.appendChild(mermaidModal);

      const backdrop = mermaidModal.querySelector('.mermaid-modal-backdrop');
      const closeBtn = mermaidModal.querySelector('.mermaid-modal-close');
      const viewport = mermaidModal.querySelector('.mermaid-modal-viewport');
      const canvas = mermaidModal.querySelector('.mermaid-modal-canvas');

      let scale = 1, tx = 0, ty = 0;
      let fitScale = 1; // fit scale computed each time the modal opens
      let dragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;

      const applyTransform = () => {
        canvas.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
      };
      const zoomAt = (nextScale, clientX, clientY) => {
        // Keep the point under the pointer/fingers stationary while zooming.
        // There is intentionally no upper clamp: Mermaid SVG stays vector-sharp
        // and users can keep zooming into dense sequence diagrams.
        nextScale = Math.max(0.2, nextScale);
        if (!Number.isFinite(nextScale)) return;
        const rect = viewport.getBoundingClientRect();
        const pointerX = clientX - (rect.left + rect.width / 2);
        const pointerY = clientY - (rect.top + rect.height / 2);
        const ratio = nextScale / scale;
        tx = pointerX - (pointerX - tx) * ratio;
        ty = pointerY - (pointerY - ty) * ratio;
        scale = nextScale;
      };
      const reset = () => {
        fitScale = mermaidModal._fitScale || 1;
        scale = fitScale; tx = 0; ty = 0;
        applyTransform();
      };

      viewport.addEventListener('wheel', e => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          // trackpad pinch → zoom
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          zoomAt(scale * factor, e.clientX, e.clientY);
        } else {
          // trackpad two-finger pan → move
          tx -= e.deltaX;
          ty -= e.deltaY;
        }
        applyTransform();
      }, { passive: false });

      viewport.addEventListener('mousedown', e => {
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        startTx = tx; startTy = ty;
        viewport.style.cursor = 'grabbing';
      });
      window.addEventListener('mousemove', e => {
        if (!dragging) return;
        tx = startTx + (e.clientX - startX);
        ty = startTy + (e.clientY - startY);
        applyTransform();
      });
      window.addEventListener('mouseup', () => { dragging = false; viewport.style.cursor = ''; });

      // touch: two-finger pinch zooms, one or two fingers move
      let lastTouchDist = null, lastTouchMidX = 0, lastTouchMidY = 0;
      viewport.addEventListener('touchstart', e => {
        e.preventDefault();
        if (e.touches.length === 2) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          lastTouchDist = Math.hypot(dx, dy);
          lastTouchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          lastTouchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        } else if (e.touches.length === 1) {
          lastTouchDist = null;
          startX = e.touches[0].clientX; startY = e.touches[0].clientY;
          startTx = tx; startTy = ty;
        }
      }, { passive: false });

      viewport.addEventListener('touchmove', e => {
        e.preventDefault();
        if (e.touches.length === 2) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.hypot(dx, dy);
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          // zoom
          if (lastTouchDist) {
            zoomAt(scale * dist / lastTouchDist, lastTouchMidX, lastTouchMidY);
          }
          // pan: accumulate the difference between the centre points of the current and previous frame
          tx += midX - lastTouchMidX;
          ty += midY - lastTouchMidY;
          lastTouchDist = dist;
          lastTouchMidX = midX;
          lastTouchMidY = midY;
          applyTransform();
        } else if (e.touches.length === 1 && lastTouchDist === null) {
          tx = startTx + (e.touches[0].clientX - startX);
          ty = startTy + (e.touches[0].clientY - startY);
          applyTransform();
        }
      }, { passive: false });

      viewport.addEventListener('touchend', e => {
        if (e.touches.length < 2) lastTouchDist = null;
        if (e.touches.length === 1) {
          startX = e.touches[0].clientX; startY = e.touches[0].clientY;
          startTx = tx; startTy = ty;
        }
      }, { passive: false });

      viewport.addEventListener('dblclick', reset);
      closeBtn.addEventListener('click', () => closeMermaidModal(reset));
      backdrop.addEventListener('click', () => closeMermaidModal(reset));
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && mermaidModal.classList.contains('open')) closeMermaidModal(reset);
      });

      mermaidModal._reset = reset;
    }

    const canvas = mermaidModal.querySelector('.mermaid-modal-canvas');
    const viewport = mermaidModal.querySelector('.mermaid-modal-viewport');
    canvas.innerHTML = '';
    const cloned = el.cloneNode(true);
    // the cloned SVG gets its original size back; the modal decides the scaling itself
    const clonedSvg = cloned.querySelector('svg');
    if (clonedSvg) { clonedSvg.style.width = ''; clonedSvg.style.height = ''; }
    canvas.appendChild(cloned);
    mermaidModal.classList.add('open');
    document.body.style.overflow = 'hidden';

    // compute a suitable initial scale after the modal is shown
    requestAnimationFrame(() => {
      const vw = viewport.clientWidth - 48;
      const vh = viewport.clientHeight - 48;
      const cw = canvas.scrollWidth;
      const ch = canvas.scrollHeight;
      if (cw > 0 && ch > 0) {
        mermaidModal._fitScale = cw > 0 ? (vw / cw) : 1;
      } else {
        mermaidModal._fitScale = 1;
      }
      mermaidModal._reset();
    });
  }

  function closeMermaidModal(reset) {
    if (!mermaidModal) return;
    mermaidModal.classList.remove('open');
    document.body.style.overflow = '';
    if (reset) reset();
  }

  function formatDue(dateStr) {
    if (!dateStr) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dateStr + 'T00:00:00');
    const diff = Math.floor((due - today) / 86400000);
    if (diff < 0) return { text: 'Overdue', overdue: true };
    if (diff === 0) return { text: 'Today', overdue: false };
    if (diff === 1) return { text: 'Tomorrow', overdue: false };
    return { text: dateStr, overdue: false };
  }

  // An unreachable Engine: authentication expired, service offline, or loading tasks failed this time.
  function problemOf(src) {
    if (src.local) return null;
    const server = src.server || {};
    if (server.status === 'unauthorized') return { code: 'REMOTE_HTTP_401', unauthorized: true };
    if (server.status === 'offline' || src.loadError) {
      return { code: src.loadError || server.last_error || 'REMOTE_CONNECTION_FAILED', unauthorized: src.loadError === 'REMOTE_HTTP_401' };
    }
    return null;
  }

  function renderSidebar() {
    const nav = document.getElementById('task-nav');
    const scrollTop = nav.scrollTop;
    nav.innerHTML = '';

    const section = document.createElement('div');
    section.className = 'task-sidebar-section';
    section.dataset.engineKey = source.key;
    nav.appendChild(section);

    if (problemOf(source)) {
      const note = document.createElement('div');
      note.className = 'remote-empty';
      note.textContent = 'Service unavailable, please check its status';
      section.appendChild(note);
      nav.scrollTop = scrollTop;
      return;
    }

    const writable = can('tasks:write');
    const heading = document.createElement('div');
    heading.className = 'sidebar-section-heading';
    const title = document.createElement('span');
    title.textContent = source.local ? 'Local tasks' : source.label;
    const count = document.createElement('span');
    count.className = 'sidebar-section-count';
    count.textContent = tasks.length;
    const tools = document.createElement('span');
    tools.className = 'sidebar-section-tools';
    tools.appendChild(count);
    if (writable) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'sidebar-section-add';
      add.title = 'New task group';
      add.setAttribute('aria-label', 'New task group');
      add.textContent = '+';
      add.addEventListener('click', () => showCreateGroup());
      tools.appendChild(add);
    }
    heading.append(title, tools);
    section.appendChild(heading);

    const groups = source.groups;
    groups.forEach(group => section.appendChild(buildGroup(group, groups, writable)));
    nav.scrollTop = scrollTop;
  }

  function buildGroup(group, groups, writable) {
    const status = group.key;
    const collapseKey = `${source.key}:${status}`;
    const groupEl = document.createElement('div');
    groupEl.className = 'task-group';
    groupEl.dataset.status = status;

    const headerEl = document.createElement('div');
    headerEl.className = 'task-group-header';
    headerEl.dataset.mobileMenu = group.is_system || !group.id ? 'false' : 'true';
    headerEl.title = group.is_system || !group.id ? 'Default group' : 'Right-click to manage groups';

    const toggleEl = document.createElement('span');
    toggleEl.className = `task-group-toggle${collapsedGroups[collapseKey] ? ' collapsed' : ''}`;
    toggleEl.textContent = '▾';
    const labelEl = document.createElement('span');
    labelEl.className = 'task-group-label';
    labelEl.textContent = group.name;
    const groupTasks = tasks.filter(task => task.status === status);
    const countEl = document.createElement('span');
    countEl.className = 'task-group-count';
    countEl.textContent = groupTasks.length;
    headerEl.append(toggleEl, labelEl, countEl);

    const itemsEl = document.createElement('div');
    itemsEl.className = `task-group-items${collapsedGroups[collapseKey] ? ' collapsed' : ''}`;
    itemsEl.dataset.status = status;
    groupTasks.forEach(task => itemsEl.appendChild(buildNavItem(task, groups, writable)));

    if (writable) {
      // drop onto a group (an empty group can receive too)
      itemsEl.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const draggingEl = document.querySelector('.task-nav-item.dragging');
        if (!draggingEl) return;
        let placeholder = document.getElementById('drag-placeholder');
        if (!placeholder) {
          placeholder = document.createElement('div');
          placeholder.id = 'drag-placeholder';
          placeholder.className = 'drag-placeholder';
        }
        const afterEl = getDragAfterElement(itemsEl, e.clientY);
        if (afterEl) itemsEl.insertBefore(placeholder, afterEl);
        else itemsEl.appendChild(placeholder);
      });

      itemsEl.addEventListener('dragleave', e => {
        // only remove the placeholder when truly leaving the whole itemsEl
        if (!itemsEl.contains(e.relatedTarget)) {
          const ph = document.getElementById('drag-placeholder');
          if (ph && ph.parentNode === itemsEl) ph.remove();
        }
      });

      itemsEl.addEventListener('drop', e => {
        e.preventDefault();
        const id = parseInt(e.dataTransfer.getData('text/plain'));
        const placeholder = document.getElementById('drag-placeholder');
        const items = [...itemsEl.querySelectorAll('.task-nav-item')];
        const afterEl = placeholder ? placeholder.nextElementSibling : null;
        let newIndex = afterEl ? items.indexOf(afterEl) : items.length;
        if (newIndex < 0) newIndex = items.length;
        placeholder && placeholder.remove();
        onDrop(id, itemsEl.dataset.status, newIndex);
      });
    }

    headerEl.addEventListener('click', () => {
      const collapsed = itemsEl.classList.toggle('collapsed');
      toggleEl.classList.toggle('collapsed', collapsed);
      collapsedGroups[collapseKey] = collapsed;
    });
    headerEl.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!writable || group.is_system || !group.id) return;
      ContextMenu.show(event.clientX, event.clientY, [
        { label: 'Rename group', action: () => showRenameGroup(group) },
        { label: 'Delete group', danger: true, action: () => removeGroup(group) },
      ]);
    });

    groupEl.append(headerEl, itemsEl);
    return groupEl;
  }

  function getDragAfterElement(container, y) {
    const els = [...container.querySelectorAll('.task-nav-item:not(.dragging)')];
    return els.reduce((closest, el) => {
      const box = el.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, el };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).el;
  }

  async function onDrop(id, targetStatus, newIndex) {
    const task = tasks.find(t => t.id === id);
    if (!task || !can('tasks:write')) return;
    try {
      // update status
      if (task.status !== targetStatus) {
        await API.put(taskUrl(id), { status: targetStatus });
      }
      // recompute sort_order inside the target group (old Engines do not support ordering, only the group changes)
      if (can('tasks:reorder')) {
        const groupTasks = tasks
          .filter(t => t.id !== id && t.status === targetStatus)
          .sort((a, b) => a.sort_order - b.sort_order);
        groupTasks.splice(newIndex, 0, { ...task, status: targetStatus });
        await API.put(`${source.tasksBase}/reorder`, groupTasks.map((t, i) => ({ id: t.id, sort_order: i })));
      }
    } catch (error) {
      alert('Could not move task: ' + error.message);
    }
    await refreshActive();
  }

  function buildNavItem(task, groups, writable) {
    const item = document.createElement('div');
    item.className = `task-nav-item${task.id === selectedId ? ' active' : ''}`;
    item.dataset.id = task.id;
    item.draggable = writable;

    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', task.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
      setTimeout(() => item.classList.add('drag-ghost'), 0);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging', 'drag-ghost');
      document.getElementById('drag-placeholder')?.remove();
    });

    const statusLabel = (groups.find(group => group.key === task.status) || {}).name || STATUS_LABEL[task.status] || task.status;
    const statusBtn = document.createElement('button');
    statusBtn.className = `task-status-btn ${task.status}`;
    if (task.status === 'doing') statusBtn.textContent = '●';
    else if (task.status === 'done') statusBtn.textContent = '✓';
    else if (task.status === 'personal') statusBtn.textContent = '★';
    statusBtn.title = writable ? `Click to change status (current: ${statusLabel})` : `Current: ${statusLabel}`;
    statusBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!writable) return;
      await setStatus(task.id, STATUS_NEXT[task.status] || 'todo');
    });

    const iconEl = document.createElement('span');
    iconEl.className = 'task-nav-icon';
    iconEl.textContent = task.md_path ? '▶' : '';

    const titleEl = document.createElement('span');
    titleEl.className = `task-nav-title${task.status === 'done' ? ' done' : ''}`;
    titleEl.textContent = task.title;
    titleEl.title = task.title;

    item.appendChild(statusBtn);
    item.appendChild(iconEl);
    item.appendChild(titleEl);

    applyTermState(item, TerminalActivity.taskState(task.id, source.key));

    const due = formatDue(task.due_date);
    if (due) {
      const dueEl = document.createElement('span');
      dueEl.className = `task-nav-due${due.overdue ? ' overdue' : ''}`;
      dueEl.textContent = due.text;
      item.appendChild(dueEl);
    }

    item.addEventListener('click', () => selectTask(task.id));
    if (!writable) return item;

    function showTaskMenu(x, y) {
      ContextMenu.show(x, y, [
        ...groups.map(group => ({
          label: `${task.status === group.key ? '✓ ' : ''}Move to “${group.name}”`,
          action: () => setStatus(task.id, group.key),
        })),
        { separator: true },
        { label: 'Edit', action: () => showEditModal(task) },
        { label: 'Delete', danger: true, action: () => deleteTask(task.id) },
      ]);
    }
    item.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      showTaskMenu(event.clientX, event.clientY);
    });
    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'task-menu-button';
    menuButton.textContent = '⋯';
    menuButton.title = 'Task menu';
    menuButton.setAttribute('aria-label', `${task.title} task menu`);
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.addEventListener('click', event => {
      event.stopPropagation();
      const bounds = menuButton.getBoundingClientRect();
      showTaskMenu(bounds.left, bounds.bottom);
    });
    menuButton.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation(); });
    item.appendChild(menuButton);

    return item;
  }

  async function setStatus(id, status) {
    try { await API.put(taskUrl(id), { status }); }
    catch (error) { alert('Could not update task: ' + error.message); }
    await refreshActive();
  }

  // Delete confirmation dialog: "also delete the directory" can be ticked, unticked by default. Returns { deleteDirectory } or null (cancelled).
  function confirmDeleteTask(task) {
    return new Promise(resolve => {
      const hasDir = Boolean(task && task.work_dir);
      Modal.show('Delete task', `
        <p>Delete task “${escapeHtml(task ? task.title : '')}”? The task record and its to-dos will be deleted.</p>
        ${hasDir ? `<label class="delete-dir-option"><input type="checkbox" id="delete-task-dir"> Also delete the directory</label>
        <div class="delete-dir-path" id="delete-task-dir-path" hidden><code>${escapeHtml(task.work_dir)}</code><br>The directory and everything in it will be permanently deleted and cannot be recovered.</div>` : '<div class="form-hint">This task has no working directory, so no directory will be deleted.</div>'}
        <div class="form-actions"><button class="btn-cancel" id="delete-task-cancel" type="button">Cancel</button><button class="btn-submit btn-danger-confirm" id="delete-task-ok" type="button">Delete</button></div>`);
      const box = document.getElementById('delete-task-dir');
      if (box) box.addEventListener('change', () => { document.getElementById('delete-task-dir-path').hidden = !box.checked; });
      let settled = false;
      const finish = value => { if (settled) return; settled = true; Modal.hide(); resolve(value); };
      document.getElementById('delete-task-cancel').addEventListener('click', () => finish(null));
      document.getElementById('delete-task-ok').addEventListener('click', () => finish({ deleteDirectory: Boolean(box && box.checked) }));
    });
  }

  const deleteErrorLabel = code => ({
    DIRECTORY_NOT_SAFE_TO_DELETE: 'This directory cannot be deleted (protected or shared with other tasks); the task was not deleted',
  })[code] || code;

  async function deleteTask(id) {
    if (selectedId === id && window.FilePanel?.isOpen() && !await FilePanel.beforeContextChange()) return;
    const task = tasks.find(item => item.id === id);
    const choice = await confirmDeleteTask(task);
    if (!choice) return;
    let result;
    try { result = await API.delete(`${taskUrl(id)}${choice.deleteDirectory ? '?delete_directory=1' : ''}`); }
    catch (error) {
      let text = error.message;
      try { const data = JSON.parse(text); text = data.reason ? `${deleteErrorLabel(data.error)}: ${data.reason}` : deleteErrorLabel(data.error); } catch { /* keep the original text */ }
      alert('Could not delete task: ' + text);
      return;
    }
    if (choice.deleteDirectory) {
      if (result && result.directory_error) alert(`Task deleted, but deleting the directory failed: ${result.directory_error}`);
      else if (result && result.directory_deleted === undefined) alert('Task deleted, but the remote service is older and did not delete the directory.');
    }
    if (selectedId === id) {
      disposeTerminalsOf(source.key, id);
      selectedId = null;
      source.selectedId = null;
      showEmpty();
    }
    await refreshActive();
  }

  // ── Task groups (same for local and remote) ──
  function groupNameDialog(title, initial, onSubmit) {
    Modal.show(title, `
      <div class="form-group"><label class="form-label">Group name</label><input class="form-input" id="group-name" maxlength="40" value="${escapeHtml(initial)}" autocomplete="off"></div>
      <div class="form-hint error" id="group-name-error"></div>
      <div class="form-actions"><button class="btn-cancel" id="group-name-cancel">Cancel</button><button class="btn-submit" id="group-name-save">Save</button></div>`);
    document.getElementById('group-name-cancel').addEventListener('click', Modal.hide);
    const input = document.getElementById('group-name');
    input.focus();
    document.getElementById('group-name-save').addEventListener('click', async event => {
      event.target.disabled = true;
      try { await onSubmit(input.value.trim()); Modal.hide(); await refreshActive(); }
      catch (error) {
        document.getElementById('group-name-error').textContent = groupErrorLabel(error.message);
        event.target.disabled = false;
      }
    });
  }

  function groupErrorLabel(code) {
    return ({
      GROUP_NAME_REQUIRED: 'Enter a group name', GROUP_NAME_TOO_LONG: 'Group name cannot exceed 40 characters',
      GROUP_NAME_ALREADY_EXISTS: 'A group with this name already exists', TASK_GROUP_NOT_FOUND: 'Task group does not exist',
      SYSTEM_GROUP_IMMUTABLE: 'The default group cannot be modified or deleted', TASK_GROUP_NOT_EMPTY: 'The group still has tasks and cannot be deleted',
    })[code] || code;
  }

  function showCreateGroup() {
    groupNameDialog('New task group', '', name => API.post(source.groupsBase, { name }));
  }

  function showRenameGroup(group) {
    groupNameDialog('Rename group', group.name, name => API.put(`${source.groupsBase}/${group.id}`, { name }));
  }

  async function removeGroup(group) {
    if (!confirm(`Delete group “${group.name}”? The group must contain no tasks.`)) return;
    try { await API.delete(`${source.groupsBase}/${group.id}`); await refreshActive(); }
    catch (error) { alert('Could not delete group: ' + groupErrorLabel(error.message)); }
  }

  // ── Data sources: load, switch, sync ──
  function errorCode(error) {
    const message = String((error && error.message) || '');
    try { const parsed = JSON.parse(message); if (parsed && typeof parsed.error === 'string') return parsed.error; } catch {}
    return /^[A-Z0-9_]+$/.test(message) ? message : 'REMOTE_CONNECTION_FAILED';
  }

  // Re-read the tasks and groups of one data source; for a remote one a failure only records the connection problem and does not throw.
  async function reloadSource(key) {
    const src = sources.get(key);
    if (!src) return;
    let list;
    try {
      list = await API.get(src.tasksBase);
      if (!Array.isArray(list)) throw new Error('INVALID_TASKS_RESPONSE');
    } catch (error) {
      if (src.local) throw error;
      src.loadError = errorCode(error);
      src.tasks = [];
      src.groups = fallbackGroups();
      src.loaded = true;
      if (src === source) tasks = src.tasks;
      return;
    }
    src.loadError = null;
    src.tasks = list;
    // Update the tasks of the current view synchronously: if the data source is switched while we wait for the groups request below, activateSource writes tasks back to the old source,
    // and without this sync the task list we just fetched would be overwritten with the old empty array (after a refresh, local tasks vanish when switching back).
    if (src === source) tasks = list;
    // When an old Engine has no groups endpoint, derive them from the task statuses.
    let groups = null;
    try { groups = await API.get(src.groupsBase); } catch {}
    src.groups = groupsFor(src, groups);
    src.loaded = true;
    if (src === source) tasks = src.tasks;
  }

  function showSourceLoading() {
    const empty = document.getElementById('preview-empty');
    empty.style.display = 'flex';
    empty.querySelector('span').textContent = `Loading ${source.label}…`;
    document.getElementById('preview-content').style.display = 'none';
    contentToolbar.style.display = 'none';
    contentTabs.style.display = 'none';
    terminalPane.style.display = 'none';
    previewPane.style.display = '';
  }

  // Clear the content area (used when switching to an unavailable Engine or removing a connection).
  function clearView() {
    selectedId = null;
    source.selectedId = null;
    TerminalHistory.activate(null);
    hideToc();
    stopWatcher();
    document.getElementById('preview-empty').style.display = 'none';
    document.getElementById('preview-content').style.display = 'none';
    contentToolbar.style.display = 'none';
    contentTabs.style.display = 'none';
    terminalPane.style.display = 'none';
    previewPane.style.display = '';
    document.querySelectorAll('.task-nav-item').forEach(el => el.classList.remove('active'));
  }

  function syncSourceControls() {
    // Finder / VS Code depend on the local file system and are not shown for remote tasks.
    for (const id of ['btn-reveal-folder', 'btn-open-vscode']) {
      const button = document.getElementById(id);
      if (button) button.style.display = source.local ? '' : 'none';
    }
  }

  function activateSource(key, options = {}) {
    const next = sources.get(key) || sources.get('local');
    if (next !== source && !options.confirmed) {
      if (window.FilePanel?.isOpen()) {
        // once the panel has been confirmed, continue switching without checking again
        return FilePanel.beforeContextChange().then(allowed => allowed && activateSource(key, { ...options, confirmed: true }));
      }
      if (!confirmDiscardEditor()) return;
    }
    source.tasks = tasks;
    source.selectedId = selectedId;
    source = next;
    tasks = source.tasks;
    selectedId = source.selectedId;
    localStorage.setItem('active-engine-key', source.key);
    hideToc();          // also invalidates unfinished rendering from the previous data source
    stopWatcher();
    TerminalActivity.setActive(source.key);
    syncSourceControls();
    renderSidebar();
    notifySourceChange();

    if (problemOf(source)) {
      clearView();
      if (window.Engines) Engines.showUnavailable(source);
      return;
    }
    if (window.Engines) Engines.hideUnavailable();
    if (!source.loaded) { showSourceLoading(); return; }
    if (window.FilePanel?.isOpen()) return;

    const cached = parseInt(localStorage.getItem(selectedStorageKey()));
    const task = tasks.find(t => t.id === selectedId) || tasks.find(t => t.id === cached) || tasks[0];
    if (task) return selectTask(task.id);
    selectedId = null;
    showEmpty();
  }

  // After startup or an Engine list refresh, return to the data source the user used last.
  let enginesSynced = false;
  function restoreActiveSource() {
    const wanted = activeKeyPreference();
    if (wanted === 'local') {
      if (sources.get('local').loaded) activateSource('local');
    } else if (sources.has(wanted)) {
      activateSource(wanted);
    } else if (enginesSynced) {
      activateSource('local');  // the saved Engine has been removed
    }
  }

  // Re-read the current data source and refresh the UI.
  async function refreshActive() {
    const current = source;
    await reloadSource(current.key);
    if (current !== source) return;
    tasks = current.tasks;
    renderSidebar();
    if (window.FilePanel?.isOpen()) return;
    if (problemOf(current)) {
      clearView();
      if (window.Engines) Engines.showUnavailable(current);
      return;
    }
    if (window.Engines) Engines.hideUnavailable();
    if (selectedId) {
      const task = tasks.find(t => t.id === selectedId);
      if (task) renderPreview(task);
      else { selectedId = null; current.selectedId = null; localStorage.removeItem(selectedStorageKey(current)); showEmpty(); }
    }
  }

  // The Engines module syncs the remote connection list: add, update or remove data sources while keeping existing task caches.
  function syncSources(servers) {
    const seen = new Set();
    for (const server of servers) {
      const key = `remote:${server.id}`;
      seen.add(key);
      const existing = sources.get(key);
      const desc = {
        key, id: server.id, label: server.name, server,
        tasksBase: `/api/remote-servers/${server.id}/tasks`,
        groupsBase: `/api/remote-servers/${server.id}/task-groups`,
        wsPath: `/api/remote-servers/${server.id}/terminal/ws`,
      };
      if (existing) Object.assign(existing, desc);
      else sources.set(key, makeSource({ ...desc, caps: new Set() }));
    }
    for (const key of [...sources.keys()]) {
      if (key !== 'local' && !seen.has(key)) removeSource(key);
    }
    enginesSynced = true;
    notifySourceChange();
  }

  // Declare an Engine's role and capabilities; a read-only role loses every write capability.
  function setSourceAccess(key, info) {
    const src = sources.get(key);
    if (!src || src.local) return;
    const capabilities = Array.isArray(info && info.capabilities) ? info.capabilities : [];
    const readOnly = info && info.role === 'readonly';
    src.role = (info && info.role) || null;
    src.caps = new Set(capabilities.filter(capability => !(readOnly && /:(write|create|reorder)$/.test(capability))));
    if (capabilities.includes('terminal:activity')) {
      TerminalActivity.registerSource(key, { activityUrl: `/api/remote-servers/${src.id}/terminal-activity`, tasksBase: src.tasksBase });
    } else {
      TerminalActivity.unregisterSource(key);
    }
    if (src === source) { renderSidebar(); syncSourceControls(); }
    notifySourceChange(); // the tools panel decides from role and capabilities whether PM2 is available
  }

  function removeSource(key) {
    const src = sources.get(key);
    if (!src || src.local) return;
    disposeTerminalsOf(key);
    TerminalActivity.unregisterSource(key);
    sources.delete(key);
    if (src === source) {
      source.tasks = tasks;
      source = sources.get('local');
      tasks = source.tasks;
      selectedId = source.selectedId;
    }
  }

  function disposeTerminalsOf(sourceKey, taskId) {
    for (const inst of [...termInstances.values()]) {
      if (inst.sourceKey === sourceKey && (taskId === undefined || inst.taskId === taskId)) {
        disposeTerminalInstance(inst.taskId, inst.terminalId, sourceKey);
      }
    }
  }

  function selectTask(id) {
    if (window.FilePanel?.isOpen()) {
      if (selectedId === id) return;
      return FilePanel.beforeContextChange().then(allowed => allowed && selectTask(id));
    }
    if (selectedId !== id && !confirmDiscardEditor()) return;
    selectedId = id;
    source.selectedId = id;
    localStorage.setItem(selectedStorageKey(), id);
    // The tab bar (design doc / README / AGENTS.md / to-do / terminal) must follow the selected task;
    // if the last tab was "terminal" no document is rendered, so we cannot count on renderPreview to show it.
    contentTabs.style.display = 'flex';
    document.querySelectorAll('.task-nav-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.id) === id);
    });
    // restore the tab this task last stayed on
    const tab = getTaskTab(id);
    activeTab = tab;
    contentTabs.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
      b.disabled = false;
      b.title = '';
    });
    if (tab === 'shell') {
      const task = tasks.find(t => t.id === id);
      contentToolbar.style.visibility = 'visible';
      contentToolbar.style.pointerEvents = '';
      contentToolbar.style.display = task ? 'flex' : 'none';
      document.getElementById('btn-share-md').style.display = source.local && task && task.md_path ? '' : 'none';
      setEditButtonState(false);
      previewPane.style.display = 'none';
      hideToc();
      stopWatcher();
      terminalPane.style.display = 'flex';
      // clear the "finished, awaiting review" state when switching to the terminal
      acknowledgeCurrentTerminal();
    } else {
      previewPane.style.display = '';
      TerminalHistory.activate(null);
      terminalPane.style.display = 'none';
    }
    const task = tasks.find(t => t.id === id);
    if (task) {
      if (tab === 'shell') {
        connectTerminal(task);
        const inst = termInstances.get(terminalKey(task.id));
        if (inst) setTimeout(() => { if (!inst.disposed && term === inst.term && selectedId === task.id && activeTab === 'shell') inst.term.focus(); }, 0);
      } else {
        renderPreview(task);
      }
    }
  }

  async function renderPreview(task) {
    const empty = document.getElementById('preview-empty');
    const content = document.getElementById('preview-content');

    empty.style.display = 'none';
    content.style.display = 'block';
    hideToc();
    stopWatcher();

    contentTabs.style.display = 'flex';

    if (activeTab === 'todos') {
      // The to-do page keeps the full toolbar so the content area does not jump up and down when switching tabs.
      contentToolbar.style.display = 'flex';
      contentToolbar.style.visibility = 'visible';
      contentToolbar.style.pointerEvents = '';
      document.getElementById('btn-share-md').style.display = source.local && task.md_path ? '' : 'none';
      setEditButtonState(false);
      await renderTodos(task);
      return;
    }

    contentToolbar.style.visibility = 'visible';
    contentToolbar.style.pointerEvents = '';
    const isTechnical = activeTab === 'doc';
    const hasDocumentRoot = isTechnical ? Boolean(task.md_path) : Boolean(task.work_dir || task.md_path);
    contentToolbar.style.display = hasDocumentRoot ? 'flex' : 'none';
    document.getElementById('btn-share-md').style.display = source.local && isTechnical && task.md_path ? '' : 'none';
    setEditButtonState(hasDocumentRoot);

    if (isTechnical && !task.md_path) {
      const due = formatDue(task.due_date);
      content.innerHTML = `
        <div class="task-info-card">
          <div class="task-info-title">${escapeHtml(task.title)}</div>
          <div class="task-info-row"><span class="task-info-label">Status</span><span class="badge ${task.status}">${STATUS_LABEL[task.status]}</span></div>
          <div class="task-info-row"><span class="task-info-label">Priority</span><span class="badge ${task.priority}">${PRIORITY_LABEL[task.priority]}</span></div>
          ${task.due_date ? `<div class="task-info-row"><span class="task-info-label">Due</span><span class="${due && due.overdue ? 'badge high' : ''}">${task.due_date}</span></div>` : ''}
          ${task.work_dir ? `<div class="task-info-row"><span class="task-info-label">Working directory</span><span class="task-info-path">${escapeHtml(task.work_dir)}</span></div>` : ''}
        </div>`;
      return;
    }

    if (!hasDocumentRoot) {
      content.innerHTML = '<div class="document-empty">This task has no working directory yet</div>';
      return;
    }

    const tab = activeTab;
    await loadMdContent(task, tab);
    startWatcher(task, tab);
  }

  function setEditButtonState(enabled) {
    const button = document.getElementById('btn-edit-md');
    const writable = can('documents:write');
    button.disabled = !enabled || !writable;
    button.title = !writable ? 'This connection is read-only and cannot edit'
      : enabled ? 'Edit the current Markdown in the page' : 'The current page is not editable Markdown';
  }

  function confirmDiscardEditor() {
    if (!editorState) return true;
    if (editorState.dirty && !confirm('This document has unsaved changes. Discard them?')) return false;
    disposeDocumentEditor(editorState);
    editorState = null;
    document.getElementById('preview-content').classList.remove('editor-active');
    return true;
  }

  function disposeDocumentEditor(state) {
    if (!state) return;
    if (state.editor) state.editor.dispose();
    if (state.model) state.model.dispose();
  }

  async function openDocumentEditor(task, tab) {
    if (editorState || typeof monaco === 'undefined') {
      if (typeof monaco === 'undefined') alert('Editor resources failed to load. Please refresh the page');
      return;
    }
    stopWatcher();
    hideToc();
    const content = document.getElementById('preview-content');
    const editButton = document.getElementById('btn-edit-md');
    editButton.disabled = true;
    content.innerHTML = '<div class="preview-loading">Opening editor…</div>';
    try {
      const kind = documentKind(tab);
      const sourceKey = source.key;
      const res = await fetch(taskUrl(task.id, `/document/${kind}`), {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) throw new Error('Could not read the document');
      const text = await res.text();
      if (selectedId !== task.id || activeTab !== tab || source.key !== sourceKey) return;
      content.classList.add('editor-active');
      content.innerHTML = `
        <div class="md-editor-shell">
          <div class="md-editor-header">
            <span class="md-editor-file">${escapeHtml(documentLabel(tab))}</span>
            <span class="md-editor-status" id="md-editor-status">Unmodified</span>
            <span class="md-editor-shortcuts">VS Code shortcuts · Alt/Option+click for multiple cursors · Shift+Alt/Option+drag for column select</span>
            <button type="button" class="md-editor-action secondary" id="md-editor-cancel">Cancel</button>
            <button type="button" class="md-editor-action primary" id="md-editor-save">Save</button>
          </div>
          <div class="md-editor-host" id="md-editor-host"></div>
        </div>`;
      let model, editor;
      const modelUri = monaco.Uri.parse(`inmemory://task/${encodeURIComponent(source.key)}/${task.id}/${kind}.md`);
      const existingModel = monaco.editor.getModel(modelUri);
      if (existingModel) existingModel.dispose();
      model = monaco.editor.createModel(text, 'markdown', modelUri);
      editor = monaco.editor.create(document.getElementById('md-editor-host'), {
        model,
        theme: typeof Theme === 'undefined' ? 'vs' : Theme.monacoTheme(),
        lineNumbers: true,
        wordWrap: 'on',
        automaticLayout: true,
        fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 22,
        tabSize: 2,
        insertSpaces: true,
        autoClosingBrackets: 'always',
        autoClosingQuotes: 'always',
        multiCursorModifier: 'alt',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        find: {
          addExtraSpaceOnTop: false,
          autoFindInSelection: 'multiline',
          seedSearchStringFromSelection: 'selection',
        },
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveDocumentEditor);
      editorState = { task, tab, kind, editor, model, source: text, sourceKey, dirty: false, saving: false };
      editor.onDidChangeModelContent(() => {
        if (!editorState) return;
        editorState.dirty = model.getValue() !== text;
        document.getElementById('md-editor-status').textContent = editorState.dirty ? 'Unsaved' : 'Unmodified';
      });
      document.getElementById('md-editor-save').addEventListener('click', saveDocumentEditor);
      document.getElementById('md-editor-cancel').addEventListener('click', cancelDocumentEditor);
      requestAnimationFrame(() => editor.focus());
    } catch (e) {
      content.classList.remove('editor-active');
      editorState = null;
      editButton.disabled = false;
      alert('Could not open the editor: ' + e.message);
      await loadMdContent(task, tab);
      startWatcher(task, tab);
    }
  }

  async function saveDocumentEditor() {
    const state = editorState;
    if (!state || state.saving) return;
    state.saving = true;
    const saveButton = document.getElementById('md-editor-save');
    const status = document.getElementById('md-editor-status');
    saveButton.disabled = true;
    status.textContent = 'Saving…';
    try {
      await API.put(`${sources.get(state.sourceKey).tasksBase}/${state.task.id}/document/${state.kind}`, { content: state.model.getValue() });
      disposeDocumentEditor(state);
      editorState = null;
      document.getElementById('preview-content').classList.remove('editor-active');
      setEditButtonState(true);
      await loadMdContent(state.task, state.tab);
      startWatcher(state.task, state.tab);
    } catch (e) {
      state.saving = false;
      saveButton.disabled = false;
      status.textContent = 'Save failed';
      alert('Could not save the document: ' + e.message);
    }
  }

  async function cancelDocumentEditor() {
    const state = editorState;
    if (!state) return;
    if (state.dirty && !confirm('Discard unsaved changes?')) return;
    disposeDocumentEditor(state);
    editorState = null;
    document.getElementById('preview-content').classList.remove('editor-active');
    setEditButtonState(true);
    await loadMdContent(state.task, state.tab);
    startWatcher(state.task, state.tab);
  }

  async function renderTodos(task) {
    const content = document.getElementById('preview-content');
    const renderForId = task.id;
    content.innerHTML = '<div class="preview-loading">Loading to-dos…</div>';
    try {
      const todos = await API.get(taskUrl(task.id, '/todos'));
      if (selectedId !== renderForId || activeTab !== 'todos') return;
      const writable = can('todos:write');
      const completedCount = todos.filter(todo => todo.completed).length;
      content.innerHTML = `
        <section class="todo-page${writable ? '' : ' remote-readonly'}">
          <div class="todo-heading">
            <div>
              <h2>To-do list</h2>
              <p>${writable ? (todos.length ? `${completedCount} / ${todos.length} done` : 'Write down what to do next for this task') : 'This connection is read-only'}</p>
            </div>
          </div>
          ${writable ? `<form class="todo-add-form" id="todo-add-form">
            <input id="todo-new-content" type="text" maxlength="500" autocomplete="off" placeholder="Add a to-do and press Enter to save">
            <button type="submit">Add</button>
          </form>` : ''}
          <div class="todo-list" id="todo-list">
            ${todos.length ? todos.map(todo => `
              <div class="todo-item${todo.completed ? ' completed' : ''}" data-todo-id="${todo.id}">
                <label class="todo-check-wrap" title="${todo.completed ? 'Mark as not done' : 'Mark as done'}">
                  <input class="todo-check" type="checkbox" ${todo.completed ? 'checked' : ''} ${writable ? '' : 'disabled'}>
                  <span class="todo-checkmark"></span>
                </label>
                <span class="todo-content" ${writable ? 'title="Double-click to edit"' : ''}>${escapeHtml(todo.content)}</span>
                ${writable ? '<button class="todo-delete" type="button" title="Delete to-do">×</button>' : ''}
              </div>`).join('') : '<div class="todo-empty">No to-dos yet</div>'}
          </div>
        </section>`;

      if (!writable) return;
      const form = document.getElementById('todo-add-form');
      const input = document.getElementById('todo-new-content');
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        input.disabled = true;
        try {
          await API.post(taskUrl(task.id, '/todos'), { content: value });
          await renderTodos(task);
        } catch (e) {
          input.disabled = false;
          alert('Could not add to-do: ' + e.message);
        }
      });

      document.querySelectorAll('#todo-list .todo-item').forEach(item => {
        const todoId = item.dataset.todoId;
        const checkbox = item.querySelector('.todo-check');
        const label = item.querySelector('.todo-content');
        checkbox.addEventListener('change', async () => {
          try {
            await API.put(taskUrl(task.id, `/todos/${todoId}`), { completed: checkbox.checked });
            await renderTodos(task);
          } catch (e) {
            checkbox.checked = !checkbox.checked;
            alert('Could not update to-do: ' + e.message);
          }
        });
        label.addEventListener('dblclick', () => editTodoInline(task, todoId, label));
        item.querySelector('.todo-delete').addEventListener('click', async () => {
          try {
            await API.delete(taskUrl(task.id, `/todos/${todoId}`));
            await renderTodos(task);
          } catch (e) {
            alert('Could not delete to-do: ' + e.message);
          }
        });
      });
      input.focus();
    } catch (e) {
      if (selectedId === renderForId && activeTab === 'todos') {
        content.innerHTML = '<div class="preview-loading">Failed to load to-dos</div>';
      }
    }
  }

  function editTodoInline(task, todoId, label) {
    const original = label.textContent;
    const input = document.createElement('input');
    input.className = 'todo-edit-input';
    input.value = original;
    label.replaceWith(input);
    input.focus();
    input.select();
    let saved = false;
    const save = async () => {
      if (saved) return;
      saved = true;
      const content = input.value.trim();
      if (!content || content === original) {
        await renderTodos(task);
        return;
      }
      try {
        await API.put(taskUrl(task.id, `/todos/${todoId}`), { content });
      } catch (e) {
        alert('Could not update to-do: ' + e.message);
      }
      await renderTodos(task);
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') {
        saved = true;
        renderTodos(task);
      }
    });
  }

  function documentKind(tab) {
    return tab === 'readme' ? 'readme' : tab === 'agent' ? 'agent' : 'technical';
  }

  function documentLabel(tab) {
    return tab === 'readme' ? 'README.md' : tab === 'agent' ? 'AGENTS.md' : 'Design doc';
  }

  function isCurrentPreview(task, tab) {
    return selectedId === task.id && activeTab === tab && ['doc', 'readme', 'agent'].includes(tab)
      && !editorState && previewPane.style.display !== 'none';
  }

  async function loadMdContent(task, tab = activeTab) {
    const content = document.getElementById('preview-content');
    const savedScroll = parseInt(localStorage.getItem(`mdScroll_${storageId(task.id)}_${tab}`)) || 0;
    const scrollTop = previewPane.scrollTop || savedScroll;
    // Record the target task at render time and verify after the async return that it is still the current task/tab, preventing racy UI updates
    const revision = ++mdRenderRevision;
    const isCurrent = () => revision === mdRenderRevision && isCurrentPreview(task, tab);

    try {
      const kind = documentKind(tab);
      const res = await fetch(taskUrl(task.id, `/document/${kind}`), {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!isCurrent()) return;
      if (res.status === 404) {
        setEditButtonState(false);
        const canCreate = (tab === 'readme' || tab === 'agent') && can('documents:create');
        content.innerHTML = `
          <div class="document-empty">
            <p>${escapeHtml(documentLabel(tab))} does not exist</p>
            ${canCreate ? `<button class="document-create-btn" id="document-create-btn">Create ${escapeHtml(documentLabel(tab))}</button>` : ''}
          </div>`;
        if (canCreate) {
          document.getElementById('document-create-btn').addEventListener('click', async () => {
            try {
              await API.post(taskUrl(task.id, `/document/${documentKind(tab)}`), {});
              setEditButtonState(true);
              await loadMdContent(task, tab);
              startWatcher(task, tab);
            } catch (e) {
              alert('Could not create the document: ' + e.message);
            }
          });
        }
        return;
      }
      if (!res.ok) throw new Error('Failed');
      const text = await res.text();
      if (!isCurrent()) return;
      content.innerHTML = (can('documents:write') ? '' : `<div class="remote-readonly-banner">${escapeHtml(source.label)} · read-only connection</div>`) + renderMd(text, task.id);
      MarkdownView.enhance(content);
      for (const script of Array.from(content.querySelectorAll('script'))) {
        if (!isCurrent()) return;
        if (script.src) {
          await new Promise(resolve => {
            const s = document.createElement('script');
            s.src = script.src;
            s.onload = resolve;
            s.onerror = resolve;
            document.head.appendChild(s);
          });
        } else {
          try { new Function(script.textContent)(); } catch (e) { /* inline script parse error, ignored */ }
        }
      }
      // render mermaid diagrams one by one; one failure does not affect the rest
      for (const node of content.querySelectorAll('.mermaid')) {
        if (!isCurrent()) return;
        try {
          await ensureMermaid();
          node.dataset.mermaidSource = node.textContent; // used to render again when the theme changes
          await mermaid.run({ nodes: [node] });
        } catch (e) {
          if (!isCurrent()) return;
          node.innerHTML = `<pre style="color:#c0392b;font-size:12px;white-space:pre-wrap">⚠️ Mermaid rendering failed: ${e.message || e.str || 'Syntax error'}</pre>`;
        }
      }
      if (!isCurrent()) return;
      wrapMermaidDiagrams(content);
      addHeadingIds(content);
      buildToc(content);
      setupScrollSpy(content);
      previewPane.scrollTop = scrollTop;
    } catch (e) {
      if (!isCurrent()) return;
      console.error('[loadMdContent] error:', e);
      content.innerHTML = '<div class="preview-loading">Failed to load. Check that the file path is valid</div>';
    }
  }

  function startWatcher(task, tab = activeTab) {
    if (!isCurrentPreview(task, tab) || !can('documents:watch')) return;
    stopWatcher();
    const watchedTab = tab;
    mdWatcher = new EventSource(taskUrl(task.id, `/document/${documentKind(tab)}/watch`));
    mdWatcher.onmessage = (e) => {
      if (e.data === 'changed' && isCurrentPreview(task, watchedTab)) loadMdContent(task, watchedTab);
    };
    mdWatcher.onerror = () => stopWatcher();
  }

  function stopWatcher() {
    if (mdWatcher) {
      mdWatcher.close();
      mdWatcher = null;
    }
  }

  function rewriteRelativeLinks(container, taskId) {
    const isRelative = href => href && !href.startsWith('http') && !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('mailto:');
    container.querySelectorAll('a[href]').forEach(a => {
      if (isRelative(a.getAttribute('href'))) {
        a.href = `${taskUrl(taskId, '/file')}?path=${encodeURIComponent(a.getAttribute('href'))}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });
    container.querySelectorAll('img[src]').forEach(img => {
      if (isRelative(img.getAttribute('src'))) {
        img.src = `${taskUrl(taskId, '/file')}?path=${encodeURIComponent(img.getAttribute('src'))}`;
      }
    });
  }

  function addHeadingIds(container) {    const headings = container.querySelectorAll('h1,h2,h3,h4');
    const counts = {};
    headings.forEach(h => {
      const base = h.textContent.trim().replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fa5-]/g, '');
      counts[base] = (counts[base] || 0) + 1;
      h.id = counts[base] > 1 ? `${base}-${counts[base]}` : base;
    });
  }

  function buildToc(container) {
    const headings = container.querySelectorAll('h1,h2,h3,h4');
    if (headings.length === 0) { hideToc(); return; }

    const tocList = document.getElementById('toc-list');
    tocList.innerHTML = '';

    // load the persisted collapsed state
    const storageKey = `toc-collapsed-${storageId(selectedId)}`;
    let collapsed = new Set();
    try { collapsed = new Set(JSON.parse(localStorage.getItem(storageKey)) || []); } catch(e) {}

    function saveCollapsed() {
      localStorage.setItem(storageKey, JSON.stringify([...collapsed]));
    }

    // Build the tree: every node records the indexes of its descendant items
    const items = Array.from(headings).map((h, i) => ({
      h,
      level: parseInt(h.tagName[1]),
      index: i,
      children: [],  // direct and indirect descendant item indexes (all levels)
    }));

    // Compute each node's "all descendants" range (the following run of larger levels)
    function getDescendants(idx) {
      const level = items[idx].level;
      const result = [];
      for (let i = idx + 1; i < items.length; i++) {
        if (items[i].level <= level) break;
        result.push(i);
      }
      return result;
    }

    // Decide whether a node has children (the next level is larger)
    function hasChildren(idx) {
      return idx + 1 < items.length && items[idx + 1].level > items[idx].level;
    }

    // Render all items and bind the collapse logic
    const domItems = items.map(({ h, level, index }) => {
      const item = document.createElement('div');
      item.className = 'toc-item';
      item.dataset.level = level;
      item.dataset.target = h.id;
      item.dataset.index = index;

      if (hasChildren(index)) {
        const arrow = document.createElement('span');
        arrow.className = 'toc-arrow';
        arrow.textContent = collapsed.has(index) ? '▶' : '▼';
        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          const isCollapsed = collapsed.has(index);
          if (isCollapsed) {
            collapsed.delete(index);
            arrow.textContent = '▼';
          } else {
            collapsed.add(index);
            arrow.textContent = '▶';
          }
          saveCollapsed();
          updateVisibility();
        });
        item.appendChild(arrow);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'toc-arrow toc-arrow-spacer';
        item.appendChild(spacer);
      }

      const label = document.createElement('span');
      label.className = 'toc-label';
      label.textContent = h.textContent.trim();
      label.title = h.textContent.trim();
      label.addEventListener('click', () => {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      item.appendChild(label);

      tocList.appendChild(item);
      return item;
    });

    function updateVisibility() {
      // for each item, check whether any of its ancestors is collapsed
      items.forEach((node, i) => {
        let hidden = false;
        for (let a = 0; a < i; a++) {
          if (items[a].level < node.level && collapsed.has(a)) {
            const descs = getDescendants(a);
            if (descs.includes(i)) { hidden = true; break; }
          }
        }
        domItems[i].style.display = hidden ? 'none' : 'flex';
      });
    }

    updateVisibility();

    document.getElementById('toc-pane').style.display = 'flex';
    document.getElementById('toc-pane').style.flexDirection = 'column';
  }

  function hideToc() {
    mdRenderRevision++;
    document.getElementById('toc-pane').style.display = 'none';
    document.getElementById('toc-list').innerHTML = '';
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
  }

  function setupScrollSpy(container) {
    if (tocObserver) tocObserver.disconnect();

    const headings = Array.from(container.querySelectorAll('h1,h2,h3,h4'));
    if (headings.length === 0) return;

    const previewPane = document.getElementById('preview-pane');
    const tocItems = document.querySelectorAll('.toc-item');

    function setActive(id) {
      tocItems.forEach(item => {
        item.classList.toggle('active', item.dataset.target === id);
      });
    }

    tocObserver = new IntersectionObserver((entries) => {
      const visible = entries.filter(e => e.isIntersecting);
      if (visible.length > 0) {
        const top = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b
        );
        setActive(top.target.id);
      }
    }, {
      root: previewPane,
      rootMargin: '0px 0px -70% 0px',
      threshold: 0,
    });

    headings.forEach(h => tocObserver.observe(h));
    if (headings[0]) setActive(headings[0].id);
  }

  function showEmpty() {
    const empty = document.getElementById('preview-empty');
    empty.style.display = 'flex';
    empty.querySelector('span').textContent = source.local || tasks.length ? '← Pick a task on the left to see details' : `${source.label} has no tasks`;
    document.getElementById('preview-content').style.display = 'none';
    contentToolbar.style.display = 'none';
    contentTabs.style.display = 'none';
    TerminalHistory.activate(null);
    terminalPane.style.display = 'none';
    previewPane.style.display = '';
    hideToc();
    stopWatcher();
  }

  // Targets selectable for a new task: the local Engine and remote Engines that are reachable and writable.
  function targetLabel(src) {
    if (src.local) return 'Local engine';
    return `${src.label}${problemOf(src) ? '(offline)' : ''}`;
  }

  function targetUsable(src) {
    return !problemOf(src) && (src.caps === null || src.caps.has('tasks:write'));
  }

  function buildTaskForm(task = {}) {
    const creating = !task.id;
    const preferred = sources.get(source.key);
    const initialTarget = creating ? (targetUsable(preferred) ? preferred : sources.get('local')) : source;
    const initialRemote = !initialTarget.local;
    const initialGroups = initialTarget.groups;
    const selectedGroup = task.status || 'todo';
    const enginePicker = creating ? `
      <div class="form-group">
        <label class="form-label">Engine</label>
        <select class="form-input" id="f-engine">
          ${[...sources.values()].map(src => `<option value="${escapeHtml(src.key)}" ${src === initialTarget ? 'selected' : ''} ${targetUsable(src) ? '' : 'disabled'}>${escapeHtml(targetLabel(src))}</option>`).join('')}
        </select>
        <div class="form-hint" id="f-engine-hint">The task and working directory are stored on the selected engine</div>
      </div>` : '';
    return `
      ${enginePicker}
      <div class="form-group">
        <label class="form-label">Title</label>
        <input class="form-input" id="f-title" type="text" value="${escapeHtml(task.title || '')}" placeholder="Task title (can be filled from the MD file name)">
      </div>
      <details class="form-advanced" id="f-advanced" ${creating ? '' : 'open'}>
        <summary class="form-advanced-toggle">Advanced settings</summary>
      ${[['technical_path', 'Design doc', 'DESIGN.md'], ['readme_path', 'README.md', 'README.md'], ['agent_path', 'AGENTS.md', 'AGENTS.md']].map(([field, label, name]) => {
        const override = task[field] || (field === 'technical_path' && task.md_path && !task.md_path.endsWith('/DESIGN.md') ? task.md_path : '');
        const root = task.work_dir || (task.md_path ? task.md_path.slice(0, task.md_path.lastIndexOf('/')) || '/' : '');
        const value = override || (task.id && root ? `${root.replace(/\/$/, '')}/${name}` : '');
        const id = field === 'technical_path' ? 'f-md-path' : `f-${field}`;
        return `<div class="form-group"><label class="form-label">${label} path</label><input class="form-input" id="${id}" type="text" value="${escapeHtml(value)}" data-path-override="${escapeHtml(override)}" data-initial-value="${escapeHtml(value)}" placeholder="Leave empty to use ${name} in the working directory">${field === 'technical_path' ? '<div class="form-hint" id="f-md-hint"></div>' : ''}</div>`;
      }).join('')}
      <div class="form-hint">All three paths accept an absolute Markdown file path; existing files are used as-is and missing ones are created. Clear a field to go back to the default file in the working directory.</div>
      <div class="form-group">
        <label class="form-label" id="f-work-dir-label">${initialRemote ? 'Remote working directory' : 'Working directory'}</label>
        <input class="form-input" id="f-work-dir" type="text" value="${escapeHtml(task.work_dir || '')}" placeholder="${initialRemote ? '/home/user/projects/example' : 'Defaults to the MD file directory'}" autocomplete="off">
        <div class="form-hint" id="f-work-dir-hint">${initialRemote ? 'Absolute path on the remote engine; created if missing. The design doc defaults to DESIGN.md in this directory' : 'Docs and the terminal use this directory; existing DESIGN.md, README.md and AGENTS.md are used first and created if missing'}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Priority</label>
        <div class="form-radio-group">
          <label><input type="radio" name="priority" value="low" ${task.priority === 'low' ? 'checked' : ''}> Low</label>
          <label><input type="radio" name="priority" value="normal" ${(!task.priority || task.priority === 'normal') ? 'checked' : ''}> Medium</label>
          <label><input type="radio" name="priority" value="high" ${task.priority === 'high' ? 'checked' : ''}> High</label>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Group</label>
        <select class="form-input" id="f-task-group">
          ${initialGroups.map(group => `<option value="${escapeHtml(group.key)}" ${group.key === selectedGroup ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Due date</label>
        <input class="form-input" id="f-due-date" type="date" value="${task.due_date || ''}">
      </div>
      </details>
      <div class="form-actions">
        <button class="btn-cancel" id="f-cancel">Cancel</button>
        <button class="btn-submit" id="f-submit">${task.id ? 'Save' : 'Create'}</button>
      </div>`;
  }

  function setupFormEvents(existingTask = {}) {
    document.getElementById('f-cancel').addEventListener('click', Modal.hide);

    const mdInput = document.getElementById('f-md-path');
    const mdHint = document.getElementById('f-md-hint');
    const titleInput = document.getElementById('f-title');
    const workDirInput = document.getElementById('f-work-dir');
    const workDirLabel = document.getElementById('f-work-dir-label');
    const workDirHint = document.getElementById('f-work-dir-hint');
    const engineInput = document.getElementById('f-engine');
    const engineHint = document.getElementById('f-engine-hint');
    const groupInput = document.getElementById('f-task-group');

    // When creating, the target comes from "Engine"; when editing it is the current data source.
    const target = () => (engineInput ? sources.get(engineInput.value) : source) || source;

    function updateGroupOptions() {
      if (!groupInput || !engineInput) return;
      const previous = groupInput.value;
      const groups = target().groups;
      groupInput.innerHTML = groups.map(group => `<option value="${escapeHtml(group.key)}">${escapeHtml(group.name)}</option>`).join('');
      groupInput.value = groups.some(group => group.key === previous) ? previous : 'todo';
    }

    function updateEnginePathFields() {
      const remote = !target().local;
      if (engineHint) {
        engineHint.textContent = remote ? 'The task and directory will be created on the remote engine' : 'The task and working directory are stored on the local engine';
      }
      workDirLabel.textContent = remote ? 'Remote working directory' : 'Working directory';
      workDirInput.placeholder = remote ? '/home/user/projects/example' : 'Defaults to the MD file directory';
      workDirHint.textContent = remote
        ? 'Absolute path on the remote engine; created if missing. The design doc defaults to DESIGN.md in this directory'
        : 'Docs and the terminal use this directory; existing DESIGN.md, README.md and AGENTS.md are used first and created if missing';
      mdHint.textContent = '';
      mdHint.className = 'form-hint';
      mdInput.classList.remove('error');
    }

    if (engineInput) {
      engineInput.addEventListener('change', () => {
        updateEnginePathFields();
        updateGroupOptions();
      });
    }
    updateEnginePathFields();

    mdInput.addEventListener('blur', async () => {
      const val = mdInput.value.trim();
      if (!val) { mdHint.textContent = ''; mdHint.className = 'form-hint'; return; }
      const dest = target();
      if (dest.caps !== null && !dest.caps.has('paths:validate')) {
        // An old Engine has no path-validation endpoint; validate at creation instead.
        mdHint.textContent = 'The path is validated when created on the remote engine';
        mdHint.className = 'form-hint';
        mdInput.classList.remove('error');
        return;
      }
      try {
        const result = await API.post(`${dest.tasksBase}/validate-path`, { md_path: val });
        if (result.valid) {
          mdHint.textContent = '✓ File exists';
          mdHint.className = 'form-hint ok';
          mdInput.classList.remove('error');
          if (!titleInput.value.trim()) titleInput.value = result.filename;
          if (!workDirInput.value.trim()) workDirInput.value = result.work_dir || '';
        } else {
          mdHint.textContent = result.error;
          mdHint.className = 'form-hint error';
          mdInput.classList.add('error');
        }
      } catch (e) {
        mdHint.textContent = 'Validation failed';
        mdHint.className = 'form-hint error';
      }
    });

    document.getElementById('f-submit').addEventListener('click', async () => {
      if (window.FilePanel?.isOpen() && !await FilePanel.beforeContextChange()) return;
      const title = titleInput.value.trim();
      // Unchanged default paths continue to follow the working directory.
      const pathValue = input => (input.value === input.dataset.initialValue
        ? input.dataset.pathOverride : input.value).trim() || null;
      const technical_path = pathValue(mdInput);
      const md_path = null;
      const readme_path = pathValue(document.getElementById('f-readme_path'));
      const agent_path = pathValue(document.getElementById('f-agent_path'));
      const work_dir = workDirInput.value.trim() || null;
      const priority = document.querySelector('input[name="priority"]:checked')?.value || 'normal';
      const due_date = document.getElementById('f-due-date').value || null;
      const status = groupInput?.value || 'todo';

      if (!title && !technical_path) {
        titleInput.classList.add('error');
        return;
      }
      titleInput.classList.remove('error');

      try {
        const dest = target();
        const payload = { title: title || (technical_path ? technical_path.split('/').pop().replace(/\.md$/i, '') : undefined), md_path, technical_path, readme_path, agent_path, work_dir, priority, due_date, status };
        if (existingTask.id) {
          await API.put(taskUrl(existingTask.id), payload);
          Modal.hide();
          await refreshActive();
        } else {
          const created = await API.post(dest.tasksBase, payload);
          Modal.hide();
          await showCreatedTask(dest, created);
        }
      } catch (e) {
        alert('Operation failed: ' + e.message);
      }
    });
  }

  // After creating, switch to the target Engine and select the new task.
  async function showCreatedTask(dest, created) {
    await reloadSource(dest.key);
    dest.selectedId = created.id;
    if (dest === source) {
      tasks = source.tasks;
      renderSidebar();
      selectedId = null;       // force the full selection flow so the TOC visibility is handled
      selectTask(created.id);
    } else {
      activateSource(dest.key);
    }
  }

  function showEditModal(task) {
    Modal.show('Edit task', buildTaskForm(task));
    setupFormEvents(task);
  }

  document.getElementById('btn-new-task').addEventListener('click', () => {
    Modal.show('New task', buildTaskForm());
    setupFormEvents();
  });

  // load reads the local tasks; then it returns to the last used data source (remote Engines are restored after the Engines module registers them).
  return {
    async load() {
      await reloadSource('local');
      restoreActiveSource();
    },
    refresh: refreshActive,
    activateSource,
    restoreActiveSource,
    syncSources,
    setSourceAccess,
    reloadSource,
    removeSource,
    clearView,
    problemOf: key => { const src = sources.get(key); return src ? problemOf(src) : null; },
    getActiveKey: () => source.key,
    getSource: key => sources.get(key) || null,
    getSources: () => [...sources.values()],
    onSourceChange: listener => sourceListeners.add(listener),
    disposeSourceTerminals: key => disposeTerminalsOf(key),
    showCreateGroup,
    openFileBrowser,
    confirmDiscardEditor,
    newTerminal: options => TerminalTabs.create(options),
    reopenTerminal,
    closeTerminal,
    deleteTerminal,
    restartTerminalFromWorkDir,
    // Returns whether it was really sent (false while the terminal is disconnected, paused or an image is uploading).
    sendTerminalInput(data) {
      if (TerminalImages.busy) return false;
      const instance = termInstances.get(terminalKey(selectedId));
      if (!instance || instance.paused || !instance.ws || instance.ws.readyState !== WebSocket.OPEN || activeTab !== 'shell') return false;
      instance.ws.send(data);
      instance.term.focus();
      return true;
    },
  };
})();

window.Tasks = Tasks;
