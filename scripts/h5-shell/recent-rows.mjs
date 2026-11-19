// The rows of the "Recent" tab of the task list ("Recent tab" in docs/design/page-task-list.md): the recent sessions of the switcher
// (recent-sessions.mjs) with their task, device, state and the time they were last used, and what the search field and the filter chips keep. Pure
// functions, used only by the tab's lazy chunk (RecentList.jsx), so the first screen does not carry them.
import { recentKey, recentTaskRef, switcherCards } from './recent-sessions.mjs';

const KINDS = { claude: 'Claude session', codex: 'Codex session' };
// The rows of the tab: the switcher's cards in their order (the shown session first, then the others, most recently used first), each with what the
// task list knows of its task (`tasks`: the rows of `state.taskList.tasks`; `taskTitle`, `device` when the list tags its rows) and its live state
// (`statusOf(entry)`: 'running' | 'waiting' | 'idle', the header's rule). `name` is the session's name, else (`named` false) its kind in English, which
// the page translates.
export function recentRows(list, { shown = null, tasks = [], statusOf = () => 'idle' } = {}) {
  const byRef = new Map((Array.isArray(tasks) ? tasks : []).map(row => [`${row.source}|${row.id}`, row]));
  return switcherCards(list, shown).map(entry => {
    const ref = recentTaskRef(entry);
    const task = byRef.get(ref);
    return {
      key: recentKey(entry), ref, sourceKey: entry.sourceKey, taskId: entry.taskId, terminalId: entry.terminalId, agent: entry.agent,
      name: entry.title || KINDS[entry.agent] || 'Terminal', named: Boolean(entry.title), taskTitle: (task && task.title) || '', device: (task && task.device) || null,
      status: statusOf(entry) || 'idle', current: entry.current, lastUsed: entry.lastUsed || null,
    };
  });
}

// The rows a search and a filter chip keep: the search matches the session's name or its task's name (any case); `running` keeps the running sessions,
// `pending` the ones that need the person, `all` every row. Order is kept.
export function filterRecent(rows, query = '', filter = 'all') {
  const needle = String(query || '').trim().toLowerCase();
  const state = filter === 'running' ? 'running' : filter === 'pending' ? 'waiting' : null;
  return (Array.isArray(rows) ? rows : []).filter(row => (!state || row.status === state)
    && (!needle || row.name.toLowerCase().includes(needle) || row.taskTitle.toLowerCase().includes(needle)));
}

// How many rows are in each state, for the counts of the filter chips in the tab.
export const recentCounts = rows => (Array.isArray(rows) ? rows : []).reduce((sum, row) => ({
  running: sum.running + (row.status === 'running' ? 1 : 0), pending: sum.pending + (row.status === 'waiting' ? 1 : 0),
}), { running: 0, pending: 0 });

// When a session was last used, in English pieces the page translates: { count, word } for "2 min ago" (count 2, word 'min ago'), "1 h ago", "2 days
// ago", or { count: 0, word } for "just now" and "yesterday" (the saved commands' steps, command-recency.mjs `usedLabel`); null without a time.
export function recentWhen(at, now = Date.now()) {
  const time = Number(at);
  if (!Number.isFinite(time) || time <= 0) return null;
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  if (minutes < 1) return { count: 0, word: 'just now' };
  if (minutes < 60) return { count: minutes, word: 'min ago' };
  if (minutes < 1440) return { count: Math.floor(minutes / 60), word: 'h ago' };
  const days = Math.floor(minutes / 1440);
  return days === 1 ? { count: 0, word: 'yesterday' } : { count: days, word: 'days ago' };
}
