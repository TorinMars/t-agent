// Small text helpers of the chat footer (kept apart from React so they can be tested directly).

// A number with at most one decimal and no trailing ".0": 4.25 -> "4.3", 2 -> "2".
export const num = value => String(Math.round(value * 10) / 10);

// A time span in a single unit, decimals allowed: "3.2d", "4.2h", "35m" (under one minute: "<1m").
export function duration(ms) {
  const hours = ms / 3600000;
  if (hours >= 24) return `${num(hours / 24)}d`;
  if (hours >= 1) return `${num(hours)}h`;
  const minutes = ms / 60000;
  return minutes >= 1 ? `${num(minutes)}m` : '<1m';
}

// "claude-sonnet-5-5" -> "Sonnet 5.5"; an alias such as "sonnet" -> "Sonnet"; ids of other makers are shown as they are.
export function modelName(id) {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)(?:-\d{8})?$/.exec(id || '');
  if (match) return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2].replace('-', '.')}`;
  return /^(opus|sonnet|haiku|fable)$/.test(id || '') ? `${id[0].toUpperCase()}${id.slice(1)}` : id || '';
}

export const capitalize = text => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : '');
export const tokens = count => (count >= 1e6 ? `${num(count / 1e6)}M` : count >= 1000 ? `${Math.round(count / 1000)}k` : String(count));

// The plan windows still worth showing at `now`: a window whose reset time has passed has been read before it reset, so it says nothing.
export function visibleLimits(limits, now) {
  return (Array.isArray(limits) ? limits : []).filter(entry => entry && (entry.resetsAt === null || entry.resetsAt === undefined || entry.resetsAt > now));
}

// What is left of a window and when it resets: { text: "5h 62% · 4.2h", title: "5h limit: 62% left, resets in 4.2h" }.
export function limitText(entry, now) {
  const left = num(Math.max(0, 100 - entry.usedPercent));
  const reset = entry.resetsAt ? duration(entry.resetsAt - now) : '';
  return { left, reset, text: `${entry.label} ${left}%${reset ? ` · ${reset}` : ''}` };
}
