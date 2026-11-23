# Shell notebook

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

A kind of session in a task beside Claude, Codex, OpenCode and New Terminal: cells of shell commands (code cells) and Markdown text cells, like
Jupyter, with the person's own shell as the kernel. One long-lived shell per notebook runs the code cells one at a time, in order, so `cd`,
variables, functions and `source`d environments carry over from cell to cell. This file describes the server side (`lib/notebook-format.js`,
`services/notebook-kernels.js`, `routes/notebooks.js` and the notebook parts of `routes/terminal.js`); the page side is in
[shell-notebook-page.md](shell-notebook-page.md).

## Identity and storage

- A notebook is a `task_terminals` row with `agent = 'notebook'` (no schema change). `agent_session_id` holds the notebook file's path relative
  to the row's folder (`notebooks/release-check.ipynb`), `work_dir` that folder: the task's working directory at creation, else the folder of
  the task's Markdown file (`notebookFolder`). A task with neither: 409 `TASK_HAS_NO_FOLDER`. A task rename or move rewrites `work_dir` like a
  terminal's; the file moves with the folder.
- Made by `POST {tasksBase}/:id/terminals { agent: 'notebook', title?, session_id? }` (`createNotebook` in `routes/terminal.js`):
  - no `session_id`: a new `notebooks/<slug>.ipynb` with one empty code cell (`createNotebookFile`; `-2`, `-3` when taken). The slug keeps any
    script, turns `/ \ : * ? " < > |` and whitespace runs into `-`, drops control characters and leading or trailing dots and dashes, at most 60
    characters, `notebook` when empty. Title "Notebook N" unless one was given (then `title_custom`).
  - `session_id`: a relative path of an existing `.ipynb` in the folder; title = the file's base name (cut to 40 characters). A path that leaves
    the folder (also through a symbolic link: real paths are compared), that is not `.ipynb` or that is missing: 400 `INVALID_NOTEBOOK_PATH`.
    A notebook row of the task that already has this file is answered instead of a second row, so two shells never write one file.
  - The answer is the terminal row plus `agent: 'notebook'` and `notebook` (the path).
- `GET …/terminals` lists the row with `agent: 'notebook'` and `notebook: '<path>'` (`withNotebooks`). Rename, order, Recent, columns and the
  switcher use the terminal paths unchanged; the session-binding code of agent terminals (`withAgentSessions`, `reopenCommand`, the Codex binder,
  `bindReportedSession`, the agent rename) never sees a notebook row.
- `GET …/agent-sessions?agent=notebook` -> `[{ id: 'notebooks/x.ipynb', title: 'x', updated_at: <ms> }]`: the `.ipynb` files directly in
  `<folder>/notebooks/` and in `<folder>`, newest first, at most 200, links that lead out of the folder left out (`listNotebookFiles`).
- The terminal WebSocket closes a notebook row with 1008 `NOTEBOOK_NOT_A_TERMINAL` before any shell starts (`handleWs`). The row controls
  (`POST …/terminal/control`): `restart-workdir` starts a fresh kernel (none for an archived or moving task), `close` stops it, `delete` stops it,
  ends the notebook's event streams and removes the row; the `.ipynb` file is kept.

## The file

nbformat 4.5 (`lib/notebook-format.js`).

- Read: `cells[]` with `cell_type` code, markdown or raw (raw and unknown kinds are shown as markdown and written back as they were); `source` as
  a string or an array (joined); `id`, made (8 random hex characters) when missing, malformed or repeated; code cells' `execution_count` and
  `outputs` (stream text joined; `execute_result` / `display_data` `text/plain`; `error` traceback lines), turned into lines by the normaliser;
  our metadata `metadata["t-agent"] = { state, exit, duration_ms, started_at, ended_at, dropped?, program? }`. A cell saved while it ran reads
  back as `interrupted`; a cell without our metadata is `done` when it has an `execution_count`, else `idle`. An empty file is a new notebook.
  Not JSON or not nbformat 4: 422 `NOTEBOOK_FILE_UNREADABLE`; larger than 20 MB: 413 `NOTEBOOK_TOO_LARGE`.
- Write: `nbformat: 4`, `nbformat_minor: 5`, `metadata.kernelspec = { name: 'bash', display_name: 'Bash', language: 'bash' }`,
  `metadata.language_info = { name: 'bash' }`, every other notebook and cell field kept; keys sorted (as Jupyter writes them), 2-space JSON and a
  trailing newline, atomically (a temporary file in the same folder, then a rename; owned by the terminal user when a root service drops to one).
  Sources as Jupyter's line arrays. A code cell that ran here: one `stream` / `stdout` output with the kept lines (SGR codes kept) or `[]`, and
  our metadata; a cell that did not run here keeps its original outputs (pictures of a notebook made elsewhere survive) and gets no metadata.
- Saved while a cell runs at most every 2 s, when it ends, and 300 ms after cell changes. `GET` reads the file again when it changed on disk
  (inode, size, times) since our last read or write and nothing runs, is queued or waits to be saved; the followers then get a new snapshot.

## Output lines

`createOutput` turns a terminal's output into the lines a cell shows, as a terminal would show them: `\r\n` and `\n` end a line, a bare `\r`
returns to the line start (later text overwrites; a progress bar ends as its last state), `\b` deletes one character (at the end of the line;
in the middle it moves back), `ESC [ K` erases as a terminal does, SGR (`ESC [ … m`) is kept in the text, every other escape sequence (other CSI,
OSC, DCS, SOS, PM, APC, charset and two-byte escapes) and control character except `\t` is dropped. A chunk may end inside a sequence or a
surrogate pair: the rest waits for the next chunk. Lines longer than 4000 characters wrap. A cell keeps the last 10,000 lines and at most 2 MB;
`dropped` counts the lines cut from the front. SGR state is not closed at line ends: a colour started on one line goes on until it is reset, as
in a terminal, so the page carries it across lines.

## The kernel

`services/notebook-kernels.js`, one per notebook row, started by the first `run` or a restart (opening a notebook starts nothing), kept while the
server runs; closing the page does not stop it.

- Start: `terminalLaunch` of `routes/terminal.js` gives the shell (`/bin/zsh`, else bash, else sh), the folder, the user (the terminal user drop
  of a root service) and the environment every terminal gets (PATH additions, clipboard shims, UTF-8 locale, `TA_HOOK_URL` / `TA_HOOK_TOKEN` /
  `TA_TCLI`, a T-Attention token for this terminal id, ended with the kernel), without `TERM_PROGRAM` and the like of the terminal the server was
  started from. node-pty, 120 x 40, a login shell (`-l`, not for sh). The first line (with Ctrl+U before it and a leading space) unsets
  `HISTFILE`, empties `PS1` / `PS2` (zsh: `PROMPT`, `RPROMPT`, `RPS1`, `PROMPT_EOL_MARK`), exports `PAGER`, `GIT_PAGER` and `MANPAGER` as `cat`
  (a pager would take the full screen and be stopped, so `git log` prints straight through), in bash puts a prompt marker before the person's
  `PROMPT_COMMAND` (which still runs), and prints the ready marker. No ready marker within 30 s, a spawn error or a shell that ends at once:
  the first queued cell gets the line "The shell did not start: <reason>" and fails, the other queued cells are idle again.
- Markers: OSC 6973, which terminals ignore: `ESC ] 6973 ; ready ; <nonce> BEL`, `… ; start ; <run id> BEL`, `… ; end ; <run id> ; <exit> BEL`
  and (bash) `… ; prompt ; <nonce> BEL`. Each cell is written to `<run id>.sh` in a private 0700 folder under the OS temp directory (removed after
  the run and with the kernel) and run as one typed line: `\printf <start>; . '<file>'; \printf <end> "$?"` (the backslash keeps an alias from replacing `printf`); in zsh inside
  `{ … } always { <end>; TRY_BLOCK_INTERRUPT=0 }`, so the end marker comes also when Ctrl+C ends the cell. Only what comes between a run's start
  and end marker is its output; the echo of the line, prompts and what `precmd` / `PROMPT_COMMAND` print are dropped.
- Queue: one cell at a time, in the order asked. A cell that does not end `done` (exit != 0, stopped, full screen, interrupted) clears the rest
  of the queue (those cells are `idle` again), so Run all stops at the first failure. `execution_count` counts from 1 in every new shell.
- Stop (`interrupt`): Ctrl+C to the terminal and the queue cleared; bash also gets SIGINT itself (it would otherwise go on with the rest of the
  sourced file). A bash line cut short shows its prompt marker, which ends the run; otherwise, when no end marker came within 1.5 s and the shell
  owns the terminal again (`pty.process`), the cell ends. Either way: `stopped`, exit 130 (also when the shell reported 0).
- Full screen: `ESC [ ? 1049 h`, `? 47 h` or `? 1047 h` in a cell's output -> Ctrl+C at once, SIGTERM to the foreground process group after 1 s
  and SIGKILL 2 s later (`services/terminal-reaper.js`; vim and less ignore Ctrl+C). What the program drew is not kept; the cell ends `fullscreen`
  with `program` (the foreground program's name, else "The program").
- Input: `POST …/input` writes the text and Enter. `kernel.waiting_input` is true while a cell runs, printed nothing for 800 ms, and either the
  shell itself owns the terminal (a `read`) or the output stops in the middle of a line (a prompt). It is a guess: a quiet `cat` is not seen, a
  busy loop of shell built-ins is.
- `exit` in a cell ends the shell: the cell ends with the shell's exit code (`done` / `failed`) and the kernel is `stopped`.
- Restart: the shell ends (its foreground jobs get SIGTERM, the shell SIGHUP, SIGKILL after 2 s), the running cell becomes `interrupted`, the
  queue is cleared, a new shell starts (`starting`, then `idle`). Stop: the same without the new shell.
- Ends with the server (`shutdownTerminals`: running cells `interrupted` and saved, foreground jobs and shells killed), with its row (delete) and
  with its task (`closeTaskTerminals`: archive, move, delete, repository clean-up).
- Tokens: the hook token is the HMAC of task and terminal id, so `tcli`, the peer file relay, open-link and `tcli notify` accept a notebook's
  terminal id like a terminal's (`verifyHookToken` checks no live shell); the T-Attention token is issued when the kernel starts and revoked
  when it ends. Hook activity reports from a cell (an agent run inside a cell) answer 404: a notebook has no activity tracker.
- Activity: a notebook that runs a cell is `running` for its terminal id in `activitySnapshot` (so in `GET …/terminal-activity`, the activity
  streams and the task list), in `liveTerminalActivity` (the desktop window, `agent: 'notebook'`) and in `updateIdleTerminals` (a running cell
  blocks an automatic update, an idle shell does not); `liveTerminalIds` includes a notebook whose shell runs (no folder rename under it). The
  service registers itself with `routes/terminal.js` (`setNotebookKernels`) when it is first used and calls `notifyActivity()` when a cell starts
  or ends.
- Memory: a notebook stays loaded while it is followed or its shell runs, and leaves memory 10 minutes after the last of these.

## HTTP API

`{tasksBase}/:id/notebooks/:tid`, where `tasksBase` is `/api/tasks` (this machine, `server.js`), `/v1/tasks` on an Engine (`routes/engine-v1.js`,
`requireEngineAuth('terminal:execute')`, the token's owner; the task visibility guard covers these paths and ends their streams when a link loses
the task) and `/api/remote-servers/:rid/tasks` (forwarded by `routes/remote-servers.js`: `GET` with up to 32 MB, the POSTs as JSON, `/events`
streamed). Every write is a POST. The task must be the person's (`user_id`); errors are `{ error: 'CODE' }`.

| Call | Answer | Notes |
| --- | --- | --- |
| `GET …/` | Notebook | Reads the file when needed (above). |
| `GET …/events` | `text/event-stream` | Below. |
| `POST …/ops { client, ops }` | `{ revision }` | 409 `TASK_ARCHIVED` / `TASK_MOVING`. |
| `POST …/run { ids, client }` | `{ kernel }` | Starts the kernel when stopped; 409 when archived; 404 `CELL_NOT_FOUND` when no id is a cell. |
| `POST …/interrupt` | `{ kernel }` | Ctrl+C, the queue cleared. |
| `POST …/restart` | `{ kernel }` | 409 when archived. |
| `POST …/stop` | `{ kernel }` | |
| `POST …/input { text }` | `{ ok: true }` | 409 `NO_RUNNING_CELL`; 400 `INVALID_NOTEBOOK_INPUT` (not a string, over 64 KB). |
| `POST …/clear { ids? }` | `{ revision }` | Outputs, exit and times cleared (all code cells without ids), counts kept, the revision unchanged; 409 when archived. |

- Notebook: `{ id, task_id, title, path, folder, revision, kernel, cells }`; `kernel = { state: stopped | starting | idle | busy, shell, running,
  queue, waiting_input, counter }`; a code cell `{ id, type: 'code', source, count, state, exit, duration_ms, started_at, ended_at, lines,
  dropped, program? }`, a text cell `{ id, type: 'markdown', source }`. `revision` goes up by one for every applied cell change (source, type,
  insert, delete, move), not for outputs; it lives in memory and goes up when the file is read again.
- Ops apply in order on the current state, last write wins per cell: `insert { index, cell: { id?, type, source } }` (the server makes an id
  when none is sent; an insert whose id exists already is skipped, so a resent request does nothing twice), `set { id, source }`,
  `type { id, type }` (outputs cleared when it becomes markdown; a queued cell leaves the queue), `delete { id }`, `move { id, index }` (the
  index in the list after removing it). At most 200 ops and 5 MB per request and 1 MB per source: 400 `INVALID_NOTEBOOK_OPS`, also for an
  unknown op or a bad shape. An op on a missing cell is skipped. A deleted or retyped running cell finishes unseen.
- Run: the given code cells in that order; markdown, unknown ids and cells already queued or running are skipped.
- Other errors: 404 `TASK_NOT_FOUND`, 404 `NOTEBOOK_NOT_FOUND` (no such row or not a notebook), 413 `NOTEBOOK_TOO_LARGE`, 422
  `NOTEBOOK_FILE_UNREADABLE`, 400 `INVALID_NOTEBOOK_PATH`, 409 `TASK_HAS_NO_FOLDER`, 500 `NOTEBOOK_FAILED` (unexpected). Their Chinese is in
  `public/js/i18n-zh-server.js`; the start-failure sentences are in `public/js/i18n-zh-extra.js`.

## Events

`GET …/events`: `data: <json>\n\n` per event and `: ping` every 20 s. One JSON text per event is made and written to every follower.

- `{ type: 'snapshot', notebook }` first, and again after the file was read again from disk.
- `{ type: 'ops', revision, ops, by }`: the applied ops (with the ids the server made), `by` = the sender's `client`.
- `{ type: 'cell', id, patch }`: only the changed keys of state, exit, count, duration_ms, started_at, ended_at. A run sends `queued`, then
  `running` (with `count`, `started_at` and nulls), then the end (`state`, `exit`, `duration_ms`, `ended_at`).
- `{ type: 'output', id, from, lines, dropped }`: replace the cell's lines from index `from` on with `lines`; `from: 0` with no lines clears (sent
  when a run starts and by clear). While a cell runs at most every 80 ms; when lines were cut from the front the event replaces every line
  (`from: 0`), at most once a second.
- `{ type: 'kernel', kernel }`: the whole kernel object, after every change of it.
- The stream ends (cleanly) when the row is deleted.

## Remote engines

The shell runs on the Engine of the task. The page of another device reaches it through `/api/remote-servers/:rid/tasks/:taskId/notebooks/...`
(the Client forwards with the link's token). `/v1/info` lists `terminal:notebook`; the Client refuses `POST …/terminals { agent: 'notebook' }` to an
Engine without it with 501 `NOTEBOOK_UNSUPPORTED` (an older Engine would make a plain shell), and the page greys the kind out for it.

## Limits

- One kernel per notebook; no other kernels, pictures or charts in outputs (kept from files made elsewhere, never made here), scheduled runs or
  agents running cells.
- A cell's stdin is the terminal: text sent with `input` while no program reads it is read by the shell after the cell (as in a terminal).
- `local` and `typeset` / `declare` at the top of a cell behave as at a prompt (the cell is sourced in the shell itself, not in a function).
- Files written while outputs are large can pass 20 MB, and then cannot be opened again until outputs are cleared in another editor.
- Two pages that edit the same cell at once: the last write wins.

## Tests

- `test/notebook-format.test.js`: the normaliser (`\r`, `\b`, SGR kept, other CSI / OSC / DCS / charset dropped, split chunks, wrap, caps,
  changes), reading a Jupyter file (array sources, missing and repeated ids, rich outputs, raw cells, unknown fields) and writing it back, round
  trip of our metadata, unreadable and too large files, atomic writes, slugs, paths (escape by `..`, absolute paths, symbolic links), new files and
  the list.
- `test/notebook-kernel.test.js` (real pty, `/bin/bash` and `/bin/zsh`, a HOME whose start files print and set fancy prompts): state between
  cells, exit codes, Run all stopping at a failure, Stop of `sleep 30`, `read` with input, restart, full screen, the file, the hook token, the
  activity feeds, `exit` in a cell, a shell that cannot start.
- `test/notebook-routes.test.js`: create and list through the terminal routes, the document, ops, run and the order of events, clear, reading a
  file changed on disk, delete ending the stream, the errors, paths out of the folder, the WebSocket refusal, the row controls, rename, the
  activity, `/v1` with a token and `/v1/info`, the Client's forwarding and its refusal of an older Engine.
