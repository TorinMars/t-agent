// The document format of a mind map, and the rules that make any document (from the server, a .xmind file, the clipboard) safe to draw.
// A document is what the editor library (mind-elixir) reads: { nodeData, arrows, summaries, direction }. The server stores it as opaque JSON.
// Extra topic fields: `note` (plain text), `markers` (XMind marker ids, kept for the round trip).
export const LIMITS = { topics: 20000, depth: 200, text: 20000, label: 200 };
export const DIRECTION = { LEFT: 0, RIGHT: 1, SIDE: 2 };

export class DocError extends Error {}

const SAFE_ID = /^[\w-]{1,64}$/;
let counter = 0;
export const newId = () => `mm${Date.now().toString(36)}${(counter += 1).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Only links that open a page or a mail: never javascript:, data: or a file on the device.
export function safeLink(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^(https?:\/\/|mailto:)/i.test(text) && text.length <= 2048 ? text : '';
}

const clip = (value, size) => (typeof value === 'string' ? value.slice(0, size) : '');

export function blankDoc(title) {
  return { nodeData: { id: newId(), topic: String(title || '').trim() || 'Central Topic', children: [] }, arrows: [], summaries: [], direction: DIRECTION.SIDE };
}

// Keeps only the fields the editor needs, as plain data of the right type. What the library would draw as HTML or fetch (`dangerouslySetInnerHTML`, `image`, `style`) is
// dropped. A topic id that could not go into a selector, or is used twice, is replaced; `ids` maps old ids to new ones for the arrows and summaries.
function cleanTopic(raw, depth, state) {
  if (!raw || typeof raw !== 'object') throw new DocError('A topic is not valid');
  if (depth > LIMITS.depth) throw new DocError('This map is too deeply nested');
  state.topics += 1;
  if (state.topics > LIMITS.topics) throw new DocError('This map has too many topics');
  const usable = typeof raw.id === 'string' && SAFE_ID.test(raw.id) && !state.ids.has(raw.id);
  const id = usable ? raw.id : newId();
  if (typeof raw.id === 'string' && !state.ids.has(raw.id)) state.ids.set(raw.id, id); // the first topic with an id keeps it, also for the arrows
  const node = { id, topic: clip(raw.topic, LIMITS.text) };
  const note = clip(raw.note, LIMITS.text);
  if (note) node.note = note;
  const link = safeLink(raw.hyperLink);
  if (link) node.hyperLink = link;
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.map(tag => clip(typeof tag === 'string' ? tag : tag && tag.text, LIMITS.label).trim()).filter(Boolean).slice(0, 50);
    if (tags.length) node.tags = tags;
  }
  if (Array.isArray(raw.icons)) {
    const icons = raw.icons.map(icon => clip(icon, 16)).filter(Boolean).slice(0, 20);
    if (icons.length) node.icons = icons;
  }
  if (Array.isArray(raw.markers)) {
    const markers = raw.markers.map(marker => clip(marker, 64)).filter(Boolean).slice(0, 20);
    if (markers.length) node.markers = markers;
  }
  if (raw.expanded === false) node.expanded = false;
  if (raw.direction === 0 || raw.direction === 1) node.direction = raw.direction;
  node.children = Array.isArray(raw.children) ? raw.children.map(child => cleanTopic(child, depth + 1, state)) : [];
  return node;
}

const delta = value => ({ x: Number(value && value.x) || 0, y: Number(value && value.y) || 0 });

export function sanitizeDoc(raw) {
  if (!raw || typeof raw !== 'object' || !raw.nodeData || typeof raw.nodeData !== 'object') throw new DocError('This map cannot be read');
  const state = { topics: 0, ids: new Map() };
  const nodeData = cleanTopic(raw.nodeData, 0, state);
  const known = id => state.ids.get(id);
  const arrows = (Array.isArray(raw.arrows) ? raw.arrows : [])
    .filter(arrow => arrow && known(arrow.from) && known(arrow.to))
    .map(arrow => ({ id: SAFE_ID.test(arrow.id || '') ? arrow.id : newId(), label: clip(arrow.label, LIMITS.label), from: known(arrow.from), to: known(arrow.to), delta1: delta(arrow.delta1), delta2: delta(arrow.delta2), ...(arrow.bidirectional ? { bidirectional: true } : {}) }));
  const summaries = (Array.isArray(raw.summaries) ? raw.summaries : [])
    .filter(summary => summary && known(summary.parent) && Number.isInteger(summary.start) && Number.isInteger(summary.end))
    .map(summary => ({ id: SAFE_ID.test(summary.id || '') ? summary.id : newId(), parent: known(summary.parent), start: summary.start, end: summary.end, label: clip(summary.label, LIMITS.label) }));
  const direction = raw.direction === DIRECTION.LEFT || raw.direction === DIRECTION.RIGHT ? raw.direction : DIRECTION.SIDE;
  return { nodeData, arrows, summaries, direction };
}

// What is stored: the editor's document without its display settings.
export function plainDoc(data) {
  return { nodeData: data.nodeData, arrows: data.arrows || [], summaries: data.summaries || [], direction: data.direction };
}

export function countTopics(node) { return 1 + (node.children || []).reduce((sum, child) => sum + countTopics(child), 0); }
