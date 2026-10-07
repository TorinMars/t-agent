const Tasks = (() => {
  // ── 数据源 ──
  // 本地 Client 与每个远程 Engine 是一个"数据源"，共用同一套界面；只有请求的基础路径、
  // 终端地址和能力不同。侧栏一次只显示当前数据源的任务。
  const STATUS_LABEL = { doing: '进行中', todo: '待办', done: '已完成', personal: '个人任务' };
  const STATUS_NEXT = { todo: 'doing', doing: 'done', done: 'personal', personal: 'todo' };
  const DEFAULT_GROUPS = [
    { id: null, key: 'personal', name: '个人任务', sort_order: 0, is_system: false },
    { id: null, key: 'doing', name: '进行中', sort_order: 1000, is_system: true },
    { id: null, key: 'todo', name: '待办', sort_order: 2000, is_system: true },
    { id: null, key: 'done', name: '已完成', sort_order: 3000, is_system: true },
  ];
  const sources = new Map();
  const sourceListeners = new Set();

  function makeSource(desc) {
    return {
      key: 'local', label: '默认', local: false, tasksBase: '/api/tasks', groupsBase: '/api/task-groups',
      wsPath: '/terminal/ws', activityUrl: null,
      caps: null,        // null = 全部可用（本地）；否则为 Engine 声明的能力集合
      role: null, problem: null, loaded: false,
      tasks: [], groups: DEFAULT_GROUPS.map(group => ({ ...group })), selectedId: null,
      ...desc,
    };
  }
  sources.set('local', makeSource({ local: true }));
  let source = sources.get('local');
  let tasks = [];       // 当前数据源的任务（与 source.tasks 同步）
  let selectedId = null; // 当前数据源选中的任务

  const can = capability => source.caps === null || source.caps.has(capability);
  const taskUrl = (id, suffix = '') => `${source.tasksBase}/${id}${suffix}`;
  // localStorage 键：本地沿用原键名，远程加上数据源前缀，避免不同 Engine 上的同号任务冲突。
  const storageId = (id, src = source) => (src.local ? String(id) : `${src.key}:${id}`);
  const selectedStorageKey = (src = source) => (src.local ? 'selectedTaskId' : `remote-selected-task-${src.id}`);
  const terminalScope = (taskId, src = source) => `${src.tasksBase}/${taskId}`;
  const activeKeyPreference = () => localStorage.getItem('active-engine-key') || 'local';
  const notifySourceChange = () => sourceListeners.forEach(listener => { try { listener(); } catch {} });

  function groupsFor(src, list) {
    return Array.isArray(list) && list.length ? list : fallbackGroups(src.tasks);
  }

  // Engine 不返回分组（旧版本）时，按任务出现的状态补全。
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
  const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' };
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
  let termTaskId = null;   // 当前终端绑定的 taskId

  // mermaid 约 5 MB，首次渲染图表时才加载；加载失败会清除缓存，下次渲染重试。
  const MERMAID_SRC = '/vendor/mermaid/mermaid-12.1.0.min.js';
  let mermaidReady = null;
  function ensureMermaid() {
    if (!mermaidReady) {
      const loaded = typeof mermaid !== 'undefined' ? Promise.resolve() : new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = MERMAID_SRC;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Mermaid 加载失败'));
        document.head.appendChild(script);
      });
      mermaidReady = loaded
        .then(() => mermaid.initialize({ startOnLoad: false, theme: 'default', gantt: { useWidth: undefined }, locale: 'zh-CN' }))
        .catch(error => { mermaidReady = null; throw error; });
    }
    return mermaidReady;
  }

  const previewPane = document.getElementById('preview-pane');
  const contentToolbar = document.getElementById('content-toolbar');
  const contentTabs = document.getElementById('content-tabs');
  const terminalPane = document.getElementById('terminal-pane');

  // ── Tab 切换 ──
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
      // 切到终端时清除"执行完成待查看"状态
      acknowledgeCurrentTerminal();
      if (task) {
        connectTerminal(task);
        // connectTerminal 是异步的（onopen），已有实例直接 focus
        const inst = termInstances.get(terminalKey(task.id));
        if (inst) setTimeout(() => { if (!inst.disposed && term === inst.term && selectedId === task.id && activeTab === 'shell') inst.term.focus(); }, 0);
      }
    }
  });

  // ── 每个任务的每个终端独立缓存；切换标签只隐藏视图 ──
  const termInstances = new Map(); // [sourceKey, taskId, terminalId] -> live terminal instance
  function terminalKey(taskId, terminalId, sourceKey = source.key) {
    const src = sources.get(sourceKey) || source;
    return JSON.stringify([sourceKey, taskId, terminalId ?? TerminalTabs.current(terminalScope(taskId, src))]);
  }

  // 终端状态由服务端按 PTY 前台进程判定（running / done），这里只负责展示。
  // 左侧任务项取该任务所有终端的汇总状态；终端 tab 各自显示自己的状态。
  function applyTermState(item, state) {
    item.classList.toggle('term-running', state === 'running');
    item.classList.toggle('term-done', state === 'done');
  }

  function refreshTermIndicators() {
    document.querySelectorAll('.task-nav-item[data-id]').forEach(item => {
      applyTermState(item, TerminalActivity.taskState(Number(item.dataset.id), source.key));
    });
    TerminalTabs.refresh();
    notifySourceChange(); // 引擎标签汇总各自的终端状态
  }

  // 用户正在看某个任务当前终端时，视为已确认完成
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
    inst.term.write(`\r\n\x1b[33m[连接已断开，${Math.ceil(delay / 1000)}s 后自动重连...]\x1b[0m\r\n`);
  }

  function connectWebSocket(task, inst) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${inst.wsPath}?taskId=${task.id}&terminalId=${encodeURIComponent(inst.terminalId)}`);
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
      if (event.code === 1000 || event.code === 1008) {
        inst.term.write('\r\n[终端已断开，点击“重新打开”可再次连接]\r\n');
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
      theme: { background: '#1e1e1e' },
      scrollback: 5000,
    });
    const fa = new FitAddon.FitAddon();
    t.loadAddon(fa);
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
    if (!task) throw new Error('请先选择任务');
    return task;
  }

  async function reopenTerminal() {
    const task = selectedTerminalTask();
    disposeTerminalInstance(task.id);
    TerminalControls.clearMessage();
    connectTerminal(task);
  }

  async function controlTerminal(action) {
    const task = selectedTerminalTask();
    disposeTerminalInstance(task.id);
    try {
      await API.post(`${terminalScope(task.id)}/terminal/control`, { action, terminal_id: TerminalTabs.current(terminalScope(task.id)) });
    } catch (error) {
      // 控制请求失败时恢复到原服务端会话，避免留下不可见的运行进程。
      connectTerminal(task);
      throw error;
    }
    TerminalActivity.refresh(source.key);
    if (action === 'restart-workdir') {
      TerminalControls.clearMessage();
      connectTerminal(task);
    } else {
      TerminalControls.showMessage('当前终端已关闭。点击“重新打开”可从任务工作目录启动新终端。');
    }
  }

  async function deleteTerminal() {
    const task = selectedTerminalTask();
    const scope = terminalScope(task.id);
    const terminalId = TerminalTabs.current(scope);
    if (terminalId === 'default') throw new Error('默认终端不能删除，可使用关闭或从工作目录重新打开');
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
    } catch (error) { alert('文件浏览器打开失败：' + error.message); }
  });

  // 在 Finder / VS Code 中打开、生成分享链接依赖本机文件系统，远程任务不提供。
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
      btn.textContent = '已复制 ✓';
      btn.style.color = 'var(--accent)';
      setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 2000);
    } catch (e) {
      alert('生成分享链接失败: ' + e.message);
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

  // 基础 renderer（不含相对路径重写，需运行时传入 taskId）
  function makeRenderer(taskId) {
    const isRelativeSrc = src => src && !src.startsWith('http') && !src.startsWith('/') && !src.startsWith('data:');
    // 相对路径的图片/链接经当前数据源读取；Engine 不支持时保持原样。
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
    // 每次创建独立实例以注入当前 taskId 的 renderer，避免全局状态污染
    const m = new marked.Marked({ renderer: makeRenderer(taskId) });
    return m.parse(content);
  }

  // 给已渲染的 mermaid SVG 加放大按钮，点击弹出 modal
  function wrapMermaidDiagrams(container) {
    container.querySelectorAll('.mermaid').forEach(el => {
      if (el.dataset.zoomBound) return;
      el.dataset.zoomBound = '1';

      const wrap = document.createElement('div');
      wrap.className = 'mermaid-wrap';
      // actor 每个参与者渲染顶部+底部共2个 g.actor，除以2得实际数量
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
      btn.title = '放大查看';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
      wrap.appendChild(btn);

      btn.addEventListener('click', () => openMermaidModal(el));
    });
  }

  // Modal 放大查看
  let mermaidModal = null;
  function openMermaidModal(el) {
    if (!mermaidModal) {
      mermaidModal = document.createElement('div');
      mermaidModal.className = 'mermaid-modal';
      mermaidModal.innerHTML = `
        <div class="mermaid-modal-backdrop"></div>
        <div class="mermaid-modal-box">
          <button class="mermaid-modal-close" title="关闭">✕</button>
          <div class="mermaid-modal-hint">触控板缩放 · 拖拽移动 · 双击重置</div>
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
      let fitScale = 1; // 每次打开时计算的适合缩放值
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
          // 触控板双指捏合 → 缩放
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          zoomAt(scale * factor, e.clientX, e.clientY);
        } else {
          // 触控板双指平移 → 移动
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

      // 触控：双指开合缩放，双指/单指移动
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
          // 缩放
          if (lastTouchDist) {
            zoomAt(scale * dist / lastTouchDist, lastTouchMidX, lastTouchMidY);
          }
          // 平移：用当前帧与上一帧中心点的差值增量累加
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
    // 克隆的 SVG 恢复原始尺寸，由 modal 自己决定缩放
    const clonedSvg = cloned.querySelector('svg');
    if (clonedSvg) { clonedSvg.style.width = ''; clonedSvg.style.height = ''; }
    canvas.appendChild(cloned);
    mermaidModal.classList.add('open');
    document.body.style.overflow = 'hidden';

    // 等 modal 显示后计算合适的初始 scale
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
    if (diff < 0) return { text: '已逾期', overdue: true };
    if (diff === 0) return { text: '今天', overdue: false };
    if (diff === 1) return { text: '明天', overdue: false };
    return { text: dateStr, overdue: false };
  }

  // 无法连接的 Engine：认证失效、服务离线，或本次加载任务失败。
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
      note.textContent = '服务不可用，请检查服务状态';
      section.appendChild(note);
      nav.scrollTop = scrollTop;
      return;
    }

    const writable = can('tasks:write');
    const heading = document.createElement('div');
    heading.className = 'sidebar-section-heading';
    const title = document.createElement('span');
    title.textContent = source.local ? '本地任务' : source.label;
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
      add.title = '新建任务分组';
      add.setAttribute('aria-label', '新建任务分组');
      add.textContent = '＋';
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
    headerEl.title = group.is_system || !group.id ? '默认分组' : '右键管理分组';

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
      // 拖拽放置到组（空组也能接收）
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
        // 只在真正离开整个 itemsEl 时移除 placeholder
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
        { label: '重命名分组', action: () => showRenameGroup(group) },
        { label: '删除分组', danger: true, action: () => removeGroup(group) },
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
      // 更新 status
      if (task.status !== targetStatus) {
        await API.put(taskUrl(id), { status: targetStatus });
      }
      // 重新计算目标组内的 sort_order（旧版 Engine 不支持排序，只改分组）
      if (can('tasks:reorder')) {
        const groupTasks = tasks
          .filter(t => t.id !== id && t.status === targetStatus)
          .sort((a, b) => a.sort_order - b.sort_order);
        groupTasks.splice(newIndex, 0, { ...task, status: targetStatus });
        await API.put(`${source.tasksBase}/reorder`, groupTasks.map((t, i) => ({ id: t.id, sort_order: i })));
      }
    } catch (error) {
      alert('移动任务失败: ' + error.message);
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
    statusBtn.title = writable ? `点击切换状态（当前：${statusLabel}）` : `当前：${statusLabel}`;
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
          label: `${task.status === group.key ? '✓ ' : ''}移到「${group.name}」`,
          action: () => setStatus(task.id, group.key),
        })),
        { separator: true },
        { label: '编辑', action: () => showEditModal(task) },
        { label: '删除', danger: true, action: () => deleteTask(task.id) },
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
    menuButton.title = '任务菜单';
    menuButton.setAttribute('aria-label', `${task.title} 的任务菜单`);
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
    catch (error) { alert('更新任务失败: ' + error.message); }
    await refreshActive();
  }

  async function deleteTask(id) {
    if (selectedId === id && window.FilePanel?.isOpen() && !await FilePanel.beforeContextChange()) return;
    if (!confirm('确认删除该任务？')) return;
    try { await API.delete(taskUrl(id)); }
    catch (error) { alert('删除任务失败: ' + error.message); return; }
    if (selectedId === id) {
      disposeTerminalsOf(source.key, id);
      selectedId = null;
      source.selectedId = null;
      showEmpty();
    }
    await refreshActive();
  }

  // ── 任务分组（本地与远程相同） ──
  function groupNameDialog(title, initial, onSubmit) {
    Modal.show(title, `
      <div class="form-group"><label class="form-label">分组名称</label><input class="form-input" id="group-name" maxlength="40" value="${escapeHtml(initial)}" autocomplete="off"></div>
      <div class="form-hint error" id="group-name-error"></div>
      <div class="form-actions"><button class="btn-cancel" id="group-name-cancel">取消</button><button class="btn-submit" id="group-name-save">保存</button></div>`);
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
      GROUP_NAME_REQUIRED: '请输入分组名称', GROUP_NAME_TOO_LONG: '分组名称不能超过 40 个字符',
      GROUP_NAME_ALREADY_EXISTS: '已有同名分组', TASK_GROUP_NOT_FOUND: '任务分组不存在',
      SYSTEM_GROUP_IMMUTABLE: '默认分组不能修改或删除', TASK_GROUP_NOT_EMPTY: '分组内还有任务，不能删除',
    })[code] || code;
  }

  function showCreateGroup() {
    groupNameDialog('新建任务分组', '', name => API.post(source.groupsBase, { name }));
  }

  function showRenameGroup(group) {
    groupNameDialog('重命名分组', group.name, name => API.put(`${source.groupsBase}/${group.id}`, { name }));
  }

  async function removeGroup(group) {
    if (!confirm(`确认删除分组“${group.name}”？分组内必须没有任务。`)) return;
    try { await API.delete(`${source.groupsBase}/${group.id}`); await refreshActive(); }
    catch (error) { alert('删除分组失败: ' + groupErrorLabel(error.message)); }
  }

  // ── 数据源：加载、切换、同步 ──
  function errorCode(error) {
    const message = String((error && error.message) || '');
    try { const parsed = JSON.parse(message); if (parsed && typeof parsed.error === 'string') return parsed.error; } catch {}
    return /^[A-Z0-9_]+$/.test(message) ? message : 'REMOTE_CONNECTION_FAILED';
  }

  // 重新读取一个数据源的任务与分组；远程失败时只记录连接问题，不抛出。
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
    // 旧版 Engine 没有分组接口时，按任务状态补全。
    let groups = null;
    try { groups = await API.get(src.groupsBase); } catch {}
    src.groups = groupsFor(src, groups);
    src.loaded = true;
    if (src === source) tasks = src.tasks;
  }

  function showSourceLoading() {
    const empty = document.getElementById('preview-empty');
    empty.style.display = 'flex';
    empty.querySelector('span').textContent = `正在加载 ${source.label}…`;
    document.getElementById('preview-content').style.display = 'none';
    contentToolbar.style.display = 'none';
    contentTabs.style.display = 'none';
    terminalPane.style.display = 'none';
    previewPane.style.display = '';
  }

  // 清空内容区（切换到不可用的 Engine、移除连接时使用）。
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
    // Finder / VS Code 依赖本机文件系统，远程任务不显示。
    for (const id of ['btn-reveal-folder', 'btn-open-vscode']) {
      const button = document.getElementById(id);
      if (button) button.style.display = source.local ? '' : 'none';
    }
  }

  function activateSource(key, options = {}) {
    const next = sources.get(key) || sources.get('local');
    if (next !== source && !options.confirmed) {
      if (window.FilePanel?.isOpen()) {
        // 面板确认一次后继续切换，不再重复检查。
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
    hideToc();          // 同时让上一个数据源里未完成的渲染作废
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

  // 启动或 Engine 列表刷新后，回到用户上次使用的数据源。
  let enginesSynced = false;
  function restoreActiveSource() {
    const wanted = activeKeyPreference();
    if (wanted === 'local') {
      if (sources.get('local').loaded) activateSource('local');
    } else if (sources.has(wanted)) {
      activateSource(wanted);
    } else if (enginesSynced) {
      activateSource('local');  // 保存的 Engine 已被移除
    }
  }

  // 重新读取当前数据源并刷新界面。
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

  // Engines 模块同步远程连接列表：新增、更新或移除数据源，保留已有的任务缓存。
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

  // 声明 Engine 的角色与能力；只读角色去掉所有写入类能力。
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
    notifySourceChange(); // 工具面板按角色和能力决定 PM2 是否可用
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
    // 标签栏（技术方案 / README / AGENTS.md / 待办 / 终端）必须随选中任务显示；
    // 上次停在“终端”标签时不会渲染文档，不能指望 renderPreview 来显示它。
    contentTabs.style.display = 'flex';
    document.querySelectorAll('.task-nav-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.id) === id);
    });
    // 恢复该任务上次停留的 tab
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
      // 切到终端时清除"执行完成待查看"状态
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
      // 待办页沿用完整工具栏，避免切换 Tab 时内容区上下跳动。
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
          <div class="task-info-row"><span class="task-info-label">状态</span><span class="badge ${task.status}">${STATUS_LABEL[task.status]}</span></div>
          <div class="task-info-row"><span class="task-info-label">优先级</span><span class="badge ${task.priority}">${PRIORITY_LABEL[task.priority]}</span></div>
          ${task.due_date ? `<div class="task-info-row"><span class="task-info-label">截止日</span><span class="${due && due.overdue ? 'badge high' : ''}">${task.due_date}</span></div>` : ''}
          ${task.work_dir ? `<div class="task-info-row"><span class="task-info-label">工作目录</span><span class="task-info-path">${escapeHtml(task.work_dir)}</span></div>` : ''}
        </div>`;
      return;
    }

    if (!hasDocumentRoot) {
      content.innerHTML = '<div class="document-empty">该任务尚未配置工作目录</div>';
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
    button.title = !writable ? '当前连接为只读，无法编辑'
      : enabled ? '在页面中编辑当前 Markdown' : '当前页面不是可编辑的 Markdown';
  }

  function confirmDiscardEditor() {
    if (!editorState) return true;
    if (editorState.dirty && !confirm('当前文档有未保存的修改，确认放弃吗？')) return false;
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
      if (typeof monaco === 'undefined') alert('编辑器资源加载失败，请刷新页面');
      return;
    }
    stopWatcher();
    hideToc();
    const content = document.getElementById('preview-content');
    const editButton = document.getElementById('btn-edit-md');
    editButton.disabled = true;
    content.innerHTML = '<div class="preview-loading">正在打开编辑器...</div>';
    try {
      const kind = documentKind(tab);
      const sourceKey = source.key;
      const res = await fetch(taskUrl(task.id, `/document/${kind}`), {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) throw new Error('文档读取失败');
      const text = await res.text();
      if (selectedId !== task.id || activeTab !== tab || source.key !== sourceKey) return;
      content.classList.add('editor-active');
      content.innerHTML = `
        <div class="md-editor-shell">
          <div class="md-editor-header">
            <span class="md-editor-file">${escapeHtml(documentLabel(tab))}</span>
            <span class="md-editor-status" id="md-editor-status">未修改</span>
            <span class="md-editor-shortcuts">VS Code 原生快捷键 · Alt/Option+点击多光标 · Shift+Alt/Option+拖拽列选</span>
            <button type="button" class="md-editor-action secondary" id="md-editor-cancel">取消</button>
            <button type="button" class="md-editor-action primary" id="md-editor-save">保存</button>
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
        theme: 'vs',
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
        document.getElementById('md-editor-status').textContent = editorState.dirty ? '未保存' : '未修改';
      });
      document.getElementById('md-editor-save').addEventListener('click', saveDocumentEditor);
      document.getElementById('md-editor-cancel').addEventListener('click', cancelDocumentEditor);
      requestAnimationFrame(() => editor.focus());
    } catch (e) {
      content.classList.remove('editor-active');
      editorState = null;
      editButton.disabled = false;
      alert('打开编辑器失败: ' + e.message);
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
    status.textContent = '保存中...';
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
      status.textContent = '保存失败';
      alert('保存文档失败: ' + e.message);
    }
  }

  async function cancelDocumentEditor() {
    const state = editorState;
    if (!state) return;
    if (state.dirty && !confirm('确认放弃未保存的修改吗？')) return;
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
    content.innerHTML = '<div class="preview-loading">正在加载待办...</div>';
    try {
      const todos = await API.get(taskUrl(task.id, '/todos'));
      if (selectedId !== renderForId || activeTab !== 'todos') return;
      const writable = can('todos:write');
      const completedCount = todos.filter(todo => todo.completed).length;
      content.innerHTML = `
        <section class="todo-page${writable ? '' : ' remote-readonly'}">
          <div class="todo-heading">
            <div>
              <h2>待办清单</h2>
              <p>${writable ? (todos.length ? `已完成 ${completedCount} / ${todos.length}` : '记录这个任务接下来要做的事情') : '当前连接为只读'}</p>
            </div>
          </div>
          ${writable ? `<form class="todo-add-form" id="todo-add-form">
            <input id="todo-new-content" type="text" maxlength="500" autocomplete="off" placeholder="添加一项待办，按 Enter 保存">
            <button type="submit">添加</button>
          </form>` : ''}
          <div class="todo-list" id="todo-list">
            ${todos.length ? todos.map(todo => `
              <div class="todo-item${todo.completed ? ' completed' : ''}" data-todo-id="${todo.id}">
                <label class="todo-check-wrap" title="${todo.completed ? '标记为未完成' : '标记为已完成'}">
                  <input class="todo-check" type="checkbox" ${todo.completed ? 'checked' : ''} ${writable ? '' : 'disabled'}>
                  <span class="todo-checkmark"></span>
                </label>
                <span class="todo-content" ${writable ? 'title="双击编辑"' : ''}>${escapeHtml(todo.content)}</span>
                ${writable ? '<button class="todo-delete" type="button" title="删除待办">×</button>' : ''}
              </div>`).join('') : '<div class="todo-empty">还没有待办事项</div>'}
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
          alert('添加待办失败: ' + e.message);
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
            alert('更新待办失败: ' + e.message);
          }
        });
        label.addEventListener('dblclick', () => editTodoInline(task, todoId, label));
        item.querySelector('.todo-delete').addEventListener('click', async () => {
          try {
            await API.delete(taskUrl(task.id, `/todos/${todoId}`));
            await renderTodos(task);
          } catch (e) {
            alert('删除待办失败: ' + e.message);
          }
        });
      });
      input.focus();
    } catch (e) {
      if (selectedId === renderForId && activeTab === 'todos') {
        content.innerHTML = '<div class="preview-loading">待办加载失败</div>';
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
        alert('更新待办失败: ' + e.message);
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
    return tab === 'readme' ? 'README.md' : tab === 'agent' ? 'AGENTS.md' : '技术方案';
  }

  function isCurrentPreview(task, tab) {
    return selectedId === task.id && activeTab === tab && ['doc', 'readme', 'agent'].includes(tab)
      && !editorState && previewPane.style.display !== 'none';
  }

  async function loadMdContent(task, tab = activeTab) {
    const content = document.getElementById('preview-content');
    const savedScroll = parseInt(localStorage.getItem(`mdScroll_${storageId(task.id)}_${tab}`)) || 0;
    const scrollTop = previewPane.scrollTop || savedScroll;
    // 记录本次渲染时的目标任务，异步回来后校验是否仍是当前任务/tab，防止竞态更新 UI
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
            <p>${escapeHtml(documentLabel(tab))} 不存在</p>
            ${canCreate ? `<button class="document-create-btn" id="document-create-btn">创建 ${escapeHtml(documentLabel(tab))}</button>` : ''}
          </div>`;
        if (canCreate) {
          document.getElementById('document-create-btn').addEventListener('click', async () => {
            try {
              await API.post(taskUrl(task.id, `/document/${documentKind(tab)}`), {});
              setEditButtonState(true);
              await loadMdContent(task, tab);
              startWatcher(task, tab);
            } catch (e) {
              alert('创建文档失败: ' + e.message);
            }
          });
        }
        return;
      }
      if (!res.ok) throw new Error('Failed');
      const text = await res.text();
      if (!isCurrent()) return;
      content.innerHTML = (can('documents:write') ? '' : `<div class="remote-readonly-banner">${escapeHtml(source.label)} · 只读连接</div>`) + renderMd(text, task.id);
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
      // 逐个渲染 mermaid，单个失败不影响整体
      for (const node of content.querySelectorAll('.mermaid')) {
        if (!isCurrent()) return;
        try {
          await ensureMermaid();
          await mermaid.run({ nodes: [node] });
        } catch (e) {
          if (!isCurrent()) return;
          node.innerHTML = `<pre style="color:#c0392b;font-size:12px;white-space:pre-wrap">⚠️ Mermaid 渲染失败：${e.message || e.str || '语法错误'}</pre>`;
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
      content.innerHTML = '<div class="preview-loading">加载失败，请检查文件路径是否有效</div>';
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

    // 加载折叠状态持久化
    const storageKey = `toc-collapsed-${storageId(selectedId)}`;
    let collapsed = new Set();
    try { collapsed = new Set(JSON.parse(localStorage.getItem(storageKey)) || []); } catch(e) {}

    function saveCollapsed() {
      localStorage.setItem(storageKey, JSON.stringify([...collapsed]));
    }

    // 构建树形结构：每个节点记录其子孙 item 索引
    const items = Array.from(headings).map((h, i) => ({
      h,
      level: parseInt(h.tagName[1]),
      index: i,
      children: [],   // 直接子孙 item index（所有层级）
    }));

    // 计算每个节点的"所有子孙"范围（level 更大的紧跟序列）
    function getDescendants(idx) {
      const level = items[idx].level;
      const result = [];
      for (let i = idx + 1; i < items.length; i++) {
        if (items[i].level <= level) break;
        result.push(i);
      }
      return result;
    }

    // 判断节点是否有子节点（下一个 level 更大）
    function hasChildren(idx) {
      return idx + 1 < items.length && items[idx + 1].level > items[idx].level;
    }

    // 渲染所有 item，绑定折叠逻辑
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
      // 对每个 item，检查其所有祖先是否有折叠的
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
    empty.querySelector('span').textContent = source.local || tasks.length ? '← 选择左侧任务查看详情' : `${source.label} 暂无任务`;
    document.getElementById('preview-content').style.display = 'none';
    contentToolbar.style.display = 'none';
    contentTabs.style.display = 'none';
    TerminalHistory.activate(null);
    terminalPane.style.display = 'none';
    previewPane.style.display = '';
    hideToc();
    stopWatcher();
  }

  // 新建任务可选的目标：本地 Engine 和可连接且可写的远程 Engine。
  function targetLabel(src) {
    if (src.local) return '本地 Engine';
    return `${src.label}${problemOf(src) ? '（离线）' : ''}`;
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
        <label class="form-label">所属 Engine</label>
        <select class="form-input" id="f-engine">
          ${[...sources.values()].map(src => `<option value="${escapeHtml(src.key)}" ${src === initialTarget ? 'selected' : ''} ${targetUsable(src) ? '' : 'disabled'}>${escapeHtml(targetLabel(src))}</option>`).join('')}
        </select>
        <div class="form-hint" id="f-engine-hint">任务和工作目录将保存在所选 Engine 上</div>
      </div>` : '';
    return `
      ${enginePicker}
      <div class="form-group">
        <label class="form-label">标题</label>
        <input class="form-input" id="f-title" type="text" value="${escapeHtml(task.title || '')}" placeholder="任务标题（可由 MD 文件名自动填充）">
      </div>
      ${[['technical_path', '技术方案', 'DESIGN.md'], ['readme_path', 'README.md', 'README.md'], ['agent_path', 'AGENTS.md', 'AGENTS.md']].map(([field, label, name]) => {
        const override = task[field] || (field === 'technical_path' && task.md_path && !task.md_path.endsWith('/DESIGN.md') ? task.md_path : '');
        const root = task.work_dir || (task.md_path ? task.md_path.slice(0, task.md_path.lastIndexOf('/')) || '/' : '');
        const value = override || (task.id && root ? `${root.replace(/\/$/, '')}/${name}` : '');
        const id = field === 'technical_path' ? 'f-md-path' : `f-${field}`;
        return `<div class="form-group"><label class="form-label">${label}路径</label><input class="form-input" id="${id}" type="text" value="${escapeHtml(value)}" data-path-override="${escapeHtml(override)}" data-initial-value="${escapeHtml(value)}" placeholder="留空使用工作目录下的 ${name}">${field === 'technical_path' ? '<div class="form-hint" id="f-md-hint"></div>' : ''}</div>`;
      }).join('')}
      <div class="form-hint">三个路径均可填写绝对 Markdown 文件路径；已有文件直接使用，缺失时创建。清空后恢复工作目录下的默认文件。</div>
      <div class="form-group">
        <label class="form-label" id="f-work-dir-label">${initialRemote ? '远程工作目录' : '工作目录'}</label>
        <input class="form-input" id="f-work-dir" type="text" value="${escapeHtml(task.work_dir || '')}" placeholder="${initialRemote ? '/home/user/projects/example' : '自动取 MD 文件所在目录'}" autocomplete="off">
        <div class="form-hint" id="f-work-dir-hint">${initialRemote ? '填写远程 Engine 上的绝对路径；目录不存在时会自动创建，技术方案默认为该目录下的 DESIGN.md' : '文档和终端均使用此目录；优先读取已有 DESIGN.md、README.md、AGENTS.md，缺失时创建'}</div>
      </div>
      <div class="form-group">
        <label class="form-label">优先级</label>
        <div class="form-radio-group">
          <label><input type="radio" name="priority" value="low" ${task.priority === 'low' ? 'checked' : ''}> 低</label>
          <label><input type="radio" name="priority" value="normal" ${(!task.priority || task.priority === 'normal') ? 'checked' : ''}> 中</label>
          <label><input type="radio" name="priority" value="high" ${task.priority === 'high' ? 'checked' : ''}> 高</label>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">分组</label>
        <select class="form-input" id="f-task-group">
          ${initialGroups.map(group => `<option value="${escapeHtml(group.key)}" ${group.key === selectedGroup ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">截止日期</label>
        <input class="form-input" id="f-due-date" type="date" value="${task.due_date || ''}">
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="f-cancel">取消</button>
        <button class="btn-submit" id="f-submit">${task.id ? '保存' : '创建'}</button>
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

    // 创建时由“所属 Engine”决定目标；编辑时就是当前数据源。
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
        engineHint.textContent = remote ? '任务和目录将创建在远程 Engine 上' : '任务和工作目录将保存在本地 Engine 上';
      }
      workDirLabel.textContent = remote ? '远程工作目录' : '工作目录';
      workDirInput.placeholder = remote ? '/home/user/projects/example' : '自动取 MD 文件所在目录';
      workDirHint.textContent = remote
        ? '填写远程 Engine 上的绝对路径；目录不存在时会自动创建，技术方案默认为该目录下的 DESIGN.md'
        : '文档和终端均使用此目录；优先读取已有 DESIGN.md、README.md、AGENTS.md，缺失时创建';
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
        // 旧版 Engine 没有路径校验接口，创建时再校验。
        mdHint.textContent = '路径将在远程 Engine 创建时校验';
        mdHint.className = 'form-hint';
        mdInput.classList.remove('error');
        return;
      }
      try {
        const result = await API.post(`${dest.tasksBase}/validate-path`, { md_path: val });
        if (result.valid) {
          mdHint.textContent = '✓ 文件存在';
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
        mdHint.textContent = '校验失败';
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
        alert('操作失败: ' + e.message);
      }
    });
  }

  // 新建后切换到目标 Engine 并选中新任务。
  async function showCreatedTask(dest, created) {
    await reloadSource(dest.key);
    dest.selectedId = created.id;
    if (dest === source) {
      tasks = source.tasks;
      renderSidebar();
      selectedId = null;       // 强制走完整的选中流程，处理 TOC 显隐
      selectTask(created.id);
    } else {
      activateSource(dest.key);
    }
  }

  function showEditModal(task) {
    Modal.show('编辑任务', buildTaskForm(task));
    setupFormEvents(task);
  }

  document.getElementById('btn-new-task').addEventListener('click', () => {
    Modal.show('新建任务', buildTaskForm());
    setupFormEvents();
  });

  // load 读取本地任务；随后回到上次使用的数据源（远程 Engine 由 Engines 模块注册后再恢复）。
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
    newTerminal: () => TerminalTabs.create(),
    reopenTerminal,
    closeTerminal,
    deleteTerminal,
    restartTerminalFromWorkDir,
    sendTerminalInput(data) {
      if (TerminalImages.busy) return;
      const instance = termInstances.get(terminalKey(selectedId));
      if (!instance || instance.paused || !instance.ws || instance.ws.readyState !== WebSocket.OPEN || activeTab !== 'shell') return;
      instance.ws.send(data);
      instance.term.focus();
    },
  };
})();

window.Tasks = Tasks;
