const Tasks = (() => {
  let tasks = [];
  let selectedId = null;
  const STATUS_ORDER = ['doing', 'todo', 'done'];
  const STATUS_LABEL = { doing: '进行中', todo: '待办', done: '已完成' };
  const STATUS_NEXT = { todo: 'doing', doing: 'done', done: 'todo' };
  const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' };
  const collapsedGroups = {};
  let tocObserver = null;
  let mdWatcher = null;

  // ── Tab & Terminal state ──
  let activeTab = 'doc';   // 'doc' | 'shell'

  function getTaskTab(id) {
    return localStorage.getItem(`task-tab-${id}`) || 'doc';
  }
  function saveTaskTab(id, tab) {
    localStorage.setItem(`task-tab-${id}`, tab);
  }
  let term = null;
  let fitAddon = null;
  let termWs = null;
  let termTaskId = null;   // 当前终端绑定的 taskId

  mermaid.initialize({ startOnLoad: false, theme: 'default' });

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
    activeTab = tab;
    if (selectedId) saveTaskTab(selectedId, tab);
    contentTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'doc') {
      // 离开 shell tab → 补设 done
      if (selectedId) onLeaveShellTab(selectedId);
      previewPane.style.display = '';
      terminalPane.style.display = 'none';
      const task = tasks.find(t => t.id === selectedId);
      if (task) renderPreview(task);
    } else {
      previewPane.style.display = 'none';
      document.getElementById('toc-pane').style.display = 'none';
      terminalPane.style.display = 'flex';
      // 切到终端时清除"执行完成待查看"状态
      if (selectedId && termState.get(selectedId) === 'done') updateTermDot(selectedId, 'idle');
      const task = tasks.find(t => t.id === selectedId);
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

  function connectTerminal(task) {
    const container = document.getElementById('xterm-container');

    // 已有实例且 ws 活着：直接显示，不重连
    if (termInstances.has(task.id)) {
      const inst = termInstances.get(task.id);
      if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
        // 隐藏所有，显示当前
        termInstances.forEach((i, id) => i.el.style.display = id === task.id ? '' : 'none');
        term = inst.term;
        fitAddon = inst.fitAddon;
        termWs = inst.ws;
        termTaskId = task.id;
        setTimeout(() => { inst.fitAddon.fit(); inst.term.focus(); }, 0);
        return;
      }
      // ws 断了，清理旧实例
      inst.ws && inst.ws.close();
      inst.term.dispose();
      inst.el.remove();
      termInstances.delete(task.id);
    }

    // 隐藏其他任务的终端
    termInstances.forEach(i => i.el.style.display = 'none');

    // 为当前任务创建新 Terminal 实例
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

    termTaskId = task.id;
    term = t;
    fitAddon = fa;

    let paused = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/terminal/ws?taskId=${task.id}`);
    termWs = ws;

    const inst = { term: t, fitAddon: fa, ws, el };
    termInstances.set(task.id, inst);

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      fa.fit();
      t.focus();
      ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && e.data.startsWith('{"type":"history"')) {
        try {
          const msg = JSON.parse(e.data);
          paused = true;
          t.write(msg.data, () => {
            // 等 xterm 处理完所有 ANSI 序列（含 DA response）再解除暂停
            // 双 rAF 确保当前帧渲染完毕后再开放输入，避免 DA response 漏入 shell
            requestAnimationFrame(() => requestAnimationFrame(() => { paused = false; }));
          });
        } catch { t.write(e.data); }
        return;
      }
      if (e.data instanceof ArrayBuffer) {
        t.write(new Uint8Array(e.data));
      } else {
        t.write(e.data);
        onTermData(task.id, e.data);
      }
    };

    ws.onclose = () => {
      if (termInstances.get(task.id)?.ws === ws) {
        t.write('\r\n\x1b[31m[连接已断开，切换任务可重新连接]\x1b[0m\r\n');
      }
    };

    ws.onerror = () => {
      t.write('\r\n\x1b[31m[WebSocket 连接失败]\x1b[0m\r\n');
    };

    t.onData(data => {
      if (paused) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    t.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

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

  let scrollSaveTimer = null;
  previewPane.addEventListener('scroll', () => {
    if (!selectedId) return;
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      localStorage.setItem(`mdScroll_${selectedId}`, previewPane.scrollTop);
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

    const grouped = {};
    STATUS_ORDER.forEach(s => grouped[s] = []);
    tasks.forEach(t => { if (grouped[t.status]) grouped[t.status].push(t); });

    STATUS_ORDER.forEach(status => {
      const group = grouped[status];

      const groupEl = document.createElement('div');
      groupEl.className = 'task-group';

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

      group.forEach(task => itemsEl.appendChild(buildNavItem(task)));

      headerEl.addEventListener('click', () => {
        const c = itemsEl.classList.toggle('collapsed');
        toggleEl.classList.toggle('collapsed', c);
        collapsedGroups[status] = c;
      });

      groupEl.appendChild(headerEl);
      groupEl.appendChild(itemsEl);
      nav.appendChild(groupEl);
    });

    nav.scrollTop = scrollTop;
  }

  function buildNavItem(task) {
    const item = document.createElement('div');
    item.className = `task-nav-item${task.id === selectedId ? ' active' : ''}`;
    item.dataset.id = task.id;

    const statusBtn = document.createElement('button');
    statusBtn.className = `task-status-btn ${task.status}`;
    if (task.status === 'doing') statusBtn.textContent = '●';
    else if (task.status === 'done') statusBtn.textContent = '✓';
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
    // 离开旧任务的 shell tab 时补设 done
    if (selectedId && selectedId !== id && activeTab === 'shell') {
      onLeaveShellTab(selectedId);
    }
    selectedId = id;
    localStorage.setItem('selectedTaskId', id);
    document.querySelectorAll('.task-nav-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.id) === id);
    });
    // 恢复该任务上次停留的 tab
    const tab = getTaskTab(id);
    activeTab = tab;
    contentTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'shell') {
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

    contentToolbar.style.display = task.md_path ? 'flex' : 'none';
    contentTabs.style.display = 'flex';

    if (!task.md_path) {
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

    await loadMdContent(task);
    startWatcher(task);
  }

  async function loadMdContent(task) {
    const content = document.getElementById('preview-content');
    const savedScroll = parseInt(localStorage.getItem(`mdScroll_${task.id}`)) || 0;
    const scrollTop = previewPane.scrollTop || savedScroll;
    // 记录本次渲染时的目标任务，异步回来后校验是否仍是当前任务/tab，防止竞态更新 UI
    const renderForId = task.id;

    try {
      const res = await fetch(`/api/tasks/${task.id}/md`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      // 异步回来后检查：若已切换任务或切换到 shell，丢弃本次结果
      if (selectedId !== renderForId || activeTab !== 'doc') return;
      if (!res.ok) throw new Error('Failed');
      const text = await res.text();
      if (selectedId !== renderForId || activeTab !== 'doc') return;
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
          try { new Function(script.textContent)(); } catch (e) { console.warn('script error:', e); }
        }
      }
      await mermaid.run({ nodes: content.querySelectorAll('.mermaid') });
      addHeadingIds(content);
      buildToc(content);
      setupScrollSpy(content);
      previewPane.scrollTop = scrollTop;
    } catch (e) {
      content.innerHTML = '<div class="preview-loading">加载失败，请检查文件路径是否有效</div>';
    }
  }

  function startWatcher(task) {
    stopWatcher();
    mdWatcher = new EventSource(`/api/tasks/${task.id}/md/watch`);
    mdWatcher.onmessage = (e) => {
      if (e.data === 'changed') loadMdContent(task);
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
    document.getElementById('preview-empty').style.display = 'flex';
    document.getElementById('preview-content').style.display = 'none';
    contentToolbar.style.display = 'none';
    contentTabs.style.display = 'none';
    terminalPane.style.display = 'none';
    previewPane.style.display = '';
    hideToc();
    stopWatcher();
  }

  function buildTaskForm(task = {}) {
    return `
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

    mdInput.addEventListener('blur', async () => {
      const val = mdInput.value.trim();
      if (!val) { mdHint.textContent = ''; mdHint.className = 'form-hint'; return; }
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

      if (!title && !md_path) {
        titleInput.classList.add('error');
        return;
      }
      titleInput.classList.remove('error');

      try {
        if (existingTask.id) {
          await API.put(`/api/tasks/${existingTask.id}`, { title: title || undefined, md_path, work_dir, priority, due_date });
          Modal.hide();
          await Tasks.load();
          if (selectedId === existingTask.id) {
            const updated = tasks.find(t => t.id === existingTask.id);
            if (updated) renderPreview(updated);
          }
        } else {
          const newTask = await API.post('/api/tasks', { title: title || undefined, md_path, work_dir, priority, due_date });
          Modal.hide();
          tasks = await API.get('/api/tasks');
          renderSidebar();
          // 自动选中新建的任务，会正确触发 renderPreview，处理 TOC 显隐
          selectTask(newTask.id);
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
      if (selectedId) {
        const task = tasks.find(t => t.id === selectedId);
        if (task) renderPreview(task);
        else { selectedId = null; localStorage.removeItem('selectedTaskId'); showEmpty(); }
      }
    },
  };
})();
