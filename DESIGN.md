# T-Agent Design Document

> This document describes the system as it is now. The history of how it got here is in `git log` (and in the release notes of each version). It used to be one large file; it is now this index plus one topic file per area in `docs/design/`. The text of the topic files is the same as before, only moved.

## How to use it

- Do not read every file. Find the area of your task in the table below and open only the topic files you need. Each file is small enough to read whole (60 KB at most). For a term you cannot place, `grep -rn "<term>" docs/design` finds the file.
- The architecture files are the map: what runs where, the server modules, the data and the core concepts. Read the part you need before changing an area you do not know.
- When you change a feature, update its topic file. Keep a new topic in the file of its area; add a new file (lower-case-kebab name, with a `# ` title and the "Part of" line under it) only for a new area, and add it to the table below.
- A code comment that says `"<name>" in docs/design/<file>.md` points at a heading or a bold paragraph title with that name in that file.
- "Recent versions" stays at the end of this file: `scripts/release.js` appends one line there for every release.

## Topic files

### Architecture (the map; start here)

| File | What is in it | Size |
| --- | --- | --- |
| [architecture-overview.md](docs/design/architecture-overview.md) | The map of the system: overview diagrams, purpose and users, deployment topology, every server module (part A to C). | 32 KB |
| [architecture-data.md](docs/design/architecture-data.md) | Data storage, the data directory (`~/.tagent`), the data model and core concepts, terminal start directory, task rename (part D and E). | 33 KB |
| [architecture-features-and-page.md](docs/design/architecture-features-and-page.md) | T-Attention data, API and tokens; mind maps; the client UI; routes, layout and input mode of the page (part F and G). | 35 KB |

### Terminals and agent sessions

| File | What is in it | Size |
| --- | --- | --- |
| [terminals.md](docs/design/terminals.md) | PTY lifecycle, protocol v2, ending processes, idle cost, terminal order, restore and history, agent (Claude / Codex) terminals, a rename typed into the agent (`/rename`), peer file access (MCP), activity push, file links, clipboard (OSC 52), links opened by programs. | 55 KB |
| [open-links.md](docs/design/open-links.md) | Web links that programs in a terminal open, opened on the person's device: the cause (Claude Code, Codex), the link shims and relay, the link bar, the Mac app handler, Home Screen apps on iOS and Android. | 11 KB |
| [agent-chat.md](docs/design/agent-chat.md) | The conversation view of Claude Code / Codex: backends, service, approvals, the chat page. | 43 KB |
| [tcli.md](docs/design/tcli.md) | The `tcli` command of agent sessions: environment, relay, `tcli oss`, `tcli notify`, exit codes. | 12 KB |
| [agent-rule-files.md](docs/design/agent-rule-files.md) | `AGENTS.md` and `CLAUDE.md` of new and existing tasks. | 1 KB |
| [rules-and-skills-sync.md](docs/design/rules-and-skills-sync.md) | Sharing Claude rules, skills and Codex rules across linked services: roles, layers, bundle, shared Claude settings. | 26 KB |

### Linked devices

| File | What is in it | Size |
| --- | --- | --- |
| [service-links.md](docs/design/service-links.md) | Two services that operate each other as remote Engines: joining, tokens, linked capabilities, per-task visibility, shared task order. | 16 KB |
| [service-links-tunnel.md](docs/design/service-links-tunnel.md) | The reverse WebSocket tunnel that lets a service behind NAT be reached by its linked service. | 6 KB |
| [settings-sync.md](docs/design/settings-sync.md) | One set of settings for all linked devices: what is shared, registry, rounds, conflict rule, encryption, known limits. | 11 KB |
| [linked-device-settings.md](docs/design/linked-device-settings.md) | Reading and changing the per-device settings of a linked device from this page; the settings tabs; the "Company computer" device tier. | 16 KB |
| [peer-file-access.md](docs/design/peer-file-access.md) | Read-only file access of agent sessions to linked Engines (MCP tools, scope, the switch). | 8 KB |
| [engine-names.md](docs/design/engine-names.md) | One name per Engine, kept by that Engine and shown everywhere. | 3 KB |

### The page (`/` and `/h5`)

| File | What is in it | Size |
| --- | --- | --- |
| [page-shell-and-columns.md](docs/design/page-shell-and-columns.md) | The page: the shell, store and loading; routes, login and manifests; wide layout and keyboard; the multi-column view (its Columns and Mind maps tabs) and pane mode. | 59 KB |
| [page-navigation.md](docs/design/page-navigation.md) | The page: the navigation rail of both views on a wide screen (Sessions, Columns, Attention, Mind maps, Learn, Update, Settings) and its phone counterpart, the bottom navigation (Sessions, Attention, Mind maps, Learn, Settings); the page layout; the session header on a computer and a phone; the phone's modal task drawer. | 11 KB |
| [page-task-list.md](docs/design/page-task-list.md) | The task list and its sessions: rows, the By task and Recent tabs, create dialogs, task and session order, the task menu, archived tasks, shared task order. | 57 KB |
| [page-terminal-and-bottom-bar.md](docs/design/page-terminal-and-bottom-bar.md) | The terminal on the page (warm terminals, width, touch scrolling, wheel strip, copy), the bottom bar and its keys, the compact one-row bottom area of a column, the next-session action of a column. | 66 KB |
| [session-switcher.md](docs/design/session-switcher.md) | The page: the session switcher of the single view (the switch button `#h5-cycle`): recent sessions remembered on the device, the stack of cards, previews, gestures, keys, closing. | 8 KB |
| [page-files-and-settings.md](docs/design/page-files-and-settings.md) | The design sheet and file viewer, the file tree, Settings / Devices / Update, voice input, back button and rename. | 55 KB |
| [page-dialogs.md](docs/design/page-dialogs.md) | The one dialog pattern of the page (title, content, actions, widths, full screen, Enter / Escape, errors) and the sheet headers. | 5 KB |
| [page-attention.md](docs/design/page-attention.md) | T-Attention on the page: one design on both layouts, the panel, rows, edit view, every engine in one list, plugins, marketplace, first-run guide. | 42 KB |
| [page-ui-icons.md](docs/design/page-ui-icons.md) | The icon library, self-drawn icons and the mapping table of every icon (update it when you add an icon). | 12 KB |
| [page-bundles-and-tests.md](docs/design/page-bundles-and-tests.md) | How the page bundles and lazy chunks are built, bundle size and touch targets, the page tests. | 11 KB |
| [toast.md](docs/design/toast.md) | The global notice function and how the page shows notices. | 3 KB |
| [interface-language.md](docs/design/interface-language.md) | English source text and the Chinese translation layer (`public/js/i18n*.js`). | 4 KB |
| [static-asset-caching.md](docs/design/static-asset-caching.md) | Content-hash URLs, long cache, pre-compressed and combined files. | 8 KB |
| [usage-data.md](docs/design/usage-data.md) | Usage data: local, private tracking of button presses on the page (what is and is not recorded, keys, surfaces, batches, storage and retention, the switch, the `/api/ui-events` API, the Settings group). | 11 KB |
| [mind-maps.md](docs/design/mind-maps.md) | The mind map editor: why this shape, maps of every service, the editor library, the page, the Mind maps tab of the multi-column view, editing, saving, .xmind. | 19 KB |
| [learn-english.md](docs/design/learn-english.md) | Learn English: study cards from the person's translated sentences, looked-up words and a starter list; the tables, the spaced review rules, the `/api/learn` API, meanings through the translator, the collection hooks of the page; the sync across linked devices and the company computer (cache only, home, offline queue). | 21 KB |
| [learn-english-page.md](docs/design/learn-english-page.md) | The Learn page: the Learn destination, the home, the practice modes (Review, Spell the word, Build the sentence, Dictation, Say it, Fill the gap), Mistakes, Your material, Learn settings; grading in the browser, speech, tests. | 10 KB |

### T-Attention

| File | What is in it | Size |
| --- | --- | --- |
| [attention-cli-and-listener.md](docs/design/attention-cli-and-listener.md) | The `t-attention` command, the Claude listener plugin, plugin overview and settings, easy listener install, the plugin marketplace, the agent skills. | 58 KB |
| [attention-notifiers.md](docs/design/attention-notifiers.md) | Telling the user on another channel: rules, the wait before a message, one Telegram sender, direct messages, Telegram, email, the desktop bubble. | 43 KB |
| [attention-desktop-window.md](docs/design/attention-desktop-window.md) | The native macOS window: launch, auth, API and merge rules, notices, panel look, live activity, settings, page link to a terminal. | 34 KB |

### Browser, files and tools

| File | What is in it | Size |
| --- | --- | --- |
| [browser-extension.md](docs/design/browser-extension.md) | The Chrome extension driven by `tcli browser`: its parts, the shared contract, `tabs.reveal`, the bridge diagram. | 2 KB |
| [site-library.md](docs/design/site-library.md) | What agents learn about each website (`tcli site`): entry shape, storage, sync. | 6 KB |
| [upload-oss.md](docs/design/upload-oss.md) | Image and file upload to OSS: configuration, policies, limits. | 6 KB |
| [machine-tools.md](docs/design/machine-tools.md) | Tools whose pages were removed in 2.88.0 but whose routes stay (frp, SSH tunnel, PM2, apps, file sync and more). | 1 KB |
| [update-check-and-versions.md](docs/design/update-check-and-versions.md) | Version source, update check and apply, release rule, automatic update, automatic refresh after an update. | 16 KB |
| [mac-app.md](docs/design/mac-app.md) | The macOS shell app T-Agent.app: why, window and web view, menu bar and web addresses, deep links, not-running view, service control, self-test, build and install, the automatic rebuild of an installed app after an update, app.json and the web addresses the server publishes, the Mac app card, the floating window opening pages in the app. | 27 KB |

## H. Cross-cutting rules

- **UI design**: Material Design 2 is the design specification for every screen and mockup; the page is built with MUI 9 components styled through the shared theme (`scripts/h5-shell/theme.mjs`); native macOS windows follow MD2 with AppKit controls. See `AGENTS.md` "UI design: Material Design 2, built with MUI 9".

- **Language and i18n**: code, docs and UI text are English; Chinese lives only in `public/js/i18n-zh-ui.js`, `i18n-zh-server.js`, `i18n-zh-extra.js` (keyed by the exact English text) and in fixtures; `test/i18n.test.js` enforces it. See "Interface language" ([interface-language.md](docs/design/interface-language.md)).
- **UI icons**: one library (Ant Design Official Icon Library, iconfont.cn collection 9402), inline SVG in `scripts/h5-shell/Icons.jsx`; self-drawn icons (`DRAWN`) or text labels where no library icon is clear; every icon-only button has an English `aria-label` and `title`. See `AGENTS.md` "UI icons" and "UI icons" in [page-ui-icons.md](docs/design/page-ui-icons.md).
- **Security**: the browser never gets an Engine token; tokens and secrets are stored hashed or encrypted and never written to logs; same-origin checks on browser mutations and WebSocket upgrades; the files API rules in C ([architecture-overview.md](docs/design/architecture-overview.md)); the preview of any path ("Preview of any path" in C) is read only and reads as the terminal user (a child process with its uid / gid when the service drops root), regular files only; untrusted Markdown (the design document sheet) shows raw HTML as text and keeps only `http(s)` / `mailto` links and `http(s)` / `data:image` images; shared Markdown stays inside the folder of `md_path`; remote file responses carry `Content-Security-Policy: sandbox`; OSC 52 never writes the clipboard silently: only right after the user's own (trusted) gesture on that terminal, otherwise after a one-line preview in the copy bar and a tap on Copy; the previewed text cannot be replaced by later output, and decode limits, replay, hidden terminals and read queries are refused (see "Copy" under "Terminal on the page"); terminal output is not stored; the clipboard shims in terminal PATH (see "Clipboard (OSC 52)" under "Terminals") only send copies to the browser through OSC 52 and never read the browser clipboard, and a dropped terminal user gets them only when it can read and run them.
- **Releases**: batch requirements until the user says all are submitted, then one full `npm test`, `node scripts/release.js`, commit, normal push to `origin/main`. See `AGENTS.md` "Requirement batches" and "Releases and pushing".
- **Testing**: unit tests in `test/` (`npm run test:quick` while developing), real-Chromium scripts `scripts/test-*-browser.cjs` for UI, full `npm test` once before a release; bundles (`build:h5-shell`, `build:agent-chat`, `build:markdown`) are rebuilt when their sources change.
- **HTTP login sessions**: remote access needs HTTPS for the login cookie by default; only `CLIENT_ALLOW_HTTP=true` lets a plain-HTTP (intranet) request keep a session, and HTTPS requests always get a Secure cookie. It changes nothing else (authenticator, same-origin check, task permissions, WebSocket authentication) and never trusts a request by its IP.

## Development notes

- Tests: unit tests in `test/` (`npm run test:quick` while developing), real-Chromium scripts `scripts/test-*-browser.cjs` for the UI (Playwright is a dev dependency; Chromium is installed after `npm ci --include=dev`; the scripts support `CHROME_PATH`), and the full `npm test` once before a release (`AGENTS.md`).
- `npm audit --omit=dev` is kept at 0 findings. axios, body-parser, follow-redirects, qs and express are updated within their ranges (`npm update`); transitive packages with `npm audit fix --package-lock-only` (hono and `@hono/node-server`, which come with `@anthropic-ai/claude-agent-sdk`). The full `npm audit` still lists the file watcher of nodemon (picomatch, chokidar, minimatch): a dev tool, with no fix inside its range.
- `npm test` is `node --test --test-concurrency=4 test/*.test.js scripts/test-*-browser.cjs`: the browser regressions start real Chromium windows and shells, so run it alone; with other heavy work on the machine, or with every file in parallel, the slower ones time out (the terminal check of `scripts/test-terminal-file-links-browser.cjs` waits up to 90 s for the shell).
- CI (`.github/workflows/test.yml`, ubuntu) runs `node --test test/*.test.js` on Node 20 and Node 24 (a matrix with the same steps; behaviour such as mocked timers differs between them). The files are named by a shell glob: Node 22 and later read `node --test test/` as one file named `test/`. The browser scripts run only locally.
- Browser scripts wait for what the page does, never for a fixed time when something must happen: `scripts/browser-test-wait.cjs` `settled(page)` waits until no finite animation runs (a sheet slid in, a dialog faded in; MUI ripples are ignored), and a slow timer of the page (the 30 s check of an offline service, the 15 s id retry, the 10 s peek wait, the notice duration, five idle minutes) is jumped over with Playwright's clock (`page.clock.install()` before `goto`, then `page.clock.fastForward(ms)`; time still flows normally), not waited out. Product timing is never changed for a test. A fixed `waitForTimeout` is left only before a check that something does NOT happen.
- Installing through a flaky proxy: a request that stalls leaves `npm` waiting without using the CPU, and an interrupted install leaves temporary directories (`node_modules/.axios-XXXXXXXX`) that make the next install fail with `ENOTEMPTY`. Use `--fetch-timeout=20000 --fetch-retries=2` so a stalled request fails fast, and remove such directories before retrying.

## Recent versions

One line per release, added by `scripts/release.js`. Older notes are in `git log`.

> v2.87.14 Runtime data moves from <install>/data to ~/.tagent (TAGENT_HOME, alias T_AGENT_DATA_DIR): one-time copy with a backup of the old folder, empty-folder guard, refusal of a newer database schema (PRAGMA user_version), single-writer lock (server.lock), uninstall keeps the data unless --purge-data.
> v2.87.15 Phone/PC page loads faster (parallel start, hashed long-cache assets, defer + skeleton, pre-compressed files, zh dictionaries only for zh), slimmer MUI bundle and 44 px touch targets, voice keeps typed text, Android back closes layers, rename agent terminals, 3 warm terminals, virtualized file preview and Markdown images (capability files:image), pushed agent counters.
> v2.88.0 Single MUI page: / and /h5 serve the same page, old PC page, Monaco and tools pages removed (endpoints kept)
> v2.88.1 Phase 4 cleanup: stale comments, dead i18n keys, unused vendor files; login keeps the query of old /web links
> v2.88.2 Terminal keyboard button opens a custom full on-screen keyboard instead of the system keyboard
> v2.88.3 Saved commands: Keys group with common Claude Code and Codex key combinations (Shift+Tab, Shift+Left, Esc, Ctrl+R, ...)
> v2.88.4 Session name fields inline in the sidebar; Claude terminals follow their current session after /clear
> v2.88.5 Translate-and-send keeps line breaks and sends long text whole
> v2.88.6 Update dialog shows the force option only after a blocked update; data backups ignored by Git
> v2.88.7 Settings: one consistent row style; Design sheet: outline and full-screen zoomable images and diagrams; terminals keep their own start directory when the task's working directory changes (schema 8)
> v2.88.8 Terminal file links: a path that a program such as Claude Code wraps itself over several rows (real newlines and an indent) is one link
> v2.88.9 File tree on the MUI page, upload any file to OSS, OSC 52 copy in all input modes plus clipboard shims (pbcopy/xclip/xsel/wl-copy; Codex copies via OSC 52 with HERDR_ENV=1 and a codex wrapper), terminal uses the full width
> v2.88.10 Wheel strip never gets stuck after an interrupted touch; copy on select with one shared copy bar for page selections and program (OSC 52) copies
> v2.89.0 T-Attention (attention hub: tasks updated by listener plugins, Claude Code listener, t-attention CLI, context card, timeline, AI summary off by default, page panel with reminders, Telegram notifier), preview files at any path, Docs button, wheel strip as a scrollbar; schema 9
> v2.90.0 File preview of common formats (code highlighting, JSON, CSV, HTML, images with zoom, PDF, audio, video); T-Attention plugin overview, one-click and pairing install, manifest settings, Telegram QR login, plugin marketplace and setup guide; Wide terminal mode and touch scrolling anywhere (the scrollbar strip is gone)
> v2.90.1 Paste on iPhone: one clipboard read per tap (iOS refused the second read), and a paste sheet when the browser refuses
> v2.90.2 Telegram login and notifications use the SOCKS proxy from the environment, and connecting gives up after 20 seconds with a clear error instead of loading forever
> v2.91.0 T-Attention waits for all sub-agents before notifying, plugin settings open from a list, voice input can be turned off, and the top-bar agent counters are gone
> v2.91.1 Plain Claude turn ends raise no blue notice, blue notices start collapsed, Telegram sends a formatted card, and every session in the sidebar can be renamed
> v2.91.2 The test suite passes in CI on Node 20 again, and notifier plugins load in a stable order
> v2.91.3 Restore the phone terminal wheel strip for vertical scrolling, and offer Restart and Delete on sessions of tasks that are not selected.
> v2.92.0 Give an accurate error for an unusable translation key, make Enter send and Cmd/Ctrl+Enter a new line in the translation box, open the design document and file tree as a top sheet aligned with the terminal on wide screens, and remove agent chats from the task list.
> v2.93.0 Stop creating a terminal for new tasks, send a typed Space only once, keep lists from sticking on Loading after switching task, let sheet lists scroll without closing the sheet, and close the new session panel when its task collapses.
> v2.93.1 Open the session row menu as a popup under its button, and fade it in so a press during the opening is not lost.
> v2.94.0 Automatic silent updates: apply when the service has been idle for the quiet window, and reload open pages.
> v2.94.1 Keep the phone page full height when the visual viewport reports a small height with no keyboard, and never resize the PTY from a collapsed box.
> v2.95.0 Mind maps in the single page with XMind-style shortcuts, touch editing and .xmind import and export; reversible task archiving (schema 10).
> v2.95.1 Mind maps always use one tree that grows to the right.
> v2.95.2 Never list live tasks as archived when an older server process ignores the archived filter.
> v2.96.0 Service links: a six-digit code connects two services in both directions, with a reverse tunnel when the joiner cannot be reached.
> v2.97.0 Linked services share file upload, translation and speech recognition: a service without its own settings is served by a linked one, and keys never move.
> v2.98.0 One task list across this machine and every connected service, with no Engine switching, and a setting for which devices are shown.
> v2.99.0 Per-task visibility for linked machines: the owner of a task chooses which linked machines can see it, enforced on the /v1 API.
> v2.100.0 Mind maps shared across connected services, engine names with renaming, and New session / New task as dialogs.
> v2.101.0 Multi-column view, Cmd/Ctrl+Shift+O keyboard flow for New session, translate-and-send appends on a new line, a clearer copy bar, no system notifications, no flicker opening a remote session, and agent chat suggestions no longer lost.
> v2.102.0 Update linked services together from the Update dialog, and restart T-Agent from Settings.
> v2.103.0 One flat task list across devices with a device tag before each task name, drag and menu sorting, and one shared order across browsers and linked services.
> v2.104.0 Drag handle with reorder animation, task rename that can also rename the folder and move its Claude/Codex sessions, and automatic restart when the code on disk is newer than the running process.
> v2.105.0 The engine tag in front of a task name is now its drag grip and shows whether the task is open; the separate drag handle and the expand arrow are gone, so the title starts further left.
> v2.106.0 Sessions can be reordered within their task by press-and-hold (or Move up / Move down in their menu); the order is saved on the Engine that owns the task, so every client sees it.
> v2.107.0 Sessions can read files on linked engines (read-only MCP tools t-agent-peers for Claude and Codex; home folder only, sensitive files left out; one switch per engine), and Claude/Codex rules and chosen skills sync from a source engine to receive-only engines without touching each machine's own rules and skills.
> v2.108.0 The shared rules can be edited from the page of any linked engine (saved on the source), and receivers guard their synced copies: a local edit is backed up and replaced with the source's version.
> v2.109.0 T-Attention merged with the SELF-ATTENTION tracker: sub-tasks (parent), custom status and result fields, manual order with drag and drop onto another group, Confirm / Reject / Handled buttons, new CLI commands (confirm, reject, handled, move, tree, import-tasks-md) and a t-attention agent skill for Claude Code and Codex with an installer. Database schema 11.
> v2.110.0 T-Attention items of every connected service in one list (each item stays on its owner, /v1/attention and a proxy), and notifications only when a session is finished, needs you or failed while it is not open on a screen used in the last 5 minutes (terminal presence).
> v2.111.0 Settings tidied into fewer groups: Tasks and files, Voice and translation, Devices (devices, Link a device, peer file access, rules and skills sync, Advanced one-way connections), T-Attention, Account and access.
> v2.112.0 Shared Claude Code settings through the rules sync (status line with its scripts, interface preferences, optionally model, effort and permission mode, from a fixed allowlist), injected with --settings into the Claude sessions T-Agent starts on receivers, never written to their settings.json; each receiver can keep its own value per key.
> v2.113.0 Multi-column view: every column keeps the width of an 80-column terminal and the strip scrolls sideways with a visible scrollbar; sideways swipes inside a column scroll the strip, Ctrl+Alt+Left/Right moves between columns, up to 12 columns.
> v2.114.0 tcli, the agent command line: OSS list, stat, get, put, copy, move, delete and signed links on the bucket of the upload settings, from T-Agent terminals (the access key never leaves the server; linked services forward to the provider), with a switch in Settings; Agent skills installer for t-attention and tcli under Tasks and files.
> v2.115.0 T-Attention desktop window for macOS (the old floating window ported: count and badge, hover panel with every connected device's items, Confirm / Reject / Handled, drag to reorder or change status, create / edit / delete), built and started by T-Agent with a switch in Settings; the multi-column view fits four columns per screen and scrolls for more.
> v2.116.0 The header shows the device as the same tag as the task list; task rows can be reordered by press-and-hold anywhere on the row, and every order change slides smoothly (also when a new order arrives mid-slide).
> v2.116.1 The desktop window builds on every Mac: swiftc gets the macOS SDK path from xcrun (it failed with "unable to load standard library for target").
> v2.117.0 Settings of linked devices kept as one set (everything except the working directory, access and authenticator, device name, desktop window switch, peer file access, restart and rules-sync role; values sealed per link), Telegram notifications sent by one device for all, scope labels on every setting, and column tabs in the multi-column view with hold-drag reorder.
> v2.118.0 A name given to a Claude session (at creation, or a rename in T-Agent) becomes Claude's own session name with --name, shown in Claude's prompt box and /resume picker.
> v2.119.0 A Claude terminal stays bound to its original session after /clear, so reopening it resumes the original conversation
> v2.120.0 Settings for a linked device (per-device parts read and saved on K01 through the link), the Telegram label names the sender, rule-sync headers name Settings > Devices, and uploads stream through the service link tunnel (1 GiB)
> v2.121.0 Browser extension: agent sessions drive the computer's own Chrome through tcli browser (open/click/type, read the DOM, console and network, record a page's behaviour), with a paired Manifest V3 extension, secrets redacted by one shared rule, and a tcli site capability library that accumulates what the model learns about each website and syncs across linked devices
> v2.122.0 Settings: tabs at the top (Shared, this device, each linked device) replace the Settings for selector; each tab shows only the parts that belong to it, and a linked device's tab reads and saves on that device
> v2.123.0 Settings tabs for linked devices also when settings sync is off; the phone T-Attention list as the skill's Home view (trees kept together, shared with t-attention list --tree); calmer open settings groups (grey helper text fixed for MUI 9, type scale, fewer dividers, one button rule); translate-and-send puts the translation on a new line after Claude Code input such as an image link (its pointer is followed by a no-break space)
> v2.124.0 Notifier messages wait a few minutes first (messageDelayMinutes, default 3) and are dropped when the task moved on or the session was on screen; the on-screen check no longer depends on the host name, counts the Agent chat view, and expires for a frozen phone page
> v2.125.0 T-Attention desktop window takes less room: the floating counter is a 26 pt pill (count and Needs you badge), the hover panel is 288 x at most 440 pt with row buttons beside the second line
> v2.125.1 Browser extension 1.0.1: tcli browser back / forward work after a click on a link (falls back to the page's history when Chrome skips entries left without a user gesture)
> v2.125.2 Browser extension 1.0.2 reports the version in its manifest (it always said 1.0.0); the codex wrapper test reads the terminal name from a marked line
> v2.126.0 Email notifier (Gmail and 163 presets, other SMTP servers, encrypted app password / authorization code) and tcli notify: agent sessions message the user through Telegram (also through the linked sender) and email, with a switch in the notifier rules; notifiers that are not set up leave no line in the recent list
> v2.127.0 The terminal's Upload image or file button, a paste on the terminal and the Paste sheet take up to 9 files at once; they go up one after another and all links are typed in one paste.
> v2.127.1 The terminal copy bar hides by itself after 10 seconds, with a countdown line; a mouse over it or the keyboard focus inside it holds it.
> v2.128.0 The multi-column view's top bar has an Update button at its left end; it opens the header's Update dialog and shows the same red dot.
> v2.129.0 T-Attention tasks take a link in the page's edit dialog and open it with one click from the list, the desktop window, Telegram and email; a new Desktop window (macOS) notifier shows messages as a bubble beside the floating window, and a click opens the task's link or T-Agent.
> v2.129.1 Terminal close, restart and server exit now end the terminal's foreground job (SIGTERM, then SIGKILL), so an orphaned Codex no longer keeps its session lock and blocks codex resume
> v2.130.0 Desktop window: Confirm/Reject/Handled and Reply from the bubble, replies typed into the agent's terminal, Open session (page link ?openTerminal=), live agent activity in the pill and a Working now section, global shortcuts (Ctrl+Option+T panel, Ctrl+Option+N new task), per-display position, fade when idle, search and a collapsible Finished group, with switches in Settings
> v2.131.0 Lower idle cost: terminal activity without session-file reads and slower unwatched process polling, file sync that does nothing when nothing changed, one desktop-window tick endpoint with a cached item list and a completed_at index, quieter update log with production-only installs and audit fixes, idle agent chats leave memory and chat processes end on exit, long-cached lazy bundles and combined page scripts
> v2.132.0 Desktop window panel redesign (icon actions on the title line, readable background, drawn section dots with counts, two-line rows, compact search) and Open session switches the open T-Agent page in place (page channel on the attention stream, extension tabs.reveal) instead of opening a new tab
> v2.133.0 Mind maps as columns with a maximize for any column that keeps the others as a live rail; first-paint JS 1,067 KB to 709 KB (lazy settings, T-Attention, design and file tree chunks; chat shares React and highlight.js); store diffing and memoised rows (one activity push redraws one row); relay sender learns at once; CI on Node 20 and 24; faster browser tests; widget source split into files
> v2.133.1 DESIGN.md split into a 29 KB index plus 33 topic files under docs/design (content moved verbatim, line-checked); AGENTS.md, README and code comments point at the topic files
> v2.134.0 T-Agent.app: a native macOS shell app (WebKit window on the server, menu bar with status, start/restart/stop and the web addresses, t-agent:// links, auto-start of the service, not-running view), built universal and ad-hoc signed by npm run build:mac-app (--install to ~/Applications); the server publishes app.json with its web addresses, a Mac app card in Settings, and the floating window opens pages in the app
> v2.135.0 Multi-column view: one header per column (status dot, device tag, task and session with a list button, hover or touch actions, a menu with every action) instead of the tab strip plus each pane's own header; a column list, running summary and needs-you chip in the app bar; drag a header to reorder
> v2.136.0 Multi-column view: a navigation rail with Columns and Mind maps tabs (the mind map page with its list beside the editor; columns stay connected while hidden), mind map columns removed (old ones are dropped on load), and one compact bottom row per column (input, upload, voice, More tools, Translate and send; quiet in unfocused columns, drafts kept); minimum column width 340px
> v2.136.1 Terminal selection on a computer: the drawn text is back on the cell grid (the terminal no longer inherits the page's letter spacing), so a mouse selection ends at the pointer on long lines
> v2.137.0 Page redesign (MD2): one navigation for the whole page (the rail on a computer, a bottom navigation on a phone: Sessions, Columns, Attention, Mind maps, Settings); a one-line session header; the task list with sentence-case names, live session states, filter chips with counts and actions on hover; a one-row bottom area with one Send on a computer and flat tools on a phone (12px terminal font there); Settings as a group list with one page per group, switches for immediate options and one menu per device; one dialog pattern; T-Attention the same on a computer and a phone
> v2.138.0 T-Attention: a task from a T-Agent session opens that session on click (session chip, Details button, the status unchanged, a notice with Details on a phone, the shown session marked on a computer); the switch button opens a stacked switcher of recently used sessions like the iPhone app switcher (no count on the button, no shortcut, arrow keys while open); saved commands send at once with Enter, recently used first, a pencil to edit before sending
> v2.138.1 The task dialogs (delete, working directory, archive, visibility) load on demand, so the first screen is back under its 760 KiB budget (779,608 -> 768,371 bytes); fixes the v2.138.0 CI failure
> v2.139.0 Usage data: local, private tracking of button use (keys by id, never text; on by default; 90 days; Settings > Usage data with most used, not used, clear and export; schema 12); links opened by programs in a terminal open on the device in use (open / xdg-open / BROWSER stand-ins; Mac app at once, a bar in a browser, Safari or the default browser on a phone's Home Screen app; Codex on a macOS engine is not caught)
> v2.139.1 T-Attention floats over the page on a wide screen (nothing below is squeezed; a press outside closes it and does nothing else); the floating window's pill keeps its width (two-digit room, held while the panel is open) so the panel no longer slides; the Mac app refuses broken % escapes itself (its self-test failed when built with a newer SDK, as on K01)
> v2.140.0 Wide switcher: a row of cards without overlap, each naming its task; task list: a Recent tab (recently used sessions with time, device, task and state, the same order as the switcher); the Mac app rebuilds and reinstalls itself after an update when its shell code changed (source hash in Info.plist; never a first install)
> v2.140.1 Floating window: a fixed 32 x 90 pt vertical capsule with three numbers always shown (open, needs you, running; a dim 0, 99+ above 99), so the panel beside it never moves; the red number counts Needs-you items plus waiting terminals without an item, once each
> v2.141.0 Learn English: a Learn destination with study cards from the person's own translated sentences and looked-up words plus a Programmer English starter list; spaced review, Spell the word, Build the sentence, Dictation, Say it, Fill the gap and Mistakes; progress stored on the server (schema 13)
> v2.141.1 Renaming a Claude or Codex session row also renames the agent session (/rename typed into its terminal at once; it waits only while a permission question is shown or the agent is not in the foreground)
> v2.141.2 Keep the focus in the draft box after a send; Mac app title bar in the page's colour
