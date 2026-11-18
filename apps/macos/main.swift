// T-Agent.app: a native macOS window for the T-Agent web service. The Node server stays what it is (PM2 or launchd runs
// it, browsers and phones use it); the app shows its page in a WKWebView, keeps a menu bar item with the service's state,
// web addresses and Start / Restart / Stop, and opens t-agent:// links. AppKit and WebKit only, no dependencies, built with
// the Command Line Tools (scripts/build-mac-app.js makes the bundle). The source is every *.swift file of this folder,
// compiled together; this file (main.swift) is the entry point, because Swift runs top-level code only from main.swift:
//
//   Config          app.json, the data home, the server address, the web addresses, the app version
//   URLPolicy       same origin, navigation decisions, the microphone rule, page URLs, download names
//   DeepLink        t-agent://show and t-agent://open?path=...
//   ServiceControl  the pm2 / launchd commands, the process runner and the health check
//   ServiceMonitor  the running / not running state machine, the automatic start, the check timers
//   Placeholder     the not-running view
//   StatusMenu      the menu bar item
//   MainMenu        the main menu (the Edit menu makes Cmd+C / V / X / A / Z work in the page)
//   MainWindow      the window, the web view and its delegates
//   AppDelegate     the wiring, the links, the preferences, the real services
//   SelfTest        --self-test
//
//   swiftc -O -swift-version 5 -target x86_64-apple-macos12.0 -framework AppKit -framework WebKit $(ls apps/macos/*.swift | sort) -o T-Agent
//
// --self-test  run the logic checks with fake files, health checks, processes, timers and openers: no window, no network,
//              no process, never the real ~/.tagent or the app's defaults; print ok / FAIL lines and "N passed, M failed",
//              exit 0 only when every check passed
// --version    print the version of the app (CFBundleShortVersionString; "dev" outside a bundle) and exit
import AppKit

// MARK: - Entry point

if CommandLine.arguments.contains("--self-test") {
    runSelfTest()
}
if CommandLine.arguments.contains("--version") {
    print(appVersion())
    exit(0)
}

let preferences = UserDefaultsPreferences()
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate(services: liveServices(preferences: preferences), preferences: preferences)
app.delegate = delegate
app.run()
