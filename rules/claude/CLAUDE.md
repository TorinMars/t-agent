## General working rules

- Reply in Chinese by default; keep code, commands and identifiers as they are.
- Before changing anything, check `git status` and the current branch, keep the user's uncommitted work, and commit only the files involved in the task.
- Confirm the data flow and existing behavior behind the problem first, then make the necessary changes; do not refactor unrelated code.
- Run the relevant verification after changing things; a check that was not run or did not pass must not be reported as passed.
- When blocked by permissions, the network or the environment, state the actual reason truthfully and do not bypass a denial.
- Never write secrets, tokens or other sensitive information into code, logs or commits.

## Session handoff (HANDOFF.md)

- Applies only when a `HANDOFF.md` already exists in the project root; if it does not exist, do not create one unless the user explicitly asks.
- Read `HANDOFF.md` before starting work to learn the goal, the progress and the pitfalls already hit, so the user does not have to explain the background again.
- Update it when a phase is finished or before the session ends, and keep it short: current goal, done, not done, pitfalls, next step.
- Record only progress and conclusions; never write secrets, tokens, account passwords or other sensitive information.
- Updating `HANDOFF.md` itself does not need a separate commit; whether it is committed together with the code follows the project's own rules.

## Scope of file changes

- Places you may add, delete and modify directly (no need to ask):
  1. The current workspace (the project directory, i.e. the working directory of the current session and its subdirectories);
  2. The system temporary directory (`/tmp`, the directory `$TMPDIR` points to, and so on);
  3. Files and directories whose names start with `.` in the user's home directory (such as `~/.claude`, `~/.codex`, `~/.config`, `~/.local`, `~/.zshrc`, `~/.gitconfig`), except `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker` and `~/.config/gh`.
- Everything else (including `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gh`, system directories, directories in the home directory whose names do not start with `.`, and other projects) must not be modified by default. When a change there is really needed, first tell the user the exact path, what you will do and why, and act only after explicit approval; that approval is valid only for the operation described and is not a standing permission.
- The same rules apply to indirect changes through shell commands, scripts, redirection, global package installs and the like.
- Read-only access is not restricted.
- Before modifying, confirm the real path of the target (resolving symlinks, `..` and variable expansion); never go out of scope through a symlink or a relative path, and a symlink that points outside the scope is treated as outside.

## Background service management (PM2)

- Long-running background services you set up yourself (such as web services, tunnels, queue consumers and resident scripts) must be started and managed with PM2; do not use `nohup`, `&`, `screen` or `tmux`, or leave them running in a terminal.
- Start them with `pm2 start … --name <a meaningful name>`; with many arguments or several services, write an `ecosystem.config.js` (or `.yml`) in the project, start from it, and commit it to the project.
- Before starting, run `pm2 list` to make sure no process has the same name or uses the same port, to avoid starting twice; after changes use `pm2 restart <name>`, and when the service must not be interrupted use `pm2 reload <name>`.
- Do not put secrets or tokens in the ecosystem file or in command-line arguments; use an environment file or the project's own configuration mechanism.
- Manage only processes you started yourself; before stopping, restarting or deleting a PM2 process you did not start, get the user's consent.
- One-off commands, tests and builds are not background services and do not need PM2.
- When start on boot is needed, remind the user to run `pm2 startup` and `pm2 save` (the part that needs sudo is run by the user).
