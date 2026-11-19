# Agent development and release rules

## Design document

- Index: `DESIGN.md`. It is small: a table of every topic file with a one-line description and its size, the cross-cutting rules, the development notes and "Recent versions" (where `scripts/release.js` appends one line per release; keep that section last).
- Topics: `docs/design/*.md`, one file per area (architecture, terminals, service links, settings sync, the page split into shell and columns, task list, terminal and bottom bar, files and settings, T-Attention, UI icons, bundles and tests, and so on). Each is at most about 60 KB and can be read whole.
- Find your area in the table of `DESIGN.md` and open only the topic files you need; do not read every file. For a term you cannot place, `grep -rn "<term>" docs/design`.
- When you change a feature, update its topic file (not the index). A new area gets a new lower-case-kebab file with a `# ` title and the "Part of" line, and a row in the table of `DESIGN.md`. Code comments name the place as `"<heading or bold title>" in docs/design/<file>.md`.
- Handoff notes (current state, unverified items, known limitations, things to watch out for): `docs/HANDOFF.md`. Read it before taking over.

## Language

- All source code, comments, documentation, test names, commit messages and agent rules are written in English.
- User-facing text in the UI, error messages from the server and CLI output are written in English. The Chinese UI is a translation layer: add the Chinese text to `public/js/i18n-zh-ui.js` (client text), `public/js/i18n-zh-server.js` (server messages) or `public/js/i18n-zh-extra.js` (sentences assembled from several pieces), keyed by the exact English text. See "Interface language" in `docs/design/interface-language.md`.
- Chinese characters may appear only in those dictionaries and in test fixtures that exist to prove that Chinese user content (translator input, terminal output, file names) is handled. `test/i18n.test.js` fails when Chinese shows up anywhere else. Where a regular expression needs a CJK range, write it with `\u` escapes.
- Content created or entered by users (tasks, documents, file names, terminal input) must keep working with Chinese and any other language.

## One experience on every device and engine

The goal of the project: the person hardly notices which engine (T01, K01, ...) or which client (phone, computer, the Mac app, the Home Screen app) they are using. The same person sees the same things and gets the same behaviour everywhere (the user's rule, 2026-11-19). In the usual terms: across engines this is a **single system image** with **location transparency** (several machines look like one system, and the person does not need to know which machine holds their data or runs their session); across clients it is **cross-device continuity** (what was done on one device is there on the next).

- State that describes the person and their work is kept on the server and shared by all linked engines, never only in one browser: recent sessions, the recency of saved commands, progress (Learn), layout and list choices (columns, the chosen task list tab, collapsed groups), and preferences. (The session a device opens at start stays that device's own, so a page never opens a session the person did not pick there; the session last looked at anywhere is the top of the shared Recent list.) A new feature that remembers something stores it on the server and syncs it over the service links (settings sync, the Learn sync or the same pattern), with a merge rule that loses nothing when two devices change it at the same time.
- Anything that names a session, task or device in shared state uses an engine-neutral identity (the engine's instance id plus the task and terminal ids), not a page-relative one such as `local` / `remote:<n>`: each page maps it to its own source.
- Phone and computer differ only where the screen size or the input really requires it (layout, touch targets, keyboards); the content, order and choices stay the same.
- Allowed per browser or per device only: what is tied to that hardware or that browser (microphone and voice permission, measured terminal widths, the pane of a column, the auto-reload guard), and what the person explicitly sets for one device (scope "device" in Settings, e.g. the company computer flag). Name the reason in a comment where such a key is defined.
- When a feature cannot behave the same everywhere (an offline engine, an older version), it says so on the page instead of silently showing different data.
- Enforced by test/local-storage-keys.test.js: browser storage goes through public/js/local-keys.js (`window.TALocalKeys`; the shell's door is scripts/h5-shell/local-keys.mjs), and every key is declared there with its reason.

## UI design: Material Design 2, built with MUI 9

- Design specification: every UI design follows Material Design 2 (https://m2.material.io), including mockups and design proposals. Layout on its 8px grid (4px for small details), its type scale (h1–h6, subtitle, body, button, caption, overline), its color system (primary, secondary, surface, background, error, and the "on" colors, in a dark and a light theme), elevation for layering, its component guidelines (app bars, navigation drawer, lists, cards, dialogs, menus, chips, buttons, text fields, snackbars, sheets, tabs) and its state, motion and accessibility guidance. Do not use Material Design 3 patterns (color roles such as `primaryContainer` or `surfaceContainer`, tonal buttons, the M3 shape scale) or another design system's look.
- Components: the page (the MUI page at `/` and `/h5` and its lazy bundles) is built with MUI 9 (`@mui/material`, the version in `package.json`). Use the MUI component when one exists instead of a hand-made control or another component library, and style it through the shared theme in `scripts/h5-shell/theme.mjs` (palette, typography, shape, component overrides) rather than hard-coded colors, radii or font sizes in components. A change to the look of a whole kind of component goes into the theme.
- Material Theming choices of this project, made through the theme and allowed by MD2's theming: the dark theme; buttons in sentence case, without elevation, with an 8px corner radius; the same 8px radius on dialogs, top sheets and cards (MD2's default is 4px); centred dialogs keep a 16px margin on a phone, and only long forms are full screen there; the `notice` color (blue 800) for requests that wait for the person over the terminal; touch targets of at least 44 x 44px in touch input mode; the navigation rail, the session header and the navigation drawer use the dark theme's 1dp surface overlay, the drawer's scrim is 32% black, and count badges on navigation items use the error color. Change them in the theme, and record a new one here.
- Page structure: one navigation for the whole page (the rail on the wide layout, the bottom navigation on a phone) with the destinations Sessions, Columns (wide only), Attention, Mind maps and Settings; one dialog pattern (h6 title, text buttons at the bottom right with the dismissive one first, a contained button only for a form that creates or saves, the error color for a destructive confirmation; "One dialog pattern" in `docs/design/page-dialogs.md`); an option that takes effect at once is a switch in a list row, a checkbox only inside a form that is saved with a button.
- Icons: the "UI icons" rule below still applies (the Ant Design icon library instead of Material Icons), drawn at MD2's icon sizes and placements.
- Native macOS parts (the floating window in `widgets/macos/`, the app in `apps/macos/`) are AppKit, where MUI cannot be used: they follow MD2's grid, type hierarchy, color use and states with native controls, and keep the platform's own behaviour for menus, the menu bar, window chrome and keyboard.
- Existing screens that do not follow this yet move to it when they are changed; a screen you touch follows MD2 in that change.

## UI icons

- All icons in the page (the MUI page at `/` and `/h5`) come from one icon library: the "Ant Design Official Icon Library" collection on iconfont.cn (https://www.iconfont.cn/collections/detail?cid=9402). Same grid, same outlined style. Do not mix in icons from other sets. Library icons come first.
- Where no library icon is clearly recognisable for a button (for example the keyboard keys Backspace, Tab and Shift), you may draw an inline SVG yourself on the 24 grid, with the same stroke weight (1.5), round caps and joins, outlined style and `currentColor`, or use a short text label instead. Judge it on a real-size screenshot (phone width, 3x). A text label is better than an unclear icon.
- Self-drawn icons live in `scripts/h5-shell/Icons.jsx`, in the clearly marked `SELF-DRAWN ICONS` section (the `DRAWN` map).
- Icons are inline SVG paths in `scripts/h5-shell/Icons.jsx`, drawn with `currentColor` at a consistent size (24px; 22px for the function keys; the self-drawn ones are stroked on a 24 viewBox). No runtime requests and no icon fonts.
- Every icon-only button has an English `aria-label` and the same `title` (with its Chinese text in `public/js/i18n-zh-ui.js`).
- To add an icon: take the closest same-style icon from the same collection, add its path to `Icons.jsx`, and update the mapping table in "UI icons" in `docs/design/page-ui-icons.md` (library icon with its id, self-drawn icon, or text label).
- Text labels are styled to match the icons (same size, weight and vertical alignment).

## Development workflow

0. For a task that needs its own branch, create the worktree with `scripts/new-worktree.sh <name> [branch]`: it starts from the latest `origin/main` and links `node_modules`, so tests run at once.
1. Before starting, read this file and the relevant design documents, and check `git status`, the current branch and existing changes. Keep the user's uncommitted work and commit only the files involved in this task.
2. Confirm the data flow and existing behavior behind the problem first, then make the necessary changes. When the local and remote sides have a similar feature, check whether both need the fix.
3. Edit forms must echo the existing configuration; when a default path is used, show the path that is actually in effect. A default path that was not modified keeps inheriting the default rule, and clearing a path restores the default. Echoing must never save a default path as a fixed custom path.
4. Verify changes according to their impact. While developing, run only the files the change touches (`npm run test:quick -- test/<file>.test.js`, or one `node scripts/test-<name>-browser.cjs`); `npm run test:quick` runs every unit test except the slow installer tests (about 20 seconds). Run the full `npm test` (13 to 23 minutes on an otherwise idle development machine, about 40 minutes while other heavy work runs: about 200 unit test files and about 80 headless browser scripts) once, before the release (see "Requirement batches" for when that is), not after every edit. Details: for fixes that touch logic or endpoint behavior add meaningful regression cases and run the relevant `node --test test/<file>.test.js`; for cross-module changes run `npm test` as needed. Low-risk changes such as pure documentation need no new tests.
5. Run `node --check <file>` on modified JavaScript, and run `git diff --check` and review the diff before committing. Rebuild Markdown, Monaco and other bundles only when their build entry points or dependencies changed; when upgrading marked, mermaid or xterm, download them again according to `scripts/vendor-libs.json` (`node scripts/fetch-vendor.js --update`).
6. When tests lack dependencies, install the dependencies declared by the project, including the dev dependencies the tests need. When blocked by permissions, network or the environment, state the actual reason; a check that was not run or did not pass must not be reported as passed.
7. When done, briefly state the result, how it was verified and the remaining limitations. When features, configuration or interfaces change, update the necessary documentation such as `README.md` and the topic files in `docs/design/` (see "Design document").

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
