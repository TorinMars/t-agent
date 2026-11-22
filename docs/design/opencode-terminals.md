# OpenCode terminals

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

OpenCode is the third agent of task terminals, beside Claude Code and Codex ("Agent terminals" in [terminals.md](terminals.md)): agent key `opencode`,
display name "OpenCode", default terminal title `OpenCode N`. Checked against opencode 1.19.6 (a Bun single binary; `ps` shows `opencode.exe`, and
`baseName()` strips the `.exe`, so the foreground name is `opencode`). The docs at opencode.ai now describe "OpenCode 2", whose plugin API and config keys
differ; everything below was read from the 1.19.6 binary and tried in a throwaway home, and has to be checked again when opencode is upgraded.

## Start and resume

- New terminal: `OPENCODE_CONFIG_CONTENT="$TA_OPENCODE_CONFIG" opencode` (`withSessionHook` in `routes/terminal.js`). opencode has no way to start a session
  with a known id: the TUI opens on its home screen and makes the session (`ses_` + 26 characters) at the first prompt, so a new OpenCode terminal has no
  `agent_session_id` until the plugin reports one (below). An OpenCode terminal that never got a prompt reopens as a fresh `opencode`, as Codex.
- Resume (`reopenCommand`, a session picked in the New session list): `OPENCODE_CONFIG_CONTENT="$TA_OPENCODE_CONFIG" opencode -s <id>`, only when the id is
  still a root session of the terminal's directory in opencode's database; otherwise a fresh start (an unknown id makes the TUI exit with an error).
- Without a hook endpoint (it is set when the server listens) the commands are plain `opencode` / `opencode -s <id>`.
- `TA_OPENCODE_CONFIG` (PTY environment only, in `HOOK_ENV_KEYS`, so an outer terminal's value is never passed on) is a JSON config that opencode merges as
  one more source on top of the person's own: their `~/.config/opencode` files and plugins still load, and T-Agent writes nothing there (with
  `OPENCODE_CONFIG_CONTENT` set, opencode does not create its default `opencode.jsonc`; with a plugin configured, opencode itself installs
  `@opencode-ai/plugin` into `~/.config/opencode` with a `package.json`, once, as it does for any plugin; seen in a temp home). It holds
  `plugin: ["file://<install>/scripts/opencode-session-plugin.js"]` and, with peer file access on, `mcp: { "t-agent-peers": { type: "local", command:
  [<node of the service>, "<install>/scripts/peer-mcp.js"] } }` (opencode starts a local MCP server with its whole environment, so the `TA_PEER_*`
  variables and the token reach it; no `environment` key is needed). `OPENCODE_CONFIG_DIR` is not used: it would replace the person's config folder.
- The person's own `OPENCODE_CONFIG_CONTENT`: a value in the server's environment is merged into `TA_OPENCODE_CONFIG` (its keys kept, its plugins first and
  T-Agent's plugin added once, its `mcp` entries kept beside `t-agent-peers`); a value that is not a JSON object is left out with a warning in the server
  log. A value set only in a shell profile cannot be seen by the server, and the typed prefix replaces it for that command.
- `--pure` / `OPENCODE_PURE` turns plugins off; such a session reports nothing and falls back to the output-burst activity of `lib/terminal-activity.js`.

## The plugin (`scripts/opencode-session-plugin.js`)

An ES module with no dependencies, the plugin shape of opencode 1.19.6: an exported async function that gets `{ client, project, worktree, directory,
experimental_workspace, serverUrl, $ }` and returns `{ event }`. It does nothing without `TA_HOOK_URL` / `TA_HOOK_TOKEN` (or with a URL that is not http(s)),
catches every step, prints nothing, and sends its reports one after the other in the order of the events, without making opencode wait (each POST gives up
after 1.5 s). Reports go to the existing `POST /hooks/terminal-activity?task=&terminal=&event=...` with the per-terminal `X-TA-Token`:

| opencode event | report |
| --- | --- |
| `session.created` of a root session (no `parentID`) | `event=session` `{ session_id, source, cwd }`: `startup` for the first one of the process, `new` after that (`/new`); `cwd` is the session's `directory` |
| `session.status` `busy` of a root session the process did not bind last (`opencode -s <id>`, `/sessions`) | `event=session` with `source: "resume"`, then `event=start` |
| `session.status` `busy` of the bound root session | `event=start` |
| `session.idle` of a root session | `event=stop` |
| `permission.asked` | `event=attention&kind=accept` |
| `question.asked` | `event=attention&kind=select&via=tool` |
| `permission.replied`, `question.replied`, `question.rejected` | `event=start` |

- Child sessions (sub-agents, `parentID` set; remembered from `session.created`, else asked once with `client.session.get`) never bind and their busy / idle
  are not reported. Their permission requests and questions are reported: the TUI shows them and the person must answer them.
- `TA_SESSION_NAME` (a terminal the person named in T-Agent, `title_custom`): a root session the process makes gets that title through the in-process SDK
  client (`client.session.update({ path: { id }, body: { title } })`, the v1 form of 1.19.6; the v2 form `{ sessionID }` fails there), and the session a process
  was started with (`-s <id>`) gets it when its title differs, so a rename in T-Agent reaches opencode at the next start. A session picked later with
  `/sessions` keeps its title. opencode generates a title only while the title is still its default, so the name is kept (checked with a real turn).
- A rename of a running OpenCode terminal is not typed into opencode (`lib/agent-rename.js` has no command for it: opencode's `/rename` and Ctrl+R open a
  dialog). It reaches opencode at the next start.

## Binding and names (server)

- `bindReportedSession` takes reports for Claude and OpenCode terminals, with the same checks (token, task and terminal, `SESSION_ID`, `cwd` is the
  terminal's directory as a real path). `new` behaves like Claude's `clear`: the binding is kept, so a new shell resumes the first conversation (a terminal
  that is not bound yet takes it); `startup` and `resume` rebind.
- Sessions are read from opencode's SQLite database (`listOpencode` in `lib/agent-sessions.js`): `$OPENCODE_DB` (absolute, or a name inside opencode's data
  folder), else `$XDG_DATA_HOME/opencode/opencode.db`, else `~/.local/share/opencode/opencode.db` of the terminal user's home (a root service that drops
  to `TERMINAL_USER` reads that user's file; the server's `XDG_DATA_HOME` / `OPENCODE_DB` are the ones its shells inherit). Opened read only with
  `fileMustExist` and a 200 ms busy timeout; the root sessions (`parent_id IS NULL`, not archived) whose `directory` is the folder or its real path, newest
  `time_updated` first, at most 200. A read-only open of a WAL database leaves an empty `-wal` / `-shm` beside it (SQLite gives them the database's owner
  when it runs as root); opencode uses them as its own. The answer is cached by the stats of the database and its `-wal` file (the file cache of
  `lib/agent-sessions.js`). Any error (no database, locked, another schema) is no sessions.
- A session whose title is still opencode's default (`New session - <ISO time>`) is listed with `untitled: true` and the last 8 characters of its id as its
  title; such a session does not name its terminal, which keeps `OpenCode N`. Otherwise an OpenCode terminal without `title_custom` shows its session's
  title, as Claude and Codex terminals do. `GET …/agent-sessions?agent=opencode` answers the same shape as for Codex (`id`, `title`, `updated_at`,
  `started_at`, plus `untitled` when set); `listSessions` refuses an unknown agent (400 `INVALID_AGENT`).

## Across engines and the rest of T-Agent

- Capability `terminal:opencode` in `/v1/info`. The page offers OpenCode only for an engine that lists it. The Client's proxy answers
  `POST /api/remote-servers/:id/tasks/:taskId/terminals` with `agent: "opencode"` for an engine without it with 501 `OPENCODE_UNSUPPORTED` before
  anything is created (an older engine would make a plain shell); an older engine answers the session list with 400 `INVALID_AGENT`.
- The Recent list keeps the kind (`services/page-state-merge.js`), the desktop window lists OpenCode terminals as targets and labels them "OpenCode"
  (`routes/attention-widget.js`, `widgets/macos/PartC-Activity.swift`), a link opened from one says "OpenCode" (`public/js/open-link.js programName`),
  linked engines cannot read `~/.local/share/opencode/auth.json` (the provider keys; `services/peer-fs.js`), and the environment tools list has an
  OpenCode row (installed or not, its version; `services/environment-check.js`).
- Task folder rename: OpenCode sessions are not moved (opencode keeps the `directory` of each session in its database); after a rename the terminal starts
  a fresh opencode, and the rename note on the page says so. Moving a task to another machine: the OpenCode terminal comes along without its session (it
  starts a fresh opencode there, and an older target is never asked to list OpenCode sessions); the session is counted in `sessions.missing` with the reason
  "OpenCode sessions are not carried".
- Skills and rules: opencode already reads `~/.claude/skills/**/SKILL.md` and, without `~/.config/opencode/AGENTS.md`, `~/.claude/CLAUDE.md`, so the
  skills T-Agent installs reach it without a sync of their own.

## Limits and later

- Not done yet: a live rename of a running session, moving OpenCode sessions with a task rename or a task move (`opencode export` / `import`), rules and
  agent config for opencode, a T-Attention listener, the chat view, the input-line finder of `public/js/terminal-input-line.js`, sub-agent counts.
- opencode captures the mouse by default (`OPENCODE_DISABLE_MOUSE=1` turns it off) and shows a 42-column sidebar above 120 columns; Tab switches its agent
  and Ctrl+C / Ctrl+D on an empty prompt quit it. Permissions default to allow, so "Needs acceptance" is rare.
- Tests: `test/agent-sessions-opencode.test.js` (the database fixture), `test/opencode-session-plugin.test.js` (the plugin imported as opencode imports it,
  a fake fetch and client), `test/terminal-opencode.test.js` (commands, environment, binding, names, resume, the real plugin through a hook endpoint, with a
  fake PTY), `test/terminal-opencode-engine.test.js` (the capability, the Engine routes and the proxy).
