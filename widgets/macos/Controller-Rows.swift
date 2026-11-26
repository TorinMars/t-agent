// T-Attention desktop widget: the controller, reordering, menus, the form and the row actions. See main.swift for the overview and the build.
import AppKit

extension WidgetController {
    // MARK: Reordering

    var items: [WidgetItem] { list?.items ?? [] }

    private var rowsInDragSection: [Row] {
        guard let summary = summary, let source = pressedRow else { return [] }
        return [summary.needs, summary.working, summary.todo].first { $0.contains { $0.key == source } } ?? []
    }

    func frameInDocument(_ key: String) -> NSRect? {
        rowViews[key].map { $0.convert($0.bounds, to: documentView) }
    }

    func rowPressed(_ key: String) {
        // A release without a drag opens the task's details (rowReleased); never while a form or confirmation is open.
        clickedRow = overlay == nil ? key : nil
        // While an action is out the list is about to change, so a drop computed on it could be wrong.
        guard !moveInFlight, actionRows.isEmpty else { return }
        cancelHide()
        pressedRow = key
        refreshGeneration += 1  // a response already on its way must not rebuild the row under the pointer
    }

    /// The press ended without a drag (TaskRowView calls onDragEnd instead after one): a plain click shows the task's
    /// details on the T-Agent page (openItemPage). Its buttons take their own presses, and a control-click opens the menu.
    func rowReleased(_ key: String) {
        let clicked = clickedRow == key && overlay == nil
        clickedRow = nil
        pressedRow = nil
        if clicked { openItemPage(key) }
        hideIfPointerOutside()
    }

    func rowDragBegan(_ key: String) {
        guard pressedRow == key, partD.query.isEmpty else { return }  // Part D: no reordering in a filtered list
        if let item = items.first(where: { $0.key == key }), item.timing.waiting { return }  // Part G: Scheduled and Recurring keep their order
        rowDragActive = true
        dragging = true
        cancelHide()
        drop = .noChange
        for row in rowsInDragSection where row.key == key || row.ancestors.contains(key) {
            rowViews[row.key]?.alphaValue = 0.45
        }
        NSCursor.closedHand.set()
    }

    func rowDragMoved(_ event: NSEvent) {
        guard rowDragActive else { return }
        documentView.autoscroll(with: event)
        updateDrop(documentY: documentView.convert(event.locationInWindow, from: nil).y)
    }

    /// Works out the drop for a pointer at this height in the (flipped) list and shows it.
    private func updateDrop(documentY y: CGFloat) {
        let target = sectionAt(documentY: y)
        drop = decideDrop(documentY: y)
        var line: (anchor: (key: String, below: Bool)?, underTitle: Bool) = (nil, false)
        switch drop {
        case .place(let spec):
            line.anchor = insertionAnchor(rows: rowsInDragSection, spec: spec)
            if spec == .top, let source = pressedRow {
                let rows = rowsInDragSection
                let block = rows.first { $0.key == source }?.block
                if let first = rows.first(where: { $0.block == block }) { line.anchor = (first.key, false) }
            }
        case .change(let status, let spec):
            line = crossLine(target, status, spec)
        case .noChange, .invalid:
            break
        }
        if case .change(let status, _) = drop, let target = target {
            showDropHighlight(target, status)
        } else {
            dropHighlight.isHidden = true
        }
        // Rows under the dragged one stay where they are when it changes section.
        if let source = pressedRow {
            var crossing = false
            if case .change = drop { crossing = true }
            for row in rowsInDragSection where row.ancestors.contains(source) {
                rowViews[row.key]?.alphaValue = crossing ? 1 : 0.45
            }
        }
        var lineY: CGFloat?
        if let anchor = line.anchor, let frame = frameInDocument(anchor.key) {
            lineY = anchor.below ? frame.maxY + 1.5 : frame.minY - 3.5
        } else if line.underTitle, let target = target, let title = sectionHeaders[target] {
            lineY = title.convert(title.bounds, to: documentView).maxY + 1.5
        }
        if let lineY = lineY {
            insertionLine.frame = NSRect(x: detailPadding, y: lineY, width: detailWidth - detailPadding * 2, height: 2)
            insertionLine.isHidden = false
            NSCursor.closedHand.set()
        } else {
            insertionLine.isHidden = true
            if case .invalid = drop { NSCursor.operationNotAllowed.set() } else { NSCursor.closedHand.set() }
        }
    }

    private func rows(in section: Section) -> [Row] {
        summary?.rows(section) ?? []
    }

    /// The section a pointer at this height is in: from just above its title down to the next title.
    private func sectionAt(documentY y: CGFloat) -> Section? {
        var found: Section?
        for section in Section.allCases {
            guard let title = sectionHeaders[section] else { continue }
            if found == nil || y >= title.convert(title.bounds, to: documentView).minY - 3 { found = section }
        }
        return found
    }

    /// Where the line goes for a drop into another section: above the row that will follow the dragged one there, else
    /// below the row before it, else under the title of an empty section. The Done line shows none.
    private func crossLine(_ target: Section?, _ status: String, _ spec: MoveSpec) -> (anchor: (key: String, below: Bool)?, underTitle: Bool) {
        guard let target = target, target != .done, let current = list, let source = pressedRow,
              case .moved(let moved) = applyMove(current.items, key: source, spec: spec, status: status) else { return (nil, false) }
        let shown = rows(in: target)
        var next = current
        next.items = moved
        let after = summarize(next).rows(target)
        guard let at = after.firstIndex(where: { $0.key == source }) else { return (nil, false) }
        var end = at + 1
        while end < after.count && after[end].ancestors.contains(source) { end += 1 }
        if end < after.count, shown.contains(where: { $0.key == after[end].key }) { return ((after[end].key, false), false) }
        if at > 0, shown.contains(where: { $0.key == after[at - 1].key }) { return ((after[at - 1].key, true), false) }
        return (nil, shown.isEmpty)
    }

    private func showDropHighlight(_ section: Section, _ status: String) {
        guard let title = sectionHeaders[section] else {
            dropHighlight.isHidden = true
            return
        }
        let frame = title.convert(title.bounds, to: documentView)
        dropHighlight.frame = NSRect(x: detailPadding - 5, y: frame.minY - 2, width: detailWidth - detailPadding * 2 + 10,
                                     height: frame.height + 4)
        dropHint.stringValue = "\u{2192} " + statusLabel(status)
        dropHint.frame = NSRect(x: 4, y: (dropHighlight.bounds.height - 14) / 2, width: dropHighlight.bounds.width - 10, height: 14)
        dropHighlight.isHidden = false
    }

    private func decideDrop(documentY y: CGFloat) -> DropDecision {
        guard y >= 0, y <= documentView.bounds.height else { return .noChange }  // outside the list: cancels quietly
        guard let source = pressedRow, let current = list, let item = current.items.first(where: { $0.key == source }),
              let target = sectionAt(documentY: y) else { return .invalid(.level) }
        func rowUnder(_ rows: [Row]) -> (Row, Bool)? {
            guard let last = rows.last else { return nil }
            var over = last
            for row in rows {
                if let frame = frameInDocument(row.key), y <= frame.maxY + 2.5 {
                    over = row
                    break
                }
            }
            guard let frame = frameInDocument(over.key) else { return nil }
            return (over, y > frame.midY)
        }
        if target.timed { return .noChange }  // Part G: nothing is dropped into Scheduled or Recurring
        if target != sectionOf(item.status) {  // another section: a status change, placed where the pointer is
            let shown = rows(in: target)
            guard let first = shown.first, let top = frameInDocument(first.key), y >= top.minY - 2,
                  let (over, lowerHalf) = rowUnder(shown) else {
                return crossSectionDrop(current, source: source, into: target, over: nil, lowerHalf: false)
            }
            return crossSectionDrop(current, source: source, into: target, over: over.key, lowerHalf: lowerHalf)
        }
        let rows = rowsInDragSection
        guard let first = rows.first, let top = frameInDocument(first.key) else { return .invalid(.level) }
        if y < top.minY - 2 { return titleDrop(rows: rows, source: source) }  // the section's own title
        guard let (over, lowerHalf) = rowUnder(rows) else { return .invalid(.level) }
        return dropDecision(rows: rows, source: source, over: over.key, lowerHalf: lowerHalf)
    }

    func rowDragEnded() {
        guard rowDragActive, let source = pressedRow else { return }
        let decision = drop
        cancelRowDrag()
        switch decision {
        case .place(let spec), .change(_, let spec):
            var status: String?
            if case .change(let next, _) = decision { status = next }
            if let hook = moveHook {
                hook(source, spec, status)
                return
            }
            moveInFlight = true
            // Not done inside mouseUp: the optimistic rebuild removes the view that is handling the event.
            DispatchQueue.main.async { [weak self] in self?.performMove(source, spec, status: status) }
        case .invalid(let refusal):
            showToast(refusal.message)  // the rows are already back where they were
        case .noChange:
            break
        }
    }

    /// Ends the press and the drag and clears the feedback; the caller decides whether anything moves.
    func cancelRowDrag() {
        for row in rowsInDragSection { rowViews[row.key]?.alphaValue = 1 }
        insertionLine.isHidden = true
        dropHighlight.isHidden = true
        pressedRow = nil
        rowDragActive = false
        dragging = false
        drop = .noChange
        NSCursor.arrow.set()
        hideIfPointerOutside()
    }

    func applyLocal(_ newList: ItemList) {
        ticks.poll.etag = nil  // Part E: the list shown is no longer the server's, so the next tick asks for it whole
        list = newList
        summary = summarize(newList)
        hasResult = true
        problem = nil
        updateCollapsed()
        rebuildDetail()
        if detail.isVisible { positionDetail() }
    }

    private func performMove(_ key: String, _ spec: MoveSpec, status: String? = nil) {
        guard let current = list else {
            moveInFlight = false
            return
        }
        switch applyMove(current.items, key: key, spec: spec, status: status) {
        case .moved(let moved):
            var next = current
            next.items = moved
            applyLocal(next)
        case .noChange:
            moveInFlight = false
            return
        case .invalid(let reason):
            moveInFlight = false
            showToast(L("Move failed: {1}", reason))
            return
        }
        perform(api.moveRequest(key: key, spec: spec, status: status)) { [weak self] data, code, error in
            guard let self = self else { return }
            self.moveInFlight = false
            self.refreshGeneration += 1  // drop a list that was fetched before this move finished
            if (200..<300).contains(code) {
                self.refresh()
            } else {
                self.applyLocal(current)  // the rollback
                self.showDetail()
                self.showToast(L("Move failed: {1}", failureText(data, error)))
            }
        }
    }

    // MARK: Menus

    /// A context menu with these items above the quit item.
    func makeMenu(_ items: [NSMenuItem]) -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        items.forEach { menu.addItem($0) }
        if !items.isEmpty { menu.addItem(.separator()) }
        let quit = NSMenuItem(title: L("Quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        quit.target = NSApp
        menu.addItem(quit)
        return menu
    }

    func rowMenu(_ key: String) -> NSMenu {
        func item(_ title: String, _ action: Selector) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            item.representedObject = key
            return item
        }
        let hasLink = items.contains { $0.key == key && !$0.link.isEmpty }
        let hasSession = items.contains { $0.key == key && !$0.openPath.isEmpty }
        let sessionTitle = items.first { $0.key == key }?.timing.then.kind == "script" ? L("Open terminal") : L("Open session")
        // The row's own actions (Confirm and Reject, or Handled and Reply), so they never need the icons: the icons of
        // a row outside Needs you show only under the pointer.
        let actions = (summaryRow(key).map(rowButtons) ?? []).filter { !$0.opensOnly }.map { action -> NSMenuItem in
            let entry = item(action.label, #selector(rowActionItemClicked(_:)))
            entry.identifier = NSUserInterfaceItemIdentifier(action.rawValue)
            return entry
        }
        // Details first: what a click on the row does. Open session stays the only way to the conversation.
        return makeMenu([item(L("Details"), #selector(openDetailsItemClicked(_:)))]
                        + (hasLink ? [item(L("Open link"), #selector(openLinkItemClicked(_:)))] : [])
                        + (hasSession ? [item(sessionTitle, #selector(openSessionItemClicked(_:)))] : [])
                        + actions
                        + [item(L("Edit"), #selector(editItemClicked(_:))), item(L("Delete"), #selector(deleteItemClicked(_:)))])
    }

    /// The row of a key as the panel shows it now.
    private func summaryRow(_ key: String) -> Row? {
        guard let summary = summary else { return nil }
        return (summary.needs + summary.working + summary.todo + summary.scheduled + summary.recurring + summary.finished).first { $0.key == key }
    }

    @objc private func rowActionItemClicked(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String, let raw = sender.identifier?.rawValue,
              let action = RowAction(rawValue: raw) else { return }
        performRowAction(key, action)
    }

    /// What a row's icon button does, also from its menu and its accessibility actions.
    func performRowAction(_ key: String, _ action: RowAction) {
        switch action {
        case .link: openLink(key)
        case .session, .terminal: openSession(key)
        case .reply: openReplyForm(key)
        default: runAction(key, action)
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        menuOpen = true
        cancelHide()
    }

    func menuDidClose(_ menu: NSMenu) {
        menuOpen = false
        // Later, because a chosen item's action runs after this and may open a form.
        DispatchQueue.main.async { [weak self] in
            if self?.detail.isVisible == true { self?.hideIfPointerOutside() }
        }
    }

    // MARK: Form and confirmation

    @objc func plusClicked() {
        openForm(TaskFormView(mode: .create, draft: TaskDraft(), heading: L("New task"), schedule: makeScheduleEditor(engine: "local", item: nil)))
    }

    @objc private func editItemClicked(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        guard let item = items.first(where: { $0.key == key }) else {
            showToast(L("Task not found"))
            return
        }
        let draft = TaskDraft(item)
        openForm(TaskFormView(mode: .edit(key: key, original: draft), draft: draft, heading: L("Edit task"),
                              showsNotes: item.notes != nil, schedule: makeScheduleEditor(engine: item.engine, item: item)))
    }

    @objc private func deleteItemClicked(_ sender: NSMenuItem) {
        guard overlay == nil, let key = sender.representedObject as? String else { return }
        guard let item = items.first(where: { $0.key == key }) else {
            showToast(L("Task not found"))
            return
        }
        let view = DeleteConfirmView(key: key, title: item.title)
        view.onDelete = { [weak self, weak view] in view.map { self?.confirmDelete($0) } }
        view.onCancel = { [weak self] in self?.closeOverlay() }
        showOverlay(view)
    }

    func showOverlay(_ view: OverlayView) {
        guard let root = detail.contentView else { return }
        overlay = view
        cancelHide()
        // The top row's search parts lie above the overlay in the view order (they were added after the red message), so the
        // form's heading and a scrolled form would show through them: hidden while an overlay shows (Part G).
        partG.coveredTopRow = [partD.searchButton, partD.heading, partD.searchField].filter { !$0.isHidden }
        partG.coveredTopRow.forEach { $0.isHidden = true }
        view.frame = root.bounds
        view.autoresizingMask = [.width, .height]
        root.addSubview(view, positioned: .below, relativeTo: toast)  // the red message stays on top
        showDetail()
    }

    private func openForm(_ form: TaskFormView) {
        guard overlay == nil else { return }
        form.onSubmit = { [weak self] in self?.submitForm() }
        form.onCancel = { [weak self] in self?.cancelForm() }
        form.onResize = { [weak self, weak form] in if let form = form, self?.overlay === form { self?.positionDetail() } }
        detail.onCancel = form.onCancel
        detail.onReturn = form.onSubmit
        if !options.offscreen { previousApp = NSWorkspace.shared.frontmostApplication }
        showOverlay(form)
        detail.acceptsKey = true
        if !options.offscreen { detail.makeKey() }  // does not activate this app: the other app stays frontmost
        detail.makeFirstResponder(form.nameField)
    }

    func cancelForm() {
        guard overlay?.busy != true else { return }  // settles within the request timeout
        closeOverlay()
    }

    func closeOverlay() {
        guard let view = overlay else { return }
        overlay = nil
        partG.coveredTopRow.forEach { $0.isHidden = false }
        partG.coveredTopRow = []
        let wasKey = detail.isKeyWindow
        detail.makeFirstResponder(nil)
        detail.acceptsKey = false
        detail.onCancel = nil
        detail.onReturn = nil
        view.removeFromSuperview()
        if wasKey && !options.offscreen {
            detail.orderOut(nil)  // the keyboard goes back to the frontmost app only when the panel gives up being key
            orderFront(detail)
        }
        if detail.isVisible { positionDetail() }
        if NSApp.isActive, let previous = previousApp, previous != NSRunningApplication.current {
            previous.activate(options: [])
        }
        previousApp = nil
        hideIfPointerOutside()
    }

    private func submitForm() {
        guard let form = overlay as? TaskFormView, !form.busy else { return }
        form.commitComposition()
        guard form.nameIsValid else { return }
        let draft = form.draft
        // Part G: a When or Then that cannot be saved says why in the form.
        if let editor = form.scheduleEditor, let problem = editor.problem {
            form.showError(problem)
            return
        }
        form.showError(nil)
        let request: URLRequest
        switch form.mode {
        case .create:
            request = api.createRequest(draft, extra: form.scheduleEditor?.fields(changedFrom: nil) ?? [:])
        case .edit(let key, let original):
            var fields = changedFields(original: original, edited: draft, includeNotes: form.showsNotes)
            if let editor = form.scheduleEditor {
                fields.merge(editor.fields(changedFrom: items.first { $0.key == key }?.timing ?? ItemTiming())) { _, new in new }
            }
            if fields.isEmpty {
                closeOverlay()
                return
            }
            request = api.updateRequest(key: key, fields: fields)
        }
        send(request, from: form)
    }

    private func confirmDelete(_ view: DeleteConfirmView) {
        guard !view.busy else { return }
        send(api.deleteRequest(key: view.key), from: view)
    }

    private func send(_ request: URLRequest, from view: OverlayView) {
        view.busy = true
        perform(request) { [weak self] data, code, error in
            self?.requestFinished(view, failure: (200..<300).contains(code) ? nil : failureText(data, error))
        }
    }

    /// A failed save keeps the form and its text; a refused delete closes the question and says why.
    func requestFinished(_ view: OverlayView, failure: String?) {
        view.busy = false
        refreshGeneration += 1  // drop a list that was fetched before this finished
        if let failure = failure {
            if let form = view as? TaskFormView {
                showDetail()
                form.showError(L("Save failed: {1}", failure))  // in the form too, e.g. 403 SCRIPT_NEEDS_PERSON
                showToast(L("Save failed: {1}", failure))
            } else {
                closeOverlay()
                showDetail()
                showToast(L("Delete failed: {1}", failure))
            }
            return
        }
        closeOverlay()
        refresh()
    }

    // MARK: Row actions

    func syncActionButtons() {
        for (key, view) in rowViews {
            view.setActionsEnabled(!moveInFlight && !actionRows.contains(key))
            view.setPending(actionRows.contains(key))
        }
    }

    func actionButtonPressed() {
        cancelHide()
        buttonHeld = true
        refreshGeneration += 1  // a response already on its way must not rebuild the row under the pointer
    }

    func actionButtonReleased() {
        buttonHeld = false
        hideIfPointerOutside()
    }

    @objc func actionButtonClicked(_ sender: ActionButton) {
        guard let key = sender.identifier?.rawValue else { return }
        performRowAction(key, sender.rowAction)
    }

    /// Opens the link of a task as the list has it now, in the browser (a page of this T-Agent in T-Agent.app when it is
    /// installed); nothing is sent to T-Agent.
    private func openLink(_ key: String) {
        guard let item = items.first(where: { $0.key == key }), let url = linkTarget(item.link, base: api.base) else { return }
        openPage(url)
    }

    @objc private func openLinkItemClicked(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        openLink(key)
    }

    /// A row's Confirm, Reject, Handled, Done, Send now or Run again, from its button, its menu, its accessibility action or the bubble: one
    /// way in, so every one is guarded the same. The row is pending at once (dimmed, a spinner instead of its buttons) and takes no other
    /// action until the answer; the same action is not taken again on any row within actionDebounce. On success the row moves at once (the
    /// owner's answer, else the status the action gives) and the refresh afterwards reconciles; a refusal or a timeout gives the row back.
    /// See "Fast actions on a connected service" in docs/design/attention-desktop-window.md.
    func runAction(_ key: String, _ action: RowAction) {
        // The last check is for a button pressed just as a refresh changed the task under it.
        guard !actionRows.contains(key), !moveInFlight, pressedRow == nil,
              let item = items.first(where: { $0.key == key }), actionAllowed(action, item) else { return }
        let at = now()
        if let last = lastActionAt[action.rawValue], at >= last, at.timeIntervalSince(last) < actionDebounce { return }
        lastActionAt[action.rawValue] = at
        cancelHide()
        actionRows.insert(key)
        actionsRunning += 1
        refreshGeneration += 1  // drop a list that was fetched before this action
        syncActionButtons()
        var request = scheduleActionRequest(key: key, action: action) ?? api.actionRequest(key: key, action: action)
        request.timeoutInterval = actionTimeout
        perform(request) { [weak self] data, code, error in
            let timedOut = (error as? URLError)?.code == .timedOut
            self?.actionFinished(key, action, answer: data, timedOut: timedOut,
                                 failure: (200..<300).contains(code) ? nil : failureText(data, error))
        }
    }

    private func actionFinished(_ key: String, _ action: RowAction, answer: Data?, timedOut: Bool, failure: String?) {
        actionsRunning -= 1
        refreshGeneration += 1  // drop a list that was fetched before this action finished
        if timedOut {
            // No answer is not a refusal: the change may have reached the owner. The row comes back as the list has it, and the
            // refresh below shows what T-Agent has now.
            actionRows.remove(key)
            syncActionButtons()
            showDetail()
            showToast(L("Still waiting for T-Agent; checking the list"), error: false)
            actionNeedsRefresh = true
        } else if let failure = failure {
            actionRows.remove(key)
            syncActionButtons()
            showDetail()
            showToast(L("Action failed: {1}", failure))
        } else {
            if applyActionAnswer(key, action, answer) {
                actionRows.remove(key)  // the row is in its new place; the guard of runAction keeps the old action away
                syncActionButtons()
            }
            actionNeedsRefresh = true  // otherwise the row stays pending until the refresh has replaced it
        }
        guard actionsRunning == 0, actionNeedsRefresh else { return }
        actionNeedsRefresh = false
        refresh { [weak self] in
            guard let self = self, self.actionsRunning == 0 else { return }
            self.actionRows.removeAll()
            self.syncActionButtons()
            self.hideIfPointerOutside()
        }
    }

    /// Puts the answer of a successful action into the list at once: the item the owner answered (POST confirm, reject, handled and the
    /// PATCH of Done answer it), else the status the action gives. False when nothing is known to change (Send now, Run again).
    func applyActionAnswer(_ key: String, _ action: RowAction, _ answer: Data?) -> Bool {
        guard var current = list, let index = current.items.firstIndex(where: { $0.key == key }) else { return false }
        let old = current.items[index]
        var next = old
        if let data = answer, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let answered = decodeItem(object), answered.key == key {
            next = answered
            if next.notes == nil { next.notes = old.notes }
            if next.session == nil { next.session = old.session }
        } else if let status = actionStatus(action) {
            next.status = status
            if status == "working" { next.attentionReason = ""; next.pending = "" }
        } else {
            return false
        }
        current.items[index] = next
        ticks.poll.etag = nil  // the next tick asks for the whole list, not "same as before"
        apply(current, problem: nil)
        return true
    }

    /// The message at the bottom of the panel: red for a failure, neutral for a note (an answer that is late).
    func showToast(_ message: String, error: Bool = true) {
        toast.layer?.backgroundColor = (error ? NSColor.systemRed : NSColor(white: 0.22, alpha: 1)).withAlphaComponent(0.92).cgColor
        toastLabel.stringValue = message
        toast.isHidden = false
        toastTimer?.invalidate()
        let timer = Timer(timeInterval: toastDuration, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.toast.isHidden = true
            self.toastTimer = nil
            if self.detail.isVisible { self.hideIfPointerOutside() }
        }
        RunLoop.main.add(timer, forMode: .common)
        toastTimer = timer
    }
}
