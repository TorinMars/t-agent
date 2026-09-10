import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import nginx from 'highlight.js/lib/languages/nginx';

hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('nginx', nginx);

export function enhance(root) {
  const article = document.createElement('article');
  article.className = 'markdown-body';
  while (root.firstChild) article.append(root.firstChild);
  root.append(article);
  article.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    const source = code.textContent;
    const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || 'text';
    if (language === 'mermaid') {
      const diagram = document.createElement('div');
      diagram.className = 'mermaid';
      diagram.textContent = source;
      pre.replaceWith(diagram);
      return;
    }
    if (hljs.getLanguage(language)) {
      code.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
    }
    const card = document.createElement('div');
    card.className = 'md-code-block';
    const bar = document.createElement('div');
    bar.className = 'md-code-toolbar';
    const label = document.createElement('span');
    label.textContent = language;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制代码';
    copy.setAttribute('aria-label', '复制代码');
    copy.setAttribute('aria-live', 'polite');
    copy.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(source);
        } else {
          const field = document.createElement('textarea');
          field.value = source;
          field.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.append(field);
          field.select();
          try { if (!document.execCommand('copy')) throw new Error('Copy failed'); }
          finally { field.remove(); copy.focus(); }
        }
        copy.textContent = '已复制';
      } catch { copy.textContent = '复制失败，请手动选择'; }
      setTimeout(() => { copy.textContent = '复制代码'; }, 2000);
    });
    bar.append(label, copy);
    pre.replaceWith(card);
    card.append(bar, pre);
  });
  article.querySelectorAll('table').forEach(table => {
    const wrapper = document.createElement('div');
    wrapper.className = 'md-table-scroll';
    table.replaceWith(wrapper);
    wrapper.append(table);
  });
}
