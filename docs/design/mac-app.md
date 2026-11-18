# macOS app (T-Agent.app)

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

> Code: `apps/macos/*.swift` (the app, entry point `main.swift`; `apps/macos/README.md` lists the files), `scripts/build-mac-app.js` (the bundle). Tests: `test/mac-app-swift.test.js` (compiles the sources and runs `--self-test`).

## Why a shell app

T-Agent is a web service: a Node server that PM2 (or launchd) runs and that updates itself with git. Browsers, phones and linked devices use it. A Mac user also wants it as an app: its own window and Dock icon, a menu bar item that tells whether the service runs, Start / Restart / Stop without a terminal, and links that other programs (the floating window) can open. The app is only that front end. It is a thin native AppKit program with a WKWebView, built with the Command Line Tools like the floating window (`widgets/macos`). It has no Electron and no bundled Node, and it never replaces the server. The web service stays reachable exactly as before: quitting the app never stops it, and the window shows the same service that browsers use.

- Bundle id `local.t-agent.app`, minimum macOS 12, universal (x86_64 and arm64), ad-hoc signed, version = `app_version` of `VERSION.json`.
- The app's text is English only in v1. It has no translation layer (the page inside it is translated as usual); `test/mac-app-swift.test.js` fails on CJK text in `apps/macos`.

## The app

**Finding the server.** The server writes `<data home>/app.json` at every start (`url`, `version`, `pid`, `install_dir`, `supervisor`, `pm2_name`, `addresses`; see the server section below). The data home is `TAGENT_HOME`, then `T_AGENT_DATA_DIR`, then the hidden default `DataHome` (`defaults write local.t-agent.app DataHome <path>`, for a person whose `TAGENT_HOME` lives only in a shell profile, which an app opened from the Finder does not see), else `~/.tagent`. Every field is checked: a missing or broken file gives the defaults (`http://127.0.0.1:3000`, no supervisor), and a bad field falls back to its default while the others are kept. `url` keeps only `scheme://host[:port]` of an http(s) address. An optional `launchd_label` names the LaunchAgent; the default is `com.tagent.client`. app.json is read again before every check, so a new port is picked up (the page loads again at the new address).

**Is it running.** `GET <url>/api/system/version` with a 2 s timeout, no proxy, no cookies. Any HTTP answer counts as running, because the route needs a login, so a 401 also proves the server is there. The version comes from a 200 answer, else from app.json. A state machine (`stepMonitor` in `ServiceMonitor.swift`) has the states checking (launch), running, not running, starting, restarting and stopping:

| State | Next check |
|-------|------------|
| running | 15 s; after one failure again in 1 s, and only two failures in a row count as gone (one failure can be a restart) |
| not running | 5 s |
| starting, restarting, stopping | 1 s; a start not answered within 60 s has failed, and a stop the server still answers 20 s later has failed |

Only one check is pending at a time, and the answer to an older check is dropped.

**Starting at launch.** When the first check finds no server, app.json names PM2 or launchd, and the preference "Start T-Agent when the app opens" is on (default on; in the menu bar menu and the app menu), the app runs the Start command once per app run. The placeholder says "Starting T-Agent…" and the page loads as soon as the server answers. Without a supervisor it does not start anything; the placeholder explains how.

**Window.** One window (it remembers its frame through `setFrameAutosaveName`) with a WKWebView on the server. It uses the default persistent website data store, so the login cookie survives restarts and the person logs in once in the app. The user agent is WebKit's default plus ` T-AgentApp/<version>` (`applicationNameForUserAgent`), so the page and the server can tell the app from a browser. Swipe back and forward is on. Web Inspector can be attached only on macOS 13.3 and newer, and only in a debug build or with `defaults write local.t-agent.app WebInspector -bool true`.
- Navigation (`navigationDecision`): the server's own origin (scheme, host and port) stays in the window. Another origin from the main frame, every `target=_blank` and every `window.open` open in the default browser (the app never opens a second web view). An iframe of another origin loads in place. `about:blank` / `about:srcdoc` and `blob:` load in place, `data:` only in an iframe, and `mailto:` / `tel:` go to their app. Everything else is cancelled, including `file:`, `javascript:` and `t-agent:`.
- Microphone (voice input): `requestMediaCapturePermissionFor` is granted for the server's own origin only, and macOS then asks once for the app (NSMicrophoneUsageDescription).
- File inputs open an NSOpenPanel (multiple files and folders when the input allows them). `alert`, `confirm` and `prompt` show as sheets (the page uses `confirm`).
- Downloads (WKDownload): a response the web view cannot show, or `Content-Disposition: attachment`, or a link with `download`, goes to `~/Downloads`. The name is cleaned (no folders, colons or leading dots), and a taken name gets ` (1)`, ` (2)` and so on. A finished download makes the Downloads stack bounce.
- Keyboard: a program without a nib has no menu, so the app builds the main menu in code. Its Edit menu uses the standard first-responder selectors, which makes Cmd+C / V / X / A / Z work in the page. Cmd+R reloads, Cmd+[ / Cmd+] go back and forward, Cmd+0 / Cmd+= / Cmd+- zoom, Cmd+W hides the window (the app stays in the menu bar and the Dock; a Dock click shows it again), and Cmd+Q quits the app while the server keeps running. No menu item takes Esc, Tab or the arrow keys, so they reach the page and the terminal. WebKit offers other key equivalents to the page before the menu.
- A main-frame load that fails makes the monitor check at once. A web content process that crashed is reloaded.

**Not-running view.** While the server does not answer, the window shows a native view instead of a WebKit error page. It says "T-Agent is not running" and explains that this is the same web service that browsers and phones use. It shows the last error (for example `pm2: command not found`), or the Terminal command when there is no supervisor, and has the buttons "Start T-Agent" and "Try again". It tries again every 5 s. It keeps AppKit controls but follows Material Design 2 for layout (`PlaceholderLayout`): the 8 pt grid (8 between title and text, 24 before the spinner or buttons, 8 between buttons, 32 from the edges, text at most 480 wide), Headline 6 / Body 2 type (20 pt medium title, 14 pt secondary text), system surface and on-surface colors, and one accent on the primary "Start T-Agent" button. While a start runs it shows a spinner instead of the buttons. When the server is back, the page that was open loads again (or the path of a waiting `t-agent://open` link).

**Menu bar.** An NSStatusItem with a template icon drawn in code (a rounded square with a T). The menu is rebuilt from `statusMenuEntries` every time it opens:
- the status line ("T-Agent is running (v2.133.1)" / "T-Agent is not running" / "Starting T-Agent…" …) and "The same web service your browsers use"
- Open T-Agent, and Open in Browser (the page that is open, else the server; only while it runs)
- Web addresses: one item per address of app.json (`label: url`). A click copies the URL, and with Option held the item becomes "Open <label> in Browser" (an alternate item). The list comes from app.json `addresses`, read defensively: only `kind` local / lan / remote with an http(s) URL that has a host and no user or password. A missing label becomes This Mac / Local network / Remote. The list is sorted local, lan, remote, without repeats, at most 12, and is the server's own address when empty.
- Start (only while not running; without a supervisor it explains how), Restart and Stop (only while running under PM2 or launchd). None of them is enabled while a command runs.
- Start T-Agent when the app opens (a checkbox), and Quit T-Agent app.

**Service control.** By `supervisor` of app.json (`serviceCommand`):

| Supervisor | Start | Restart | Stop |
|------------|-------|---------|------|
| pm2 | `pm2 start <name>`, or `cd <dir> && pm2 start server.js --name <name> --cwd <dir>` when PM2 no longer knows the name | `pm2 restart <name>` | `pm2 stop <name>` |
| launchd | `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/<label>.plist` when the job is not loaded, then `launchctl kickstart gui/<uid>/<label>` | `launchctl kickstart -k gui/<uid>/<label>` | `launchctl bootout gui/<uid>/<label>` |
| systemd, none, no app.json | instructions (the pm2 command with the install folder, with Copy Command) | not offered | not offered |

The pm2 commands run through the person's login shell (`$SHELL -lc` when it is sh, bash, zsh or ksh, else `/bin/zsh -lc`), after adding `~/.local/bin`, `~/.local/node/bin`, `/opt/homebrew/bin` and `/usr/local/bin` to PATH and loading nvm when pm2 is still not found. Names and paths are single-quoted. Stop and Restart ask for confirmation first, because browsers, phones and linked devices lose the service too. A failed command the person asked for shows its output in an alert; a failed automatic start shows it in the not-running view. The app never starts an unmanaged background process and never kills a process. The output is read as it arrives and taken when the command exits, so the PM2 daemon holding the pipe never blocks it, and a command still running after 90 s is ended.

**Deep links.** The app registers `t-agent://` (CFBundleURLTypes in the bundle) and receives links as `kAEGetURL` Apple Events. The handler is registered in `applicationWillFinishLaunching`, so the link that launched the app is not lost. `t-agent://show` shows the window. `t-agent://open?path=<value>` shows it and loads that path of the server. It is accepted only with exactly one `path` and nothing else, and with no user, port, fragment or path on the host. The value is percent-decoded exactly once (a broken escape or bytes that are not UTF-8 are refused, and `+` stays `+`). It must then start with one `/` (never `//`), have no backslash, whitespace, control or format character, and be at most 4096 characters. The page URL is built from the server's address (non-ASCII is percent-encoded) and must still be of the server's origin. Any other link is ignored. While the server is not running, the path waits and loads when the page shows.

## Self-test

`T-Agent --self-test` (or any build of `apps/macos/*.swift`) runs about 215 checks and prints `ok` / `FAIL` lines and `N passed, M failed`. It exits 0 only when every check passed. It covers app.json (missing, broken, every field, the data home and its overrides), the web addresses, origins and navigation decisions, the microphone rule, page URLs, download names, deep links, the exact argv of every service command with shell quoting, the state machine (timing, the one automatic start, failures, timeouts), the monitor run with fake timers / health checks / processes (dropped stale answers, a new address in app.json), the placeholder text, the menu bar entries and their enabling, the alternate items, the main menu's selectors and key equivalents, and the window built offscreen (user agent, gestures, inspector, delegates, close hides) and the placeholder layout (8 pt grid, type sizes, the one accent).

Every outside effect is injected (`AppServices`: files, environment, health check, process runner, scheduler, clock, browser opener, pasteboard), so the self-test puts no window on screen, opens no connection, runs no process and never reads the real `~/.tagent`. The window in the test uses a non-persistent website data store and no frame autosave, so nothing is written to the app's defaults or WebKit folders. `test/mac-app-swift.test.js` compiles the sources with `-Onone` into a temporary folder (no warnings allowed), runs the self-test and `--version`, and checks that every source file is in `apps/macos/README.md`, that top-level code is only in `main.swift` and that the folder has no CJK text. It is skipped off macOS or without `swiftc`, and `TA_SKIP_SWIFT_APP=1` skips it on a Mac.

What only a person running the app can check: the window and its remembered frame, typing in the terminal (Esc, Tab, arrows, Ctrl keys, an input method), Cmd+C / V / X / A / Z in the page and the terminal, swipe back and forward, the microphone prompt and voice input, file inputs, `confirm` sheets, downloads into `~/Downloads`, links opening in the default browser, `t-agent://` links from the floating window or `open t-agent://...`, the menu bar icon in light and dark menu bars, the Option-click alternate items, Start / Restart / Stop against the real PM2 or launchd (with nvm or Homebrew PATHs), the automatic start at launch, the login cookie surviving an app restart, and the Web Inspector default.

## Building and installing

To be written with `scripts/build-mac-app.js` (bundle, Info.plist, icon, universal build, signing, `--install`).

## Server and floating window integration

To be written with the server change (`app.json` and its `addresses`), the floating window's `t-agent://` links and the Settings "Mac app" card.
