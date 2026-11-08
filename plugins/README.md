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
| `PostToolUse`, `PostToolUseFailure` | back to `working` after a prompt was answered; only when the last status this hook set was `waiting_user` (a small state file in `~/.tagent/listeners/claude-state/`), so normal tool calls send nothing |

Each event also fills the task's `context` (goal, latest prompt, last reply, what is pending with the tool and command, changed files from `git diff --numstat` with a 1.5 s limit, branch, resume command, the T-Agent task and terminal from `TA_HOOK_URL`) and sends an `activity` for the timeline. On a change to `waiting_user` or `review` it sends an `excerpt`: the last 8 KiB of readable text of the transcript (the server only passes it to the optional AI summary and never stores it). `PermissionRequest` only remembers the tool for the next permission notification and makes no request.

The hooks are in `rules/claude/settings.json` and reach `~/.claude/settings.json` through `scripts/agent-sync.py` (run by `ta` before Claude starts), through `lib/listener-install.js` (`t-attention login`, `t-attention pair`, and "Install on this machine" under Settings -> T-Attention -> Plugins), which adds only the missing listener entries, replaces an older version of them and keeps everything else. They find this install through `~/.tagent/listeners/claude-hook.path` (written by the same steps), else through `$TA_ATTENTION_HOOK` (set in every T-Agent terminal together with `TA_ATTENTION_URL` and a per-terminal `TA_ATTENTION_TOKEN`); without either, and without `node`, they do nothing. The current entry runs `TA_ATTENTION_ENTRY=2 node <hook>`; an older entry that `ta` left next to it does nothing for an event that has the current one, so an event is never reported twice. Another machine connects with a pairing code from the page: `t-attention pair <code> --url <address>`. Errors go to `~/.tagent/listeners/claude.log`. Set `TA_ATTENTION_LISTENER=0` to turn the listener off for one shell.

## Notifier format

```
plugins/notifiers/<name>/
  manifest.json   {"name", "version", "kind": "notifier", "description", "config"?, "test"?, "customUi"?}
  index.js        { name, label, configFields, notify(), test() } and optional ready(), status(), routes(), close()
```

### Settings in the manifest (`config`, `test`, `customUi`)

Simple settings are described in the manifest; the server validates and stores them (per user, encrypted, with an on / off switch) and Settings -> T-Attention -> Plugins draws the form. Example:

```json
"config": [
  { "key": "url", "label": "Webhook URL", "type": "string", "required": true, "placeholder": "https://example.com/hook" },
  { "key": "apiKey", "label": "API key", "type": "secret", "help": "From the provider's dashboard" },
  { "key": "seconds", "label": "Ring time (seconds)", "type": "number", "integer": true, "min": 5, "max": 120, "default": 30 },
  { "key": "loud", "label": "Loud", "type": "boolean", "default": false },
  { "key": "level", "label": "Level", "type": "select", "options": ["low", { "value": "high", "label": "High" }], "default": "low" }
],
"test": true,
"customUi": "telegram"
```

- `type`: `string`, `secret`, `number`, `boolean` or `select`. `key`: letters, digits and `_`, starting with a letter. `label` is required; `help`, `placeholder`, `required`, `default` are optional. `options` only for a select; `min`, `max`, `integer` only for a number; a secret cannot have a default. At most 30 fields. An invalid `config` skips the plugin (the overview shows why).
- A secret is never sent back to the browser (`{ "set": true }` only) and an empty secret in a save keeps the saved one.
- `test` (default `true`): the page shows a Test button that calls `test(config, { kind: 'message', link, values, owner, log })`; return `{ ok, message? }` or throw. Never put a secret in the message (the server also hides stored secrets in it).
- `customUi`: the name of a section the page draws itself (Telegram's login); the generic form is shown below it.
- `notify` and `test` get `values` (the settings with defaults) and also find them merged into `config`. A plugin switched off gets no `notify` call. Values your plugin wrote to its own store under a schema key are moved into these settings the first time they are read.
- API: `GET/PUT /api/attention/plugins/<name>/config` (`{ enabled, values }`), `POST /api/attention/plugins/<name>/test`; see "Plugin settings from the manifest" in `DESIGN.md`.

A plugin whose manifest cannot be read or whose `index.js` lacks `notify` / `test` (or has another `name`) is skipped and logged; the plugin overview (`GET /api/attention/plugins`, `t-attention plugins`, Settings -> T-Attention -> Plugins) still lists it with `loaded: false` and the error.

### Optional hook `status(config, owner)`

Called with the plugin's stored settings and the user. It returns an object for the plugin's own settings page; two fields are also read by the plugin overview:

- `configured`: `true` when the plugin can deliver (for Telegram: logged in and account 2 chosen), else `false`. Without the field the overview shows `null` (unknown).
- `summary`: one short line, for example `Logged in as Ann (+86*******78) -> account 2 Bob`. Never put a secret in it: no session string, api key, hash, token or password, and mask phone numbers. As a safety net the overview drops a summary that contains a stored setting named like session, hash, token, secret, password or key.

`status` must be fast and must not use the network: the overview calls it on every request.

## Publishing a plugin (marketplace)

Anyone can publish a plugin in a Git repository; users install it from Settings -> T-Attention -> Plugins -> Marketplace, or with `t-attention plugins install <name|git-url>`. The server downloads it, shows what it contains and installs it only after the user confirms, pinned to that commit. Installed plugins live in `<data folder>/plugins/{listeners,notifiers}/<name>/` (`~/.tagent` by default); see "Plugin marketplace" in `DESIGN.md`.

**Repository layout**: the plugin folder is the repository root, or a subfolder of it (users give it as `https://host/repo.git#<ref>:<subfolder>`, an index entry as `"path"`). It contains `manifest.json` and the files of the format above (a notifier: `index.js`; a listener: its `entry`). Rules:

- `manifest.json` needs `name` (`^[a-z0-9][a-z0-9-]{0,40}$`, not the name of a built-in plugin: `claude`, `telegram`), `version`, `kind` (`listener` or `notifier`) and `description` (at most 500 characters); a notifier's `config` must be valid (see above).
- **No dependencies**: nothing is installed with npm. Use Node built-ins only, or put the dependencies you need inside the folder (a `node_modules` you commit). A `package.json` with dependencies and no `node_modules` shows the warning "needs dependencies; not supported".
- At most 2000 files and 20 MiB. Symlinks must be relative and stay inside the plugin folder. Submodules, Git LFS files and Git hooks are not used.
- Tag your releases. Users pin a commit; `t-attention plugins update` (or the Update button) installs the newer commit of the same ref, and the plugin's settings stay.
- The preview tells the user when the code uses `child_process`, network modules or `fetch`, `vm` or worker threads. A notifier runs inside the T-Agent server; a listener is only copied, and its tool must be set up to run it (say how in your README).

**Index entry**: to appear in the marketplace search, add an entry to an index. The official index is `marketplace.json` at the root of the T-Agent repository (open a pull request); users can add their own indexes (https URLs) under "Sources".

```json
{
  "name": "my-bell",
  "kind": "notifier",
  "description": "Rings a bell on my desk when a task needs me.",
  "version": "1.2.0",
  "repo": "https://github.com/me/t-attention-bell.git",
  "path": "plugin",
  "ref": "v1.2.0",
  "homepage": "https://github.com/me/t-attention-bell",
  "author": "Me",
  "tags": ["bell", "hardware"]
}
```

`repo` is an `https://` or `git@host:path` URL, `path` and `ref` are optional (default: the root and the default branch); `name` and `kind` must match the manifest. Built-in plugins are listed with `"builtIn": true` and no `repo`.

**Developing**: `t-attention plugins link /path/to/folder` (or "Link local folder…" on the page) uses the folder in place; a linked notifier reloads when its files change. `t-attention plugins unlink <name>` ends it.
