// 界面语言切换：英文（默认）/ 中文。源码里的界面文字保持中文，英文模式下由本模块翻译：
//   1. 用 MutationObserver 翻译 DOM 里的文本节点和 title / placeholder / aria-label 等属性（静态 HTML 与 JS 动态渲染的内容都覆盖）；
//   2. 包装 alert / confirm / prompt；
//   3. 暴露 I18n.t() 给直接写入终端等非 DOM 输出使用。
// 词典见 i18n-en-*.js（I18n.add({ 中文: 'English' })）。未收录的文字原样显示。切换语言会刷新页面，保证所有动态内容按新语言重新渲染。
// 用户内容（Markdown 文档、终端、编辑器、任务/文件名等）不翻译：放在 SKIP 选择器或 translate="no" 里。
(() => {
  const KEY = 'ta-lang';
  const LANGS = ['en', 'zh'];
  const HAS_DOM = typeof document !== 'undefined';
  const HAN = /[一-鿿]/;
  const readStored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  let lang = LANGS.includes(readStored()) ? readStored() : 'en';

  const dict = new Map();
  const patterns = [];
  let phraseRegex = null;
  const cache = new Map();

  function add(entries) {
    for (const [zh, en] of Object.entries(entries)) dict.set(zh, en);
    phraseRegex = null;
    cache.clear();
  }
  // 需要调整语序的模板句：regex 命中整句时用 render(match) 生成英文
  function addPattern(regex, render) { patterns.push([regex, render]); cache.clear(); }

  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function getPhraseRegex() {
    if (!phraseRegex) {
      const keys = [...dict.keys()].filter(key => key.length > 1 && HAN.test(key)).sort((a, b) => b.length - a.length);
      phraseRegex = keys.length ? new RegExp(keys.map(escapeRegex).join('|'), 'g') : /(?!)/g;
    }
    return phraseRegex;
  }

  const PUNCT = { '，': ', ', '。': '. ', '：': ': ', '；': '; ', '、': ', ', '？': '? ', '！': '! ', '（': ' (', '）': ') ', '“': '"', '”': '"', '「': '"', '」': '"', '‘': "'", '’': "'", '《': '"', '》': '"' };

  function translatePhrases(core) {
    let replaced = false;
    let out = core.replace(getPhraseRegex(), (match, offset, whole) => {
      replaced = true;
      let value = dict.get(match);
      const before = whole[offset - 1];
      // 句中的词不保留首字母大写（句首、冒号/句号/换行之后保留）
      const lead = whole.slice(0, offset).replace(/[ \t]+$/, '');
      if (/^[A-Z][a-z]/.test(value) && lead && !/[：。！？:.!?\n>]$/.test(lead)) value = value[0].toLowerCase() + value.slice(1);
      const after = whole[offset + match.length];
      if (value && before && /[\w一-鿿)\]%]/.test(before)) value = ` ${value}`;
      if (value && after && /[\w一-鿿(\[]/.test(after)) value = `${value} `;
      return value;
    });
    if (!replaced) return core;
    out = out.replace(/[，。：；、？！（）“”「」‘’《》]/g, ch => PUNCT[ch]);
    return out.replace(/ {2,}/g, ' ').replace(/\( +/g, '(').replace(/ +([,.;:?!)])/g, '$1').replace(/([,.;:?!]) +$/g, '$1');
  }

  function translateCore(core) {
    if (dict.has(core)) return dict.get(core);
    for (const [regex, render] of patterns) {
      const match = regex.exec(core);
      if (match) { const result = render(match, translateCore); if (typeof result === 'string') return result; }
    }
    return translatePhrases(core);
  }

  function t(text) {
    if (lang !== 'en' || typeof text !== 'string' || !HAN.test(text)) return text;
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const result = lead + translateCore(core) + tail;
    if (cache.size > 2000) cache.clear();
    cache.set(text, result);
    return result;
  }

  function set(next) {
    if (!LANGS.includes(next) || next === lang) return;
    try { localStorage.setItem(KEY, next); } catch { /* 隐私模式下无法记住，刷新后回到默认英文 */ }
    if (HAS_DOM) location.reload();
    lang = next;
  }

  const api = { t, add, addPattern, set, get: () => lang, toggle: () => set(lang === 'en' ? 'zh' : 'en'), languages: () => LANGS.slice() };

  if (HAS_DOM) {
    const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip', 'alt'];
    const SKIP = 'script,style,.xterm,.monaco-editor,.markdown-body,.md-code-block,.file-tree-name,.task-nav-title,.quicklinks-chip,.todo-content,#terminal-history-text,[translate="no"]';
    const skipped = el => !!(el && el.closest && el.closest(SKIP));

    const fixText = node => {
      const value = node.nodeValue;
      if (!value || !HAN.test(value) || node.parentNode.nodeName === 'TEXTAREA' || skipped(node.parentElement)) return;
      const next = t(value);
      if (next !== value) node.nodeValue = next;
    };
    const fixAttrs = el => {
      if (!el.getAttribute || skipped(el)) return;
      for (const name of ATTRS) {
        const value = el.getAttribute(name);
        if (value && HAN.test(value)) { const next = t(value); if (next !== value) el.setAttribute(name, next); }
      }
    };
    const walk = root => {
      if (root.nodeType === 3) return fixText(root);
      if (root.nodeType !== 1 || skipped(root)) return;
      fixAttrs(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: node => (node.nodeType === 1 && node.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === 3) fixText(node); else fixAttrs(node);
      }
    };

    // 切换按钮：显示"另一种语言"的名字（名字本身不翻译）
    const wireToggles = () => {
      document.querySelectorAll('[data-lang-toggle]').forEach(button => {
        button.setAttribute('translate', 'no');
        const label = lang === 'en' ? '中文' : 'English';
        const text = `${button.dataset.langIcon || ''}${label}`;
        if (button.textContent !== text) button.textContent = text;
        button.title = lang === 'en' ? 'Switch to Chinese / 切换为中文' : 'Switch to English / 切换为英文';
        if (!button.dataset.langBound) { button.dataset.langBound = '1'; button.addEventListener('click', () => api.toggle()); }
      });
    };

    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    if (lang === 'en') {
      // 在解析阶段就开始观察，页面第一次绘制前基本已经是英文
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'childList') record.addedNodes.forEach(walk);
          else if (record.type === 'characterData') fixText(record.target);
          else if (record.type === 'attributes') fixAttrs(record.target);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
      for (const fn of ['alert', 'confirm', 'prompt']) {
        const original = window[fn];
        if (typeof original === 'function') window[fn] = (message, ...rest) => original.call(window, t(String(message === undefined ? '' : message)), ...rest);
      }
    }
    const ready = () => { if (lang === 'en') walk(document.documentElement); wireToggles(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
  }

  if (typeof window !== 'undefined') window.I18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
