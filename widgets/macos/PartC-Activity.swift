// T-Attention desktop widget: Part C, live activity. See main.swift for the overview and the build.
import AppKit

// MARK: - Part C: live activity

// GET {TA_WIDGET_URL}/api/attention/widget/activity on the 5 s tick (one request at a time): the agent terminals of this
// machine that run, wait for a permission answer, or have just finished. The capsule's teal number is the running count
// and its red number takes in the waiting ones (needsYouCount); the panel lists them under "Working now", and a click
// on a row opens that terminal on the T-Agent page. A 404 (an older server) hides it and
// asks again after 5 minutes. WidgetController.showActivity (show_activity of GET /prefs) turns all of it off.

let activityRetryDelay: TimeInterval = 300  // after a 404 (an older server), the next try
let activityRowsShown = 5  // rows in the panel; the rest is "+N more"
let activityMaxTerminals = 50
let activityPathPrefix = "/?openTerminal="

enum ActivityState: String {
    case running, waiting, done

    /// The panel's order: waiting first (they need the person, and must not hide behind "+N more"), then running, then
    /// done. The server sends running first; the window orders them itself.
    var rank: Int {
        switch self {
        case .waiting: return 0
        case .running: return 1
        case .done: return 2
        }
    }

    var label: String {
        switch self {
        case .running: return L("Running")
        case .waiting: return L("Waiting for you")
        case .done: return L("Finished")
        }
    }

    /// The dot colour, as the notice bubble colours a working, a waiting and a done task.
    var color: NSColor {
        switch self {
        case .running: return toneColor("teal")
        case .waiting: return toneColor("orange")
        case .done: return toneColor("green")
        }
    }
}

/// One terminal of GET /activity.
struct ActivityTerminal: Equatable {
    var engine = "local"
    var taskID = ""
    var taskTitle = ""  // one line
    var terminalID = ""
    var title = ""  // the terminal's title, one line
    var agent = ""  // claude, codex or "" (a plain terminal or an unknown agent)
    var state: ActivityState = .running
    var since: Date?  // the last state change; nil when the answer has none
    var openPath = ""  // a path activityOpenPath accepts, else empty (the row then opens nothing)
    /// A waiting terminal's question: "select" (choose or enter something) or "accept" (an approval), else "" (an older server).
    var waitingKind = ""

    /// The state's words; a wait names its kind ("Two waiting kinds" in docs/design/terminals.md).
    var stateLabel: String {
        guard state == .waiting else { return state.label }
        switch waitingKind {
        case "select": return L("Needs selection")
        case "accept": return L("Needs acceptance")
        default: return state.label
        }
    }
}

let activityTimeFormatters: [ISO8601DateFormatter] = {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let whole = ISO8601DateFormatter()
    whole.formatOptions = [.withInternetDateTime]
    return [fractional, whole]
}()

/// An ISO 8601 time with or without fractional seconds; nil for anything else.
func activityTime(_ value: Any?) -> Date? {
    guard let text = (value as? String)?.trimmed, !text.isEmpty else { return nil }
    for formatter in activityTimeFormatters {
        if let date = formatter.date(from: text) { return date }
    }
    return nil
}

/// The page path a row may open: "/?openTerminal=<something>" without whitespace, control characters or backslashes.
/// Nil for anything else.
func activityOpenPath(_ value: String) -> String? {
    let text = value.trimmed
    guard text.hasPrefix(activityPathPrefix), text.count > activityPathPrefix.count, text.count <= 1000,
          !text.unicodeScalars.contains(where: {
              CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) || $0 == "\\"
          }) else { return nil }
    return text
}

/// The address a row opens: its path on the T-Agent of the window (`base`, WidgetAPI.base). Nil when the path is not
/// one activityOpenPath accepts.
func activityURL(_ path: String, base: String) -> URL? {
    guard let path = activityOpenPath(path), let origin = URL(string: base), let url = URL(string: base + path),
          url.host == origin.host, url.scheme == origin.scheme else { return nil }
    return url
}

/// A terminal of the answer; nil when its state is not running, waiting or done.
func decodeActivityTerminal(_ object: [String: Any]) -> ActivityTerminal? {
    guard let state = ActivityState(rawValue: (looseText(object["state"]) ?? "").trimmed.lowercased()) else { return nil }
    func text(_ key: String) -> String { String((looseText(object[key]) ?? "").oneLine.prefix(300)) }
    let agent = text("agent").lowercased()
    let engine = text("engine")
    return ActivityTerminal(engine: engine.isEmpty ? "local" : engine, taskID: text("task_id"), taskTitle: text("task_title"),
                            terminalID: text("terminal_id"), title: text("title"),
                            agent: agent == "claude" || agent == "codex" ? agent : "", state: state,
                            since: activityTime(object["since"]),
                            openPath: (object["open_path"] as? String).flatMap(activityOpenPath) ?? "",
                            waitingKind: ["select", "accept"].contains(text("waiting_kind")) ? text("waiting_kind") : "")
}

/// Waiting first, then running, then done; inside a state the newest `since` first (a missing one last).
func sortActivity(_ terminals: [ActivityTerminal]) -> [ActivityTerminal] {
    terminals.enumerated().sorted { a, b in
        if a.element.state.rank != b.element.state.rank { return a.element.state.rank < b.element.state.rank }
        let first = a.element.since ?? .distantPast
        let second = b.element.since ?? .distantPast
        if first != second { return first > second }
        return a.offset < b.offset
    }.map { $0.element }
}

/// The terminals of a GET /activity answer, sorted, at most activityMaxTerminals; nil when it is not one.
func decodeActivity(_ data: Data) -> [ActivityTerminal]? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let terminals = object["terminals"] as? [Any] else { return nil }
    return Array(sortActivity(terminals.compactMap { ($0 as? [String: Any]).flatMap(decodeActivityTerminal) })
        .prefix(activityMaxTerminals))
}

/// How long ago, short: "42s", "3m", "1h 2m".
func elapsedText(_ seconds: TimeInterval) -> String {
    let total = seconds.isFinite ? Int(min(max(seconds, 0), 1e9)) : 0
    if total < 60 { return L("{1}s", String(total)) }
    if total < 3600 { return L("{1}m", String(total / 60)) }
    return L("{1}h {2}m", String(total / 3600), String(total % 3600 / 60))
}

/// Who runs in the terminal: Claude or Codex, else the terminal's title, else "Terminal".
func activityAgentLabel(_ terminal: ActivityTerminal) -> String {
    switch terminal.agent {
    case "claude": return "Claude"
    case "codex": return "Codex"
    default: return terminal.title.isEmpty ? L("Terminal") : terminal.title
    }
}

/// The running terminals (the capsule's teal number) and the waiting ones (they need the person, like Needs you).
struct ActivityCounts: Equatable {
    var running = 0
    var waiting = 0
    var isEmpty: Bool { running == 0 && waiting == 0 }
}

func activityCounts(_ terminals: [ActivityTerminal]) -> ActivityCounts {
    ActivityCounts(running: terminals.filter { $0.state == .running }.count,
                   waiting: terminals.filter { $0.state == .waiting }.count)
}

/// The rows of the panel: the first activityRowsShown, and how many more there are.
func activityPanelRows(_ terminals: [ActivityTerminal]) -> (shown: [ActivityTerminal], more: Int) {
    (Array(terminals.prefix(activityRowsShown)), max(terminals.count - activityRowsShown, 0))
}

/// The VoiceOver label of a row: agent, task, state and time.
func activityRowSpeech(_ terminal: ActivityTerminal, now: Date) -> String {
    var parts = [activityAgentLabel(terminal)]
    if !terminal.taskTitle.isEmpty { parts.append(terminal.taskTitle) }
    parts.append(terminal.stateLabel)
    if let since = terminal.since { parts.append(elapsedText(now.timeIntervalSince(since))) }
    return parts.joined(separator: ", ")
}

/// The polling of GET /activity: one request at a time; a 404 (an older server) pauses it for activityRetryDelay.
struct ActivityPoll {
    var pausedUntil: Date?
    var inFlight = false

    func due(_ now: Date) -> Bool { !inFlight && (pausedUntil.map { now >= $0 } ?? true) }

    /// The terminals to show after an answer: what it lists, or none after any failure (a stale "running" would mislead).
    mutating func finished(code: Int, data: Data?, now: Date) -> [ActivityTerminal] {
        inFlight = false
        if code == 404 {
            pausedUntil = now.addingTimeInterval(activityRetryDelay)
            return []
        }
        guard (200..<300).contains(code), let data = data, let terminals = decodeActivity(data) else { return [] }
        pausedUntil = nil
        return terminals
    }
}

extension WidgetAPI {
    var activityRequest: URLRequest { request("GET", "/api/attention/widget/activity") }
}

/// A one-line field's text ends with an ellipsis when it does not fit (an attributed value carries its own style).
let truncating: NSParagraphStyle = {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byTruncatingTail
    return style
}()

/// One terminal under "Working now": a state dot, the task title with the agent muted after it, and at the right the
/// state and how long it has been in it. A click opens the terminal on the T-Agent page.
final class ActivityRowView: NSView {
    let terminal: ActivityTerminal
    let url: URL?
    var onClick: () -> Void = {}
    let titleField = NSTextField(labelWithString: "")
    let stateField = NSTextField(labelWithString: "")
    private var hovered = false { didSet { needsDisplay = true } }
    private var pressed = false
    static let height: CGFloat = 20

    init(terminal: ActivityTerminal, url: URL?, width: CGFloat) {
        self.terminal = terminal
        self.url = url
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: ActivityRowView.height))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: width).isActive = true
        heightAnchor.constraint(equalToConstant: ActivityRowView.height).isActive = true
        let title = NSMutableAttributedString()
        let agent = activityAgentLabel(terminal)
        if terminal.taskTitle.isEmpty {
            title.append(NSAttributedString(string: agent, attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.labelColor]))
        } else {
            title.append(NSAttributedString(string: terminal.taskTitle, attributes: [.font: NSFont.systemFont(ofSize: 12),
                                                                                       .foregroundColor: NSColor.labelColor]))
            title.append(NSAttributedString(string: "  " + agent, attributes: [.font: NSFont.systemFont(ofSize: 11),
                                                                                .foregroundColor: NSColor.secondaryLabelColor]))
        }
        title.addAttribute(.paragraphStyle, value: truncating, range: NSRange(location: 0, length: title.length))
        titleField.attributedStringValue = title
        for field in [titleField, stateField] {
            field.lineBreakMode = .byTruncatingTail
            field.maximumNumberOfLines = 1
            field.translatesAutoresizingMaskIntoConstraints = false
            field.setAccessibilityElement(false)
            addSubview(field)
        }
        titleField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        stateField.setContentCompressionResistancePriority(.required, for: .horizontal)
        stateField.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            titleField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            titleField.centerYAnchor.constraint(equalTo: centerYAnchor),
            titleField.trailingAnchor.constraint(lessThanOrEqualTo: stateField.leadingAnchor, constant: -8),
            stateField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            stateField.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        toolTip = terminal.taskTitle.isEmpty ? agent : agent + " \u{00B7} " + terminal.taskTitle
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
        setAccessibilityElement(true)
        setAccessibilityRole(url == nil ? .staticText : .button)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The state and the time since `since`, and the VoiceOver label with them; called on each refresh tick.
    func updateClock(_ now: Date) {
        let text = NSMutableAttributedString(string: terminal.stateLabel, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            .foregroundColor: terminal.state == .waiting ? terminal.state.color : NSColor.secondaryLabelColor,
            .paragraphStyle: truncating,
        ])
        if let since = terminal.since {
            text.append(NSAttributedString(string: "  " + elapsedText(now.timeIntervalSince(since)), attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor,
                .paragraphStyle: truncating,
            ]))
        }
        stateField.attributedStringValue = text
        setAccessibilityLabel(activityRowSpeech(terminal, now: now))
    }

    // The fields must not swallow the click.
    override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) ? self : nil }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() {
        if url != nil { addCursorRect(bounds, cursor: .pointingHand) }
    }

    override func mouseEntered(with event: NSEvent) { hovered = url != nil }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func mouseDown(with event: NSEvent) { pressed = true }

    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        if pressed, inside, url != nil { onClick() }
        pressed = false
    }

    override func accessibilityPerformPress() -> Bool {
        guard url != nil else { return false }
        onClick()
        return true
    }

    override func draw(_ dirtyRect: NSRect) {
        if hovered {
            NSColor.labelColor.withAlphaComponent(0.08).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
        }
        terminal.state.color.setFill()
        NSBezierPath(ovalIn: NSRect(x: 3, y: (bounds.height - 7) / 2, width: 7, height: 7)).fill()
    }
}

/// The live activity state of the window controller.
final class LiveActivity {
    var poll = ActivityPoll()
    var terminals: [ActivityTerminal] = []
    var rows: [ActivityRowView] = []  // the rows in the panel now
    var dirty = false  // changed while the panel could not be rebuilt (a press or drag); rebuilt on the next tick
}

extension WidgetController {
    /// Asks for the live activity; called with each refresh tick. Also moves the shown times on.
    func pollActivity() {
        updateActivityClock()
        if live.dirty, !refreshPaused, !rowDragActive { activityChanged() }
        guard showActivity, !tickMode, live.poll.due(now()) else { return }  // Part E: the tick brings the activity
        live.poll.inFlight = true
        perform(api.activityRequest) { [weak self] data, code, _ in
            guard let self = self else { return }
            let terminals = self.live.poll.finished(code: code, data: data, now: self.now())
            guard self.showActivity else { return }
            self.setActivity(terminals)
        }
    }

    func setActivity(_ terminals: [ActivityTerminal]) {
        guard terminals != live.terminals else { return }
        live.terminals = terminals
        activityChanged()
    }

    /// The capsule at once; the panel unless a row is pressed or dragged (then on the next tick).
    func activityChanged() {
        updateCollapsed()
        if refreshPaused || rowDragActive {
            live.dirty = true
            return
        }
        rebuildDetail()
        if detail.isVisible { positionDetail() }
    }

    func showActivityChanged() {
        if !showActivity { live.terminals = [] }
        activityChanged()
        if showActivity { if tickMode { sendTick(wantList: false) } else { pollActivity() } }
    }

    /// "Working now" at the top of the panel, with at most activityRowsShown rows and "+N more"; nothing when empty.
    func addActivitySection() {
        live.rows = []
        live.dirty = false
        guard showActivity, !live.terminals.isEmpty else { return }
        let header = SectionHeaderView(title: L("Working now"), count: live.terminals.count, color: toneColor("teal"),
                                       width: detailWidth - detailPadding * 2)
        stack.addArrangedSubview(header)
        stack.setCustomSpacing(3, after: header)
        let (shown, more) = activityPanelRows(live.terminals)
        let clock = now()
        for (index, terminal) in shown.enumerated() {
            let row = ActivityRowView(terminal: terminal, url: activityURL(terminal.openPath, base: api.base),
                                      width: detailWidth - detailPadding * 2)
            row.onClick = { [weak self, weak row] in
                // An open T-Agent page switches to the terminal; else its address opens (openTerminalPage).
                if let row = row, row.url != nil { self?.openTerminalPage(row.terminal.openPath) }
            }
            row.updateClock(clock)
            stack.addArrangedSubview(row)
            stack.setCustomSpacing(index == shown.count - 1 && more == 0 ? 9 : 1, after: row)
            live.rows.append(row)
        }
        if more > 0 { addLine(plain(L("+{1} more", String(more)), size: 11, color: .secondaryLabelColor), after: 9) }
    }

    func updateActivityClock() {
        let clock = now()
        live.rows.forEach { $0.updateClock(clock) }
    }

    // For --self-test and --render-sample.
    func testSetActivity(_ terminals: [ActivityTerminal]) { setActivity(terminals) }
    var testActivityRows: [ActivityRowView] { live.rows }
    var testActivityPoll: ActivityPoll { live.poll }
    /// A mouse down and up in the middle of a row, through the panel's hit test.
    func testPressActivityRow(_ index: Int) -> Bool {
        guard index < live.rows.count, let root = detail.contentView else { return false }
        let row = live.rows[index]
        let point = row.convert(NSPoint(x: row.bounds.midX, y: row.bounds.midY), to: nil)
        guard let taken = root.hitTest(root.superview?.convert(point, from: nil) ?? point) else { return false }
        taken.mouseDown(with: mouseEvent(.leftMouseDown, point))
        taken.mouseUp(with: mouseEvent(.leftMouseUp, point))
        return taken === row
    }
}

/// The terminals of the activity renders, relative to `now`.
func sampleActivity(now: Date) -> [ActivityTerminal] {
    func terminal(_ task: String, _ title: String, _ agent: String, _ state: ActivityState, ago: TimeInterval, _ id: String) -> ActivityTerminal {
        ActivityTerminal(taskID: id, taskTitle: task, terminalID: "t1", title: title, agent: agent, state: state,
                         since: now.addingTimeInterval(-ago), openPath: "/?openTerminal=local:\(id):t1")
    }
    return sortActivity([
        terminal("Build the widget API", "Claude 1", "claude", .running, ago: 185, "20"),
        terminal("Translate the strings", "Codex", "codex", .running, ago: 3720, "23"),
        terminal("Deploy the staging build", "Claude 2", "claude", .waiting, ago: 720, "12"),
        terminal("Fix the flaky stream test in the CI pipeline", "Claude", "claude", .running, ago: 42, "22"),
        terminal("", "npm run watch", "", .running, ago: 7300, "21"),
        terminal("Refactor the login flow", "Claude", "claude", .done, ago: 40, "9"),
        terminal("Check the new icons", "Codex", "codex", .done, ago: 900, "14"),
    ])
}

/// Renders the capsule and the panel with live activity, light and dark, into DIR, and the capsule in the states of the
/// mockup side by side (capsule-states-*.png: 12 / 6 / 1, 3 / 0 / 0, 128 / 14 / 3, and no list).
func renderActivitySample(_ controller: WidgetController, dir: String, save: (String, Bool) -> Void) {
    let clock = Date(timeIntervalSince1970: 1_800_000_000)
    controller.now = { clock }
    for dark in [false, true] {
        let suffix = dark ? "dark" : "light"
        controller.setAppearance(dark: dark)
        controller.loadForTest(sampleList())
        controller.testSetActivity(sampleActivity(now: clock))
        controller.loadForTest(sampleList())  // lays the panel out again with the section
        for name in ["widget-activity-\(suffix).png", "panel-activity-\(suffix).png"] {
            let path = (dir as NSString).appendingPathComponent(name)
            save(name, name.hasPrefix("widget") ? controller.renderWidget(path, dark: dark) : controller.renderPanel(path, dark: dark))
        }
        print("capsule with activity (\(suffix)): \(controller.testWidgetWidth) x \(controller.testWidgetHeight), "
              + controller.testTooltip)
        let states = [CapsuleCounts(open: 12, needs: 6, running: 1), CapsuleCounts(open: 3, needs: 0, running: 0),
                      CapsuleCounts(open: 128, needs: 14, running: 3), CapsuleCounts(open: nil, needs: nil, running: 0)]
        let name = "capsule-states-\(suffix).png"
        save(name, controller.renderCapsuleStates((dir as NSString).appendingPathComponent(name), states, dark: dark))
    }
    controller.testSetActivity([])
}

/// The checks of the live activity, for --self-test.
func runActivitySelfTest(_ check: (String, Bool) -> Void) {
    // Decoding.
    let answer = Data("""
    {"terminals":[
      {"engine":"local","task_id":"12","task_title":"Fix the\\nlogin","terminal_id":"t3","title":"Claude 1","agent":"claude",
       "state":"waiting","since":"2026-11-18T10:00:00.000Z","open_path":"/?openTerminal=local:12:t3"},
      {"task_id":"13","state":"running","since":"2026-11-18T10:05:00Z","agent":"CODEX","open_path":"/?openTerminal=local:13:t1"},
      {"task_id":"14","state":"idle"},
      {"task_id":"15","state":"done","agent":"gemini","title":"Shell","open_path":"javascript:alert(1)"},
      {"task_id":"16","state":"running","since":"2026-11-18T10:06:00Z","open_path":null},
      7
    ],"updated_at":"2026-11-18T10:07:00.000Z"}
    """.utf8)
    let decoded = decodeActivity(answer) ?? []
    check("activity: the answer is read, unknown states are left out", decoded.count == 4)
    check("activity: sorted waiting first, then running (newest first), then done",
          decoded.map { $0.taskID } == ["12", "16", "13", "15"])
    let waiting = decoded.first { $0.taskID == "12" }
    check("activity: every field of a full terminal", waiting == ActivityTerminal(
        engine: "local", taskID: "12", taskTitle: "Fix the login", terminalID: "t3", title: "Claude 1", agent: "claude",
        state: .waiting, since: Date(timeIntervalSince1970: 1_794_996_000), openPath: "/?openTerminal=local:12:t3"))
    let codex = decoded.first { $0.taskID == "13" }
    check("activity: missing fields get their defaults, times without a fraction are read",
          codex?.engine == "local" && codex?.agent == "codex" && codex?.title == "" && codex?.since == Date(timeIntervalSince1970: 1_794_996_300))
    let shell = decoded.first { $0.taskID == "15" }
    check("activity: an unknown agent and a bad open_path are dropped", shell?.agent == "" && shell?.openPath == ""
          && decoded.first { $0.taskID == "16" }?.openPath == "")
    check("activity: a broken answer is refused", decodeActivity(Data("[]".utf8)) == nil && decodeActivity(Data("{}".utf8)) == nil
          && decodeActivity(Data("nope".utf8)) == nil && decodeActivity(Data("{\"terminals\":[]}".utf8)) == [])
    let many = (0..<60).map { ["task_id": String($0), "state": "running"] }
    let manyData = try! JSONSerialization.data(withJSONObject: ["terminals": many])
    check("activity: at most 50 terminals", decodeActivity(manyData)?.count == activityMaxTerminals)
    check("activity: times with and without fractions, nothing else", activityTime("2026-11-18T10:00:00.250Z") != nil
          && activityTime("2026-11-18T10:00:00+08:00") != nil && activityTime("yesterday") == nil && activityTime(12) == nil)

    // Open paths.
    check("activity: open_path must be a terminal path of the page", activityOpenPath("/?openTerminal=local:12:t3") == "/?openTerminal=local:12:t3"
          && activityOpenPath(" /?openTerminal=remote:3:9:t1 ") == "/?openTerminal=remote:3:9:t1"
          && ["", "/?openTerminal=", "/h5?openTerminal=local:1:t1", "//evil.com/?openTerminal=x", "https://evil.com/?openTerminal=x",
              "/?openTerminal=local:1 t1", "/?openTerminal=local:1\\t1", "/?openTerminal=local:1\tt1", "/?openTerminal=a\nb",
              "javascript:alert(1)"].allSatisfy { activityOpenPath($0) == nil })
    check("activity: a row opens its path on the window's T-Agent",
          activityURL("/?openTerminal=local:12:t3", base: "http://127.0.0.1:3999")?.absoluteString == "http://127.0.0.1:3999/?openTerminal=local:12:t3"
          && activityURL("/h5", base: "http://127.0.0.1:3999") == nil)

    // Elapsed time, labels, counts.
    check("activity: elapsed time is short", [(-5, "0s"), (0, "0s"), (59, "59s"), (60, "1m"), (3599, "59m"), (3600, "1h 0m"),
                                               (3720, "1h 2m"), (90061, "25h 1m")].allSatisfy { elapsedText(TimeInterval($0.0)) == $0.1 }
          && elapsedText(.nan) == "0s" && elapsedText(.infinity) == "0s")
    stringTable = ["{1}m": "{1} min", "{1}h {2}m": "{1} h {2} min", "Waiting for you": "W"]
    check("strings: the elapsed time and the states come from the table", elapsedText(125) == "2 min" && elapsedText(3720) == "1 h 2 min"
          && ActivityState.waiting.label == "W")
    stringTable = [:]
    let kinds = decodeActivity(Data("""
    {"terminals":[{"task_id":"1","state":"waiting","waiting_kind":"select"},{"task_id":"2","state":"waiting","waiting_kind":"accept"},
      {"task_id":"3","state":"waiting","waiting_kind":"odd"},{"task_id":"4","state":"running","waiting_kind":"select"}]}
    """.utf8)) ?? []
    let kindLabel = { (id: String) in kinds.first { $0.taskID == id }?.stateLabel ?? "" }
    check("activity: a waiting terminal names its kind, an unknown kind or another state keeps the plain words",
          kindLabel("1") == "Needs selection" && kindLabel("2") == "Needs acceptance" && kindLabel("3") == "Waiting for you"
          && kindLabel("4") == "Running" && kinds.first { $0.taskID == "3" }?.waitingKind == ""
          && activityRowSpeech(kinds.first { $0.taskID == "1" }!, now: Date()).contains("Needs selection"))
    check("activity: the agent label is Claude, Codex, the title, else Terminal",
          activityAgentLabel(ActivityTerminal(title: "Claude 2", agent: "claude")) == "Claude"
          && activityAgentLabel(ActivityTerminal(agent: "codex")) == "Codex"
          && activityAgentLabel(ActivityTerminal(title: "npm run watch")) == "npm run watch"
          && activityAgentLabel(ActivityTerminal()) == "Terminal")
    check("activity: running and waiting are counted, not done", activityCounts(decoded) == ActivityCounts(running: 2, waiting: 1)
          && activityCounts([]).isEmpty)
    let seven = (0..<7).map { ActivityTerminal(taskID: String($0)) }
    check("activity: at most five rows, then +N more", activityPanelRows(seven).shown.count == 5 && activityPanelRows(seven).more == 2
          && activityPanelRows(Array(seven.prefix(3))).more == 0)

    // Polling.
    var poll = ActivityPoll()
    let start = Date(timeIntervalSince1970: 1_000_000)
    check("poll: activity is due at first", poll.due(start))
    poll.inFlight = true
    check("poll: one activity request at a time", !poll.due(start))
    check("poll: a failure shows nothing and tries again on the next tick", poll.finished(code: 500, data: Data(), now: start).isEmpty
          && poll.due(start))
    _ = poll.finished(code: 404, data: nil, now: start)
    check("poll: a 404 stops the activity for five minutes", !poll.due(start.addingTimeInterval(activityRetryDelay - 1))
          && poll.due(start.addingTimeInterval(activityRetryDelay)))
    check("poll: an answer starts it again", poll.finished(code: 200, data: answer, now: start).count == 4 && poll.pausedUntil == nil)

    // The window.
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let controller = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:3999", token: "secret-token"), parentPID: nil, options: options)
    var requests: [URLRequest] = []
    var answers: [(Data?, Int) -> Void] = []
    var opened: [String] = []
    var clock = Date(timeIntervalSince1970: 1_794_996_600)  // 10:10:00Z
    controller.requestHook = { request, done in
        requests.append(request)
        answers.append(done)
    }
    controller.openURL = { opened.append($0.absoluteString) }
    controller.announce = { _ in }
    controller.now = { clock }
    func reply(_ body: Data?, _ code: Int = 200) {
        guard !answers.isEmpty else { return }
        answers.removeFirst()(body, code)
    }
    let items = ItemList(items: (1...12).map { index in
        WidgetItem(key: "local:\(index)", engine: "local", id: String(index), parentKey: "", title: "Task \(index)",
                   status: index <= 3 ? "waiting_user" : "working", customStatus: "", result: "", attentionReason: "", pending: "",
                   notes: "", sortOrder: Double(index), link: "", linkLabel: "")
    }, engines: [EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0)], failed: [])
    controller.loadForTest(items)
    func capsule(_ open: String, _ needs: String, _ running: String) -> Bool {
        controller.testCount == open && controller.testBadge == needs && controller.testRunning == running
            && controller.testWidgetWidth == widgetWidth && controller.testWidgetHeight == widgetHeight
    }
    check("capsule: no activity, 0 running", capsule("12", "3", "0") && controller.testActivityRows.isEmpty
          && controller.testLines.first?.contains("Needs you") == true)
    controller.pollActivity()
    let request = requests.first
    check("request: activity is a GET with the token", requests.count == 1 && request?.httpMethod == "GET"
          && request?.url?.absoluteString == "http://127.0.0.1:3999/api/attention/widget/activity"
          && request?.value(forHTTPHeaderField: "Authorization") == "Bearer secret-token" && request?.httpBody == nil)
    controller.pollActivity()
    check("poll: the window sends one activity request at a time", requests.count == 1)
    reply(answer)
    check("capsule: the running count, and the waiting terminal (no item of its own) joins Needs you, same size",
          capsule("12", "4", "2"))
    check("capsule: the tooltip and VoiceOver label read the three numbers", controller.testTooltip == "12 open \u{00B7} 4 need you \u{00B7} 2 running")
    let lines = controller.testLines
    check("panel: Working now comes first with its rows", lines.first?.contains("Working now") == true
          && lines.count > 5 && lines[1] == "Fix the login  Claude" && lines[2] == "Terminal" && lines[3] == "Codex"
          && controller.testActivityRows.count == 4 && lines[5].contains("Needs you"))
    let rows = controller.testActivityRows
    check("panel: the rows' states and times", rows.map { $0.stateField.stringValue } == ["Waiting for you  10m", "Running  4m", "Running  5m", "Finished"])
    check("panel: the rows' VoiceOver labels", rows[0].accessibilityLabel() == "Claude, Fix the login, Waiting for you, 10m"
          && rows[1].accessibilityLabel() == "Terminal, Running, 4m"
          && rows[0].accessibilityRole() == .button && rows[3].accessibilityRole() == .staticText)
    clock = clock.addingTimeInterval(3000)
    controller.pollActivity()  // the next tick moves the times on, and asks again
    check("panel: the times move on with each tick", controller.testActivityRows[0].stateField.stringValue == "Waiting for you  1h 0m"
          && requests.count == 2)
    var raised = 0
    controller.activateBrowser = { raised += 1 }
    check("click: a row first asks T-Agent to switch an open page", controller.testPressActivityRow(0) && opened.isEmpty
          && requests.last?.httpMethod == "POST" && requests.last?.url?.path == "/api/attention/widget/open-terminal"
          && requests.last?.httpBody.flatMap { String(data: $0, encoding: .utf8) } == "{\"engine\":\"local\",\"task_id\":\"12\",\"terminal_id\":\"t3\"}")
    answers.removeLast()(Data("{\"delivered\":0,\"focused\":false}".utf8), 200)
    check("click: no page took it, so it opens its terminal on T-Agent", opened == ["http://127.0.0.1:3999/?openTerminal=local:12:t3"])
    let postsBefore = requests.filter { $0.httpMethod == "POST" }.count
    check("click: a row without a valid path opens nothing", controller.testPressActivityRow(3) && opened.count == 1
          && controller.testActivityRows[3].accessibilityPerformPress() == false && requests.filter { $0.httpMethod == "POST" }.count == postsBefore)
    check("click: VoiceOver's press asks too", controller.testActivityRows[0].accessibilityPerformPress()
          && requests.filter { $0.httpMethod == "POST" }.count == postsBefore + 1)
    answers.removeLast()(Data("{\"delivered\":1,\"focused\":true}".utf8), 200)
    check("click: a page took it and the extension focused its tab: nothing opens, no browser activation", opened.count == 1 && raised == 0)
    let sevenTerminals = (0..<7).map { ActivityTerminal(taskID: String($0), taskTitle: "T\($0)", openPath: "/?openTerminal=local:\($0):t1") }
    reply(try! JSONSerialization.data(withJSONObject: ["terminals": sevenTerminals.map { ["task_id": $0.taskID, "task_title": $0.taskTitle,
                                                                                          "state": "running", "open_path": $0.openPath] }]))
    check("panel: five rows and +2 more", controller.testActivityRows.count == 5 && controller.testLines.contains("+2 more")
          && capsule("12", "3", "7"))
    controller.pollActivity()
    reply(Data("{\"error\":\"NOT_FOUND\"}".utf8), 404)
    check("poll: a 404 hides the activity", capsule("12", "3", "0") && controller.testActivityRows.isEmpty
          && controller.testLines.first?.contains("Working now") == false)
    let at404 = requests.count
    clock = clock.addingTimeInterval(activityRetryDelay - 1)
    controller.pollActivity()
    check("poll: and asks again only after five minutes", requests.count == at404)
    clock = clock.addingTimeInterval(1)
    controller.pollActivity()
    check("poll: then tries again", requests.count == at404 + 1)
    reply(answer)
    check("poll: an answer after the pause shows it again", controller.testActivityRows.count == 4)
    controller.pollActivity()
    reply(Data(), 500)
    check("poll: a failed answer hides it", capsule("12", "3", "0") && controller.testActivityRows.isEmpty)
    controller.pollActivity()
    reply(answer)
    controller.showActivity = false
    let offCount = requests.count
    check("prefs: showActivity off shows 0 running, leaves the waiting terminal out of Needs you and hides the section",
          capsule("12", "3", "0") && controller.testActivityRows.isEmpty)
    controller.pollActivity()
    check("prefs: and stops asking", requests.count == offCount)
    controller.showActivity = true
    check("prefs: turning it on asks at once", requests.count == offCount + 1)
    reply(answer)
    check("prefs: and shows it again", controller.testActivityRows.count == 4 && capsule("12", "4", "2"))
    controller.pollActivity()
    controller.showActivity = false
    reply(answer)
    check("prefs: an answer that arrives after turning it off is ignored", capsule("12", "3", "0")
          && controller.testActivityRows.isEmpty && controller.testActivityPoll.due(clock))
    controller.showActivity = true
    reply(Data("{\"terminals\":[]}".utf8))
    check("panel: no terminals, no section", controller.testActivityRows.isEmpty && capsule("12", "3", "0")
          && controller.testLines.first?.contains("Working now") == false)
    check("activity: no window was put on screen", !controller.testOnScreen)
}
