// The plan usage bars of the page header (docs/design/plan-usage.md): the Claude and Codex plan windows (5 hours, 7 days) of this engine.
//
// The readings are the agent chat's own (services/agent-chat.js `refreshLimits` / `limitsReading`), so the chat and the bars show the same numbers and a
// reading never runs twice for one agent. A reading is made when a GET finds the last one old, on a refresh, after a chat turn (as before), after a
// Claude or Codex turn in a terminal (at most once a minute), and on a schedule: every minute while a session of that agent runs, otherwise before
// the reading is 10 minutes old.
// The answer names each account only by a short hash; no email, raw account id or token is kept, logged or answered.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFinder } = require('../lib/find-program');
const { resolveTerminalUser, terminalEnvFor } = require('../lib/terminal-user');

const CAPABILITY = 'agent-usage:read';
const AGENTS = ['claude', 'codex'];
const WINDOWS = new Set(['5h', '7d']);
const STALE_MS = 5 * 60 * 1000; // a GET that finds an older reading starts one in the background
const REFRESH_GAP_MS = 10 * 1000; // a refresh forces a reading at most this often per agent
const REFRESH_TIMEOUT_MS = 20 * 1000; // how long a refresh waits for its readings
const INSTALLED_TTL_MS = 10 * 60 * 1000; // how long "is the CLI installed" is kept
const ACCOUNT_FILE_MAX_BYTES = 32 * 1024 * 1024;
// Automatic readings ("Scheduled readings" in docs/design/plan-usage.md). A tick at start and every minute reads each installed agent whose last
// reading (from any source) is old for its state: a working one before it is 10 minutes old (okMaxMs, a hard maximum age), a failed one 1, 5, then
// every 10 minutes after the failure (errorGapsMs, by the number of failures in a row), a signed-out one every 60 minutes. A Claude or Codex turn
// that ends in a terminal reads that agent too, at most once a minute (turnGapMs). While a session of an agent runs (a terminal whose activity is
// 'running', or a chat turn), a working reading of that agent is read at every tick unless it is younger than busyMinAgeMs; the waits after a failure
// and for a signed-out agent still apply.
const SCHEDULE = {
  tickMs: 60 * 1000, okMaxMs: 10 * 60 * 1000, busyMinAgeMs: 50 * 1000,
  errorGapsMs: [60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000], signedOutGapMs: 60 * 60 * 1000, turnGapMs: 60 * 1000,
};

// The agents that have a running session on this engine: a terminal whose activity is 'running' (routes/terminal.js) or a chat in a turn.
function defaultBusyAgents(chat) {
  const agents = new Set();
  try { for (const agent of require('../routes/terminal').runningAgents()) agents.add(agent); } catch { /* no terminals */ }
  try { for (const agent of chat().runningAgents()) agents.add(agent); } catch { /* no chats */ }
  return agents;
}

const hashAccount = id => (id ? crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12) : null);
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

// Where the agents of the terminals keep their login: the home of the user the shells run as (a root service drops to TERMINAL_USER, like the
// OpenCode session home in routes/terminal.js), with CLAUDE_CONFIG_DIR / CODEX_HOME when they are set.
function accountFiles({ env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser({ env }) } = {}) {
  let user = null;
  try { user = terminalUser().user || null; } catch { user = null; }
  const where = user ? { env: terminalEnvFor(user, env), home: user.home } : { env, home: homedir() };
  const absolute = value => (value && path.isAbsolute(value) ? path.resolve(value) : null);
  const claudeDir = absolute(where.env.CLAUDE_CONFIG_DIR);
  return {
    claude: claudeDir ? path.join(claudeDir, '.claude.json') : path.join(where.home, '.claude.json'),
    codex: path.join(absolute(where.env.CODEX_HOME) || path.join(where.home, '.codex'), 'auth.json'),
  };
}

// Only the account id is taken from these files: Claude's oauthAccount.accountUuid (or its organization), Codex's tokens.account_id.
const ACCOUNT_IDS = {
  claude: json => { const account = json && json.oauthAccount; return account ? text(account.accountUuid) || text(account.organizationUuid) : null; },
  codex: json => { const tokens = json && json.tokens; return tokens ? text(tokens.account_id) : null; },
};

// The account hash of an agent from its file, kept while the file's size and time stay the same (~/.claude.json can be a few MB).
function createAccountReader({ files = () => accountFiles() } = {}) {
  const cache = new Map(); // agent -> { file, mtimeMs, size, hash }
  return agent => {
    let file;
    try { file = files()[agent]; } catch { return null; }
    if (!file) return null;
    let stat;
    try { stat = fs.statSync(file); } catch { cache.delete(agent); return null; }
    const known = cache.get(agent);
    if (known && known.file === file && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.hash;
    let hash = null;
    try {
      if (stat.isFile() && stat.size <= ACCOUNT_FILE_MAX_BYTES) hash = hashAccount(ACCOUNT_IDS[agent](JSON.parse(fs.readFileSync(file, 'utf8'))));
    } catch { hash = null; } // an unreadable file is an unknown account
    cache.set(agent, { file, mtimeMs: stat.mtimeMs, size: stat.size, hash });
    return hash;
  };
}

// Whether an agent's CLI is on this machine, as the chat adapters find it (CLAUDE_PATH / CODEX_PATH, PATH, the usual install folders, the login shell).
function defaultInstalledChecks() {
  const claude = makeFinder('claude', { envVar: 'CLAUDE_PATH', extraDirs: [path.join('.claude', 'local')] });
  return {
    claude: async () => Boolean(await claude.find()),
    codex: async () => Boolean(await require('../lib/agent-chat/codex-app-server').findCodex()),
  };
}

// The answer's shape, also used on the answer of another engine before it is passed on (routes/remote-servers.js): only the known fields.
function cleanWindow(entry) {
  const usedPercent = Number(entry && entry.usedPercent);
  if (!entry || !WINDOWS.has(entry.id) || !Number.isFinite(usedPercent)) return null;
  const resetsAt = Number(entry.resetsAt);
  return { id: entry.id, label: entry.id, usedPercent: Math.max(0, Math.min(100, usedPercent)), resetsAt: entry.resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null };
}
const STATES = new Set(['ok', 'not_read', 'signed_out', 'error']);
function cleanUsage(usage) {
  if (!usage || !AGENTS.includes(usage.agent)) return null;
  const state = STATES.has(usage.state) ? usage.state : 'error';
  const readAt = Number(usage.read_at);
  return {
    agent: usage.agent, state,
    account: typeof usage.account === 'string' && /^[0-9a-f]{12}$/.test(usage.account) ? usage.account : null,
    read_at: usage.read_at !== null && Number.isFinite(readAt) ? readAt : null,
    windows: state === 'ok' && Array.isArray(usage.windows) ? usage.windows.map(cleanWindow).filter(Boolean) : [],
  };
}
function cleanAnswer(answer) {
  const engine = (answer && answer.engine) || {};
  const agents = (Array.isArray(answer && answer.agents) ? answer.agents : []).map(cleanUsage).filter(Boolean)
    .sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent));
  return {
    engine: { instance_id: typeof engine.instance_id === 'string' ? engine.instance_id : null, name: typeof engine.name === 'string' ? engine.name : null },
    agents: agents.filter((usage, index) => agents.findIndex(other => other.agent === usage.agent) === index),
  };
}

// Whether the automatic readings (the schedule and the reads after terminal turns) run: off with AGENT_USAGE_SCHEDULE=off (or 0, false, no), in tests
// (NODE_ENV=test) and in CI, so that no other test starts an agent.
function scheduleEnabled(env = process.env) {
  if (/^(off|0|false|no)$/i.test(String(env.AGENT_USAGE_SCHEDULE || '').trim())) return false;
  if (env.NODE_ENV === 'test') return false;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false;
  return true;
}

// options: chat (the agent chat service, or a function that gives it), installed ({ agent: async () => boolean }), account (agent -> hash or null),
// identity () -> { engine_id, name }, now, staleMs, refreshGapMs, refreshTimeoutMs, installedTtlMs, busyAgents () -> agents with a running session,
// schedule ({ tickMs, okMaxMs, busyMinAgeMs, errorGapsMs, signedOutGapMs, turnGapMs }).
function createAgentUsage({
  chat = () => require('./agent-chat').getAgentChat(), installed = defaultInstalledChecks(), account = createAccountReader(),
  identity = () => require('./engine-identity').getEngineIdentity(), now = () => Date.now(),
  staleMs = STALE_MS, refreshGapMs = REFRESH_GAP_MS, refreshTimeoutMs = REFRESH_TIMEOUT_MS, installedTtlMs = INSTALLED_TTL_MS, schedule = {}, busyAgents = null,
} = {}) {
  const service = () => (typeof chat === 'function' ? chat() : chat);
  const busyNow = () => { try { return new Set(busyAgents ? busyAgents() : defaultBusyAgents(service)); } catch { return new Set(); } };
  const timing = { ...SCHEDULE, ...schedule };
  const forcedAt = new Map(); // agent -> when a refresh last forced a reading
  const installedCache = new Map(); // agent -> { value, at, pending }

  function isInstalled(agent) {
    const known = installedCache.get(agent);
    const check = () => {
      const entry = installedCache.get(agent) || { value: null, at: 0, pending: null };
      if (!entry.pending) {
        entry.pending = Promise.resolve().then(() => installed[agent]()).then(Boolean, () => false)
          .then(value => { installedCache.set(agent, { value, at: now(), pending: null }); return value; });
        installedCache.set(agent, entry);
      }
      return entry.pending;
    };
    if (!installed[agent]) return Promise.resolve(false);
    if (known && known.value !== null) {
      if (now() - known.at >= installedTtlMs) void check(); // the old answer now, a new one for the next time
      return Promise.resolve(known.value);
    }
    return check();
  }
  async function installedAgents() {
    const found = await Promise.all(AGENTS.map(agent => isInstalled(agent)));
    return AGENTS.filter((agent, index) => found[index]);
  }

  function reading(agent) {
    try { return service().limitsReading(agent); } catch { return { supported: false, reading: false, last: null }; }
  }

  function usageOf(agent) {
    const { last } = reading(agent);
    const hash = account(agent);
    if (!last) return { agent, state: 'not_read', account: hash, read_at: null, windows: [] };
    // A reading that failed with no login in the agent's files is a signed-out agent, whatever the message said.
    const state = last.state === 'error' && !hash ? 'signed_out' : last.state;
    return cleanUsage({ agent, state, account: hash, read_at: last.at, windows: last.limits });
  }

  function answer(agents) {
    let engine = {};
    try { engine = identity() || {}; } catch { engine = {}; }
    return cleanAnswer({ engine: { instance_id: engine.engine_id || engine.instance_id, name: engine.name }, agents: agents.map(usageOf) });
  }

  // Starts a reading of an agent unless one runs or the last one is younger than `maxAgeMs`; resolves when it ends (never rejects).
  function read(agent, options) {
    const { supported } = reading(agent);
    if (!supported) return Promise.resolve(false);
    try { return Promise.resolve(service().refreshLimits(agent, options)).catch(() => false); } catch { return Promise.resolve(false); }
  }

  // GET: the last readings at once; an agent whose reading is old (or missing) is read in the background for the next GET.
  async function get() {
    const agents = await installedAgents();
    for (const agent of agents) {
      const { supported, reading: running, last } = reading(agent);
      if (supported && !running && (!last || now() - last.at >= staleMs)) void read(agent, { force: true });
    }
    return answer(agents);
  }

  // POST refresh: a new reading of each agent (at most once per refreshGapMs per agent; within that, a reading still under way is waited for),
  // answered when they ended or after refreshTimeoutMs with what is known then.
  async function refresh() {
    const agents = await installedAgents();
    const jobs = [];
    for (const agent of agents) {
      const { supported, reading: running } = reading(agent);
      if (!supported) continue;
      const last = forcedAt.get(agent);
      if (last !== undefined && now() - last < refreshGapMs) { if (running) jobs.push(read(agent, {})); continue; }
      forcedAt.set(agent, now());
      jobs.push(read(agent, { force: true }));
    }
    let timer = null;
    await Promise.race([Promise.allSettled(jobs), new Promise(resolve => { timer = setTimeout(resolve, refreshTimeoutMs); if (timer.unref) timer.unref(); })]);
    clearTimeout(timer);
    return answer(agents);
  }

  // One tick of the schedule: each installed agent whose last reading is old for its state is read (one reading at a time per agent, shared with the
  // GET, the refresh and the chat). Failures in a row are counted from the readings the tick sees, whoever made them.
  const seen = new Map(); // agent -> { at, failures }
  function dueIn(agent, last, busy) {
    const state = usageOf(agent).state;
    const known = seen.get(agent) || { at: null, failures: 0 };
    if (known.at !== last.at) seen.set(agent, { at: last.at, failures: state === 'error' ? known.failures + 1 : 0 });
    const failures = seen.get(agent).failures;
    const age = now() - last.at;
    // A tick comes every tickMs: a working reading is read again before it gets older than okMaxMs; a wait after a failure is rounded to the nearest tick.
    if (state === 'signed_out') return age + timing.tickMs / 2 >= timing.signedOutGapMs;
    if (state === 'error') return age + timing.tickMs / 2 >= timing.errorGapsMs[Math.min(failures, timing.errorGapsMs.length) - 1];
    if (busy) return age >= timing.busyMinAgeMs;
    return age + timing.tickMs > timing.okMaxMs;
  }
  async function tick() {
    let agents = [];
    try { agents = await installedAgents(); } catch { return; }
    const busy = agents.length ? busyNow() : new Set();
    for (const agent of agents) {
      const { supported, reading: running, last } = reading(agent);
      if (!supported || running || (last && !dueIn(agent, last, busy.has(agent)))) continue;
      void read(agent, { force: true });
    }
  }

  // A Claude or Codex turn ended in a terminal of this engine (routes/terminal.js `onAgentTurnEnd`): a turn is what uses the plan up. Only while the
  // automatic readings run, at most once per turnGapMs per agent, and not when a reading of that agent is younger than that.
  const turnReadAt = new Map();
  function turnEnded(agent) {
    if (!timer || !AGENTS.includes(agent) || !reading(agent).supported) return false;
    const last = turnReadAt.get(agent);
    if (last !== undefined && now() - last < timing.turnGapMs) return false;
    turnReadAt.set(agent, now());
    void read(agent, { maxAgeMs: timing.turnGapMs });
    return true;
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, timing.tickMs);
    if (timer.unref) timer.unref(); // never keeps the process alive
    void tick();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { get, refresh, tick, turnEnded, start, stop, installedAgents, running: () => Boolean(timer) };
}

let shared = null;
const getAgentUsage = () => shared || (shared = createAgentUsage());
const setAgentUsage = service => { shared = service || null; }; // tests
// For the exit handler of the server: stops the schedule without making the instance.
const stopShared = () => { if (shared) shared.stop(); };

module.exports = { createAgentUsage, getAgentUsage, setAgentUsage, stopShared, scheduleEnabled, accountFiles, createAccountReader, hashAccount, cleanAnswer, CAPABILITY, SCHEDULE };
