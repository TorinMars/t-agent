// A rename of an agent terminal in T-Agent is also typed into the agent running in it ("Rename reaches the agent" in docs/design/terminals.md):
// Claude Code and Codex both take `/rename <name>` in their prompt, also while they work (Claude Code runs /rename mid-turn, Codex allows
// it during a task). It is typed at once unless the agent waits at a permission question (typed keys would answer it) or does not own the
// terminal's foreground (not started yet, or exited: never typed into a shell); then the rename waits, one pending rename per terminal (a
// newer rename replaces it), and is given up after MAX_WAIT_MS. The prompt is cleared first with
// Ctrl+E (end of the line) and Ctrl+U (delete to the line start; again at a line start it deletes the line break), which both agents bind
// by default and which keep the deleted draft for Ctrl+Y.

// The agents that have a rename command, and how the command is typed.
const RENAME_COMMANDS = {
  claude: name => `/rename ${name}`,
  codex: name => `/rename ${name}`,
};
// Ctrl+E, then Ctrl+U a dozen times: clears a draft of up to about six lines above the cursor's line. Ctrl+U on an empty prompt does
// nothing in Codex and leaves Claude's shell (!) mode, so the extra presses are harmless.
const CLEAR_PROMPT = `\x05${'\x15'.repeat(12)}`;
const MAX_NAME = 80; // code points; T-Agent's own names are at most 40 characters (cleanTitle in routes/terminal.js)
const MAX_WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 2000;
const SETTLE_MS = 500;      // after an activity change, so the question is gone from the screen before anything is typed
const KEY_GAP_MS = 60;      // between the clearing keys and the command
const ENTER_DELAY_MS = 150; // Enter on its own: Codex takes keys that come quickly after each other as a paste, where Enter is a line break

// One line of printable text: control characters (C0, DEL, C1), line and paragraph separators, zero-width and bidirectional controls
// become a space, runs of white space one space, the ends are trimmed, at most MAX_NAME code points.
function sanitizeAgentName(value) {
  const text = String(value ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, MAX_NAME).join('').trim();
}

// A word that starts with @ opens Claude's file suggestions, and Enter would then pick a file instead of sending the command.
function typeable(name) {
  return Boolean(name) && !/(^|\s)@/.test(name);
}

// What to do now for a pending rename, from what the terminal is doing:
// info: null (no live shell) or { agent, state: 'idle' | 'running' | 'done', awaiting, foreground: [names] }.
// Answers 'send', 'wait' or 'drop'. Running is no reason to wait: both agents take the command while they work.
function decide(info) {
  if (!info) return 'drop';
  if (!RENAME_COMMANDS[info.agent]) return 'drop';
  if (info.awaiting) return 'wait';
  if (!Array.isArray(info.foreground) || !info.foreground.includes(info.agent)) return 'wait';
  return 'send';
}

// probe(key): null when the terminal has no live shell, else { token, state, awaiting, foreground }; `token` names the shell (a
// pending rename is dropped when the terminal got another shell).
// write(key, token, data): types into that shell; false when it is gone.
function createAgentRenamer({ probe, write, log = () => {}, maxWaitMs = MAX_WAIT_MS, pollMs = POLL_MS, settleMs = SETTLE_MS,
  keyGapMs = KEY_GAP_MS, enterDelayMs = ENTER_DELAY_MS } = {}) {
  const pending = new Map(); // key -> { agent, name, token, since }
  let poll = null;

  const stopPollIfIdle = () => {
    if (pending.size || !poll) return;
    clearInterval(poll);
    poll = null;
  };
  const startPoll = () => {
    if (poll || !pending.size) return;
    poll = setInterval(() => { for (const key of [...pending.keys()]) attempt(key); }, pollMs);
    poll.unref?.();
  };

  // Types the clearing keys, the command and Enter, each only while the same shell still runs.
  function typeOut(key, token, agent, name) {
    if (!write(key, token, CLEAR_PROMPT)) return false;
    const command = setTimeout(() => {
      if (!write(key, token, RENAME_COMMANDS[agent](name))) return;
      const enter = setTimeout(() => write(key, token, '\r'), enterDelayMs);
      enter.unref?.();
    }, keyGapMs);
    command.unref?.();
    return true;
  }

  function attempt(key) {
    const entry = pending.get(key);
    if (!entry) return 'none';
    const info = probe(key);
    let verdict = info && info.token !== entry.token ? 'drop' : decide(info && { ...info, agent: entry.agent });
    if (verdict === 'wait' && Date.now() - entry.since >= maxWaitMs) {
      log(`agent rename of ${key} given up: the session waited at a question (or its agent was not in the foreground) for ${Math.round(maxWaitMs / 60000)} minutes`);
      verdict = 'given-up';
    }
    if (verdict === 'wait') return 'pending';
    pending.delete(key);
    stopPollIfIdle();
    if (verdict === 'send') return typeOut(key, entry.token, entry.agent, entry.name) ? 'sent' : 'dropped';
    return verdict === 'given-up' ? 'given-up' : 'dropped';
  }

  return {
    // A rename was saved for the terminal `key` whose agent is `agent`. Answers 'sent', 'pending', 'dropped' (no live shell) or
    // 'skipped' (no rename command for that agent, or a name that cannot be typed).
    request(key, agent, value) {
      const name = sanitizeAgentName(value);
      if (!RENAME_COMMANDS[agent] || !typeable(name)) {
        pending.delete(key);
        stopPollIfIdle();
        return 'skipped';
      }
      const info = probe(key);
      if (!info) {
        pending.delete(key);
        stopPollIfIdle();
        return 'dropped';
      }
      pending.set(key, { agent, name, token: info.token, since: Date.now() }); // replaces an older pending rename of the terminal
      const result = attempt(key);
      if (result === 'pending') startPoll();
      return result;
    },
    // The terminal's activity changed (a question was answered): try again once the screen had time to follow.
    poke(key) {
      if (!pending.has(key)) return;
      const timer = setTimeout(() => attempt(key), settleMs);
      timer.unref?.();
    },
    cancel(key) {
      pending.delete(key);
      stopPollIfIdle();
    },
    pending(key) {
      const entry = pending.get(key);
      return entry ? { agent: entry.agent, name: entry.name, since: entry.since } : null;
    },
    stop() {
      pending.clear();
      stopPollIfIdle();
    },
  };
}

module.exports = { createAgentRenamer, sanitizeAgentName, decide, RENAME_COMMANDS, CLEAR_PROMPT, MAX_WAIT_MS };
