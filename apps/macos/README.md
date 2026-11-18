# T-Agent.app (macOS shell app)

A native window for the T-Agent web service: the page in a WKWebView, a menu bar item with the service's state, its web addresses and Start / Restart / Stop, and `t-agent://` links. The Node server is not part of the app; PM2 or launchd keeps running it, and browsers, phones and linked devices keep using it. Quitting the app never stops the server. AppKit and WebKit only, built with the Command Line Tools. The design is in `docs/design/mac-app.md`.

| File | What is in it |
|------|---------------|
| `main.swift` | The entry point (top-level code only here), the overview comment, `--self-test` and `--version` |
| `Config.swift` | The app version, the data home, reading `app.json` (missing or broken file, every field checked), the web addresses |
| `URLPolicy.swift` | Same origin, what stays in the window and what opens in the browser, the microphone rule, page URLs, download names |
| `DeepLink.swift` | Parsing `t-agent://show` and `t-agent://open?path=...` |
| `ServiceControl.swift` | The exact pm2 / launchd commands, shell quoting, the process runner, the health check, the timer type |
| `ServiceMonitor.swift` | The state machine (checking, running, not running, starting, restarting, stopping), the one automatic start, the check timing, the injected `AppServices` |
| `Placeholder.swift` | The not-running view and its text per state |
| `StatusMenu.swift` | The menu bar item: entries per state, the web addresses, the icon drawn in code |
| `MainMenu.swift` | The main menu; the Edit menu makes Cmd+C / V / X / A / Z work in the page |
| `MainWindow.swift` | The window, the web view and its navigation, UI and download delegates |
| `AppDelegate.swift` | The wiring, the Apple Event for links, the alerts, the preferences, the real services |
| `SelfTest.swift` | `--self-test` and its fakes |

## Build and check

```bash
swiftc -O -swift-version 5 -target x86_64-apple-macos12.0 -framework AppKit -framework WebKit $(ls apps/macos/*.swift | sort) -o "$TMPDIR/tagent-app"
"$TMPDIR/tagent-app" --self-test   # ok / FAIL lines, then "N passed, M failed"; exit 0 only when all passed
"$TMPDIR/tagent-app" --version     # CFBundleShortVersionString, "dev" outside a bundle
```

`scripts/build-mac-app.js` builds the bundle (both architectures, Info.plist, icon, signing). The self-test replaces every outside effect with a fake (files, environment, health checks, processes, timers, clock, browser, pasteboard): it puts no window on screen, opens no connection, runs no process and never reads the real `~/.tagent` or the app's defaults. `test/mac-app-swift.test.js` compiles the files to a temporary folder and runs it (skipped off macOS or without `swiftc`; `TA_SKIP_SWIFT_APP=1` skips it on a Mac).

## Rules

- Never launch the built app on screen while developing or testing; only `--self-test` and `--version`. Never install it into `~/Applications` or `/Applications` from a test, and never control the real PM2 or launchd from a test.
- Top-level statements only in `main.swift`. Every new `*.swift` file is built with the others; add it to the table above (the test checks).
- The app's text is English only in v1 (no translation layer); the test fails on CJK text in this folder.
