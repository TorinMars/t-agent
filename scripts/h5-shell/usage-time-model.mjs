// The words and numbers of the Time and Memories tabs of Settings > Usage data (UsageTime.jsx, UsageMemories.jsx; "Usage time and memories: the page"
// in docs/design/usage-time-page.md). Pure functions, tested in test/h5-usage-time-model.test.js. `t` translates (the page's I18n.t); every text is
// built in English first, whole, and translated as one sentence.

const plain = text => text;

// The page's source key and task id of an engine-neutral task or session id, or null (a device this page does not list).
export function refOfNeutral(id, sources) {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts.length < 2) return null;
  const [instance, taskId, ...rest] = parts;
  const from = (Array.isArray(sources) ? sources : []).find(item => item && item.instanceId === instance);
  if (!from || !taskId) return null;
  return { sourceKey: from.key, taskId, terminalId: rest.length ? rest.join(':') : null };
}

export const RANGES = [['week', 'This week'], ['today', 'Today'], ['30d', '30 days']];
const BEFORE = { today: 'yesterday', week: 'last week', '30d': 'the 30 days before' };
const RANGE_DAYS = { today: 1, week: 7, '30d': 30 };
export const rangeDays = range => RANGE_DAYS[range] || 7;

// "23 h 40 min", "28 h", "6 min", "0 min" (a few seconds count as a minute, so time that was there never reads as none).
export function duration(seconds, t = plain) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = total > 0 ? Math.max(1, Math.round(total / 60)) : 0;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return t(`${m} min`);
  if (!m) return t(`${h} h`);
  return t(`${h} h ${String(m).padStart(2, '0')} min`);
}

// The change from the previous period: "+2 h 10 min vs last week", "−5 min vs yesterday", "Same as last week". The sign is in the text, so the colour
// is never the only sign of the direction. `tone`: 'up' | 'down' | 'same'.
export function delta(seconds, range, t = plain) {
  const before = BEFORE[range] || BEFORE.week;
  const value = Math.round(Number(seconds) || 0);
  if (!Number.isFinite(value) || Math.abs(value) < 60) return { text: t(`Same as ${before}`), tone: 'same' };
  const amount = duration(Math.abs(value));
  return value > 0 ? { text: t(`+${amount} vs ${before}`), tone: 'up' } : { text: t(`−${amount} vs ${before}`), tone: 'down' };
}

// The four tiles of the design (frame 1): the value, the change and the line under it.
export function tiles(summary, range, t = plain) {
  const x = (summary && summary.tiles) || {};
  const days = rangeDays(range);
  return [
    { id: 'page', label: t('On the page'), value: duration(x.page_s, t), delta: delta(x.page_delta, range, t), note: '' },
    { id: 'working', label: t('Agents working'), value: duration(x.working_s, t), delta: delta(x.working_delta, range, t), note: t(`while you were away: ${duration(x.away_working_s)}`) },
    { id: 'waiting', label: t('Waiting for you'), value: duration(x.waiting_s, t), delta: delta(x.waiting_delta, range, t), note: t(`median wait ${duration(x.median_wait_s)}`) },
    { id: 'learn', label: t('Learn English'), value: duration(x.learn_s, t), delta: delta(x.learn_delta, range, t), note: t(`${Math.max(0, Number(x.learn_days) || 0)} of ${days} days`) },
  ];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// `day` is 'YYYY-MM-DD' (the person's calendar day). Its weekday, its month-day and both.
const dateOfDay = day => { const [y, m, d] = String(day).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
export const weekday = (day, t = plain) => t(WEEKDAYS[dateOfDay(day).getDay()]);
export const monthDay = day => String(day).slice(5);
export const dayName = (day, t = plain) => `${weekday(day, t)} ${monthDay(day)}`;

export const SERIES = [['sessions_s', 'Sessions'], ['learn_s', 'Learn'], ['other_s', 'Other']];
// The stacked bars: per day the parts (Sessions, Learn, Other) with their seconds, the total and the height relative to the highest day (0..1); the
// label under it (a weekday for a week, the day of the month for 30 days, shown on every fifth day there) and the sentence a hover or focus shows.
export function bars(days, range, t = plain) {
  const list = Array.isArray(days) ? days : [];
  const totals = list.map(row => SERIES.reduce((sum, [key]) => sum + Math.max(0, Number(row[key]) || 0), 0));
  const max = Math.max(0, ...totals);
  return list.map((row, index) => {
    const parts = SERIES.map(([key, name]) => ({ key, name: t(name), seconds: Math.max(0, Number(row[key]) || 0) }));
    const label = range === '30d' ? (index % 5 === 0 || index === list.length - 1 ? String(Number(monthDay(row.day).slice(3))) : '') : weekday(row.day, t);
    const text = `${dayName(row.day, t)}: ${parts.map(part => `${part.name} ${duration(part.seconds, t)}`).join(', ')}`;
    return { day: row.day, label, parts, total: totals[index], height: max ? totals[index] / max : 0, text };
  });
}

// "12 h 20 min / 28 h": looked at / agent worked.
export const lookedText = (row, t = plain) => `${duration(row && row.looked_s, t)} / ${duration(row && row.worked_s, t)}`;
// The looked-at bar of a task, relative to the task looked at most (0..1).
export function taskRows(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const max = Math.max(0, ...list.map(row => Number(row.looked_s) || 0));
  return list.map(row => ({ ...row, share: max ? (Number(row.looked_s) || 0) / max : 0 }));
}

const KIND_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', terminal: 'terminals', notebook: 'notebooks' };
export const KIND_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', terminal: 'Terminal', notebook: 'Notebook' };
// "Kinds of session: Claude 62%, Codex 21%, terminals 12%, notebooks 5%." A share is a fraction (0..1) or a percentage (above 1). '' with none.
export function kindsLine(kinds, t = plain) {
  const list = (Array.isArray(kinds) ? kinds : []).filter(row => row && KIND_NAMES[row.kind] && Number(row.share) > 0);
  if (!list.length) return '';
  const percent = share => Math.round(Number(share) <= 1 ? Number(share) * 100 : Number(share));
  return t(`Kinds of session: ${list.map(row => `${t(KIND_NAMES[row.kind])} ${percent(row.share)}%`).join(', ')}.`);
}

// The devices of the device chip: All devices, then each device of the summary; then the page's devices whose engine does not offer `usage:time`
// yet (`sources` of the store: a remote device that said what it can do without it), each "needs an update first" and not selectable.
export function deviceChoices(summary, sources, t = plain) {
  const known = (summary && Array.isArray(summary.devices) ? summary.devices : []).filter(row => row && row.id).map(row => ({ id: String(row.id), name: String(row.name || row.id), old: false }));
  const ids = new Set(known.map(row => row.id));
  const old = (Array.isArray(sources) ? sources : [])
    .filter(from => from && from.key !== 'local' && Array.isArray(from.capabilities) && !from.capabilities.includes('usage:time') && !(from.instanceId && ids.has(from.instanceId)))
    .map(from => ({ id: from.instanceId || from.key, name: String(from.label || from.name || ''), old: true, note: t(`${from.label || from.name} needs an update first`) }));
  return [{ id: 'all', name: t('All devices'), old: false }, ...known, ...old];
}

// ── Memories ──
export const MEMORY_KINDS = [['all', 'All'], ['event', 'Events'], ['note', 'Notes'], ['digest', 'Digests']];
// The colour of an entry's dot (a theme colour) and the word that says the same in text: an entry is never told apart by its colour alone.
export function memoryLook(item) {
  const kind = item && item.kind;
  if (kind === 'note') return { color: 'warning.light', word: 'your note' };
  if (kind === 'digest') return { color: 'primary.main', word: 'digest' };
  const code = String((item && item.event) || '');
  if (/fail|down|error|lost/i.test(code)) return { color: 'error.light', word: 'event' };
  if (/learn|practice|spell|coach/i.test(code)) return { color: 'primary.main', word: 'event' };
  return { color: 'success.light', word: 'event' };
}
// The date of an entry in the person's time zone, "11-24".
export const memoryDate = at => { const d = new Date(Number(at)); return Number.isFinite(d.getTime()) ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''; };

// Where an entry belongs, as parts of the line under it: [{ text, name }] where `name` marks a task or session title (user content: never
// translated), then the kind word. "Task SELF-TAGENT · event", "SELF-TAGENT · main dev · your note", "Learn · event", "Engines · event".
// `titles(id)` gives the title of a task or session the page knows (the task list), else ''; the server's own `task_title` / `session_title` win.
export function memoryWhere(item, titles = () => '', t = plain) {
  const look = memoryLook(item);
  const parts = [];
  const code = String((item && item.event) || '');
  const taskTitle = (item && item.task_title) || (item && item.task ? titles(item.task) : '');
  const sessionTitle = (item && item.session_title) || (item && item.session ? titles(item.session) : '');
  if (item && item.kind === 'event' && /learn|practice|spell|coach/i.test(code) && !taskTitle) parts.push({ text: t('Learn') });
  else if (item && item.kind === 'event' && /engine|link/i.test(code) && !taskTitle) parts.push({ text: t('Engines') });
  else if (taskTitle && item.kind === 'event') { parts.push({ text: t('Task') }); parts.push({ text: taskTitle, name: true, join: ' ' }); }
  else if (taskTitle) parts.push({ text: taskTitle, name: true });
  if (sessionTitle && item.kind === 'note') parts.push({ text: sessionTitle, name: true });
  parts.push({ text: t(look.word) });
  return parts;
}

// The page's target of an entry: { sourceKey, taskId, terminalId } (terminalId null for a task alone), or null when this page does not list its
// device. The session id wins over the task id.
export function memoryTarget(item, sources) {
  if (!item) return null;
  return refOfNeutral(item.session, sources) || refOfNeutral(item.task, sources);
}

// Opens a task or a session of an entry or a time row through the page's own actions (h5.js): the Settings page closes first. Returns whether it could.
export function openTarget(ui, target) {
  if (!target || !ui || !ui.actions) return false;
  if (ui.actions.closeSettings) ui.actions.closeSettings();
  const taskId = Number(target.taskId);
  if (target.terminalId && ui.actions.openTerminalLink && Number.isSafeInteger(taskId)) {
    void ui.actions.openTerminalLink({ sourceKey: target.sourceKey, taskId, terminalId: String(target.terminalId) });
    return true;
  }
  if (ui.actions.openRow) { ui.actions.openRow(`${target.sourceKey}|${target.taskId}`, { kind: 'task' }); return true; }
  return false;
}

// The title of a task or session the page knows, by its engine-neutral id: the task list's rows (`state.taskList.tasks`, each with `source`, `id`,
// `title` and the `sessions` shown under it).
export function titleLookup(state) {
  const sources = (state && state.sources) || [];
  const rows = (state && state.taskList && Array.isArray(state.taskList.tasks)) ? state.taskList.tasks : [];
  return id => {
    const ref = refOfNeutral(id, sources);
    if (!ref) return '';
    const row = rows.find(item => item.source === ref.sourceKey && String(item.id) === String(ref.taskId));
    if (!row) return '';
    if (!ref.terminalId) return row.title || '';
    const list = row.sessions && Array.isArray(row.sessions.rows) ? row.sessions.rows : [];
    const session = list.find(entry => entry && entry.kind === 'terminal' && String(entry.id) === String(ref.terminalId));
    return session ? session.title || '' : '';
  };
}

// The digest card's heading: "This week, in short" for the current week, else "Week of 11-17"; and when it was written ("written Sun 21:00").
export function digestHeading(digest, now = Date.now(), t = plain) {
  const at = new Date(Number(digest && digest.at) || now);
  const written = `${t(WEEKDAYS[at.getDay()])} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const ageDays = (now - at.getTime()) / 86400000;
  const title = ageDays < 7 ? t('This week, in short') : t(`Week of ${digest && digest.week ? String(digest.week).slice(5) : memoryDate(at.getTime())}`);
  return { title, written: t(`written ${written}`) };
}
