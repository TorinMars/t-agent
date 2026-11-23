// A turn of Claude Code or Codex in a terminal ended: the activity of the terminal went from 'running' to 'done' or 'idle' (lib/terminal-activity.js)
// while that agent runs there. The plan usage bars read that agent's plan windows then ("Readings after a turn" in docs/design/plan-usage.md).
const TURN_AGENTS = new Set(['claude', 'codex']);

// `agentOf()`: the agent of the terminal ('claude', 'codex', another name or null), asked only when a turn ends. `onTurnEnd(agent)` is called for
// Claude and Codex only and never throws out of here. Returns the function for each new activity state.
function createTurnEndWatch({ agentOf, onTurnEnd }) {
  let previous = 'idle';
  return state => {
    const ended = previous === 'running' && (state === 'done' || state === 'idle');
    previous = state;
    if (!ended) return null;
    let agent = null;
    try { agent = agentOf(); } catch { agent = null; }
    if (!TURN_AGENTS.has(agent)) return null;
    try { onTurnEnd(agent); } catch { /* a reading is never the terminal's problem */ }
    return agent;
  };
}

module.exports = { createTurnEndWatch, TURN_AGENTS };
