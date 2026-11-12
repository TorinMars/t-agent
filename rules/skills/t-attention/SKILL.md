---
name: t-attention
description: Track work in T-Attention, the user's list of tasks that need them (the t-attention command). Use it when you start multi-step work, before you hand work to a sub-agent, when your brief names a T-Attention task id, when finished work needs the user's confirmation, when you are blocked or need the user, and when the user asks to see their tasks, what needs them or what is in progress.
---

# T-Attention

T-Attention is the user's one list of tasks that need them: an answer, a decision, or a check that finished work is really done. Agents write to it with the `t-attention` command; the user reads it on the T-Agent page (the Attention button) and in chat. Its purpose is that the user never has to ask "what is going on" or "what do you need from me".

Talk to the user in the user's language. Task titles, notes and results you write may be in the user's language too.

## The command

In this file `t-attention` stands for this command. Use it exactly like this in every shell call, with the quotes:

```bash
"${TA_ATTENTION_CLI:-t-attention}"
```

- Inside a T-Agent terminal, `TA_ATTENTION_CLI`, `TA_ATTENTION_URL` and `TA_ATTENTION_TOKEN` are already set: it works with no setup.
- Elsewhere the part after `:-` is the path written when T-Agent installed this skill, and the server and token come from `t-attention login`.
- Shell variables do not survive between your tool calls, so write the full command each time.

Add `--json` to any command when you need to read the answer. The id of a new task is printed by `add`.

Exit codes: `0` ok, `1` wrong usage, `2` token or login problem, `3` no such task, `4` server not reachable. `127` means the command was not found.

## Statuses

| Status | Meaning |
|--------|---------|
| `todo` | Not started yet |
| `working` | Being worked on |
| `waiting_user` | Needs the user: an answer, a decision, an action |
| `review` | Finished; waiting for the user to confirm it is really done |
| `done` | The user confirmed it |
| `failed` | Could not be done |
| `cancelled` | Dropped |

Beside the status a task has:

| Field | Flag | Use |
|-------|------|-----|
| Custom status | `--custom-status` | A short free-text state shown next to the status, for example `Blocked` or `In testing; due Fri 18:00` |
| Result | `--result` | The outcome in one sentence |
| Notes | `--notes` | Lasting facts: deadlines, scope, links, what it waits for |
| Parent | `--parent` | The task this one belongs to (an id or `ref:<ref>`) |
| Timeline note | `--note` | A progress line on the task's timeline; it changes no field |

An empty value (`--result ''`) clears a field.

## Rules

### 1. The main session has one task

If you are the session the user talks to (not a sub-agent), your work has one task in T-Attention. Find it before you register anything under it:

1. In Claude Code, the Claude listener already keeps one task per session, with the ref `claude:<session id>`. Look for it:

   ```bash
   "${TA_ATTENTION_CLI:-t-attention}" show "ref:claude:$CLAUDE_CODE_SESSION_ID" --json
   ```

   If it exists (exit code `0`), its id is your main task. The listener sets its status by itself (working while you work, review when your turn ends, waiting_user when a dialog waits). Do not change that task's status yourself; use it only as the parent.
2. Otherwise (Codex, no listener, exit code `3`, or `CLAUDE_CODE_SESSION_ID` is empty) create your main task once and remember its id for the rest of the conversation:

   ```bash
   "${TA_ATTENTION_CLI:-t-attention}" add "<the goal in a few words>" --status working
   ```

   You own this task: move it to `review` when the work is finished (rule 4) and `confirm` it when the user confirms.

Do not register small one-step answers. Register work that takes several steps, runs for a while, or is delegated.

### 2. Register every sub-agent before you start it

Before you launch a sub-agent, register its work as a child of your main task:

```bash
"${TA_ATTENTION_CLI:-t-attention}" add "<what the sub-agent does>" --parent <main id> --status working --notes "Sub-agent"
```

Put the returned id in the sub-agent's brief, with the exact commands to report. A sub-agent starts with no context: anything not in the brief is missing. Copy this block into the brief and fill in the id:

```text
T-Attention task: <id>. Report on this task only, with this command (keep the quotes):
  "${TA_ATTENTION_CLI:-t-attention}" update <id> --note "<progress, one line>"
When finished:
  "${TA_ATTENTION_CLI:-t-attention}" update <id> --status review --result "<the outcome in one sentence>" --reason "<one sentence>"
When blocked (leave the status as it is):
  "${TA_ATTENTION_CLI:-t-attention}" update <id> --custom-status Blocked --result "<what went wrong>"
When only the user can unblock it:
  "${TA_ATTENTION_CLI:-t-attention}" wait <id> --reason "<what the user must do>"
Never run confirm, and never change any other task.
```

Sub-agents that edit the same files must run one after another, never at the same time. Register the later one as `todo` and say in its notes what it waits for:

```bash
"${TA_ATTENTION_CLI:-t-attention}" add "<second job>" --parent <main id> --status todo --notes "Waits for <first id>: both edit <file>"
```

When it starts, move it to `working`:

```bash
"${TA_ATTENTION_CLI:-t-attention}" work <id>
```

If a sub-agent ends without reporting, update its task yourself from what it returned. The list must never be left stale.

### 3. If you are a sub-agent

Your brief names your task id. Report only on that task, with the commands from your brief. Do not look up or change the session's task, and do not create a main task of your own. Use `--note` for progress that changes nothing about the task's state.

### 4. Finishing: review, never confirm

Finished work goes to `review` with a one-sentence result:

```bash
"${TA_ATTENTION_CLI:-t-attention}" update <id> --status review --result "<the outcome in one sentence>" --reason "<one sentence>"
```

The short form, when there is no result to record:

```bash
"${TA_ATTENTION_CLI:-t-attention}" review <id> --reason "<one sentence>"
```

`review` puts the task in the user's "Needs you" group, so the user sees that it needs a check.

`done` records that the user has confirmed the work. Only the main session sets it, and only after the user has actually said it is done:

```bash
"${TA_ATTENTION_CLI:-t-attention}" confirm <id>
```

Never confirm on the user's behalf, never confirm because the tests passed, and never confirm from a sub-agent. `confirm` and `reject` work only on a task in `review` (and `handled` only on one in `waiting_user`); otherwise they change nothing and exit with `1`. When the user rejects the work, send it back with the reason:

```bash
"${TA_ATTENTION_CLI:-t-attention}" reject <id> --reason "<what the user wants changed>"
```

### 5. Blocked, or needs the user

- **Blocked** (a tool fails, access is missing, a dependency is broken): set the custom status and the result, and leave the status alone. Moving the status would misreport how far the work got.

  ```bash
  "${TA_ATTENTION_CLI:-t-attention}" update <id> --custom-status Blocked --result "<what went wrong>"
  ```

  When it is unblocked, clear both: `update <id> --custom-status '' --result ''`.
- **Needs the user** (an answer, a decision, a login, an approval): move it to `waiting_user` with what the user must do, in one sentence the user can act on:

  ```bash
  "${TA_ATTENTION_CLI:-t-attention}" wait <id> --reason "<what the user must do>"
  ```

  When the user has done it, move it back to work:

  ```bash
  "${TA_ATTENTION_CLI:-t-attention}" work <id>
  ```

  If the user handled a reminder without the work going on (for example they only read it), use `handled <id>`.
- **Failed for good**: `fail <id> --reason "<why>"`.

### 6. Changed facts: one update for every stale field

When a fact about a task changes (a date, the owner, the scope, the target), read the task first (`show <id> --json`) and update every field the new fact makes wrong in one call: the title, the notes, the custom status and the result. Separate calls leave the task contradicting itself in between, and a stale title or note is what the user reads first.

```bash
"${TA_ATTENTION_CLI:-t-attention}" update <id> --title "<new title>" --notes "Deadline moved to Friday 18:00" --custom-status "In testing; due Fri 18:00" --reason "Deadline moved"
```

A deadline goes in the notes; the custom status may repeat it in short.

### 7. Order and parents

- Move a task under another one: `update <id> --parent <other id>`; make it top-level again with `--parent ''`.
- Reorder among its siblings: `move <id> --before <other id>`, `--after <other id>`, `--top` or `--bottom`. Add `--status <status>` to change the status in the same step.
- Do not delete tasks; the user decides what to remove.

## Home view

Show it only when the user asks to see their tasks or wants an overview. When you only report a change, say in one short line what changed and do not add the view.

Read the list with:

```bash
"${TA_ATTENTION_CLI:-t-attention}" list --tree --json
```

(`list --tree` without `--json` prints the same view as plain text, which you may show as it is when the chat cannot render tables.)

The answer is `{"groups": [{"key", "label", "items": [...]}], "done": N}`. The groups come in order: Needs you (the `waiting_user` tasks, then the `review` tasks), Working, To do. `done` is the number of finished tasks (done, failed and cancelled together). The CLI has already built the trees and placed them in their groups: each item is a task (id, title, status, custom status, notes, result, the reason or question for the user, its parent, the time of the last change) plus `depth` (0 for a top-level row, 1 for a child, and so on), in display order. Keep the groups and the order as they are; do not regroup.

Write the view in this order. Write the headings and the column names in the user's language (translate the English ones below); task data stays as stored, never translated.

1. `🔴 **Needs you**`: always shown. Columns: ID, Task, Status, What you need to do, Updated. "What you need to do" is the task's reason or question for the user; for a task in `review` with no reason, write that it waits for the user's confirmation.
2. `🟢 **Working**`: columns ID, Task, Status, Custom status, Notes, Updated.
3. `🟡 **To do**`: columns ID, Task, Status, Updated.
4. `⚪ **Done: N**`: one line with the count only, never a table of finished tasks.

An empty section keeps its heading with "none" (in the user's language) under it, instead of a table.

Rules:

- The colour markers go on the section headings only, never on a task or a row.
- A tree stays together in one table: a child always appears under its parent, even when their statuses differ, and each row shows its own status. In Needs you, show each task's own reason; never move a child's reason to its parent.
- Mark children by their `depth` with tree branches in the ID column: `├ 12` for a child with more siblings after it (the next item at the same depth comes before any item with a smaller depth), `└ 12` for the last one, two more spaces of indentation per deeper level.
- Finished tasks are only counted in the Done line. A finished parent appears only when the CLI includes it to keep an open child under it.
- Times are shown as `MM-DD HH:MM`, in local time.
- No statistics or count table besides the Done line.

Example with made-up tasks (headings in English here; write them in the user's language):

```markdown
🔴 **Needs you**

| ID | Task | Status | What you need to do | Updated |
|----|------|--------|---------------------|---------|
| 31 | Choose the launch date | waiting_user | Pick a date | 03-02 14:05 |
| 27 | Prepare the demo | working | | 03-02 11:40 |
| └ 36 | Export the metrics | review | Confirm that it is done | 03-02 15:20 |

🟢 **Working**

| ID | Task | Status | Custom status | Notes | Updated |
|----|------|--------|---------------|-------|---------|
| 40 | Fix the login page | working | In testing | Due Friday 18:00 | 03-02 12:10 |
| ├ 41 | Write the tests | working | | Sub-agent | 03-02 12:12 |
| └ 42 | Update the docs | todo | | Waits for 41 | 03-02 12:12 |

🟡 **To do**

none

⚪ **Done: 2**
```

## When something goes wrong

- Exit code `4`, or a connection error: T-Attention is not reachable. Tell the user once, in one line, and go on with the work. Do not retry in a loop. Nothing is queued, so the update is lost; send it again once the server is back if it still matters.
- Exit code `2`: the token is missing, wrong or revoked. Outside a T-Agent terminal the user can run `t-attention login --url <server> --token <token>` (a token comes from Settings, T-Attention, CLI tokens). Tell the user; do not look for tokens yourself.
- Exit code `127`: the command is not installed here. Tell the user once and go on.
- Exit code `3`: the id or ref is wrong. Check it with `list --json`.
- Never start, stop or restart T-Agent, its server or its processes (pm2 or any other way) to make T-Attention work. They belong to the user and may be running other agents.
