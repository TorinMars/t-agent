# Shell notebook: the page

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md). The engine side (the kernel, the .ipynb file, the API and its stream) is in [shell-notebook.md](shell-notebook.md).

A shell notebook is a session of a task after Claude, Codex, OpenCode and New Terminal: cells of shell commands and Markdown text, run in order by one long-lived shell of the task's engine, so `cd`, variables and functions carry over from cell to cell. The design was confirmed on the artboard `Notebook.dc.html` of the design canvas (2026-11-23).

## Where the code is

- `scripts/notebook/`: the view, plain DOM like the mind map view (the page's React bundle is not available to a lazy IIFE). `entry.js` (adds the styles, `mount`), `view.js` (the view), `ops.mjs` (ops and stream events, pure), `sgr.mjs` (SGR colours and the output window, pure), `model.mjs` (texts, shell highlighting, Download .ipynb, pure), `markdown.mjs` (text cells), `notebook.css`. Built by `npm run build:notebook` (esbuild IIFE, global `NotebookUI`) into `public/js/notebook-ui.js`; commit the built file.
- `public/js/notebook.js`: the small loader on every page (`data-combine` in `public/h5.html`). `Notebook.mount(...)` returns at once and fetches `notebook-ui.js` the first time a notebook is opened, by the hash the page carries (`window.TAAsset`, lib/static-assets.js), so it is cached for a year like the other lazy bundles.
- `public/js/h5.js`: the session kind, the sub-list, `showNotebook` / `closeNotebook`, the task list's line, `ui.actions.notebookAction` (the header's menu), `renameShown`.
- `scripts/h5-shell/Header.jsx` `NotebookHeader`: the session header while a notebook is shown (`state.notebook`).

## Session kind and the New session dialog

- `SESSION_KINDS` has `['notebook', 'Shell notebook']`, drawn after New Terminal (`AFTER_TERMINAL`), with the caption "Cells of shell commands that share one shell" (`KIND_NOTES`) and the flask mark. `AGENT_CAPABILITY.notebook = 'terminal:notebook'`: an engine whose `/info` does not list it shows the row greyed with "<engine> needs an update first", as for OpenCode. Enter on the highlighted row makes a new notebook at once.
- Its sub-list reads `GET {tasksBase}/:id/agent-sessions?agent=notebook`: New notebook (`POST …/terminals { agent: 'notebook', title? }`), then each .ipynb file of the task (title, caption "release-check.ipynb · 11-23 14:21"; a press posts `{ agent: 'notebook', session_id: <path> }`), then Back. An answer with `existing: true` (the file already has a row) opens that row instead of listing it twice (`createTerminal`).
- Not built: the mockup's "Open a .ipynb file…" row. The list already holds the .ipynb files of `notebooks/` and of the task folder (the server's rule); a file elsewhere is not offered.

## Mount

`Notebook.mount(host, options)` (and `NotebookUI.mount`) returns `{ destroy(), flush(), setActive(on), action(name) }`. The contract's options: `api` (`{ get, post }`, errors with `.status` and the code as `.message`), `base` (`{tasksBase}/:id/notebooks/:tid`), `notebookId`, `title`, `notify(message, kind)`, `onTitle(title)`, `embedded`. The page adds:

- `embedded: true` (a column of the multi-column view, which has no page header): the view draws its own header (flask, title, "task · path · Saved", the shell's chip, a menu). Otherwise the page header shows the notebook.
- `onStatus({ path, saved, live, kernel: { text, tone }, line, running })`: the header and the task list follow it.
- `onOpenTerminal()`: "Open in a terminal" of a full-screen cell; h5.js makes a New Terminal in the same task (`createTerminal({})`).
- `onRename()`: the menu's Rename; h5.js opens the task sheet with the name field on the row (`renameShown`, also the column header's Rename).
- `onGone()`: the stream ended and `GET {base}` answered 404 (the row was deleted elsewhere); h5.js reads the terminals again, which closes the view.
- `taskTitle`, `active`.
- `action(name)`: `rename`, `download`, `clear`, `stop-shell`, `restart` (asks first), `run-all`.

## Over the terminal area

- A row with `agent === 'notebook'` has no terminal socket: `connect()` calls `showNotebook(row)` instead, which mounts the view in `#h5-notebook` (fixed, like the chat: from the bottom of the page header to the bottom of the visual viewport, above the phone's bottom navigation, `fitNotebookView`; left of it the rail and the sidebar on a wide screen). An early socket opened for a remembered notebook row is dropped.
- It is not kept warm: another row, another task (`loadTerminals`), no terminal (`showNoTerminal`), Delete or Restart of the row (`disconnect`) and the multi-column view being shown unmount it; `destroy` still sends what was typed.
- The bottom bar, the terminal keyboard, the saved commands and the wheel strip lie under the view; "Copy text" is not offered (no terminal session); the header has no Wide terminal button.
- A notebook whose cell finished while it is shown is acknowledged (`ackNotebook`, `POST …/terminal/ack`), so the activity feed does not keep it as "needs you".

## Session header

`NotebookHeader` (Header.jsx), while `state.notebook` is set:

- Computer: the sidebar toggle, then (in the task name's button) the flask, the notebook's name over "task · notebooks/x.ipynb · Saved" ("Saving…", "Not saved, retrying…", "Reconnecting…" while the stream is down), the shell's chip ("zsh · Running cell 3" green, "zsh · Idle", "Shell stopped" grey, "zsh · Starting", "zsh · Waiting for input"), and "Notebook menu".
- Phone: the Tasks button, the name over the shell's state in its colour, and the menu.
- The menu: Rename, Download .ipynb, Clear outputs, Stop shell, Restart shell, a divider, Refresh the page (and Update on a phone). An action runs once the menu has closed, so the focus it gives back cannot leave the restart dialog.

## Task list line

`sessionRow` in h5.js: a notebook row's second line is `line`: "Notebook · Running cell 3" / "Notebook · Idle" / "Notebook · Shell stopped" from the view while it is shown here, else "Notebook · Running" / "Notebook · Idle" from the activity feed (it knows only whether a cell runs). Its dot is green while running, grey otherwise ("needs you" is not shown for a notebook). The kind's name is "Shell notebook" (`kindOf` in TaskDrawer.jsx and Switcher.jsx, Recent's `KIND_NAMES`, `recent-rows.mjs`); `AGENT_NAMES.notebook = 'Notebook'` (column and session headers). `'notebook'` is in the agent sets of `columns.mjs`, `recent-sessions.mjs` and `services/page-state-merge.js`, so the shared Recent list keeps the kind.

## The view

- Wide (900px and up): a 48px toolbar (Run, Run all, Stop, Restart shell | + Code, + Text | Clear outputs), cells with a 64px gutter: the run / stop button (36px; shown on hover, the selected and the running cell) over the count `[3]`, `[*]` running, `[ ]` queued or never run. "+ Code / + Text" between cells under the pointer; the key hint at the end (pointer only).
- Phone: each cell has a head row (count, meta line, the 44px run / stop button at the right); the action bar Run · Run all · Stop · + Cell sits right above the bottom navigation. Every target is at least 44px in touch mode, the editor and the input field use 16px text (iOS does not zoom).
- Run = run the selected cell and go to the next (as Shift+Enter). Run all sends every code cell. Stop is `interrupt`. Restart shell asks "Restart the shell?" (MD2 dialog: h6 title, body, Cancel then Restart in the error colour, because the shell's state is lost; the mockup drew it blue). Stop shell (menu) is `stop`.
- Meta line: "Exit 0 · 0.3 s · 14:20" with a check; failed: "Exit 1 · 0.8 s · 14:20" in the error colour, with "Run all stopped here" when its failure cleared queued cells, and its output tinted; "Stopped (Ctrl+C) · 12 s · the shell keeps its state" in the warning colour; "Running · 0:38 · Ctrl+C stops it" with a spinner (ticks every second); "Queued · runs after cell 3"; "Not finished: the shell was restarted" ("… stopped" when the shell is stopped). Cell numbers are positions among the code cells. Each part is translated on its own.
- Input field: under the running cell whenever a cell runs (`waiting_input` is only a hint: it changes the caption to "The command asks for input" and the emphasis, and focuses the field with a pointer device). Enter sends (`POST …/input`), "Hide what I type" makes it a password field.
- Full screen: "<program> draws a full screen, which a cell cannot show. It was stopped." with the cell's `program` from the engine (the cell's first word for an older answer; "This program …" when the engine says "The program"), and "Open in a terminal".

## Code editor

A textarea over its own highlighted copy (`pre.nb-hl`) in one grid cell with the same font, padding, wrapping and tab size, so the textarea sets the caret and selection and the copy shows the colours (its text is transparent). It grows with its content (the copy has a trailing newline). Tab inserts two spaces. Highlighting (`shellTokens` in model.mjs): shell keywords and builtins in a command's place, strings, `$VAR` / `${…}`, comments; it never changes what runs.

## Long cells fold

Confirmed on the artboard `NotebookFold.dc.html` (2026-11-23).

- A code or text cell of more than 12 screen lines (`FOLD_OVER`; a long line counts as the lines it wraps to) shows its first 8 (`FOLD_SHOW`), the end faded into the box's colour, and "Show all 42 lines" under it (the down chevron, `down` in Icons.jsx). Open, the same button at the end says "Show less" (the chevron turned up). A short cell has no button and never folds. N is the lines of the text (`lineCount`); a few very long lines that wrap past the fold count as their screen lines (`foldLabel`), so N is never less than what is already shown.
- Measured, not guessed: the screen lines are the drawn height of the text (the highlighted copy `pre.nb-hl` of a code cell, `.nb-md` of a rendered text cell) over its line height (`screenLines`), so the wrap width is the one the cell has now. One `ResizeObserver` watches those elements and decides before the frame is painted, so typing, an op from another device, a new width, the touch font and Markdown that finished loading all count. Before a cell is laid out (a hidden view) the lines of its text stand in.
- Folding only cuts the box around the text (`max-height` on `.nb-code` / `.nb-md-box`, `data-folded` on the cell); the textarea, its highlighted copy and their growing are untouched, and the editor always holds the whole text. Run, Run all and Shift+Enter run every line of a folded cell and leave it folded; the queued / running states and the output do not change it (the output keeps its own "Last 200" fold).
- Opening: Show all; a click or tap into the folded code (the fade lets it through to the editor), Enter in command mode, or the cursor arriving from the cell above (Shift+Enter there): the editor's focus opens the cell at once, so nothing is typed into hidden lines. A click into folded rendered text (not on a link) opens it; a double-click still edits. Z in command mode folds or opens the selected long cell. The button is a Tab stop (Enter or Space), 32px high, 44px in touch mode.
- A long cell that was opened, or whose editor had the focus while it was long (or a text cell just written long), stays open while the notebook is open (`opened`, per mount); leaving the editor does not fold it. Show less and Z fold it again. A cell whose editor has the focus is never folded (`foldOf`): an op from another device that makes it long leaves it open; one that makes another cell long folds that cell.
- Not saved: folding is how this page shows the cell; every page folds long cells the same way when it opens the notebook. The file is unchanged (Jupyter's "hide input" flag is left alone).

## Keys

- Edit mode (focus in an editor): Shift+Enter runs and goes to the next cell (a new code cell at the end), Cmd/Ctrl+Enter runs in place, Cmd/Ctrl+Shift+Enter runs all, Esc goes to command mode.
- Command mode (focus on the cell): Enter edits (and opens a folded cell), A / B add a code cell above / below, D D deletes, M makes it text, Y code, Z folds or opens a long cell, Up / Down (and K / J) move the selection; Shift+Enter, Cmd/Ctrl+Enter and Cmd/Ctrl+Shift+Enter as above.
- In a column of the multi-column view Cmd/Ctrl+Shift+Enter keeps maximizing the column (pane.mjs takes it first); Run all is the toolbar button there.

## Text cells

Rendered with the page's Markdown renderer (marked and `css/markdown.css`, loaded on first use with the page's hashes; raw HTML shown as text, only web / mail links and web images live, the same rules as the design sheet), dark overrides in `notebook.css`. Double-click or Enter edits; leaving the editor, Shift+Enter or Cmd/Ctrl+Enter renders it.

## Edits and the stream

- The view loads `GET {base}` and follows `GET {base}/events` with fetch (so the status is seen), reconnecting after 1, 2, 4, 8, 15 s; a stream with no byte for 50 s is dropped. Every connection starts with a snapshot. A stream that ends normally may mean the row was deleted: the view reads `GET {base}` and on 404 says "This notebook no longer exists" and calls `onGone`.
- Ops (`createOpQueue`): a cell's text goes as one `set` 400 ms after typing stops; insert / delete / type go at once; one request at a time, at most 200 ops (and about 4 MB) each; `flush` sends everything before a run. A network failure is retried with the same ops; a refusal (4xx) drops them, says so and reads the notebook again. A source over 1 MB is not sent.
- Remote ops (`by` another client) are applied in order; a cell whose text this page has not had saved keeps its text (its own `set` wins at the engine, last write wins). A snapshot is applied with this page's pending ops again on top, so a cell typed here never disappears. Output events change the lines in place; a `from` past the end means an event was missed and the notebook is read again; `from: 0` replaces them.

## Output

- SGR (`sgr.mjs`): 16 colours (the terminals' xterm palette), 256 colours, truecolour (`;` and `:` forms), bold, dim, italic, underline, inverse; the style carries over from line to line (the style at the start of the drawn window is computed from the lines before it, cached per cell). Spans are made with `textContent`; leftover escapes lose their ESC.
- Long output: the last 200 lines with "Last 200 of 12,408 lines · Show all · Download" (Show less back; "The first N lines were not kept" when the engine dropped some). Download writes the kept lines as `<notebook>-cell-<n>.txt` without SGR codes.
- Fast output is drawn once per animation frame per cell, from the first changed line on.

## Download .ipynb

Made on the page from the notebook shown (`ipynbOf`): nbformat 4.5, bash kernelspec, one stream output per code cell with SGR codes kept, the execution count and `metadata["t-agent"]`. Notebook metadata the file on the engine keeps beyond that is not in this copy.

## Tests

`test/notebook-sgr.test.js`, `test/notebook-ops.test.js` (also model.mjs, with the fold rule), and `scripts/test-h5-notebook-browser.cjs`: a stand-in engine (express on a free port) with the contract's API and stream and a scripted shell, at 1440x900 and 390x844 touch (also the folding: a 42-line cell shows 8 lines with the button, Show all / Show less, Z, a click into the folded code, Enter, the cursor from the cell above, Run, ops from another device with and without the focus, a text cell).

## Not verified

A real engine (the server half was built at the same time against the same contract), a real remote engine through the proxy, real phones (iOS keyboard and visual viewport with the input field, the 16px editor), real fast output.
