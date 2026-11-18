// T-Attention desktop widget for macOS: a small always-on-top counter of the unfinished T-Attention tasks, with a
// detail panel on hover to act on them. T-Agent builds and starts it (see widgets/macos/README.md). AppKit only, no
// dependencies. The source is every *.swift file of this folder, compiled together; this file (main.swift) is the entry
// point, because Swift runs top-level code only from main.swift. The other files hold the sections (one `// MARK: -`
// section, or part of one, per file; the controller's groups of methods are `extension WidgetController` blocks):
//
//   Strings, Model, Notices, Reordering, Requests   the data and the requests
//   Views, Views-Forms, Views-Bubble                the views
//   Controller (the class and its stored state), Controller-Window, Controller-Rows, Controller-Data, Controller-Testing
//   PartB-Actions, PartC-Activity, PartD-Preferences, PartE-Tick, PartF-Look
//   SampleData (--render-sample), SelfTest (--self-test)
//
//   swiftc -O -swift-version 5 -framework AppKit widgets/macos/*.swift -o taw
//   TA_WIDGET_URL=http://127.0.0.1:3000 TA_WIDGET_TOKEN=<token> ./taw [--parent-pid PID] [--no-persist]
//
// --parent-pid PID     exit when PID is no longer this process's parent (checked every second)
// --no-persist         neither read nor write the saved window position
// --self-test          run the logic, request, drag and form checks without putting a window on screen and without the
//                      network; print ok / FAIL lines and exit 0 only when every check passed
// --render-sample DIR  build the widget and the panel with built-in sample data, render them offscreen into DIR/*.png
//                      and exit; no window is ever ordered on screen
//
// Polling: one request every 5 s, GET {TA_WIDGET_URL}/api/attention/widget/tick with `Authorization: Bearer
// {TA_WIDGET_TOKEN}`: the item list (only when it changed), the notices, the activity and the preferences in one answer
// (see "Part E: one request per tick"). An older T-Agent answers it 404; the window then asks the four endpoints below
// on the same 5 s timer and tries /tick again after 5 minutes. The token is never printed or logged.
// Data: GET {TA_WIDGET_URL}/api/attention/widget/items.
// Notices: GET {TA_WIDGET_URL}/api/attention/widget/notices?after=<seq>; each new one slides out in a bubble beside the
// window, and a click opens its target.
// Activity: GET {TA_WIDGET_URL}/api/attention/widget/activity; the running and waiting agent terminals show in the pill
// and under "Working now" in the panel (see "Part C: live activity").
// Preferences: GET {TA_WIDGET_URL}/api/attention/widget/prefs (global shortcuts, fading when idle, the working agents
// section); see "Part D: shortcuts and preferences".
//
// Text: every visible string is English in these files and goes through L(), which looks it up in the table loaded from
// GET /api/attention/widget/strings (the English text itself when it is missing). S() only marks a string that is
// translated later with L(). widgets/macos/strings.json lists every such string; test/attention-widget-swift.test.js
// checks that the list and these files agree.
import AppKit

// MARK: - Entry point

func argumentValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

if CommandLine.arguments.contains("--self-test") {
    runSelfTest()
}
if let dir = argumentValue("--render-sample") {
    renderSample(dir)
}

let environment = ProcessInfo.processInfo.environment
var options = WidgetOptions()
options.persistPosition = !CommandLine.arguments.contains("--no-persist")

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = WidgetController(api: WidgetAPI(base: environment["TA_WIDGET_URL"], token: environment["TA_WIDGET_TOKEN"]),
                                  parentPID: argumentValue("--parent-pid").flatMap { pid_t($0) }, options: options)
app.delegate = controller
app.run()
