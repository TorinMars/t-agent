// T-Attention desktop widget: Part G's --self-test checks and --render-sample images. See main.swift for the overview and the build.
import AppKit

/// What the owner would answer to the form's requests in the renders and checks: the sessions and tasks, and "Next".
func scheduleSampleAnswer(_ request: URLRequest) -> (Data, Int)? {
    let path = request.url?.path ?? ""
    if path.hasSuffix("/targets") {
        let body = """
        {"sessions":[{"task_id":"12","terminal_id":"t1","name":"ONCALL-CC","task_title":"ONCALL","agent":"claude"},
        {"task_id":"3","terminal_id":"t2","name":"Release checks","task_title":"Release","agent":"codex"}],
        "tasks":[{"id":"5","title":"Notes"},{"id":"3","title":"Release"}]}
        """
        return (Data(body.utf8), 200)
    }
    if path.hasSuffix("/schedule/preview") {
        let sent = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["schedule"] as? [String: Any]
        let time = (sent?["rule"] as? [String: Any])?["time"] as? String ?? ""
        let next = ["03:00": "2026-11-20T19:00:00.000Z", "02:00": "2026-11-20T18:00:00.000Z", "09:00": "2026-11-23T01:00:00.000Z",
                    "09:30": "2026-11-21T01:30:00.000Z"][time] ?? "2026-12-01T02:00:00.000Z"
        return (Data("{\"next\":[\"\(next)\"],\"text\":\"Every day at \(time)\"}".utf8), 200)
    }
    return nil
}

/// --render-sample, Part G: the panel with Scheduled and Recurring, the form (Repeats with a prompt and with a script, Every
/// week, Once, scrolled), the four bubbles and the capsule, as widget-sched-*.png.
func renderScheduleSamples(_ controller: WidgetController, dir: String, save: (String, Bool) -> Void) {
    let clock = scheduleClock
    let zone = scheduleZone
    let hook = controller.requestHook
    let clockOfNotices = controller.now
    scheduleClock = { scheduleSampleNow }
    scheduleZone = TimeZone(identifier: "Asia/Taipei")!
    controller.now = { scheduleSampleNow }
    controller.requestHook = { request, answer in
        if let (data, code) = scheduleSampleAnswer(request) { answer(data, code) }
    }
    defer {
        scheduleClock = clock
        scheduleZone = zone
        controller.requestHook = hook
        controller.now = clockOfNotices
    }
    func path(_ name: String) -> String { (dir as NSString).appendingPathComponent(name) }
    controller.testClearNotices()
    for dark in [false, true] {
        let suffix = dark ? "dark" : "light"
        controller.setAppearance(dark: dark)
        controller.loadForTest(sampleScheduleList())
        save("widget-sched-panel-\(suffix).png", controller.renderPanel(path("widget-sched-panel-\(suffix).png"), dark: dark))
        controller.loadForTest(sampleScheduleList(), scroll: 300)
        save("widget-sched-panel-end-\(suffix).png", controller.renderPanel(path("widget-sched-panel-end-\(suffix).png"), dark: dark))
        save("widget-sched-capsule-\(suffix).png", controller.renderWidget(path("widget-sched-capsule-\(suffix).png"), dark: dark))
    }
    let forms: [(String, String, (ScheduleEditorView) -> Void)] = [
        ("prompt", "remote:7:47", { _ in }),
        ("script", "local:48", { _ in }),
        ("weekly", "local:43", { _ in }),
        ("once", "local:45", { _ in }),
        ("new-prompt", "local:44", { editor in
            editor.testChoose(when: 2)
            editor.testChoose(then: "prompt")
            editor.promptField.stringValue = "Summarise what changed today"
            editor.update()
        }),
    ]
    for dark in [true, false] {
        let suffix = dark ? "dark" : "light"
        controller.setAppearance(dark: dark)
        for (name, key, change) in forms where dark || name == "weekly" {
            controller.loadForTest(sampleScheduleList())
            guard let form = controller.testOpenFromRowMenu(key, L("Edit")) as? TaskFormView, let editor = form.scheduleEditor else {
                save("widget-sched-form-\(name)-\(suffix).png", false)
                continue
            }
            change(editor)
            form.layoutSubtreeIfNeeded()
            save("widget-sched-form-\(name)-\(suffix).png", controller.renderPanel(path("widget-sched-form-\(name)-\(suffix).png"), dark: dark))
            if name == "script" && dark {
                form.formScroll.contentView.scroll(to: NSPoint(x: 0, y: 240))
                form.formScroll.reflectScrolledClipView(form.formScroll.contentView)
                save("widget-sched-form-scrolled-dark.png", controller.renderPanel(path("widget-sched-form-scrolled-dark.png"), dark: dark))
                form.showError(L("Save failed: {1}", "Only a person can set or change a script (from the page or a CLI token made in Settings)"))
                save("widget-sched-form-refused-dark.png", controller.renderPanel(path("widget-sched-form-refused-dark.png"), dark: dark))
            }
            controller.testClose()
        }
    }
    let list = sampleScheduleList()
    let bubbles: [(String, String, String)] = [("time", "scheduled", "local:43"), ("sent", "prompt_sent", "remote:7:47"),
                                               ("notsent", "prompt_failed", "remote:7:41"), ("script", "script_failed", "local:49")]
    for dark in [true, false] {
        let suffix = dark ? "dark" : "light"
        controller.setAppearance(dark: dark)
        for (name, kind, key) in bubbles where dark || name == "time" {
            controller.loadForTest(list)
            controller.testClearNotices()
            controller.testPlaceWidget(right: true)
            guard let item = list.items.first(where: { $0.key == key }) else { continue }
            controller.testShowNotices([firingNotice(kind, item, engine: key.hasPrefix("remote:") ? "K01" : "T01")])
            save("widget-sched-bubble-\(name)-\(suffix).png", controller.renderBubbleScene(path("widget-sched-bubble-\(name)-\(suffix).png"), dark: dark))
        }
    }
    controller.testClearNotices()
    controller.setAppearance(dark: false)
    controller.loadForTest(list)
    for key in ["remote:7:41", "local:49", "local:43", "local:45", "local:46", "remote:7:47", "local:48"] {
        print("schedule row height \(key): \(controller.testRowHeight(key))")
    }
}

/// --self-test, Part G.
func runScheduleSelfTest(_ check: (String, Bool) -> Void) {
    let clock = scheduleClock
    let zone = scheduleZone
    scheduleClock = { scheduleSampleNow }
    scheduleZone = TimeZone(identifier: "Asia/Taipei")!
    defer {
        scheduleClock = clock
        scheduleZone = zone
    }
    stringTable = [:]
    let list = sampleScheduleList()
    func item(_ key: String) -> WidgetItem { list.items.first { $0.key == key }! }

    // Decoding.
    check("schedule: an owner without schedules sends none", decodeItem(["key": "local:1"])?.timing == ItemTiming()
          && decodeItem(["key": "local:1", "schedule": NSNull()])?.timing.present == true)
    let weekly = item("local:43").timing
    check("schedule: the fields are read", weekly.schedule == ItemSchedule(kind: "repeat", rule: ScheduleRule(freq: "weekly", days: [1], time: "09:00"), tz: "Asia/Taipei")
          && weekly.state == "due" && weekly.runs == 4 && weekly.lastFired == "2026-11-16T01:00:00.000Z" && weekly.due && !weekly.waiting)
    check("schedule: a JSON string, a prompt and a script", decodeSchedule("{\"kind\":\"once\",\"at\":\"2026-12-01T10:00\"}")?.at == "2026-12-01T10:00"
          && item("remote:7:41").timing.then == ThenAction(kind: "prompt", taskId: "12", terminalId: "t1", text: "Run the nightly tests and report failures")
          && item("local:48").timing.then == ThenAction(kind: "script", taskId: "5", script: "./scripts/backup.sh && git push", timeoutMin: 30)
          && item("local:48").timing.target?.name == "Notes" && item("local:48").timing.lastExit == 0)
    check("schedule: anything else is none or remind", decodeSchedule(["kind": "sometimes"]) == nil && decodeThen(["kind": "prompt", "task_id": "1"]) == ThenAction()
          && decodeThen("nonsense") == ThenAction() && decodeItem(["key": "local:1", "schedule": [:], "schedule_state": "later"])?.timing.state == "")
    check("schedule: the body values", ItemSchedule(kind: "repeat", rule: ScheduleRule(freq: "every", interval: 3, time: "07:00"), starts: "2026-11-20",
                                                     ends: ScheduleEnds(kind: "after", count: 5)).json as NSDictionary
          == ["kind": "repeat", "rule": ["freq": "every", "interval": 3, "time": "07:00"], "starts": "2026-11-20", "ends": ["kind": "after", "count": 5]] as NSDictionary
          && ItemSchedule(kind: "once", at: "2026-12-01T10:00").json as NSDictionary == ["kind": "once", "at": "2026-12-01T10:00"] as NSDictionary
          && ThenAction().json == nil)

    // Sections and counts.
    let summary = summarize(list)
    func keys(_ rows: [Row]) -> [String] { rows.map { $0.key } }
    check("sections: Scheduled holds the waiting once task", keys(summary.scheduled) == ["local:45"])
    check("sections: Recurring the waiting repeats, soonest first", keys(summary.recurring) == ["remote:7:47", "local:48", "local:46"])
    check("sections: a due task stays in its status section", keys(summary.todo) == ["local:43", "local:44"]
          && keys(summary.needs) == ["local:40", "local:49", "remote:7:41"])
    check("counts: waiting tasks are not counted", summary.unfinished == 6)
    check("sections: nothing is dropped into Scheduled or Recurring", statusForDrop(item("local:44"), into: .scheduled) == nil
          && statusForDrop(item("local:44"), into: .recurring) == nil && sectionColor(.scheduled) == .systemBlue && sectionColor(.recurring) == .systemPurple)

    // Words.
    let now = scheduleSampleNow
    check("words: the rules", ruleWords(ScheduleRule(freq: "weekly", days: [1])) == "Every Monday" && ruleWords(ScheduleRule(freq: "weekly", days: [4, 1])) == "Every Mon, Thu"
          && ruleWords(ScheduleRule(freq: "weekly", days: [1, 2, 3, 4, 5])) == "Weekdays" && ruleWords(ScheduleRule(freq: "monthly", day: 15)) == "Monthly on day 15"
          && ruleWords(ScheduleRule(freq: "every", interval: 3)) == "Every 3 days" && ruleWords(ScheduleRule(freq: "every", interval: 1)) == "Every day")
    let tomorrow = Date(timeIntervalSince1970: 1_795_161_600 + 16 * 3600)
    check("words: moments in this Mac's time", momentText(tomorrow, now: now) == "tomorrow 08:00" && momentText(now, now: now) == "today 16:00"
          && momentText(now, now: now, today: false) == "16:00" && momentText(activityTime("2026-12-01T02:00:00Z")!, now: now) == "Tue 12-01 10:00"
          && momentText(activityTime("2026-11-19T10:00:00Z")!, now: now) == "yesterday 18:00")
    check("words: the row lines", scheduleLine(item("local:45"), now: now) == "Once \u{00B7} Tue 12-01 10:00"
          && scheduleLine(item("local:46"), now: now) == "Weekdays 09:30 \u{00B7} next tomorrow \u{00B7} done 09:41"
          && scheduleLine(item("local:43"), now: now) == "Every Monday 09:00 \u{00B7} due now"
          && scheduleLine(item("remote:7:47"), now: now) == "Every day 02:00 \u{00B7} next tomorrow \u{00B7} prompt to ONCALL-CC"
          && scheduleLine(item("local:48"), now: now) == "Every day 03:00 \u{00B7} next tomorrow \u{00B7} script in Notes \u{00B7} exit 0"
          && scheduleLine(item("local:49"), now: now).hasSuffix("script in Notes \u{00B7} exit 2") && scheduleLine(item("local:44"), now: now) == "")
    check("words: the marks", rowMark(item("local:45")) == .once && rowMark(item("local:46")) == .repeating && rowMark(item("remote:7:47")) == .prompt
          && rowMark(item("local:48")) == .script && rowMark(item("local:44")) == .none
          && [RowMark.once, .repeating, .prompt, .script].allSatisfy { rowMarkImage($0) != nil })

    // The panel.
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let window = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:3999", token: "t"), parentPID: nil, options: options)
    var sent: [URLRequest] = []
    var pending: [(URLRequest, (Data?, Int) -> Void)] = []
    var opened: [String] = []
    var autoAnswer = true
    window.requestHook = { request, answer in
        sent.append(request)
        if autoAnswer, let (data, code) = scheduleSampleAnswer(request) { answer(data, code) } else { pending.append((request, answer)) }
    }
    window.openURL = { opened.append($0.absoluteString) }
    window.activateBrowser = {}
    window.announce = { _ in }
    window.alwaysShowRowActions = { false }
    var clockNow = scheduleSampleNow
    window.now = { clockNow }
    func body(_ request: URLRequest) -> String { request.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? "" }
    func calls(_ method: String) -> [String] { sent.filter { $0.httpMethod == method }.map { ($0.url?.path ?? "") + " " + body($0) } }
    func answerLast(_ text: String, _ code: Int = 200) {
        guard !pending.isEmpty else { return }
        pending.removeLast().1(Data(text.utf8), code)
    }
    window.loadForTest(list)
    let lines = window.testLines
    check("panel: Scheduled and Recurring after To do, before Finished", {
        guard let todo = lines.firstIndex(of: "To do"), let scheduled = lines.firstIndex(of: "Scheduled"), let recurring = lines.firstIndex(of: "Recurring"),
              let finished = lines.firstIndex(of: "Finished") else { return false }
        return todo < scheduled && scheduled < recurring && recurring < finished
    }())
    check("panel: blue and purple dots with the counts", window.testSectionHeader(.scheduled)?.dot.color == .systemBlue
          && window.testSectionHeader(.recurring)?.dot.color == .systemPurple && window.testSectionHeader(.recurring)?.countField.stringValue == "3")
    window.loadForTest(ItemList(items: list.items.filter { !$0.timing.waiting }, engines: list.engines, failed: []))
    check("panel: no empty Scheduled or Recurring header", !window.testLines.contains("Scheduled") && !window.testLines.contains("Recurring"))
    window.loadForTest(list)
    check("panel: the capsule counts as before", window.testCount == "6" && window.testBadge == "3")
    check("rows: the rule and next time on the second line", window.testSecondLine("local:46")?.stringValue == "Weekdays 09:30 \u{00B7} next tomorrow \u{00B7} done 09:41"
          && window.testSecondLine("local:43")?.stringValue == "Every Monday 09:00 \u{00B7} due now")
    check("rows: Needs you shows why first", window.testSecondLine("remote:7:41")?.stringValue == "The session was busy at 02:00; the prompt was not sent")
    check("rows: the symbol before the title, the title intact", {
        guard let line = window.testRowView("local:43")?.subviews.first(where: { $0 is NSStackView }) as? NSStackView else { return false }
        return line.arrangedSubviews.first is NSImageView && window.testTitleField("local:43")?.stringValue == "Weekly review"
            && (window.testRowView("local:44")?.subviews.first { $0 is NSStackView } as? NSStackView)?.arrangedSubviews.first is NSTextField
    }())
    func all(_ key: String) -> [RowAction] { window.testRowView(key)?.actionButtons.map { $0.rowAction } ?? [] }
    check("rows: a busy prompt has Send now (paperplane, accent), always shown", all("remote:7:41") == [.session, .sendNow, .handled]
          && window.testButton("remote:7:41", .sendNow)?.isHidden == false && RowAction.sendNow.symbolName == "paperplane" && RowAction.sendNow.isPrimary)
    check("rows: a failed script has Open terminal and Run again", all("local:49") == [.terminal, .runAgain, .handled]
          && window.testButton("local:49", .terminal)?.label == "Open terminal")
    check("rows: a waiting prompt opens its session", all("remote:7:47") == [.session])
    check("menu: Send now, Open terminal and Run again", window.testMenuTitles("remote:7:41") == ["Details", "Open session", "Send now", "Handled", "Edit", "Delete", "Quit"]
          && window.testMenuTitles("local:49") == ["Details", "Open terminal", "Run again", "Handled", "Edit", "Delete", "Quit"])
    check("VoiceOver: the custom actions", window.testRowView("remote:7:41")?.accessibilityCustomActions()?.map { $0.name } == ["Open session", "Send now", "Handled", "Open details"])
    sent = []
    _ = window.testPressButton("remote:7:41", .sendNow)
    check("Send now posts run-now", calls("POST") == ["/api/attention/widget/items/remote:7:41/run-now {}"])
    sent = []
    _ = window.testOpenFromRowMenu("local:49", "Run again")
    check("Run again posts run-now", calls("POST") == ["/api/attention/widget/items/local:49/run-now {}"])
    window.loadForTest(list)
    sent = []
    _ = window.testPressButton("remote:7:41", .session)
    check("the prompt's session opens through open-terminal", calls("POST") == ["/api/attention/widget/open-terminal {\"engine\":\"remote:7\",\"task_id\":\"12\",\"terminal_id\":\"t1\"}"])
    window.testRowView("local:46").map { _ in window.rowPressed("local:46") }
    window.rowDragBegan("local:46")
    check("drag: a waiting row does not move", !window.rowDragActive)
    window.cancelRowDrag()

    // Bubbles of a firing. The row actions above are answered first, so their rows take presses again.
    while let waiting = pending.popLast() { waiting.1(Data("{}".utf8), 200) }
    func with(_ key: String, _ change: (inout WidgetItem) -> Void) -> ItemList {
        var next = list
        if let index = next.items.firstIndex(where: { $0.key == key }) { change(&next.items[index]) }
        return next
    }
    check("firings: the first list counts only a firing of the last minute", firingNotices(previous: nil, items: list.items, engines: list.engines, now: now).isEmpty
          && firingNotices(previous: nil, items: with("local:46") { $0.timing.lastFired = "2026-11-20T07:59:30.000Z" }.items, engines: list.engines, now: now).map { $0.key } == ["local:46"])
    let seen = Dictionary(uniqueKeysWithValues: list.items.map { ($0.key, $0.timing.lastFired) })
    check("firings: nothing new, nothing shown", firingNotices(previous: seen, items: list.items, engines: list.engines, now: now).isEmpty)
    let remind = firingNotices(previous: seen, items: with("local:43") { $0.timing.lastFired = "2026-11-23T01:00:00.000Z" }.items, engines: list.engines, now: now)
    check("firings: a reminder is \"It is time\"", remind.map { $0.kind } == ["scheduled"] && remind.first?.title == "It is time \u{00B7} T01"
          && remind.first?.text == "Weekly review \u{00B7} Every Monday 09:00" && remind.first?.seconds == 0 && noticeTone(remind[0]) == "blue")
    let sentPrompt = firingNotices(previous: seen, items: with("remote:7:47") { $0.timing.lastFired = "2026-11-20T18:00:00.000Z" }.items, engines: list.engines, now: now)
    check("firings: a prompt sent", sentPrompt.map { $0.kind } == ["prompt_sent"] && sentPrompt.first?.text == "Nightly build check \u{2192} ONCALL-CC"
          && sentPrompt.first?.title == "Prompt sent \u{00B7} K01" && sentPrompt.first?.seconds == noticeDefaultSeconds)
    let busy = firingNotices(previous: seen, items: with("remote:7:41") { $0.timing.lastFired = "2026-11-20T18:00:00.000Z" }.items, engines: list.engines, now: now)
    check("firings: a prompt the busy session did not take", busy.map { $0.kind } == ["prompt_failed"]
          && busy.first?.text == "Nightly test run\nThe session was busy at 02:00; the prompt was not sent" && noticeTone(busy[0]) == "orange")
    let scriptOK = firingNotices(previous: seen, items: with("local:48") { $0.timing.lastFired = "2026-11-20T19:00:00.000Z" }.items, engines: list.engines, now: now)
    let scriptBad = firingNotices(previous: seen, items: with("local:49") { $0.timing.lastFired = "2026-11-20T19:00:00.000Z" }.items, engines: list.engines, now: now)
    check("firings: a script that ended well makes none, a failed one \"Script failed\"", scriptOK.isEmpty && scriptBad.map { $0.kind } == ["script_failed"]
          && scriptBad.first?.title == "Script failed \u{00B7} T01" && noticeTone(scriptBad[0]) == "red")
    let single = firingNotices(previous: seen, items: with("local:43") { $0.timing.lastFired = "x" }.items, engines: [list.engines[0]], now: now)
    check("firings: one engine, no engine in the title", single.first?.title == "It is time")

    window.testClearNotices()
    window.loadForTest(nil)
    window.testFirings(list)
    check("controller: the first list shows no old firing", window.testShownNotice == nil)
    clockNow = scheduleSampleNow.addingTimeInterval(60)
    window.testFirings(with("local:43") { $0.timing.lastFired = "2026-11-20T08:00:30.000Z" })
    check("controller: a new firing shows its bubble with Open and Done", window.testShownNotice?.kind == "scheduled" && window.testBubbleActions == ["Open", "Done"])
    window.testShowNotices([decodeNotice(["seq": 9, "kind": "item", "title": "Weekly review", "status": "todo", "key": "local:43"])!])
    check("controller: the server's notice of the same task is dropped", window.testShownNotice?.kind == "scheduled" && window.testWaitingNotices.isEmpty)
    sent = []
    _ = window.testBubbleAction(.done)
    check("bubble: Done marks the task done", calls("PATCH") == ["/api/attention/widget/items/local:43 {\"status\":\"done\"}"] && window.testShownNotice == nil)
    clockNow = scheduleSampleNow.addingTimeInterval(400)
    window.testShowNotices([decodeNotice(["seq": 10, "kind": "item", "title": "Needs you", "status": "waiting_user", "key": "remote:7:41"])!])
    window.testFirings(with("remote:7:41") { $0.timing.lastFired = "2026-11-20T18:00:00.000Z" })
    check("controller: a shown server notice of the task gives way", window.testShownNotice?.kind == "prompt_failed" && window.testBubbleActions == ["Open session", "Send now"])
    sent = []
    _ = window.testBubbleAction(.sendNow)
    check("bubble: Send now posts run-now", calls("POST") == ["/api/attention/widget/items/remote:7:41/run-now {}"])
    window.testClearNotices()
    window.loadForTest(list)
    window.testShowNotices([firingNotice("script_failed", item("local:49"), engine: "T01")])
    check("bubble: Script failed has Open terminal and Run again", window.testBubbleActions == ["Open terminal", "Run again"])
    sent = []
    _ = window.testBubbleAction(.terminal)
    check("bubble: Open terminal opens the script's terminal", calls("POST") == ["/api/attention/widget/open-terminal {\"engine\":\"local\",\"task_id\":\"5\",\"terminal_id\":\"s-49-3\"}"])
    window.testShowNotices([firingNotice("prompt_sent", item("remote:7:47"), engine: "K01")])
    check("bubble: Prompt sent has Open session", window.testBubbleActions == ["Open session"])
    window.testShowNotices([firingNotice("scheduled", item("local:45"), engine: nil)])
    window.testClearNotices()
    window.testShowNotices([firingNotice("scheduled", item("local:45"), engine: nil)])
    opened = []
    sent = []
    _ = window.testBubbleAction(.open)
    check("bubble: Open opens the task's details, like a click on the bubble", calls("POST") == ["/api/attention/widget/open-item {\"key\":\"local:45\"}"]
          && opened.isEmpty)
    window.testClearNotices()

    // The form.
    window.loadForTest(list)
    sent = []
    guard let form = window.testOpenFromRowMenu("local:46", "Edit") as? TaskFormView, let editor = form.scheduleEditor else {
        check("form: When and Then for an engine with schedules", false)
        return
    }
    check("form: When and Then for an engine with schedules", editor.engine == "local" && editor.testShown == ["repeat", "then", "next"])
    check("form: it asks for the sessions and tasks and for Next", sent.contains { $0.url?.absoluteString == "http://127.0.0.1:3999/api/attention/widget/targets?engine=local" }
          && calls("POST").contains { $0.hasPrefix("/api/attention/widget/schedule/preview {\"engine\":\"local\",\"schedule\":{\"kind\":\"repeat\"") })
    check("form: Next from the owner", editor.nextLabel.stringValue == "Next: tomorrow 09:30 \u{00B7} then weekdays")
    check("form: the controls echo the schedule", editor.schedule == item("local:46").timing.schedule && editor.fields(changedFrom: item("local:46").timing).isEmpty
          && editor.rulePopup.titleOfSelectedItem == "Weekdays" && wallTime(editor.ruleTime.dateValue) == "09:30")
    check("form: the pop-ups are filled", editor.sessions.count == 2 && editor.tasks.count == 2 && editor.taskPopup.itemTitles == ["In task: Notes", "In task: Release"])
    editor.testChoose(freq: "weekly")
    check("form: Every week shows the day buttons", editor.testShown.contains("weekly") && editor.dayButtons.filter { $0.isOn }.map { $0.day } == [5])
    editor.dayButtons.forEach { $0.isOn = false }
    editor.update()
    check("form: no day cannot be saved", editor.problem == "Pick at least one day" && editor.nextLabel.stringValue == "Pick at least one day")
    editor.dayButtons[0].isOn = true
    editor.dayButtons[3].isOn = true
    editor.testChoose(ends: "after")
    editor.endsCount.stringValue = "8"
    editor.testChoose(then: "prompt")
    check("form: Ends after and the prompt part", editor.testShown.contains("ends after") && editor.testShown.contains("prompt") && !editor.testShown.contains("script"))
    editor.testSelect(session: "12:t1")
    check("form: a prompt needs its text", editor.problem == "Write the prompt")
    editor.promptField.stringValue = "Write the standup notes"
    let changed = editor.fields(changedFrom: item("local:46").timing)
    check("form: only what changed is saved", (changed["schedule"] as? [String: Any]).map { NSDictionary(dictionary: $0) }
          == ["kind": "repeat", "rule": ["freq": "weekly", "days": [1, 4], "time": "09:30"], "ends": ["kind": "after", "count": 8], "tz": "Asia/Taipei"] as NSDictionary
          && (changed["then_action"] as? [String: Any]).map { NSDictionary(dictionary: $0) }
          == ["kind": "prompt", "task_id": "12", "terminal_id": "t1", "text": "Write the standup notes"] as NSDictionary)
    autoAnswer = false
    sent = []
    form.onSubmit()
    check("form: Save sends the PATCH with the schedule", calls("PATCH").first?.hasPrefix("/api/attention/widget/items/local:46 {") == true
          && calls("PATCH").first?.contains("\"then_action\":{\"kind\":\"prompt\"") == true)
    answerLast("{\"error\":\"SCRIPT_NEEDS_PERSON\",\"message\":\"Only a person can set or change a script\"}", 403)
    check("form: a refusal shows in the form", !form.errorField.isHidden && form.errorField.stringValue == "Save failed: Only a person can set or change a script"
          && window.testOverlay === form)
    autoAnswer = true
    editor.testChoose(then: "script")
    editor.testSelect(task: "5")
    editor.scriptField.stringValue = String(repeating: "echo one\n", count: 3)
    check("form: Run a script with its task", editor.then == ThenAction(kind: "script", taskId: "5", script: "echo one\necho one\necho one", timeoutMin: 30)
          && editor.testShown.contains("script"))
    check("form: Return in the script is a new line", editor.control(editor.scriptField, textView: NSTextView(), doCommandBy: #selector(NSResponder.insertNewline(_:))))
    window.positionDetail()
    check("form: the panel stays at most 440 pt and the form scrolls", window.testDetailFrame.height <= detailMaxHeight
          && form.preferredHeight > window.testDetailFrame.height && form.formScroll.documentView!.frame.height > form.formScroll.frame.height)
    editor.testChoose(when: 0)
    check("form: No date hides When's parts and Then, and clears the schedule", !["once", "repeat", "then", "next"].contains { editor.testShown.contains($0) }
          && (editor.fields(changedFrom: item("local:46").timing)["schedule"] is NSNull))
    window.testClose()

    if let once = window.testOpenFromRowMenu("local:45", "Edit") as? TaskFormView, let onceEditor = once.scheduleEditor {
        check("form: Once shows the date and time", onceEditor.testShown.contains("once") && wallDay(onceEditor.onceDate.dateValue) == "2026-12-01"
              && wallTime(onceEditor.onceTime.dateValue) == "10:00" && onceEditor.fields(changedFrom: item("local:45").timing).isEmpty)
        window.testClose()
    } else {
        check("form: Once shows the date and time", false)
    }
    if let script = window.testOpenFromRowMenu("local:48", "Edit") as? TaskFormView, let scriptEditor = script.scheduleEditor {
        check("form: a script task echoes its task and script", scriptEditor.thenKind == "script" && scriptEditor.taskPopup.titleOfSelectedItem == "In task: Notes"
              && scriptEditor.scriptField.stringValue == "./scripts/backup.sh && git push" && scriptEditor.fields(changedFrom: item("local:48").timing).isEmpty)
        window.testClose()
    } else {
        check("form: a script task echoes its task and script", false)
    }
    // A new task on this machine with schedules gets When; without them (an older server) it does not.
    if let create = window.testOpenCreate() {
        let editor = create.scheduleEditor
        editor?.testChoose(when: 1)
        check("form: the new task form has When and saves the schedule", editor != nil
              && (editor?.fields(changedFrom: nil)["schedule"] as? [String: Any])?["at"] as? String == "2026-11-21T09:00"
              && editor?.fields(changedFrom: nil)["then_action"] is NSNull)
        window.testClose()
    }
    window.loadForTest(sampleList())
    check("form: no When for an engine without schedules", window.testOpenCreate()?.scheduleEditor == nil)
    window.testClose()
    check("part G: no window was put on screen", !window.testOnScreen)
}
