// Recently used saved commands ("Saved commands" in docs/design/page-terminal-and-bottom-bar.md): the commands sent from the list (a tap, or the pencil
// "Edit before sending") come first, the most recent at the top, and the second line of such a row says when ("used 5 min ago"). Each kind of list
// (Claude Code, Codex, the plain shell) keeps its own order. It is remembered on this device only (localStorage, every access guarded) as
// { claude: { '/compact': <ms> }, codex: {...}, shell: {...} }, keyed by the command text. A command that is no longer in commands.mjs is ignored and
// dropped at the next use, so a kind never holds more than the commands of its list.
import { AGENT_COMMANDS, commandsFor } from './commands.mjs';

export const RECENCY_KEY = 'ta-saved-commands-used';

const kindOf = agent => (Object.hasOwn(AGENT_COMMANDS, agent) ? agent : 'shell');
const local = () => { try { return globalThis.localStorage || null; } catch { return null; } };

function readAll(storage) {
  try {
    const value = storage ? JSON.parse(storage.getItem(RECENCY_KEY)) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// The last use of each command of this agent's list: { command: ms }. Unknown commands and bad values are left out.
export function usesFor(agent, storage = local()) {
  const known = new Set(commandsFor(agent).commands.map(entry => entry.command));
  const raw = readAll(storage)[kindOf(agent)];
  const uses = {};
  if (raw && typeof raw === 'object') {
    for (const [command, at] of Object.entries(raw)) if (known.has(command) && Number.isFinite(at) && at > 0) uses[command] = at;
  }
  return uses;
}

// Remembers that `command` was sent from the list of this agent's kind. False when it is not in that list or the storage refuses.
export function recordUse(agent, command, { now = Date.now(), storage = local() } = {}) {
  if (!storage || !commandsFor(agent).commands.some(entry => entry.command === command)) return false;
  const all = readAll(storage);
  all[kindOf(agent)] = { ...usesFor(agent, storage), [command]: now };
  try { storage.setItem(RECENCY_KEY, JSON.stringify(all)); return true; } catch { return false; }
}

// Splits a list's commands into the used ones (most recent first, each with `usedAt`) and the never used ones (in their usual order). The divider of the
// list goes between the two, and only when both have rows.
export function orderCommands(commands, uses) {
  const used = commands.filter(entry => uses[entry.command]).map(entry => ({ ...entry, usedAt: uses[entry.command] }));
  used.sort((a, b) => b.usedAt - a.usedAt);
  return { used, rest: commands.filter(entry => !uses[entry.command]) };
}

// When a command was last used, in English words that the dictionaries translate (public/js/i18n-zh-ui.js and i18n-zh-extra.js):
// "used just now", "used 5 min ago", "used 3 h ago", "used yesterday", "used 3 days ago".
export function usedLabel(at, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return 'used just now';
  if (minutes < 60) return `used ${minutes} min ago`;
  if (minutes < 1440) return `used ${Math.floor(minutes / 60)} h ago`;
  const days = Math.floor(minutes / 1440);
  return days === 1 ? 'used yesterday' : `used ${days} days ago`;
}
