// T-Attention desktop widget: the controller, timers, data and the notice bubble. See main.swift for the overview and the build.
import AppKit

extension WidgetController {
    // MARK: Timers and data

    func tick() {
        if let parent = parentPID, getppid() != parent {
            exit(0)
        }
        // Safety net for a mouse up that never arrived, so the refresh cannot stay paused.
        if pressedRow != nil, NSEvent.pressedMouseButtons & 1 == 0 { cancelRowDrag() }
        // Safety net for a missed mouseExited, for example after a Space switch.
        if detail.isVisible, !holdsPanel, hideTimer == nil {
            let mouse = NSEvent.mouseLocation
            if !widget.frame.contains(mouse) && !detail.frame.contains(mouse) {
                hideDetail()
            }
        }
    }

    func loadStrings() {
        guard !stringsLoading, !stringsLoaded else { return }
        stringsLoading = true
        perform(api.stringsRequest) { [weak self] data, code, _ in
            guard let self = self else { return }
            self.stringsLoading = false
            guard (200..<300).contains(code), let data = data, let table = parseStrings(data) else { return }
            self.stringsLoaded = true
            if table != stringTable {
                stringTable = table
                self.stringsChanged()
            }
        }
    }

    /// Puts the loaded language on what is already built; forms and menus are built when they open.
    func stringsChanged() {
        updateCollapsed()  // the capsule's tooltip and VoiceOver label
        plusButton.toolTip = L("New task")
        plusButton.setAccessibilityLabel(L("New task"))
        widgetRoot?.menu = makeMenu([])
        detailRoot?.menu = makeMenu([])
        if !refreshPaused && !rowDragActive {
            rebuildDetail()
            if detail.isVisible { positionDetail() }
        }
    }

    func refresh(then done: (() -> Void)? = nil) {
        loadStrings()
        if refreshPaused {  // during a drag or a button press, and while a move or an action is in flight
            done?()
            return
        }
        if tickMode {  // Part E: the list at once, with the rest of a tick
            sendTick(wantList: true, then: done)
            return
        }
        let generation = refreshGeneration
        perform(api.itemsRequest) { [weak self] data, code, _ in
            guard let self = self else { return }
            guard generation == self.refreshGeneration, !self.refreshPaused else {
                done?()
                return
            }
            if (200..<300).contains(code), let data = data, let decoded = decodeItemList(data) {
                self.apply(decoded, problem: nil)
            } else if code == 401 || code == 403 {
                self.apply(nil, problem: L("T-Agent did not accept the widget token"))
            } else {
                self.apply(nil, problem: L("Could not reach T-Agent"))
            }
            done?()
        }
    }

    var refreshPaused: Bool { pressedRow != nil || moveInFlight || buttonHeld || actionsRunning > 0 }

    func apply(_ newList: ItemList?, problem newProblem: String?) {
        let result = newList.map(summarize)
        let same = hasResult && result == summary && newProblem == problem
        list = newList  // always: a new sort_order alone changes no row but matters to the next move
        problem = newProblem
        refreshBubbleActions()  // the bubble's buttons follow the task as the list now has it
        if same { return }
        hasResult = true
        summary = result
        updateCollapsed()
        rebuildDetail()
        if detail.isVisible { positionDetail() }
    }

    // MARK: Notice bubble

    /// Asks for new notices; called with each refresh tick, apart from the item list.
    func pollNotices() {
        guard noticePoll.due(now()) else { return }
        noticePoll.inFlight = true
        perform(api.noticesRequest(after: noticePoll.lastSeq)) { [weak self] data, code, _ in
            guard let self = self else { return }
            let fresh = self.noticePoll.finished(code: code, data: data, now: self.now())
            if !fresh.isEmpty { self.enqueue(fresh) }
        }
    }

    func enqueue(_ notices: [WidgetNotice]) {
        noticeQueue.add(notices)
        if noticeQueue.current == nil { showNextNotice() }
    }

    private func showNextNotice() {
        endBubbleReply()
        guard let notice = noticeQueue.advance() else {
            hideBubble()
            return
        }
        noteActivity()  // Part D: a new notice brings the window back to full opacity
        let view = NoticeBubbleView(notice: notice, more: noticeQueue.more, tooltip: bubbleTooltip(notice))
        view.onClick = { [weak self] in self?.bubbleClicked() }
        view.onClose = { [weak self] in self?.dismissNotice() }
        view.onEnter = { [weak self] in self?.bubbleEntered() }
        view.onExit = { [weak self] in self?.bubbleExited() }
        attachBubbleActions(view)
        view.frame = NSRect(x: 0, y: 0, width: bubbleWidth, height: view.preferredHeight)
        bubbleView = view
        bubbleHovered = false
        bubble.contentView = view
        let placed = placeBubble(NSSize(width: bubbleWidth, height: view.preferredHeight))
        let start = bubbleStartFrame(placed.frame, toLeft: placed.toLeft, reduceMotion: reduceMotion())
        bubbleSlides = start != placed.frame
        if options.offscreen || !bubbleSlides {
            bubble.setFrame(placed.frame, display: !options.offscreen)
            bubble.alphaValue = 1
            orderFront(bubble)
        } else {
            bubble.setFrame(start, display: false)
            bubble.alphaValue = 0
            orderFront(bubble)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = bubbleAnimation
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                bubble.animator().setFrame(placed.frame, display: true)
                bubble.animator().alphaValue = 1
            }
        }
        if !options.offscreen { bubble.invalidateShadow() }
        announce(notice.text.isEmpty ? notice.title : notice.title + ". " + notice.text.oneLine)
        startBubbleTimer()
    }

    /// Beside the window, or beside the window and its panel while the panel is open.
    func placeBubble(_ size: NSSize) -> (frame: NSRect, toLeft: Bool) {
        let visible = (widget.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let anchor = detail.isVisible ? widget.frame.union(detail.frame) : widget.frame
        return bubbleFrame(size: size, pill: widget.frame, anchor: anchor, visible: visible)
    }

    func positionBubble() {
        guard bubbleView != nil else { return }
        bubble.setFrame(placeBubble(bubble.frame.size).frame, display: !options.offscreen)
    }

    func startBubbleTimer() {
        stopBubbleTimer()
        guard let notice = noticeQueue.current, notice.seconds > 0, !bubbleHovered, !bubbleReply.active else { return }
        bubbleSeconds = notice.seconds
        let timer = Timer(timeInterval: notice.seconds, repeats: false) { [weak self] _ in self?.bubbleTimedOut() }
        RunLoop.main.add(timer, forMode: .common)
        bubbleTimer = timer
    }

    func stopBubbleTimer() {
        bubbleTimer?.invalidate()
        bubbleTimer = nil
        bubbleSeconds = nil
    }

    func bubbleTimedOut() {
        bubbleTimer = nil
        bubbleSeconds = nil
        dismissNotice()
    }

    /// The pointer over the bubble holds it; leaving starts the full time again.
    private func bubbleEntered() {
        bubbleHovered = true
        stopBubbleTimer()
    }

    private func bubbleExited() {
        bubbleHovered = false
        startBubbleTimer()
    }

    /// Opens the task's link, else its session, else the notice's target, else the T-Agent page (bubbleOpen), and
    /// closes it. Not while a reply is being typed, so a stray click cannot lose it.
    private func bubbleClicked() {
        guard let notice = noticeQueue.current, !bubbleReply.active else { return }
        let target = bubbleOpen(notice, item: bubbleItem(notice), base: api.base)
        dismissNotice()
        if let session = target.session {
            openTerminalPage(session)  // an open T-Agent page switches to it, as with Open session
        } else if let url = target.url {
            openPage(url)  // a page of this T-Agent in T-Agent.app when it is installed; other links in the browser
        }
    }

    /// Closes the shown notice; the next one waiting comes up.
    func dismissNotice() {
        showNextNotice()
    }

    func hideBubble() {
        endBubbleReply(keepShown: false)
        stopBubbleTimer()
        bubbleHovered = false
        bubbleView = nil
        bubble.orderOut(nil)
        bubble.contentView = nil
    }
}
