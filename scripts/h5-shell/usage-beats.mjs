// The rules of page time ("Page time" in docs/design/usage-time-page.md): pure functions, no DOM, so they are tested on their own
// (test/h5-usage-beats.test.js). usage-time.mjs wires them to the page: the clock, the activity listeners, visibility, the switch and the sending.
// A beat is 15 seconds of the person on the page: the page is visible AND there was a key, a pointer, a touch or a wheel in the last 2 minutes. What
// a beat names comes from the store only: the surface, the kind of the shown session and engine-neutral ids of its task and session (the engine's
// instance id with the task and terminal ids, as the shared page state names them). Never a title, a path or text.

export const IDLE_MS = 2 * 60 * 1000; // no activity for this long: the clock stops
export const STEP_MS = 15 * 1000; // one beat per step while active
export const STEP_S = 15;
export const BATCH_MAX = 40; // beats in one request at most (the server refuses more)
export const FLUSH_MS = 2 * 60 * 1000; // a batch goes this long after its first beat (8 beats), or at once when it is full
// The events that count as activity, and the message a pane sends its top page (usage-time.mjs keeps the same two, so the first screen does not
// import this module and the sender chunk stays apart from it).
export const ACTIVITY = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'];
export const MESSAGE = 't-agent-activity';
export const SURFACES = ['sessions', 'learn', 'mindmaps', 'attention', 'settings', 'other'];
const KINDS = new Set(['claude', 'codex', 'opencode', 'notebook']);

// Whether the clock runs at `now`: visible, and the last activity at most IDLE_MS ago (0: none yet).
export const isActive = (now, lastActivity, visible) => Boolean(visible) && lastActivity > 0 && now - lastActivity >= 0 && now - lastActivity <= IDLE_MS;

// The part of the page the person looks at, from the store. The screens that lie over the sessions win (Settings, Learn, T-Attention); then the
// multi-column view (its Mind maps tab, else its columns); then the full-window mind map view; then a shown session; anything else (the task list
// with no session) is `other`.
export function surfaceOf(s) {
  if (!s) return 'other';
  if (s.settingsOpen) return 'settings';
  if (s.learnOpen) return 'learn';
  if (s.attention && s.attention.open) return 'attention';
  const columns = s.columns && s.columns.shown ? s.columns.tab || 'columns' : null;
  if (columns === 'maps' || (!columns && s.mindmapOpen)) return 'mindmaps';
  if (columns) return 'sessions';
  if (s.shownTarget || s.notebook) return 'sessions';
  return 'other';
}

// The session shown: { target: { sourceKey, taskId, terminalId } | null, agent }. In the multi-column view it is the focused column's (its pane
// reports it to the top page, Columns.jsx `titles`); otherwise the page's own (h5.js `shownTarget`, `terminalAgent`, `notebook`).
export function shownOf(s) {
  if (s && s.columns && s.columns.shown && (s.columns.tab || 'columns') === 'columns') {
    const info = s.columns.focus && s.columns.titles ? s.columns.titles[s.columns.focus] : null;
    return { target: (info && info.target) || null, agent: (info && info.agent) || null };
  }
  return { target: (s && s.shownTarget) || null, agent: s && s.notebook ? 'notebook' : (s && s.terminalAgent) || null };
}

// Engine-neutral ids: `<instance id>:<task id>` for a task (the shared task order's form) and `<instance id>:<task id>:<terminal id>` for a
// session. A device whose instance id is not known (an older engine, the list not read yet) gives null: the beat then names no task.
export function neutralIds(target, sources) {
  if (!target || target.taskId === undefined || target.taskId === null) return { task: null, session: null };
  const from = (Array.isArray(sources) ? sources : []).find(item => item && item.key === target.sourceKey);
  const instance = from && typeof from.instanceId === 'string' && from.instanceId ? from.instanceId : null;
  if (!instance) return { task: null, session: null };
  const task = `${instance}:${target.taskId}`;
  const terminal = target.terminalId === undefined || target.terminalId === null || target.terminalId === '' ? null : String(target.terminalId);
  return { task, session: terminal ? `${task}:${terminal}` : null };
}

// One beat at `now` from the store's state `s` (its `sources` name the devices): { at, surface, kind, task, session, seconds }. Task, session and
// kind belong to a shown session only, so a beat in Settings or Learn names none.
export function beatOf(s, now) {
  const surface = surfaceOf(s);
  if (surface !== 'sessions') return { at: now, surface, kind: null, task: null, session: null, seconds: STEP_S };
  const { target, agent } = shownOf(s);
  const ids = neutralIds(target, s && s.sources);
  const kind = target ? (KINDS.has(agent) ? agent : 'terminal') : null;
  return { at: now, surface, kind, task: ids.task, session: ids.session, seconds: STEP_S };
}

// Splits a queue into the batch to send now (at most BATCH_MAX, oldest first) and the rest.
export function takeBatch(queue, max = BATCH_MAX) {
  const list = Array.isArray(queue) ? queue : [];
  return [list.slice(0, max), list.slice(max)];
}

// Whether a batch should go at `now`: it is full, or its first beat is FLUSH_MS old.
export const flushDue = (queue, now) => Array.isArray(queue) && queue.length > 0 && (queue.length >= BATCH_MAX || now - queue[0].at >= FLUSH_MS);

// Several tabs of the page: only the one with the newest activity counts. `mine` is this tab's { id, last }, `others` the newest activity heard
// from the other tabs ({ id: last }). A tie goes to the smaller id, so exactly one tab wins.
export function isOwner(mine, others) {
  for (const [id, last] of Object.entries(others || {})) {
    if (last > mine.last || (last === mine.last && id < mine.id)) return false;
  }
  return true;
}

// The kind of client, as the server names it for button use ("Usage data" in docs/design/usage-data.md): the Mac app, a phone or a computer.
export function clientOf(userAgent) {
  const ua = String(userAgent || '');
  if (/ T-AgentApp\//.test(ua)) return 'mac-app';
  if (/iPhone|iPad|iPod|Android|Mobile/.test(ua)) return 'phone';
  return 'computer';
}
