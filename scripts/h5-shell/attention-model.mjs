// The pure logic of the T-Attention page (Attention.jsx, attention-feed.mjs): groups, order, the "Needs you" count, how a live change event updates the
// list, and which change is a reminder. No DOM, no requests, so test/attention-model.test.js runs it in Node. Items are the JSON of `attention_items`
// (see "T-Attention" in DESIGN.md): { id, title, notes, status, priority, due_date, source, attention_reason, link_url, link_label, updated_at, ... }.
// A server with sub-tasks adds `parent_id`, `custom_status`, `result` and `sort_order` (see `hasTree`); an older one sends none of them.
// One list of several engines (this machine and every connected service that has T-Attention, see "T-Attention on the page" in DESIGN.md): the feed
// tags each item with `engine` (the key of its engine, as h5.js names it: 'local', 'remote:7') and `key` ('<engine>:<id>'), since ids repeat between
// engines. `item.source` stays what it always was: who reported the task ('claude', 'user', ...). Every function here names an item by its `key` when it
// has one, else by its `id` (an untagged list, as the tests and an older page build it), and a `parent_id` always means an item of the same engine.
// The phone list is the "Home view" (`homeGroups`): its grouping is lib/attention-home.js, shared with `t-attention list --tree`.
import attentionHome from '../../lib/attention-home.js';

// ── Engines ──
export const REMOTE_CAPABILITY = 'attention:remote';
export const engineOf = item => (item && item.engine) || 'local';
export const keyOf = item => (item && item.key != null ? item.key : item ? item.id : null);
export const itemKey = (engine, id) => `${engine}:${id}`;
// An item as the feed keeps it: tagged with its engine and key (a new object; the item of the answer is not changed).
export const tagItem = (item, engine) => (item && item.id != null ? { ...item, engine, key: itemKey(engine, item.id) } : item);
// A key ('local:5', 'remote:7:5') or a bare id (an item of this machine) as { engine, id }; null when it cannot be read.
export function parseKey(ref) {
  if (typeof ref === 'number') return Number.isFinite(ref) ? { engine: 'local', id: ref } : null;
  const text = String(ref == null ? '' : ref);
  const cut = text.lastIndexOf(':');
  const id = Number(cut < 0 ? text : text.slice(cut + 1));
  if (!text || !Number.isFinite(id)) return null;
  return { engine: cut < 0 ? 'local' : text.slice(0, cut), id };
}
// The engines whose items the list shows, from `state.sources` of h5.js (the devices of the one task list, in list order, this machine first): the ones
// listed there (not hidden by "Show in task list"), and of those the remote ones only when online and advertising REMOTE_CAPABILITY. Before h5.js has
// said what is listed (or on a page without it), and whenever nothing would be left, this machine alone.
export function attentionEngines(sources) {
  const list = Array.isArray(sources) ? sources.filter(source => source && source.key) : [];
  const local = list.find(source => source.key === 'local') || { key: 'local', label: 'This machine', name: '' };
  const pick = source => ({ key: source.key, local: source.key === 'local', label: source.label || '', name: source.name || '', instanceId: source.instanceId || null });
  const listed = list.filter(source => source.listed === true);
  const out = listed.filter(source => source.key === 'local' || (!source.offline && Array.isArray(source.capabilities) && source.capabilities.includes(REMOTE_CAPABILITY)));
  return (out.length ? out : [local]).map(pick);
}
const parentKeyOf = item => {
  const parent = idOf(item && item.parent_id);
  if (parent === null) return null;
  return item.key != null ? itemKey(engineOf(item), parent) : parent;
};

export const STATUSES = ['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled'];
export const PRIORITIES = ['high', 'medium', 'low', 'none'];

// English labels (the Chinese ones are in public/js/i18n-zh-ui.js, keyed by these).
export const STATUS_LABELS = {
  todo: 'To do', working: 'Working', waiting_user: 'Needs you', review: 'Review', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};
export const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };

// The groups of the list, top to bottom. "Done & failed" is folded by default (Attention.jsx).
export const GROUPS = [
  { key: 'needs', label: 'Needs you', statuses: ['waiting_user'] },
  { key: 'review', label: 'Review', statuses: ['review'] },
  { key: 'working', label: 'Working', statuses: ['working'] },
  { key: 'todo', label: 'To do', statuses: ['todo'] },
  { key: 'closed', label: 'Done & failed', statuses: ['done', 'failed', 'cancelled'], folded: true },
];
const GROUP_OF = Object.fromEntries(GROUPS.flatMap(group => group.statuses.map(status => [status, group.key])));
export const groupOf = item => GROUP_OF[item && item.status] || 'todo';

// The statuses that ask for the user: a change INTO one of them is a reminder (toast, system notification, sound).
export const REMIND_STATUSES = ['waiting_user', 'failed', 'review'];
export const CLOSED_STATUSES = ['done', 'failed', 'cancelled'];

const RANK = { high: 0, medium: 1, low: 2, none: 3 };
const rank = item => (item.priority in RANK ? RANK[item.priority] : RANK.none);
const time = value => { const at = Date.parse(value || ''); return Number.isFinite(at) ? at : 0; };

const order = item => (item && typeof item.sort_order === 'number' && Number.isFinite(item.sort_order) ? item.sort_order : null);

// Within a group: `sort_order` (the highest first, the server's order of the group), then id (the highest first). Items of an older server have no
// `sort_order`: priority (high first), then due date (the earliest first, none last), then updated_at (the newest first), then id.
export function compareItems(a, b) {
  const orderA = order(a);
  const orderB = order(b);
  if (orderA !== null && orderB !== null) return orderB - orderA || (Number(b.id) || 0) - (Number(a.id) || 0);
  const byRank = rank(a) - rank(b);
  if (byRank) return byRank;
  const dueA = a.due_date || '';
  const dueB = b.due_date || '';
  if (dueA !== dueB) {
    if (!dueA) return 1;
    if (!dueB) return -1;
    return dueA < dueB ? -1 : 1;
  }
  const byUpdate = time(b.updated_at) - time(a.updated_at);
  if (byUpdate) return byUpdate;
  return (Number(a.id) || 0) - (Number(b.id) || 0);
}

// The order of the engine blocks inside a group: `engines` (keys, this machine first), an engine that is not in it after them. Without `engines`:
// this machine first, the others together.
const engineRank = engines => {
  const at = new Map((engines || ['local']).map((key, index) => [key, index]));
  return item => (at.has(engineOf(item)) ? at.get(engineOf(item)) : at.size);
};

// [{ key, label, folded, items }] in GROUPS order; empty groups are left out unless `keepEmpty`. Inside a group the items of one engine are one block,
// in the order of `engines` (this machine first), each block in the order of `compareItems`.
export function groupItems(items, { keepEmpty = false, engines = null } = {}) {
  const buckets = Object.fromEntries(GROUPS.map(group => [group.key, []]));
  for (const item of items || []) if (item && item.id != null) buckets[groupOf(item)].push(item);
  const rank = engineRank(engines);
  const compare = (a, b) => rank(a) - rank(b) || compareItems(a, b);
  return GROUPS
    .map(group => ({ key: group.key, label: group.label, folded: Boolean(group.folded), items: buckets[group.key].sort(compare) }))
    .filter(group => keepEmpty || group.items.length);
}

// Whether the list comes from a server with sub-tasks, a custom status, a result and the order of /move: its items have the `parent_id` key (null
// for a top-level task). An older server sends no such key: the page then offers no drag and none of these fields.
export const hasTree = items => (items || []).some(item => item && Object.prototype.hasOwnProperty.call(item, 'parent_id'));

// ── Sub-tasks: the tree inside a group ──

// The deepest indent drawn (levels 0 to MAX_INDENT); deeper sub-tasks are drawn at that indent.
export const MAX_INDENT = 3;
const idOf = value => (value === null || value === undefined || value === '' ? null : Number(value));

// The tree of one group: `items` are the group's items in their order (`groupItems`), `all` every item (for the parent of another group). A sub-task
// whose parent is in the same group is drawn under it (depth first, siblings in the group's order); one whose parent is in another group is a top-level
// row of its own group with `parent` (that parent, for the "↳ <title>" hint); one whose parent is not known is a plain top-level row. Never loops,
// even on a cycle in the data. Returns [{ item, depth, indent, parent, children: [...] }].
export function buildTree(items, all = items) {
  const list = items || [];
  const inGroup = new Map(list.map(item => [keyOf(item), item]));
  const known = new Map((all || []).filter(item => item && item.id != null).map(item => [keyOf(item), item]));
  const kids = new Map();
  for (const item of list) {
    const parent = parentKeyOf(item);
    if (parent !== null && parent !== keyOf(item) && inGroup.has(parent)) {
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(item);
    }
  }
  const seen = new Set();
  const node = (item, depth, parent) => {
    seen.add(keyOf(item));
    const children = (kids.get(keyOf(item)) || []).filter(child => !seen.has(keyOf(child))).map(child => node(child, depth + 1, null));
    return { item, depth, indent: Math.min(depth, MAX_INDENT), parent, children };
  };
  const roots = [];
  for (const item of list) {
    if (seen.has(keyOf(item))) continue;
    const parent = parentKeyOf(item);
    if (parent !== null && parent !== keyOf(item) && inGroup.has(parent)) continue; // drawn under its parent
    roots.push(node(item, 0, parent !== null && parent !== keyOf(item) ? known.get(parent) || null : null));
  }
  // A cycle inside the group (a data error) leaves rows that no root reached: they are drawn as top-level rows.
  for (const item of list) if (!seen.has(keyOf(item))) roots.push(node(item, 0, null));
  return roots;
}

// ── The phone list: the Home view of the t-attention skill ──

// The sections of the phone list, top to bottom (then the "Done: N" line): Needs you (waiting_user, then review), Working, To do.
export const HOME_SECTIONS = attentionHome.HOME_SECTIONS.map(section => ({ key: section.key, label: section.label, statuses: [...section.statuses] }));

// The phone list (lib/attention-home.js `homeView`, the grouping of `t-attention list --tree`): every section (an empty one too) with whole trees, a
// tree in the section of its most urgent open task, each row with its own status; finished tasks only counted (`done`), except a finished parent
// that keeps an open sub-task under it. Inside a section the trees of one engine keep the order of `engines` (this machine first) after the status
// order of the shared rules, and `compareItems` decides between equals. Nodes have the shape of `buildTree` ({ item, depth, indent, parent: null,
// children }), so they draw (and collapse) the same way. An older server (no `parent_id`) gives one row per task, in the section of its status.
// -> { sections: [{ key, label, statuses, nodes }], done }
export function homeGroups(items, { engines = null } = {}) {
  const rank = engineRank(engines);
  const view = attentionHome.homeView(items, { keyOf, parentOf: parentKeyOf, compare: (a, b) => rank(a) - rank(b) || compareItems(a, b) });
  const node = entry => ({ item: entry.item, depth: entry.depth, indent: Math.min(entry.depth, MAX_INDENT), parent: null, children: entry.children.map(node) });
  return { sections: view.sections.map(section => ({ key: section.key, label: section.label, statuses: section.statuses, nodes: section.nodes.map(node) })), done: view.done };
}

// The line under the title of a phone row, by its section (the columns of the Home view): Needs you shows what the user has to do (what is pending,
// else the reason; a review with neither waits for the user's confirmation), Working the custom status and the first line of the notes, To do
// nothing. A row of another status in Needs you (the parent of a task that needs the user) shows nothing there. -> { kind, text } or null; `kind`
// 'reason', 'confirm' (the English text to translate) or 'progress'.
export function homeDetail(item, section) {
  if (!item) return null;
  if (section === 'needs_you') {
    if (item.status !== 'waiting_user' && item.status !== 'review') return null;
    const text = pendingLine(item);
    if (text) return { kind: 'reason', text };
    return item.status === 'review' ? { kind: 'confirm', text: 'Waits for your confirmation' } : null;
  }
  if (section === 'working') {
    const note = String(item.notes || '').split('\n').map(line => line.trim()).find(Boolean) || '';
    const text = [String(item.custom_status || '').trim(), note].filter(Boolean).join(' \u00b7 ');
    return text ? { kind: 'progress', text } : null;
  }
  return null;
}

// A time as MM-DD HH:MM in local time ('' for none), as the Home view writes it.
export function shortTime(value) {
  const at = Date.parse(value || '');
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The rows a tree shows, top to bottom ([{ id, key, depth, indent, hasChildren }]); the sub-tasks of a key (or id) in `collapsed` are left out.
export function visibleRows(tree, collapsed = new Set()) {
  const out = [];
  const walk = nodes => {
    for (const entry of nodes) {
      out.push({ id: entry.item.id, key: keyOf(entry.item), depth: entry.depth, indent: entry.indent, hasChildren: entry.children.length > 0 });
      if (!collapsed.has(keyOf(entry.item))) walk(entry.children);
    }
  };
  walk(tree || []);
  return out;
}

// The direct sub-tasks of a key (or id) (any group), in the order of `compareItems`.
export const childrenOf = (items, ref) => (items || []).filter(item => item && parentKeyOf(item) === ref && keyOf(item) !== ref).sort(compareItems);

// The keys (or ids) of every sub-task of a key (or id), at any depth (any group). Never loops.
export function descendantsOf(items, ref) {
  const out = new Set();
  const queue = [ref];
  while (queue.length) {
    const current = queue.shift();
    for (const item of items || []) {
      if (item && parentKeyOf(item) === current && !out.has(keyOf(item)) && keyOf(item) !== ref) { out.add(keyOf(item)); queue.push(keyOf(item)); }
    }
  }
  return out;
}

// The tasks the Parent select offers for `item`: every other task of its own engine that is not one of its sub-tasks, in the list's order (by group).
export function parentChoices(items, item) {
  const blocked = descendantsOf(items, keyOf(item));
  blocked.add(keyOf(item));
  const engine = engineOf(item);
  return groupItems(items).flatMap(group => group.items).filter(entry => !blocked.has(keyOf(entry)) && engineOf(entry) === engine);
}

// The collapsed parents remembered in localStorage: a JSON list of ids (this machine's tasks) and keys ('remote:7:5', another engine's). Bad data reads
// as none.
const COLLAPSED_KEY_RE = /^[a-z][\w-]*(?::[\w-]+)*:\d+$/;
export function readCollapsed(text) {
  try {
    const list = JSON.parse(text || '[]');
    return new Set(Array.isArray(list) ? list.filter(id => Number.isFinite(id) || (typeof id === 'string' && id.length <= 200 && COLLAPSED_KEY_RE.test(id))) : []);
  } catch { return new Set(); }
}
// The name a collapsed parent is remembered by: its id for a task of this machine (as before there were engines), else its key.
export const collapseId = item => (engineOf(item) === 'local' ? item.id : keyOf(item));

// ── Moving: the body of POST /api/attention/:id/move, and the list the page shows before the answer ──

// The status a drop on the title of a group gives: the group's first status ("Done & failed" gives done; the phone's Needs you gives waiting_user).
export const statusesOfGroup = key => ([...GROUPS, ...HOME_SECTIONS].find(group => group.key === key) || { statuses: [] }).statuses;
export const statusOfGroup = key => statusesOfGroup(key)[0] || null;

// The list after the item `ref` (its key, or id) moved, as the page draws it until the server answers: `move` is the body of /move ({ before } |
// { after } | { position, status }, with the ids of its own engine). Only the moved item changes: its `sort_order` goes between its new neighbours of the
// group and engine (or above / below all of them) and, with `status`, its status. Its sub-tasks need no change: they are drawn under it. null when the
// move cannot be shown (an unknown item).
export function moveLocal(items, ref, move) {
  const list = Array.isArray(items) ? items : [];
  const moving = list.find(item => keyOf(item) === ref);
  if (!moving || !move) return null;
  const status = move.status || moving.status;
  const next = { ...moving, status };
  const peers = list.filter(item => keyOf(item) !== ref && groupOf(item) === groupOf(next) && engineOf(item) === engineOf(moving)).sort(compareItems);
  const at = item => order(item) ?? 0;
  let value;
  const target = move.before ?? move.after;
  if (target !== undefined && target !== null) {
    const index = peers.findIndex(item => item.id === target);
    if (index < 0) return null;
    if (move.before !== undefined) value = index > 0 ? (at(peers[index - 1]) + at(peers[index])) / 2 : at(peers[index]) + 1;
    else value = index < peers.length - 1 ? (at(peers[index]) + at(peers[index + 1])) / 2 : at(peers[index]) - 1;
  } else if (move.position === 'bottom') value = peers.length ? Math.min(...peers.map(at)) - 1 : 0;
  else value = peers.length ? Math.max(...peers.map(at)) + 1 : 0;
  next.sort_order = value;
  return list.map(item => (keyOf(item) === ref ? next : item));
}

// The list after a change drawn at once (`shown`, made from `before`) failed: every item that change touched goes back to its copy in `before`, unless a
// newer copy (a live event, an answer) replaced it in `now` meanwhile.
export function rollbackItems(now, before, shown) {
  const was = new Map((before || []).map(item => [keyOf(item), item]));
  const touched = new Map((shown || []).filter(item => was.get(keyOf(item)) !== item).map(item => [keyOf(item), item]));
  return (now || []).map(item => (touched.get(keyOf(item)) === item && was.has(keyOf(item)) ? was.get(keyOf(item)) : item));
}

// The move of a keyboard step in the edit view ('up', 'down', 'top') among the item's siblings of its group and engine (the rows of its engine drawn at
// the same level next to it): the body of /move (with ids), or null when it cannot go there. `ref` is the item's key (or id).
export function stepMove(items, ref, step) {
  const item = (items || []).find(entry => keyOf(entry) === ref);
  if (!item) return null;
  const group = groupItems(items).find(entry => entry.key === groupOf(item));
  if (!group) return null;
  const find = nodes => {
    for (const entry of nodes) {
      if (keyOf(entry.item) === ref) return nodes;
      const deeper = find(entry.children);
      if (deeper) return deeper;
    }
    return null;
  };
  const siblings = (find(buildTree(group.items, items)) || []).filter(entry => engineOf(entry.item) === engineOf(item)).map(entry => entry.item.id);
  const id = item.id;
  const index = siblings.indexOf(id);
  if (step === 'top') return index > 0 ? { before: siblings[0] } : null;
  if (step === 'up') return index > 0 ? { before: siblings[index - 1] } : null;
  if (step === 'down') return index >= 0 && index < siblings.length - 1 ? { after: siblings[index + 1] } : null;
  return null;
}

// The number on the Attention button: the tasks waiting for the user.
export const needsCount = items => (items || []).filter(item => item && item.status === 'waiting_user').length;

// The list after one change event of GET /api/attention/stream ({ kind: 'created' | 'updated' | 'deleted', item, previous, event }). A new list is returned
// (the store compares by reference); an event for an item that is not known is added (created or updated), a delete of an unknown one changes nothing.
export function applyChange(items, change) {
  const list = Array.isArray(items) ? items : [];
  if (!change || !change.item || change.item.id == null) return list;
  const id = keyOf(change.item);
  const at = list.findIndex(item => keyOf(item) === id);
  if (change.kind === 'deleted') return at < 0 ? list : list.filter(item => keyOf(item) !== id);
  if (at < 0) return [...list, change.item];
  // An older copy (a late event after a newer list was read) does not replace a newer one.
  if (time(change.item.updated_at) && time(list[at].updated_at) > time(change.item.updated_at)) return list;
  const next = list.slice();
  next[at] = change.item;
  return next;
}

// A reminder for a change that moves a task INTO waiting_user, failed or review (a task created in one of them counts too); null for anything else.
export function reminderFor(change) {
  if (!change || change.kind === 'deleted' || !change.item) return null;
  const { item, previous } = change;
  if (!REMIND_STATUSES.includes(item.status)) return null;
  if (previous && previous.status === item.status) return null;
  // A move (POST /move publishes every task whose order or status changed with `reorder: true`; the renumbered neighbours with `event: null`) is a
  // reminder only when it changed the status.
  if (change.kind === 'updated' && change.reorder === true && (!change.event || change.event.type !== 'status')) return null;
  if (change.kind === 'updated' && MOVE_EVENTS.has(change.event && change.event.type) && !(change.event.to_status && change.event.to_status !== change.event.from_status)) return null;
  return { id: item.id, status: item.status, label: STATUS_LABELS[item.status], title: String(item.title || ''), reason: String(item.attention_reason || '') };
}

// Whether a reminder also shows the in-page notice. The one exception is a review that ends a plain Claude turn (the listener's plain_turn_end on this
// one change event); every other change keeps its notice. The sound and the system notification do not depend on this.
export const showsNotice = change => !(change && change.plain_turn_end === true && change.item && change.item.status === 'review');

// A link of a task may be opened: a web address, or a page address of this app (one leading '/', not '//').
export function safeLink(url) {
  const text = String(url || '').trim();
  if (/^https?:\/\/[^\s]+$/i.test(text)) return { url: text, external: true };
  if (/^\/(?![/\\])[^\s]*$/.test(text)) return { url: text, external: false };
  return null;
}

// The fields of the edit form that differ from the item, as the body of PATCH /api/attention/:id (null when nothing changed).
// Empty notes and an empty due date are sent as null (cleared).
export function patchFor(item, form) {
  const out = {};
  const title = String(form.title || '').trim();
  if (title !== String(item.title || '')) out.title = title;
  const notes = String(form.notes || '');
  if (notes !== String(item.notes || '')) out.notes = notes.trim() ? notes : null;
  if (form.status && form.status !== item.status) out.status = form.status;
  if (form.priority && form.priority !== (item.priority || 'none')) out.priority = form.priority;
  const due = String(form.due_date || '');
  if (due !== String(item.due_date || '')) out.due_date = due || null;
  // The fields of a server with sub-tasks, only when the form has them: an empty one is cleared (null).
  for (const key of ['custom_status', 'result']) {
    if (form[key] === undefined) continue;
    const value = String(form[key] || '').trim();
    if (value !== String(item[key] || '')) out[key] = value || null;
  }
  if (form.parent_id !== undefined) {
    const parent = idOf(form.parent_id);
    if (parent !== idOf(item.parent_id)) out.parent_id = parent;
  }
  return Object.keys(out).length ? out : null;
}

// The date of today in the local time zone (YYYY-MM-DD), to mark an overdue due date.
export function today(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export const overdue = (item, day = today()) => Boolean(item && item.due_date && !CLOSED_STATUSES.includes(item.status) && item.due_date < day);

// ── Context recall: the context card, the timeline and the jump back (see "T-Attention on the page" in DESIGN.md) ──

// `item.context` as an object (the API sends it parsed; a JSON string is read too). Never throws.
export function contextOf(item) {
  const raw = item && item.context;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

// The one line under the title of a row that needs the user: what is pending, else the reason.
export function pendingLine(item) {
  const pending = contextOf(item).pending;
  if (pending && pending.text) return String(pending.text);
  return item && item.attention_reason ? String(item.attention_reason) : '';
}

// The timeline sentences: an English fixed part (`key`, translated by the page) and the variable text (shown as it is).
export const ACTIVITY_SENTENCES = {
  prompt: 'You asked', permission: 'Asked for permission', question: 'Asked you a question', resumed: 'Work resumed',
  turn_end: 'Finished a turn', error: 'Error', session_end: 'Session ended', note: 'Note',
};
export const STATUS_SENTENCES = {
  todo: 'Moved to To do', working: 'Started working', waiting_user: 'Now needs you', review: 'Ready for your review',
  done: 'Marked done', failed: 'Failed', cancelled: 'Cancelled',
};
const QUIET_FIELDS = new Set(['context', 'meta', 'attention_reason', 'activity', 'excerpt', 'updated_at', 'source', 'sort_order', 'completed_at', 'move', 'reason']);
// The fields with a sentence of their own; the others of an update are listed in one "Changed: …".
const OWN_FIELDS = new Set(['custom_status', 'result', 'parent_id']);
// The event types of a move. The server stores a move as an `updated` (or, with a new status, `status`) event whose data has `move`; a move that also
// changed the status has the status sentence; the order alone is "Moved", once for a run of moves.
export const MOVE_EVENTS = new Set(['moved', 'move', 'reordered']);
const dataOf = event => {
  if (!event || !event.data) return {};
  if (typeof event.data === 'object') return event.data;
  try { return JSON.parse(event.data) || {}; } catch { return {}; }
};

// The new value of a field in an event's data: the value itself, or `to` of a { from, to } pair.
const newValue = value => (value && typeof value === 'object' && !Array.isArray(value) && 'to' in value ? value.to : value);

// The sentences of the fields with their own (custom status, result, parent). `titleOf(id)` names a parent ('' when not known).
function fieldSentences(data, titleOf) {
  const out = [];
  if ('custom_status' in data) { const value = newValue(data.custom_status); out.push(value ? { key: 'Custom status', text: String(value), kind: 'custom_status' } : { key: 'Custom status cleared', text: '', kind: 'custom_status' }); }
  if ('result' in data) { const value = newValue(data.result); out.push(value ? { key: 'Result', text: String(value), kind: 'result' } : { key: 'Result cleared', text: '', kind: 'result' }); }
  if ('parent_id' in data) {
    const parent = idOf(newValue(data.parent_id));
    const title = parent === null ? '' : String(titleOf(parent) || '');
    out.push(parent === null ? { key: 'Now top-level', text: '', kind: 'parent' } : { key: 'Moved under', text: title || `#${parent}`, kind: 'parent', joined: true });
  }
  return out;
}

// One event as its sentences ([] when it says nothing a person needs to read: an update of the context only, or of the order alone).
export function eventSentences(event, titleOf = () => '') {
  if (!event) return [];
  const data = dataOf(event);
  if (event.type === 'activity') {
    const text = String(data.text || '');
    // The notes of the row buttons are stored in English ("Handled", "Rejected: <reason>"): they read as sentences of their own, translated.
    if (data.kind === 'note' && text === 'Handled') return [{ key: 'Handled', text: '', kind: 'note' }];
    if (data.kind === 'note' && /^Rejected(?::|$)/.test(text)) return [{ key: 'Rejected', text: text.replace(/^Rejected:?\s*/, ''), kind: 'note' }];
    return [{ key: ACTIVITY_SENTENCES[data.kind] || 'Note', text, kind: data.kind || 'note' }];
  }
  if (event.type === 'status') return [{ key: STATUS_SENTENCES[event.to_status] || 'Status changed', text: '', kind: 'status', status: event.to_status }, ...fieldSentences(data, titleOf)];
  if (event.type === 'created') return [{ key: 'Created', text: '', kind: 'created' }];
  if (event.type === 'deleted') return [{ key: 'Deleted', text: '', kind: 'deleted' }];
  if (MOVE_EVENTS.has(event.type)) return [{ key: 'Moved', text: '', kind: 'moved' }, ...fieldSentences(data, titleOf)];
  if (event.type === 'updated' && data.move !== undefined) return [{ key: 'Moved', text: '', kind: 'moved' }, ...fieldSentences(data, titleOf)];
  if (event.type === 'updated') {
    const fields = Object.keys(data).filter(field => !QUIET_FIELDS.has(field) && !OWN_FIELDS.has(field));
    return [...(fields.length ? [{ key: 'Changed', text: fields.map(field => field.replace(/_/g, ' ')).join(', '), kind: 'updated' }] : []), ...fieldSentences(data, titleOf)];
  }
  return [];
}

// One event as a sentence (its first), or null.
export const eventSentence = (event, titleOf) => eventSentences(event, titleOf)[0] || null;

// The local calendar day of a time (YYYY-MM-DD), '' for none.
export function dayOf(value) {
  const at = Date.parse(value || '');
  return Number.isFinite(at) ? today(new Date(at)) : '';
}

// The events (the API sends them newest first) as days, oldest first, each with its sentences oldest first.
// A run of moves one after another (dragging a row up and down) is one "Moved", at the time of the last one. `titleOf(id)` names a parent.
export function timeline(events, titleOf) {
  const rows = (events || [])
    .filter(Boolean)
    .map(event => ({ event, at: Date.parse(event.at || '') }))
    .sort((a, b) => (a.at || 0) - (b.at || 0) || (Number(a.event.id) || 0) - (Number(b.event.id) || 0))
    .flatMap(row => eventSentences(row.event, titleOf).map((sentence, index) => ({ ...row, sentence, index })));
  const days = [];
  for (const row of rows) {
    const day = dayOf(row.event.at);
    if (!days.length || days.at(-1).day !== day) days.push({ day, items: [] });
    const items = days.at(-1).items;
    const entry = { id: row.index ? `${row.event.id}.${row.index}` : row.event.id, at: row.event.at, actor: row.event.actor || '', ...row.sentence };
    const last = items.at(-1);
    if (entry.kind === 'moved' && last && last.kind === 'moved') { items[items.length - 1] = entry; continue; }
    items.push(entry);
  }
  return days;
}

// Back to where the task runs: the T-Agent terminal it runs in, when that task is in the list of this machine the page shows; else the
// command that resumes the session; null when neither is known. `groups` is `state.taskList.groups` (tasks with their ids).
// Whether the session of a context ran on this machine: `context.host` (the listener's os.hostname()) against `localHost` (GET /api/attention
// `host`). Unknown on either side counts as this machine (older items, a listener that sent no host).
export function onThisMachine(context, localHost) {
  const host = context && typeof context.host === 'string' ? context.host.trim().toLowerCase() : '';
  const here = typeof localHost === 'string' ? localHost.trim().toLowerCase() : '';
  return !host || !here || host === here;
}

// An item of another engine (`sourceKey` 'remote:7'): `tasks` is `state.taskList.tasks` (the rows of the one list, each with its `source` and `ref`), and
// its terminal opens when that engine's task is listed there (`taskId` is then the row's ref, which `ui.actions.openRow` takes); `localHost` is then the
// host of that engine's answer.
export function jumpBack(context, { sourceKey, groups, tasks, localHost } = {}) {
  const tagent = context && context.tagent;
  if (tagent && tagent.task_id != null && tagent.terminal_id && onThisMachine(context, localHost)) {
    const terminalId = String(tagent.terminal_id);
    if (sourceKey === 'local') {
      for (const group of groups || []) {
        for (const task of group.tasks || []) {
          if (String(task.id) === String(tagent.task_id)) return { kind: 'terminal', taskId: task.id, terminalId };
        }
      }
    } else if (sourceKey) {
      const task = (tasks || []).find(row => row && row.source === sourceKey && row.ref && String(row.id) === String(tagent.task_id));
      if (task) return { kind: 'terminal', taskId: task.ref, terminalId };
    }
  }
  const resume = context && context.session && context.session.resume;
  return resume ? { kind: 'copy', command: String(resume) } : null;
}

// The absolute path of a file of the context (`files[].path` is relative to `context.cwd`, or already absolute); null when it cannot be told.
export function contextFilePath(context, file) {
  const name = String((file && file.path) || '');
  if (!name) return null;
  if (name.startsWith('/')) return name;
  const cwd = String((context && context.cwd) || '');
  return cwd.startsWith('/') ? `${cwd.replace(/\/+$/, '')}/${name.replace(/^\.\//, '')}` : null;
}
