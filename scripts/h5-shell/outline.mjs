// The outline of a Markdown document in the file sheet (scripts/h5-shell/Design.jsx): the h1-h3 headings of the rendered document, each with a stable,
// unique id, and the heading of the section being read. Headings are taken from the rendered DOM, so a `#` line inside a code block is never one.

export const OUTLINE_LEVELS = 'h1, h2, h3';
export const ID_PREFIX = 'h5-doc-'; // keeps a heading's id apart from the page's own ids (a heading "h5 design body" cannot take `h5-design-body`)

// A slug for any language: letters, digits and marks of every script are kept (Chinese, Cyrillic, accents ...), spaces become `-`, other characters go.
export function slugify(text) {
  const slug = String(text || '').normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]+/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'section';
}

// Unique ids in document order: the second "Notes" is `notes-1`, the third `notes-2`; a suffix that another heading already uses is skipped.
export function uniqueIds(texts, prefix = ID_PREFIX) {
  const used = new Set();
  return texts.map(text => {
    const base = `${prefix}${slugify(text)}`;
    let id = base;
    for (let n = 1; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return id;
  });
}

// Gives every h1-h3 of `root` an id and returns the outline: [{ id, level, text }]. Headings inside a code block or a diagram are left out.
export function buildOutline(root) {
  const headings = [...root.querySelectorAll(OUTLINE_LEVELS)].filter(node => !node.closest('pre, code, .mermaid, .md-code-block'));
  const texts = headings.map(node => node.textContent.replace(/\s+/g, ' ').trim());
  const ids = uniqueIds(texts);
  return headings.map((node, i) => {
    node.id = ids[i];
    return { id: ids[i], level: Number(node.tagName.slice(1)), text: texts[i] || ids[i] };
  });
}

// The section being read: the last heading whose top (px from the top of the scrolling view) has reached `line`; before the first heading, the first.
// `tops` are in document order.
export function currentIndex(tops, line) {
  let index = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= line) index = i;
    else break;
  }
  return tops.length ? index : -1;
}
