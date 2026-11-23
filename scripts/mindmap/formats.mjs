// Other mind map and outline formats: Markdown, indented text and HTML lists (export, import and the clipboard), OPML, FreeMind / Freeplane (.mm), and the choice of
// a reader for an imported file. A file or a paste comes from outside, so it is handled as untrusted: size and topic limits first, only text goes into the document,
// links only through `safeLink`, and every result through `sanitizeDoc` (doc.mjs).
import { DocError, LIMITS, escapeHtml, newId, safeLink, sanitizeDoc } from './doc.mjs';
import { XmindError, emptyLost, escapeXml, iconsFor, looksLikeZip, parseXmind } from './xmind.mjs';

export class FormatError extends Error {}
export const TEXT_LIMIT = 8 * 1024 * 1024; // bytes of a text or XML file

const ARROW_DELTAS = () => ({ delta1: { x: 80, y: -40 }, delta2: { x: -80, y: -40 } }); // as for an XMind relationship: the file has no position for the curve
const oneLine = value => String(value == null ? '' : value).replace(/\s*[\r\n]+\s*/g, ' ');
const lineSplit = text => String(text).split(/\r\n|\r|\n/);
const isDone = node => Array.isArray(node.markers) && node.markers.includes('task-done');

// ---------- Export ----------

export function toOutlineText(nodes) {
  const lines = [];
  const walk = (node, depth) => { lines.push('\t'.repeat(depth) + oneLine(node.topic).trim()); (node.children || []).forEach(child => walk(child, depth + 1)); };
  (nodes || []).forEach(node => walk(node, 0));
  return lines.join('\n');
}

// Lines of a note that a reader would take for Markdown syntax get a backslash in front; parseOutline takes one leading backslash off every note line.
const BULLET = /^([ \t]*)([-*+\u2022\u25e6\u25aa\u2023\u2043\u25cf\u25cb\u25a0\u25a1]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const markdownLike = line => BULLET.test(line) || HEADING.test(line) || RULE.test(line) || FENCE.test(line) || QUOTE.test(line) || /^[ \t]*\\/.test(line);
const escapeNoteLine = line => (markdownLike(line) ? line.replace(/^([ \t]*)/, '$1\\') : line);
const unescapeNoteLine = line => line.replace(/^([ \t]*)\\/, '$1');

function markdownText(node) {
  const text = oneLine(node.topic).trim();
  const link = safeLink(node.hyperLink);
  if (!link) return text;
  const label = (text || link).replace(/[[\]\\]/g, ch => `\\${ch}`);
  return `[${label}](${link.replace(/[\s()<>]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`;
}

export function toMarkdown(nodes) {
  const list = nodes || [];
  const lines = [];
  const item = (node, level) => {
    const indent = '  '.repeat(level);
    lines.push(`${indent}- ${isDone(node) ? '[x] ' : ''}${markdownText(node)}`);
    if (node.note) for (const line of lineSplit(node.note)) lines.push(line.trim() ? `${indent}  ${escapeNoteLine(line)}` : '');
    (node.children || []).forEach(child => item(child, level + 1));
  };
  if (list.length === 1) {
    const [root] = list;
    lines.push(`# ${markdownText(root)}`);
    if (root.note) { lines.push(''); for (const line of lineSplit(root.note)) lines.push(line ? `> ${line}` : '>'); }
    if ((root.children || []).length) lines.push('');
    (root.children || []).forEach(child => item(child, 0));
  } else list.forEach(node => item(node, 0));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

export function toHtmlList(nodes) {
  const list = items => `<ul>${items.map(node => {
    const text = escapeHtml(oneLine(node.topic).trim());
    const link = safeLink(node.hyperLink);
    const body = link ? `<a href="${escapeHtml(link)}">${text || escapeHtml(link)}</a>` : text;
    return `<li>${body}${(node.children || []).length ? list(node.children) : ''}</li>`;
  }).join('')}</ul>`;
  return (nodes || []).length ? list(nodes) : '';
}

export function toOpml({ title, data }) {
  const outline = (node, depth) => {
    const pad = '  '.repeat(depth);
    let attrs = `text="${escapeXml(node.topic)}"`;
    if (node.note) attrs += ` _note="${escapeXml(node.note)}"`;
    const link = safeLink(node.hyperLink);
    if (link) attrs += ` url="${escapeXml(link)}"`;
    const children = node.children || [];
    if (!children.length) return `${pad}<outline ${attrs}/>`;
    return `${pad}<outline ${attrs}>\n${children.map(child => outline(child, depth + 1)).join('\n')}\n${pad}</outline>`;
  };
  const name = oneLine(title || (data.nodeData && data.nodeData.topic) || '').trim();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escapeXml(name, { attribute: false })}</title>\n  </head>\n  <body>\n${outline(data.nodeData, 2)}\n  </body>\n</opml>\n`;
}

// FreeMind 1.0.1, which Freeplane opens too. The map has no title of its own: the root topic is its name, so `title` is not written.
export function toFreeMind({ data }) {
  const ids = new Map();
  let next = 0;
  const idOf = node => { if (!ids.has(node.id)) ids.set(node.id, `ID_${1000000001 + (next += 1)}`); return ids.get(node.id); };
  const arrowsFrom = new Map();
  (function index(node) { idOf(node); (node.children || []).forEach(index); })(data.nodeData);
  for (const arrow of data.arrows || []) {
    if (!ids.has(arrow.from) || !ids.has(arrow.to)) continue;
    arrowsFrom.set(arrow.from, [...(arrowsFrom.get(arrow.from) || []), arrow]);
  }
  const write = (node, depth, firstLevel) => {
    const pad = '  '.repeat(depth);
    let attrs = `ID="${idOf(node)}" TEXT="${escapeXml(node.topic)}"`;
    if (firstLevel) attrs += ' POSITION="right"';
    const link = safeLink(node.hyperLink);
    if (link) attrs += ` LINK="${escapeXml(link)}"`;
    const children = node.children || [];
    if (node.expanded === false && children.length) attrs += ' FOLDED="true"';
    const inner = [];
    if (node.note) {
      const paragraphs = lineSplit(node.note).map(line => `<p>${escapeXml(line, { attribute: false })}</p>`).join('');
      inner.push(`${pad}  <richcontent TYPE="NOTE"><html><head/><body>${paragraphs}</body></html></richcontent>`);
    }
    for (const arrow of arrowsFrom.get(node.id) || []) {
      const label = arrow.label ? ` MIDDLE_LABEL="${escapeXml(arrow.label)}"` : '';
      inner.push(`${pad}  <arrowlink DESTINATION="${ids.get(arrow.to)}" STARTARROW="${arrow.bidirectional ? 'Default' : 'None'}" ENDARROW="Default"${label}/>`);
    }
    children.forEach(child => inner.push(write(child, depth + 1, depth === 0)));
    return inner.length ? `${pad}<node ${attrs}>\n${inner.join('\n')}\n${pad}</node>` : `${pad}<node ${attrs}/>`;
  };
  return `<map version="1.0.1">\n<!-- To view this file, download free mind mapping software FreeMind from http://freemind.sourceforge.net -->\n${write(data.nodeData, 0, false)}\n</map>\n`;
}

// ---------- Import ----------

function counter() {
  let count = 0;
  return depth => {
    if (depth > LIMITS.depth) throw new FormatError('This map is too deeply nested');
    count += 1;
    if (count > LIMITS.topics) throw new FormatError('This map has too many topics');
  };
}

const finish = raw => {
  try { return sanitizeDoc(raw); } catch (error) {
    if (error instanceof DocError) throw new FormatError(error.message);
    throw error;
  }
};

export function docFromNodes(nodes, fallbackTitle) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) throw new FormatError('This file has no topics in it');
  const nodeData = list.length === 1 ? list[0] : { id: newId(), topic: oneLine(fallbackTitle).trim() || 'Central Topic', children: list };
  return finish({ nodeData, arrows: [], summaries: [] });
}

// The text of one item: a Markdown link or a bare web address as a link, emphasis and code marks taken off.
function inlineTopic(raw) {
  let text = raw.trim();
  let hyperLink = '';
  const code = /^`([^`]+)`$/.exec(text);
  if (code) text = code[1].trim();
  const md = /^\[((?:\\.|[^\]\\])*)\]\(\s*<?([^\s<>]*?)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)$/.exec(text);
  const auto = /^<(https?:\/\/[^\s<>]+)>$/i.exec(text);
  if (md) {
    text = md[1].replace(/\\([[\]\\])/g, '$1').trim();
    hyperLink = safeLink(md[2]);
    if (!text) text = md[2];
  } else if (auto || /^https?:\/\/\S+$/i.test(text)) {
    text = auto ? auto[1] : text;
    hyperLink = safeLink(text);
  }
  if (!hyperLink || text !== hyperLink) {
    text = text.replace(/\*\*(?=\S)(.+?)\*\*/g, '$1').replace(/(^|[^\w])__(?=\S)(.+?)__(?!\w)/g, '$1$2').trim();
    const inner = /^`([^`]+)`$/.exec(text);
    if (inner) text = inner[1].trim();
  }
  return { text, hyperLink };
}

const columns = indent => [...indent].reduce((sum, ch) => sum + (ch === '\t' ? 4 : 1), 0); // a tab counts as 4 columns
// The line without up to `width` columns of its indent: a note keeps the indent it has beyond the item's text.
function dropIndent(line, width) {
  let i = 0;
  for (let used = 0; i < line.length && (line[i] === ' ' || line[i] === '\t'); i += 1) {
    used += line[i] === '\t' ? 4 : 1;
    if (used > width) break;
  }
  return line.slice(i);
}

// Lines as records, without front matter, fenced code, rules and blank lines (a blank line is kept as a count on the next record, for notes).
function scanLines(text) {
  const lines = lineSplit(String(text).replace(/^\ufeff/, ''));
  const records = [];
  let i = 0;
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    const end = lines.findIndex((line, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end > 0) i = end + 1;
  }
  let blanks = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+$/, '');
    if (!line.trim()) { blanks += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^[ \\t]*\\${fence[1][0]}{${fence[1].length},}[ \\t]*$`);
      for (i += 1; i < lines.length && !close.test(lines[i]); i += 1);
      continue;
    }
    if (/^[ \t]*<!--/.test(line)) { // an HTML comment of a Markdown file
      for (; i < lines.length && !lines[i].includes('-->'); i += 1);
      continue;
    }
    if (RULE.test(line)) continue;
    const indent = /^[ \t]*/.exec(line)[0];
    const col = columns(indent);
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const quote = QUOTE.exec(line);
    if (heading) records.push({ kind: 'heading', level: heading[1].length, text: (heading[2] || '').replace(/[ \t]+#+$/, ''), blanks });
    else if (bullet) records.push({ kind: 'bullet', col, textCol: col + bullet[2].length + Math.max(1, columns(bullet[3])), text: bullet[4], blanks });
    else if (quote) records.push({ kind: 'quote', col, text: quote[1], raw: line, blanks });
    else records.push({ kind: 'plain', col, text: line, blanks });
    blanks = 0;
  }
  return records;
}

function parseLines(text) {
  const records = scanLines(text);
  const bullets = records.some(r => r.kind === 'bullet');
  const headingLevels = records.filter(r => r.kind === 'heading').map(r => r.level);
  const minLevel = headingLevels.length ? Math.min(...headingLevels) : 1;
  const check = counter();
  const roots = [];
  const headings = []; // open headings: { rank, node, depth }
  let list = []; // open items under the current heading: { col, node, depth }
  let last = null; // the topic that a note line below would belong to, with how it got there
  let levels = 0;
  const add = (parent, node, depth) => {
    check(depth);
    levels = Math.max(levels, depth + 1);
    (parent ? parent.children : roots).push(node);
  };
  const addNote = (node, line, blanks) => {
    node.note = node.note === undefined ? line : `${node.note}${'\n'.repeat(blanks + 1)}${line}`;
  };
  for (const record of records) {
    if (record.kind === 'heading') {
      const { text: topic, hyperLink } = inlineTopic(record.text);
      if (!topic) { last = null; continue; }
      const rank = record.level - minLevel;
      while (headings.length && headings[headings.length - 1].rank >= rank) headings.pop();
      const parent = headings[headings.length - 1];
      const node = { id: newId(), topic, children: [], ...(hyperLink ? { hyperLink } : {}) };
      const depth = parent ? parent.depth + 1 : 0;
      add(parent && parent.node, node, depth);
      headings.push({ rank, node, depth });
      list = [];
      last = { node, kind: 'heading' };
      continue;
    }
    // A quote, or prose in a text that has bullets, right below a heading is that heading's note.
    if (last && last.kind === 'heading' && (record.kind === 'quote' || (record.kind === 'plain' && bullets && record.col < 4))) {
      addNote(last.node, record.kind === 'quote' ? record.text : record.text.trim(), last.node.note === undefined ? 0 : record.blanks);
      continue;
    }
    // A line below a list item, indented deeper than its bullet, continues that item as a note.
    if (bullets && record.kind !== 'bullet' && last && last.kind === 'item' && record.col > last.col) {
      const raw = record.kind === 'quote' ? record.raw : record.text;
      const line = unescapeNoteLine(dropIndent(raw, last.textCol));
      addNote(last.node, line, last.node.note === undefined ? 0 : record.blanks);
      continue;
    }
    const isBullet = record.kind === 'bullet';
    let body = isBullet ? record.text : record.text.trim();
    let markers;
    if (isBullet) {
      const task = /^\[([ xX])\](?:[ \t]+|$)(.*)$/.exec(body);
      if (task) { body = task[2]; if (task[1] !== ' ') markers = ['task-done']; }
    }
    const { text: topic, hyperLink } = inlineTopic(body);
    if (!topic) continue;
    while (list.length && list[list.length - 1].col > record.col) list.pop();
    if (list.length && list[list.length - 1].col === record.col) list.pop();
    const holder = list[list.length - 1] || headings[headings.length - 1];
    const node = { id: newId(), topic, children: [], ...(hyperLink ? { hyperLink } : {}), ...(markers ? { markers, icons: iconsFor(markers) } : {}) };
    const depth = holder ? holder.depth + 1 : 0;
    add(holder && holder.node, node, depth);
    list.push({ col: record.col, node, depth });
    last = { node, kind: isBullet ? 'item' : 'line', col: record.col, textCol: record.textCol };
  }
  return { nodes: roots, levels, marked: bullets || headingLevels.length > 0 };
}

export function parseOutline(text) {
  const { nodes, levels } = parseLines(text);
  return { nodes, levels };
}

// ---------- HTML lists (the clipboard of Notion, Google Docs, web pages) ----------

const SKIP = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'svg', 'head', 'title', 'meta', 'link']);
const LIST = new Set(['ul', 'ol']);
const nameOf = el => String(el.localName || el.nodeName || '').toLowerCase();

export function parseHtmlList(html, { parseHtml } = {}) {
  if (typeof parseHtml !== 'function') throw new FormatError('This file cannot be read as a mind map');
  const dom = parseHtml(String(html || ''));
  const top = dom && (dom.body || dom.documentElement);
  if (!top) return null;
  const lists = [];
  (function find(el) {
    for (const child of [...el.children]) {
      const name = nameOf(child);
      if (SKIP.has(name)) continue;
      if (LIST.has(name)) lists.push(child);
      else find(child);
    }
  })(top);
  if (!lists.length) return null;
  const check = counter();
  let levels = 0;
  // The own text and first link of a list item: its content without the nested lists.
  const ownContent = li => {
    let text = '';
    let link = '';
    (function walk(node) {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) text += child.nodeValue;
        else if (child.nodeType === 1) {
          const name = nameOf(child);
          if (SKIP.has(name) || LIST.has(name)) continue;
          if (name === 'br') { text += ' '; continue; }
          if (name === 'a' && !link && child.getAttribute('href')) link = child.getAttribute('href');
          walk(child);
          if (/^(p|div|h[1-6]|li|tr|summary|blockquote)$/.test(name)) text += ' ';
        }
      }
    })(li);
    return { text: text.replace(/\s+/g, ' ').trim(), link };
  };
  const nested = li => {
    const found = [];
    (function walk(node) {
      for (const child of [...node.children]) {
        const name = nameOf(child);
        if (SKIP.has(name)) continue;
        if (LIST.has(name)) found.push(child); else walk(child);
      }
    })(li);
    return found;
  };
  const readList = (listEl, depth) => {
    const out = [];
    for (const child of [...listEl.children]) {
      const name = nameOf(child);
      if (LIST.has(name)) { // a list right inside a list (Google Docs and older editors): the children of the item above it
        const kids = readList(child, depth + 1);
        const prev = out[out.length - 1];
        if (prev) prev.children.push(...kids); else out.push(...kids);
        continue;
      }
      if (name !== 'li') continue;
      const { text, link } = ownContent(child);
      const children = [];
      if (text) check(depth);
      for (const sub of nested(child)) children.push(...readList(sub, text ? depth + 1 : depth));
      if (!text) { out.push(...children); continue; }
      levels = Math.max(levels, depth + 1);
      const hyperLink = safeLink(link);
      out.push({ id: newId(), topic: text, children, ...(hyperLink ? { hyperLink } : {}) });
    }
    return out;
  };
  const nodes = lists.flatMap(list => readList(list, 0));
  return { nodes, levels };
}

// ---------- OPML and FreeMind ----------

const kids = (el, name) => [...el.children].filter(child => child.localName === name);
const firstKid = (el, name) => [...el.children].find(child => child.localName === name) || null;

function readXml(text, parseXml) {
  if (typeof parseXml !== 'function') throw new FormatError('This file cannot be read as a mind map');
  let dom;
  try { dom = parseXml(text); } catch { throw new FormatError('This file is damaged'); }
  const root = dom && dom.documentElement;
  if (!root || root.localName === 'parsererror' || dom.getElementsByTagName('parsererror').length) throw new FormatError('This file is damaged');
  return root;
}

function fromOpml(text, parseXml, fallbackTitle) {
  const root = readXml(text, parseXml);
  const head = firstKid(root, 'head');
  const headTitle = head && firstKid(head, 'title') ? oneLine(firstKid(head, 'title').textContent).trim() : '';
  const body = firstKid(root, 'body');
  const lost = emptyLost();
  const check = counter();
  const toTopic = (el, depth) => {
    check(depth);
    const node = { id: newId(), topic: el.getAttribute('text') || el.getAttribute('title') || '', children: [] };
    const note = el.getAttribute('_note');
    if (note) node.note = note;
    const url = el.getAttribute('url') || el.getAttribute('htmlUrl') || el.getAttribute('xmlUrl');
    if (url) { const link = safeLink(url); if (link) node.hyperLink = link; else lost.links += 1; }
    node.children = kids(el, 'outline').map(child => toTopic(child, depth + 1));
    return node;
  };
  const nodes = body ? kids(body, 'outline').map(el => toTopic(el, 0)) : [];
  return { doc: docFromNodes(nodes, headTitle || fallbackTitle), lost, headTitle };
}

// The text of FreeMind rich content (XHTML): one line per paragraph, the rest of the whitespace collapsed.
function richText(el) {
  const lines = [];
  let current = '';
  const flush = force => { if (force || current.trim()) lines.push(current.replace(/\s+/g, ' ').trim()); current = ''; };
  (function walk(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 || child.nodeType === 4) { current += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      const name = nameOf(child);
      if (name === 'head' || name === 'style' || name === 'script') continue;
      if (name === 'br') { flush(true); continue; }
      const block = /^(p|div|li|h[1-6]|tr|pre|blockquote)$/.test(name);
      if (block) flush(false);
      walk(child);
      if (block) flush(name === 'p');
    }
  })(el);
  flush(false);
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

function fromFreeMind(text, parseXml) {
  const root = readXml(text, parseXml);
  const first = firstKid(root, 'node');
  if (!first) throw new FormatError('This file has no topics in it');
  const lost = emptyLost();
  const check = counter();
  const idMap = new Map();
  const links = [];
  const toTopic = (el, depth) => {
    check(depth);
    const id = newId();
    const given = el.getAttribute('ID');
    if (given && !idMap.has(given)) idMap.set(given, id);
    const rich = kids(el, 'richcontent');
    const nodeHtml = rich.find(r => (r.getAttribute('TYPE') || '').toUpperCase() === 'NODE');
    const noteHtml = rich.find(r => (r.getAttribute('TYPE') || '').toUpperCase() === 'NOTE');
    const textAttr = el.getAttribute('TEXT');
    const node = { id, topic: textAttr !== null && textAttr !== '' ? textAttr : (nodeHtml ? richText(nodeHtml) : ''), children: [] };
    const note = noteHtml ? richText(noteHtml) : '';
    if (note) node.note = note;
    const href = el.getAttribute('LINK');
    if (href) { const link = safeLink(href); if (link) node.hyperLink = link; else lost.links += 1; }
    if (el.getAttribute('FOLDED') === 'true') node.expanded = false;
    for (const arrow of kids(el, 'arrowlink')) {
      const start = arrow.getAttribute('STARTARROW');
      const end = arrow.getAttribute('ENDARROW');
      links.push({ from: id, to: arrow.getAttribute('DESTINATION'), label: arrow.getAttribute('MIDDLE_LABEL') || '', bidirectional: !!start && start !== 'None' && !!end && end !== 'None' });
    }
    node.children = kids(el, 'node').map(child => toTopic(child, depth + 1));
    return node;
  };
  const nodeData = toTopic(first, 0);
  const arrows = links.filter(link => idMap.has(link.to)).map(link => ({ id: newId(), label: link.label, from: link.from, to: idMap.get(link.to), ...ARROW_DELTAS(), ...(link.bidirectional ? { bidirectional: true } : {}) }));
  return { doc: finish({ nodeData, arrows, summaries: [] }), lost };
}

// ---------- Choosing a reader ----------

function decodeText(bytes) {
  if (bytes.length > TEXT_LIMIT) throw new FormatError('This file is too large');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8: try the common Chinese encoding, then UTF-8 with replacements */ }
  try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

// The first element name of an XML text, past the declaration, comments and a doctype; '' when the text does not start with markup.
function firstTag(text) {
  const rest = text.replace(/^\ufeff/, '').replace(/^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '');
  if (!rest.startsWith('<')) return '';
  const m = /^<([A-Za-z][\w:.-]*)/.exec(rest);
  return m ? m[1].toLowerCase() : '<';
}

const baseName = name => String(name || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '').trim();
const titleOf = (...candidates) => candidates.map(value => oneLine(value).trim()).find(Boolean) || '';

export function importFile({ name, bytes, parseXml } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const fileTitle = baseName(name);
  if (looksLikeZip(data) || /\.xmind$/i.test(String(name || ''))) {
    const { doc, lost } = parseXmind(data, { parseXml }); // its XmindError messages reach the page as they are
    return { doc, lost, format: 'xmind', title: titleOf(doc.nodeData.topic, fileTitle) };
  }
  const text = decodeText(data);
  const tag = firstTag(text);
  if (tag === 'opml') {
    const { doc, lost, headTitle } = fromOpml(text, parseXml, fileTitle);
    return { doc, lost, format: 'opml', title: titleOf(headTitle, doc.nodeData.topic, fileTitle) };
  }
  if (tag === 'map') {
    const { doc, lost } = fromFreeMind(text, parseXml);
    return { doc, lost, format: 'freemind', title: titleOf(doc.nodeData.topic, fileTitle) };
  }
  if (tag) throw new FormatError('This file cannot be read as a mind map');
  const { nodes, marked } = parseLines(text);
  const doc = docFromNodes(nodes, fileTitle);
  return { doc, lost: emptyLost(), format: marked ? 'markdown' : 'text', title: titleOf(doc.nodeData.topic, fileTitle) };
}

export { XmindError };
