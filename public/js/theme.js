// 主题切换：浅色 / 深色 / 未来科技。在 <head> 里同步加载，先于样式渲染设置 data-theme，避免闪烁。
const Theme = (() => {
  const KEY = 'ta-theme';
  const THEMES = [
    { id: 'light', label: '浅色', hint: '默认，适合白天', color: '#f6f8fa', monaco: 'vs', mermaid: 'default' },
    { id: 'dark', label: '深色', hint: '低亮度，护眼', color: '#161b22', monaco: 'vs-dark', mermaid: 'dark' },
    { id: 'tech', label: '未来科技', hint: '深空蓝底、霓虹青与光晕', color: '#050b1a', monaco: 'ta-tech', mermaid: 'dark' },
  ];
  const listeners = new Set();
  const find = id => THEMES.find(theme => theme.id === id);
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  let current = (find(read()) || THEMES[0]).id;

  function defineMonaco() {
    if (!window.monaco || Theme.monacoDefined) return;
    Theme.monacoDefined = true;
    monaco.editor.defineTheme('ta-tech', {
      base: 'vs-dark', inherit: true,
      rules: [{ token: 'comment', foreground: '5b7aa6', fontStyle: 'italic' }, { token: 'keyword', foreground: 'c792ff' }, { token: 'string', foreground: '7dffcf' }],
      colors: {
        'editor.background': '#07112a', 'editor.foreground': '#d6e6ff', 'editorLineNumber.foreground': '#3b5b8f',
        'editorLineNumber.activeForeground': '#00e5ff', 'editor.lineHighlightBackground': '#0c1d42',
        'editor.selectionBackground': '#00e5ff33', 'editorCursor.foreground': '#00e5ff', 'editorWidget.background': '#0a1630',
      },
    });
  }

  function apply() {
    const theme = find(current);
    document.documentElement.dataset.theme = theme.id;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.color);
    defineMonaco();
    if (window.monaco) { try { monaco.editor.setTheme(theme.monaco); } catch { /* 编辑器尚未创建 */ } }
    if (window.mermaid && typeof mermaid.initialize === 'function') {
      try { mermaid.initialize({ startOnLoad: false, theme: theme.mermaid, gantt: { useWidth: undefined }, locale: 'zh-CN' }); } catch { /* 之后渲染的图表使用新主题 */ }
    }
  }

  function set(id) {
    if (!find(id) || id === current) return;
    current = id;
    try { localStorage.setItem(KEY, id); } catch { /* 隐私模式下只在本次页面生效 */ }
    apply();
    listeners.forEach(listener => { try { listener(id); } catch { /* 忽略监听器错误 */ } });
  }

  document.documentElement.dataset.theme = current;
  return {
    list: () => THEMES,
    get: () => current,
    set,
    apply,
    monacoTheme: () => { defineMonaco(); return find(current).monaco; },
    mermaidTheme: () => find(current).mermaid,
    onChange: listener => listeners.add(listener),
  };
})();
window.Theme = Theme;
