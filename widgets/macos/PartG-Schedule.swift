// T-Attention desktop widget: Part G, scheduled and recurring tasks. See main.swift for the overview and the build.
import AppKit

// MARK: - Part G: scheduled and recurring tasks
//
// The owner engine keeps the schedule, computes `next_at` and fires it ("Scheduled and recurring tasks" in
// docs/design/attention-desktop-window.md); the window shows and edits it:
// - Items of an engine with schedules carry `schedule`, `then_action`, `next_at`, `schedule_state`, `runs`, `last_fired_at`,
//   `last_done_at`, `schedule_text` and `then_target` (ItemTiming). Older owners send none of them and nothing below shows.
// - The panel lists a task that waits for its time (`schedule_state` 'waiting') under Scheduled (once, blue dot) or Recurring
//   (repeat, purple dot) after To do, soonest first, with its rule and next time on the second line; a due task is in the
//   section of its status, with its symbol before the title. Waiting tasks are not counted in the capsule or the heading.
// - A prompt the busy session did not take (Needs you, `schedule_state` 'due') has Send now, a failed script Run again: both
//   POST /items/:key/run-now. A script's terminal (the item's `session`, from context.tagent) opens as "Open terminal".
// - Bubbles: the window compares `last_fired_at` of every item between two lists of /tick. A new firing makes "It is time"
//   (remind: Open, Done), "Prompt sent" (Open session), "Prompt not sent" (the session was busy: Open session, Send now) or
//   "Script failed" (Open terminal, Run again); a script that ended with exit 0 makes none. In the first list after the
//   window starts, only a firing of the last minute counts. The server's own notice of the same task (the widget notifier,
//   kind `item`) within two minutes is dropped, and one already shown gives way.
// - The form gets "When" and "Then" (Part G's ScheduleEditorView), with "Next: ..." from POST /schedule/preview and the
//   pop-ups from GET /targets of the item's engine.

/// The rule of a repeating schedule.
struct ScheduleRule: Equatable {
    var freq = "daily"  // daily, weekdays, weekly, monthly, every
    var days: [Int] = []  // weekly: 1 (Monday) to 7
    var day = 1  // monthly: 1 to 31
    var interval = 1  // every N days
    var time = "09:00"
}

struct ScheduleEnds: Equatable {
    var kind = "never"  // never, on, after
    var date = ""  // YYYY-MM-DD
    var count = 1
}

/// `schedule` of an item: once at a wall time of the owner, or repeating by a rule.
struct ItemSchedule: Equatable {
    var kind = "once"  // once, repeat
    var at = ""  // once: YYYY-MM-DDTHH:mm
    var rule = ScheduleRule()
    var starts = ""
    var ends = ScheduleEnds()
    var tz = ""  // the owner's zone; empty for a new one (the owner fills it in)

    /// The body value the owner takes.
    var json: [String: Any] {
        var out: [String: Any] = ["kind": kind]
        if kind == "once" {
            out["at"] = at
        } else {
            var rule: [String: Any] = ["freq": self.rule.freq, "time": self.rule.time]
            switch self.rule.freq {
            case "weekly": rule["days"] = self.rule.days
            case "monthly": rule["day"] = self.rule.day
            case "every": rule["interval"] = self.rule.interval
            default: break
            }
            out["rule"] = rule
            if !starts.isEmpty { out["starts"] = starts }
            switch ends.kind {
            case "on": out["ends"] = ["kind": "on", "date": ends.date]
            case "after": out["ends"] = ["kind": "after", "count": ends.count]
            default: break
            }
        }
        if !tz.isEmpty { out["tz"] = tz }
        return out
    }
}

/// `then_action`: remind (also for null), a prompt typed into a session, or a script run in a new terminal of a task.
struct ThenAction: Equatable {
    var kind = "remind"  // remind, prompt, script
    var taskId = ""
    var terminalId = ""
    var text = ""  // the prompt
    var script = ""
    var timeoutMin = 30

    /// The body value: nil for remind (sent as null).
    var json: [String: Any]? {
        switch kind {
        case "prompt": return ["kind": "prompt", "task_id": taskId, "terminal_id": terminalId, "text": text]
        case "script": return ["kind": "script", "task_id": taskId, "script": script, "timeout_min": timeoutMin]
        default: return nil
        }
    }
}

/// `then_target`: where a prompt goes or the task a script runs in, with its name when this machine is the owner.
struct ThenTarget: Equatable {
    var engine = ""
    var taskId = ""
    var terminalId = ""
    var name = ""
    var openPath = ""
}

/// The schedule fields of an item.
struct ItemTiming: Equatable {
    var present = false  // the owner sent them (it has schedules)
    var schedule: ItemSchedule?
    var then = ThenAction()
    var nextAt: Date?
    var state = ""  // waiting, due or ""
    var runs = 0
    var lastFired = ""  // `last_fired_at` as sent: compared between two lists
    var lastDoneAt: Date?
    var text = ""  // schedule_text, the owner's English sentence
    var target: ThenTarget?
    var lastExit: Int?

    var waiting: Bool { schedule != nil && state == "waiting" }
    var due: Bool { schedule != nil && state == "due" }
}

/// A JSON object, also given as a JSON string; nil for anything else.
func looseObject(_ value: Any?) -> [String: Any]? {
    if let object = value as? [String: Any] { return object }
    guard let text = value as? String, let data = text.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func decodeSchedule(_ value: Any?) -> ItemSchedule? {
    guard let object = looseObject(value), let kind = looseText(object["kind"]), kind == "once" || kind == "repeat" else { return nil }
    var out = ItemSchedule(kind: kind)
    out.at = looseText(object["at"]) ?? ""
    out.tz = looseText(object["tz"]) ?? ""
    out.starts = looseText(object["starts"]) ?? ""
    if let rule = looseObject(object["rule"]) {
        out.rule.freq = looseText(rule["freq"]) ?? "daily"
        out.rule.days = ((rule["days"] as? [Any]) ?? []).compactMap { looseNumber($0).map { Int($0) } }.filter { (1...7).contains($0) }
        out.rule.day = looseNumber(rule["day"]).map { Int($0) } ?? 1
        out.rule.interval = looseNumber(rule["interval"]).map { Int($0) } ?? 1
        out.rule.time = looseText(rule["time"]) ?? "09:00"
    }
    if let ends = looseObject(object["ends"]) {
        out.ends.kind = looseText(ends["kind"]) ?? "never"
        out.ends.date = looseText(ends["date"]) ?? ""
        out.ends.count = looseNumber(ends["count"]).map { Int($0) } ?? 1
    }
    return out
}

func decodeThen(_ value: Any?) -> ThenAction {
    guard let object = looseObject(value) else { return ThenAction() }
    let kind = looseText(object["kind"]) ?? ""
    var out = ThenAction()
    out.taskId = (looseText(object["task_id"]) ?? "").trimmed
    switch kind {
    case "prompt":
        out.terminalId = (looseText(object["terminal_id"]) ?? "").trimmed
        out.text = looseText(object["text"]) ?? ""
        if !out.taskId.isEmpty && !out.terminalId.isEmpty { out.kind = "prompt" }
    case "script":
        out.script = looseText(object["script"]) ?? ""
        out.timeoutMin = looseNumber(object["timeout_min"]).map { Int($0) } ?? 30
        if !out.taskId.isEmpty { out.kind = "script" }
    default:
        break
    }
    return out.kind == "remind" ? ThenAction() : out
}

func decodeTiming(_ object: [String: Any]) -> ItemTiming {
    guard object.keys.contains("schedule") else { return ItemTiming() }
    var out = ItemTiming(present: true)
    out.schedule = decodeSchedule(object["schedule"])
    out.then = decodeThen(object["then_action"])
    out.nextAt = activityTime(object["next_at"])
    let state = looseText(object["schedule_state"]) ?? ""
    out.state = state == "waiting" || state == "due" ? state : ""
    out.runs = max(0, looseNumber(object["runs"]).map { Int($0) } ?? 0)
    out.lastFired = (looseText(object["last_fired_at"]) ?? "").trimmed
    out.lastDoneAt = activityTime(object["last_done_at"])
    out.text = (looseText(object["schedule_text"]) ?? "").oneLine
    out.lastExit = looseNumber(object["last_exit"]).map { Int($0) }
    if let target = looseObject(object["then_target"]) {
        out.target = ThenTarget(engine: (looseText(target["engine"]) ?? "").trimmed, taskId: (looseText(target["task_id"]) ?? "").trimmed,
                                terminalId: (looseText(target["terminal_id"]) ?? "").trimmed, name: (looseText(target["name"]) ?? "").oneLine,
                                openPath: (target["open_path"] as? String).flatMap(sessionOpenPath) ?? "")
    }
    return out
}

extension WidgetItem {
    /// The terminal Open session opens: the agent's terminal of the task (context.tagent; for a failed script the terminal it
    /// ran in), else the session a prompt goes to.
    var openPath: String {
        if let path = session?.openPath, !path.isEmpty { return path }
        return timing.target?.openPath ?? ""
    }
}

// MARK: Words

/// The clock and the zone the schedule lines are written in; --self-test fixes them.
var scheduleClock: () -> Date = { Date() }
var scheduleZone = TimeZone.current

let weekdayShort = [S("Mon"), S("Tue"), S("Wed"), S("Thu"), S("Fri"), S("Sat"), S("Sun")]
let weekdayLong = [S("Monday"), S("Tuesday"), S("Wednesday"), S("Thursday"), S("Friday"), S("Saturday"), S("Sunday")]

/// The rule in a few words, without the time: "Every day", "Weekdays", "Every Monday", "Every Mon, Thu", "Every 3 days",
/// "Monthly on day 15" (the page's words, translated by the window's table).
func ruleWords(_ rule: ScheduleRule) -> String {
    let days = Array(Set(rule.days)).sorted()
    switch rule.freq {
    case "weekdays": return L("Weekdays")
    case "weekly":
        if days == [1, 2, 3, 4, 5] { return L("Weekdays") }
        if days.isEmpty || days.count == 7 { return L("Every day") }
        if days.count == 1 { return L("Every {1}", L(weekdayLong[days[0] - 1])) }
        return L("Every {1}", days.map { L(weekdayShort[$0 - 1]) }.joined(separator: ", "))
    case "monthly": return L("Monthly on day {1}", String(rule.day))
    case "every": return rule.interval > 1 ? L("Every {1} days", String(rule.interval)) : L("Every day")
    default: return L("Every day")
    }
}

/// "Once", or the rule and its time: "Every Monday 09:00".
func ruleText(_ schedule: ItemSchedule) -> String {
    schedule.kind == "once" ? L("Once") : ruleWords(schedule.rule) + " " + schedule.rule.time
}

func scheduleCalendar() -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = scheduleZone
    return calendar
}

func clockText(_ date: Date) -> String {
    let parts = scheduleCalendar().dateComponents([.hour, .minute], from: date)
    return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
}

/// A moment in words, in this Mac's time: "today 10:00", "tomorrow 09:30", "yesterday 18:00", else "Mon 12-01 10:00".
/// `time` false leaves the time out; `today` false writes a time of today alone ("09:41").
func momentText(_ date: Date, now: Date, time: Bool = true, today: Bool = true) -> String {
    let calendar = scheduleCalendar()
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 99
    let clock = time ? " " + clockText(date) : ""
    switch days {
    case 0: return today ? L("today") + clock : clockText(date)
    case 1: return L("tomorrow") + clock
    case -1: return L("yesterday") + clock
    default:
        let parts = calendar.dateComponents([.weekday, .month, .day], from: date)
        let weekday = ((parts.weekday ?? 2) + 5) % 7  // Sunday = 1 -> 6, Monday = 2 -> 0
        return L(weekdayShort[weekday]) + " " + String(format: "%02d-%02d", parts.month ?? 1, parts.day ?? 1) + clock
    }
}

/// The exit code of the last script run: `last_exit` when the owner sends it, else read from the reason of a failed run.
func lastExitCode(_ item: WidgetItem) -> Int? {
    if let exit = item.timing.lastExit { return exit }
    guard item.timing.due, item.status == "waiting_user",
          let regex = try? NSRegularExpression(pattern: "exit (-?[0-9]{1,4})"),
          let match = regex.firstMatch(in: item.attentionReason, range: NSRange(item.attentionReason.startIndex..., in: item.attentionReason)),
          let range = Range(match.range(at: 1), in: item.attentionReason) else { return nil }
    return Int(item.attentionReason[range])
}

/// The schedule line of a row ("" without a schedule): the rule; for a waiting task its next time ("Mon 12-01 10:00" once,
/// "next tomorrow" for a repeat at its usual time), "due now" for a due one; "done 09:41" for a repeat done before; then
/// where its prompt or script goes, and the exit code of the last script run when it is known.
func scheduleLine(_ item: WidgetItem, now: Date) -> String {
    guard let schedule = item.timing.schedule else { return "" }
    var parts = [ruleText(schedule)]
    if item.timing.due {
        parts.append(L("due now"))
    } else if item.timing.waiting, let next = item.timing.nextAt {
        if schedule.kind == "once" {
            parts.append(momentText(next, now: now))
        } else {
            let usual = clockText(next) == schedule.rule.time
            parts.append(L("next {1}", momentText(next, now: now, time: !usual)))
        }
    }
    if schedule.kind == "repeat", let done = item.timing.lastDoneAt { parts.append(L("done {1}", momentText(done, now: now, today: false))) }
    let name = item.timing.target?.name ?? ""
    switch item.timing.then.kind {
    case "prompt": parts.append(name.isEmpty ? L("sends a prompt") : L("prompt to {1}", name))
    case "script":
        parts.append(name.isEmpty ? L("runs a script") : L("script in {1}", name))
        if let exit = lastExitCode(item) { parts.append(L("exit {1}", String(exit))) }
    default: break
    }
    return parts.joined(separator: " \u{00B7} ")
}

/// The symbol before the title of a scheduled task.
enum RowMark: Equatable {
    case none, once, repeating, prompt, script

    var symbol: String {
        switch self {
        case .none: return ""
        case .once: return "clock"
        case .repeating: return "arrow.triangle.2.circlepath"
        case .prompt: return "paperplane"
        case .script: return "chevron.left.forwardslash.chevron.right"
        }
    }

    /// Drawn in the title instead when the system has no symbols.
    var glyph: String {
        switch self {
        case .none: return ""
        case .once: return "\u{25F7}"
        case .repeating: return "\u{21BB}"
        case .prompt: return "\u{27A4}"
        case .script: return "\u{203A}_"
        }
    }
}

func rowMark(_ item: WidgetItem) -> RowMark {
    guard let schedule = item.timing.schedule else { return .none }
    switch item.timing.then.kind {
    case "prompt": return .prompt
    case "script": return .script
    default: return schedule.kind == "repeat" ? .repeating : .once
    }
}

func rowMarkImage(_ mark: RowMark) -> NSImage? {
    mark == .none ? nil : symbolImage(mark.symbol, pointSize: 9)
}

/// The mark as a small muted symbol before the title; nil without one (or without symbols: then the glyph is in the title).
func rowMarkView(_ row: Row) -> NSImageView? {
    guard let image = rowMarkImage(row.mark) else { return nil }
    let view = NSImageView(image: image)
    view.contentTintColor = .secondaryLabelColor
    view.imageScaling = .scaleProportionallyDown
    view.setAccessibilityElement(false)
    view.translatesAutoresizingMaskIntoConstraints = false
    view.widthAnchor.constraint(equalToConstant: 11).isActive = true
    view.heightAnchor.constraint(equalToConstant: 11).isActive = true
    return view
}

/// Scheduled and Recurring: the waiting tasks of that kind, the soonest next time first (none last), then the engine order and
/// the list order. No children are drawn under parents there.
func timedOrder(_ items: [WidgetItem], _ section: Section, engines: [EngineInfo]) -> [(item: WidgetItem, depth: Int)] {
    let ranks = engineRanks(engines)
    return items.filter { sectionOf($0) == section }.sorted { a, b in
        let nextA = a.timing.nextAt ?? .distantFuture
        let nextB = b.timing.nextAt ?? .distantFuture
        if nextA != nextB { return nextA < nextB }
        let rankA = ranks[a.engine] ?? ranks.count
        let rankB = ranks[b.engine] ?? ranks.count
        if rankA != rankB { return rankA < rankB }
        return comesBefore(a, b)
    }.map { ($0, 0) }
}

/// The status an action leaves the task in, for the list until the refresh (the owner's answer wins when it has one); nil when it is not known.
func actionStatus(_ action: RowAction) -> String? {
    switch action {
    case .confirm, .done: return "done"
    case .reject, .handled: return "working"
    default: return nil
    }
}

/// Whether a row or bubble may run this action on the task as the list has it now.
func actionAllowed(_ action: RowAction, _ item: WidgetItem) -> Bool {
    if action == .done { return !finishedStatuses.contains(item.status) }
    return rowActions(for: item).contains(action)
}

// MARK: Bubbles of a firing

let scheduleNoticeKinds: Set<String> = ["scheduled", "prompt_sent", "prompt_failed", "script_failed"]
let firingRecent: TimeInterval = 60  // in the first list, a firing this recent still makes a bubble
let firingTwinWindow: TimeInterval = 120  // the server's notice of the same task within this time is dropped

/// What a firing of the item made: a reminder, a prompt sent or not, a script that failed; nil for a script that ended well.
func firingKind(_ item: WidgetItem) -> String? {
    let failed = item.status == "waiting_user" && item.timing.due
    switch item.timing.then.kind {
    case "prompt": return failed ? "prompt_failed" : "prompt_sent"
    case "script": return failed ? "script_failed" : nil
    default: return "scheduled"
    }
}

/// The bubble of a firing. The title names the engine when the list has more than one.
func firingNotice(_ kind: String, _ item: WidgetItem, engine: String?) -> WidgetNotice {
    let heading: String
    var text = item.title.oneLine
    switch kind {
    case "prompt_sent":
        heading = L("Prompt sent")
        if let name = item.timing.target?.name, !name.isEmpty { text += " \u{2192} " + name }
    case "prompt_failed":
        heading = L("Prompt not sent")
        if !item.attentionReason.isEmpty { text += "\n" + item.attentionReason.oneLine }
    case "script_failed":
        heading = L("Script failed")
        if !item.attentionReason.isEmpty { text += "\n" + item.attentionReason.oneLine }
    default:
        heading = L("It is time")
        if let schedule = item.timing.schedule { text += " \u{00B7} " + ruleText(schedule) }
    }
    return WidgetNotice(seq: 0, kind: kind, title: heading + (engine.map { " \u{00B7} " + $0 } ?? ""), text: text, from: "",
                        status: item.status, key: item.key, target: "", seconds: kind == "prompt_sent" ? noticeDefaultSeconds : 0)
}

/// The firings between the list seen before (`previous`: key -> last_fired_at as sent; nil before the first list) and this one.
/// An item the window did not have yet counts only when it fired in the last firingRecent seconds.
func firingNotices(previous: [String: String]?, items: [WidgetItem], engines: [EngineInfo], now: Date) -> [WidgetNotice] {
    var names: [String: String] = [:]
    for engine in engines where names[engine.key] == nil { names[engine.key] = engine.name }
    let many = names.count > 1
    return items.compactMap { item in
        let fired = item.timing.lastFired
        guard item.timing.schedule != nil, !fired.isEmpty, let kind = firingKind(item) else { return nil }
        if let before = previous?[item.key] {
            guard before != fired else { return nil }
        } else {
            guard let at = activityTime(fired), now.timeIntervalSince(at) <= firingRecent else { return nil }
        }
        return firingNotice(kind, item, engine: many ? names[item.engine] ?? item.engine : nil)
    }
}

/// The buttons of a firing's bubble, by the task as the list has it now.
func scheduleBubbleActions(_ notice: WidgetNotice, item: WidgetItem?) -> [RowAction] {
    guard let item = item, item.key == notice.key else { return [] }
    let open: [RowAction] = item.openPath.isEmpty ? [] : [notice.kind == "script_failed" ? .terminal : .session]
    switch notice.kind {
    case "scheduled": return [.open] + (finishedStatuses.contains(item.status) ? [] : [.done])
    case "prompt_sent": return open
    case "prompt_failed": return open + (actionAllowed(.sendNow, item) ? [.sendNow] : [])
    case "script_failed": return open + (actionAllowed(.runAgain, item) ? [.runAgain] : [])
    default: return []
    }
}

/// Part G's state on the controller.
final class PartGState {
    var seen: [String: String]?  // key -> last_fired_at of the last list applied; nil before the first
    var twins: [String: Date] = [:]  // key -> when the window made a bubble of its firing
    var previewTimer: Timer?
    var previewGeneration = 0
    var targetsGeneration = 0
    var coveredTopRow: [NSView] = []  // the top row's parts hidden while an overlay shows
}

// MARK: Requests

/// A session a prompt can go to and a task a script can run in (GET /targets).
struct TargetSession: Equatable {
    var taskId: String
    var terminalId: String
    var name: String
    var taskTitle: String
}

struct TargetTask: Equatable {
    var id: String
    var title: String
}

func decodeTargets(_ data: Data) -> (sessions: [TargetSession], tasks: [TargetTask])? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let sessions: [TargetSession] = ((object["sessions"] as? [Any]) ?? []).compactMap { entry in
        guard let entry = entry as? [String: Any], let task = looseText(entry["task_id"]), let terminal = looseText(entry["terminal_id"]),
              !task.isEmpty, !terminal.isEmpty else { return nil }
        return TargetSession(taskId: task, terminalId: terminal, name: (looseText(entry["name"]) ?? "").oneLine,
                             taskTitle: (looseText(entry["task_title"]) ?? "").oneLine)
    }
    let tasks: [TargetTask] = ((object["tasks"] as? [Any]) ?? []).compactMap { entry in
        guard let entry = entry as? [String: Any], let id = looseText(entry["id"]), !id.isEmpty else { return nil }
        return TargetTask(id: id, title: (looseText(entry["title"]) ?? "").oneLine)
    }
    return (sessions, tasks)
}

/// The answer of POST /schedule/preview: the next times, the owner's sentence and why it cannot be saved.
func decodePreview(_ data: Data) -> (next: [Date], text: String, error: String)? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let next = ((object["next"] as? [Any]) ?? []).compactMap { activityTime($0) }
    return (next, (looseText(object["text"]) ?? "").oneLine, (looseText(object["error"]) ?? "").oneLine)
}

extension WidgetAPI {
    /// Send now, Run again (and a reminder fired now): the owner's run-now.
    func runNowRequest(key: String) -> URLRequest {
        request("POST", itemPath(key) + "/run-now", body: [:])
    }

    func previewRequest(engine: String, schedule: [String: Any]) -> URLRequest {
        request("POST", "/api/attention/widget/schedule/preview", body: ["engine": engine, "schedule": schedule])
    }

    func targetsRequest(engine: String) -> URLRequest {
        request("GET", "/api/attention/widget/targets?engine=" + WidgetAPI.encodeKey(engine))
    }
}

extension WidgetController {
    /// The request of a scheduled task's action, or nil for the others.
    func scheduleActionRequest(key: String, action: RowAction) -> URLRequest? {
        switch action {
        case .sendNow, .runAgain: return api.runNowRequest(key: key)
        case .done: return api.updateRequest(key: key, fields: ["status": "done"])
        default: return nil
        }
    }

    /// Called with every list the window applies: bubbles for the firings since the last one.
    func noteScheduleFirings(_ list: ItemList) {
        let fresh = firingNotices(previous: partG.seen, items: list.items, engines: list.engines, now: now())
        var seen: [String: String] = [:]
        for item in list.items where seen[item.key] == nil { seen[item.key] = item.timing.lastFired }
        partG.seen = seen
        let at = now()
        partG.twins = partG.twins.filter { at.timeIntervalSince($0.value) < firingTwinWindow }
        guard !fresh.isEmpty else { return }
        for notice in fresh { partG.twins[notice.key] = at }
        // The server's bubble of the same task (the widget notifier) gives way to the window's, which has the right buttons.
        let replaces = noticeQueue.current.map { current in current.kind == "item" && fresh.contains { $0.key == current.key } } ?? false
        noticeQueue.add(fresh)
        if noticeQueue.current == nil || replaces { showNextNotice() }
    }

    /// The server's notices without those of a task whose firing the window has just shown.
    func withoutScheduleTwins(_ notices: [WidgetNotice]) -> [WidgetNotice] {
        let at = now()
        return notices.filter { notice in
            guard notice.kind == "item", let made = partG.twins[notice.key] else { return true }
            return at.timeIntervalSince(made) >= firingTwinWindow
        }
    }

    /// The form's "When" and "Then" for an item of this engine (nil for a new task: this machine), or nil when the engine has
    /// no schedules. It asks for the engine's sessions and tasks at once, and for "Next" after each change.
    func makeScheduleEditor(engine: String, item: WidgetItem?) -> ScheduleEditorView? {
        let supported = (list?.engines ?? []).first { $0.key == engine }?.schedules == true || item?.timing.present == true
        guard supported else { return nil }
        let editor = ScheduleEditorView(engine: engine, timing: item?.timing ?? ItemTiming(), now: scheduleClock())
        editor.onChange = { [weak self, weak editor] in editor.map { self?.schedulePreview($0) } }
        loadTargets(editor)
        sendPreview(editor)
        return editor
    }

    /// "Next" 0.3 s after the last change (at once offscreen, where timers do not run).
    func schedulePreview(_ editor: ScheduleEditorView) {
        partG.previewTimer?.invalidate()
        partG.previewTimer = nil
        if options.offscreen {
            sendPreview(editor)
            return
        }
        let timer = Timer(timeInterval: 0.3, repeats: false) { [weak self, weak editor] _ in
            self?.partG.previewTimer = nil
            editor.map { self?.sendPreview($0) }
        }
        RunLoop.main.add(timer, forMode: .common)
        partG.previewTimer = timer
    }

    func sendPreview(_ editor: ScheduleEditorView) {
        partG.previewGeneration += 1
        let generation = partG.previewGeneration
        guard let schedule = editor.schedule, editor.scheduleProblem == nil else {
            editor.showPreview(nil)
            return
        }
        perform(api.previewRequest(engine: editor.engine, schedule: schedule.json)) { [weak self, weak editor] data, code, _ in
            guard let self = self, let editor = editor, generation == self.partG.previewGeneration else { return }
            if (200..<300).contains(code), let data = data, let answer = decodePreview(data) {
                editor.showPreview(answer)
            } else {
                editor.showPreview(nil)  // an older owner or no answer: no "Next" line
            }
        }
    }

    func loadTargets(_ editor: ScheduleEditorView) {
        partG.targetsGeneration += 1
        let generation = partG.targetsGeneration
        perform(api.targetsRequest(engine: editor.engine)) { [weak self, weak editor] data, code, _ in
            guard let self = self, let editor = editor, generation == self.partG.targetsGeneration,
                  (200..<300).contains(code), let data = data, let targets = decodeTargets(data) else { return }
            editor.setTargets(sessions: targets.sessions, tasks: targets.tasks)
        }
    }

    // For --self-test and --render-sample.
    var testScheduleForm: TaskFormView? { overlay as? TaskFormView }
    func testFirings(_ list: ItemList) { apply(list, problem: nil) }
    var testShownNotice: WidgetNotice? { noticeQueue.current }
    var testWaitingNotices: [WidgetNotice] { noticeQueue.waiting }
}
