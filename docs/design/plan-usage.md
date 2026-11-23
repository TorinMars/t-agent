# Plan usage bars (server)

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

The page header shows the Claude and Codex plan windows (5 hours, 7 days) of the engine of the shown session. This file is the server side: the readings, the API, the forward to linked engines. The page side is in [plan-usage-page.md](plan-usage-page.md).

Plan usage is read by each engine from the Claude and Codex logins on that machine (the user its terminals run as): every minute while a session of that agent runs, otherwise every 10 minutes at most, after each Claude or Codex turn (at most once a minute), and when asked. Every client shows that engine's last reading. Two engines show different numbers only when their agents are logged in to different accounts.

## Readings

- **One reading per agent, shared with the agent chat.** `services/agent-usage.js` does not read anything itself: it uses the chat's `refreshLimits(agent, { force, maxAgeMs })` and the adapters' `loadLimits()` (`lib/agent-chat/claude.js`: the SDK usage call; `lib/agent-chat/codex.js`: `account/rateLimits/read` of a short-lived app server). `refreshLimits` never runs two readings of one agent at once (a second caller gets the promise of the first), so the bars, the chat footer, the chat's turn-end read and Codex's pushed `account/rateLimits/updated` all fill the same entry, `agentLimits` (agent -> `{ limits, at, state }`). The bars read it with `limitsReading(agent)` (`{ supported, reading, last }`).
- **States.** `state` of an entry is `'ok'` after a reading that worked and `'signed_out'` / `'error'` after one that failed (the chat keeps the old numbers for its footer; the bars show no windows then). A failure is `signed_out` when the agent's message says it is not logged in (`signedOutError` in `services/agent-chat.js`: "not logged in", "run /login", "authentication required", "unauthorized", "invalid API key", 401), and also when the login file has no account (below). An agent with no reading yet is `not_read`. A reading that worked but has no 5-hour or 7-day window is answered as `no_plan` (an API key, or Claude signed out: its usage call then answers without limits); the page leaves it out of the bars and says so in the details.
- **Not installed.** An agent whose CLI is not found is left out of the answer and never read. Claude: `CLAUDE_PATH`, `PATH`, `~/.claude/local` and the other folders of `lib/find-program.js`, then the login shell; Codex: `findCodex` of `lib/agent-chat/codex-app-server.js`. The answer is kept for 10 minutes (an old one is answered while a new one is looked for).
- **Account hash.** `account` is the first 12 hex characters of the SHA-256 of the account id, so two engines can tell "same account" without seeing it: Claude's `oauthAccount.accountUuid` (else `organizationUuid`) in `.claude.json`, Codex's `tokens.account_id` in `auth.json`. The files are those of the user the terminals run as: a service running as root that drops its shells to `TERMINAL_USER` reads that user's home (as the OpenCode session home in `routes/terminal.js`), with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` when set. Only the id is taken; the hash is kept while the file's size and time stay the same. No email, raw id or token is kept, logged or answered; an unreadable file gives `null`.
- Readings live in memory only; no `system_state` key is used.

## When a reading is made

- **GET** answers the last reading at once. An installed agent whose reading is older than 5 minutes (or missing) is read in the background; the page sees it on its next GET.
- **POST refresh** forces a reading of each installed agent, at most once per 10 s per agent (a second refresh within that waits for a reading still under way, else answers the last one), and answers after the readings or after 20 s with what is known then.
- **Scheduled readings** (`start()` in `server.js`): a tick at start and every minute. For each installed agent whose reading is not under way:
  - a working reading is read again before it is 10 minutes old (a hard maximum age), or every minute (when it is at least 50 s old) while a session of that agent runs: a terminal whose activity is `running` (`runningAgents()` in `routes/terminal.js`) or a chat in a turn (`runningAgents()` of the chat service);
  - after a failed reading: again after 1 minute, then 5 minutes, then every 10 minutes (failures in a row, counted from the readings the tick sees, whoever made them);
  - a signed-out agent every 60 minutes.
  These waits win over the one-minute pace. A reading from any source counts, so a tick right after a chat or GET reading skips the agent.
- **Readings after a turn**: when a Claude or Codex terminal goes from `running` to `done` or `idle` (`lib/agent-turn-end.js`, wired in the activity tracker's callback of `routes/terminal.js`; the agent is the terminal row's, else `claude` / `codex` in the foreground), `turnEnded(agent)` reads that agent, at most once a minute per agent and not when its reading is younger than a minute. The chat's own turn-end read (`POLL_LIMITS`) stays as it is.
- **Switch**: the schedule and the turn-end reads are off with `AGENT_USAGE_SCHEDULE=off` (or `0`, `false`, `no`), with `NODE_ENV=test` and in CI (`scheduleEnabled`), so no other test starts an agent; GET and refresh still read. The timer is unreferenced and stopped by the exit handler (`stopShared`).

## API

`GET {base}/agent-usage` and `POST {base}/agent-usage/refresh` (`routes/agent-usage.js`, `Cache-Control: no-store`), where base is:

- `/api`: this machine, with the page's login.
- `/v1`: an engine, with any token that can read tasks (`tasks:read`). `/v1/info` lists the capability `agent-usage:read`.
- `/api/remote-servers/:id`: forwarded by `routes/remote-servers.js` to that engine's `/v1/agent-usage` (and `/refresh`), only when its `/v1/info` lists `agent-usage:read`; an older engine answers 501 `AGENT_USAGE_UNSUPPORTED` and is sent nothing. The answer passes through `cleanAnswer`, which keeps only the fields below.

```
{ engine: { instance_id, name }, agents: [Usage] }   // claude first, then codex; an agent that is not installed is left out
Usage = { agent: 'claude' | 'codex', state: 'ok' | 'not_read' | 'signed_out' | 'no_plan' | 'error',
  account: '<12 hex chars>' | null, read_at: <ms of the reading> | null,
  windows: [{ id: '5h' | '7d', label: '5h' | '7d', usedPercent: 0..100, resetsAt: <ms> | null }] }   // [] unless state is ok
```

A failure of the service itself answers 500 `AGENT_USAGE_FAILED`.

## Limits

- The readings run as the service user (the chat adapters do), while the account hash comes from the terminal user's files. On a root service that drops its shells, the two can name different logins; the hash is then the terminal user's.
- Claude's usage call is marked experimental in the SDK; an account without plan limits (an API key) reads as `ok` with no windows.
- Only the 5-hour and 7-day windows are answered; another window an agent reports is left out.

Tests: `test/agent-usage.test.js` (fake adapters, a temporary home for the login files, fake timers for the schedule).
