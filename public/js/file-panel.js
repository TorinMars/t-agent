(function () {
  'use strict';

  const RATIO_KEY = 'file-panel-ratio';
  const TREE_WIDTH_KEY = 'file-panel-tree-width';
  const MIN_RATIO = 20;
  const MAX_RATIO = 90;
  const MIN_TREE_WIDTH = 180;
  const MAX_TREE_WIDTH = 620;
  const TEXT_HEADERS = { 'X-Requested-With': 'XMLHttpRequest' };
  const JSON_HEADERS = { ...TEXT_HEADERS, 'Content-Type': 'application/json' };

  let state = null;
  let requestGeneration = 0;
  let resizeObserver = null;

  const languageByExtension = {
    bat: 'bat', c: 'c', cc: 'cpp', cfg: 'ini', conf: 'ini', cpp: 'cpp',
    cs: 'csharp', css: 'css', csv: 'plaintext', cxx: 'cpp', dockerfile: 'dockerfile',
    env: 'ini', go: 'go', h: 'c', hpp: 'cpp', html: 'html', htm: 'html',
    ini: 'ini', java: 'java', js: 'javascript', cjs: 'javascript', mjs: 'javascript',
    json: 'json', jsonc: 'json', jsx: 'javascript', kt: 'kotlin', less: 'less',
    lua: 'lua', md: 'markdown', markdown: 'markdown', m: 'objective-c',
    php: 'php', pl: 'perl', py: 'python', r: 'r', rb: 'ruby', rs: 'rust',
    scss: 'scss', sh: 'shell', sql: 'sql', swift: 'swift', toml: 'ini',
    ts: 'typescript', tsx: 'typescript', txt: 'plaintext', vue: 'html',
    xml: 'xml', yaml: 'yaml', yml: 'yaml', zsh: 'shell',
  };

  function clamp(value, min, max, fallback) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function dirname(filePath) {
    const index = filePath.lastIndexOf('/');
    return index < 0 ? '' : filePath.slice(0, index);
  }

  function basename(filePath) {
    const index = filePath.lastIndexOf('/');
    return index < 0 ? filePath : filePath.slice(index + 1);
  }

  function joinPath(parent, name) {
    return parent ? `${parent}/${name}` : name;
  }

  function languageForPath(filePath) {
    const name = basename(filePath).toLowerCase();
    if (name === 'dockerfile') return 'dockerfile';
    if (name === 'makefile') return 'makefile';
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    return languageByExtension[extension] || 'plaintext';
  }

  function contextIsCurrent(contextKey, generation) {
    return Boolean(state && state.context.key === contextKey && state.generation === generation);
  }

  function stateIsCurrent(candidate) {
    return Boolean(candidate && state === candidate && contextIsCurrent(candidate.context.key, candidate.generation));
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: options.body ? JSON_HEADERS : TEXT_HEADERS,
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(errorMessage(payload.error, response.status));
      error.code = payload.error || `HTTP_${response.status}`;
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function errorMessage(code, status) {
    const messages = {
      FILES_UNSUPPORTED: '当前 Engine 版本不支持文件浏览，请更新后重试。',
      FILE_UNSUPPORTED: '该文件是二进制文件或使用了不支持的编码，无法编辑。',
      FILE_TOO_LARGE: '文件过大，无法在页面中编辑。',
      FILE_CONFLICT: '文件已在其他位置修改，请重新加载或确认强制保存。',
      FILE_EXISTS: '同名文件或文件夹已存在。',
      ROOT_PROTECTED: '不能修改工作目录根节点。',
    };
    return messages[code] || `请求失败（${status || '未知错误'}）`;
  }

  function createPanel(context) {
    const contentArea = document.querySelector('.content-area');
    if (!contentArea) throw new Error('找不到内容区域');
    document.getElementById('file-panel')?.remove();
    const ratio = clamp(localStorage.getItem(RATIO_KEY), MIN_RATIO, MAX_RATIO, 85);
    const treeWidth = clamp(localStorage.getItem(TREE_WIDTH_KEY), MIN_TREE_WIDTH, MAX_TREE_WIDTH, 280);
    contentArea.style.setProperty('--file-panel-ratio', `${ratio}%`);
    contentArea.style.setProperty('--file-panel-tree-width', `${treeWidth}px`);
    contentArea.classList.add('file-panel-open');
    const panel = document.createElement('section');
    panel.id = 'file-panel';
    panel.className = 'file-panel';
    panel.dataset.ratio = String(ratio);
    panel.setAttribute('aria-label', '文件浏览器');
    panel.innerHTML = `
      <div class="file-panel-header">
        <strong id="file-panel-title">${escapeHtml(context.title || '文件')}</strong>
        <span id="file-panel-root" class="file-panel-root">${escapeHtml(context.root || '')}</span>
        <div class="file-panel-actions" role="toolbar" aria-label="文件操作">
          <button type="button" id="file-panel-save" class="primary" title="保存当前文件 (Ctrl/Cmd+S)" disabled>保存</button>
          <button type="button" id="file-panel-new-file" title="新建文件">＋ 文件</button>
          <button type="button" id="file-panel-new-folder" title="新建文件夹">＋ 文件夹</button>
          <button type="button" id="file-panel-rename" title="重命名" disabled>重命名</button>
          <button type="button" id="file-panel-delete" class="danger" title="删除" disabled>删除</button>
          <button type="button" id="file-panel-toggle-hidden" aria-pressed="false" title="显示隐藏文件">显示隐藏文件</button>
          <button type="button" id="file-panel-refresh" title="刷新文件树">刷新</button>
          <button type="button" id="file-panel-close" class="file-panel-close" title="关闭文件面板" aria-label="关闭文件面板">×</button>
        </div>
      </div>
      <div class="file-panel-main">
        <aside class="file-tree-pane" aria-label="文件树">
          <div id="file-panel-tree" class="file-panel-tree" role="tree"></div>
        </aside>
        <div id="file-panel-splitter" class="file-panel-splitter" role="separator" aria-orientation="vertical" aria-label="调整文件树宽度"></div>
        <section class="file-editor-pane">
          <div id="file-panel-tabs" class="file-editor-tabs" role="tablist" aria-label="已打开文件"></div>
          <div id="file-panel-empty" class="file-panel-empty">从左侧选择文件开始编辑</div>
          <div id="file-panel-editor" class="file-panel-editor"></div>
          <div id="file-panel-status" class="file-panel-status" role="status"></div>
        </section>
      </div>
      <div id="file-panel-resizer" class="file-panel-resizer" role="separator" aria-orientation="horizontal" aria-label="调整文件面板高度"></div>
      <div id="file-panel-context-menu" class="file-panel-context-menu" hidden></div>
      <div id="file-panel-dialog-layer" class="file-panel-dialog-layer" hidden></div>`;
    const toolbar = contentArea.querySelector(':scope > .content-toolbar');
    if (toolbar && toolbar.nextSibling) contentArea.insertBefore(panel, toolbar.nextSibling);
    else contentArea.prepend(panel);
    bindPanelEvents(panel);
    contentArea.dispatchEvent(new CustomEvent('file-panel:layout', { detail: { open: true, ratio } }));
    return panel;
  }

  function bindPanelEvents(panel) {
    panel.querySelector('#file-panel-close').addEventListener('click', () => close());
    panel.querySelector('#file-panel-save').addEventListener('click', () => saveActiveFile());
    panel.querySelector('#file-panel-refresh').addEventListener('click', () => refreshTree());
    panel.querySelector('#file-panel-toggle-hidden').addEventListener('click', toggleHidden);
    panel.querySelector('#file-panel-new-file').addEventListener('click', () => showCreateDialog('file'));
    panel.querySelector('#file-panel-new-folder').addEventListener('click', () => showCreateDialog('directory'));
    panel.querySelector('#file-panel-rename').addEventListener('click', showRenameDialog);
    panel.querySelector('#file-panel-delete').addEventListener('click', showDeleteDialog);
    panel.querySelector('#file-panel-tree').addEventListener('click', onTreeClick);
    panel.querySelector('#file-panel-tree').addEventListener('contextmenu', onTreeContextMenu);
    panel.querySelector('#file-panel-tabs').addEventListener('click', onTabClick);
    panel.querySelector('#file-panel-context-menu').addEventListener('click', onContextMenuClick);
    document.addEventListener('pointerdown', hideContextMenu, true);
    bindResize(panel.querySelector('#file-panel-resizer'), 'height');
    bindResize(panel.querySelector('#file-panel-splitter'), 'tree');
    resizeObserver = new ResizeObserver(() => {
      applyPanelGeometry();
      state?.editor?.layout();
    });
    resizeObserver.observe(panel.parentElement);
  }

  function bindResize(handle, kind) {
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      const startX = event.clientX;
      const contentArea = state.panel.parentElement;
      const startWidth = state.panel.querySelector('.file-tree-pane').getBoundingClientRect().width;
      const move = moveEvent => {
        if (!state) return;
        if (kind === 'tree') {
          const width = clamp(startWidth + moveEvent.clientX - startX, MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, contentArea.clientWidth * 0.6), 280);
          contentArea.style.setProperty('--file-panel-tree-width', `${width}px`);
          localStorage.setItem(TREE_WIDTH_KEY, width);
        } else {
          const bounds = contentArea.getBoundingClientRect();
          const toolbar = contentArea.querySelector(':scope > .content-toolbar');
          const top = toolbar ? toolbar.getBoundingClientRect().bottom : bounds.top;
          const available = Math.max(1, bounds.bottom - top);
          const ratio = clamp(((moveEvent.clientY - top) / available) * 100, MIN_RATIO, MAX_RATIO, 85);
          state.ratio = ratio;
          contentArea.style.setProperty('--file-panel-ratio', `${ratio}%`);
          localStorage.setItem(RATIO_KEY, ratio);
          applyPanelGeometry();
          contentArea.dispatchEvent(new CustomEvent('file-panel:layout', { detail: { open: true, ratio } }));
        }
        state.editor?.layout();
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
    });
  }

  async function open(context) {
    if (!context || !context.key || !context.baseUrl) throw new Error('文件面板缺少 context.key 或 context.baseUrl');
    if (state && state.context.key !== context.key) {
      const canChange = await beforeContextChange();
      if (!canChange) return false;
    } else if (state) {
      state.panel.querySelector('#file-panel-title').textContent = context.title || '文件';
      return true;
    }
    const generation = ++requestGeneration;
    const panel = createPanel(context);
    state = {
      context: { ...context, baseUrl: context.baseUrl.replace(/\/$/, '') },
      generation,
      panel,
      writable: true,
      showHidden: false,
      directories: new Map(),
      tabs: new Map(),
      openingFiles: new Map(),
      activePath: null,
      selectedPath: '',
      editor: null,
      ratio: Number(panel.dataset.ratio) || 85,
    };
    applyPanelGeometry();
    setStatus('正在读取文件…');
    try {
      await loadDirectory('', true);
      return contextIsCurrent(context.key, generation);
    } catch (error) {
      if (contextIsCurrent(context.key, generation)) showPanelError(error.message);
      return false;
    }
  }

  async function loadDirectory(directoryPath, reset = false) {
    if (!state) return;
    const current = state;
    const existing = current.directories.get(directoryPath);
    const offset = reset ? 0 : (existing?.nextOffset ?? 0);
    if (!reset && existing && existing.nextOffset == null && existing.loaded) return;
    const params = new URLSearchParams({ path: directoryPath, offset: String(offset), hidden: String(current.showHidden) });
    const payload = await requestJson(`${current.context.baseUrl}?${params}`);
    if (!contextIsCurrent(current.context.key, current.generation)) return;
    const previousEntries = reset ? [] : (existing?.entries || []);
    current.directories.set(directoryPath, {
      entries: previousEntries.concat(Array.isArray(payload.entries) ? payload.entries : []),
      nextOffset: payload.nextOffset == null ? null : payload.nextOffset,
      loaded: true,
      expanded: directoryPath === '' ? true : (existing?.expanded ?? true),
    });
    current.writable = payload.writable !== false;
    if (payload.root != null) current.panel.querySelector('#file-panel-root').textContent = payload.root;
    setWritableControls();
    renderTree();
    setStatus('');
  }

  function sortedEntries(entries) {
    return [...entries].sort((left, right) => {
      if (left.type === 'directory' && right.type !== 'directory') return -1;
      if (left.type !== 'directory' && right.type === 'directory') return 1;
      return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
  }

  function renderTree() {
    if (!state) return;
    const tree = state.panel.querySelector('#file-panel-tree');
    const parts = [];
    appendDirectoryRows('', 0, parts);
    tree.innerHTML = parts.join('') || '<div class="file-tree-empty">此文件夹为空</div>';
  }

  function appendDirectoryRows(directoryPath, depth, parts) {
    const directory = state.directories.get(directoryPath);
    if (!directory) return;
    for (const entry of sortedEntries(directory.entries)) {
      const isDirectory = entry.type === 'directory';
      const child = state.directories.get(entry.path);
      const expanded = Boolean(child?.expanded);
      const selected = state.selectedPath === entry.path;
      const icon = isDirectory ? (expanded ? '▾' : '▸') : (entry.type === 'symlink' ? '↗' : '');
      parts.push(`<button type="button" class="file-tree-row${selected ? ' is-selected' : ''}" role="treeitem" data-path="${escapeHtml(entry.path)}" data-type="${escapeHtml(entry.type)}" style="--file-depth:${depth}"${isDirectory ? ` aria-expanded="${expanded}"` : ''}>
        <span class="file-tree-chevron">${icon}</span><span class="file-tree-icon" aria-hidden="true">${isDirectory ? '📁' : entry.type === 'file' ? '📄' : '◇'}</span><span class="file-tree-name">${escapeHtml(entry.name)}</span>
      </button>`);
      if (isDirectory && expanded) appendDirectoryRows(entry.path, depth + 1, parts);
      if (isDirectory && expanded && child?.nextOffset != null) {
        parts.push(`<button type="button" class="file-tree-more" data-load-more="${escapeHtml(entry.path)}" style="--file-depth:${depth + 1}">加载更多…</button>`);
      }
    }
    if (directoryPath === '' && directory.nextOffset != null) {
      parts.push('<button type="button" class="file-tree-more" data-load-more="" style="--file-depth:0">加载更多…</button>');
    }
  }

  async function onTreeClick(event) {
    const more = event.target.closest('[data-load-more]');
    if (more) {
      await loadDirectory(more.dataset.loadMore, false).catch(showOperationError);
      return;
    }
    const row = event.target.closest('.file-tree-row');
    if (!row) return;
    selectPath(row.dataset.path);
    if (row.dataset.type === 'directory') {
      const directory = state.directories.get(row.dataset.path);
      if (!directory) {
        await loadDirectory(row.dataset.path, true).catch(showOperationError);
      } else {
        directory.expanded = !directory.expanded;
        renderTree();
      }
      return;
    }
    if (row.dataset.type === 'file' || row.dataset.type === 'symlink') await openFile(row.dataset.path);
  }

  function selectPath(filePath) {
    state.selectedPath = filePath;
    setWritableControls();
    renderTree();
  }

  function setWritableControls() {
    if (!state) return;
    const hasSelection = Boolean(state.selectedPath);
    state.panel.querySelector('#file-panel-new-file').disabled = !state.writable;
    state.panel.querySelector('#file-panel-new-folder').disabled = !state.writable;
    state.panel.querySelector('#file-panel-save').disabled = !state.writable || !state.activePath;
    state.panel.querySelector('#file-panel-rename').disabled = !state.writable || !hasSelection;
    state.panel.querySelector('#file-panel-delete').disabled = !state.writable || !hasSelection;
  }

  async function openFile(filePath) {
    if (!state) return;
    if (state.tabs.has(filePath)) {
      activateTab(filePath);
      return;
    }
    if (state.openingFiles.has(filePath)) return state.openingFiles.get(filePath);
    const current = state;
    const opening = (async () => {
      setStatus(`正在打开 ${basename(filePath)}…`);
      try {
        const params = new URLSearchParams({ path: filePath });
        const payload = await requestJson(`${current.context.baseUrl}/content?${params}`);
        if (!contextIsCurrent(current.context.key, current.generation)) return;
        if (current.tabs.has(filePath)) {
          activateTab(filePath);
          return;
        }
        const language = languageForPath(payload.path || filePath);
        const uri = monaco.Uri.parse(modelUri(current.context.key, payload.path || filePath));
        monaco.editor.getModel(uri)?.dispose();
        const model = monaco.editor.createModel(payload.content || '', language, uri);
        const tab = {
          path: payload.path || filePath,
          model,
          savedContent: payload.content || '',
          revision: payload.revision,
          eol: payload.eol,
          bom: payload.bom,
          dirty: false,
          saving: false,
          savePromise: null,
        };
        tab.changeDisposable = model.onDidChangeContent(() => {
          tab.dirty = model.getValue() !== tab.savedContent;
          renderTabs();
          updateEditorStatus();
        });
        current.tabs.set(tab.path, tab);
        activateTab(tab.path);
        setStatus('');
      } catch (error) {
        if (!contextIsCurrent(current.context.key, current.generation)) return;
        showEditorError(error.message);
      } finally {
        if (current.openingFiles.get(filePath) === opening) current.openingFiles.delete(filePath);
      }
    })();
    current.openingFiles.set(filePath, opening);
    return opening;
  }

  function modelUri(contextKey, filePath) {
    return `inmemory://file-panel/${encodeURIComponent(contextKey)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  }

  function ensureEditor(model) {
    const host = state.panel.querySelector('#file-panel-editor');
    if (!state.editor) {
      state.editor = monaco.editor.create(host, {
        model,
        theme: 'vs',
        automaticLayout: true,
        fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 21,
        lineNumbers: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        renderWhitespace: 'selection',
        readOnly: !state.writable,
      });
      state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActiveFile());
    } else {
      state.editor.setModel(model);
      state.editor.updateOptions({ readOnly: !state.writable });
    }
    host.style.display = 'block';
    state.panel.querySelector('#file-panel-empty').style.display = 'none';
    requestAnimationFrame(() => {
      state?.editor?.layout();
      state?.editor?.focus();
    });
  }

  function activateTab(filePath) {
    const tab = state?.tabs.get(filePath);
    if (!tab) return;
    state.activePath = filePath;
    state.selectedPath = filePath;
    ensureEditor(tab.model);
    renderTabs();
    renderTree();
    updateEditorStatus();
    setWritableControls();
  }

  function renderTabs() {
    if (!state) return;
    const tabs = state.panel.querySelector('#file-panel-tabs');
    tabs.innerHTML = [...state.tabs.values()].map(tab => `<div class="file-editor-tab${tab.path === state.activePath ? ' is-active' : ''}${tab.dirty ? ' is-dirty' : ''}" role="tab" aria-selected="${tab.path === state.activePath}" data-tab-path="${escapeHtml(tab.path)}" title="${escapeHtml(tab.path)}">
      <button type="button" class="file-tab-select"><span class="file-tab-dirty" aria-hidden="true">●</span>${escapeHtml(basename(tab.path))}</button>
      <button type="button" class="file-tab-close" aria-label="关闭 ${escapeHtml(basename(tab.path))}" title="关闭">×</button>
    </div>`).join('');
  }

  async function onTabClick(event) {
    const element = event.target.closest('[data-tab-path]');
    if (!element) return;
    const filePath = element.dataset.tabPath;
    if (event.target.closest('.file-tab-close')) await requestCloseTab(filePath);
    else activateTab(filePath);
  }

  async function requestCloseTab(filePath) {
    const current = state;
    const tab = current?.tabs.get(filePath);
    if (!tab) return true;
    let action = 'clean';
    if (tab.dirty) {
      action = await showDirtyDialog([tab]);
      if (action === 'cancel') return false;
      if (action === 'save' && !(await saveTab(tab))) return false;
    }
    if (!stateIsCurrent(current) || current.tabs.get(filePath) !== tab) return false;
    if (action === 'save' && tab.dirty) return false;
    disposeTab(filePath);
    return true;
  }

  function disposeTab(filePath) {
    const current = state;
    const tab = current?.tabs.get(filePath);
    if (!tab) return;
    tab.changeDisposable?.dispose();
    tab.model.dispose();
    current.tabs.delete(filePath);
    if (current.activePath === filePath) {
      const next = [...current.tabs.keys()].at(-1) || null;
      current.activePath = next;
      if (next) activateTab(next);
      else showEmptyEditor();
    }
    renderTabs();
    setWritableControls();
  }

  function showEmptyEditor(message = '从左侧选择文件开始编辑') {
    if (!state) return;
    state.panel.querySelector('#file-panel-editor').style.display = 'none';
    const empty = state.panel.querySelector('#file-panel-empty');
    empty.className = 'file-panel-empty';
    empty.textContent = message;
    empty.style.display = '';
    state.panel.querySelector('#file-panel-status').textContent = '';
  }

  function showEditorError(message) {
    showEmptyEditor(message);
    state.panel.querySelector('#file-panel-empty').classList.add('is-error');
    setStatus(message, true);
  }

  async function saveActiveFile() {
    if (!state?.activePath) return false;
    return saveTab(state.tabs.get(state.activePath));
  }

  function saveTab(tab, force = false) {
    if (!state || !tab) return Promise.resolve(false);
    if (!state.writable) {
      setStatus('当前工作目录为只读，无法保存。', true);
      return Promise.resolve(false);
    }
    if (tab.saving) return tab.savePromise;
    if (!tab.dirty && !force) return Promise.resolve(true);
    const current = state;
    const submittedContent = tab.model.getValue();
    tab.saving = true;
    setStatus(`正在保存 ${basename(tab.path)}…`);
    tab.savePromise = (async () => {
      try {
        const body = { path: tab.path, content: submittedContent, revision: tab.revision };
        if (force) body.force = true;
        const payload = await requestJson(`${current.context.baseUrl}/content`, { method: 'PUT', body: JSON.stringify(body) });
        if (!contextIsCurrent(current.context.key, current.generation) || !current.tabs.has(tab.path)) return false;
        tab.revision = payload.revision;
        tab.savedContent = payload.content == null ? submittedContent : payload.content;
        tab.eol = payload.eol;
        tab.bom = payload.bom;
        if (tab.model.getValue() === submittedContent && payload.content != null && payload.content !== submittedContent) {
          tab.model.setValue(payload.content);
        }
        tab.dirty = tab.model.getValue() !== tab.savedContent;
        renderTabs();
        updateEditorStatus();
        setWritableControls();
        setStatus(`已保存 ${basename(tab.path)}`);
        current.panel.parentElement.dispatchEvent(new CustomEvent('file-panel:saved', {
          bubbles: true,
          detail: { contextKey: current.context.key, path: tab.path, revision: tab.revision },
        }));
        return true;
      } catch (error) {
        if (!contextIsCurrent(current.context.key, current.generation)) return false;
        if (error.code === 'FILE_CONFLICT' || error.status === 409) showConflictDialog(tab);
        else setStatus(`保存失败：${error.message}`, true);
        return false;
      } finally {
        tab.saving = false;
        tab.savePromise = null;
      }
    })();
    return tab.savePromise;
  }

  function updateEditorStatus() {
    if (!state?.activePath) return;
    const tab = state.tabs.get(state.activePath);
    state.panel.querySelector('#file-panel-status').textContent = tab.dirty ? '未保存' : '';
  }

  function showConflictDialog(tab) {
    showDialog(`
      <div class="file-panel-dialog" id="file-panel-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="file-conflict-title">
        <h3 id="file-conflict-title">文件已被修改</h3>
        <p>${escapeHtml(tab.path)} 在其他位置发生了变化。重新加载会丢弃当前草稿；强制保存会覆盖远端内容。</p>
        <div class="file-dialog-actions">
          <button type="button" data-conflict-action="cancel">取消</button>
          <button type="button" data-conflict-action="reload">重新加载</button>
          <button type="button" class="danger" data-conflict-action="force">确认强制保存</button>
        </div>
      </div>`, layer => {
      layer.querySelector('[data-conflict-action="cancel"]').addEventListener('click', hideDialog);
      layer.querySelector('[data-conflict-action="reload"]').addEventListener('click', async () => {
        hideDialog();
        await reloadTab(tab);
      });
      layer.querySelector('[data-conflict-action="force"]').addEventListener('click', async () => {
        hideDialog();
        await saveTab(tab, true);
      });
    });
  }

  async function reloadTab(tab) {
    if (!state || !state.tabs.has(tab.path)) return;
    const current = state;
    try {
      const payload = await requestJson(`${current.context.baseUrl}/content?${new URLSearchParams({ path: tab.path })}`);
      if (!contextIsCurrent(current.context.key, current.generation) || !current.tabs.has(tab.path)) return;
      tab.savedContent = payload.content || '';
      tab.revision = payload.revision;
      tab.eol = payload.eol;
      tab.bom = payload.bom;
      tab.model.setValue(tab.savedContent);
      tab.dirty = false;
      renderTabs();
      updateEditorStatus();
      setStatus(`已重新加载 ${basename(tab.path)}`);
    } catch (error) {
      setStatus(`重新加载失败：${error.message}`, true);
    }
  }

  async function refreshTree() {
    if (!state) return;
    const current = state;
    const expanded = [...current.directories.entries()].filter(([, value]) => value.expanded).map(([key]) => key);
    current.directories.clear();
    setStatus('正在刷新…');
    try {
      await loadDirectory('', true);
      if (!stateIsCurrent(current)) return;
      for (const directoryPath of expanded.filter(Boolean)) {
        await loadDirectory(directoryPath, true);
        if (!stateIsCurrent(current)) return;
      }
    } catch (error) {
      if (stateIsCurrent(current)) showOperationError(error);
    }
  }

  async function toggleHidden() {
    if (!state) return;
    const current = state;
    current.showHidden = !current.showHidden;
    const button = current.panel.querySelector('#file-panel-toggle-hidden');
    button.setAttribute('aria-pressed', String(current.showHidden));
    button.textContent = current.showHidden ? '隐藏隐藏文件' : '显示隐藏文件';
    await refreshTree();
  }

  function operationParent() {
    if (!state.selectedPath) return '';
    const entry = findEntry(state.selectedPath);
    return entry?.type === 'directory' ? entry.path : dirname(entry?.path || state.selectedPath);
  }

  function findEntry(filePath) {
    for (const directory of state.directories.values()) {
      const found = directory.entries.find(entry => entry.path === filePath);
      if (found) return found;
    }
    return null;
  }

  function showCreateDialog(type) {
    if (!state?.writable) return;
    const current = state;
    const parent = operationParent();
    showTextDialog(type === 'file' ? '新建文件' : '新建文件夹', '', async name => {
      const cleanName = validateName(name);
      await requestJson(current.context.baseUrl, {
        method: 'POST',
        body: JSON.stringify({ path: joinPath(parent, cleanName), type }),
      });
      if (!stateIsCurrent(current)) return;
      await loadDirectory(parent, true);
      if (!stateIsCurrent(current)) return;
      setStatus(`已创建 ${cleanName}`);
    });
  }

  function showRenameDialog() {
    if (!state?.selectedPath || !state.writable) return;
    const current = state;
    const oldPath = state.selectedPath;
    showTextDialog('重命名', basename(oldPath), async name => {
      const newPath = joinPath(dirname(oldPath), validateName(name));
      if (newPath === oldPath) return;
      const collision = findRenameCollision(current, oldPath, newPath);
      if (collision) throw new Error(`请先关闭已打开的目标文件 ${collision}`);
      const payload = await requestJson(current.context.baseUrl, {
        method: 'PATCH',
        body: JSON.stringify({ path: oldPath, newPath }),
      });
      if (!stateIsCurrent(current)) return;
      updatePathsAfterRename(oldPath, payload.path || newPath);
      await loadDirectory(dirname(oldPath), true);
      if (!stateIsCurrent(current)) return;
      setStatus(`已重命名为 ${basename(payload.path || newPath)}`);
    });
  }

  function findRenameCollision(current, oldPath, newPath) {
    const moving = new Set([...current.tabs.keys()].filter(filePath => filePath === oldPath || filePath.startsWith(`${oldPath}/`)));
    for (const filePath of moving) {
      const destination = newPath + filePath.slice(oldPath.length);
      if (current.tabs.has(destination) && !moving.has(destination)) return destination;
    }
    return null;
  }

  function validateName(name) {
    const clean = String(name || '').trim();
    if (!clean || clean === '.' || clean === '..' || clean.includes('/') || clean.includes('\\')) throw new Error('请输入不含路径分隔符的名称');
    return clean;
  }

  function updatePathsAfterRename(oldPath, newPath) {
    const replacePath = filePath => filePath === oldPath || filePath.startsWith(`${oldPath}/`)
      ? newPath + filePath.slice(oldPath.length)
      : filePath;
    const replacements = [...state.tabs.entries()].filter(([filePath]) => filePath === oldPath || filePath.startsWith(`${oldPath}/`));
    for (const [filePath, tab] of replacements) {
      const replacedPath = replacePath(filePath);
      const content = tab.model.getValue();
      const language = languageForPath(replacedPath);
      tab.changeDisposable?.dispose();
      tab.model.dispose();
      const uri = monaco.Uri.parse(modelUri(state.context.key, replacedPath));
      monaco.editor.getModel(uri)?.dispose();
      tab.model = monaco.editor.createModel(content, language, uri);
      tab.path = replacedPath;
      tab.changeDisposable = tab.model.onDidChangeContent(() => {
        tab.dirty = tab.model.getValue() !== tab.savedContent;
        renderTabs();
        updateEditorStatus();
      });
      state.tabs.delete(filePath);
      state.tabs.set(replacedPath, tab);
      if (state.activePath === filePath) {
        state.activePath = replacedPath;
        state.editor?.setModel(tab.model);
      }
    }
    for (const directory of state.directories.values()) {
      directory.entries = directory.entries.map(entry => {
        const replacedPath = replacePath(entry.path);
        return replacedPath === entry.path ? entry : {
          ...entry,
          path: replacedPath,
          name: entry.path === oldPath ? basename(newPath) : entry.name,
        };
      });
    }
    for (const [directoryPath, directory] of [...state.directories.entries()]) {
      if (directoryPath === oldPath || directoryPath.startsWith(`${oldPath}/`)) {
        state.directories.delete(directoryPath);
        state.directories.set(replacePath(directoryPath), directory);
      }
    }
    state.selectedPath = newPath;
    renderTabs();
    renderTree();
  }

  function showDeleteDialog() {
    if (!state?.selectedPath || !state.writable) return;
    const current = state;
    const target = state.selectedPath;
    const dirtyCount = [...state.tabs.values()].filter(tab => tab.dirty && (tab.path === target || tab.path.startsWith(`${target}/`))).length;
    showDialog(`
      <div class="file-panel-dialog" role="dialog" aria-modal="true" aria-labelledby="file-delete-title">
        <h3 id="file-delete-title">确认删除</h3>
        <p>将删除 ${escapeHtml(target)}${dirtyCount ? `，其中包含 ${dirtyCount} 个未保存草稿` : ''}。此操作无法撤销。</p>
        <div class="file-dialog-actions"><button type="button" data-delete-action="cancel">取消</button><button type="button" class="danger" data-delete-action="confirm">删除</button></div>
      </div>`, layer => {
      layer.querySelector('[data-delete-action="cancel"]').addEventListener('click', hideDialog);
      layer.querySelector('[data-delete-action="confirm"]').addEventListener('click', async () => {
        layer.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
          await requestJson(current.context.baseUrl, { method: 'DELETE', body: JSON.stringify({ path: target, recursive: true }) });
          if (!stateIsCurrent(current)) return;
          closeTabsUnder(target);
          clearCachedSubtree(current, target);
          current.selectedPath = '';
          hideDialog();
          await loadDirectory(dirname(target), true);
          if (!stateIsCurrent(current)) return;
          setStatus(`已删除 ${basename(target)}`);
        } catch (error) {
          if (!stateIsCurrent(current)) return;
          showDialogError(error.message);
          layer.querySelectorAll('button').forEach(button => { button.disabled = false; });
        }
      });
    });
  }

  function clearCachedSubtree(current, target) {
    for (const directoryPath of [...current.directories.keys()]) {
      if (directoryPath === target || directoryPath.startsWith(`${target}/`)) current.directories.delete(directoryPath);
    }
    for (const directory of current.directories.values()) {
      directory.entries = directory.entries.filter(entry => entry.path !== target && !entry.path.startsWith(`${target}/`));
    }
  }

  function closeTabsUnder(target) {
    for (const filePath of [...state.tabs.keys()]) {
      if (filePath === target || filePath.startsWith(`${target}/`)) disposeTab(filePath);
    }
  }

  function showTextDialog(title, initialValue, operation) {
    showDialog(`
      <form class="file-panel-dialog" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <label>名称<input id="file-dialog-name" value="${escapeHtml(initialValue)}" autocomplete="off"></label>
        <div class="file-dialog-error" role="alert"></div>
        <div class="file-dialog-actions"><button type="button" data-text-action="cancel">取消</button><button type="submit" class="primary">确定</button></div>
      </form>`, layer => {
      const form = layer.querySelector('form');
      layer.querySelector('[data-text-action="cancel"]').addEventListener('click', hideDialog);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const dialogState = state;
        const buttons = form.querySelectorAll('button');
        buttons.forEach(button => { button.disabled = true; });
        try {
          await operation(layer.querySelector('#file-dialog-name').value);
          if (stateIsCurrent(dialogState)) hideDialog();
        } catch (error) {
          if (!stateIsCurrent(dialogState)) return;
          showDialogError(error.message);
          buttons.forEach(button => { button.disabled = false; });
        }
      });
      requestAnimationFrame(() => layer.querySelector('#file-dialog-name').focus());
    });
  }

  function onTreeContextMenu(event) {
    const row = event.target.closest('.file-tree-row');
    if (!row || !state) return;
    event.preventDefault();
    selectPath(row.dataset.path);
    const menu = state.panel.querySelector('#file-panel-context-menu');
    menu.innerHTML = `<button type="button" data-menu-action="new-file">新建文件</button><button type="button" data-menu-action="new-folder">新建文件夹</button><button type="button" data-menu-action="rename">重命名</button><button type="button" class="danger" data-menu-action="delete">删除</button>`;
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.hidden = false;
  }

  function onContextMenuClick(event) {
    const action = event.target.closest('[data-menu-action]')?.dataset.menuAction;
    if (!action) return;
    hideContextMenu();
    if (action === 'new-file') showCreateDialog('file');
    if (action === 'new-folder') showCreateDialog('directory');
    if (action === 'rename') showRenameDialog();
    if (action === 'delete') showDeleteDialog();
  }

  function hideContextMenu(event) {
    const menu = state?.panel.querySelector('#file-panel-context-menu');
    if (!menu || (event?.target instanceof window.Element && event.target.closest('#file-panel-context-menu') === menu)) return;
    menu.hidden = true;
  }

  function showDialog(markup, bind) {
    if (!state) return;
    const layer = state.panel.querySelector('#file-panel-dialog-layer');
    layer.innerHTML = markup;
    layer.hidden = false;
    bind(layer);
  }

  function hideDialog() {
    const layer = state?.panel.querySelector('#file-panel-dialog-layer');
    if (!layer) return;
    layer.hidden = true;
    layer.innerHTML = '';
  }

  function showDialogError(message) {
    const error = state?.panel.querySelector('.file-dialog-error');
    if (error) error.textContent = message;
    else setStatus(message, true);
  }

  function showDirtyDialog(dirtyTabs) {
    return new Promise(resolve => {
      const names = dirtyTabs.slice(0, 3).map(tab => basename(tab.path)).join('、');
      const suffix = dirtyTabs.length > 3 ? ` 等 ${dirtyTabs.length} 个文件` : '';
      showDialog(`
        <div class="file-panel-dialog" id="file-panel-dirty-dialog" role="dialog" aria-modal="true" aria-labelledby="file-dirty-title">
          <h3 id="file-dirty-title">保存修改？</h3>
          <p>${escapeHtml(names)}${escapeHtml(suffix)} 有未保存的修改。</p>
          <div class="file-dialog-actions">
            <button type="button" data-dialog-action="cancel">取消</button>
            <button type="button" data-dialog-action="discard">放弃修改</button>
            <button type="button" class="primary" data-dialog-action="save">保存并继续</button>
          </div>
        </div>`, layer => {
        layer.querySelectorAll('[data-dialog-action]').forEach(button => button.addEventListener('click', () => {
          const action = button.dataset.dialogAction;
          hideDialog();
          resolve(action);
        }));
      });
    });
  }

  async function beforeContextChange() {
    if (!state) return true;
    const current = state;
    const dirtyTabs = [...current.tabs.values()].filter(tab => tab.dirty);
    if (dirtyTabs.length) {
      const action = await showDirtyDialog(dirtyTabs);
      if (action === 'cancel') return false;
      if (action === 'save') {
        for (const tab of dirtyTabs) {
          if (!(await saveTab(tab))) return false;
          if (tab.dirty) return false;
        }
        if ([...current.tabs.values()].some(tab => tab.dirty)) return false;
      }
    }
    if (state === current) closeImmediately();
    return true;
  }

  async function close() {
    return beforeContextChange();
  }

  function closeImmediately() {
    if (!state) return;
    const current = state;
    ++requestGeneration;
    hideDialog();
    resizeObserver?.disconnect();
    resizeObserver = null;
    current.editor?.dispose();
    for (const tab of current.tabs.values()) {
      tab.changeDisposable?.dispose();
      tab.model.dispose();
    }
    document.removeEventListener('pointerdown', hideContextMenu, true);
    const contentArea = current.panel.parentElement;
    current.panel.remove();
    contentArea.classList.remove('file-panel-open');
    contentArea.dispatchEvent(new CustomEvent('file-panel:layout', { detail: { open: false } }));
    state = null;
  }

  function applyPanelGeometry() {
    if (!state) return;
    const contentArea = state.panel.parentElement;
    const toolbar = contentArea.querySelector(':scope > .content-toolbar');
    const toolbarHeight = toolbar?.offsetHeight || 0;
    const available = contentArea.clientHeight - toolbarHeight;
    if (available <= 0) return;
    const desired = available * state.ratio / 100;
    const height = Math.max(0, Math.min(desired, Math.max(0, available - 70)));
    contentArea.style.setProperty('--file-panel-height', `${height}px`);
  }

  function showPanelError(message) {
    if (!state) return;
    state.panel.querySelector('#file-panel-tree').innerHTML = `<div class="file-tree-error">${escapeHtml(message)}<button type="button" id="file-panel-retry">重试</button></div>`;
    state.panel.querySelector('#file-panel-retry').addEventListener('click', refreshTree);
    setStatus(message, true);
  }

  function showOperationError(error) {
    setStatus(error.message || String(error), true);
  }

  function setStatus(message, isError = false) {
    if (!state) return;
    const status = state.panel.querySelector('#file-panel-status');
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  window.addEventListener('beforeunload', event => {
    if (!state || ![...state.tabs.values()].some(tab => tab.dirty)) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.FilePanel = Object.freeze({
    open,
    close,
    beforeContextChange,
    isOpen() { return Boolean(state); },
  });
})();
