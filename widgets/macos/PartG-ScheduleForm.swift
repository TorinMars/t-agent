// T-Attention desktop widget: Part G, the "When" and "Then" of the task form. See main.swift for the overview and the build.
import AppKit

// MARK: - Part G: When and Then
//
// Native controls in the panel's material (AGENTS.md, "Native macOS parts"): a segmented control No date / Once / Repeats;
// Once: a date and a time field; Repeats: a pop-up for the rule and the time, day buttons for Every week, the day for Every
// month, N for Every N days, Starts and Ends (Never / On a date / After N times); a "Next: ..." line from the owner's preview.
// Then: radio buttons Remind me / Send a prompt to a session (a pop-up of the owner engine's sessions and a multi-line
// prompt) / Run a script (a pop-up of its tasks and a monospaced multi-line script). The wall times are the owner's: the
// fields edit them as they are (in UTC, so no zone of this Mac is applied).

let wallCalendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
}()

/// A wall date and time ("2026-12-01", "10:00") as a Date of the fields (UTC); nil when it is not one.
func wallDate(_ day: String, _ time: String = "00:00") -> Date? {
    let d = day.split(separator: "-").compactMap { Int($0) }
    let t = time.split(separator: ":").compactMap { Int($0) }
    guard d.count == 3, t.count == 2 else { return nil }
    return wallCalendar.date(from: DateComponents(year: d[0], month: d[1], day: d[2], hour: t[0], minute: t[1]))
}

func wallDay(_ date: Date) -> String {
    let parts = wallCalendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 2000, parts.month ?? 1, parts.day ?? 1)
}

func wallTime(_ date: Date) -> String {
    let parts = wallCalendar.dateComponents([.hour, .minute], from: date)
    return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
}

/// Today on this Mac's clock as a wall day.
func wallToday(_ now: Date) -> String {
    let parts = scheduleCalendar().dateComponents([.year, .month, .day], from: now)
    return String(format: "%04d-%02d-%02d", parts.year ?? 2000, parts.month ?? 1, parts.day ?? 1)
}

/// The first letter in lower case when it is a Latin capital ("Every day" -> "every day"); other scripts stay as they are.
func lowerFirst(_ text: String) -> String {
    guard let first = text.unicodeScalars.first, ("A"..."Z").contains(first) else { return text }
    return text.prefix(1).lowercased() + text.dropFirst()
}

/// A day of the week for Every week: drawn by itself (accent fill when chosen) so it reads in a panel that is not key.
final class DayToggle: NSButton {
    let day: Int
    var isOn = false { didSet { needsDisplay = true; setAccessibilityValue(isOn) } }

    init(day: Int) {
        self.day = day
        super.init(frame: .zero)
        title = L(weekdayShort[day - 1])
        isBordered = false
        refusesFirstResponder = true
        focusRingType = .none
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 36).isActive = true
        heightAnchor.constraint(equalToConstant: 22).isActive = true
        setAccessibilityRole(.checkBox)
        setAccessibilityLabel(L(weekdayLong[day - 1]))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        (isOn ? NSColor.controlAccentColor : NSColor.labelColor.withAlphaComponent(0.1)).setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 5, yRadius: 5).fill()
        let text = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: isOn ? NSColor.white : NSColor.labelColor,
        ])
        let size = text.size()
        text.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }
}

final class ScheduleEditorView: NSView, NSTextFieldDelegate {
    let engine: String
    let original: ItemTiming
    let width = detailWidth - detailPadding * 2
    var onChange: () -> Void = {}
    var onResize: () -> Void = {}

    let whenControl = NSSegmentedControl(labels: [L("No date"), L("Once"), L("Repeats")], trackingMode: .selectOne, target: nil, action: nil)
    let onceDate = ScheduleEditorView.picker(.yearMonthDay)
    let onceTime = ScheduleEditorView.picker(.hourMinute)
    let rulePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let ruleTime = ScheduleEditorView.picker(.hourMinute)
    let dayButtons = (1...7).map { DayToggle(day: $0) }
    let monthDayField = NSTextField(string: "1")
    let everyField = NSTextField(string: "2")
    let startsPicker = ScheduleEditorView.picker(.yearMonthDay)
    let endsPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let endsDate = ScheduleEditorView.picker(.yearMonthDay)
    let endsCount = NSTextField(string: "10")
    let nextLabel = NSTextField(wrappingLabelWithString: "")
    let remindRadio = NSButton(radioButtonWithTitle: L("Remind me"), target: nil, action: nil)
    let promptRadio = NSButton(radioButtonWithTitle: L("Send a prompt to a session"), target: nil, action: nil)
    let scriptRadio = NSButton(radioButtonWithTitle: L("Run a script"), target: nil, action: nil)
    let sessionPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let promptField = NSTextField(string: "")
    let taskPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let scriptField = NSTextField(string: "")
    private(set) var sessions: [TargetSession] = []
    private(set) var tasks: [TargetTask] = []
    private var startsTouched = false

    // The parts shown or hidden by the choices.
    private let column = NSStackView()
    private var onceRow = NSView()
    private var repeatBox = NSStackView()
    private var weeklyRow = NSView()
    private var monthlyRow = NSView()
    private var everyRow = NSView()
    private var endsDateRow = NSView()
    private var endsCountRow = NSView()
    private var thenBox = NSStackView()
    private var promptBox = NSStackView()
    private var scriptBox = NSStackView()

    static let freqs = ["daily", "weekdays", "weekly", "monthly", "every"]
    static let freqLabels = [S("Every day"), S("Weekdays"), S("Every week"), S("Every month"), S("Every N days")]
    static let endKinds = ["never", "on", "after"]
    static let endLabels = [S("Never"), S("On a date"), S("After N times")]

    static func picker(_ elements: NSDatePicker.ElementFlags) -> NSDatePicker {
        let picker = NSDatePicker()
        picker.datePickerStyle = .textField
        picker.datePickerElements = elements
        picker.calendar = wallCalendar
        picker.timeZone = wallCalendar.timeZone
        picker.locale = Locale(identifier: "sv_SE")  // 2026-11-20 and a 24-hour clock, the form of the schedule, in every language
        picker.font = .systemFont(ofSize: 12)
        picker.isBezeled = true
        picker.drawsBackground = true
        picker.translatesAutoresizingMaskIntoConstraints = false
        picker.widthAnchor.constraint(equalToConstant: elements == .hourMinute ? 64 : 96).isActive = true
        return picker
    }

    init(engine: String, timing: ItemTiming, now: Date) {
        self.engine = engine
        self.original = timing
        super.init(frame: NSRect(x: 0, y: 0, width: detailWidth - detailPadding * 2, height: 100))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: width).isActive = true
        build()
        load(timing, now: now)
        update(notify: false)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func hstack(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = spacing
        return row
    }

    private func numberField(_ field: NSTextField, label: String) {
        field.font = .systemFont(ofSize: 12)
        field.alignment = .right
        field.delegate = self
        field.setAccessibilityLabel(label)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: 52).isActive = true
    }

    private func multiLine(_ field: NSTextField, label: String, mono: Bool) {
        field.font = mono ? .monospacedSystemFont(ofSize: 11, weight: .regular) : .systemFont(ofSize: 12)
        field.usesSingleLineMode = false
        field.lineBreakMode = .byWordWrapping
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        field.delegate = self
        field.setAccessibilityLabel(label)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: width).isActive = true
        field.heightAnchor.constraint(equalToConstant: 48).isActive = true
    }

    private func popup(_ button: NSPopUpButton, width: CGFloat, label: String) {
        button.font = .systemFont(ofSize: 12)
        button.target = self
        button.action = #selector(controlChanged)
        button.setAccessibilityLabel(label)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: width).isActive = true
    }

    private func build() {
        whenControl.target = self
        whenControl.action = #selector(controlChanged)
        whenControl.setAccessibilityLabel(L("When"))
        whenControl.translatesAutoresizingMaskIntoConstraints = false
        whenControl.widthAnchor.constraint(equalToConstant: width).isActive = true
        for (index, _) in ScheduleEditorView.freqs.enumerated() { rulePopup.addItem(withTitle: L(ScheduleEditorView.freqLabels[index])) }
        popup(rulePopup, width: width - 64 - 8, label: L("Repeats"))
        for label in ScheduleEditorView.endLabels { endsPopup.addItem(withTitle: L(label)) }
        popup(endsPopup, width: 112, label: L("Ends"))
        popup(sessionPopup, width: width, label: L("Session"))
        popup(taskPopup, width: width, label: L("Task"))
        for picker in [onceDate, onceTime, ruleTime, startsPicker, endsDate] {
            picker.target = self
            picker.action = #selector(controlChanged)
        }
        startsPicker.action = #selector(startsChanged)
        onceDate.setAccessibilityLabel(L("Date"))
        onceTime.setAccessibilityLabel(L("Time"))
        ruleTime.setAccessibilityLabel(L("Time"))
        startsPicker.setAccessibilityLabel(L("Starts"))
        endsDate.setAccessibilityLabel(L("Ends"))
        for button in dayButtons {
            button.target = self
            button.action = #selector(dayClicked(_:))
        }
        numberField(monthDayField, label: L("Day of the month"))
        numberField(everyField, label: L("Every N days"))
        numberField(endsCount, label: L("After N times"))
        multiLine(promptField, label: L("Prompt"), mono: false)
        multiLine(scriptField, label: L("Script"), mono: true)
        promptField.placeholderString = L("Prompt")
        scriptField.placeholderString = L("Script")
        for radio in [remindRadio, promptRadio, scriptRadio] {
            radio.font = .systemFont(ofSize: 12)
            radio.target = self
            radio.action = #selector(radioClicked(_:))
        }
        nextLabel.font = .systemFont(ofSize: 11)
        nextLabel.textColor = .controlAccentColor
        nextLabel.maximumNumberOfLines = 2
        nextLabel.preferredMaxLayoutWidth = width
        nextLabel.translatesAutoresizingMaskIntoConstraints = false
        nextLabel.widthAnchor.constraint(equalToConstant: width).isActive = true

        onceRow = hstack([onceDate, onceTime])
        weeklyRow = hstack(dayButtons, spacing: 4)
        monthlyRow = hstack([makeCaption(L("Day of the month")), monthDayField])
        everyRow = hstack([makeCaption(L("Every N days")), everyField])
        endsDateRow = hstack([makeCaption(L("Ends on")), endsDate])
        endsCountRow = hstack([makeCaption(L("Times")), endsCount])
        let startsCaption = makeCaption(L("Starts"))
        let endsCaption = makeCaption(L("Ends"))
        for caption in [startsCaption, endsCaption] { caption.setContentCompressionResistancePriority(.required, for: .horizontal) }
        let endsRow = hstack([startsCaption, startsPicker, endsCaption, endsPopup], spacing: 6)
        repeatBox = NSStackView(views: [hstack([rulePopup, ruleTime]), weeklyRow, monthlyRow, everyRow, endsRow, endsDateRow, endsCountRow])
        repeatBox.orientation = .vertical
        repeatBox.alignment = .leading
        repeatBox.spacing = 6
        promptBox = NSStackView(views: [sessionPopup, promptField])
        scriptBox = NSStackView(views: [taskPopup, scriptField])
        for box in [promptBox, scriptBox] {
            box.orientation = .vertical
            box.alignment = .leading
            box.spacing = 6
        }
        let radios = NSStackView(views: [remindRadio, promptRadio, scriptRadio])
        radios.orientation = .vertical
        radios.alignment = .leading
        radios.spacing = 4
        thenBox = NSStackView(views: [makeCaption(L("Then")), radios, promptBox, scriptBox])
        thenBox.orientation = .vertical
        thenBox.alignment = .leading
        thenBox.spacing = 6
        thenBox.setCustomSpacing(4, after: radios)
        column.setViews([makeCaption(L("When")), whenControl, onceRow, repeatBox, nextLabel, thenBox], in: .leading)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 6
        column.setCustomSpacing(10, after: nextLabel)
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    /// Fills the controls from the task's schedule; a new one starts as tomorrow 09:00 (Once) or every day at 09:00.
    private func load(_ timing: ItemTiming, now: Date) {
        let today = wallToday(now)
        let tomorrow = wallDate(today).map { wallDay($0.addingTimeInterval(86400)) } ?? today
        let schedule = timing.schedule
        whenControl.selectedSegment = schedule == nil ? 0 : schedule?.kind == "once" ? 1 : 2
        let at = schedule?.kind == "once" ? schedule!.at : tomorrow + "T09:00"
        let atParts = at.split(separator: "T").map(String.init)
        onceDate.dateValue = wallDate(atParts.first ?? tomorrow) ?? Date()
        onceTime.dateValue = wallDate("2000-01-01", atParts.count > 1 ? atParts[1] : "09:00") ?? Date()
        let rule = schedule?.kind == "repeat" ? schedule!.rule : ScheduleRule()
        rulePopup.selectItem(at: ScheduleEditorView.freqs.firstIndex(of: rule.freq) ?? 0)
        ruleTime.dateValue = wallDate("2000-01-01", rule.time) ?? Date()
        let days = rule.freq == "weekly" ? rule.days : [isoWeekday(now)]
        dayButtons.forEach { $0.isOn = days.contains($0.day) }
        monthDayField.stringValue = String(rule.freq == "monthly" ? rule.day : 1)
        everyField.stringValue = String(rule.freq == "every" ? rule.interval : 2)
        let starts = schedule?.starts ?? ""
        startsPicker.dateValue = wallDate(starts.isEmpty ? today : starts) ?? Date()
        let ends = schedule?.ends ?? ScheduleEnds()
        endsPopup.selectItem(at: ScheduleEditorView.endKinds.firstIndex(of: ends.kind) ?? 0)
        endsDate.dateValue = wallDate(ends.kind == "on" ? ends.date : today) ?? Date()
        endsCount.stringValue = String(ends.kind == "after" ? ends.count : 10)
        let then = timing.then
        setThen(then.kind)
        promptField.stringValue = then.kind == "prompt" ? then.text : ""
        scriptField.stringValue = then.kind == "script" ? then.script : ""
        setTargets(sessions: [], tasks: [])
    }

    private func isoWeekday(_ date: Date) -> Int {
        ((scheduleCalendar().component(.weekday, from: date) + 5) % 7) + 1
    }

    private func setThen(_ kind: String) {
        remindRadio.state = kind == "remind" ? .on : .off
        promptRadio.state = kind == "prompt" ? .on : .off
        scriptRadio.state = kind == "script" ? .on : .off
    }

    var thenKind: String { promptRadio.state == .on ? "prompt" : scriptRadio.state == .on ? "script" : "remind" }

    /// The pop-ups: the engine's sessions and tasks; the task's own choice stays listed when the answer lacks it.
    func setTargets(sessions: [TargetSession], tasks: [TargetTask]) {
        self.sessions = sessions
        self.tasks = tasks
        let then = original.then
        let chosenSession = (sessionPopup.selectedItem?.representedObject as? String) ?? (then.kind == "prompt" ? then.taskId + ":" + then.terminalId : "")
        let chosenTask = (taskPopup.selectedItem?.representedObject as? String) ?? (then.kind == "script" ? then.taskId : "")
        var sessionItems = sessions.map { session -> (String, String) in
            let name = session.name.isEmpty ? session.taskTitle : session.name
            let label = session.taskTitle.isEmpty || session.taskTitle == name ? name : name + " \u{00B7} " + session.taskTitle
            return (session.taskId + ":" + session.terminalId, label.isEmpty ? session.terminalId : label)
        }
        if then.kind == "prompt", !sessionItems.contains(where: { $0.0 == then.taskId + ":" + then.terminalId }) {
            let name = original.target?.name ?? ""
            sessionItems.insert((then.taskId + ":" + then.terminalId, name.isEmpty ? L("Task {1} · {2}", then.taskId, then.terminalId) : name), at: 0)
        }
        var taskItems = tasks.map { ($0.id, L("In task: {1}", $0.title.isEmpty ? $0.id : $0.title)) }
        if then.kind == "script", !taskItems.contains(where: { $0.0 == then.taskId }) {
            let name = original.target?.name ?? ""
            taskItems.insert((then.taskId, L("In task: {1}", name.isEmpty ? then.taskId : name)), at: 0)
        }
        fill(sessionPopup, sessionItems, chosen: chosenSession, empty: L("No session"))
        fill(taskPopup, taskItems, chosen: chosenTask, empty: L("No task"))
    }

    private func fill(_ button: NSPopUpButton, _ items: [(String, String)], chosen: String, empty: String) {
        button.removeAllItems()
        if items.isEmpty {
            button.addItem(withTitle: empty)
            button.lastItem?.representedObject = nil
            button.isEnabled = false
            return
        }
        button.isEnabled = true
        for (value, label) in items {
            button.addItem(withTitle: label)
            button.lastItem?.representedObject = value
        }
        if let index = button.itemArray.firstIndex(where: { ($0.representedObject as? String) == chosen }) { button.selectItem(at: index) }
    }

    // MARK: The values

    private func number(_ field: NSTextField) -> Int? {
        Int(((field.currentEditor() as? NSTextView)?.string ?? field.stringValue).trimmed)
    }

    private func text(_ field: NSTextField) -> String {
        (field.currentEditor() as? NSTextView)?.string ?? field.stringValue
    }

    /// The schedule the controls describe; nil for No date. A schedule of the task keeps its zone.
    var schedule: ItemSchedule? {
        switch whenControl.selectedSegment {
        case 1:
            return ItemSchedule(kind: "once", at: wallDay(onceDate.dateValue) + "T" + wallTime(onceTime.dateValue), tz: original.schedule?.tz ?? "")
        case 2:
            let freq = ScheduleEditorView.freqs[max(0, min(rulePopup.indexOfSelectedItem, ScheduleEditorView.freqs.count - 1))]
            var rule = ScheduleRule(freq: freq, time: wallTime(ruleTime.dateValue))
            if freq == "weekly" { rule.days = dayButtons.filter { $0.isOn }.map { $0.day } }
            if freq == "monthly" { rule.day = number(monthDayField) ?? 0 }
            if freq == "every" { rule.interval = number(everyField) ?? 0 }
            var out = ItemSchedule(kind: "repeat", rule: rule, tz: original.schedule?.tz ?? "")
            // Starts only when the task had one or it was changed here (the owner counts Every N days from today otherwise).
            if startsTouched || !(original.schedule?.starts ?? "").isEmpty { out.starts = wallDay(startsPicker.dateValue) }
            let kind = ScheduleEditorView.endKinds[max(0, min(endsPopup.indexOfSelectedItem, 2))]
            out.ends = ScheduleEnds(kind: kind, date: kind == "on" ? wallDay(endsDate.dateValue) : "", count: kind == "after" ? (number(endsCount) ?? 0) : 1)
            return out
        default:
            return nil
        }
    }

    var then: ThenAction {
        switch thenKind {
        case "prompt":
            let parts = ((sessionPopup.selectedItem?.representedObject as? String) ?? "").split(separator: ":", maxSplits: 1).map(String.init)
            return ThenAction(kind: "prompt", taskId: parts.first ?? "", terminalId: parts.count > 1 ? parts[1] : "", text: text(promptField).trimmed)
        case "script":
            return ThenAction(kind: "script", taskId: (taskPopup.selectedItem?.representedObject as? String) ?? "", script: text(scriptField).trimmed,
                              timeoutMin: original.then.kind == "script" ? original.then.timeoutMin : 30)
        default:
            return ThenAction()
        }
    }

    /// Why the schedule cannot be saved, or nil.
    var scheduleProblem: String? {
        guard let schedule = schedule, schedule.kind == "repeat" else { return nil }
        switch schedule.rule.freq {
        case "weekly" where schedule.rule.days.isEmpty: return L("Pick at least one day")
        case "monthly" where !(1...31).contains(schedule.rule.day): return L("The day of the month is a number from 1 to 31")
        case "every" where !(1...365).contains(schedule.rule.interval): return L("Every N days takes a number from 1 to 365")
        default: break
        }
        if schedule.ends.kind == "after", !(1...9999).contains(schedule.ends.count) { return L("The number of times is from 1 to 9999") }
        return nil
    }

    /// Why the form cannot be saved (the schedule, or the action without its session, task, prompt or script), or nil.
    var problem: String? {
        guard schedule != nil else { return nil }
        if let problem = scheduleProblem { return problem }
        let then = self.then
        switch then.kind {
        case "prompt":
            if then.taskId.isEmpty || then.terminalId.isEmpty { return L("Pick a session") }
            if then.text.isEmpty { return L("Write the prompt") }
            if then.text.utf16.count > 4000 { return L("The prompt cannot exceed 4000 characters") }
        case "script":
            if then.taskId.isEmpty { return L("Pick a task") }
            if then.script.isEmpty { return L("Write the script") }
            if then.script.utf16.count > 4000 { return L("The script cannot exceed 4000 characters") }
        default: break
        }
        return nil
    }

    /// The schedule fields of the save: for a new task (`changedFrom` nil) the schedule and its action when there is one; for
    /// an edit only what changed (`schedule: null` clears it).
    func fields(changedFrom original: ItemTiming?) -> [String: Any] {
        let schedule = self.schedule
        let then = self.then
        guard let original = original else {
            guard let schedule = schedule else { return [:] }
            return ["schedule": schedule.json, "then_action": then.json ?? NSNull()]
        }
        guard let next = schedule else { return original.schedule == nil ? [:] : ["schedule": NSNull()] }
        var out: [String: Any] = [:]
        if next != original.schedule { out["schedule"] = next.json }
        if then != original.then || original.schedule == nil { out["then_action"] = then.json ?? NSNull() }
        return out
    }

    /// "Next: tomorrow 03:00 · then every day" from the owner's preview, its message when the schedule cannot be saved, or
    /// nothing (no schedule, no answer, an older owner).
    func showPreview(_ answer: (next: [Date], text: String, error: String)?) {
        if let error = scheduleProblem ?? answer.flatMap({ $0.error.isEmpty ? nil : $0.error }) {
            nextLabel.stringValue = error
            nextLabel.textColor = .systemRed
        } else if let first = answer?.next.first, let schedule = schedule {
            var line = L("Next: {1}", momentText(first, now: scheduleClock()))
            if schedule.kind == "repeat" { line += " \u{00B7} " + L("then {1}", lowerFirst(ruleWords(schedule.rule))) }
            nextLabel.stringValue = line
            nextLabel.textColor = .controlAccentColor
        } else {
            nextLabel.stringValue = ""
        }
        let hidden = nextLabel.stringValue.isEmpty || schedule == nil
        if nextLabel.isHidden != hidden {
            nextLabel.isHidden = hidden
            onResize()
        }
    }

    // MARK: Changes

    /// Shows the parts the choices need; tells the form when its height changed and asks for "Next" again.
    func update(notify: Bool = true) {
        let when = whenControl.selectedSegment
        let freq = ScheduleEditorView.freqs[max(0, min(rulePopup.indexOfSelectedItem, ScheduleEditorView.freqs.count - 1))]
        let ends = ScheduleEditorView.endKinds[max(0, min(endsPopup.indexOfSelectedItem, 2))]
        let shown: [(NSView, Bool)] = [
            (onceRow, when == 1), (repeatBox, when == 2), (weeklyRow, freq == "weekly"), (monthlyRow, freq == "monthly"),
            (everyRow, freq == "every"), (endsDateRow, ends == "on"), (endsCountRow, ends == "after"), (thenBox, when != 0),
            (promptBox, thenKind == "prompt"), (scriptBox, thenKind == "script"),
        ]
        var changed = false
        for (view, on) in shown where view.isHidden == on {
            view.isHidden = !on
            changed = true
        }
        if when == 0 && !nextLabel.isHidden {
            nextLabel.isHidden = true
            changed = true
        }
        if notify {
            if changed { onResize() }
            onChange()
        }
    }

    @objc func controlChanged() { update() }

    @objc func startsChanged() {
        startsTouched = true
        update()
    }

    @objc func dayClicked(_ sender: DayToggle) {
        sender.isOn.toggle()
        update()
    }

    @objc func radioClicked(_ sender: NSButton) {
        setThen(sender === promptRadio ? "prompt" : sender === scriptRadio ? "script" : "remind")
        update()
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField, field !== promptField, field !== scriptField else { return }
        onChange()  // a number: "Next" again
    }

    /// Return in the prompt and the script is a new line; in the number fields it saves, as in the rest of the form.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if textView.hasMarkedText() { return false }
        if selector == #selector(NSResponder.insertNewline(_:)), control === promptField || control === scriptField {
            textView.insertNewlineIgnoringFieldEditor(nil)
            return true
        }
        return false
    }

    // For --self-test.
    func testChoose(when segment: Int) {
        whenControl.selectedSegment = segment
        update()
    }
    func testChoose(freq: String) {
        rulePopup.selectItem(at: ScheduleEditorView.freqs.firstIndex(of: freq) ?? 0)
        update()
    }
    func testChoose(ends: String) {
        endsPopup.selectItem(at: ScheduleEditorView.endKinds.firstIndex(of: ends) ?? 0)
        update()
    }
    func testChoose(then kind: String) {
        radioClicked(kind == "prompt" ? promptRadio : kind == "script" ? scriptRadio : remindRadio)
    }
    func testSelect(session value: String) {
        if let index = sessionPopup.itemArray.firstIndex(where: { ($0.representedObject as? String) == value }) { sessionPopup.selectItem(at: index) }
    }
    func testSelect(task value: String) {
        if let index = taskPopup.itemArray.firstIndex(where: { ($0.representedObject as? String) == value }) { taskPopup.selectItem(at: index) }
    }
    var testShown: [String] {
        [("once", onceRow), ("repeat", repeatBox), ("weekly", weeklyRow), ("monthly", monthlyRow), ("every", everyRow), ("ends on", endsDateRow),
         ("ends after", endsCountRow), ("then", thenBox), ("prompt", promptBox), ("script", scriptBox), ("next", nextLabel)]
            .filter { !$0.1.isHidden }.map { $0.0 }
    }
}
