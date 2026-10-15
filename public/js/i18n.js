// UI language switch: English (default) / Chinese.
// All source text is English. When Chinese is selected, this module translates it:
//   1. a MutationObserver translates DOM text nodes and title / placeholder / aria-label ... attributes
//      (static HTML, content rendered later by JS, and toasts are all covered);
//   2. alert / confirm / prompt are wrapped;
//   3. I18n.t() is available for text that does not go through the DOM (terminal output, downloads).
// Dictionaries live in i18n-zh-*.js as I18n.add({ 'English text': '<Chinese text>' }). A key may contain {1}, {2} ... placeholders
// for the variable parts of a sentence; the same placeholders appear in the Chinese value and may be reordered.
// Text without an entry is shown unchanged. Switching the language reloads the page so everything is rendered again.
// User content (Markdown documents, terminals, the editor, task / file names ...) is never translated: it is excluded by
// the SKIP selector below or by translate="no".
(() => {
  const KEY = 'ta-lang';
  const LANGS = ['en', 'zh'];
  const HAS_DOM = typeof document !== 'undefined';
  const LETTER = /[A-Za-z]/;
  const readStored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  let lang = LANGS.includes(readStored()) ? readStored() : 'en';

  const exact = new Map();
  const templates = []; // { regex, slots, value, weight }
  const cache = new Map();
  const norm = text => text.replace(/\s+/g, ' ');
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function add(entries) {
    for (const [source, target] of Object.entries(entries)) {
      const key = norm(source).trim();
      if (!/\{\d+\}/.test(key)) { exact.set(key, target); continue; }
      const slots = [];
      const parts = key.split(/(\{\d+\})/);
      // A template with almost no fixed text (such as "{1}s" for a duration) must only match numbers, otherwise it would
      // also match unrelated words ("docs" -> "doc" + "s").
      const weight = parts.reduce((sum, part) => sum + (/^\{\d+\}$/.test(part) ? 0 : part.trim().length), 0);
      const capture = weight < 4 ? '(\\d+(?:\\.\\d+)?)' : '([\\s\\S]*?)';
      const pattern = parts.map(part => {
        const slot = /^\{(\d+)\}$/.exec(part);
        if (slot) { slots.push(slot[1]); return capture; }
        return escapeRegex(part);
      }).join('');
      templates.push({ regex: new RegExp(`^${pattern}$`), slots, value: target, weight });
    }
    templates.sort((a, b) => b.weight - a.weight);
    cache.clear();
  }

  function translateCore(core, depth) {
    const hit = exact.get(core);
    if (hit !== undefined) return hit;
    if (depth > 2) return core;
    for (const template of templates) {
      const match = template.regex.exec(core);
      if (!match) continue;
      return template.value.replace(/\{(\d+)\}/g, (all, number) => {
        const index = template.slots.indexOf(number);
        return index < 0 ? all : translateCore(match[index + 1].trim(), depth + 1);
      });
    }
    // "A · B · C" is assembled from separately translatable parts (status lines, version labels ...).
    if (core.includes(' \u00b7 ')) {
      const parts = core.split(' \u00b7 ');
      const translated = parts.map(part => translateCore(part, depth + 1));
      if (translated.some((part, index) => part !== parts[index])) return translated.join(' \u00b7 ');
    }
    return core;
  }

  function t(text) {
    if (lang !== 'zh' || typeof text !== 'string' || !LETTER.test(text)) return text;
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const translated = translateCore(norm(core), 0);
    const result = translated === norm(core) ? text : lead + translated + tail;
    if (cache.size > 3000) cache.clear();
    cache.set(text, result);
    return result;
  }

  function set(next) {
    if (!LANGS.includes(next) || next === lang) return;
    try { localStorage.setItem(KEY, next); } catch { /* private mode: not remembered, the next load falls back to English */ }
    if (HAS_DOM) location.reload();
    lang = next;
  }

  const api = { t, add, set, get: () => lang, toggle: () => set(lang === 'en' ? 'zh' : 'en'), languages: () => LANGS.slice() };

  if (HAS_DOM) {
    const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip', 'alt'];
    const SKIP = 'script,style,.xterm,.monaco-editor,.markdown-body,.md-code-block,.file-tree-name,.task-nav-title,.quicklinks-chip,.todo-content,#terminal-history-text,[translate="no"]';
    const skipped = el => !!(el && el.closest && el.closest(SKIP));

    const fixText = node => {
      const value = node.nodeValue;
      if (!value || !LETTER.test(value) || node.parentNode.nodeName === 'TEXTAREA' || skipped(node.parentElement)) return;
      const next = t(value);
      if (next !== value) node.nodeValue = next;
    };
    const fixAttrs = el => {
      if (!el.getAttribute || skipped(el)) return;
      for (const name of ATTRS) {
        const value = el.getAttribute(name);
        if (value && LETTER.test(value)) { const next = t(value); if (next !== value) el.setAttribute(name, next); }
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

    // Toggle buttons show the name of the OTHER language (the names themselves are never translated).
    const wireToggles = () => {
      document.querySelectorAll('[data-lang-toggle]').forEach(button => {
        button.setAttribute('translate', 'no');
        const text = `${button.dataset.langIcon || ''}${lang === 'en' ? '\u4e2d\u6587' : 'English'}`;
        if (button.textContent !== text) button.textContent = text;
        button.title = lang === 'en' ? 'Switch to Chinese' : '\u5207\u6362\u4e3a\u82f1\u6587 (Switch to English)';
        if (!button.dataset.langBound) { button.dataset.langBound = '1'; button.addEventListener('click', () => api.toggle()); }
      });
    };

    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    if (lang === 'zh') {
      // Observe while the document is still being parsed, so the first paint is already in Chinese.
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
    const ready = () => { if (lang === 'zh') walk(document.documentElement); wireToggles(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
  }

  if (typeof window !== 'undefined') window.I18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
