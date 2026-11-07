// The pure logic of the T-Attention page (Attention.jsx, attention-feed.mjs): groups, order, the "Needs you" count, how a live change event updates the
// list, and which change is a reminder. No DOM, no requests, so test/attention-model.test.js runs it in Node. Items are the JSON of `attention_items`
// (see "T-Attention" in DESIGN.md): { id, title, notes, status, priority, due_date, source, attention_reason, link_url, link_label, updated_at, ... }.

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

// Within a group: priority (high first), then due date (the earliest first, none last), then updated_at (the newest first), then id.
export function compareItems(a, b) {
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
  return { id: item.id, status: item.status, label: STATUS_LABELS[item.status], title: String(item.title || ''), reason: String(item.attention_reason || '') };
}

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
const QUIET_FIELDS = new Set(['context', 'meta', 'attention_reason', 'activity', 'excerpt', 'updated_at', 'source']);
const dataOf = event => {
  if (!event || !event.data) return {};
  if (typeof event.data === 'object') return event.data;
  try { return JSON.parse(event.data) || {}; } catch { return {}; }
};

// One event as a sentence, or null when it says nothing a person needs to read (an update of the context only).
export function eventSentence(event) {
  if (!event) return null;
  const data = dataOf(event);
  if (event.type === 'activity') return { key: ACTIVITY_SENTENCES[data.kind] || 'Note', text: String(data.text || ''), kind: data.kind || 'note' };
  if (event.type === 'status') return { key: STATUS_SENTENCES[event.to_status] || 'Status changed', text: '', kind: 'status', status: event.to_status };
  if (event.type === 'created') return { key: 'Created', text: '', kind: 'created' };
  if (event.type === 'deleted') return { key: 'Deleted', text: '', kind: 'deleted' };
  if (event.type === 'updated') {
    const fields = Object.keys(data).filter(field => !QUIET_FIELDS.has(field));
    return fields.length ? { key: 'Changed', text: fields.join(', '), kind: 'updated' } : null;
  }
  return null;
}

// The local calendar day of a time (YYYY-MM-DD), '' for none.
export function dayOf(value) {
  const at = Date.parse(value || '');
  return Number.isFinite(at) ? today(new Date(at)) : '';
}

// The events (the API sends them newest first) as days, oldest first, each with its sentences oldest first.
export function timeline(events) {
  const rows = (events || [])
    .map(event => ({ event, sentence: eventSentence(event), at: Date.parse((event && event.at) || '') }))
    .filter(row => row.sentence)
    .sort((a, b) => (a.at || 0) - (b.at || 0) || (Number(a.event.id) || 0) - (Number(b.event.id) || 0));
  const days = [];
  for (const row of rows) {
    const day = dayOf(row.event.at);
    if (!days.length || days.at(-1).day !== day) days.push({ day, items: [] });
    days.at(-1).items.push({ id: row.event.id, at: row.event.at, actor: row.event.actor || '', ...row.sentence });
  }
  return days;
}

// Back to where the task runs: the T-Agent terminal it runs in, when that task is in the list of this machine the page shows; else the
// command that resumes the session; null when neither is known. `groups` is `state.taskList.groups` (tasks with their ids).
export function jumpBack(context, { sourceKey, groups } = {}) {
  const tagent = context && context.tagent;
  if (tagent && tagent.task_id != null && tagent.terminal_id && sourceKey === 'local') {
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
