const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function render(html, clipboard = {}) {
  const { document } = parseHTML(`<html><body><main>${html}</main></body></html>`);
  const context = vm.createContext({ document, navigator: { clipboard }, window: { isSecureContext: true }, setTimeout() {} });
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/markdown-view.js'), 'utf8'), context);
  context.MarkdownView.enhance(document.querySelector('main'));
  return document;
}

test('highlight preserves exact code, whitespace and escaped markup; copy uses original source', async () => {
  const source = 'const html = "<script>alert(1)</script>";\n\tconsole.log(html);\n';
  let copied;
  const doc = render(`<pre><code class="language-javascript">${source.replaceAll('<', '&lt;')}</code></pre>`, { async writeText(value) { copied = value; } });
  assert.equal(doc.querySelector('code').textContent, source);
  assert.ok(doc.querySelector('.hljs-keyword'));
  assert.equal(doc.querySelector('script'), null);
  doc.querySelector('button').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, source);
  assert.equal(doc.querySelector('button').textContent, '已复制');
});

test('unknown languages stay plain and Mermaid remains a diagram rather than a code card', () => {
  const doc = render('<pre><code class="language-custom">&lt;b&gt;hello&lt;/b&gt;</code></pre><pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre><table><tr><td>内容</td></tr></table>');
  assert.equal(doc.querySelector('code').textContent, '<b>hello</b>');
  assert.equal(doc.querySelector('code b'), null);
  assert.equal(doc.querySelectorAll('.md-code-block').length, 1);
  assert.equal(doc.querySelector('.mermaid').textContent, 'graph TD; A-->B;');
  assert.ok(doc.querySelector('.md-table-scroll table'));
});

test('copy failures are shown without breaking document rendering', async () => {
  const doc = render('<pre><code>example</code></pre>', { async writeText() { throw new Error('denied'); } });
  doc.querySelector('button').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector('button').textContent, '复制失败，请手动选择');
  assert.equal(doc.querySelector('code').textContent, 'example');
});
