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
- Typing: the lines are held in memory (`pendingStartup`, as the agent start commands) until the terminal's shell is spawned, which happens when a page
  first opens the terminal (`getOrCreateSession`). Then `typeWhenReady` waits for the shell's first output and then 250 ms without output
  (`INITIAL_QUIET_MS`: the prompt is drawn, also after an rc file that prints several chunks); a shell that prints nothing or never goes quiet gets it
  after 3 s (`INITIAL_WAIT_MS`). Each line is written as `<line>\r`. Nothing is typed into a shell that ended or was replaced. The command runs once:
  Restart, Reopen after close or a service restart start a plain shell. A service restart before the terminal was first opened loses the command.
- Privacy: the text is never logged, never put into events, T-Attention items or the usage tables. The terminal history holds what the shell echoed,
  as for typed input.
- Capability: `/v1/info` lists `terminal:initial-command`. The Client's proxy forwards `command` only to an Engine that lists it; to an older one it
  answers 501 `INITIAL_COMMAND_UNSUPPORTED` before anything is made (an older Engine would ignore the field and open a terminal without running it).
- tcli has no command that makes a terminal, so it has no `--command`; scripts use the API above.

## The New session dialog

- `NewSessionDialog` in `scripts/h5-shell/TaskDrawer.jsx` (opened by the "+" of a task, "New session" in the empty terminal area and Cmd/Ctrl+Shift+O)
  has, under the name field and on the first list only (`StartCommand` in `scripts/h5-shell/screen-start-command.jsx`, a chunk of its own loaded by `lazy-screens.jsx` when the dialog opens, so the first screen does not grow), the text button "Run a command when it starts" (`#h5-start-command-toggle`, a chevron,
  `aria-expanded`, 44px in touch mode). Folded at every opening. Unfolded: a multiline monospace field (`#h5-start-command-input`,
  2 to 6 rows, `maxlength` 4,000, helper text "Typed into the shell as if you typed it, then Enter. The terminal stays open.") and a "Recent" text
  button (`#h5-start-command-recent`) whose menu lists the last 10 commands (one line each, lines joined with ⏎); a pick fills the field.
- Enter in the field is a new line; Cmd/Ctrl+Enter makes New Terminal. While a command is typed (unfolded and not blank) the other kinds are greyed
  with "Only a terminal runs a start command" and New Terminal is the highlighted choice, so Enter in the name field makes it. Folding the field
  keeps the text but sends no command. A sub-list (Claude, Codex, OpenCode, notebook) has no field.
- h5.js: `ui.actions.menuCommand` keeps the text (`newCommand`), `startSession` sends it only for New Terminal (no `agent`), and after the terminal was
  made calls `ui.actions.startCommandUsed`, which remembers it for Recent. The text is cleared when the dialog closes and at each opening.
- An Engine without `terminal:initial-command` (`startCommandState` in h5.js; this machine always has it): the field and Recent are disabled and the
  caption "This computer needs an update to run a command at start" stands under the button. While a remote Engine has not said what it can do the
  field is disabled without the caption, and the list is drawn again when its `/info` answers.
- Recent: `scripts/h5-shell/start-commands.mjs`, the shared page state key `ta-start-commands` (`{ shell: { <command>: ms } }`), so the same list on
  every device and engine. A command used again moves to the top (one entry per text); the page keeps the 10 newest and drops the oldest while the
  value would be over 16,000 characters (a command that alone does not fit is not remembered). The server merges two versions per command by the
  later time and cuts to the 10 newest (`TIME_MAP_CAPS` in `services/page-state-merge.js`, then the oldest while over `VALUE_MAX`), the same on every
  side. See [shared-page-state.md](shared-page-state.md).

## Tests

`test/terminal-initial-command.test.js` (validation, typing into a fake PTY after the first output and the quiet wait, the fallback, once only, not
logged), `test/terminal-initial-command-routes.test.js` (HTTP errors, the capability, the proxy forwarding and the 501 for an older Engine),
`test/start-commands.test.js` (Recent: dedupe, 10 at most, size, the server merge), `scripts/test-h5-initial-command-browser.cjs` (the dialog at
1440x900 and 390x844). Not covered: the prompt timing of real shells (zsh with a slow rc file, fish, a remote login shell); 250 ms of quiet after the
first output is a heuristic, and a prompt drawn later than 3 s still gets the command, typed ahead.
