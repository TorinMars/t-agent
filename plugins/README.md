# T-Attention plugins

Plugins connect T-Attention (the attention hub: tasks that need you) to other tools. Each plugin is a folder:

- `plugins/listeners/<name>/`: a **listener** watches a tool from outside (hooks, webhooks) and creates or updates tasks through the HTTP API, with `lib/attention-client.js`.
- `plugins/notifiers/<name>/`: a **notifier** runs inside the server and tells the user when a task changes (see "T-Attention" in `DESIGN.md`).

## Listener format

```
plugins/listeners/<name>/
  manifest.json   {"name", "version", "kind": "listener", "description", "entry", "events"}
  <entry>         the program the tool runs (for example hook.js)
```

- `name`: short id, also the `source` of the tasks it writes and the prefix of their `external_ref` (`<name>:<id>`).
- `entry`: the file to run; `events`: the tool events it handles (for documentation and tests).
- A listener talks to `/api/attention` with a token (Settings -> T-Attention -> CLI tokens) and reads the same config as the `t-attention` CLI: `TA_ATTENTION_URL` / `TA_ATTENTION_TOKEN`, else `~/.tagent/attention-client.json` (written by `t-attention login`; `TAGENT_HOME` moves the folder).
- Rules: one task per unit of work (a session, a build), addressed by `PUT /api/attention/by-ref/<external_ref>`; send the title only when the task is created; set `attention_reason` when the user is needed; never mark work `done` on its own (use `review`). A listener runs inside someone else's tool: it must be fast (short timeout), print nothing, always succeed, log errors to a file under the data folder, and do nothing without a config.

## claude (Claude Code)

`plugins/listeners/claude/hook.js` is a Claude Code command hook, one task per Claude session (`claude:<session_id>`):

| Claude Code event | Task |
|---|---|
| `UserPromptSubmit` | `working`; the first prompt (80 characters) is the title; clears the reason; `meta` `{cwd, host}` |
| `Notification` (`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`, `worker_permission_prompt`) | `waiting_user`, reason = the message |
| `Stop` | `review`, reason = Claude's last message |
| `StopFailure` (API error) | `failed`, reason = the error |
| `SessionEnd` | `review` if it was still `working` or `waiting_user` |

The hooks are in `rules/claude/settings.json` and reach `~/.claude/settings.json` through `scripts/agent-sync.py` (run by `ta` before Claude starts). They find this install through `~/.tagent/listeners/claude-hook.path`, which `t-attention login` writes; until then, and without `node`, they do nothing. Errors go to `~/.tagent/listeners/claude.log`. Set `TA_ATTENTION_LISTENER=0` to turn the listener off for one shell.
