// T-Attention desktop widget: the controller, offscreen checks and renders. See main.swift for the overview and the build.
import AppKit

extension WidgetController {
    // MARK: Offscreen checks and renders

    /// Lays the panel out for this list without showing it or using the network.
    func loadForTest(_ newList: ItemList?, problem: String? = nil, scroll: CGFloat = 0) {
        toast.isHidden = true
        toastTimer?.invalidate()
        toastTimer = nil
        if let newList = newList { applyLocal(newList) } else { apply(nil, problem: problem ?? L("Could not reach T-Agent")) }
        positionDetail()
        detail.contentView?.layoutSubtreeIfNeeded()
        scrollList(to: scroll)
    }

    func scrollList(to y: CGFloat) {
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    /// Where a drag's pointer ends, in the list's (flipped) coordinates.
    private func debugDocumentY(_ step: DebugDrag) -> CGFloat? {
        let named: [String: Section] = ["@needs": .needs, "@working": .working, "@todo": .todo, "@done": .done]
        if let section = named[step.over.lowercased()] {
            guard let title = sectionHeaders[section] else { return nil }
            return title.convert(title.bounds, to: documentView).midY
        }
        guard let frame = frameInDocument(step.over) else { return nil }
        if step.onHeader {
            guard let title = sectionTitles[step.over] else { return nil }
            return title.convert(title.bounds, to: documentView).midY
        }
        return step.lowerHalf ? frame.maxY - frame.height * 0.25 : frame.minY + frame.height * 0.25
    }

    func mouseEvent(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: detail.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                           pressure: type == .leftMouseUp ? 0 : 1)!
    }

    /// One whole drag as NSEvents, delivered in-process (the real pointer never moves): the press is hit-tested
    /// through the panel as AppKit would, then the view that took it gets mouseDown, mouseDragged and mouseUp.
    @discardableResult
    func sendMouseDrag(_ step: DebugDrag, stopBeforeRelease: Bool = false) -> MouseDragResult {
        func nothing(_ hit: String) -> MouseDragResult {
            MouseDragResult(hit: hit, decision: .noChange, lineShown: false, toast: "", highlight: "")
        }
        guard let source = rowViews[step.source], let y = debugDocumentY(step), let root = detail.contentView else {
            return nothing("missing")
        }
        let end = documentView.convert(NSPoint(x: 40, y: y), to: nil)
        let start = source.convert(NSPoint(x: 40, y: source.bounds.midY), to: nil)
        let taken = root.hitTest(root.superview?.convert(start, from: nil) ?? start)
        guard let row = taken as? TaskRowView else { return nothing(taken.map { String(describing: type(of: $0)) } ?? "nothing") }
        let hit = rowViews.first { $0.value === row }?.key ?? "unknown row"
        row.mouseDown(with: mouseEvent(.leftMouseDown, start))
        let steps = 8
        for index in 1...steps {
            let t = CGFloat(index) / CGFloat(steps)
            row.mouseDragged(with: mouseEvent(.leftMouseDragged, NSPoint(x: start.x + (end.x - start.x) * t,
                                                                          y: start.y + (end.y - start.y) * t)))
        }
        let decision = drop
        let lineShown = !insertionLine.isHidden
        let highlighted = dropHighlight.isHidden ? "" : dropHint.stringValue
        if stopBeforeRelease {
            return MouseDragResult(hit: hit, decision: decision, lineShown: lineShown, toast: "", highlight: highlighted)
        }
        row.mouseUp(with: mouseEvent(.leftMouseUp, end))
        return MouseDragResult(hit: hit, decision: decision, lineShown: lineShown, toast: toast.isHidden ? "" : toastLabel.stringValue,
                               highlight: highlighted)
    }

    func testOpenCreate() -> TaskFormView? {
        plusButton.performClick(nil)
        return overlay as? TaskFormView
    }

    func testOpenFromRowMenu(_ key: String, _ title: String) -> OverlayView? {
        guard let menu = rowViews[key]?.menu(for: mouseEvent(.rightMouseDown, .zero)) else { return nil }
        let index = menu.indexOfItem(withTitle: title)
        guard index >= 0 else { return nil }
        menu.performActionForItem(at: index)
        return overlay
    }

    func testMenuTitles(_ key: String) -> [String] {
        rowViews[key]?.menu(for: mouseEvent(.rightMouseDown, .zero))?.items.filter { !$0.isSeparatorItem }.map { $0.title } ?? []
    }

    func testPanelMenuTitles() -> [String] {
        detail.contentView?.menu(for: mouseEvent(.rightMouseDown, .zero))?.items.map { $0.title } ?? []
    }

    func testButtonMenuTitles(_ key: String) -> [String] {
        rowViews[key]?.actionButtons.first?.menu(for: mouseEvent(.rightMouseDown, .zero))?.items
            .filter { !$0.isSeparatorItem }.map { $0.title } ?? []
    }

    func testHitAtRow(_ key: String) -> NSView? {
        guard let row = rowViews[key], let root = detail.contentView else { return nil }
        let point = row.convert(NSPoint(x: 40, y: row.bounds.midY), to: nil)
        return root.hitTest(root.superview?.convert(point, from: nil) ?? point)
    }

    /// A plain click on a row (a mouse down and up without movement, delivered in-process to what the panel's hit test
    /// gives at the row's left part). False when the press does not reach the row.
    @discardableResult
    func testClickRow(_ key: String) -> Bool {
        guard let row = rowViews[key], let root = detail.contentView else { return false }
        let point = row.convert(NSPoint(x: 40, y: row.bounds.midY), to: nil)
        guard let taken = root.hitTest(root.superview?.convert(point, from: nil) ?? point) as? TaskRowView, taken === row else { return false }
        row.mouseDown(with: mouseEvent(.leftMouseDown, point))
        row.mouseUp(with: mouseEvent(.leftMouseUp, point))
        return true
    }

    func testPressButton(_ key: String, _ action: RowAction) -> Bool {
        guard let button = rowViews[key]?.actionButtons.first(where: { $0.rowAction == action }) else { return false }
        button.performClick(nil)
        return true
    }

    /// --render-sample: forgets an action whose request is never answered there.
    func testFinishActionsForRender() {
        actionsRunning = 0
        actionRows.removeAll()
        syncActionButtons()
    }
    /// As if actionDebounce had passed since every action taken so far.
    func testLetActionPausePass() { lastActionAt = lastActionAt.mapValues { $0.addingTimeInterval(-actionDebounce) } }
    func testRowPending(_ key: String) -> Bool { rowViews[key]?.pending ?? false }
    func testSpinnerShown(_ key: String) -> Bool { rowViews[key]?.spinner.map { !$0.isHidden } ?? false }
    func testShownButtons(_ key: String) -> [RowAction] { rowViews[key]?.actionButtons.filter { !$0.isHidden }.map { $0.rowAction } ?? [] }
    func testRowAlpha(_ key: String) -> CGFloat { rowViews[key]?.alphaValue ?? 0 }
    func testButtonsEnabled(_ key: String) -> [Bool] { rowViews[key]?.actionButtons.map { $0.isEnabled } ?? [] }
    func testButtonTitles(_ key: String) -> [String] { rowViews[key]?.actionButtons.map { $0.label } ?? [] }
    func testButton(_ key: String, _ action: RowAction) -> ActionButton? {
        rowViews[key]?.actionButtons.first { $0.rowAction == action }
    }
    func testRowHeight(_ key: String) -> CGFloat { rowViews[key]?.frame.height ?? 0 }
    /// Whether the panel gives a press in the middle of the button to the button (and not to its row), with the
    /// pointer over the row (the icons of a row outside Needs you show only then).
    func testButtonTakesPress(_ key: String, _ action: RowAction) -> Bool {
        guard let button = testButton(key, action), let row = rowViews[key], let root = detail.contentView else { return false }
        let wasHovered = row.hovered
        row.setHovered(true)
        defer { row.setHovered(wasHovered) }
        row.layoutSubtreeIfNeeded()
        let point = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
        return root.hitTest(root.superview?.convert(point, from: nil) ?? point) === button
    }
    /// Whether every button of the row lies inside the row, clear of the engine tag and of the other buttons, while they
    /// show (the pointer over the row).
    func testButtonsInside(_ key: String) -> Bool {
        guard let row = rowViews[key] else { return false }
        let wasHovered = row.hovered
        row.setHovered(true)
        defer { row.setHovered(wasHovered) }
        row.layoutSubtreeIfNeeded()
        let pills = [testPill(key)].compactMap { $0 }.map { $0.convert($0.bounds, to: row) }
        let frames = row.actionButtons.map { $0.convert($0.bounds, to: row) }
        return frames.enumerated().allSatisfy { index, frame in
            frame.width > 0 && frame.minX >= 0 && frame.maxX <= row.bounds.width + 0.5 && frame.minY >= -0.5
                && frame.maxY <= row.bounds.height + 0.5 && !pills.contains { $0.intersects(frame) }
                && !frames.enumerated().contains { $0.offset != index && $0.element.intersects(frame) }
        }
    }
    func testHasPill(_ key: String) -> Bool { testPill(key) != nil }
    /// The engine tag of a row (it sits in the row's title line).
    func testPill(_ key: String) -> EnginePill? {
        guard let row = rowViews[key] else { return nil }
        func find(_ view: NSView) -> EnginePill? {
            if let pill = view as? EnginePill { return pill }
            for child in view.subviews { if let found = find(child) { return found } }
            return nil
        }
        return find(row)
    }
    func testRowView(_ key: String) -> TaskRowView? { rowViews[key] }
    func testRowTooltip(_ key: String) -> String { rowViews[key]?.toolTip ?? "" }
    /// The title field of a row: the first text field of its title line.
    func testTitleField(_ key: String) -> NSTextField? {
        (rowViews[key]?.subviews.first { $0 is NSStackView } as? NSStackView)?.arrangedSubviews.first { $0 is NSTextField } as? NSTextField
    }
    /// The second line of a row, or nil.
    func testSecondLine(_ key: String) -> NSTextField? { rowViews[key]?.subviews.first { $0 is NSTextField } as? NSTextField }
    /// Whether the row's title is cut with an ellipsis (its one-line width is more than the field has).
    func testTitleTruncated(_ key: String) -> Bool {
        guard let field = testTitleField(key) else { return false }
        rowViews[key]?.layoutSubtreeIfNeeded()
        return field.attributedStringValue.size().width > field.frame.width + 1
    }
    func testHolding() -> Bool { holdsPanel }
    func testSectionHeader(_ section: Section) -> SectionHeaderView? { sectionHeaders[section] as? SectionHeaderView }
    var testBackgroundVeiled: Bool {
        guard let blur = detail.contentView?.subviews.first(where: { $0 is NSVisualEffectView }) as? NSVisualEffectView else { return false }
        return blur.material == .menu && blur.subviews.contains { $0 is BackgroundVeilView } && backgroundVeil >= 0.8
    }
    var testPlusIsIcon: Bool { plusButton.isIcon }
    func testApply(_ newList: ItemList?) { apply(newList, problem: newList == nil ? L("Could not reach T-Agent") : nil) }
    func testClose() { closeOverlay() }
    func testStringsChanged() { stringsChanged() }
    func testRefresh() { refresh() }
    var testPanelCanBecomeKey: Bool { detail.canBecomeKey }
    var testToast: String { toast.isHidden ? "" : toastLabel.stringValue }
    var testOverlay: OverlayView? { overlay }
    /// The capsule's rows, top to bottom: open tasks, Needs you, running.
    var testCount: String { capsule.rows[0].stringValue }
    var testBadge: String { capsule.rows[1].stringValue }
    var testRunning: String { capsule.rows[2].stringValue }
    var testCapsule: CapsuleView { capsule }
    var testDetailFrame: NSRect { detail.frame }
    var testTooltip: String { widgetRoot?.toolTip ?? "" }
    var testWidgetWidth: CGFloat { widget.frame.width }
    var testWidgetHeight: CGFloat { widget.frame.height }
    var testOnScreen: Bool { widget.isVisible || detail.isVisible || bubble.isVisible }
    var testLines: [String] {
        stack.arrangedSubviews.compactMap { view in
            if let field = view as? NSTextField { return field.stringValue }
            if let row = view as? TaskRowView, let key = rowViews.first(where: { $0.value === row })?.key {
                return testTitleField(key)?.stringValue
            }
            return (view.subviews.first { $0 is NSTextField } as? NSTextField)?.stringValue
        }
    }
    var testOrder: String {
        guard let summary = summary else { return "(no data)" }
        func keys(_ rows: [Row]) -> String { rows.map { $0.key }.joined(separator: " ") }
        return "needs[\(keys(summary.needs))] working[\(keys(summary.working))] todo[\(keys(summary.todo))] done \(summary.done)"
    }
    var testPlusHit: Bool {
        guard let root = detail.contentView else { return false }
        let point = plusButton.convert(NSPoint(x: 5, y: 5), to: nil)
        return root.hitTest(root.superview?.convert(point, from: nil) ?? point) === plusButton
    }
    var testMenuOpen: Bool {
        get { menuOpen }
        set { if newValue { menuWillOpen(NSMenu()) } else { menuOpen = false } }
    }

    /// Writes the panel (and the collapsed window) offscreen.
    func renderPanel(_ path: String, dark: Bool) -> Bool {
        guard let view = detail.contentView else { return false }
        return renderView(view, to: path, background: dark ? NSColor(white: 0.17, alpha: 1) : NSColor(white: 0.94, alpha: 1))
    }

    func renderWidget(_ path: String, dark: Bool) -> Bool {
        guard let view = widget.contentView else { return false }
        return renderView(view, to: path, background: dark ? NSColor(white: 0.17, alpha: 1) : NSColor(white: 0.94, alpha: 1))
    }

    /// The capsule showing each of `states`, side by side 24 pt apart, at 2x, on the plain background of renderWidget.
    func renderCapsuleStates(_ path: String, _ states: [CapsuleCounts], dark: Bool) -> Bool {
        guard let view = widget.contentView else { return false }
        defer { updateCollapsed() }
        let gap: CGFloat = 24
        let size = NSSize(width: gap + CGFloat(states.count) * (widgetWidth + gap), height: widgetHeight + gap * 2)
        let scale: CGFloat = 2
        guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: out) else { return false }
        var reps: [NSBitmapImageRep] = []
        for counts in states {
            capsule.show(counts)
            view.layoutSubtreeIfNeeded()
            guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
            view.cacheDisplay(in: view.bounds, to: rep)
            reps.append(rep)
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let transform = NSAffineTransform()
        transform.scale(by: scale)
        transform.concat()
        (dark ? NSColor(white: 0.17, alpha: 1) : NSColor(white: 0.94, alpha: 1)).setFill()
        NSRect(origin: .zero, size: size).fill()
        for (index, rep) in reps.enumerated() {
            let rect = NSRect(x: gap + CGFloat(index) * (widgetWidth + gap), y: gap, width: widgetWidth, height: widgetHeight)
            rep.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        }
        NSGraphicsContext.restoreGraphicsState()
        guard let png = out.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: URL(fileURLWithPath: path))) != nil
    }

    func setAppearance(dark: Bool) {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        widget.appearance = appearance
        detail.appearance = appearance
        bubble.appearance = appearance
    }

    func testDragBegin(_ key: String, over step: DebugDrag) {
        _ = sendMouseDrag(DebugDrag(source: key, over: step.over, lowerHalf: step.lowerHalf, onHeader: step.onHeader),
                          stopBeforeRelease: true)
    }

    func testDragCancel() { cancelRowDrag() }

    // The notice bubble, for --self-test and --render-sample.
    func testShowNotices(_ notices: [WidgetNotice]) { enqueue(notices) }
    func testClearNotices() {
        noticeQueue.clear()
        hideBubble()
    }
    var testBubbleView: NoticeBubbleView? { bubbleView }
    var testBubbleTitle: String? { bubbleView?.notice.title }
    var testBubbleMore: String { bubbleView.map { $0.moreField.superview == nil ? "" : $0.moreField.stringValue } ?? "" }
    var testBubbleFrame: NSRect { bubble.frame }
    var testBubbleSeconds: TimeInterval? { bubbleSeconds }
    var testBubbleSlides: Bool { bubbleSlides }
    var testBubbleCanBecomeKey: Bool { bubble.canBecomeKey }
    var testNoticesWaiting: Int { noticeQueue.waiting.count }
    var testLastSeq: Int? { noticePoll.lastSeq }
    var testWidgetFrame: NSRect { widget.frame }
    func testBubbleClick() { bubbleView?.onClick() }
    func testBubbleClose() { bubbleView?.closeButton.performClick(nil) }
    func testBubbleEnter() { bubbleView?.mouseEntered(with: mouseEvent(.mouseMoved, .zero)) }
    func testBubbleExit() { bubbleView?.mouseExited(with: mouseEvent(.mouseMoved, .zero)) }
    func testBubbleTimeout() { if bubbleSeconds != nil { bubbleTimedOut() } }
    /// What a press at a point of the bubble (in its own coordinates) lands on.
    func testBubbleHit(_ point: NSPoint) -> NSView? {
        guard let view = bubbleView else { return nil }
        return view.hitTest(view.convert(point, to: view.superview))
    }
    /// A mouse down and up at the middle of the bubble, through its hit test.
    func testBubblePress() {
        guard let view = bubbleView, let taken = testBubbleHit(NSPoint(x: 60, y: view.bounds.midY)) else { return }
        let point = view.convert(NSPoint(x: 60, y: view.bounds.midY), to: nil)
        taken.mouseDown(with: mouseEvent(.leftMouseDown, point))
        taken.mouseUp(with: mouseEvent(.leftMouseUp, point))
    }
    /// Puts the window near the top-right (or top-left) corner of the main screen, as a drag would end.
    func testPlaceWidget(right: Bool) {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = right ? visible.maxX - widget.frame.width - 16 : visible.minX + 16
        widget.setFrameOrigin(NSPoint(x: x, y: visible.maxY - widgetHeight - 16))
        positionBubble()
    }
    /// Moves the window the way a drag does, step by step through the drag view.
    func testDragWidget(to origin: NSPoint) {
        widget.setFrameOrigin(origin)
        widgetRoot?.onDragMove()
    }

    /// The window and the bubble where they are on screen, on a desktop-like background, offscreen.
    func renderBubbleScene(_ path: String, dark: Bool) -> Bool {
        guard let pill = widget.contentView, let view = bubble.contentView else { return false }
        let margin: CGFloat = 20
        let union = widget.frame.union(bubble.frame)
        let size = NSSize(width: ceil(union.width + margin * 2), height: ceil(union.height + margin * 2))
        let scale: CGFloat = 2
        guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: out) else { return false }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let transform = NSAffineTransform()
        transform.scale(by: scale)
        transform.concat()
        (dark ? NSColor(white: 0.09, alpha: 1) : NSColor(white: 0.82, alpha: 1)).setFill()
        NSRect(origin: .zero, size: size).fill()
        for (window, content, radius) in [(widget as NSWindow, pill, widgetWidth / 2), (bubble as NSWindow, view, CGFloat(12))] {
            content.layoutSubtreeIfNeeded()
            // The blur draws only a grey veil offscreen; the plain fill below stands in for it.
            let blurs = content.subviews.filter { $0 is NSVisualEffectView }
            blurs.forEach { $0.isHidden = true }
            defer { blurs.forEach { $0.isHidden = false } }
            guard let rep = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { continue }
            content.cacheDisplay(in: content.bounds, to: rep)
            let rect = NSRect(x: window.frame.minX - union.minX + margin, y: window.frame.minY - union.minY + margin,
                              width: window.frame.width, height: window.frame.height)
            NSGraphicsContext.saveGraphicsState()
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(dark ? 0.6 : 0.25)
            shadow.shadowBlurRadius = 10
            shadow.shadowOffset = NSSize(width: 0, height: -3)
            shadow.set()
            (dark ? NSColor(white: 0.21, alpha: 1) : NSColor(white: 0.98, alpha: 1)).setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            NSGraphicsContext.restoreGraphicsState()
            rep.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        }
        NSGraphicsContext.restoreGraphicsState()
        guard let png = out.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: URL(fileURLWithPath: path))) != nil
    }
}
