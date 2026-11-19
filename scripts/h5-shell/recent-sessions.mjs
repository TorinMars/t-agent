// The recent sessions of the session switcher ("Session switcher" in docs/design/session-switcher.md): the terminal sessions this page has shown,
// most recently shown first, remembered on this device. Pure functions: h5.js keeps the list (it sees every change of the shown terminal, by any path)
// and stores it with its `store` helper; Switcher.jsx draws it as a stack of cards. An entry is
// { sourceKey, taskId, terminalId, title, agent, lastUsed? }: the device (source key), the task and the terminal, plus the session's name and agent kind
// as they were when it was last shown (a task that is not selected has no terminal list in the page, so its card shows what was seen then), and when it
// was last used (ms; lists stored before 2026-11-19 have no time, and an entry gets one the next time it is shown or left). The "Recent" tab of the task
// list draws the same list as rows (recent-rows.mjs, RecentList.jsx; "Recent tab" in docs/design/page-task-list.md).

export const RECENT_MAX = 12;
const AGENTS = new Set(['claude', 'codex']);

export const recentKey = entry => `${entry.sourceKey}|${entry.taskId}|${entry.terminalId}`;
// The ref h5.js `openRow` takes for the task of an entry (`taskRef`).
export const recentTaskRef = entry => `${entry.sourceKey}|${entry.taskId}`;

// A well-formed entry, or null. The ids are strings (a task id is a number in the API, a string in a ref).
export function cleanEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const sourceKey = typeof entry.sourceKey === 'string' ? entry.sourceKey : '';
  const taskId = entry.taskId === undefined || entry.taskId === null ? '' : String(entry.taskId);
  const terminalId = entry.terminalId === undefined || entry.terminalId === null ? '' : String(entry.terminalId);
  if (!sourceKey || !taskId || !terminalId || sourceKey.length > 200 || taskId.length > 200 || terminalId.length > 200) return null;
  const title = typeof entry.title === 'string' ? entry.title.slice(0, 120) : '';
  const agent = AGENTS.has(entry.agent) ? entry.agent : null;
  const lastUsed = Number(entry.lastUsed);
  return Number.isFinite(lastUsed) && lastUsed > 0 ? { sourceKey, taskId, terminalId, title, agent, lastUsed } : { sourceKey, taskId, terminalId, title, agent };
}

// The list after `entry` was shown: it goes first, an older copy of it goes away, at most `max` entries. The same list comes back when nothing changed.
// With `now` the entry is stamped as used then (`lastUsed`), and with `leave` the entry that was first until now too: it was in use until this moment
// (h5.js passes `leave` only once this page has shown that entry itself, so a list from an earlier visit keeps its times).
export function noteRecent(list, entry, max = RECENT_MAX, { now = null, leave = false } = {}) {
  const clean = cleanEntry(entry);
  const before = Array.isArray(list) ? list : [];
  if (!clean) return before;
  const key = recentKey(clean);
  const first = before[0];
  const same = first && recentKey(first) === key;
  if (same && first.title === clean.title && first.agent === clean.agent && before.length <= max) return before;
  const stamp = item => (now ? { ...item, lastUsed: now } : item);
  const top = same ? (first.lastUsed ? { ...clean, lastUsed: first.lastUsed } : clean) : stamp(clean);
  const rest = before.filter(item => recentKey(item) !== key).map((item, index) => (leave && !same && index === 0 && item === first ? stamp(item) : item));
  return [top, ...rest].slice(0, max);
}

// The list with one entry (by `recentKey`) renamed (`title`, a string) or forgotten (`title` null): a session renamed or deleted from a menu. The same
// list comes back when it has no such entry or the name is the same.
export function editRecent(list, key, title) {
  const before = Array.isArray(list) ? list : [];
  const at = before.findIndex(item => recentKey(item) === key);
  if (at < 0) return before;
  if (title === null) return before.filter((item, index) => index !== at);
  const name = String(title).slice(0, 120);
  if (before[at].title === name) return before;
  return before.map((item, index) => (index === at ? { ...item, title: name } : item));
}

// The entries whose session still exists: its task is in the task list (`tasks`: the rows of `state.taskList.tasks`, each with `source` and `id`), and
// when the terminals of that task are known (`terminals`: { '<sourceKey>|<taskId>': [terminal ids] }), the terminal is one of them. Order is kept.
export function pruneRecent(list, tasks, terminals = {}) {
  const before = Array.isArray(list) ? list : [];
  const listed = new Set((Array.isArray(tasks) ? tasks : []).map(row => `${row.source}|${row.id}`));
  const out = before.filter(entry => {
    const ref = recentTaskRef(entry);
    if (!listed.has(ref)) return false;
    const known = terminals && terminals[ref];
    return !Array.isArray(known) || known.map(String).includes(entry.terminalId);
  });
  return out.length === before.length ? before : out;
}

// The stored form (JSON) and back. Bad or foreign data reads as an empty list; duplicates and extra entries are dropped.
export const serializeRecent = list => JSON.stringify((Array.isArray(list) ? list : []).map(cleanEntry).filter(Boolean).slice(0, RECENT_MAX));
export function parseRecent(text) {
  let data = null;
  try { data = typeof text === 'string' && text ? JSON.parse(text) : null; } catch { return []; }
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of data) {
    const entry = cleanEntry(raw);
    if (!entry || seen.has(recentKey(entry))) continue;
    seen.add(recentKey(entry));
    out.push(entry);
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

// The cards of the switcher, index 0 on top: the shown session first (marked `current`), then the others, most recently shown first. `shown` is
// `state.shownTarget` ({ sourceKey, taskId, terminalId }, null under a chat); when it is not in the list it gets no card of its own.
export function switcherCards(list, shown) {
  const entries = Array.isArray(list) ? list : [];
  const key = shown ? recentKey({ sourceKey: shown.sourceKey, taskId: String(shown.taskId), terminalId: String(shown.terminalId) }) : null;
  const current = key ? entries.find(entry => recentKey(entry) === key) : null;
  const rest = entries.filter(entry => entry !== current);
  return current ? [{ ...current, current: true }, ...rest.map(entry => ({ ...entry, current: false }))] : rest.map(entry => ({ ...entry, current: false }));
}

// Where the switcher opens: the previous session (index 1) when the top card is the current one, else the top card.
export const startIndex = cards => (cards.length > 1 && cards[0].current ? 1 : 0);

// The place of a card in the stack. `rel` is the card's index minus the centred position (a fraction while it moves): 0 is centred, 1, 2, ... lie
// behind it to the left (each `step` px further, about 4% smaller and darker), -1 lies on top, `offset` px to the right (the current card peeking in on
// the first press), -2 and beyond `far` px further right each, off the stack. Between two places everything is interpolated, so a drag moves the
// stack smoothly.
export function cardPlace(rel, { step, offset, far = offset, shrink = 0.04, darken = 0.18, maxDim = 0.72 }) {
  if (rel >= 0) return { x: -rel * step, scale: Math.max(0.5, 1 - shrink * rel), dim: Math.min(maxDim, darken * rel) };
  if (rel >= -1) return { x: -rel * offset, scale: 1, dim: 0 };
  return { x: offset + (-rel - 1) * far, scale: 1, dim: 0 };
}

// The row of the wide switcher: the cards side by side, most recent first from the left, `gap` px apart, never overlapping. The card height follows
// the area (two thirds of it, within the space between the title and the hint), the width is 0.65 of the height, 280 to 380 px, so a wider window
// shows more cards. `xs` are the cards' left edges in the row, `contentW` the row's whole width.
export function switcherRow({ width, height }, count, { pad = 24, gap = 20, top = 86, foot = 56 } = {}) {
  const avail = Math.max(0, height - top - foot);
  const cardH = Math.max(160, Math.min(avail, Math.round(height * 0.66)));
  const cardW = Math.max(280, Math.min(380, Math.round(cardH * 0.65)));
  const xs = Array.from({ length: count }, (_, index) => pad + index * (cardW + gap));
  return { cardW, cardH, top, pad, gap, xs, contentW: count ? pad * 2 + count * cardW + (count - 1) * gap : width };
}

// The scroll position of the row that shows card `index` whole (with the side padding), moving as little as possible from `scroll`.
export function rowScrollFor(row, index, scroll, width) {
  const left = row.xs[index];
  if (left === undefined) return scroll;
  let next = scroll;
  if (left + row.cardW + row.pad > next + width) next = left + row.cardW + row.pad - width;
  if (left - row.pad < next) next = left - row.pad;
  return Math.max(0, Math.min(Math.max(0, row.contentW - width), next));
}

// The card to select after the row was scrolled by hand: the selected one while at least 60% of it is in view, else the one most in view (the
// leftmost of equals).
export function rowPick(row, selected, scroll, width) {
  const seen = left => Math.max(0, Math.min(left + row.cardW, scroll + width) - Math.max(left, scroll)) / row.cardW;
  if (row.xs[selected] !== undefined && seen(row.xs[selected]) >= 0.6) return selected;
  let best = selected;
  let most = -1;
  row.xs.forEach((left, index) => { const part = seen(left); if (part > most + 1e-9) { most = part; best = index; } });
  return best;
}

// The centred card after a drag or a key: the nearest whole index inside the stack.
export const settleIndex = (position, count) => Math.max(0, Math.min(Math.max(0, count - 1), Math.round(Number(position) || 0)));
