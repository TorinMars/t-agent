// The Recent menu of the initial command of a new terminal ("Initial command" in docs/design/terminals.md, the New session dialog in TaskDrawer.jsx):
// the last RECENT_MAX commands that started a terminal, the newest first. It is the person's, the same on every device and engine: the shared page
// state key `ta-start-commands` (shared-store.mjs), { shell: { <command>: ms } }, which the server merges per command by the later time and cuts to
// the 10 newest (services/page-state-merge.js `TIME_MAP_CAPS`). A command used again moves to the top (one entry per text).
import { sharedStore } from './shared-store.mjs';

export const START_COMMANDS_KEY = 'ta-start-commands';
export const RECENT_MAX = 10;
export const COMMAND_MAX = 4000; // the server's INITIAL_COMMAND_MAX (routes/terminal.js)
const KIND = 'shell';
const VALUE_MAX = 16000; // under the shared page state's 16,384 characters per value

// The command as the server will type it: CR LF and CR as LF, other control characters (tab and LF kept) dropped, the ends trimmed.
export const cleanCommand = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();

function readAll(storage) {
  try {
    const value = storage ? JSON.parse(storage.getItem(START_COMMANDS_KEY)) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// The recent commands, newest first: [{ command, at }], at most RECENT_MAX.
export function recentCommands(storage = sharedStore()) {
  const raw = readAll(storage)[KIND];
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([command, at]) => command && Number.isFinite(at) && at > 0)
    .sort(([a, x], [b, y]) => (y - x) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, RECENT_MAX)
    .map(([command, at]) => ({ command, at }));
}

// Remembers that `command` started a terminal: it goes to the top (once), the list keeps the RECENT_MAX newest, and the oldest go while the value is
// too long for the shared page state. False for an empty or too long command, or when the storage refuses.
export function recordCommand(command, { now = Date.now(), storage = sharedStore() } = {}) {
  const text = cleanCommand(command);
  if (!storage || !text || text.length > COMMAND_MAX) return false;
  const all = readAll(storage);
  let list = [{ command: text, at: now }, ...recentCommands(storage).filter(entry => entry.command !== text)].slice(0, RECENT_MAX);
  const build = entries => ({ ...all, [KIND]: Object.fromEntries(entries.map(entry => [entry.command, entry.at])) });
  if (JSON.stringify(build(list.slice(0, 1))).length > VALUE_MAX) return false; // a command that alone does not fit is not remembered
  while (list.length > 1 && JSON.stringify(build(list)).length > VALUE_MAX) list = list.slice(0, -1);
  try { storage.setItem(START_COMMANDS_KEY, JSON.stringify(build(list))); return true; } catch { return false; }
}

// One line of a command for the Recent menu: its lines joined with " ⏎ ", cut to `max` characters with an ellipsis.
export function commandPreview(command, max = 80) {
  const line = String(command).split('\n').map(part => part.trim()).filter(Boolean).join(' ⏎ ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
