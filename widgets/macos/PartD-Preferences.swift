// T-Attention desktop widget: Part D, shortcuts and preferences. See main.swift for the overview and the build.
import AppKit
import Carbon  // RegisterEventHotKey: global shortcuts without the Accessibility permission

// MARK: - Part D: shortcuts and preferences
//
// - Preferences: { hotkeys, dim_when_idle, show_activity }, in every tick (Part E); from a T-Agent without /tick, GET
//   /api/attention/widget/prefs at start and every 5 s. A 404 of /prefs (an older T-Agent) means the defaults (all on) and
//   the next try after prefsRetryDelay; any other failure keeps what is in effect.
// - Global shortcuts (Carbon RegisterEventHotKey, no Accessibility permission): Ctrl+Option+T opens the panel and keeps it
//   open (with the keyboard in the search field) until pressed again, Esc or a click elsewhere; Ctrl+Option+N opens New task.
//   A shortcut another app holds is reported once on stderr. Never registered with --self-test or --render-sample.
// - Fade when idle: the pill goes to idleAlpha after idleFadeDelay without the pointer over the pill or the panel, without a
//   new notice and without a rise of the Needs you count (at once with Reduce motion).
// - Search: a field above the list filters the rows by title, notes and custom status (case, diacritics and width ignored).
//   Cmd+F focuses it while the panel has the keyboard; Esc clears it, a second Esc closes the panel.
// - Finished group: done, failed and cancelled rows under a "Finished (N)" header, collapsed by default (kept in UserDefaults);
//   a search shows the matching finished rows.
// - Position per display: the pill's spot is saved for each display (by its UUID, else its name and frame), as fractions of the
//   free room so a right or bottom edge stays one; when the displays change the pill goes to the display it was last placed on
//   (when connected), else to the saved spot of the display it is on now, clamped into the visible frame.

let prefsRetryDelay: TimeInterval = 300
let idleFadeDelay: TimeInterval = 30
let idleAlpha: CGFloat = 0.45
let searchBarHeight: CGFloat = 30

/// The window preferences of GET /api/attention/widget/prefs (the switches of the settings card).
struct WindowPrefs: Equatable {
    var hotkeys = true
    var dimWhenIdle = true
    var showActivity = true
}

/// A JSON true or false (not a number).
func jsonBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}

/// The answer of GET /prefs: a missing or non-boolean field keeps its default (on). Nil when it is not a JSON object.
func decodeWindowPrefs(_ data: Data) -> WindowPrefs? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return WindowPrefs(hotkeys: jsonBool(object["hotkeys"]) ?? true, dimWhenIdle: jsonBool(object["dim_when_idle"]) ?? true,
                       showActivity: jsonBool(object["show_activity"]) ?? true)
}

/// When GET /prefs is asked and what an answer means.
struct PrefsPoll {
    var inFlight = false
    var retryAt: Date?  // after a 404

    func due(_ now: Date) -> Bool { !inFlight && (retryAt.map { now >= $0 } ?? true) }

    /// The preferences to apply after an answer; nil keeps the ones in effect.
    mutating func finished(code: Int, data: Data?, now: Date) -> WindowPrefs? {
        inFlight = false
        if code == 404 {
            retryAt = now.addingTimeInterval(prefsRetryDelay)
            return WindowPrefs()
        }
        guard (200..<300).contains(code), let data = data, let prefs = decodeWindowPrefs(data) else { return nil }
        retryAt = nil
        return prefs
    }
}

extension WidgetAPI {
    var prefsRequest: URLRequest { request("GET", "/api/attention/widget/prefs") }
}

/// The opacity of the pill: idleAlpha after idleFadeDelay without activity, else 1. `active` is the pointer over the pill or
/// the panel, the panel or a bubble showing, a drag.
func idleTargetAlpha(enabled: Bool, active: Bool, lastActivity: Date, now: Date) -> CGFloat {
    guard enabled, !active else { return 1 }
    return now.timeIntervalSince(lastActivity) >= idleFadeDelay ? idleAlpha : 1
}

/// Whether a search query keeps a row: every word of the query is found in one of the fields, ignoring case, diacritics and
/// width. Chinese has no spaces, so a Chinese query is one word matched anywhere.
func searchMatches(_ query: String, _ fields: [String]) -> Bool {
    let words = query.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    return words.allSatisfy { word in
        fields.contains { $0.range(of: word, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]) != nil }
    }
}

/// What a key does in the panel while it has the keyboard (and no form is open).
enum PanelKeyAction: Equatable {
    case focusSearch, clearSearch, close, pass
}

func panelKeyAction(keyCode: UInt16, characters: String, flags: NSEvent.ModifierFlags, queryEmpty: Bool, pinned: Bool) -> PanelKeyAction {
    let mods = flags.intersection([.command, .control, .option, .shift])
    if mods == .command && characters.lowercased() == "f" { return .focusSearch }
    if keyCode == 53 && mods.isEmpty {  // Esc
        if !queryEmpty { return .clearSearch }
        if pinned { return .close }
    }
    return .pass
}

/// The key a display's saved spot is kept under: its UUID, else its name and frame (a display without a UUID).
func displayKey(uuid: String?, name: String, frame: NSRect) -> String {
    if let uuid = uuid?.trimmed, !uuid.isEmpty { return "uuid:" + uuid }
    return "name:\(name)@\(Int(frame.minX)),\(Int(frame.minY)),\(Int(frame.width))x\(Int(frame.height))"
}

func displayKey(of screen: NSScreen) -> String {
    var uuid: String?
    if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
       let made = CGDisplayCreateUUIDFromDisplayID(CGDirectDisplayID(number.uint32Value)) {
        uuid = CFUUIDCreateString(nil, made.takeRetainedValue()) as String?
    }
    var name = "display"
    if #available(macOS 10.15, *) { name = screen.localizedName }
    return displayKey(uuid: uuid, name: name, frame: screen.frame)
}

/// An origin that keeps a window of `size` inside `visible`.
func clampedOrigin(_ origin: NSPoint, size: NSSize, in visible: NSRect) -> NSPoint {
    NSPoint(x: min(max(origin.x, visible.minX), max(visible.minX, visible.maxX - size.width)),
            y: min(max(origin.y, visible.minY), max(visible.minY, visible.maxY - size.height)))
}

/// A spot as fractions (0...1) of the room a window of `size` has in `visible`, and back: a window at the right edge stays at
/// the right edge on a display of another size.
func relativeSpot(_ origin: NSPoint, size: NSSize, in visible: NSRect) -> NSPoint {
    let room = NSSize(width: visible.width - size.width, height: visible.height - size.height)
    func part(_ offset: CGFloat, _ length: CGFloat) -> CGFloat { length > 0 ? min(max(offset / length, 0), 1) : 0 }
    return NSPoint(x: part(origin.x - visible.minX, room.width), y: part(origin.y - visible.minY, room.height))
}

func absoluteOrigin(_ spot: NSPoint, size: NSSize, in visible: NSRect) -> NSPoint {
    let origin = NSPoint(x: visible.minX + spot.x * max(visible.width - size.width, 0),
                         y: visible.minY + spot.y * max(visible.height - size.height, 0))
    return clampedOrigin(NSPoint(x: origin.x.rounded(), y: origin.y.rounded()), size: size, in: visible)
}

/// The display whose saved spot the pill takes: the one it was last placed on when that is connected and has a spot, else
/// the one it is on now when that has a spot, else none (the pill stays where it is, kept on screen).
func chooseDisplay(preferred: String?, current: String?, connected: [String], saved: Set<String>) -> String? {
    for key in [preferred, current].compactMap({ $0 }) where connected.contains(key) && saved.contains(key) { return key }
    return nil
}

/// The global shortcuts. The raw value is the hot key id.
enum HotKeyAction: UInt32 {
    case togglePanel = 1, newTask = 2

    var keyCode: UInt32 { UInt32(self == .togglePanel ? kVK_ANSI_T : kVK_ANSI_N) }
    var modifiers: UInt32 { UInt32(controlKey | optionKey) }
    var name: String { self == .togglePanel ? "Ctrl+Option+T" : "Ctrl+Option+N" }
}

let hotKeySignature: OSType = 0x5441_4857  // 'TAHW'

/// Registers the global shortcuts with Carbon (RegisterEventHotKey needs no Accessibility permission).
final class HotKeyCenter {
    var onAction: (HotKeyAction) -> Void = { _ in }
    private var refs: [EventHotKeyRef] = []
    private var handler: EventHandlerRef?
    private var warned = Set<UInt32>()
    private(set) var registered = false

    func register() {
        guard !registered else { return }
        registered = true
        if handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, event, user in
                guard let event = event, let user = user else { return OSStatus(eventNotHandledErr) }
                var id = EventHotKeyID()
                let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                               MemoryLayout<EventHotKeyID>.size, nil, &id)
                guard status == noErr, id.signature == hotKeySignature, let action = HotKeyAction(rawValue: id.id) else {
                    return OSStatus(eventNotHandledErr)
                }
                let center = Unmanaged<HotKeyCenter>.fromOpaque(user).takeUnretainedValue()
                DispatchQueue.main.async { center.onAction(action) }
                return noErr
            }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handler)
        }
        for action in [HotKeyAction.togglePanel, .newTask] {
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(action.keyCode, action.modifiers, EventHotKeyID(signature: hotKeySignature, id: action.rawValue),
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref = ref {
                refs.append(ref)
            } else if warned.insert(action.rawValue).inserted {
                FileHandle.standardError.write(Data("T-Attention window: the shortcut \(action.name) is taken by another app (\(status))\n".utf8))
            }
        }
    }

    func unregister() {
        for ref in refs { UnregisterEventHotKey(ref) }
        refs = []
        registered = false
    }
}

/// The search field above the list. A click gives the panel the keyboard first (it does not take it otherwise).
final class PanelSearchField: NSSearchField {
    var onFocus: () -> Void = {}

    override func mouseDown(with event: NSEvent) {
        onFocus()
        super.mouseDown(with: event)
    }
}

/// The header of the Finished group: a grey dot, the name, a muted count and a disclosure triangle at the right; a
/// click opens or closes the group.
final class DisclosureLine: NSView {
    let titleField: NSTextField
    let countField: NSTextField
    let triangle = NSTextField(labelWithString: "")
    var onToggle: () -> Void = {}
    var enabled = true

    init(title: String, count: Int, expanded: Bool, width: CGFloat) {
        titleField = NSTextField(labelWithString: title)
        countField = NSTextField(labelWithString: String(count))
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        titleField.font = .systemFont(ofSize: 12, weight: .semibold)
        titleField.textColor = .secondaryLabelColor
        titleField.lineBreakMode = .byTruncatingTail
        countField.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        countField.textColor = .tertiaryLabelColor
        let dot = DotView(color: sectionColor(.done))
        for field in [titleField, countField, triangle] {
            field.translatesAutoresizingMaskIntoConstraints = false
            field.setAccessibilityElement(false)
        }
        triangle.stringValue = expanded ? "\u{25BE}" : "\u{25B8}"
        triangle.font = .systemFont(ofSize: 13)
        triangle.textColor = .tertiaryLabelColor
        triangle.alignment = .right
        addSubview(titleField)  // first: what the offscreen checks read as the line's text
        addSubview(dot)
        addSubview(countField)
        addSubview(triangle)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: width),
            heightAnchor.constraint(equalToConstant: 18),
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 1),
            dot.centerYAnchor.constraint(equalTo: titleField.centerYAnchor),
            titleField.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 7),
            titleField.centerYAnchor.constraint(equalTo: centerYAnchor),
            countField.leadingAnchor.constraint(equalTo: titleField.trailingAnchor, constant: 5),
            countField.firstBaselineAnchor.constraint(equalTo: titleField.firstBaselineAnchor),
            countField.trailingAnchor.constraint(lessThanOrEqualTo: triangle.leadingAnchor, constant: -6),
            triangle.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
            triangle.centerYAnchor.constraint(equalTo: titleField.centerYAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.disclosureTriangle)
        setAccessibilityLabel(title + ", " + String(count))
        setAccessibilityExpanded(expanded)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        if enabled { onToggle() }
    }

    override func accessibilityPerformPress() -> Bool {
        guard enabled else { return false }
        onToggle()
        return true
    }
}

/// What the search leaves of the panel's rows; `empty` replaces the text of an empty section while a search runs.
struct SearchResult {
    let needs: [Row]
    let working: [Row]
    let todo: [Row]
    let finished: [Row]
    let finishedTotal: Int
    let searching: Bool
    var empty: String? { searching ? L("No matches") : nil }
}

/// The state of Part D on the controller (stored properties cannot live in the extension).
final class PartDState {
    var prefs = WindowPrefs()
    var poll = PrefsPoll()
    var started = false
    let hotKeys = HotKeyCenter()
    var hotKeysWanted = false  // what the preferences ask for; registered only on screen
    var pinned = false
    var clickMonitor: Any?
    var keyMonitor: Any?
    var lastActivity = Date()
    var lastNeeds: Int?
    var finishedExpanded: Bool?  // nil until read from UserDefaults
    let searchField = PanelSearchField()
    /// The magnifier left of +: opens the search field (as Cmd+F and the Ctrl+Option+T shortcut do).
    let searchButton = PanelButton(label: L("Search"), symbol: "magnifyingglass", symbolSize: 13)
    /// "Tasks" and the unfinished count, where the field is while the search is closed.
    let heading = NSTextField(labelWithString: "")
    var searchExpanded = false
    var query: String { searchField.stringValue.trimmed }
}

extension WidgetController {
    // MARK: Preferences

    func startPreferences() {
        guard !partD.started else { return }
        partD.started = true
        partD.lastActivity = now()
        partD.hotKeys.onAction = { [weak self] action in self?.hotKeyPressed(action) }
        applyPrefs(WindowPrefs())  // the defaults until T-Agent answers
        if !tickMode { pollPrefs() }  // the tick brings them (Part E); else poll() asks every 5 s
        addTimer(tickInterval) { [weak self] in self?.updateIdleFade() }
        if !options.offscreen {
            partD.keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                self?.panelKey(event) == true ? nil : event
            }
        }
    }

    func pollPrefs() {
        guard partD.poll.due(now()) else { return }
        partD.poll.inFlight = true
        perform(api.prefsRequest) { [weak self] data, code, _ in
            guard let self = self else { return }
            if let prefs = self.partD.poll.finished(code: code, data: data, now: self.now()) { self.applyPrefs(prefs) }
        }
    }

    func applyPrefs(_ next: WindowPrefs) {
        let before = partD.prefs
        partD.prefs = next
        showActivity = next.showActivity
        partD.hotKeysWanted = next.hotkeys
        if !options.offscreen {  // --self-test and --render-sample never take the keyboard of the whole system
            if next.hotkeys { partD.hotKeys.register() } else { partD.hotKeys.unregister() }
        }
        if before.dimWhenIdle != next.dimWhenIdle { updateIdleFade() }
        if before.showActivity != next.showActivity {
            updateCollapsed()
            rebuildDetail()
            if detail.isVisible { positionDetail() }
        }
    }

    // MARK: Shortcuts

    func hotKeyPressed(_ action: HotKeyAction) {
        noteActivity()
        switch action {
        case .togglePanel:
            if partD.pinned { unpinPanel() } else if overlay == nil { pinPanel(focusSearch: true) }
        case .newTask:
            guard overlay == nil else { return }
            unpinPanel()  // the form holds the panel and takes the keyboard itself
            plusClicked()
        }
    }

    /// Opens the panel and keeps it open (holdsPanel) with the keyboard until the shortcut, Esc or a click elsewhere.
    func pinPanel(focusSearch: Bool) {
        partD.pinned = true
        showDetail()
        detail.acceptsKey = true
        if !options.offscreen {
            detail.makeKey()  // does not activate this app: the other app stays frontmost
            if partD.clickMonitor == nil {
                partD.clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                    self?.unpinPanel()
                }
            }
        }
        if focusSearch {
            setSearchExpanded(true)
            detail.makeFirstResponder(partD.searchField)
        }
    }

    func unpinPanel() {
        guard partD.pinned else { return }
        partD.pinned = false
        if let monitor = partD.clickMonitor { NSEvent.removeMonitor(monitor) }
        partD.clickMonitor = nil
        partD.searchExpanded = false
        if !partD.searchField.stringValue.isEmpty {
            partD.searchField.stringValue = ""
            searchChanged()
        } else {
            setSearchExpanded(false)
        }
        if overlay == nil {
            let wasKey = detail.isKeyWindow
            detail.makeFirstResponder(nil)
            detail.acceptsKey = false
            if wasKey && !options.offscreen {
                detail.orderOut(nil)  // the keyboard goes back to the frontmost app
                orderFront(detail)
            }
        }
        if options.offscreen { hideDetail() } else { hideIfPointerOutside() }
    }

    /// A key in the panel; true when it was used.
    func panelKey(_ event: NSEvent) -> Bool {
        guard event.window === detail, detail.isKeyWindow, overlay == nil else { return false }
        return performPanelKey(panelKeyAction(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers ?? "",
                                              flags: event.modifierFlags, queryEmpty: partD.searchField.stringValue.isEmpty,
                                              pinned: partD.pinned))
    }

    func performPanelKey(_ action: PanelKeyAction) -> Bool {
        switch action {
        case .focusSearch:
            if !partD.pinned { pinPanel(focusSearch: false) }
            setSearchExpanded(true)
            detail.makeFirstResponder(partD.searchField)
        case .clearSearch:
            partD.searchField.stringValue = ""
            searchChanged()
        case .close:
            unpinPanel()
        case .pass:
            return false
        }
        return true
    }

    // MARK: Search and the Finished group

    func installSearchBar(in root: NSView) {
        let field = partD.searchField
        field.placeholderString = L("Search")
        field.setAccessibilityLabel(L("Search"))
        field.font = .systemFont(ofSize: 12)
        field.focusRingType = .none
        field.sendsSearchStringImmediately = true
        field.sendsWholeSearchString = false
        field.target = self
        field.action = #selector(searchFieldChanged)
        field.onFocus = { [weak self] in
            guard let self = self, !self.partD.pinned, self.overlay == nil else { return }
            self.pinPanel(focusSearch: false)
        }
        let top = root.bounds.height
        // The top row: "Tasks" and the count at the left (the field in its place while searching), the magnifier and +
        // at the right.
        let button = partD.searchButton
        button.target = self
        button.action = #selector(searchButtonClicked)
        root.addSubview(button)
        NSLayoutConstraint.activate([
            button.topAnchor.constraint(equalTo: root.topAnchor, constant: 6),
            button.trailingAnchor.constraint(equalTo: plusButton.leadingAnchor, constant: -2),
            button.widthAnchor.constraint(equalToConstant: 22),
            button.heightAnchor.constraint(equalToConstant: 22),
        ])
        let heading = partD.heading
        heading.lineBreakMode = .byTruncatingTail
        heading.frame = NSRect(x: detailPadding, y: top - 6 - 20, width: detailWidth - detailPadding - 8 - 22 - 2 - 22 - 6, height: 18)
        heading.autoresizingMask = [.minYMargin]
        root.addSubview(heading)
        field.frame = NSRect(x: detailPadding - 2, y: top - 6 - 22, width: detailWidth - detailPadding - 8 - 22 - 2 - 22 - 4, height: 22)
        field.autoresizingMask = [.minYMargin]
        field.isHidden = true
        root.addSubview(field)
        scrollView.frame = NSRect(x: 0, y: 0, width: root.bounds.width, height: top - searchBarHeight)
        updateHeading()
    }

    /// The heading's text: "Tasks" and the unfinished count, muted.
    func updateHeading() {
        let text = NSMutableAttributedString(string: L("Tasks"), attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.labelColor,
        ])
        if let summary = summary {
            text.append(NSAttributedString(string: "  " + String(summary.unfinished), attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor.tertiaryLabelColor,
            ]))
        }
        text.addAttribute(.paragraphStyle, value: truncating, range: NSRange(location: 0, length: text.length))
        partD.heading.attributedStringValue = text
        partD.searchButton.label = L("Search")
        partD.searchField.placeholderString = L("Search")
        partD.searchField.setAccessibilityLabel(L("Search"))
    }

    /// The field shows in place of the heading while a search is open or has text.
    func setSearchExpanded(_ on: Bool) {
        let expanded = on || !partD.searchField.stringValue.isEmpty
        partD.searchExpanded = expanded
        partD.searchField.isHidden = !expanded
        partD.heading.isHidden = expanded
    }

    /// The magnifier: opens the field with the keyboard in it; again on an empty field closes it.
    @objc func searchButtonClicked() {
        noteActivity()
        if partD.searchExpanded && partD.searchField.stringValue.isEmpty {
            setSearchExpanded(false)
            unpinPanel()
        } else if overlay == nil {
            pinPanel(focusSearch: true)
        }
    }

    @objc func searchFieldChanged() { searchChanged() }

    func searchChanged() {
        noteActivity()
        setSearchExpanded(partD.pinned && partD.searchExpanded)  // open while it is being used or has text
        guard !rowDragActive else { return }
        rebuildDetail()
        if detail.isVisible { positionDetail() }
    }

    func searchResult(_ summary: Summary) -> SearchResult {
        let query = partD.query
        guard !query.isEmpty else {
            return SearchResult(needs: summary.needs, working: summary.working, todo: summary.todo, finished: summary.finished,
                                finishedTotal: summary.done, searching: false)
        }
        var notes: [String: String] = [:]
        for item in items where notes[item.key] == nil { notes[item.key] = item.notes ?? "" }
        func keep(_ rows: [Row]) -> [Row] { rows.filter { searchMatches(query, [$0.title, $0.custom, notes[$0.key] ?? ""]) } }
        let finished = keep(summary.finished)
        return SearchResult(needs: keep(summary.needs), working: keep(summary.working), todo: keep(summary.todo), finished: finished,
                            finishedTotal: finished.count, searching: true)
    }

    var finishedExpanded: Bool {
        get {
            if let known = partD.finishedExpanded { return known }
            let stored = options.persistPosition && defaults.bool(forKey: "finished_expanded")
            partD.finishedExpanded = stored
            return stored
        }
        set {
            partD.finishedExpanded = newValue
            if options.persistPosition { defaults.set(newValue, forKey: "finished_expanded") }
        }
    }

    /// The header "Finished (N)" (the drop target that marks a task done) and, when open or while searching, its rows.
    func addFinishedGroup(_ shown: SearchResult, after spacing: CGFloat) {
        let open = shown.searching || finishedExpanded
        let header = DisclosureLine(title: L("Finished"), count: shown.finishedTotal, expanded: open, width: detailWidth - detailPadding * 2)
        header.enabled = !shown.searching
        header.onToggle = { [weak self] in self?.toggleFinished() }
        stack.addArrangedSubview(header)
        sectionHeaders[.done] = header
        let rows = open ? shown.finished : []
        stack.setCustomSpacing(rows.isEmpty ? spacing : 3, after: header)
        for (index, row) in rows.enumerated() { addRow(row, after: index == rows.count - 1 ? spacing : 5, actionsAlwaysShown: false) }
    }

    func toggleFinished() {
        finishedExpanded.toggle()
        noteActivity()
        guard !rowDragActive else { return }
        rebuildDetail()
        if detail.isVisible { positionDetail() }
    }

    // MARK: Fade when idle

    func noteActivity() {
        partD.lastActivity = now()
        updateIdleFade()
    }

    func updateIdleFade() {
        let needs = summary?.needs.count ?? 0
        if let last = partD.lastNeeds, needs > last { partD.lastActivity = now() }  // something new needs you
        partD.lastNeeds = needs
        var active = dragging || partD.pinned || overlay != nil || bubbleView != nil || detail.isVisible
        if !options.offscreen {
            let mouse = NSEvent.mouseLocation
            active = active || widget.frame.contains(mouse)
        }
        if active { partD.lastActivity = now() }
        let target = idleTargetAlpha(enabled: partD.prefs.dimWhenIdle, active: active, lastActivity: partD.lastActivity, now: now())
        guard abs(widget.alphaValue - target) > 0.01 else { return }
        if options.offscreen || reduceMotion() {
            widget.alphaValue = target
        } else {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = target < 1 ? 0.8 : 0.15
                widget.animator().alphaValue = target
            }
        }
    }

    // MARK: Position per display

    private func screenFrames() -> [(key: String, visible: NSRect, frame: NSRect)] {
        NSScreen.screens.map { (displayKey(of: $0), $0.visibleFrame, $0.frame) }
    }

    private var savedSpots: [String: [String: Double]] {
        (defaults.dictionary(forKey: "display_positions") as? [String: [String: Double]]) ?? [:]
    }

    /// Saves the pill's spot for the display it is on and remembers that display.
    func saveDisplayPosition() {
        guard options.persistPosition else { return }
        let frame = widget.frame
        func overlap(_ rect: NSRect) -> CGFloat {
            let common = frame.intersection(rect)
            return common.isNull ? 0 : common.width * common.height
        }
        guard let screen = screenFrames().max(by: { overlap($0.frame) < overlap($1.frame) }), overlap(screen.frame) > 0 else { return }
        let spot = relativeSpot(frame.origin, size: frame.size, in: screen.visible)
        var spots = savedSpots
        spots[screen.key] = ["x": Double(spot.x), "y": Double(spot.y)]
        defaults.set(spots, forKey: "display_positions")
        defaults.set(screen.key, forKey: "display_last")
    }

    /// The frame for the pill from the spots saved per display (see chooseDisplay), or nil.
    func placedForDisplays() -> NSRect? {
        guard options.persistPosition else { return nil }
        let spots = savedSpots
        guard !spots.isEmpty else { return nil }
        let screens = screenFrames()
        let frame = widget.frame
        func overlap(_ rect: NSRect) -> CGFloat {
            let common = frame.intersection(rect)
            return common.isNull ? 0 : common.width * common.height
        }
        let current = screens.filter { overlap($0.frame) > 0 }.max { overlap($0.frame) < overlap($1.frame) }?.key
        guard let key = chooseDisplay(preferred: defaults.string(forKey: "display_last"), current: current ?? screens.first?.key,
                                      connected: screens.map { $0.key }, saved: Set(spots.keys)),
              let screen = screens.first(where: { $0.key == key }), let spot = spots[key],
              let x = spot["x"], let y = spot["y"] else { return nil }
        let size = NSSize(width: frame.width, height: widgetHeight)
        return NSRect(origin: absoluteOrigin(NSPoint(x: x, y: y), size: size, in: screen.visible), size: size)
    }

    // MARK: Offscreen checks

    var testPinned: Bool { partD.pinned }
    var testHotKeysRegistered: Bool { partD.hotKeys.registered }
    var testHotKeysWanted: Bool { partD.hotKeysWanted }
    var testPrefs: WindowPrefs { partD.prefs }
    var testWidgetAlpha: CGFloat { widget.alphaValue }
    var testPanelAcceptsKey: Bool { detail.acceptsKey }
    var testSearchBarAbove: Bool {
        guard let root = detail.contentView else { return false }
        return partD.searchField.superview === root && partD.searchField.frame.minY >= scrollView.frame.maxY - 1
    }
    func testSearch(_ text: String) {
        partD.searchField.stringValue = text
        searchChanged()
        positionDetail()  // offscreen the panel is never visible, so searchChanged leaves its size
        detail.contentView?.layoutSubtreeIfNeeded()
    }
    func testToggleFinished() { toggleFinished() }
    var testSearchExpanded: Bool { partD.searchExpanded && !partD.searchField.isHidden && partD.heading.isHidden }
    var testHeading: String { partD.heading.isHidden ? "" : partD.heading.stringValue }
    func testSearchButton() { partD.searchButton.performClick(nil) }
    var testSearchButtonIsIcon: Bool { partD.searchButton.isIcon }
    func testScrollToEnd() { scrollList(to: max(0, documentView.frame.height - scrollView.contentView.bounds.height)) }
    func testFinishedHeader() -> DisclosureLine? { sectionHeaders[.done] as? DisclosureLine }
    func testRowShown(_ key: String) -> Bool { rowViews[key] != nil }
    var testRowDragActive: Bool { rowDragActive }
}

/// --render-sample: the panel with a search and with the Finished group open, light and dark.
func renderPartDSamples(_ controller: WidgetController, _ dir: String, _ save: (String, Bool) -> Void) {
    for dark in [false, true] {
        let suffix = dark ? "dark" : "light"
        controller.setAppearance(dark: dark)
        controller.loadForTest(sampleList())
        controller.testSearch("log")
        save("panel-search-\(suffix).png", controller.renderPanel((dir as NSString).appendingPathComponent("panel-search-\(suffix).png"), dark: dark))
        controller.testSearch("")
        for open in [false, true] {
            let name = "panel-finished-\(open ? "open" : "closed")-\(suffix).png"
            if open { controller.testToggleFinished() }
            controller.loadForTest(sampleList())
            controller.testScrollToEnd()
            save(name, controller.renderPanel((dir as NSString).appendingPathComponent(name), dark: dark))
            if open { controller.testToggleFinished() }
        }
    }
}

func partDSelfTest(_ check: (String, Bool) -> Void) {
    // Preferences.
    check("prefs: decoded", decodeWindowPrefs(Data("{\"hotkeys\":false,\"dim_when_idle\":true,\"show_activity\":false}".utf8))
          == WindowPrefs(hotkeys: false, dimWhenIdle: true, showActivity: false))
    check("prefs: a missing or non-boolean field stays on", decodeWindowPrefs(Data("{\"hotkeys\":0,\"dim_when_idle\":\"no\"}".utf8))
          == WindowPrefs())
    check("prefs: not an object is nil", decodeWindowPrefs(Data("[true]".utf8)) == nil && decodeWindowPrefs(Data("x".utf8)) == nil)
    var poll = PrefsPoll()
    let start = Date(timeIntervalSince1970: 1_000_000)
    check("prefs poll: due at first", poll.due(start))
    poll.inFlight = true
    check("prefs poll: not twice at once", !poll.due(start))
    check("prefs poll: a 404 means the defaults", poll.finished(code: 404, data: nil, now: start) == WindowPrefs())
    check("prefs poll: then waits five minutes", !poll.due(start.addingTimeInterval(299)) && poll.due(start.addingTimeInterval(300)))
    check("prefs poll: a failure keeps what is in effect", poll.finished(code: 0, data: nil, now: start) == nil
          && poll.finished(code: 401, data: Data("{}".utf8), now: start) == nil)
    let off = poll.finished(code: 200, data: Data("{\"hotkeys\":false,\"dim_when_idle\":false,\"show_activity\":true}".utf8), now: start)
    check("prefs poll: an answer applies and clears the wait", off == WindowPrefs(hotkeys: false, dimWhenIdle: false, showActivity: true)
          && poll.retryAt == nil && poll.due(start))

    // Idle fade.
    let t0 = Date(timeIntervalSince1970: 2_000_000)
    check("idle: full before 30 s", idleTargetAlpha(enabled: true, active: false, lastActivity: t0, now: t0.addingTimeInterval(29)) == 1)
    check("idle: faded after 30 s", idleTargetAlpha(enabled: true, active: false, lastActivity: t0, now: t0.addingTimeInterval(30)) == idleAlpha)
    check("idle: never while active", idleTargetAlpha(enabled: true, active: true, lastActivity: t0, now: t0.addingTimeInterval(300)) == 1)
    check("idle: never when turned off", idleTargetAlpha(enabled: false, active: false, lastActivity: t0, now: t0.addingTimeInterval(300)) == 1)

    // Search.
    check("search: case-insensitive", searchMatches("deploy", ["Deploy the staging build"]))
    check("search: diacritics ignored", searchMatches("cafe", ["Caf\u{00E9} menu"]) && searchMatches("CAF\u{00C9}", ["cafe menu"]))
    check("search: every word must match some field", searchMatches("stag build", ["Deploy the staging build", ""])
          && !searchMatches("stag nothing", ["Deploy the staging build"]))
    check("search: Chinese", searchMatches("\u{6570}\u{636E}\u{5E93}", ["\u{8FC1}\u{79FB}\u{6570}\u{636E}\u{5E93}"])
          && !searchMatches("\u{65E5}\u{5FD7}", ["\u{8FC1}\u{79FB}\u{6570}\u{636E}\u{5E93}"]))
    check("search: full-width letters match", searchMatches("abc", ["\u{FF21}\u{FF22}\u{FF23} report"]))
    check("search: notes and custom status count", searchMatches("blocked", ["Build", "Blocked", ""]) && searchMatches("seen", ["a", "", "Seen twice"]))
    check("search: an empty query keeps everything", searchMatches("  ", ["x"]))

    // Keys.
    check("keys: Cmd+F focuses the search", panelKeyAction(keyCode: 3, characters: "f", flags: .command, queryEmpty: true, pinned: false) == .focusSearch)
    check("keys: Cmd+Shift+F does not", panelKeyAction(keyCode: 3, characters: "F", flags: [.command, .shift], queryEmpty: true, pinned: false) == .pass)
    check("keys: Esc clears a search first", panelKeyAction(keyCode: 53, characters: "\u{1B}", flags: [], queryEmpty: false, pinned: true) == .clearSearch)
    check("keys: then Esc closes the opened panel", panelKeyAction(keyCode: 53, characters: "\u{1B}", flags: [], queryEmpty: true, pinned: true) == .close)
    check("keys: Esc does nothing on a panel shown by hover", panelKeyAction(keyCode: 53, characters: "\u{1B}", flags: [], queryEmpty: true, pinned: false) == .pass)
    check("keys: other keys pass", panelKeyAction(keyCode: 0, characters: "a", flags: [], queryEmpty: true, pinned: true) == .pass)
    check("hotkeys: Ctrl+Option+T and Ctrl+Option+N", HotKeyAction.togglePanel.keyCode == UInt32(kVK_ANSI_T)
          && HotKeyAction.newTask.keyCode == UInt32(kVK_ANSI_N) && HotKeyAction.newTask.modifiers == UInt32(controlKey | optionKey)
          && HotKeyAction(rawValue: 1) == .togglePanel && HotKeyAction(rawValue: 3) == nil)

    // Displays.
    let wide = NSRect(x: 0, y: 0, width: 1440, height: 900)
    check("display key: the UUID first", displayKey(uuid: "ABC-1", name: "Studio Display", frame: wide) == "uuid:ABC-1")
    check("display key: else the name and frame", displayKey(uuid: nil, name: "Studio Display", frame: NSRect(x: -1920, y: 0, width: 1920, height: 1080))
          == "name:Studio Display@-1920,0,1920x1080" && displayKey(uuid: " ", name: "A", frame: wide) == "name:A@0,0,1440x900")
    let pill = NSSize(width: 60, height: 26)
    let visible = NSRect(x: 0, y: 0, width: 1440, height: 875)
    check("clamp: inside stays", clampedOrigin(NSPoint(x: 100, y: 100), size: pill, in: visible) == NSPoint(x: 100, y: 100))
    check("clamp: past the right top corner comes back", clampedOrigin(NSPoint(x: 2000, y: 2000), size: pill, in: visible)
          == NSPoint(x: 1380, y: 849))
    check("clamp: left of a display on the left comes back", clampedOrigin(NSPoint(x: -3000, y: -5), size: pill,
          in: NSRect(x: -1920, y: 0, width: 1920, height: 1055)) == NSPoint(x: -1920, y: 0))
    let topRight = relativeSpot(NSPoint(x: 1380, y: 849), size: pill, in: visible)
    check("spot: the top right corner is (1, 1)", topRight == NSPoint(x: 1, y: 1))
    check("spot: stays the top right corner on a bigger display", absoluteOrigin(topRight, size: pill, in: NSRect(x: 1440, y: 0, width: 2560, height: 1415))
          == NSPoint(x: 3940, y: 1389))
    let middle = relativeSpot(NSPoint(x: 690, y: 424.5), size: pill, in: visible)
    check("spot: the middle is kept as a fraction", abs(middle.x - 0.5) < 0.001 && abs(middle.y - 0.5) < 0.001
          && absoluteOrigin(middle, size: pill, in: visible) == NSPoint(x: 690, y: 425))
    check("spot: out of range is clamped", relativeSpot(NSPoint(x: -50, y: 5000), size: pill, in: visible) == NSPoint(x: 0, y: 1))
    check("choose: the display it was placed on when connected", chooseDisplay(preferred: "uuid:B", current: "uuid:A",
          connected: ["uuid:A", "uuid:B"], saved: ["uuid:A", "uuid:B"]) == "uuid:B")
    check("choose: else the one it is on now", chooseDisplay(preferred: "uuid:B", current: "uuid:A", connected: ["uuid:A"], saved: ["uuid:A", "uuid:B"])
          == "uuid:A")
    check("choose: nothing saved there keeps it where it is", chooseDisplay(preferred: "uuid:B", current: "uuid:A", connected: ["uuid:A"],
          saved: ["uuid:B"]) == nil)

    // The controller, offscreen: nothing registered, nothing on screen.
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let window = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:1", token: "t"), parentPID: nil, options: options)
    var paths: [String] = []
    var answer: ((Data?, Int) -> Void)?
    window.requestHook = { request, done in
        paths.append(request.url?.path ?? "")
        if request.url?.path == "/api/attention/widget/prefs" { answer = done }
    }
    window.openURL = { _ in }
    window.announce = { _ in }
    var clock = Date(timeIntervalSince1970: 3_000_000)
    window.now = { clock }
    window.startPreferences()
    check("prefs: asked at start with the token path", paths.contains("/api/attention/widget/prefs"))
    check("hotkeys: wanted by default but never registered offscreen", window.testHotKeysWanted && !window.testHotKeysRegistered)
    answer?(Data("{\"hotkeys\":false,\"dim_when_idle\":true,\"show_activity\":false}".utf8), 200)
    check("prefs: applied", !window.testHotKeysWanted && !window.showActivity && window.testPrefs.dimWhenIdle)
    window.pollPrefs()
    answer?(Data("{\"error\":\"NOT_FOUND\"}".utf8), 404)
    check("prefs: a 404 goes back to the defaults", window.testHotKeysWanted && window.showActivity)
    let asked = paths.filter { $0 == "/api/attention/widget/prefs" }.count
    window.pollPrefs()
    check("prefs: not asked again before five minutes", paths.filter { $0 == "/api/attention/widget/prefs" }.count == asked)

    // The fade.
    window.loadForTest(sampleList())
    window.updateIdleFade()
    check("idle: full at first", window.testWidgetAlpha == 1)
    clock = clock.addingTimeInterval(31)
    window.updateIdleFade()
    check("idle: faded after 30 s", abs(window.testWidgetAlpha - idleAlpha) < 0.01)
    window.testShowNotices([WidgetNotice(seq: 1, title: "New")])
    check("idle: a new notice brings it back", window.testWidgetAlpha == 1)
    window.testClearNotices()
    clock = clock.addingTimeInterval(31)
    window.updateIdleFade()
    check("idle: fades again", abs(window.testWidgetAlpha - idleAlpha) < 0.01)
    var more = sampleList()
    more.items.append(decodeItem(["key": "local:99", "status": "waiting_user", "title": "One more question", "sort_order": 1])!)
    window.loadForTest(more)
    window.updateIdleFade()
    check("idle: a rise of Needs you brings it back", window.testWidgetAlpha == 1)
    clock = clock.addingTimeInterval(31)
    window.updateIdleFade()
    window.applyPrefs(WindowPrefs(hotkeys: true, dimWhenIdle: false, showActivity: true))
    check("idle: turned off goes back to full", window.testWidgetAlpha == 1)
    window.applyPrefs(WindowPrefs())

    // The shortcut opens and holds the panel; again closes it.
    window.loadForTest(sampleList())
    window.hotKeyPressed(.togglePanel)
    check("hotkey: the panel is held open and takes the keyboard", window.testPinned && window.testHolding() && window.testPanelAcceptsKey)
    check("keys: Esc on an empty search closes it", window.performPanelKey(.close) && !window.testPinned && !window.testPanelAcceptsKey)
    window.hotKeyPressed(.togglePanel)
    window.hotKeyPressed(.togglePanel)
    check("hotkey: pressed again closes it", !window.testPinned && !window.testHolding())
    window.hotKeyPressed(.togglePanel)
    window.hotKeyPressed(.newTask)
    check("hotkey: Ctrl+Option+N opens New task", (window.testOverlay as? TaskFormView) != nil && !window.testPinned && window.testHolding())
    window.testClose()

    // Search and the Finished group.
    window.loadForTest(sampleList())
    check("search: closed at first, the heading in its place", !window.testSearchExpanded && window.testHeading == "Tasks  11")
    window.testSearchButton()
    check("search: the magnifier opens the field above the list, with the keyboard", window.testSearchExpanded && window.testSearchBarAbove
          && window.testPinned && window.testPanelAcceptsKey)
    window.testSearchButton()
    check("search: the magnifier on an empty field closes it", !window.testSearchExpanded && !window.testPinned)
    check("search: Cmd+F opens it", window.performPanelKey(.focusSearch) && window.testSearchExpanded && window.testPinned)
    _ = window.performPanelKey(.close)
    check("search: closing the panel closes it", !window.testSearchExpanded && !window.testPinned)
    let header = window.testFinishedHeader()
    check("finished: collapsed by default with its count", header?.titleField.stringValue == "Finished" && header?.countField.stringValue == "3"
          && header?.triangle.stringValue == "\u{25B8}" && !window.testRowShown("local:1") && window.testLines.contains("Finished"))
    window.testToggleFinished()
    check("finished: opens to its rows", window.testFinishedHeader()?.triangle.stringValue == "\u{25BE}" && window.testRowShown("local:1")
          && window.testRowShown("local:2") && window.testRowShown("remote:7:1"))
    window.testToggleFinished()
    check("finished: closes again", !window.testRowShown("local:1"))
    window.testSearch("TRANSLATE")
    check("search: filters the rows", window.testRowShown("local:23") && !window.testRowShown("local:20") && !window.testRowShown("local:12"))
    check("search: empty sections say so", window.testLines.filter { $0 == "No matches" }.count == 2)
    window.testSearch("broken")
    check("search: finds finished rows in the closed group", window.testRowShown("local:2") && !window.testRowShown("local:1")
          && window.testFinishedHeader()?.countField.stringValue == "1" && window.testSearchExpanded)
    window.testSearch("blocked")
    check("search: matches the custom status", window.testRowShown("local:20") && !window.testRowShown("local:21"))
    var withNotes = sampleList()
    withNotes.items[0].notes = "Ask \u{5F20}\u{4E09} about the \u{6570}\u{636E}\u{5E93}"
    window.loadForTest(withNotes)
    window.testSearch("\u{6570}\u{636E}")
    check("search: matches notes, in Chinese", window.testRowShown(withNotes.items[0].key) && !window.testRowShown("local:20"))
    window.testDragBegin(withNotes.items[0].key, over: DebugDrag(source: withNotes.items[0].key, over: "@working", lowerHalf: false, onHeader: true))
    check("search: no reordering while filtered", !window.testRowDragActive)
    window.testDragCancel()
    window.testSearch("")
    let control = window.sendMouseDrag(DebugDrag(source: "local:23", over: "local:20", lowerHalf: false), stopBeforeRelease: true)
    check("search: reordering works again without a search", window.testRowDragActive && control.hit == "local:23")
    window.testDragCancel()
    window.testSearch("")
    check("search: cleared shows everything", window.testRowShown("local:20") && window.testRowShown("local:12"))
    stringTable = ["Finished": "F", "No matches": "NM"]
    window.testSearch("zzz")
    check("strings: the Finished header and the empty text come from the table", window.testLines.contains("F") && window.testFinishedHeader()?.countField.stringValue == "0"
          && window.testLines.contains("NM"))
    stringTable = [:]
    window.testSearch("")
    check("part D: no window was put on screen", !window.testOnScreen)
}
