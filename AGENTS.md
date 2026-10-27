# Agent development and release rules

## Design document

- Path: `DESIGN.md`
- Handoff notes (current state, unverified items, known limitations, things to watch out for): `docs/HANDOFF.md`. Read it before taking over.

## Language

- All source code, comments, documentation, test names, commit messages and agent rules are written in English.
- User-facing text in the UI, error messages from the server and CLI output are written in English. The Chinese UI is a translation layer: add the Chinese text to `public/js/i18n-zh-ui.js` (client text), `public/js/i18n-zh-server.js` (server messages) or `public/js/i18n-zh-extra.js` (sentences assembled from several pieces), keyed by the exact English text. See "Interface language" in `DESIGN.md`.
- Chinese characters may appear only in those dictionaries and in test fixtures that exist to prove that Chinese user content (translator input, terminal output, file names) is handled. `test/i18n.test.js` fails when Chinese shows up anywhere else. Where a regular expression needs a CJK range, write it with `\u` escapes.
- Content created or entered by users (tasks, documents, file names, terminal input) must keep working with Chinese and any other language.

## Development workflow

0. For a task that needs its own branch, create the worktree with `scripts/new-worktree.sh <name> [branch]`: it starts from the latest `origin/main` and links `node_modules`, so tests run at once.
1. Before starting, read this file and the relevant design documents, and check `git status`, the current branch and existing changes. Keep the user's uncommitted work and commit only the files involved in this task.
2. Confirm the data flow and existing behavior behind the problem first, then make the necessary changes. When the local and remote sides have a similar feature, check whether both need the fix.
3. Edit forms must echo the existing configuration; when a default path is used, show the path that is actually in effect. A default path that was not modified keeps inheriting the default rule, and clearing a path restores the default. Echoing must never save a default path as a fixed custom path.
4. Verify changes according to their impact. While developing, run only the files the change touches (`npm run test:quick -- test/<file>.test.js`, or one `node scripts/test-<name>-browser.cjs`); `npm run test:quick` runs every unit test except the slow installer tests (about 20 seconds). Run the full `npm test` (about a minute) once, before the release (see "Requirement batches" for when that is), not after every edit. Details: for fixes that touch logic or endpoint behavior add meaningful regression cases and run the relevant `node --test test/<file>.test.js`; for cross-module changes run `npm test` as needed. Low-risk changes such as pure documentation need no new tests.
5. Run `node --check <file>` on modified JavaScript, and run `git diff --check` and review the diff before committing. Rebuild Markdown, Monaco and other bundles only when their build entry points or dependencies changed; when upgrading marked, mermaid or xterm, download them again according to `scripts/vendor-libs.json` (`node scripts/fetch-vendor.js --update`).
6. When tests lack dependencies, install the dependencies declared by the project, including the dev dependencies the tests need. When blocked by permissions, network or the environment, state the actual reason; a check that was not run or did not pass must not be reported as passed.
7. When done, briefly state the result, how it was verified and the remaining limitations. When features, configuration or interfaces change, update the necessary documentation such as `README.md` and `DESIGN.md`.

## Requirement batches (overrides the automatic release below)

The user usually sends several requirements one after another and then releases them together. Until the user explicitly says that all requirements are submitted (for example "that is all", "release now", "submit the upgrade"):

- For each requirement, only write the code and its unit tests. Run just the test files the change touches (`npm run test:quick -- test/<file>.test.js`, or one `node scripts/test-<name>-browser.cjs`), plus `node --check` on modified JavaScript.
- Do not run the full `npm test` or `npm run test:quick`, do not run `node scripts/release.js`, do not bump any version field, and do not push a release. Do not tell the user that something was "released" or "upgraded".
- Rebuild a bundle (for example `npm run build:agent-chat`) only when the files the browser loads must change with the code; that is part of writing the code, not a full build.
- Keep the changes in the working tree or in ordinary commits as the task needs; the version bump and the push of the release wait for the user's signal.
- A signal about one requirement ("this one is done", "next") is not the signal for the whole batch. When it is unclear whether the user has finished, ask instead of releasing.
- When the user does say all requirements are submitted, then run the full `npm test` once, and continue with "Releases and pushing" for everything collected so far, as one release.

## Releases and pushing

The user has authorized automatic release and push: once the user has said that all requirements are submitted (see "Requirement batches"), and the development or fix in this repository is complete and the relevant verification has passed, continue by default with the version bump, commit, push and checking the result, without asking again. This includes work done on a feature branch or in a git worktree: merge it into `main` with a merge commit, bump the version and push, every time. When the user explicitly asks not to release yet, to only review, or to keep changes local, follow that request; when verification fails or the release is blocked, report it truthfully and do not force a release.

1. Before releasing, check the working tree, current branch, remote address, remote target branch and existing versions, to avoid overwriting someone else's commits or duplicating a version. The regular release target of this repository is `origin/main`; if the user specifies otherwise, follow the user.
2. Use `node scripts/release.js patch "<note for DESIGN.md>"` (or `minor`, or an exact `X.Y.Z`; `--dry-run` only prints the result) to update all the version fields below in one step; it refuses to run when they disagree. Follow the existing version sequence: regular fixes bump the patch version; new features or incompatible changes choose the version by impact. Before releasing, update together:
   - `app_version` in `VERSION.json`.
   - `version` in `package.json`.
   - The top-level `version` and `packages[""].version` in `package-lock.json`.
   - `VERSION.json.published_at`, using the UTC ISO 8601 time of the release.
3. `VERSION.json` is the runtime version source. Change the API, schema and remote-compatibility version fields only when the protocol or database structure really changes; they must not be bumped mechanically with each patch version.
4. A release must include the relevant verification results, and you must check that the version fields agree, that the diff has no formatting errors and contains no secrets, runtime data or unrelated files. Checks that already passed need not be repeated just because only the version number changed.
5. Commit this feature or fix together with the version files; the commit message states the main change and the version, for example `Fix task and settings path prefilling in vX.Y.Z`. Stage with an explicit file list to avoid mixing in unrelated changes.
6. A regular release updates `origin/main` with a normal push, never a force push. If the remote is ahead or has diverged, inspect the differences, merge properly, then verify and push, without overwriting remote history.
7. The current client detects new versions through `VERSION.json` on `main`, so the application version must be raised before pushing releasable code. A regular release keeps the flow of a version commit plus a branch push; create a version tag or GitHub Release separately only when the user asks or the release process needs it.
8. After pushing, confirm the command succeeded, that the remote branch contains the release commit, and check the working tree state. Report the version, commit SHA, target branch and verification results to the user; when something fails or is blocked, say clearly which step it stopped at.

## Permissions and blockers

- When committing, pushing or testing needs environment permissions, go through the tool approval flow and do not bypass a denial.
- When automatic approval is denied, state which operation was denied and the reason returned, finish the work that is not affected, and say clearly when the user needs to continue authorizing; a version that has not been committed or pushed must never be described as released.
