# Initial command of a new terminal

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

A new plain terminal can run a command when its shell starts (approved by the user, 2026-11-25). The command is typed into the shell as if the
person typed it, line by line, each line followed by Enter, so the shell stays interactive and the terminal stays open when the command ends.
Empty means exactly the behaviour before this feature.

## Initial command

- API: `POST /api/tasks/:id/terminals` (and `POST /v1/tasks/:id/terminals` of the Engine API, and the proxy `POST /api/remote-servers/:id/tasks/:tid/terminals`)
  takes `command`, a string. `routes/terminal.js` `cleanInitialCommand`: CR LF and CR become LF, other control characters (tab and LF kept) are dropped,
  the ends are trimmed; at most 4,000 characters (`INITIAL_COMMAND_MAX`). Errors, all 400: `INVALID_INITIAL_COMMAND` (not a string),
  `INITIAL_COMMAND_TOO_LONG`, `INITIAL_COMMAND_NOT_A_TERMINAL` (with `agent` claude, codex, opencode or notebook). Nothing is made when it is refused.
  A blank command is no command. Example for scripts: `curl -X POST …/api/tasks/12/terminals -H 'Content-Type: application/json' -d '{"title":"dev","command":"cd web\nnpm run dev"}'`.
- Storage (schema 28): `task_terminals.start_command` holds the cleaned command, with an empty default for older rows. The implicit default terminal
  of an older task has no terminal row, so its command is in `task_default_terminal_commands`. Commands stay on the hosting engine when a task is moved to a different engine.
- Typing: `getOrCreateSession` reads the saved command when it spawns a new shell. `typeWhenReady` waits for the shell's first output and then 250 ms
  without output (`INITIAL_QUIET_MS`). A shell that prints nothing or never goes quiet gets it after 3 s (`INITIAL_WAIT_MS`). Each line is written as
  `<line>\r`. The command is sent on every new shell after a service restart, Restart, Reopen after close, or a shell exit. Opening the same live
  shell twice reuses its session and timer. The timer is cancelled when that shell ends or is replaced.
- Editing: `GET …/terminals/:terminalId/start-command` returns `{ command }` for a plain terminal. `PATCH …/terminals/:terminalId` accepts
  `{ start_command }` as a string (blank clears) and an optional `title`. Saving takes effect on the next shell spawn. The same routes work on
  the Engine API and through the remote proxy.
- Privacy: the saved value is read only through terminal detail. Terminal lists expose `has_start_command` as a boolean. The value is never put
  into application logs, events, T-Attention items or usage tables. The terminal buffer holds whatever the shell echoes, as for typed input.
- Capability: `/v1/info` lists `terminal:start-command` and retains `terminal:initial-command` for older clients. The proxy requires persistence
  support for creation with a command and for command reads and edits. It returns 501 `INITIAL_COMMAND_UNSUPPORTED` for an older Engine, including
  one with only one-shot support.
- tcli has no command that makes a terminal, so it has no `--command`; scripts use the API above.

## The New session dialog

- `NewSessionDialog` in `scripts/h5-shell/TaskDrawer.jsx` (opened by the "+" of a task, "New session" in the empty terminal area and Cmd/Ctrl+Shift+O)
  has, under the name field and on the first list only (`StartCommand` in `scripts/h5-shell/screen-start-command.jsx`, a chunk of its own loaded by `lazy-screens.jsx` when the dialog opens, so the first screen does not grow), the text button "Run a command when it starts" (`#h5-start-command-toggle`, a chevron,
  `aria-expanded`, 44px in touch mode). Folded at every opening. Unfolded: a multiline monospace field (`#h5-start-command-input`,
  2 to 6 rows, `maxlength` 4,000, helper text "Typed into the shell every time this session starts, then Enter. The terminal stays open.") and a "Recent" text
  button (`#h5-start-command-recent`) whose menu lists the last 10 commands (one line each, lines joined with ⏎); a pick fills the field.
- Enter in the field is a new line; Cmd/Ctrl+Enter makes New Terminal. While a command is typed (unfolded and not blank) the other kinds are greyed
  with "Only a terminal runs a start command" and New Terminal is the highlighted choice, so Enter in the name field makes it. Folding the field
  keeps the text but sends no command. A sub-list (Claude, Codex, OpenCode, notebook) has no field.
- h5.js: `ui.actions.menuCommand` keeps the text (`newCommand`), `startSession` sends it only for New Terminal (no `agent`), and after the terminal was
  made calls `ui.actions.startCommandUsed`, which remembers it for Recent. The text is cleared when the dialog closes and at each opening.
- An Engine without `terminal:start-command` (`startCommandState` in h5.js; this machine always has it): the field and Recent are disabled and the
  caption "This computer needs an update to run a command at start" stands under the button. While a remote Engine has not said what it can do the
  field is disabled without the caption, and the list is drawn again when its `/info` answers.
- Recent: `scripts/h5-shell/start-commands.mjs`, the shared page state key `ta-start-commands` (`{ shell: { <command>: ms } }`), so the same list on
  every device and engine. A command used again moves to the top (one entry per text); the page keeps the 10 newest and drops the oldest while the
  value would be over 16,000 characters (a command that alone does not fit is not remembered). The server merges two versions per command by the
  later time and cuts to the 10 newest (`TIME_MAP_CAPS` in `services/page-state-merge.js`, then the oldest while over `VALUE_MAX`), the same on every
  side. See [shared-page-state.md](shared-page-state.md).

## The Start command dialog

The plain terminal's session-row "⋯" menu opens "Start command…" on the phone and the computer. The editor uses the New session dialog's
multiline field, with "Typed into the shell every time this session starts, then Enter." as its helper text. It loads the saved value. Cancel
dismisses it, Save keeps the field, and Remove clears an existing command. An older Engine shows the disabled "This computer needs an update
first" item. Agent sessions and notebooks have no start command action.

## Tests

`test/terminal-initial-command.test.js` covers cleaning, readiness, fresh shells, Restart, Reopen, exit, concurrent attachment and reconnect.
`test/terminal-initial-command-routes.test.js` covers editing and clearing, list privacy and proxy capabilities. `test/data-home.test.js`
covers the schema 28 migration. `test/start-commands.test.js` covers the shared Recent list. `scripts/test-h5-initial-command-browser.cjs`
covers both dialogs at 1440x900 and 390x844. The readiness delay is a heuristic. A shell that draws the prompt after 3 s gets the command
typed ahead.
