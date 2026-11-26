// T-Attention desktop widget: the controller, the collapsed window and the detail panel. See main.swift for the overview and the build.
import AppKit

extension WidgetController {
    // MARK: Collapsed window

    func buildWidget() {
        let root = DragView(frame: NSRect(origin: .zero, size: widgetSize))
        root.onEnter = { [weak self] in self?.pointerEntered() }
        root.onExit = { [weak self] in self?.pointerExited() }
        root.onDragBegin = { [weak self] in self?.dragBegan() }
        root.onDragMove = { [weak self] in self?.positionBubble() }  // the bubble follows the window
        root.onDragEnd = { [weak self] in self?.dragEnded() }
        root.menu = makeMenu([])
        widgetRoot = root

        let background = makeBackground(radius: widgetWidth / 2)
        background.frame = root.bounds
        background.autoresizingMask = [.width, .height]
        root.addSubview(background)
        root.addSubview(capsule)
        widget.contentView = root
        updateCollapsed()
    }

    /// The capsule's three numbers, and its tooltip and VoiceOver label, from the list and the live activity. The size
    /// never changes, so nothing beside the capsule moves.
    func updateCollapsed() {
        let counts = capsuleCounts()
        capsule.show(counts)
        let text = summary == nil ? (problem ?? L("Tasks")) : capsuleSpeech(counts)
        widgetRoot?.toolTip = text
        widgetRoot?.setAccessibilityLabel(text)
    }

    /// Open tasks, Needs you merged with the waiting terminals (needsYouCount), and the running terminals (0 while
    /// "Show what agents are doing" is off). The first two are nil while there is no list.
    func capsuleCounts() -> CapsuleCounts {
        let terminals = showActivity ? live.terminals : []
        let running = activityCounts(terminals).running
        guard let summary = summary else { return CapsuleCounts(open: nil, needs: nil, running: running) }
        let keys = Set(summary.needs.map { $0.key })
        let needs = (list?.items ?? []).filter { keys.contains($0.key) }
        return CapsuleCounts(open: summary.unfinished, needs: needsYouCount(needs, terminals: terminals), running: running)
    }

    func initialOrigin() -> NSPoint {
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
        if !options.persistPosition {
            return NSPoint(x: visible.minX + 16, y: visible.minY + 16)
        }
        if let placed = placedForDisplays() { return placed.origin }  // Part D: the spot saved for this display
        if defaults.object(forKey: "x") != nil, defaults.object(forKey: "y") != nil {
            // A spot saved by the older, smaller pill is clamped with the capsule's size, so it stays on screen.
            let saved = NSRect(x: defaults.double(forKey: "x"), y: defaults.double(forKey: "y"),
                               width: widgetWidth, height: widgetHeight)
            return keptOnScreen(saved).origin
        }
        return NSPoint(x: visible.maxX - widgetWidth - 16, y: visible.maxY - widgetHeight - 16)
    }

    /// Moves rect fully inside the screen it overlaps most, or the main screen if it overlaps none.
    func keptOnScreen(_ rect: NSRect) -> NSRect {
        func overlap(_ screen: NSScreen) -> CGFloat {
            let common = rect.intersection(screen.visibleFrame)
            return common.isNull ? 0 : common.width * common.height
        }
        let best = NSScreen.screens.filter { overlap($0) > 0 }.max { overlap($0) < overlap($1) }
        guard let visible = (best ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else { return rect }
        var out = rect
        out.origin.x = min(max(out.origin.x, visible.minX), visible.maxX - out.width)
        out.origin.y = min(max(out.origin.y, visible.minY), visible.maxY - out.height)
        return out
    }

    private func dragBegan() {
        dragging = true
        cancelHide()
        if overlay == nil { hideDetail() }  // a form stays up, with whatever has been typed
    }

    private func dragEnded() {
        dragging = false
        widget.setFrame(keptOnScreen(widget.frame), display: true)
        positionBubble()
        if options.persistPosition {
            defaults.set(Double(widget.frame.origin.x), forKey: "x")
            defaults.set(Double(widget.frame.origin.y), forKey: "y")
            saveDisplayPosition()  // Part D
        }
        if overlay != nil || widget.frame.contains(NSEvent.mouseLocation) { showDetail() }
    }

    // MARK: Detail panel

    func buildDetail() {
        let root = HoverView(frame: NSRect(x: 0, y: 0, width: detailWidth, height: 120))
        root.onEnter = { [weak self] in self?.pointerEntered() }
        root.onExit = { [weak self] in self?.pointerExited() }
        detailRoot = root

        let background = makeBackground(radius: 12)
        background.frame = root.bounds
        root.addSubview(background)

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        stack.edgeInsets = NSEdgeInsets(top: detailPadding, left: detailPadding, bottom: detailPadding, right: detailPadding)
        stack.translatesAutoresizingMaskIntoConstraints = false
        documentView.frame = NSRect(x: 0, y: 0, width: detailWidth, height: 120)
        documentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: documentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: documentView.leadingAnchor),
            stack.widthAnchor.constraint(equalToConstant: detailWidth),
        ])

        scrollView.frame = root.bounds
        scrollView.autoresizingMask = [.width, .height]
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.documentView = documentView
        root.addSubview(scrollView)
        root.menu = makeMenu([])  // the row menu takes over on a row

        plusButton.target = self
        plusButton.action = #selector(plusClicked)
        plusButton.toolTip = L("New task")
        plusButton.setAccessibilityLabel(L("New task"))
        root.addSubview(plusButton)
        NSLayoutConstraint.activate([
            plusButton.topAnchor.constraint(equalTo: root.topAnchor, constant: 6),
            plusButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -8),
            plusButton.widthAnchor.constraint(equalToConstant: 22),
            plusButton.heightAnchor.constraint(equalToConstant: 22),
        ])

        insertionLine.wantsLayer = true
        insertionLine.layer?.backgroundColor = NSColor.controlAccentColor.cgColor
        insertionLine.layer?.cornerRadius = 1
        insertionLine.isHidden = true
        documentView.addSubview(insertionLine)

        dropHighlight.wantsLayer = true
        dropHighlight.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.18).cgColor
        dropHighlight.layer?.borderColor = NSColor.controlAccentColor.cgColor
        dropHighlight.layer?.borderWidth = 1
        dropHighlight.layer?.cornerRadius = 5
        dropHighlight.isHidden = true
        dropHint.font = .systemFont(ofSize: 10, weight: .semibold)
        dropHint.textColor = .controlAccentColor
        dropHint.alignment = .right
        dropHint.lineBreakMode = .byTruncatingHead
        dropHighlight.addSubview(dropHint)
        documentView.addSubview(dropHighlight, positioned: .below, relativeTo: stack)
        documentView.addSubview(insertionLine, positioned: .above, relativeTo: nil)  // over the highlight and the rows

        toast.wantsLayer = true
        toast.layer?.backgroundColor = NSColor.systemRed.withAlphaComponent(0.92).cgColor
        toast.layer?.cornerRadius = 6
        toast.isHidden = true
        toast.translatesAutoresizingMaskIntoConstraints = false
        toastLabel.font = .systemFont(ofSize: 11, weight: .medium)
        toastLabel.textColor = .white
        toastLabel.lineBreakMode = .byTruncatingTail
        toastLabel.translatesAutoresizingMaskIntoConstraints = false
        toast.addSubview(toastLabel)
        root.addSubview(toast)
        NSLayoutConstraint.activate([
            toast.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 8),
            toast.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -8),
            toast.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -8),
            toast.heightAnchor.constraint(equalToConstant: 24),
            toastLabel.leadingAnchor.constraint(equalTo: toast.leadingAnchor, constant: 8),
            toastLabel.trailingAnchor.constraint(equalTo: toast.trailingAnchor, constant: -8),
            toastLabel.centerYAnchor.constraint(equalTo: toast.centerYAnchor),
        ])
        installSearchBar(in: root)  // Part D
        detail.contentView = root
        rebuildDetail()
    }

    private func makeField(_ text: NSAttributedString, width: CGFloat = detailWidth - detailPadding * 2) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: "")
        field.attributedStringValue = text
        field.maximumNumberOfLines = 4
        field.cell?.truncatesLastVisibleLine = true
        field.preferredMaxLayoutWidth = width
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: width).isActive = true
        return field
    }

    @discardableResult
    func addLine(_ text: NSAttributedString, after spacing: CGFloat = 5) -> NSView {
        let field = makeField(text)
        stack.addArrangedSubview(field)
        stack.setCustomSpacing(spacing, after: field)
        return field
    }

    /// One row: the title on its own line (one line, an ellipsis when it does not fit), then at its right end the
    /// row's icon buttons and the engine tag; under it, smaller and muted, the custom status and what is pending (or
    /// why it needs you, or its result), at most two lines. A sub-task is indented under its parent with a "\u{2514}".
    /// The full title and second line are the row's tooltip and accessibility label.
    func addRow(_ row: Row, after spacing: CGFloat, actionsAlwaysShown: Bool) {
        let fullWidth = detailWidth - detailPadding * 2
        let view = TaskRowView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: fullWidth).isActive = true
        let key = row.key
        let indent = rowIndent(row)
        let actions = rowButtons(row)
        let buttons = actions.map { $0 == .link ? makeLinkButton(row) : makeActionButton($0, key) }
        view.actionButtons = buttons

        let titleField = NSTextField(labelWithAttributedString: rowTitleText(row))
        titleField.lineBreakMode = .byTruncatingTail
        titleField.maximumNumberOfLines = 1
        titleField.cell?.truncatesLastVisibleLine = true
        titleField.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        titleField.setContentHuggingPriority(.init(1), for: .horizontal)
        titleField.setAccessibilityElement(false)
        var lineViews: [NSView] = rowMarkView(row).map { [$0, titleField] } ?? [titleField]  // Part G: the symbol of a scheduled task
        lineViews += buttons
        // In place of the action buttons while the row's action is out (setPending).
        let spinner = actions.contains { !$0.opensOnly } ? makeRowSpinner() : nil
        if let spinner = spinner { lineViews.append(spinner) }
        view.spinner = spinner
        if let tag = row.tag { lineViews.append(EnginePill(tag)) }
        let line = NSStackView(views: lineViews)
        line.orientation = .horizontal
        line.alignment = .centerY
        line.spacing = 1
        line.setCustomSpacing(6, after: titleField)
        if lineViews.first !== titleField, let mark = lineViews.first { line.setCustomSpacing(3, after: mark) }
        if let last = buttons.last, row.tag != nil { line.setCustomSpacing(5, after: last) }
        if let spinner = spinner, row.tag != nil { line.setCustomSpacing(5, after: spinner) }
        line.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(line)
        let lineHeight: CGFloat = buttons.isEmpty && row.tag == nil ? 16 : rowIconSize
        NSLayoutConstraint.activate([
            line.topAnchor.constraint(equalTo: view.topAnchor),
            line.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            line.widthAnchor.constraint(equalToConstant: fullWidth),
            line.heightAnchor.constraint(equalToConstant: lineHeight),
        ])
        let second = rowSecondLine(row)
        if second.isEmpty {
            line.bottomAnchor.constraint(equalTo: view.bottomAnchor).isActive = true
        } else {
            let width = fullWidth - indent
            let field = NSTextField(wrappingLabelWithString: second)
            field.font = .systemFont(ofSize: 11)
            field.textColor = .secondaryLabelColor
            field.maximumNumberOfLines = 2
            field.lineBreakMode = .byWordWrapping  // two lines at most, the second cut with an ellipsis
            field.cell?.truncatesLastVisibleLine = true
            field.preferredMaxLayoutWidth = width
            field.setAccessibilityElement(false)
            field.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(field)
            NSLayoutConstraint.activate([
                field.topAnchor.constraint(equalTo: line.bottomAnchor, constant: 0),
                field.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: indent),
                field.widthAnchor.constraint(equalToConstant: width),
                field.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
        }
        let full = (row.title.isEmpty ? "\u{2013}" : row.title) + (second.isEmpty ? "" : "\n" + second)
        view.toolTip = full + "\n" + L("Click to open details")
        view.setAccessibilityElement(true)
        view.setAccessibilityRole(.group)
        view.setAccessibilityLabel(full.replacingOccurrences(of: "\n", with: ". "))
        // A click opens the details: VoiceOver's press does the same, and it is the last of the row's actions.
        view.setAccessibilityHelp(L("Open details"))
        view.onOpen = { [weak self] in self?.openItemPage(key) }
        view.setAccessibilityCustomActions(actions.map { action in
            NSAccessibilityCustomAction(name: action == .link ? L("Open link: {1}", row.linkTitle) : action.label) { [weak self] in
                guard let self = self else { return false }
                self.performRowAction(key, action)
                return true
            }
        } + [NSAccessibilityCustomAction(name: L("Open details")) { [weak self] in
            guard let self = self else { return false }
            self.openItemPage(key)
            return true
        }])
        view.actionsAlwaysShown = actionsAlwaysShown || alwaysShowRowActions()
        view.onPress = { [weak self] in self?.rowPressed(key) }
        view.onDragBegin = { [weak self] in self?.rowDragBegan(key) }
        view.onDragMove = { [weak self] event in self?.rowDragMoved(event) }
        view.onDragEnd = { [weak self] in self?.rowDragEnded() }
        view.onRelease = { [weak self] in self?.rowReleased(key) }
        view.contextMenu = { [weak self] in self?.rowMenu(key) }
        view.actionButtons.forEach { $0.contextMenu = view.contextMenu }
        stack.addArrangedSubview(view)
        stack.setCustomSpacing(spacing, after: view)
        rowViews[key] = view
    }

    /// Open link: the tooltip is the link's label, else its address; a click opens it and never reaches the row.
    private func makeLinkButton(_ row: Row) -> ActionButton {
        let button = makeActionButton(.link, row.key)
        button.toolTip = row.linkTitle
        button.setAccessibilityLabel(L("Open link: {1}", row.linkTitle))
        return button
    }

    private func makeActionButton(_ action: RowAction, _ key: String) -> ActionButton {
        let button = ActionButton(action, icon: true)
        button.target = self
        button.action = #selector(actionButtonClicked(_:))
        button.identifier = NSUserInterfaceItemIdentifier(key)
        button.onPress = { [weak self] in self?.actionButtonPressed() }
        button.onRelease = { [weak self] in self?.actionButtonReleased() }
        return button
    }

    func plain(_ text: String, size: CGFloat = 12, weight: NSFont.Weight = .regular,
                       color: NSColor = .labelColor) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: color,
        ])
    }

    /// The "\u{2514}" mark of a sub-task with its indent (three spaces a level beyond the first, at most three levels).
    private func childPrefix(_ row: Row) -> NSAttributedString? {
        guard row.isChild else { return nil }
        return plain(String(repeating: "   ", count: min(row.depth, 3) - 1) + "\u{2514} ", color: .secondaryLabelColor)
    }

    /// Where the title starts after the sub-task mark; the second line starts there too.
    private func rowIndent(_ row: Row) -> CGFloat {
        childPrefix(row).map { ceil($0.size().width) } ?? 0
    }

    /// The title line's text: the sub-task mark and the title, on one line.
    private func rowTitleText(_ row: Row) -> NSAttributedString {
        let out = NSMutableAttributedString()
        if let prefix = childPrefix(row) { out.append(prefix) }
        if row.mark != .none, rowMarkImage(row.mark) == nil { out.append(plain(row.mark.glyph + " ", color: .secondaryLabelColor)) }  // no symbols
        out.append(plain(row.title.isEmpty ? "\u{2013}" : row.title))
        out.addAttribute(.paragraphStyle, value: truncating, range: NSRange(location: 0, length: out.length))
        return out
    }

    /// The second line: the custom status, then what is pending, else why it needs you, else its result. A scheduled task
    /// shows its schedule line instead (Part G), except in Needs you, where why it needs you comes first.
    private func rowSecondLine(_ row: Row) -> String {
        let needsYou = !row.actions.isEmpty && !row.detail.isEmpty
        return [row.custom, row.schedule.isEmpty || needsYou ? row.detail : row.schedule].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    private func addSection(_ title: String, _ rows: [Row], _ section: Section, empty: String) {
        let header = SectionHeaderView(title: title, count: rows.isEmpty ? nil : rows.count, color: sectionColor(section),
                                       width: detailWidth - detailPadding * 2)
        stack.addArrangedSubview(header)
        stack.setCustomSpacing(rows.isEmpty ? 2 : 3, after: header)
        sectionHeaders[section] = header
        if rows.isEmpty {
            addLine(plain(empty, size: 11, color: .tertiaryLabelColor), after: 10)
            return
        }
        sectionTitles[rows[0].key] = header
        for (index, row) in rows.enumerated() {
            addRow(row, after: index == rows.count - 1 ? 10 : 5, actionsAlwaysShown: section == .needs)
        }
    }

    func rebuildDetail() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        rowViews = [:]
        sectionTitles = [:]
        sectionHeaders = [:]
        addActivitySection()
        if let summary = summary {
            let shown = searchResult(summary)  // Part D: the rows the search field leaves
            addSection(L("Needs you"), shown.needs, .needs, empty: shown.empty ?? L("Nothing needs you"))
            addSection(L("Working"), shown.working, .working, empty: shown.empty ?? L("None"))
            addSection(L("To do"), shown.todo, .todo, empty: shown.empty ?? L("None"))
            // Part G: the tasks that wait for their time, only when there are some.
            if !shown.scheduled.isEmpty { addSection(L("Scheduled"), shown.scheduled, .scheduled, empty: "") }
            if !shown.recurring.isEmpty { addSection(L("Recurring"), shown.recurring, .recurring, empty: "") }
            addFinishedGroup(shown, after: summary.failed.isEmpty ? 5 : 8)  // Part D: the Finished group
            for name in summary.failed {
                addLine(plain(L("Could not load {1}", name), size: 11, color: .tertiaryLabelColor), after: 3)
            }
        } else {
            addLine(plain(problem ?? L("Could not reach T-Agent"), color: .secondaryLabelColor))
        }
        syncActionButtons()
        updateHeading()  // Part D: "Tasks" and the count in the top row
        stack.layoutSubtreeIfNeeded()
        let listHeight = ceil(stack.fittingSize.height)
        contentHeight = listHeight + searchBarHeight  // Part D: the search field above the list
        documentView.setFrameSize(NSSize(width: detailWidth, height: listHeight))
    }

    func positionDetail() {
        let visible = (widget.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let height = min(max(contentHeight, overlay?.preferredHeight ?? 0), detailMaxHeight, visible.height - screenMargin * 2)
        let anchor = widget.frame
        var x = anchor.maxX + panelGap
        if x + detailWidth > visible.maxX - screenMargin {
            x = anchor.minX - panelGap - detailWidth
        }
        x = max(visible.minX + screenMargin, min(x, visible.maxX - screenMargin - detailWidth))
        var y = anchor.maxY - height
        y = max(visible.minY + screenMargin, min(y, visible.maxY - screenMargin - height))
        detail.setFrame(NSRect(x: x, y: y, width: detailWidth, height: height), display: !options.offscreen)
        if !options.offscreen { detail.invalidateShadow() }
        positionBubble()  // beside the panel now, so the two never overlap
    }

    func hideDetail() {
        detail.orderOut(nil)
        positionBubble()  // back beside the window
    }

    func showDetail() {
        cancelHide()
        let wasVisible = detail.isVisible
        positionDetail()
        if !wasVisible {
            scrollView.contentView.scroll(to: .zero)
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }
        orderFront(detail)
    }

    private func pointerEntered() {
        noteActivity()  // Part D: back to full opacity
        cancelHide()
        if !dragging { showDetail() }
    }

    private func pointerExited() {
        guard !holdsPanel else { return }
        cancelHide()
        let timer = Timer(timeInterval: hideDelay, repeats: false) { [weak self] _ in
            self?.hideTimer = nil
            self?.hideDetail()
        }
        RunLoop.main.add(timer, forMode: .common)
        hideTimer = timer
    }

    func cancelHide() {
        hideTimer?.invalidate()
        hideTimer = nil
    }

    // A toast counts so that a failure message is not closed away with the panel while it shows.
    var holdsPanel: Bool {
        dragging || pressedRow != nil || buttonHeld || !actionRows.isEmpty || toastTimer != nil || overlay != nil || menuOpen
            || partD.pinned  // Part D: opened with the shortcut or the search field
    }

    func hideIfPointerOutside() {
        guard !options.offscreen else { return }
        let mouse = NSEvent.mouseLocation
        if !widget.frame.contains(mouse) && !detail.frame.contains(mouse) { pointerExited() }
    }
}

/// The three numbers of the capsule; nil (shown as a dash) while there is no list.
struct CapsuleCounts: Equatable {
    var open: Int?
    var needs: Int?
    var running: Int
}

/// The red number: the Needs you items (waiting_user and review), plus the waiting terminals of GET /activity that no
/// Needs you item already stands for. A terminal and an item are the same thing when the item's session
/// (context.tagent, ItemSession) names the same engine, task id and terminal id as the terminal. GET /activity lists
/// only this machine's terminals (engine "local"), so an item of a connected service never takes one; an item without
/// a session takes none; a waiting terminal whose task has no Needs you item (for example one still in Working) counts
/// on its own. Each terminal counts once.
func needsYouCount(_ needs: [WidgetItem], terminals: [ActivityTerminal]) -> Int {
    func key(_ engine: String, _ task: String, _ terminal: String) -> String { engine + "\u{0}" + task + "\u{0}" + terminal }
    let taken = Set(needs.compactMap { item in item.session.map { key($0.engine, $0.taskId, $0.terminalId) } })
    var extra = Set<String>()
    for terminal in terminals where terminal.state == .waiting {
        let id = key(terminal.engine, terminal.taskID, terminal.terminalID)
        if !taken.contains(id) { extra.insert(id) }
    }
    return needs.count + extra.count
}

/// How a number is written in the capsule: a dash for none, "99+" above 99.
func capsuleText(_ value: Int?) -> String {
    guard let value = value else { return "\u{2013}" }
    return value > 99 ? "99+" : String(max(value, 0))
}

/// The tooltip and VoiceOver label of the capsule: "12 open · 6 need you · 1 running", with the exact numbers (also above 99).
func capsuleSpeech(_ counts: CapsuleCounts) -> String {
    func exact(_ value: Int?) -> String { value.map { String(max($0, 0)) } ?? "\u{2013}" }
    return L("{1} open · {2} need you · {3} running", exact(counts.open), exact(counts.needs), exact(counts.running))
}

let capsuleRowHeight: CGFloat = 26
let capsuleTextInset: CGFloat = 3  // the least room left and right of the text
let capsuleZeroAlpha: CGFloat = 0.38

/// The point size a row's text is drawn at: 13 pt, 12 pt when two digits do not fit; "99+" at 10 pt, else 9 pt.
func capsuleFontSize(_ text: String) -> CGFloat {
    let sizes: [CGFloat] = text == "99+" ? [10, 9] : [13, 12]
    let room = widgetWidth - capsuleTextInset * 2
    return sizes.first { capsuleTextWidth(text, size: $0) <= room } ?? sizes[sizes.count - 1]
}

func capsuleFont(_ size: CGFloat) -> NSFont { .monospacedDigitSystemFont(ofSize: size, weight: .semibold) }

func capsuleTextWidth(_ text: String, size: CGFloat) -> CGFloat {
    ceil(NSAttributedString(string: text, attributes: [.font: capsuleFont(size)]).size().width)
}

/// The teal of the running count: the activity teal in dark mode; in light mode a darker teal, since the system teal
/// on the light material is about 2.2:1 (this one about 4:1).
let capsuleTeal = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? toneColor("teal") : NSColor(srgbRed: 0, green: 0.49, blue: 0.57, alpha: 1)
}

/// The capsule's three rows, top to bottom, centred: open tasks in the label colour, Needs you in the badge red, running
/// agents in teal. Every row is always there; a zero (or a dash) is drawn dim (the row at capsuleZeroAlpha).
final class CapsuleView: NSView {
    let rows: [NSTextField] = (0..<3).map { _ in NSTextField(labelWithString: "\u{2013}") }
    static let colors: [NSColor] = [.labelColor, .systemRed, capsuleTeal]

    override init(frame: NSRect) {
        super.init(frame: frame)
        for row in rows {
            row.alignment = .center
            row.lineBreakMode = .byClipping
            row.setAccessibilityElement(false)  // the window reads the three numbers as one label
            addSubview(row)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // The window takes the presses (drag, hover, menu).
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func show(_ counts: CapsuleCounts) {
        let values: [Int?] = [counts.open, counts.needs, counts.running]
        let top = (bounds.height - capsuleRowHeight * 3) / 2
        for (index, row) in rows.enumerated() {
            let text = capsuleText(values[index])
            let dim = values[index] == nil || values[index] == 0
            row.stringValue = text
            row.font = capsuleFont(capsuleFontSize(text))
            row.textColor = CapsuleView.colors[index]  // dynamic, so it follows light and dark
            row.alphaValue = dim ? capsuleZeroAlpha : 1
            row.sizeToFit()
            let height = row.frame.height
            let rowTop = bounds.height - top - capsuleRowHeight * CGFloat(index + 1)
            row.frame = NSRect(x: 0, y: rowTop + floor((capsuleRowHeight - height) / 2), width: bounds.width, height: height)
        }
    }
}
