// The rules of "Plan usage" in the session header ("Plan usage: the page" in docs/design/plan-usage-page.md), kept apart from React so they can be
// tested directly: which engine's reading the header shows, the bars of each agent (plan left and time left of its 5-hour and 7-day windows), the low
// mark, a window whose reset has passed, the pace projection, and every English text of the button and its details (the page translates them with
// the templates in public/js/i18n-zh-extra.js). The server half answers `GET {base}/agent-usage` with { engine, agents: [Usage] }.
import { limitBars, visibleLimits, windowMs } from '../agent-chat/format.mjs';

export const USAGE_CAPABILITY = 'agent-usage:read';
export const POLL_MS = 5 * 60000; // the GET while the page is visible
export const RUNNING_POLL_MS = 60000; // the GET while a Claude or Codex session of the shown engine runs (the server reads every minute then)
export const VISIBLE_STALE_MS = 60000; // a page shown again reads at once when its last GET is older than this
export const TURN_DELAY_MS = 10000; // the GET after a Claude or Codex session of the shown engine stops running
export const TURN_GAP_MS = 30000; // at most one such extra GET in this time
export const LOW_LEFT = 10; // percent left at or under which a plan is low (the warning colour, and its number beside the bars on a computer)
export const AGENTS = ['claude', 'codex'];
export const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' };
export const WINDOW_NAMES = { '5h': '5 hours', '7d': '7 days' };
const WINDOW_IDS = ['5h', '7d'];
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const identity = text => text;

// The API base of an engine of the task list: this machine's own, or a connected service's through this Client's proxy.
export const usageBase = key => (!key || key === 'local' ? '/api' : `/api/remote-servers/${String(key).replace(/^remote:/, '')}`);

// The engines the page asks: this machine always, and every listed service whose `/info` lists the capability (an offline one too: its last reading
// stays, dimmed). `sources` is h5.js `state.sources`.
export function usageEngines(sources) {
  const list = Array.isArray(sources) ? sources.filter(source => source && source.key) : [];
  const local = list.find(source => source.key === 'local') || { key: 'local', label: 'This machine', name: '' };
  const remote = list.filter(source => source.key !== 'local' && source.listed === true && Array.isArray(source.capabilities) && source.capabilities.includes(USAGE_CAPABILITY));
  return [local, ...remote].map(source => ({ key: source.key, name: engineName(source), offline: source.key !== 'local' && Boolean(source.offline) }));
}
// An engine's name as the page names devices ("Labels" in docs/design/entry-symmetry.md): this machine by its engine name, else "This machine".
export const engineName = source => (!source ? '' : source.key === 'local' ? source.name || 'This machine' : source.label || '');

// The engine whose reading the header shows: the shown task's (`taskName` is set while a task is shown, `sourceKey` is its service), this machine
// when none is shown.
export const shownKeyOf = state => (state && state.taskName && state.sourceKey ? state.sourceKey : 'local');

// ── Times ──
const pad = value => String(value).padStart(2, '0');
export const clock = ms => { const date = new Date(ms); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };
export const dayClock = ms => `${WEEKDAYS[new Date(ms).getDay()]} ${clock(ms)}`;
// A span in two units: "2 d 19 h", "3 h 10 min", "45 min" (at least "1 min").
export function spanText(ms) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return hours ? `${days} d ${hours} h` : `${days} d`;
  if (hours) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  return `${rest} min`;
}
// A span in one rounded unit: "40 min", "2 h", "1 day", "3 days".
export function aboutText(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < DAY) return `${Math.max(1, Math.round(ms / HOUR))} h`;
  const days = Math.round(ms / DAY);
  return days === 1 ? '1 day' : `${days} days`;
}
// When a reading was taken: "read just now", "read 2 min ago", "read 3 h ago", "read 2 days ago".
export const ageText = (readAt, now) => (now - readAt < MINUTE ? 'read just now' : `read ${aboutText(now - readAt)} ago`);

// ── One window ──
// The pace projection: from the used share over the elapsed share of the window at the reading, when would the plan run out? A line only when that is
// more than 10 minutes and more than 2% of the window before the reset. Returns the English line, or ''.
export function paceText(entry, at) {
  const length = windowMs(entry.label || entry.id);
  const used = Number(entry.usedPercent);
  if (!length || !entry.resetsAt || !(used > 0) || used >= 100) return '';
  const start = entry.resetsAt - length;
  const elapsed = at - start;
  if (elapsed <= 0) return '';
  const runsOutAt = start + elapsed * (100 / used);
  const early = entry.resetsAt - runsOutAt;
  if (early <= Math.max(10 * MINUTE, 0.02 * length)) return '';
  return `At this pace it runs out about ${aboutText(early)} before the reset`;
}

// A window as the page draws it: { id, short ('5h'), label ('5 hours'), left (whole percent left), plan and time (0..1, the bar heights), low, passed,
// resetText, pace }. A window whose reset time has passed was read before it reset: the plan is full again and "reset at 18:30, not read since".
export function windowView(entry, now, readAt = now) {
  const id = entry.id || entry.label;
  const label = WINDOW_NAMES[id] || String(entry.label || id || '');
  const passed = Boolean(entry.resetsAt) && !visibleLimits([entry], now).length;
  if (passed) {
    const when = now - entry.resetsAt < DAY ? clock(entry.resetsAt) : dayClock(entry.resetsAt);
    return { id, short: entry.label || id, label, left: 100, plan: 1, time: 1, low: false, passed: true, resetText: `reset at ${when}, not read since`, pace: '' };
  }
  const bars = limitBars({ ...entry, label: entry.label || id }, now);
  const exact = Math.max(0, Math.min(100, 100 - Number(entry.usedPercent || 0)));
  const left = Math.round(exact);
  let resetText = '';
  if (entry.resetsAt) resetText = entry.resetsAt - now < DAY ? `resets in ${spanText(entry.resetsAt - now)} · ${clock(entry.resetsAt)}` : `resets ${dayClock(entry.resetsAt)}`;
  return { id, short: entry.label || id, label, left, plan: bars.usage, time: bars.time, low: exact <= LOW_LEFT, passed: false, resetText, pace: paceText(entry, readAt || now) };
}

// ── One agent ──
// { agent, name, state, account, readAt, windows (state ok: the 5-hour then the 7-day window), inBars (ok or not_read: drawn in the header),
//   outlined (not_read: bars without fill), lowText ("7d 8%": the low windows, shown beside the bars on a computer) }.
export function agentView(usage, now) {
  const agent = usage && usage.agent;
  const state = ['ok', 'not_read', 'signed_out', 'no_plan', 'error'].includes(usage && usage.state) ? usage.state : 'error';
  const readAt = Number(usage && usage.read_at) || null;
  const entries = state === 'ok' && Array.isArray(usage.windows) ? usage.windows.filter(entry => entry && WINDOW_IDS.includes(entry.id || entry.label)) : [];
  entries.sort((a, b) => WINDOW_IDS.indexOf(a.id || a.label) - WINDOW_IDS.indexOf(b.id || b.label));
  const windows = entries.map(entry => windowView(entry, now, readAt || now));
  const inBars = state === 'not_read' || (state === 'ok' && windows.length > 0);
  return {
    agent, name: AGENT_NAMES[agent] || String(agent || ''), state, account: (usage && usage.account) || null, readAt, windows, inBars,
    outlined: state === 'not_read' || (state === 'ok' && !windows.length),
    lowText: windows.filter(view => view.low).map(view => `${view.short} ${view.left}%`).join(' '),
  };
}
// The agents of an answer, Claude then Codex.
export function agentsOf(answer, now) {
  const list = answer && Array.isArray(answer.agents) ? answer.agents.filter(usage => usage && AGENTS.includes(usage.agent)) : [];
  list.sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent));
  return list.map(usage => agentView(usage, now));
}
// The four bars of an agent in the header, each { kind: 'plan' | 'time', window, value (0..1), low }: 5h plan, 5h time, 7d plan, 7d time. Without a
// reading (not_read) the four are outlined and empty.
export function barsOf(view) {
  if (view.outlined) return WINDOW_IDS.flatMap(id => [{ kind: 'plan', window: id, value: 0, low: false }, { kind: 'time', window: id, value: 0, low: false }]);
  return view.windows.flatMap(win => [{ kind: 'plan', window: win.id, value: win.plan, low: win.low }, { kind: 'time', window: win.id, value: win.time, low: false }]);
}

// The name of the button (its aria-label and title): "Plan usage: Claude 5 hours 62% left, 7 days 81% left; Codex 5 hours 24% left, 7 days 8% left".
// `tr` translates each piece (the page's t()).
export function buttonLabel(agents, tr = identity) {
  const parts = agents.filter(view => view.inBars).map(view => {
    if (view.outlined) return `${view.name} ${tr('not read yet')}`;
    return `${view.name} ${view.windows.map(win => tr(`${win.label} ${win.left}% left`)).join(', ')}`;
  });
  return parts.length ? `${tr('Plan usage')}: ${parts.join('; ')}` : tr('Plan usage');
}

// ── The whole view ──
// readings: { [engine key]: { status: 'ok' | 'offline' | 'missing', answer, fetchedAt } } (plan-usage-feed.mjs). The header shows the shown task's engine;
// when that engine has no plan usage at all (an older version: no capability, or its GET answered 404) it shows this machine's, and the details say so.
// Returns null when there is nothing to show (no engine answered with any agent).
export function usageModel({ readings = {}, sources = [], shownKey = 'local', now = Date.now() } = {}) {
  const engines = usageEngines(sources);
  const byKey = new Map(engines.map(engine => [engine.key, engine]));
  const source = Array.isArray(sources) ? sources.find(item => item && item.key === shownKey) : null;
  const wanted = byKey.get(shownKey);
  const usable = key => { const reading = readings[key]; return reading && reading.answer && Array.isArray(reading.answer.agents) && reading.status !== 'missing'; };
  let key = shownKey;
  let olderNote = '';
  if (!wanted || (readings[shownKey] && readings[shownKey].status === 'missing')) {
    key = 'local';
    if (shownKey !== 'local' && source) olderNote = `${engineName(source)} cannot report plan usage until it is updated.`;
  }
  if (!usable(key)) return null;
  const engine = byKey.get(key) || { key, name: 'This machine', offline: false };
  const reading = readings[key];
  const offline = reading.status === 'offline' || engine.offline;
  const name = engine.name || (reading.answer.engine && reading.answer.engine.name) || '';
  const agents = agentsOf(reading.answer, now);
  if (!agents.length) return null;
  const readAts = agents.map(view => view.readAt).filter(Boolean);
  const readAt = readAts.length ? Math.max(...readAts) : null;
  const header = offline
    ? `${name} is offline · ${readAt ? ageText(readAt, now) : 'not read yet'}`
    : readAt ? `${name} · ${ageText(readAt, now)}` : `${name} · not read yet`;
  return {
    key, name, offline, agents, inBars: agents.filter(view => view.inBars), header, olderNote,
    details: agents.map(view => ({ ...view, message: agentMessage(view, name) })),
    others: otherLines({ shown: { key, agents }, readings, engines, now }),
  };
}
// The line of an agent that has no rows in the details.
export function agentMessage(view, engine) {
  if (view.state === 'not_read' || (view.state === 'ok' && !view.windows.length)) return 'Not read yet';
  if (view.state === 'signed_out') return `${view.name} is not signed in on ${engine}`;
  if (view.state === 'no_plan') return `${view.name} on ${engine} reports no plan limits (an API key, or not signed in)`;
  if (view.state === 'error') return `Could not read ${view.name} on ${engine}`;
  return '';
}
const windowsText = view => view.windows.map(win => `${win.label} ${win.left}% left`).join(', ');

// The lines about the other engines that report plan usage: an offline one with the age of its last reading; per agent, the engines on the same
// account as the shown one in one line ("K01 uses the same Claude account."), the others grouped by their account hash with the numbers of the newest
// reading ("Codex on K01: another account, 5 hours 71% left, 7 days 66% left."), an account that is not known with its own numbers, and the agents
// that are not signed in or could not be read.
export function otherLines({ shown, readings = {}, engines = [], now = Date.now() }) {
  const lines = [];
  const others = engines.filter(engine => engine.key !== shown.key && readings[engine.key] && readings[engine.key].answer && readings[engine.key].status !== 'missing');
  const live = [];
  for (const engine of others) {
    const reading = readings[engine.key];
    const agents = agentsOf(reading.answer, now);
    if (reading.status === 'offline' || engine.offline) {
      const readAts = agents.map(view => view.readAt).filter(Boolean);
      lines.push(`${engine.name} is offline · ${readAts.length ? ageText(Math.max(...readAts), now) : 'not read yet'}`);
    } else live.push({ engine, agents });
  }
  const names = list => list.map(item => item.engine.name).join(', ');
  for (const agent of AGENTS) {
    const mine = shown.agents.find(view => view.agent === agent);
    const account = mine && mine.account;
    const entries = live.map(item => ({ engine: item.engine, view: item.agents.find(view => view.agent === agent) })).filter(item => item.view);
    if (!entries.length) continue;
    const name = AGENT_NAMES[agent];
    const same = entries.filter(item => account && item.view.account === account && (item.view.state === 'ok' || item.view.state === 'not_read'));
    if (same.length) lines.push(`${names(same)} ${same.length === 1 ? 'uses' : 'use'} the same ${name} account.`);
    const groups = new Map(); // account hash (or the engine key for an unknown account) -> entries
    for (const item of entries) {
      if (same.includes(item)) continue;
      const { view } = item;
      if (view.state === 'signed_out') { lines.push(`${name} is not signed in on ${item.engine.name}`); continue; }
      if (view.state === 'error') { lines.push(`Could not read ${name} on ${item.engine.name}`); continue; }
      const group = view.account ? `a:${view.account}` : `e:${item.engine.key}`;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(item);
    }
    for (const [group, items] of groups) {
      const newest = items.reduce((best, item) => ((item.view.readAt || 0) > (best.view.readAt || 0) ? item : best));
      if (!newest.view.windows.length) lines.push(`${name} on ${names(items)}: not read yet.`);
      else if (group.startsWith('a:') && account) lines.push(`${name} on ${names(items)}: another account, ${windowsText(newest.view)}.`);
      else lines.push(`${name} on ${names(items)}, account unknown: ${windowsText(newest.view)}.`);
    }
  }
  return lines;
}

// ── Running sessions ──
// The sessions of an engine that run now, as "<task id>|<terminal id>", from the page's pushed terminal activity (`state.terminalActivity`, h5.js
// `publishActivity`). Only Claude and Codex sessions count: a session the task list names with another kind (a shell notebook running a cell,
// OpenCode, a plain shell) is left out; one it does not list (a folded task) counts, since only agents report running there.
export function runningSessions(state, key) {
  const tasks = (state && state.terminalActivity && state.terminalActivity[key]) || {};
  const kinds = new Map();
  for (const row of (state && state.taskList && Array.isArray(state.taskList.tasks) ? state.taskList.tasks : [])) {
    if (!row || (row.source && row.source !== key) || !row.sessions || !Array.isArray(row.sessions.rows)) continue;
    for (const session of row.sessions.rows) if (session && session.kind === 'terminal') kinds.set(`${row.id}|${session.id}`, session.agent || 'shell');
  }
  const out = new Set();
  for (const [taskId, terminals] of Object.entries(tasks)) {
    for (const [terminalId, value] of Object.entries(terminals || {})) {
      if (value !== 'running') continue;
      const id = `${taskId}|${terminalId}`;
      const kind = kinds.get(id);
      if (!kind || AGENTS.includes(kind)) out.add(id);
    }
  }
  return out;
}
