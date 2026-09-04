const Tasks = (() => {
  let tasks = [];
  let selectedId = null;
  const STATUS_ORDER = ['personal', 'doing', 'todo', 'done'];
  const STATUS_LABEL = { doing: '进行中', todo: '待办', done: '已完成', personal: '个人任务' };
  const STATUS_NEXT = { todo: 'doing', doing: 'done', done: 'personal', personal: 'todo' };
  const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' };
  const collapsedGroups = {};
  let tocObserver = null;
  let mdWatcher = null;
  let editorState = null;

  // ── Tab & Terminal state ──
  const VALID_TABS = ['doc', 'readme', 'agent', 'todos', 'shell'];
  let activeTab = 'doc';

  function getTaskTab(id) {
    const tab = localStorage.getItem(`task-tab-${id}`) || 'doc';
    return VALID_TABS.includes(tab) ? tab : 'doc';
  }
  function saveTaskTab(id, tab) {
    localStorage.setItem(`task-tab-${id}`, tab);
  }
  let term = null;
  let fitAddon = null;
  let termWs = null;
  let termTaskId = null;   // 当前终端绑定的 taskId

  mermaid.initialize({ startOnLoad: false, theme: 'default', gantt: { useWidth: undefined }, locale: 'zh-CN' });

  const previewPane = document.getElementById('preview-pane');
  const contentToolbar = document.getElementById('content-toolbar');
  const contentTabs = document.getElementById('content-tabs');
  const terminalPane = document.getElementById('terminal-pane');

  // ── Tab 切换 ──
  contentTabs.addEventListener('click', (e) => {
    if (window.RemoteTasks && window.RemoteTasks.isSelected()) return;
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
      if (selectedId && previousTab === 'shell') onLeaveShellTab(selectedId);
      previewPane.style.display = '';
      terminalPane.style.display = 'none';
      const task = tasks.find(t => t.id === selectedId);
      if (task) renderPreview(task);
    } else {
      const task = tasks.find(t => t.id === selectedId);
      contentToolbar.style.visibility = 'visible';
      contentToolbar.style.pointerEvents = '';
      contentToolbar.style.display = task && task.md_path ? 'flex' : 'none';
      setEditButtonState(false);
      previewPane.style.display = 'none';
      document.getElementById('toc-pane').style.display = 'none';
      terminalPane.style.display = 'flex';
      // 切到终端时清除"执行完成待查看"状态
      if (selectedId && termState.get(selectedId) === 'done') updateTermDot(selectedId, 'idle');
      if (task) {
        connectTerminal(task);
        // connectTerminal 是异步的（onopen），已有实例直接 focus
        const inst = termInstances.get(task.id);
        if (inst) setTimeout(() => inst.term.focus(), 0);
      }
    }
  });

  // ── xterm.js 终端：每个任务独立 Terminal 实例，切换时销毁旧的 ──
  const termInstances = new Map(); // taskId -> { term, fitAddon, ws, container }

  // 终端状态：'idle' | 'running' | 'done'
  const termState = new Map();       // taskId -> state
  let termDoneTimers = new Map();    // taskId -> setTimeout handle
  const termLastActivity = new Map(); // taskId -> timestamp（最后收到 PTY 输出的时间）

  // 更新左侧任务项的圆点
  function updateTermDot(taskId, state) {
    termState.set(taskId, state);
    const dot = document.querySelector(`.task-nav-item[data-id="${taskId}"] .term-dot`);
    if (!dot) return;
    dot.className = 'term-dot';
    if (state === 'running') dot.classList.add('running');
    else if (state === 'done') dot.classList.add('done');
  }

  // 切离某个 task 的 shell tab 时调用：若最近 30s 内有活动，补设 done
  function onLeaveShellTab(taskId) {
    const last = termLastActivity.get(taskId);
    if (!last) return;
    if (Date.now() - last < 30000 && termState.get(taskId) !== 'running') {
      updateTermDot(taskId, 'done');
    }
  }

  // PTY 有输出 → running；输出静止 2s → done
  function onTermData(taskId) {
    termLastActivity.set(taskId, Date.now());
    if (termDoneTimers.has(taskId)) {
      clearTimeout(termDoneTimers.get(taskId));
      termDoneTimers.delete(taskId);
    }
    if (termState.get(taskId) !== 'running') updateTermDot(taskId, 'running');

    const timer = setTimeout(() => {
      termDoneTimers.delete(taskId);
      // 无论用户是否在看，先设 done；若当前正在看则再立即清掉
      updateTermDot(taskId, 'done');
      if (selectedId === taskId && activeTab === 'shell') {
        updateTermDot(taskId, 'idle');
      }
    }, 2000);
    termDoneTimers.set(taskId, timer);
  }

  function disposeTerminalInstance(taskId) {
    const inst = termInstances.get(taskId);
    if (!inst) return;
    inst.disposed = true;
    if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
    if (inst.ws) inst.ws.close();
    inst.term.dispose();
    inst.el.remove();
    termInstances.delete(taskId);
    if (termTaskId === taskId) {
      term = null;
      fitAddon = null;
      termWs = null;
      termTaskId = null;
    }
  }

  function scheduleReconnect(task, inst) {
    if (inst.disposed || termInstances.get(task.id) !== inst || inst.reconnectTimer) return;
    const delay = Math.min(1000 * (2 ** inst.reconnectAttempts), 30000);
    inst.reconnectAttempts += 1;
    inst.reconnectTimer = setTimeout(() => {
      inst.reconnectTimer = null;
      if (!inst.disposed && termInstances.get(task.id) === inst) connectWebSocket(task, inst);
    }, delay);
    inst.term.write(`\r\n\x1b[33m[连接已断开，${Math.ceil(delay / 1000)}s 后自动重连...]\x1b[0m\r\n`);
  }

  function connectWebSocket(task, inst) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/terminal/ws?taskId=${task.id}`);
    ws.binaryType = 'arraybuffer';
    inst.ws = ws;
    termWs = ws;

    ws.onopen = () => {
      const reconnecting = inst.reconnectAttempts > 0;
      if (reconnecting) inst.term.reset();
      inst.reconnectAttempts = 0;
      inst.fitAddon.fit();
      inst.term.focus();
      ws.send(JSON.stringify({ type: 'resize', cols: inst.term.cols, rows: inst.term.rows }));
      if (reconnecting) inst.term.write('\x1b[32m[重新连接成功]\x1b[0m\r\n');
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && e.data.startsWith('{"type":"history"')) {
        try {
          const msg = JSON.parse(e.data);
          inst.paused = true;
          inst.term.write(msg.data, () => {
            requestAnimationFrame(() => requestAnimationFrame(() => { inst.paused = false; }));
          });
        } catch { inst.term.write(e.data); }
        return;
      }
      if (e.data instanceof ArrayBuffer) {
        inst.term.write(new Uint8Array(e.data));
      } else {
        inst.term.write(e.data);
        onTermData(task.id, e.data);
      }
    };

    ws.onclose = () => {
      if (inst.ws !== ws || inst.disposed || termInstances.get(task.id) !== inst) return;
      inst.ws = null;
      scheduleReconnect(task, inst);
    };

    ws.onerror = () => {};
  }

  function connectTerminal(task) {
    const container = document.getElementById('xterm-container');

    if (termInstances.has(task.id)) {
      const inst = termInstances.get(task.id);
      if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
        termInstances.forEach((i, id) => i.el.style.display = id === task.id ? '' : 'none');
        term = inst.term;
        fitAddon = inst.fitAddon;
        termWs = inst.ws;
        termTaskId = task.id;
        setTimeout(() => { inst.fitAddon.fit(); inst.term.focus(); }, 0);
        return;
      }
      disposeTerminalInstance(task.id);
    }

    termInstances.forEach(i => i.el.style.display = 'none');

    const el = document.createElement('div');
    el.style.cssText = 'width:100%;height:100%';
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

    const inst = {
      term: t,
      fitAddon: fa,
      ws: null,
      el,
      paused: false,
      disposed: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
    };
    termInstances.set(task.id, inst);
    termTaskId = task.id;
    term = t;
    fitAddon = fa;

    t.onData(data => {
      if (inst.paused) return;
      if (inst.ws && inst.ws.readyState === WebSocket.OPEN) inst.ws.send(data);
    });

    t.onResize(({ cols, rows }) => {
      if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
        inst.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    connectWebSocket(task, inst);

    window.addEventListener('resize', () => {
      if (activeTab === 'shell' && termTaskId === task.id) fa.fit();
    });
  }



  document.getElementById('btn-reveal-folder').addEventListener('click', async () => {
    if (!selectedId) return;
    await API.post(`/api/tasks/${selectedId}/reveal`, {});
  });

  document.getElementById('btn-open-vscode').addEventListener('click', async () => {
    if (!selectedId) return;
    await API.post(`/api/tasks/${selectedId}/vscode`, {});
  });

  document.getElementById('btn-share-md').addEventListener('click', async () => {
    if (!selectedId) return;
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
        localStorage.setItem(`mdScroll_${selectedId}_${activeTab}`, previewPane.scrollTop);
      }
    }, 150);
  });

  // 基础 renderer（不含相对路径重写，需运行时传入 taskId）
  function makeRenderer(taskId) {
    const isRelativeSrc = src => src && !src.startsWith('http') && !src.startsWith('/') && !src.startsWith('data:');
    const renderer = {
      code({ text, lang }) {
        if (lang === 'mermaid') {
          return `<div class="mermaid">${text}</div>`;
        }
        return false;
      },
      link({ href, title, text }) {
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        if (taskId && isRelativeSrc(href) && !href.startsWith('#') && !href.startsWith('mailto:')) {
          return `<a href="/api/tasks/${taskId}/file?path=${encodeURIComponent(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
        }
        return `<a href="${href}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
      image({ href, title, text }) {
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        const alt = text ? ` alt="${escapeHtml(text)}"` : '';
        const src = (taskId && isRelativeSrc(href))
          ? `/api/tasks/${taskId}/file?path=${encodeURIComponent(href)}`
          : href;
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
      const reset = () => {
        fitScale = mermaidModal._fitScale || 1;
        scale = fitScale; tx = 0; ty = 0;
        applyTransform();
      };

      viewport.addEventListener('wheel', e => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          // 触控板双指捏合 → 缩放
          const delta = e.deltaY < 0 ? 0.1 : -0.1;
          scale = Math.min(8, Math.max(0.2, +(scale + delta).toFixed(2)));
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
            scale = Math.min(8, Math.max(0.2, +(scale * dist / lastTouchDist).toFixed(3)));
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

  function renderSidebar() {
    const nav = document.getElementById('task-nav');
    const scrollTop = nav.scrollTop;
    nav.innerHTML = '';

    const localSection = document.createElement('div');
    localSection.className = 'local-sidebar-section';
    localSection.dataset.engineKey = 'local';
    nav.appendChild(localSection);

    const localHeading = document.createElement('div');
    localHeading.className = 'sidebar-section-heading';
    localHeading.innerHTML = '<span>本地任务</span><span class="sidebar-section-count">' + tasks.length + '</span>';
    localSection.appendChild(localHeading);

    const grouped = {};
    STATUS_ORDER.forEach(s => grouped[s] = []);
    tasks.forEach(t => { if (grouped[t.status]) grouped[t.status].push(t); });

    STATUS_ORDER.forEach(status => {
      const group = grouped[status];

      const groupEl = document.createElement('div');
      groupEl.className = 'task-group';
      groupEl.dataset.status = status;

      const headerEl = document.createElement('div');
      headerEl.className = 'task-group-header';

      const toggleEl = document.createElement('span');
      toggleEl.className = `task-group-toggle${collapsedGroups[status] ? ' collapsed' : ''}`;
      toggleEl.textContent = '▾';

      const labelEl = document.createElement('span');
      labelEl.textContent = STATUS_LABEL[status];

      headerEl.appendChild(toggleEl);
      headerEl.appendChild(labelEl);

      const itemsEl = document.createElement('div');
      itemsEl.className = `task-group-items${collapsedGroups[status] ? ' collapsed' : ''}`;
      itemsEl.dataset.status = status;

      group.forEach(task => itemsEl.appendChild(buildNavItem(task)));

      // 拖拽放置到组（空组也能接收）
      itemsEl.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const draggingEl = document.querySelector('.task-nav-item.dragging');
        if (!draggingEl) return;
        // 确保 placeholder 存在
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
        const targetStatus = itemsEl.dataset.status;
        const items = [...itemsEl.querySelectorAll('.task-nav-item')];
        const afterEl = placeholder ? placeholder.nextElementSibling : null;
        let newIndex = afterEl ? items.indexOf(afterEl) : items.length;
        if (newIndex < 0) newIndex = items.length;
        placeholder && placeholder.remove();
        onDrop(id, targetStatus, newIndex);
      });

      headerEl.addEventListener('click', () => {
        const c = itemsEl.classList.toggle('collapsed');
        toggleEl.classList.toggle('collapsed', c);
        collapsedGroups[status] = c;
      });

      groupEl.appendChild(headerEl);
      groupEl.appendChild(itemsEl);
      localSection.appendChild(groupEl);
    });

    nav.scrollTop = scrollTop;
    if (window.RemoteTasks) window.RemoteTasks.render();
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
    if (!task) return;

    // 更新 status
    if (task.status !== targetStatus) {
      await API.put(`/api/tasks/${id}`, { status: targetStatus });
    }

    // 重新计算目标组内的 sort_order
    const groupTasks = tasks
      .filter(t => t.id !== id && t.status === targetStatus)
      .sort((a, b) => a.sort_order - b.sort_order);
    groupTasks.splice(newIndex, 0, { ...task, status: targetStatus });
    const reorderBody = groupTasks.map((t, i) => ({ id: t.id, sort_order: i }));
    await API.put('/api/tasks/reorder', reorderBody);

    await Tasks.load();
  }

  function buildNavItem(task) {
    const item = document.createElement('div');
    item.className = `task-nav-item${task.id === selectedId ? ' active' : ''}`;
    item.dataset.id = task.id;
    item.draggable = true;

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

    const statusBtn = document.createElement('button');
    statusBtn.className = `task-status-btn ${task.status}`;
    if (task.status === 'doing') statusBtn.textContent = '●';
    else if (task.status === 'done') statusBtn.textContent = '✓';
    else if (task.status === 'personal') statusBtn.textContent = '★';
    statusBtn.title = `点击切换状态（当前：${STATUS_LABEL[task.status]}）`;
    statusBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await API.put(`/api/tasks/${task.id}`, { status: STATUS_NEXT[task.status] });
      await Tasks.load();
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

    // 终端状态圆点
    const dotEl = document.createElement('span');
    dotEl.className = 'term-dot';
    const state = termState.get(task.id);
    if (state === 'running') dotEl.classList.add('running');
    else if (state === 'done') dotEl.classList.add('done');
    item.appendChild(dotEl);

    const due = formatDue(task.due_date);
    if (due) {
      const dueEl = document.createElement('span');
      dueEl.className = `task-nav-due${due.overdue ? ' overdue' : ''}`;
      dueEl.textContent = due.text;
      item.appendChild(dueEl);
    }

    item.addEventListener('click', () => selectTask(task.id));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ContextMenu.show(e.clientX, e.clientY, [
        { label: '标记为进行中', action: () => setStatus(task.id, 'doing') },
        { label: '标记为待办', action: () => setStatus(task.id, 'todo') },
        { label: '标记为已完成', action: () => setStatus(task.id, 'done') },
        { label: '标记为个人任务', action: () => setStatus(task.id, 'personal') },
        { separator: true },
        { label: '编辑', action: () => showEditModal(task) },
        { label: '删除', danger: true, action: () => deleteTask(task.id) },
      ]);
    });

    return item;
  }

  async function setStatus(id, status) {
    await API.put(`/api/tasks/${id}`, { status });
    await Tasks.load();
  }

  async function deleteTask(id) {
    if (!confirm('确认删除该任务？')) return;
    await API.delete(`/api/tasks/${id}`);
    if (selectedId === id) {
      selectedId = null;
      showEmpty();
    }
    await Tasks.load();
  }

  function selectTask(id) {
    if (selectedId !== id && !confirmDiscardEditor()) return;
    // 离开旧任务的 shell tab 时补设 done
    if (selectedId && selectedId !== id && activeTab === 'shell') {
      onLeaveShellTab(selectedId);
    }
    selectedId = id;
    if (window.RemoteTasks) {
      window.RemoteTasks.setActiveEngine('local', { selectContent: false });
      window.RemoteTasks.clearSelection();
    }
    localStorage.setItem('selectedTaskId', id);
    document.querySelectorAll('.task-nav-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.id) === id);
    });
    // 恢复该任务上次停留的 tab
    const tab = getTaskTab(id);
    activeTab = tab;
    contentTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'shell') {
      const task = tasks.find(t => t.id === id);
      contentToolbar.style.visibility = 'visible';
      contentToolbar.style.pointerEvents = '';
      contentToolbar.style.display = task && task.md_path ? 'flex' : 'none';
      setEditButtonState(false);
      previewPane.style.display = 'none';
      document.getElementById('toc-pane').style.display = 'none';
      terminalPane.style.display = 'flex';
      // 切到终端时清除"执行完成待查看"状态
      if (termState.get(id) === 'done') updateTermDot(id, 'idle');
    } else {
      previewPane.style.display = '';
      terminalPane.style.display = 'none';
    }
    const task = tasks.find(t => t.id === id);
    if (task) {
      if (tab === 'shell') {
        connectTerminal(task);
        const inst = termInstances.get(task.id);
        if (inst) setTimeout(() => inst.term.focus(), 0);
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
      document.getElementById('btn-share-md').style.display = task.md_path ? '' : 'none';
      setEditButtonState(false);
      await renderTodos(task);
      return;
    }

    contentToolbar.style.visibility = 'visible';
    contentToolbar.style.pointerEvents = '';
    const isTechnical = activeTab === 'doc';
    const hasDocumentRoot = isTechnical ? Boolean(task.md_path) : Boolean(task.work_dir || task.md_path);
    contentToolbar.style.display = hasDocumentRoot ? 'flex' : 'none';
    document.getElementById('btn-share-md').style.display = isTechnical && task.md_path ? '' : 'none';
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

    await loadMdContent(task, activeTab);
    startWatcher(task, activeTab);
  }

  function setEditButtonState(enabled) {
    const button = document.getElementById('btn-edit-md');
    button.disabled = !enabled;
    button.title = enabled ? '在页面中编辑当前 Markdown' : '当前页面不是可编辑的 Markdown';
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
      const res = await fetch(`/api/tasks/${task.id}/document/${kind}`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) throw new Error('文档读取失败');
      const source = await res.text();
      if (selectedId !== task.id || activeTab !== tab) return;
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
      const modelUri = monaco.Uri.parse(`inmemory://task/${task.id}/${kind}.md`);
      const existingModel = monaco.editor.getModel(modelUri);
      if (existingModel) existingModel.dispose();
      const model = monaco.editor.createModel(source, 'markdown', modelUri);
      const editor = monaco.editor.create(document.getElementById('md-editor-host'), {
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
      editorState = { task, tab, kind, editor, model, source, dirty: false, saving: false };
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveDocumentEditor);
      editor.onDidChangeModelContent(() => {
        if (!editorState) return;
        editorState.dirty = model.getValue() !== source;
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
      await API.put(`/api/tasks/${state.task.id}/document/${state.kind}`, { content: state.model.getValue() });
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
      const todos = await API.get(`/api/tasks/${task.id}/todos`);
      if (selectedId !== renderForId || activeTab !== 'todos') return;
      const completedCount = todos.filter(todo => todo.completed).length;
      content.innerHTML = `
        <section class="todo-page">
          <div class="todo-heading">
            <div>
              <h2>待办清单</h2>
              <p>${todos.length ? `已完成 ${completedCount} / ${todos.length}` : '记录这个任务接下来要做的事情'}</p>
            </div>
          </div>
          <form class="todo-add-form" id="todo-add-form">
            <input id="todo-new-content" type="text" maxlength="500" autocomplete="off" placeholder="添加一项待办，按 Enter 保存">
            <button type="submit">添加</button>
          </form>
          <div class="todo-list" id="todo-list">
            ${todos.length ? todos.map(todo => `
              <div class="todo-item${todo.completed ? ' completed' : ''}" data-todo-id="${todo.id}">
                <label class="todo-check-wrap" title="${todo.completed ? '标记为未完成' : '标记为已完成'}">
                  <input class="todo-check" type="checkbox" ${todo.completed ? 'checked' : ''}>
                  <span class="todo-checkmark"></span>
                </label>
                <span class="todo-content" title="双击编辑">${escapeHtml(todo.content)}</span>
                <button class="todo-delete" type="button" title="删除待办">×</button>
              </div>`).join('') : '<div class="todo-empty">还没有待办事项</div>'}
          </div>
        </section>`;

      const form = document.getElementById('todo-add-form');
      const input = document.getElementById('todo-new-content');
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        input.disabled = true;
        try {
          await API.post(`/api/tasks/${task.id}/todos`, { content: value });
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
            await API.put(`/api/tasks/${task.id}/todos/${todoId}`, { completed: checkbox.checked });
            await renderTodos(task);
          } catch (e) {
            checkbox.checked = !checkbox.checked;
            alert('更新待办失败: ' + e.message);
          }
        });
        label.addEventListener('dblclick', () => editTodoInline(task, todoId, label));
        item.querySelector('.todo-delete').addEventListener('click', async () => {
          try {
            await API.delete(`/api/tasks/${task.id}/todos/${todoId}`);
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
        await API.put(`/api/tasks/${task.id}/todos/${todoId}`, { content });
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
    return tab === 'readme' ? 'README.md' : tab === 'agent' ? 'AGENT.md' : '技术方案';
  }

  async function loadMdContent(task, tab = activeTab) {
    const content = document.getElementById('preview-content');
    const savedScroll = parseInt(localStorage.getItem(`mdScroll_${task.id}_${tab}`)) || 0;
    const scrollTop = previewPane.scrollTop || savedScroll;
    // 记录本次渲染时的目标任务，异步回来后校验是否仍是当前任务/tab，防止竞态更新 UI
    const renderForId = task.id;
    const renderForTab = tab;

    try {
      const kind = documentKind(tab);
      const res = await fetch(`/api/tasks/${task.id}/document/${kind}`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (selectedId !== renderForId || activeTab !== renderForTab) return;
      if (res.status === 404) {
        setEditButtonState(false);
        const canCreate = tab === 'readme' || tab === 'agent';
        content.innerHTML = `
          <div class="document-empty">
            <p>${escapeHtml(documentLabel(tab))} 不存在</p>
            ${canCreate ? `<button class="document-create-btn" id="document-create-btn">创建 ${escapeHtml(documentLabel(tab))}</button>` : ''}
          </div>`;
        if (canCreate) {
          document.getElementById('document-create-btn').addEventListener('click', async () => {
            try {
              await API.post(`/api/tasks/${task.id}/document/${documentKind(tab)}`, {});
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
      if (selectedId !== renderForId || activeTab !== renderForTab) return;
      content.innerHTML = renderMd(text, task.id);
      for (const script of Array.from(content.querySelectorAll('script'))) {
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
        try {
          await mermaid.run({ nodes: [node] });
        } catch (e) {
          node.innerHTML = `<pre style="color:#c0392b;font-size:12px;white-space:pre-wrap">⚠️ Mermaid 渲染失败：${e.message || e.str || '语法错误'}</pre>`;
        }
      }
      wrapMermaidDiagrams(content);
      addHeadingIds(content);
      buildToc(content);
      setupScrollSpy(content);
      previewPane.scrollTop = scrollTop;
    } catch (e) {
      console.error('[loadMdContent] error:', e);
      content.innerHTML = '<div class="preview-loading">加载失败，请检查文件路径是否有效</div>';
    }
  }

  function startWatcher(task, tab = activeTab) {
    stopWatcher();
    const watchedTab = tab;
    mdWatcher = new EventSource(`/api/tasks/${task.id}/document/${documentKind(tab)}/watch`);
    mdWatcher.onmessage = (e) => {
      if (e.data === 'changed' && activeTab === watchedTab) loadMdContent(task, watchedTab);
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
        a.href = `/api/tasks/${taskId}/file?path=${encodeURIComponent(a.getAttribute('href'))}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });
    container.querySelectorAll('img[src]').forEach(img => {
      if (isRelative(img.getAttribute('src'))) {
        img.src = `/api/tasks/${taskId}/file?path=${encodeURIComponent(img.getAttribute('src'))}`;
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
    const storageKey = `toc-collapsed-${selectedId}`;
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
    empty.querySelector('span').textContent = '← 选择左侧任务查看详情';
    document.getElementById('preview-content').style.display = 'none';
    contentToolbar.style.display = 'none';
    contentTabs.style.display = 'none';
    terminalPane.style.display = 'none';
    previewPane.style.display = '';
    hideToc();
    stopWatcher();
  }

  function buildTaskForm(task = {}) {
    const remoteServers = !task.id && window.RemoteTasks ? RemoteTasks.getServers() : [];
    const activeEngineKey = !task.id && window.RemoteTasks ? RemoteTasks.getActiveEngineKey() : 'local';
    const enginePicker = task.id ? '' : `
      <div class="form-group">
        <label class="form-label">所属 Engine</label>
        <select class="form-input" id="f-engine">
          <option value="local" ${activeEngineKey === 'local' ? 'selected' : ''}>本地 Engine</option>
          ${remoteServers.map(server => `<option value="remote:${server.id}" ${activeEngineKey === `remote:${server.id}` && server.status === 'online' ? 'selected' : ''} ${server.status !== 'online' ? 'disabled' : ''}>${escapeHtml(server.name)}${server.status === 'online' ? '' : '（离线）'}</option>`).join('')}
        </select>
        <div class="form-hint" id="f-engine-hint">任务和工作目录将保存在所选 Engine 上</div>
      </div>`;
    return `
      ${enginePicker}
      <div class="form-group">
        <label class="form-label">标题</label>
        <input class="form-input" id="f-title" type="text" value="${escapeHtml(task.title || '')}" placeholder="任务标题（可由 MD 文件名自动填充）">
      </div>
      <div class="form-group">
        <label class="form-label">MD 文件路径</label>
        <input class="form-input" id="f-md-path" type="text" value="${escapeHtml(task.md_path || '')}" placeholder="/path/to/file.md">
        <div class="form-hint" id="f-md-hint"></div>
      </div>
      <div class="form-group">
        <label class="form-label">工作路径</label>
        <input class="form-input" id="f-work-dir" type="text" value="${escapeHtml(task.work_dir || '')}" placeholder="自动取 MD 文件所在目录">
        <div class="form-hint">打开终端时使用此路径</div>
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
        <div class="form-radio-group">
          <label><input type="radio" name="status-group" value="" ${(!task.status || task.status !== 'personal') ? 'checked' : ''}> 工作任务</label>
          <label><input type="radio" name="status-group" value="personal" ${task.status === 'personal' ? 'checked' : ''}> 个人任务</label>
        </div>
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
    const engineInput = document.getElementById('f-engine');
    const engineHint = document.getElementById('f-engine-hint');

    function isRemoteTarget() {
      return engineInput && engineInput.value.startsWith('remote:');
    }

    if (engineInput) {
      engineInput.addEventListener('change', () => {
        const remote = isRemoteTarget();
        engineHint.textContent = remote
          ? '路径指向远程 Engine 的文件系统；留空可由 Engine 自动创建'
          : '任务和工作目录将保存在本地 Engine 上';
        mdHint.textContent = remote && mdInput.value.trim() ? '路径将在远程 Engine 创建时校验' : '';
        mdHint.className = 'form-hint';
        mdInput.classList.remove('error');
      });
    }

    mdInput.addEventListener('blur', async () => {
      const val = mdInput.value.trim();
      if (!val) { mdHint.textContent = ''; mdHint.className = 'form-hint'; return; }
      if (isRemoteTarget()) {
        mdHint.textContent = '路径将在远程 Engine 创建时校验';
        mdHint.className = 'form-hint';
        mdInput.classList.remove('error');
        return;
      }
      try {
        const result = await API.post('/api/tasks/validate-path', { md_path: val });
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
      const title = titleInput.value.trim();
      const md_path = mdInput.value.trim() || null;
      const work_dir = workDirInput.value.trim() || null;
      const priority = document.querySelector('input[name="priority"]:checked')?.value || 'normal';
      const due_date = document.getElementById('f-due-date').value || null;
      const statusGroupVal = document.querySelector('input[name="status-group"]:checked')?.value;
      // personal 分组直接用 'personal' 状态；工作任务新建默认 todo，编辑时保留原状态（除非原来是 personal）
      let status;
      if (statusGroupVal === 'personal') {
        status = 'personal';
      } else if (existingTask.id) {
        status = existingTask.status === 'personal' ? 'todo' : undefined;
      } else {
        status = 'todo';
      }

      if (!title && !md_path) {
        titleInput.classList.add('error');
        return;
      }
      titleInput.classList.remove('error');

      try {
        if (existingTask.id) {
          await API.put(`/api/tasks/${existingTask.id}`, { title: title || undefined, md_path, work_dir, priority, due_date, ...(status !== undefined ? { status } : {}) });
          Modal.hide();
          await Tasks.load();
          if (selectedId === existingTask.id) {
            const updated = tasks.find(t => t.id === existingTask.id);
            if (updated) renderPreview(updated);
          }
        } else {
          const payload = { title: title || undefined, md_path, work_dir, priority, due_date, status };
          if (isRemoteTarget()) {
            const serverId = Number(engineInput.value.slice('remote:'.length));
            await RemoteTasks.createTask(serverId, payload);
            Modal.hide();
          } else {
            const newTask = await API.post('/api/tasks', payload);
            Modal.hide();
            tasks = await API.get('/api/tasks');
            renderSidebar();
            // 自动选中新建的任务，会正确触发 renderPreview，处理 TOC 显隐
            selectTask(newTask.id);
          }
        }
      } catch (e) {
        alert('操作失败: ' + e.message);
      }
    });
  }

  function showEditModal(task) {
    Modal.show('编辑任务', buildTaskForm(task));
    setupFormEvents(task);
  }

  document.getElementById('btn-new-task').addEventListener('click', () => {
    Modal.show('新建任务', buildTaskForm());
    setupFormEvents();
  });

  return {
    async load() {
      tasks = await API.get('/api/tasks');
      const cached = parseInt(localStorage.getItem('selectedTaskId'));
      if (cached && tasks.find(t => t.id === cached)) {
        selectedId = cached;
      }
      renderSidebar();
      const localActive = !window.RemoteTasks || RemoteTasks.getActiveEngineKey() === 'local';
      if (!localActive) return;
      if (selectedId) {
        const task = tasks.find(t => t.id === selectedId);
        if (task) renderPreview(task);
        else { selectedId = null; localStorage.removeItem('selectedTaskId'); showEmpty(); }
      }
    },
    clearSelection() {
      selectedId = null;
      stopWatcher();
      document.querySelectorAll('.task-nav-item').forEach(el => el.classList.remove('active'));
    },
    activateLocal() {
      const cached = parseInt(localStorage.getItem('selectedTaskId'));
      const task = tasks.find(item => item.id === cached) || tasks[0];
      if (task) selectTask(task.id);
      else showEmpty();
    },
  };
})();

window.Tasks = Tasks;
