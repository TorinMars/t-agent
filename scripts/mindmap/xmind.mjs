// .xmind files: a zip with content.json (current format), metadata.json and manifest.json; older files have content.xml instead.
// The file comes from outside, so it is handled as untrusted: size limits before anything is unpacked, only the named entries are read, and every text goes into the
// document as plain text (doc.mjs `sanitizeDoc` runs on the result).
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DIRECTION, DocError, LIMITS, newId, safeLink, sanitizeDoc } from './doc.mjs';

export const XMIND_LIMITS = { file: 64 * 1024 * 1024, entry: 16 * 1024 * 1024 };

export class XmindError extends Error {}

// Marker ids of XMind and the symbol shown for them. The ids are kept on the topic (`markers`), so a marker with no symbol still survives a round trip.
const MARKER_ICONS = [
  [/^priority-(\d)$/, m => `${m[1]}️⃣`],
  [/^task-done$/, () => '✅'],
  [/^task-pause$/, () => '⏸️'],
  [/^task-/, () => '⏳'],
  [/^flag-/, () => '🚩'],
  [/^star-/, () => '⭐'],
  [/^smiley-/, () => '🙂'],
];
export function iconsFor(markers) {
  return markers.map(id => {
    for (const [re, make] of MARKER_ICONS) { const m = re.exec(id); if (m) return make(m); }
    return null;
  }).filter(Boolean);
}

const looksLikeZip = bytes => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);

function readZip(bytes) {
  if (!looksLikeZip(bytes)) throw new XmindError('This is not a .xmind file');
  if (bytes.length > XMIND_LIMITS.file) throw new XmindError('This .xmind file is too large');
  let tooBig = false;
  let files;
  try {
    // Entries are chosen by name before they are unpacked; fflate unpacks an entry into a buffer of its declared size, so a false size cannot use more memory than that.
    files = unzipSync(bytes, {
      filter: file => {
        if (!['content.json', 'content.xml', 'metadata.json', 'manifest.json'].includes(file.name)) return false;
        if (file.originalSize > XMIND_LIMITS.entry) { tooBig = true; return false; }
        return true;
      },
    });
  } catch {
    throw new XmindError('This .xmind file is damaged');
  }
  if (tooBig) throw new XmindError('This .xmind file is too large');
  return files;
}

const emptyLost = () => ({ sheets: 0, images: 0, boundaries: 0, callouts: 0, floating: 0, links: 0 });

function directionOf(structureClass) {
  const value = String(structureClass || '');
  if (/logic\.left|left$/.test(value)) return DIRECTION.LEFT;
  if (/logic\.right|\.right$|tree\.right/.test(value)) return DIRECTION.RIGHT;
  return DIRECTION.SIDE;
}

function fromJsonTopic(raw, ctx, depth) {
  if (!raw || typeof raw !== 'object') throw new XmindError('This .xmind file is damaged');
  if (depth > LIMITS.depth) throw new XmindError('This map is too deeply nested');
  ctx.count += 1;
  if (ctx.count > LIMITS.topics) throw new XmindError('This map has too many topics');
  const id = newId();
  if (typeof raw.id === 'string') ctx.idMap.set(raw.id, id);
  const node = { id, topic: typeof raw.title === 'string' ? raw.title : '', children: [] };
  const plain = raw.notes && raw.notes.plain && raw.notes.plain.content;
  const html = raw.notes && raw.notes.realHTML && raw.notes.realHTML.content;
  if (typeof plain === 'string' && plain) node.note = plain;
  else if (typeof html === 'string' && html) node.note = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (Array.isArray(raw.labels)) node.tags = raw.labels.filter(label => typeof label === 'string');
  if (raw.href) { const link = safeLink(raw.href); if (link) node.hyperLink = link; else ctx.lost.links += 1; }
  if (Array.isArray(raw.markers)) {
    const markers = raw.markers.map(marker => marker && marker.markerId).filter(id2 => typeof id2 === 'string');
    if (markers.length) { node.markers = markers; node.icons = iconsFor(markers); }
  }
  if (raw.branch === 'folded') node.expanded = false;
  if (raw.image) ctx.lost.images += 1;
  if (Array.isArray(raw.boundaries)) ctx.lost.boundaries += raw.boundaries.length;
  const children = raw.children || {};
  for (const child of Array.isArray(children.attached) ? children.attached : []) node.children.push(fromJsonTopic(child, ctx, depth + 1));
  if (Array.isArray(children.callout)) ctx.lost.callouts += children.callout.length;
  if (Array.isArray(children.detached)) ctx.lost.floating += children.detached.length;
  if (Array.isArray(raw.summaries)) {
    const titles = new Map((Array.isArray(children.summary) ? children.summary : []).map(topic => [topic && topic.id, topic && topic.title]));
    for (const summary of raw.summaries) {
      const m = /^\((\d+),(\d+)\)$/.exec(String(summary && summary.range));
      if (m) ctx.summaries.push({ id: newId(), parent: id, start: Number(m[1]), end: Number(m[2]), label: titles.get(summary.topicId) || '' });
    }
  }
  return node;
}

function fromJson(text) {
  let sheets;
  try { sheets = JSON.parse(text); } catch { throw new XmindError('This .xmind file is damaged'); }
  if (!Array.isArray(sheets) || !sheets.length) throw new XmindError('This .xmind file has no map in it');
  const sheet = sheets[0];
  if (!sheet || !sheet.rootTopic) throw new XmindError('This .xmind file has no map in it');
  const lost = emptyLost();
  lost.sheets = sheets.length - 1;
  const ctx = { count: 0, idMap: new Map(), lost, summaries: [] };
  const nodeData = fromJsonTopic(sheet.rootTopic, ctx, 0);
  const arrows = (Array.isArray(sheet.relationships) ? sheet.relationships : [])
    .filter(r => r && ctx.idMap.has(r.end1Id) && ctx.idMap.has(r.end2Id))
    .map(r => ({ id: newId(), label: typeof r.title === 'string' ? r.title : '', from: ctx.idMap.get(r.end1Id), to: ctx.idMap.get(r.end2Id), delta1: { x: 80, y: -40 }, delta2: { x: -80, y: -40 } }));
  return { nodeData, arrows, summaries: ctx.summaries, direction: directionOf(sheet.rootTopic.structureClass), lost };
}

// content.xml (XMind 8 and older). `parseXml` is the browser's DOMParser (or linkedom in a test).
function fromXml(text, parseXml) {
  const dom = parseXml(text);
  const firstChild = (el, name) => [...el.children].find(child => child.localName === name) || null;
  const sheets = [...dom.documentElement.children].filter(el => el.localName === 'sheet');
  const sheet = sheets[0];
  const rootEl = sheet && firstChild(sheet, 'topic');
  if (!rootEl) throw new XmindError('This .xmind file has no map in it');
  const lost = emptyLost();
  lost.sheets = sheets.length - 1;
  const ctx = { count: 0, idMap: new Map(), lost };
  const toTopic = (el, depth) => {
    if (depth > LIMITS.depth) throw new XmindError('This map is too deeply nested');
    ctx.count += 1;
    if (ctx.count > LIMITS.topics) throw new XmindError('This map has too many topics');
    const id = newId();
    const given = el.getAttribute('id');
    if (given) ctx.idMap.set(given, id);
    const title = firstChild(el, 'title');
    const node = { id, topic: title ? title.textContent : '', children: [] };
    const notes = firstChild(el, 'notes');
    const plain = notes && firstChild(notes, 'plain');
    if (plain && plain.textContent) node.note = plain.textContent;
    const labels = firstChild(el, 'labels');
    if (labels) node.tags = [...labels.children].map(label => label.textContent).filter(Boolean);
    const refs = firstChild(el, 'marker-refs');
    if (refs) {
      const markers = [...refs.children].map(ref => ref.getAttribute('marker-id')).filter(Boolean);
      if (markers.length) { node.markers = markers; node.icons = iconsFor(markers); }
    }
    const href = el.getAttribute('xlink:href');
    if (href) { const link = safeLink(href); if (link) node.hyperLink = link; else lost.links += 1; }
    if (el.getAttribute('branch') === 'folded') node.expanded = false;
    const children = firstChild(el, 'children');
    if (children) {
      for (const group of [...children.children].filter(child => child.localName === 'topics')) {
        const list = [...group.children].filter(child => child.localName === 'topic');
        if (group.getAttribute('type') === 'attached') list.forEach(child => node.children.push(toTopic(child, depth + 1)));
        else if (group.getAttribute('type') === 'detached') lost.floating += list.length;
        else if (group.getAttribute('type') === 'callout') lost.callouts += list.length;
      }
    }
    return node;
  };
  const nodeData = toTopic(rootEl, 0);
  const relations = firstChild(sheet, 'relationships');
  const arrows = relations ? [...relations.children].filter(r => ctx.idMap.has(r.getAttribute('end1')) && ctx.idMap.has(r.getAttribute('end2'))).map(r => {
    const title = firstChild(r, 'title');
    return { id: newId(), label: title ? title.textContent : '', from: ctx.idMap.get(r.getAttribute('end1')), to: ctx.idMap.get(r.getAttribute('end2')), delta1: { x: 80, y: -40 }, delta2: { x: -80, y: -40 } };
  }) : [];
  return { nodeData, arrows, summaries: [], direction: directionOf(rootEl.getAttribute('structure-class')), lost };
}

// bytes: Uint8Array of the file. Returns { doc, lost } (lost: what could not be kept, as counts).
export function parseXmind(bytes, { parseXml } = {}) {
  const files = readZip(bytes);
  let result;
  if (files['content.json']) result = fromJson(strFromU8(files['content.json']));
  else if (files['content.xml']) {
    if (!parseXml) throw new XmindError('This .xmind file is in an old format that cannot be read here');
    result = fromXml(strFromU8(files['content.xml']), parseXml);
  } else throw new XmindError('This .xmind file has no map in it');
  const { lost, ...doc } = result;
  try {
    return { doc: sanitizeDoc(doc), lost };
  } catch (error) {
    if (error instanceof DocError) throw new XmindError(error.message);
    throw error;
  }
}

// A plain list of what could not be kept, for the message after an import.
export function describeLost(lost, t = text => text) {
  const parts = [];
  if (lost.sheets) parts.push(t('Only the first sheet was imported'));
  if (lost.images) parts.push(t('Images were not imported'));
  if (lost.boundaries) parts.push(t('Boundaries were not imported'));
  if (lost.callouts) parts.push(t('Callouts were not imported'));
  if (lost.floating) parts.push(t('Floating topics were not imported'));
  if (lost.links) parts.push(t('Links inside the workbook were not imported'));
  return parts;
}

const STRUCTURE = { [DIRECTION.LEFT]: 'org.xmind.ui.logic.left', [DIRECTION.RIGHT]: 'org.xmind.ui.logic.right', [DIRECTION.SIDE]: 'org.xmind.ui.map.unbalanced' };
const xmindId = () => newId().replace(/[^a-z0-9]/gi, '').padEnd(26, '0').slice(0, 26);

function toJsonTopic(node, idMap) {
  const id = xmindId();
  idMap.set(node.id, id);
  const topic = { id, class: 'topic', title: node.topic || '' };
  if (node.note) topic.notes = { plain: { content: node.note } };
  if (node.tags && node.tags.length) topic.labels = node.tags.map(tag => (typeof tag === 'string' ? tag : tag.text));
  if (node.hyperLink) topic.href = node.hyperLink;
  if (node.markers && node.markers.length) topic.markers = node.markers.map(markerId => ({ markerId }));
  if (node.expanded === false) topic.branch = 'folded';
  if (node.children && node.children.length) topic.children = { attached: node.children.map(child => toJsonTopic(child, idMap)) };
  return topic;
}

// The workbook as .xmind bytes. Summaries are added to their parent topic after all ids are known.
export function buildXmind({ title, data, creator = 'T-Agent' }) {
  const idMap = new Map();
  const rootTopic = toJsonTopic(data.nodeData, idMap);
  rootTopic.structureClass = STRUCTURE[data.direction] || STRUCTURE[DIRECTION.SIDE];
  const byId = new Map();
  (function index(topic) { byId.set(topic.id, topic); for (const child of (topic.children && topic.children.attached) || []) index(child); })(rootTopic);
  for (const summary of data.summaries || []) {
    const parent = byId.get(idMap.get(summary.parent));
    if (!parent) continue;
    const topicId = xmindId();
    parent.summaries = [...(parent.summaries || []), { id: xmindId(), range: `(${summary.start},${summary.end})`, topicId }];
    parent.children = parent.children || {};
    parent.children.summary = [...(parent.children.summary || []), { id: topicId, class: 'topic', title: summary.label || '' }];
  }
  const relationships = (data.arrows || []).filter(arrow => idMap.has(arrow.from) && idMap.has(arrow.to)).map(arrow => ({ id: xmindId(), end1Id: idMap.get(arrow.from), end2Id: idMap.get(arrow.to), ...(arrow.label ? { title: arrow.label } : {}) }));
  const sheet = { id: xmindId(), class: 'sheet', title: title || 'Sheet 1', rootTopic, topicPositioning: 'fixed', ...(relationships.length ? { relationships } : {}) };
  const content = JSON.stringify([sheet]);
  const metadata = JSON.stringify({ creator: { name: creator, version: '1' }, activeSheetId: sheet.id });
  const manifest = JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } });
  return zipSync({ 'content.json': strToU8(content), 'metadata.json': strToU8(metadata), 'manifest.json': strToU8(manifest) }, { level: 6 });
}
