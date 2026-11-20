// T-Attention desktop widget: the sample data and --render-sample. See main.swift for the overview and the build.
import AppKit

// MARK: - Sample data

func sampleList() -> ItemList {
    func item(_ key: String, _ status: String, _ title: String, order: Double, parent: String = "", custom: String = "",
              result: String = "", reason: String = "", pending: String = "", link: String = "", label: String = "",
              session: [String: Any]? = nil) -> WidgetItem {
        decodeItem(["key": key, "status": status, "title": title, "sort_order": order, "parent_key": parent,
                    "custom_status": custom, "result": result, "attention_reason": reason, "pending": ["kind": "question", "text": pending],
                    "notes": "", "link_url": link, "link_label": label, "session": session ?? NSNull()])!
    }
    func session(_ engine: String, _ task: String, live: Bool?) -> [String: Any] {
        ["engine": engine, "task_id": task, "terminal_id": "t1", "agent": "claude", "live": live.map { $0 as Any } ?? NSNull(),
         "open_path": "/?openTerminal=\(engine):\(task):t1"]
    }
    return ItemList(items: [
        item("local:12", "waiting_user", "Deploy the staging build", order: 50, pending: "Allow running npm publish?",
             link: "https://ci.example.com/run/12", label: "CI run", session: session("local", "12", live: true)),
        item("local:9", "review", "Refactor the login flow", order: 40, result: "Tests pass; ready to merge",
             link: "https://github.com/example/app/pull/42", label: "PR #42"),
        item("local:14", "review", "Check the new icons", order: 45, result: "Ready", link: "/h5?attention=14"),
        item("remote:7:3", "waiting_user", "Plan the database migration", order: 90, reason: "Pick a date for the cut-over",
             session: session("remote:7", "3", live: nil)),
        item("local:20", "working", "Build the widget API", order: 60, custom: "Blocked", session: session("local", "20", live: true)),
        item("local:21", "working", "Write the route tests", order: 59, parent: "local:20"),
        item("local:22", "working", "Fix the flaky stream test", order: 58, parent: "local:21", result: "Seen twice in CI"),
        item("local:23", "working", "Translate the strings", order: 57, link: "/files?path=strings.json"),
        item("remote:7:8", "working", "Index the server logs", order: 80, custom: "Step 3 of 5", link: "https://logs.example.com/run/8"),
        item("local:30", "todo", "Update the release notes", order: 10, link: "/docs/release-notes", label: "Draft"),
        item("remote:9:2", "todo", "Back up the studio disk", order: 20),
        item("local:1", "done", "Old task", order: 1), item("local:2", "failed", "Broken task", order: 2),
        item("remote:7:1", "cancelled", "Dropped task", order: 3),
    ], engines: [
        EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0),
        EngineInfo(key: "remote:7", name: "K01", local: false, colorIndex: 3),
        EngineInfo(key: "remote:9", name: "Studio", local: false, colorIndex: 5),
    ], failed: ["K02"])
}

/// Part G: the list of the mockup with scheduled and recurring tasks, as an owner with schedules sends it (the clock of the
/// renders and the self-test is scheduleSampleNow in Asia/Taipei). Two engines: this machine (T01) and K01.
let scheduleSampleNow = Date(timeIntervalSince1970: 1_795_161_600)  // 2026-11-20T08:00:00Z, 16:00 in Taipei
func sampleScheduleList() -> ItemList {
    func item(_ key: String, _ status: String, _ title: String, order: Double, custom: String = "", reason: String = "", pending: String = "",
              session: [String: Any]? = nil, timing: [String: Any]? = nil) -> WidgetItem {
        var object: [String: Any] = ["key": key, "status": status, "title": title, "sort_order": order, "custom_status": custom,
                                     "attention_reason": reason, "pending": pending, "notes": "", "session": session ?? NSNull()]
        if let timing = timing { object.merge(timing) { _, new in new } }
        return decodeItem(object)!
    }
    func repeating(_ freq: String, _ time: String, days: [Int] = [], state: String, next: String?, fired: String? = nil, done: String? = nil,
                   then: [String: Any]? = nil, target: [String: Any]? = nil, exit: Int? = nil) -> [String: Any] {
        var rule: [String: Any] = ["freq": freq, "time": time]
        if !days.isEmpty { rule["days"] = days }
        var out: [String: Any] = ["schedule": ["kind": "repeat", "rule": rule, "tz": "Asia/Taipei"], "then_action": then ?? NSNull(),
                                  "schedule_state": state, "next_at": next ?? NSNull(), "runs": 4, "last_fired_at": fired ?? NSNull(),
                                  "last_done_at": done ?? NSNull(), "then_target": target ?? NSNull()]
        if let exit = exit { out["last_exit"] = exit }
        return out
    }
    let prompt: [String: Any] = ["kind": "prompt", "task_id": "12", "terminal_id": "t1", "text": "Run the nightly tests and report failures"]
    let promptTarget: [String: Any] = ["engine": "remote:7", "task_id": "12", "terminal_id": "t1", "name": "ONCALL-CC", "open_path": "/?openTerminal=remote:7:12:t1"]
    let script: [String: Any] = ["kind": "script", "task_id": "5", "script": "./scripts/backup.sh && git push", "timeout_min": 30]
    let scriptTarget: [String: Any] = ["engine": "local", "task_id": "5", "name": "Notes"]
    return ItemList(items: [
        item("local:40", "waiting_user", "Allow Bash", order: 90, pending: "Claude needs your permission",
             session: ["engine": "local", "task_id": "3", "terminal_id": "t2", "agent": "claude", "live": true, "open_path": "/?openTerminal=local:3:t2"]),
        item("remote:7:41", "waiting_user", "Nightly test run", order: 80, reason: "The session was busy at 02:00; the prompt was not sent",
             timing: repeating("daily", "02:00", state: "due", next: "2026-11-20T18:00:00.000Z", fired: "2026-11-19T18:00:00.000Z", then: prompt, target: promptTarget)),
        item("local:49", "waiting_user", "Sync the archive", order: 70, reason: "Script failed (exit 2) at 03:00",
             session: ["engine": "local", "task_id": "5", "terminal_id": "s-49-3", "agent": NSNull(), "live": false, "open_path": "/?openTerminal=local:5:s-49-3"],
             timing: repeating("daily", "03:00", state: "due", next: "2026-11-20T19:00:00.000Z", fired: "2026-11-19T19:00:00.000Z", then: script, target: scriptTarget)),
        item("local:42", "working", "Fix the login page", order: 60, custom: "In testing"),
        item("local:43", "todo", "Weekly review", order: 50,
             timing: repeating("weekly", "09:00", days: [1], state: "due", next: "2026-11-23T01:00:00.000Z", fired: "2026-11-16T01:00:00.000Z")),
        item("local:44", "todo", "Release 2.0", order: 40),
        item("local:45", "todo", "Renew the TLS certificate", order: 30,
             timing: ["schedule": ["kind": "once", "at": "2026-12-01T10:00", "tz": "Asia/Taipei"], "then_action": NSNull(), "schedule_state": "waiting",
                      "next_at": "2026-12-01T02:00:00.000Z", "runs": 0, "last_fired_at": NSNull(), "last_done_at": NSNull()]),
        item("local:46", "todo", "Daily standup notes", order: 20,
             timing: repeating("weekdays", "09:30", state: "waiting", next: "2026-11-21T01:30:00.000Z", fired: "2026-11-20T01:30:00.000Z", done: "2026-11-20T01:41:00.000Z")),
        item("remote:7:47", "todo", "Nightly build check", order: 10,
             timing: repeating("daily", "02:00", state: "waiting", next: "2026-11-20T18:00:00.000Z", fired: "2026-11-19T18:00:00.000Z", then: prompt, target: promptTarget)),
        item("local:48", "todo", "Back up notes", order: 5,
             timing: repeating("daily", "03:00", state: "waiting", next: "2026-11-20T19:00:00.000Z", fired: "2026-11-19T19:00:00.000Z", then: script, target: scriptTarget, exit: 0)),
        item("local:2", "done", "Old task", order: 1),
    ], engines: [
        EngineInfo(key: "local", name: "T01", local: true, colorIndex: 0, schedules: true),
        EngineInfo(key: "remote:7", name: "K01", local: false, colorIndex: 3, schedules: true),
    ], failed: [])
}

/// The notices of the bubble renders: (name, window in the right half, notices).
func sampleNotices() -> [(String, Bool, [WidgetNotice])] {
    func notice(_ seq: Int, _ object: [String: Any]) -> WidgetNotice {
        var full = object
        full["seq"] = seq
        return decodeNotice(full)!
    }
    let item = notice(12, ["kind": "item", "title": "Approve the deploy of the staging build", "status": "waiting_user",
                           "text": "Which environment should it go to?\nStaging is ready; production needs a window.",
                           "from": "T01 \u{00B7} SELF-TAGENT", "key": "local:12", "target": "http://127.0.0.1:3000/h5?attention=12"])
    let direct = notice(13, ["kind": "direct", "title": "Build finished", "text": "All 312 tests passed in 58 s.",
                             "from": "T03 \u{00B7} t-agent", "target": "http://127.0.0.1:3000/"])
    let many = (1...5).map { index in
        notice(20 + index, ["kind": "item", "title": "Review the change \(index)", "status": index == 5 ? "review" : "done",
                            "text": "Ready for your review.", "from": "T0\(index) \u{00B7} SELF-TAGENT", "key": "local:\(30 + index)"])
    }
    return [("item", true, [item]), ("direct", false, [direct]), ("more", true, many)]
}

/// --render-sample DIR: renders the widget and the panel in several states offscreen and exits.
func renderSample(_ dir: String) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let controller = WidgetController(api: WidgetAPI(base: nil, token: nil), parentPID: nil, options: options)
    controller.requestHook = { _, _ in }  // never the network
    controller.moveHook = { _, _, _ in }
    controller.openURL = { _ in }  // never the browser
    controller.announce = { _ in }  // never VoiceOver
    var written: [String] = []
    func save(_ name: String, _ ok: Bool) {
        let path = (dir as NSString).appendingPathComponent(name)
        print((ok ? "wrote " : "FAILED ") + path)
        if ok { written.append(path) }
    }
    for dark in [false, true] {
        let suffix = dark ? "dark" : "light"
        controller.setAppearance(dark: dark)
        controller.loadForTest(sampleList())
        save("widget-\(suffix).png", controller.renderWidget((dir as NSString).appendingPathComponent("widget-\(suffix).png"), dark: dark))
        save("panel-\(suffix).png", controller.renderPanel((dir as NSString).appendingPathComponent("panel-\(suffix).png"), dark: dark))
    }
    // The notice bubble beside the window: a task that needs you (window at the right, bubble on its left), a direct
    // message (window at the left, bubble on its right), and five notices at once (the newest with "+4 more").
    for (name, right, notices) in sampleNotices() {
        for dark in [false, true] {
            let file = "bubble-\(name)-\(dark ? "dark" : "light").png"
            controller.setAppearance(dark: dark)
            controller.loadForTest(sampleList())
            controller.testClearNotices()
            controller.testPlaceWidget(right: right)
            controller.testShowNotices(notices)
            save(file, controller.renderBubbleScene((dir as NSString).appendingPathComponent(file), dark: dark))
        }
    }
    renderPartBSamples(controller, dir: dir, save: save)
    controller.testClearNotices()
    renderPartDSamples(controller, dir, save)  // Part D
    let dark = false
    controller.setAppearance(dark: dark)
    controller.loadForTest(sampleList())
    controller.testDragBegin("local:30", over: DebugDrag(source: "local:30", over: "@working", lowerHalf: false, onHeader: true))
    save("drag-to-working.png", controller.renderPanel((dir as NSString).appendingPathComponent("drag-to-working.png"), dark: dark))
    controller.testDragCancel()
    controller.loadForTest(sampleList())
    controller.testDragBegin("local:23", over: DebugDrag(source: "local:23", over: "local:20", lowerHalf: false))
    save("drag-reorder.png", controller.renderPanel((dir as NSString).appendingPathComponent("drag-reorder.png"), dark: dark))
    controller.testDragCancel()
    controller.loadForTest(sampleList())
    _ = controller.sendMouseDrag(DebugDrag(source: "local:23", over: "remote:7:8", lowerHalf: false))
    save("drag-refused.png", controller.renderPanel((dir as NSString).appendingPathComponent("drag-refused.png"), dark: dark))
    controller.loadForTest(sampleList())
    if let form = controller.testOpenCreate() {
        form.nameField.stringValue = "Review the widget"
        form.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        save("form-create.png", controller.renderPanel((dir as NSString).appendingPathComponent("form-create.png"), dark: dark))
        controller.testClose()
    }
    if controller.testOpenFromRowMenu("local:20", L("Edit")) != nil {
        save("form-edit.png", controller.renderPanel((dir as NSString).appendingPathComponent("form-edit.png"), dark: dark))
        controller.testClose()
    }
    if controller.testOpenFromRowMenu("local:23", L("Delete")) != nil {
        save("delete-confirm.png", controller.renderPanel((dir as NSString).appendingPathComponent("delete-confirm.png"), dark: dark))
        controller.testClose()
    }
    controller.loadForTest(nil)
    save("unreachable-panel.png", controller.renderPanel((dir as NSString).appendingPathComponent("unreachable-panel.png"), dark: dark))
    save("unreachable-widget.png", controller.renderWidget((dir as NSString).appendingPathComponent("unreachable-widget.png"), dark: dark))
    renderActivitySample(controller, dir: dir, save: save)  // Part C
    renderLookSamples(controller, dir: dir, save: save)  // Part F
    renderScheduleSamples(controller, dir: dir, save: save)  // Part G
    exit(controller.testOnScreen || written.isEmpty ? 1 : 0)
}
