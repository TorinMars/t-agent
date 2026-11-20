# Moving a task to another machine

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

"Move to another machine…" in a task's "⋯" menu moves the task, with its folder, its documents, its place in the shared order and its agent sessions,
to a linked engine. Mockup `MoveTask` of the single-system-image program. Code: `services/task-move.js` (both sides, the journal, recovery),
`lib/task-move-files.js` (scan, manifest, path rules, verify, journal files, trash sweeper), `routes/task-move.js`, the proxy in
`routes/remote-servers.js`, `askTaskMove` / `taskMoveStart` / `pollMove` in `public/js/h5.js`, `scripts/h5-shell/MoveTask.jsx` (in the task dialogs
chunk). Tests: `test/task-move-files.test.js`, `test/task-move.test.js`, `test/task-move-record.test.js`, `scripts/test-h5-task-move-browser.cjs`.

## What moves

- **The task**: title, group (the same key on the target, else a group of the same name, else a new one with that name, else To do), priority, due
  date, creation time; terminal rows (ids, names, agent and session ids, their folders moved), the default terminal's name / removal / folder, the
  terminal order, to-dos, agent chats, cleaned-repository records. Per-task visibility: each denied link is translated to the machine it leads to and
  the target denies its own link to that machine. Not carried: the share link (make a new one), running processes.
- **The folder**: every entry, hidden files and `.git` included. Symbolic links are copied as links (their text; never followed); an absolute link into
  the old folder is pointed into the new one. Modes (`& 0777`) and modification times are kept; sockets, FIFOs and devices are skipped and counted.
  On the target the folder is `<tasks folder>/<old folder name>` (`-2`, `-3` when taken), always a direct child of the tasks folder.
- **Documents kept outside the folder** (a technical, readme or agent document at another path): copied into the new folder under their name
  (`moved-<kind>-<name>` when taken); the originals stay on the source (they may be shared).
- **Agent sessions**: the Claude Code session files (`projects/<project>/<id>.jsonl` and `<id>/…`) and Codex rollouts of the task's terminals and
  chats, only when the session was started in the folder. On the target they go to the first Claude / Codex home (`defaultAgentDirs` of
  services/task-rename.js), Claude under the project name of the new folder's real path; their `cwd` (and Codex workspace roots) are rewritten, message
  text is not. A file that already exists there is not overwritten (the dialog's result counts it as not carried). Not written: Codex's
  `state_<n>.sqlite` index and `session_index.jsonl` (Codex finds `codex resume <id>` by id; its TUI may ask once about the directory), Claude Code's
  per-folder trust in `~/.claude.json`, the prompt history. No other project's file is read or touched.

## Rules and refusals

- Offered for a task of this machine when it has a service link, and of an online Engine that lists `tasks:move`; the targets are the source's
  online linked engines that list it (`GET /v1/task-move/capacity`). The dialog orders them with `device-order.mjs` and shows each refused one
  disabled with its reason (offline, update first, hidden from it, not enough space, too large).
- **The folder** must pass the delete rules (`taskDirectoryGuard`: not a protected folder, not shared with or holding another task's folder) and the
  Git rule of the folder rename (`worktreeReason`: not a worktree or submodule, no linked worktrees). Decision: otherwise the move is refused with the
  reason (`MOVE_FOLDER_NOT_MOVABLE`), not done without the folder: a task whose folder stays behind would have nothing to work in on the target.
- **Size**: at most `TASK_MOVE_MAX_BYTES` (default 2 GiB, folder plus session files) and 200,000 entries, on both sides; the target needs the size plus
  64 MB free in its tasks folder. The dialog shows the counts before Move.
- **Between tiers** (a company computer and a normal machine, `company_computer` of `/v1/info`): the person ticks "I understand, move it anyway"; the
  page sends `tier_ack`, the source refuses without it (`MOVE_TIER_CONFIRMATION_REQUIRED`), and the target checks again against the source's own
  `/v1/info`.
- **Auth**: the page routes need the login (or, under `/v1/tasks/:id/move`, a link token: `LINKED_ONLY` otherwise); `/v1/task-move` takes link tokens
  only, a move answers only the link it is with, and the manifest, the files and the commit are refused for a task hidden from that link.
- **Terminals**: the live terminals are closed first (the dialog says how many, and how many agents are mid-turn: closing stops that turn), running
  chat turns are stopped, and until the move ends the task gets no terminal (`TASK_MOVING` from `createTerminal`, the WebSocket closes with 1008
  `TASK_MOVING`) and cannot be deleted. One move per task at a time (`MOVE_IN_PROGRESS`).

## The protocol

1. Page → source `POST {tasksBase}/:id/move { target, tier_ack }` (202). The source checks, journals `preparing`, locks, closes the terminals, waits
   1.5 s, scans and hashes the folder and the session and document files, writes the manifest (`<data>/task-moves/<id>.manifest`), journals `offered`
   and calls the target's `POST /v1/task-move/offer` (totals, folder name, tier tick).
2. The target checks (link, capability, tier, limits, space, path), journals `pulling` and, in the background, pulls `GET /:id/manifest` and every file
   `GET /:id/blob/:index` into `.t-agent-incoming-<id>/` in its tasks folder (hidden, so never offered for import): 8 MiB `Range` chunks, piped to the
   file (back-pressure through the tunnel's credit), 4 files at a time; a failed chunk is asked again from where it stopped (the hash goes back to the
   last whole chunk), 3 times. Progress goes to the source (`POST /:id/progress`).
3. Verify: modes and times applied, then every entry's type, size and SHA-256 read again from the target's disk, every link's text, and nothing extra.
   The target reports `creating` (awaited): from then on the source refuses a cancel (`MOVE_FINISHING`).
4. Create: the staged folder is renamed into place (journal `placed`), the rows are inserted **held** (`archived_at = 'moving:<id>'`: inert, listed
   nowhere, restore refuses it; journal `created`), the session files and documents are placed. Then `POST /:id/commit { task_id }`.
5. **Commit** (the point of no return) on the source: journal `committed` first; then the folder goes to `<data>/trash/moved-<task>-<time>/folder`
   (another file system: `<parent>/.t-agent-trash-moved-<task>-<time>`, named in `moved.json`), the session files to `…/sessions/`, the rows are
   deleted, the shared task order key is replaced in place, the moved record is written, the T-Attention items are re-pointed; journal `done`. The
   target then releases its hold (and sets the visibility) and removes its staging folder.

Cancel (`POST …/move/cancel`) works until step 3 ends: the source journals `aborted` and tells the target, which removes everything it made. Any
failure before the commit ends the same way: the source keeps its task and folder untouched, the target keeps nothing (rows, folder, staging, session
files and the folders made for them). A source that hears nothing from its target for 3 minutes gives the move up.

## Journal and recovery

Each side keeps `<data folder>/task-moves/<move id>.json` (written to a temporary file, flushed, renamed). At start (`startService`, after the links):

- Source `preparing` / `offered`: aborted (the target is told; the task stays). Source `committed`: the finishing steps run again (each is idempotent).
- Target `pulling`: undone, the source is told. Target `placed` / `created`: the source is asked (`GET /v1/task-move/:id`): open there → what is
  missing is created and the commit is sent; committed or done there → the commit answers so again and the hold goes; aborted or unknown there → undone;
  no answer → asked again every 30 s.

So the task is never live on two engines (the target's copy is held until the source has committed) and never lost (before the commit the source
has it; after it the target has it, held at worst, and the source's copy is in the trash). `test/task-move.test.js` crashes each side at every step
and checks this.

## The trash

`<data folder>/trash/moved-<task>-<time>/` holds the folder and the session files for 7 days; the sweeper (`sweepTrash`, at start and every 6 hours)
removes older entries, never following a link, and removes a folder kept elsewhere only when its name is one this code gives. Journal records of
finished moves go after 30 days.

## After the move

- **The moved record**: the source writes `{ from: { instance, task }, to: { instance, task }, title }` into the shared page state (`moves`, see
  [shared-page-state.md](shared-page-state.md)), kept 30 days. Every merge re-points the Recent entries, the column sessions (`h5-column:<pane>`) and
  the drafts (`ta-draft:<hash>`, re-keyed) of the old identity, on every engine alike, so links, columns and "Continue" open the task at its new place.
- **The shared task order**: the key `<source>:<id>` is replaced by `<target>:<new id>` where it stands.
- **T-Attention**: the source's items whose `context.tagent.task_id` is the task get `tagent.moved_to = { instance, task_id, terminal_id }`
  (task_id stays, so a page without the lookup offers the resume command instead of opening another task with the same id); `attention-model.mjs`
  opens `moved_to` by instance id among the rows of the one list.
- **The page** that started the move shows a notice ("Moved “Notes” to K01"), reads both lists again and, when the moved task was open, opens it at
  its new place. The carried terminal rows resume their sessions when opened.

## The dialogs

The Move task dialog (h6 "Move task", a sentence, the "Move to" select with a "Company computer" pill, the warning and the tick between tiers, the busy
agent line, "N running terminals will be closed. N files, size.", a refusal as an inline error; Cancel, Move contained and disabled until it can go)
and the progress dialog ("Moving “Notes” to K01", a determinate bar while copying, the phase line, "The task stays on T01 until everything has arrived
and was checked. You can close this; the move goes on."; Stop move until verified, Close). The progress is read every 700 ms while a move started or
seen on this page runs, also with the dialog closed; the same menu item opens the progress again.

## Limits

- Not tried between two real machines or through a real tunnel; tested with two engines in one process over real HTTP (the tunnel carries `Range` and
  streams with credit, as for raw files).
- A restart of either side during the copy starts nothing again by itself: the move is undone and the person starts it again (restartable, not
  resumable across restarts).
- Hard links arrive as separate files; ownership is the target service's user.
- Codex's state database is not written on the target (see "What moves").
