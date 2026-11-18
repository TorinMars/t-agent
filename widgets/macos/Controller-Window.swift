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

        let background = makeBackground(radius: widgetHeight / 2)
        background.frame = root.bounds
        background.autoresizingMask = [.width, .height]
        root.addSubview(background)

        countLabel.alignment = .center
        countLabel.textColor = .labelColor
        countLabel.font = .monospacedDigitSystemFont(ofSize: 14, weight: .semibold)
        caption.stringValue = L("Tasks")  // no longer drawn: the window's tooltip and accessibility label
        root.toolTip = caption.stringValue
        root.setAccessibilityLabel(caption.stringValue)

        badge.wantsLayer = true
        badge.layer?.backgroundColor = NSColor.systemRed.cgColor
        badge.layer?.cornerRadius = badgeHeight / 2
        badge.isHidden = true
        badgeLabel.font = .monospacedDigitSystemFont(ofSize: 10, weight: .bold)
        badgeLabel.textColor = .white
        badgeLabel.alignment = .center
        badge.addSubview(badgeLabel)

        root.addSubview(countLabel)
        root.addSubview(badge)
        root.addSubview(live.indicator)
        widget.contentView = root
        updateCollapsed()
    }

    func updateCollapsed() {
        countLabel.stringValue = summary.map { String($0.unfinished) } ?? "\u{2013}"
        let needs = summary?.needs.count ?? 0
        badge.isHidden = needs == 0
        badgeLabel.stringValue = String(needs)
        layoutCollapsed()
    }

    /// Lays the pill out from left to right (count, then the badge) and fits the window's width to it. The width
    /// changes only between drags; the edge nearer the screen's side stays where it is.
    private func layoutCollapsed() {
        let side: CGFloat = 9
        let gap: CGFloat = 5
        countLabel.sizeToFit()
        let countSize = countLabel.frame.size
        var badgeWidth: CGFloat = 0
        if !badge.isHidden {
            badgeLabel.sizeToFit()
            badgeWidth = max(badgeHeight, ceil(badgeLabel.frame.width) + 8)
        }
        let activityWidth = layoutActivityIndicator()  // 0 when there is no live activity to show
        let content = ceil(countSize.width) + (badge.isHidden ? 0 : gap + badgeWidth) + (activityWidth > 0 ? gap + 1 + activityWidth : 0)
        let width = max(widgetMinWidth, content + side * 2)
        var x = (width - content) / 2
        countLabel.frame = NSRect(x: x, y: floor((widgetHeight - countSize.height) / 2), width: ceil(countSize.width),
                                  height: countSize.height)
        x += ceil(countSize.width) + gap
        if !badge.isHidden {
            badge.frame = NSRect(x: x, y: (widgetHeight - badgeHeight) / 2, width: badgeWidth, height: badgeHeight)
            let labelHeight = badgeLabel.frame.height
            badgeLabel.frame = NSRect(x: 0, y: floor((badgeHeight - labelHeight) / 2), width: badgeWidth, height: labelHeight)
            x += badgeWidth + gap
        }
        if activityWidth > 0 {
            live.indicator.frame = NSRect(x: x + 1, y: 0, width: activityWidth, height: widgetHeight)
        }
        guard !dragging, abs(widget.frame.width - width) > 0.5 else { return }
        var frame = widget.frame
        let visible = (widget.screen ?? NSScreen.main)?.visibleFrame
        if let visible = visible, frame.midX > visible.midX { frame.origin.x = frame.maxX - width }  // keep the right edge
        frame.size = NSSize(width: width, height: widgetHeight)
        widget.setFrame(keptOnScreen(frame), display: !options.offscreen)
        if detail.isVisible { positionDetail() }
        positionBubble()
    }

    func initialOrigin() -> NSPoint {
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
        if !options.persistPosition {
            return NSPoint(x: visible.minX + 16, y: visible.minY + 16)
        }
        if let placed = placedForDisplays() { return placed.origin }  // Part D: the spot saved for this display
        if defaults.object(forKey: "x") != nil, defaults.object(forKey: "y") != nil {
            let saved = NSRect(x: defaults.double(forKey: "x"), y: defaults.double(forKey: "y"),
                               width: widget.frame.width, height: widgetHeight)
            return keptOnScreen(saved).origin
        }
        return NSPoint(x: visible.maxX - widget.frame.width - 16, y: visible.maxY - widgetHeight - 16)
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
        layoutCollapsed()  // a width change held back during the drag
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
        var lineViews: [NSView] = [titleField]
        lineViews += buttons
        if let tag = row.tag { lineViews.append(EnginePill(tag)) }
        let line = NSStackView(views: lineViews)
        line.orientation = .horizontal
        line.alignment = .centerY
        line.spacing = 1
        line.setCustomSpacing(6, after: titleField)
        if let last = buttons.last, row.tag != nil { line.setCustomSpacing(5, after: last) }
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
        view.toolTip = full
        view.setAccessibilityElement(true)
        view.setAccessibilityRole(.group)
        view.setAccessibilityLabel(full.replacingOccurrences(of: "\n", with: ". "))
        view.setAccessibilityCustomActions(actions.map { action in
            NSAccessibilityCustomAction(name: action == .link ? L("Open link: {1}", row.linkTitle) : action.label) { [weak self] in
                guard let self = self else { return false }
                self.performRowAction(key, action)
                return true
            }
        })
        view.actionsAlwaysShown = actionsAlwaysShown || alwaysShowRowActions()
        view.onPress = { [weak self] in self?.rowPressed(key) }
        view.onDragBegin = { [weak self] in self?.rowDragBegan(key) }
        view.onDragMove = { [weak self] event in self?.rowDragMoved(event) }
        view.onDragEnd = { [weak self] in self?.rowDragEnded() }
        view.onRelease = { [weak self] in self?.rowReleased() }
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
        out.append(plain(row.title.isEmpty ? "\u{2013}" : row.title))
        out.addAttribute(.paragraphStyle, value: truncating, range: NSRange(location: 0, length: out.length))
        return out
    }

    /// The second line: the custom status, then what is pending, else why it needs you, else its result.
    private func rowSecondLine(_ row: Row) -> String {
        [row.custom, row.detail].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
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
