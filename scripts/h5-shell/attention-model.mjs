// The pure logic of the T-Attention page (Attention.jsx, attention-feed.mjs): groups, order, the "Needs you" count, how a live change event updates the
// list, and which change is a reminder. No DOM, no requests, so test/attention-model.test.js runs it in Node. Items are the JSON of `attention_items`
// (see "T-Attention" in DESIGN.md): { id, title, notes, status, priority, due_date, source, attention_reason, link_url, link_label, updated_at, ... }.
// A server with sub-tasks adds `parent_id`, `custom_status`, `result` and `sort_order` (see `hasTree`); an older one sends none of them.

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

// [{ key, label, folded, items }] in GROUPS order; empty groups are left out unless `keepEmpty`.
export function groupItems(items, { keepEmpty = false } = {}) {
  const buckets = Object.fromEntries(GROUPS.map(group => [group.key, []]));
  for (const item of items || []) if (item && item.id != null) buckets[groupOf(item)].push(item);
  return GROUPS
    .map(group => ({ key: group.key, label: group.label, folded: Boolean(group.folded), items: buckets[group.key].sort(compareItems) }))
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
  const inGroup = new Map(list.map(item => [item.id, item]));
  const known = new Map((all || []).filter(item => item && item.id != null).map(item => [item.id, item]));
  const kids = new Map();
  for (const item of list) {
    const parent = idOf(item.parent_id);
    if (parent !== null && parent !== item.id && inGroup.has(parent)) {
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(item);
    }
  }
  const seen = new Set();
  const node = (item, depth, parent) => {
    seen.add(item.id);
    const children = (kids.get(item.id) || []).filter(child => !seen.has(child.id)).map(child => node(child, depth + 1, null));
    return { item, depth, indent: Math.min(depth, MAX_INDENT), parent, children };
  };
  const roots = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    const parent = idOf(item.parent_id);
    if (parent !== null && parent !== item.id && inGroup.has(parent)) continue; // drawn under its parent
    roots.push(node(item, 0, parent !== null && parent !== item.id ? known.get(parent) || null : null));
  }
  // A cycle inside the group (a data error) leaves rows that no root reached: they are drawn as top-level rows.
  for (const item of list) if (!seen.has(item.id)) roots.push(node(item, 0, null));
  return roots;
}

// The rows a tree shows, top to bottom ([{ id, depth, indent, hasChildren }]); the sub-tasks of an id in `collapsed` are left out.
export function visibleRows(tree, collapsed = new Set()) {
  const out = [];
  const walk = nodes => {
    for (const entry of nodes) {
      out.push({ id: entry.item.id, depth: entry.depth, indent: entry.indent, hasChildren: entry.children.length > 0 });
      if (!collapsed.has(entry.item.id)) walk(entry.children);
    }
  };
  walk(tree || []);
  return out;
}

// The direct sub-tasks of an id (any group), in the order of `compareItems`.
export const childrenOf = (items, id) => (items || []).filter(item => item && idOf(item.parent_id) === id && item.id !== id).sort(compareItems);

// The ids of every sub-task of an id, at any depth (any group). Never loops.
export function descendantsOf(items, id) {
  const out = new Set();
  const queue = [id];
  while (queue.length) {
    const current = queue.shift();
    for (const item of items || []) {
      if (item && idOf(item.parent_id) === current && !out.has(item.id) && item.id !== id) { out.add(item.id); queue.push(item.id); }
    }
  }
  return out;
}

// The tasks the Parent select offers for `item`: every other task that is not one of its sub-tasks, in the list's order (by group).
export function parentChoices(items, item) {
  const blocked = descendantsOf(items, item.id);
  blocked.add(item.id);
  return groupItems(items).flatMap(group => group.items).filter(entry => !blocked.has(entry.id));
}

// The collapsed parents remembered in localStorage: a JSON list of ids. Bad data reads as none.
export function readCollapsed(text) {
  try { const list = JSON.parse(text || '[]'); return new Set(Array.isArray(list) ? list.filter(id => Number.isFinite(id)) : []); } catch { return new Set(); }
}

// ── Moving: the body of POST /api/attention/:id/move, and the list the page shows before the answer ──

// The status a drop on the title of a group gives: the group's first status ("Done & failed" gives done).
export const statusOfGroup = key => (GROUPS.find(group => group.key === key) || { statuses: [] }).statuses[0] || null;

// The list after `id` moved, as the page draws it until the server answers: `move` is the body of /move ({ before } | { after } | { position, status }).
// Only the moved item changes: its `sort_order` goes between its new neighbours of the group (or above / below all of them) and, with `status`, its
// status. Its sub-tasks need no change: they are drawn under it. null when the move cannot be shown (an unknown id).
export function moveLocal(items, id, move) {
  const list = Array.isArray(items) ? items : [];
  const moving = list.find(item => item.id === id);
  if (!moving || !move) return null;
  const status = move.status || moving.status;
  const next = { ...moving, status };
  const peers = list.filter(item => item.id !== id && groupOf(item) === groupOf(next)).sort(compareItems);
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
  return list.map(item => (item.id === id ? next : item));
}

// The list after a change drawn at once (`shown`, made from `before`) failed: every item that change touched goes back to its copy in `before`, unless a
// newer copy (a live event, an answer) replaced it in `now` meanwhile.
export function rollbackItems(now, before, shown) {
  const was = new Map((before || []).map(item => [item.id, item]));
  const touched = new Map((shown || []).filter(item => was.get(item.id) !== item).map(item => [item.id, item]));
  return (now || []).map(item => (touched.get(item.id) === item && was.has(item.id) ? was.get(item.id) : item));
}

// The move of a keyboard step in the edit view ('up', 'down', 'top') among the item's siblings of its group (the rows drawn at the same level next to it):
// the body of /move, or null when it cannot go there.
export function stepMove(items, id, step) {
  const item = (items || []).find(entry => entry.id === id);
  if (!item) return null;
  const group = groupItems(items).find(entry => entry.key === groupOf(item));
  if (!group) return null;
  const find = nodes => {
    for (const entry of nodes) {
      if (entry.item.id === id) return nodes;
      const deeper = find(entry.children);
      if (deeper) return deeper;
    }
    return null;
  };
  const siblings = (find(buildTree(group.items, items)) || []).map(entry => entry.item.id);
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
  const id = change.item.id;
  const at = list.findIndex(item => item.id === id);
  if (change.kind === 'deleted') return at < 0 ? list : list.filter(item => item.id !== id);
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

export function jumpBack(context, { sourceKey, groups, localHost } = {}) {
  const tagent = context && context.tagent;
  if (tagent && tagent.task_id != null && tagent.terminal_id && sourceKey === 'local' && onThisMachine(context, localHost)) {
    for (const group of groups || []) {
      for (const task of group.tasks || []) {
        if (String(task.id) === String(tagent.task_id)) return { kind: 'terminal', taskId: task.id, terminalId: String(tagent.terminal_id) };
      }
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
