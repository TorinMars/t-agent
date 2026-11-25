// T-Attention desktop widget: Part B, actions and replies. See main.swift for the overview and the build.
import AppKit

// MARK: - Part B: actions and replies

/// The agent terminal of a task (`session` of GET /items, from context.tagent): where the window opens it, and whether a
/// reply can be typed into it. Older servers send no `session`; the features below are then hidden.
struct ItemSession: Equatable {
    var engine: String = ""  // "local" or "remote:<id>"
    var taskId: String = ""
    var terminalId: String = ""
    var agent: String = ""  // "claude", "codex" or ""
    var live: Bool?  // nil: unknown (a remote engine)
    var openPath: String = ""  // when sessionOpenPath accepts it, else empty (no Open session)

    /// A reply goes only to a live terminal on this machine (POST /items/:key/reply).
    var canReply: Bool { engine == "local" && live == true }
}

let replyMaxLength = 4000  // UTF-16 units, as the server counts them

/// The page path that opens an agent's terminal, trimmed: "/?openTerminal=<engine>:<task>:<terminal>" with something
/// after the "=", and no whitespace, control character or backslash. Nil for anything else.
func sessionOpenPath(_ value: String) -> String? {
    let prefix = "/?openTerminal="
    let text = value.trimmed
    guard text.hasPrefix(prefix), text.count > prefix.count, text.count <= 2000, !text.unicodeScalars.contains(where: {
        CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) || $0 == "\\"
    }) else { return nil }
    return text
}

/// The `session` of an item; nil when it is null, missing or not an object.
func decodeSession(_ value: Any?) -> ItemSession? {
    guard let object = value as? [String: Any] else { return nil }
    let live = (object["live"] as? NSNumber).flatMap { CFGetTypeID($0) == CFBooleanGetTypeID() ? $0.boolValue : nil }
    return ItemSession(engine: (looseText(object["engine"]) ?? "").trimmed, taskId: (looseText(object["task_id"]) ?? "").trimmed,
                       terminalId: (looseText(object["terminal_id"]) ?? "").trimmed,
                       agent: (looseText(object["agent"]) ?? "").trimmed.lowercased(), live: live,
                       openPath: (object["open_path"] as? String).flatMap(sessionOpenPath) ?? "")
}

extension RowAction {
    /// Opens something in the browser and never touches the task: stays on while the row's request is out.
    var opensOnly: Bool { self == .link || self == .session || self == .terminal || self == .open }
}

/// The buttons of a row, left to right: Open link, Open session, the row's actions, and Reply after Handled when the
/// agent's terminal can take one.
func rowButtons(_ row: Row) -> [RowAction] {
    (row.link.isEmpty ? [] : [.link]) + (row.openPath.isEmpty ? [] : [row.script ? .terminal : .session]) + row.actions
        + (row.canReply && row.actions.contains(.handled) ? [.reply] : [])
}

/// The buttons of a notice's bubble: those of its task's row (Confirm and Reject in review, Handled when it waits for
/// the user, by the status the list has now), and Reply after Handled when the agent's terminal can take one. None for
/// a direct or test message, or a task the list does not have.
func bubbleActions(_ notice: WidgetNotice, item: WidgetItem?) -> [RowAction] {
    if scheduleNoticeKinds.contains(notice.kind) { return scheduleBubbleActions(notice, item: item) }  // Part G
    guard notice.kind == "item", !notice.key.isEmpty, let item = item, item.key == notice.key else { return [] }
    let actions = rowActions(for: item)
    return actions.contains(.handled) && item.session?.canReply == true ? actions + [.reply] : actions
}

/// What a click on the bubble opens, and its tooltip: the task's link (the notice's target, which the server made from
/// it), else the task's session, else the notice's target, else the T-Agent page. `session` is the session's page path
/// when that is what it opens (it then goes through openTerminalPage, like Open session).
func bubbleOpen(_ notice: WidgetNotice, item: WidgetItem?, base: String) -> (url: URL?, tooltip: String, session: String?) {
    let ownTask = notice.kind == "item" || scheduleNoticeKinds.contains(notice.kind)  // Part G: the window's own notices of a task
    if ownTask, !notice.key.isEmpty, let item = item, item.key == notice.key {
        if !item.link.isEmpty {
            if !notice.target.isEmpty { return (URL(string: notice.target), notice.target, nil) }
            if let url = linkTarget(item.link, base: base) { return (url, url.absoluteString, nil) }
        }
        if !item.openPath.isEmpty, let url = linkTarget(item.openPath, base: base) {
            return (url, L("Open session"), item.openPath)
        }
    }
    if !notice.target.isEmpty { return (URL(string: notice.target), notice.target, nil) }
    return (URL(string: base + "/"), L("Open T-Agent"), nil)
}

/// The terminal a page path names: "/?openTerminal=<engine>:<task id>:<terminal id>" with engine "local" or
/// "remote:<id>" (the pattern the page itself accepts, public/js/h5.js); nil for anything else.
func openTerminalTarget(_ path: String) -> (engine: String, taskId: String, terminalId: String)? {
    let prefix = "/?openTerminal="
    guard path.hasPrefix(prefix) else { return nil }
    let value = String(path.dropFirst(prefix.count))
    guard let regex = try? NSRegularExpression(pattern: "^(local|remote:[1-9][0-9]{0,14}):([1-9][0-9]{0,14}):([A-Za-z0-9_-]{1,64})$"),
          let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)), match.numberOfRanges == 4,
          let engine = Range(match.range(at: 1), in: value), let task = Range(match.range(at: 2), in: value),
          let terminal = Range(match.range(at: 3), in: value) else { return nil }
    return (String(value[engine]), String(value[task]), String(value[terminal]))
}

/// What the window does after POST /open-terminal: an open T-Agent page switched to the terminal (`focused`: the
/// browser extension brought its tab to the front), or it opens the address as before (no page took it, an older
/// server without the route, or any failure).
enum OpenTerminalOutcome: Equatable {
    case switched(focused: Bool)
    case openURL
}

func openTerminalOutcome(code: Int, data: Data?) -> OpenTerminalOutcome {
    guard (200..<300).contains(code), let data = data,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let delivered = looseNumber(object["delivered"]), delivered >= 1 else { return .openURL }
    return .switched(focused: jsonBool(object["focused"]) == true)
}

/// Brings the default browser (the app that opens http addresses) to the front without opening an address. Launching
/// an app that already runs only activates it, which works for a background app on every macOS version.
func activateDefaultBrowser() {
    guard let probe = URL(string: "http://127.0.0.1/"), let app = NSWorkspace.shared.urlForApplication(toOpen: probe) else { return }
    if #available(macOS 10.15, *) {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: app, configuration: configuration, completionHandler: nil)
    } else if let bundle = Bundle(url: app)?.bundleIdentifier,
              let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first {
        running.activate(options: [.activateIgnoringOtherApps])
    }
}

/// The T-Agent macOS app (apps/macos; "Server and floating window integration" in docs/design/mac-app.md). When it is
/// installed, a page of this T-Agent opens in its window through its URL scheme instead of the browser.
let tAgentAppBundleID = "local.t-agent.app"

/// The app's link for an address on the T-Agent of the window (`base`): "t-agent://open?path=<path, query and fragment,
/// percent-encoded so only unreserved characters stay>". Nil for an address on any other origin (a task's external link),
/// which always opens in the browser.
func appOpenLink(_ url: URL, base: String) -> URL? {
    guard let origin = URL(string: base), let originScheme = origin.scheme?.lowercased(), let originHost = origin.host?.lowercased(),
          url.scheme?.lowercased() == originScheme, url.host?.lowercased() == originHost, url.port == origin.port,
          url.user == nil, url.password == nil,
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    var path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
    guard path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
    if let query = components.percentEncodedQuery { path += "?" + query }
    if let fragment = components.percentEncodedFragment { path += "#" + fragment }
    let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    guard let encoded = path.addingPercentEncoding(withAllowedCharacters: unreserved) else { return nil }
    return URL(string: "t-agent://open?path=" + encoded)
}

/// Whether T-Agent.app is installed (Launch Services knows it) or running.
func tAgentAppInstalled() -> Bool {
    NSWorkspace.shared.urlForApplication(withBundleIdentifier: tAgentAppBundleID) != nil || tAgentAppRunning()
}

func tAgentAppRunning() -> Bool {
    !NSRunningApplication.runningApplications(withBundleIdentifier: tAgentAppBundleID).isEmpty
}

/// Brings T-Agent.app forward with its window shown ("t-agent://show"): its page took the terminal.
func activateTAgentApp() {
    guard let show = URL(string: "t-agent://show") else { return }
    _ = NSWorkspace.shared.open(show)
}

/// The text of a reply as it is sent: trimmed; nil when empty or longer than the server takes.
func replyText(_ value: String) -> String? {
    let text = value.trimmed
    return text.isEmpty || text.utf16.count > replyMaxLength ? nil : text
}

extension WidgetAPI {
    /// POST /items/:key/reply { text }: the text goes to the agent's terminal as a paste, then Enter.
    func replyRequest(key: String, text: String) -> URLRequest {
        request("POST", itemPath(key) + "/reply", body: ["text": text])
    }

    /// POST /open-terminal { engine, task_id, terminal_id }: an open T-Agent page on this machine switches to that
    /// terminal; the answer is { delivered, focused }.
    func openTerminalRequest(engine: String, taskId: String, terminalId: String) -> URLRequest {
        request("POST", "/api/attention/widget/open-terminal", body: ["engine": engine, "task_id": taskId, "terminal_id": terminalId])
    }
}

/// A one-line reply field with its own Return and Esc (left to the input method during a composition).
final class ReplyField: NSTextField, NSTextFieldDelegate {
    var onSubmit: () -> Void = {}
    var onCancel: () -> Void = {}
    var onChange: () -> Void = {}

    init(width: CGFloat) {
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: 22))
        stringValue = ""
        isEditable = true
        isSelectable = true
        isBezeled = true
        bezelStyle = .roundedBezel
        drawsBackground = true
        font = .systemFont(ofSize: 12)
        usesSingleLineMode = true
        lineBreakMode = .byTruncatingHead
        cell?.isScrollable = true
        cell?.wraps = false
        placeholderString = L("Reply to the agent")
        setAccessibilityLabel(L("Reply to the agent"))
        delegate = self
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: width).isActive = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// What is typed, read from the field editor so a composition in progress is included.
    var typed: String { (currentEditor() as? NSTextView)?.string ?? stringValue }

    func commitComposition() {
        (currentEditor() as? NSTextView).map { if $0.hasMarkedText() { $0.unmarkText() } }
    }

    func controlTextDidChange(_ notification: Notification) { onChange() }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if textView.hasMarkedText() { return false }
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            onSubmit()
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            onCancel()
            return true
        default:
            return false
        }
    }
}

/// Under the bubble's text: the task's buttons, or, after Reply, the reply field with Send, and a red line when the
/// reply failed.
final class BubbleActionsView: NSView {
    let actions: [RowAction]
    private(set) var buttons: [ActionButton] = []
    let field: ReplyField
    let sendButton = PanelButton(label: L("Send"), tint: .controlAccentColor)
    let errorField = NSTextField(wrappingLabelWithString: "")
    private let buttonRow = NSStackView()
    private let replyRow = NSStackView()
    var onAction: (RowAction) -> Void = { _ in }
    var onSend: () -> Void = {}
    var onCancel: () -> Void = {}
    var busy = false { didSet { update() } }

    var replying: Bool { !replyRow.isHidden }

    init(actions: [RowAction], width: CGFloat) {
        self.actions = actions
        field = ReplyField(width: width - sendButton.intrinsicContentSize.width - 6)
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: 20))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: width).isActive = true
        for action in actions {
            let button = ActionButton(action)
            button.target = self
            button.action = #selector(buttonClicked(_:))
            buttons.append(button)
        }
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 6
        buttons.forEach { buttonRow.addArrangedSubview($0) }
        replyRow.orientation = .horizontal
        replyRow.spacing = 6
        replyRow.alignment = .centerY
        replyRow.addArrangedSubview(field)
        replyRow.addArrangedSubview(sendButton)
        replyRow.isHidden = true
        sendButton.target = self
        sendButton.action = #selector(sendClicked)
        field.onSubmit = { [weak self] in self?.onSend() }
        field.onCancel = { [weak self] in self?.onCancel() }
        field.onChange = { [weak self] in self?.update() }
        errorField.font = .systemFont(ofSize: 10, weight: .medium)
        errorField.textColor = .systemRed
        errorField.maximumNumberOfLines = 2
        errorField.cell?.truncatesLastVisibleLine = true
        errorField.preferredMaxLayoutWidth = width
        errorField.translatesAutoresizingMaskIntoConstraints = false
        errorField.widthAnchor.constraint(equalToConstant: width).isActive = true
        errorField.isHidden = true
        let column = NSStackView(views: [buttonRow, replyRow, errorField])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        update()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The control under a point of this view, or nil (the press then belongs to the bubble).
    func control(at point: NSPoint) -> NSView? {
        let shown: [NSView] = replying ? [field, sendButton] : buttons
        return shown.first { !$0.isHidden && $0.convert($0.bounds, to: self).contains(point) }
    }

    func showReply() {
        buttonRow.isHidden = true
        replyRow.isHidden = false
        showError(nil)
        update()
    }

    func hideReply() {
        field.stringValue = ""
        replyRow.isHidden = true
        buttonRow.isHidden = false
        showError(nil)
        update()
    }

    func showError(_ message: String?) {
        errorField.stringValue = message ?? ""
        errorField.isHidden = message == nil
    }

    // The field stays enabled while a reply is out (disabling it would end the editing and drop the text); a second
    // Return is refused by the controller instead.
    private func update() {
        sendButton.isEnabled = !busy && replyText(field.typed) != nil
        buttons.forEach { $0.isEnabled = !busy }
    }

    @objc private func buttonClicked(_ sender: ActionButton) { onAction(sender.rowAction) }
    @objc private func sendClicked() { onSend() }
}

extension NoticeBubbleView {
    /// Puts the task's buttons (or none) under the text and measures the bubble again.
    func setActions(_ view: BubbleActionsView?) {
        if let old = actionsView {
            contentStack.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        actionsView = view
        if let view = view {
            if let last = contentStack.arrangedSubviews.last { contentStack.setCustomSpacing(8, after: last) }
            contentStack.addArrangedSubview(view)
        }
        relayout()
    }

    func relayout() {
        contentStack.layoutSubtreeIfNeeded()
        preferredHeight = ceil(contentStack.fittingSize.height) + 10 + 11
    }
}

/// The reply in the panel: the task's title, a one-line field, Cancel and Send.
final class ReplyFormView: OverlayView {
    let key: String
    let field: ReplyField
    let sendButton = PanelButton(label: L("Send"), tint: .controlAccentColor)
    let cancelButton = PanelButton(label: L("Cancel"))
    var onSubmit: () -> Void = {}
    var onCancel: () -> Void = {}

    override var busy: Bool { didSet { update() } }

    init(key: String, title: String) {
        self.key = key
        let fieldWidth = detailWidth - detailPadding * 2
        field = ReplyField(width: fieldWidth)
        super.init(frame: NSRect(x: 0, y: 0, width: detailWidth, height: 120))
        let background = makeBackground(radius: 12)
        background.frame = bounds
        addSubview(background)
        let heading = NSTextField(labelWithString: L("Reply to the agent"))
        heading.font = .systemFont(ofSize: 12, weight: .semibold)
        let name = NSTextField(wrappingLabelWithString: title.oneLine)
        name.font = .systemFont(ofSize: 11)
        name.textColor = .secondaryLabelColor
        name.maximumNumberOfLines = 2
        name.cell?.truncatesLastVisibleLine = true
        name.preferredMaxLayoutWidth = fieldWidth
        name.translatesAutoresizingMaskIntoConstraints = false
        name.widthAnchor.constraint(equalToConstant: fieldWidth).isActive = true
        let buttons = makeButtonRow([cancelButton, sendButton], width: fieldWidth)
        let stack = NSStackView(views: [heading, name, field, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.setCustomSpacing(8, after: name)
        stack.setCustomSpacing(10, after: field)
        stack.edgeInsets = NSEdgeInsets(top: detailPadding, left: detailPadding, bottom: detailPadding, right: detailPadding)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.widthAnchor.constraint(equalToConstant: detailWidth),
        ])
        stack.layoutSubtreeIfNeeded()
        preferredHeight = ceil(stack.fittingSize.height) + 34  // room for the red message under the buttons
        field.onSubmit = { [weak self] in self?.onSubmit() }
        field.onCancel = { [weak self] in self?.onCancel() }
        field.onChange = { [weak self] in self?.update() }
        sendButton.target = self
        sendButton.action = #selector(sendPressed)
        cancelButton.target = self
        cancelButton.action = #selector(cancelPressed)
        update()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func update() {
        sendButton.isEnabled = !busy && replyText(field.typed) != nil
    }

    @objc private func sendPressed() { onSubmit() }
    @objc private func cancelPressed() { onCancel() }
}

/// The reply field of the bubble while it is open. `generation` tells an answer to an older reply from the current one.
struct BubbleReplyState {
    var active = false
    var sending = false
    var generation = 0
    var previousApp: NSRunningApplication?
}

extension WidgetController {
    /// The task of a notice as the list has it now.
    func bubbleItem(_ notice: WidgetNotice) -> WidgetItem? {
        notice.key.isEmpty ? nil : items.first { $0.key == notice.key }
    }

    func bubbleTooltip(_ notice: WidgetNotice) -> String {
        bubbleOpen(notice, item: bubbleItem(notice), base: api.base).tooltip
    }

    /// Puts the buttons of the notice's task under the bubble's text (none for other notices).
    func attachBubbleActions(_ view: NoticeBubbleView) {
        let actions = bubbleActions(view.notice, item: bubbleItem(view.notice))
        guard !actions.isEmpty else {
            if view.actionsView != nil { view.setActions(nil) }
            return
        }
        let row = BubbleActionsView(actions: actions, width: bubbleWidth - NoticeBubbleView.column - NoticeBubbleView.padding)
        row.onAction = { [weak self] action in self?.bubbleActionClicked(action) }
        row.onSend = { [weak self] in self?.sendBubbleReply() }
        row.onCancel = { [weak self] in self?.cancelBubbleReply() }
        view.setActions(row)
    }

    /// After a refresh the bubble's buttons and tooltip follow the task (a notice can come before the list that has its
    /// new status). Never while a reply is open.
    func refreshBubbleActions() {
        guard let view = bubbleView, !bubbleReply.active else { return }
        let tooltip = bubbleTooltip(view.notice)
        view.toolTip = tooltip
        view.setAccessibilityHelp(tooltip)
        guard bubbleActions(view.notice, item: bubbleItem(view.notice)) != (view.actionsView?.actions ?? []) else { return }
        attachBubbleActions(view)
        resizeBubble()
    }

    /// The bubble keeps its top beside the window when its height changes.
    fileprivate func resizeBubble() {
        guard let view = bubbleView else { return }
        bubble.setFrame(placeBubble(NSSize(width: bubbleWidth, height: view.preferredHeight)).frame, display: !options.offscreen)
        if !options.offscreen { bubble.invalidateShadow() }
    }

    /// Confirm, Reject and Handled run as on the row (the same request and messages) and close the bubble without
    /// opening anything; Reply opens the field.
    fileprivate func bubbleActionClicked(_ action: RowAction) {
        guard let notice = noticeQueue.current else { return }
        if action == .reply {
            startBubbleReply()
            return
        }
        dismissNotice()
        switch action {
        case .open:  // Part G: what a click on the bubble opens
            let target = bubbleOpen(notice, item: bubbleItem(notice), base: api.base)
            if let session = target.session { openTerminalPage(session) } else if let url = target.url { openPage(url) }
        case .session, .terminal: openSession(notice.key)
        default: runAction(notice.key, action)
        }
    }

    /// Opens the reply field. The bubble may take the keyboard only while it is open; the timer waits meanwhile.
    fileprivate func startBubbleReply() {
        guard let view = bubbleView, let row = view.actionsView, !bubbleReply.active else { return }
        bubbleReply.active = true
        bubbleReply.generation += 1
        stopBubbleTimer()
        if !options.offscreen { bubbleReply.previousApp = NSWorkspace.shared.frontmostApplication }
        row.showReply()
        view.relayout()
        resizeBubble()
        bubble.onCancel = { [weak self] in self?.cancelBubbleReply() }
        bubble.onReturn = { [weak self] in self?.sendBubbleReply() }
        bubble.acceptsKey = true
        if !options.offscreen { bubble.makeKey() }  // does not activate this app: the other app stays frontmost
        bubble.makeFirstResponder(row.field)
    }

    /// Esc: back to the buttons, the timer runs again.
    fileprivate func cancelBubbleReply() {
        guard bubbleReply.active, !bubbleReply.sending else { return }
        endBubbleReply()
        if let view = bubbleView {
            view.actionsView?.hideReply()
            view.relayout()
            resizeBubble()
        }
        refreshBubbleActions()
        startBubbleTimer()
    }

    /// Gives the keyboard back to the app that had it. keepShown false: the bubble is being hidden anyway.
    func endBubbleReply(keepShown: Bool = true) {
        guard bubbleReply.active else { return }
        bubbleReply.active = false
        bubbleReply.sending = false
        let wasKey = bubble.isKeyWindow
        bubble.makeFirstResponder(nil)
        bubble.acceptsKey = false
        bubble.onCancel = nil
        bubble.onReturn = nil
        if wasKey && keepShown && !options.offscreen {
            bubble.orderOut(nil)  // the keyboard goes back only when the panel gives up being key
            orderFront(bubble)
        }
        if NSApp.isActive, let previous = bubbleReply.previousApp, previous != NSRunningApplication.current {
            previous.activate(options: [])
        }
        bubbleReply.previousApp = nil
    }

    /// Return or Send: POST /items/:key/reply. Success closes the bubble; a refusal stays in it, in red, with the text.
    fileprivate func sendBubbleReply() {
        guard bubbleReply.active, !bubbleReply.sending, let notice = noticeQueue.current, let row = bubbleView?.actionsView else { return }
        row.field.commitComposition()
        guard let text = replyText(row.field.typed) else { return }
        bubbleReply.sending = true
        row.busy = true
        let generation = bubbleReply.generation
        perform(api.replyRequest(key: notice.key, text: text)) { [weak self] data, code, error in
            self?.bubbleReplyFinished(generation, code: code, failure: (200..<300).contains(code) ? nil : failureText(data, error))
        }
    }

    fileprivate func bubbleReplyFinished(_ generation: Int, code: Int, failure: String?) {
        let current = bubbleReply.active && bubbleReply.generation == generation
        if current {
            bubbleReply.sending = false
            bubbleView?.actionsView?.busy = false
        }
        refreshGeneration += 1  // drop a list that was fetched before this finished
        if let failure = failure {
            let message = L("Reply failed: {1}", failure)
            if current, let view = bubbleView, let row = view.actionsView {
                row.showError(message)
                view.relayout()
                resizeBubble()
                bubble.makeFirstResponder(row.field)
            } else {
                showDetail()
                showToast(message)
            }
            if code == 404 || code == 409 { refresh() }  // the task or its terminal is gone: the list then drops Reply
            return
        }
        if current {
            endBubbleReply()
            dismissNotice()
        }
        refresh()
    }

    /// Opens the agent's terminal of a task on this T-Agent's page (openTerminalPage).
    func openSession(_ key: String) {
        guard let path = items.first(where: { $0.key == key })?.openPath, !path.isEmpty else { return }
        openTerminalPage(path)
    }

    /// Shows a terminal on the T-Agent page without a new tab when one is open: POST /open-terminal tells the most
    /// recently used T-Agent page of this machine to switch to it. When a page took it, the browser comes to the front
    /// (the extension has focused that tab, else the default browser is activated, without opening an address). When
    /// none did, or the server is older (404) or failed, the page path is opened in the browser as before.
    /// With T-Agent.app installed, the app opens it when the window opens a T-Agent page (or the page took the terminal:
    /// the app comes forward when it runs, else the browser).
    func openTerminalPage(_ path: String) {
        guard let url = linkTarget(path, base: api.base) else { return }
        guard let target = openTerminalTarget(path) else {
            openPage(url)
            return
        }
        perform(api.openTerminalRequest(engine: target.engine, taskId: target.taskId, terminalId: target.terminalId)) { [weak self] data, code, _ in
            guard let self = self else { return }
            switch openTerminalOutcome(code: code, data: data) {
            case .switched(let focused):
                if !focused { self.raisePage() }
            case .openURL:
                self.openPage(url)
            }
        }
    }

    /// Opens an address: a page of this T-Agent in T-Agent.app when it is installed ("t-agent://open?path="), anything
    /// else (and everything without the app) in the browser.
    func openPage(_ url: URL) {
        if appInstalled(), let link = appOpenLink(url, base: api.base) {
            openURL(link)
        } else {
            openURL(url)
        }
    }

    /// An open page switched to the terminal without the browser extension focusing a tab: the running T-Agent.app comes
    /// forward (its page is the one that took it, by the simplest rule), else the default browser.
    func raisePage() {
        if appRunning() { activateApp() } else { activateBrowser() }
    }

    @objc func openSessionItemClicked(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        openSession(key)
    }

    /// The reply of a panel row, over the list like the task form; it takes the keyboard while it is open.
    func openReplyForm(_ key: String) {
        guard overlay == nil, let item = items.first(where: { $0.key == key }), item.status == "waiting_user",
              item.session?.canReply == true else { return }
        let form = ReplyFormView(key: key, title: item.title)
        form.onSubmit = { [weak self] in self?.submitReplyForm() }
        form.onCancel = { [weak self] in self?.cancelForm() }
        detail.onCancel = form.onCancel
        detail.onReturn = form.onSubmit
        if !options.offscreen { previousApp = NSWorkspace.shared.frontmostApplication }
        showOverlay(form)
        detail.acceptsKey = true
        if !options.offscreen { detail.makeKey() }
        detail.makeFirstResponder(form.field)
    }

    fileprivate func submitReplyForm() {
        guard let form = overlay as? ReplyFormView, !form.busy else { return }
        form.field.commitComposition()
        guard let text = replyText(form.field.typed) else { return }
        form.busy = true
        perform(api.replyRequest(key: form.key, text: text)) { [weak self, weak form] data, code, error in
            guard let self = self else { return }
            form?.busy = false
            self.refreshGeneration += 1
            if (200..<300).contains(code) {
                if let form = form, self.overlay === form { self.closeOverlay() }
                self.refresh()
                return
            }
            self.showDetail()
            self.showToast(L("Reply failed: {1}", failureText(data, error)))
            if code == 404 || code == 409 { self.refresh() }
        }
    }

    // For --self-test and --render-sample.
    var testBubbleActions: [String] { bubbleView?.actionsView?.buttons.map { $0.label } ?? [] }
    var testBubbleReplying: Bool { bubbleView?.actionsView?.replying ?? false }
    var testBubbleError: String {
        guard let field = bubbleView?.actionsView?.errorField, !field.isHidden else { return "" }
        return field.stringValue
    }
    var testBubbleField: ReplyField? { bubbleView?.actionsView?.field }
    func testBubbleAction(_ action: RowAction) -> Bool {
        guard let button = bubbleView?.actionsView?.buttons.first(where: { $0.rowAction == action }) else { return false }
        button.performClick(nil)
        return true
    }
    /// What a press in the middle of a bubble button lands on, through the bubble's hit test.
    func testBubbleButtonHit(_ action: RowAction) -> NSView? {
        guard let view = bubbleView, let button = view.actionsView?.buttons.first(where: { $0.rowAction == action }) else { return nil }
        let point = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: view)
        return view.hitTest(view.convert(point, to: view.superview))
    }
    func testBubbleType(_ text: String) {
        guard let field = testBubbleField else { return }
        if let editor = field.currentEditor() as? NSTextView {
            editor.string = ""
            editor.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
        } else {
            field.stringValue = text
        }
        field.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
    }
    @discardableResult
    func testBubbleKey(_ selector: Selector) -> Bool {
        guard let field = testBubbleField else { return false }
        return field.control(field, textView: (field.currentEditor() as? NSTextView) ?? NSTextView(), doCommandBy: selector)
    }
    var testBubbleSendEnabled: Bool { bubbleView?.actionsView?.sendButton.isEnabled ?? false }
    var testReplyForm: ReplyFormView? { overlay as? ReplyFormView }
}

/// --render-sample, Part B: a bubble with Confirm and Reject, the bubble's reply field (typed, and refused), and the
/// panel's reply form.
func renderPartBSamples(_ controller: WidgetController, dir: String, save: (String, Bool) -> Void) {
    let review = decodeNotice(["seq": 40, "kind": "item", "title": "Refactor the login flow", "status": "review",
                               "text": "Tests pass; ready to merge", "from": "T02 \u{00B7} t-agent", "key": "local:9",
                               "target": "https://github.com/example/app/pull/42"])!
    let waiting = decodeNotice(["seq": 41, "kind": "item", "title": "Deploy the staging build", "status": "waiting_user",
                                "text": "Claude wants to run npm publish", "from": "T01 \u{00B7} SELF-TAGENT", "key": "local:12",
                                "target": "http://127.0.0.1:3000/"])!
    for dark in [false, true] {
        let suffix = dark ? "dark" : "light"
        controller.setAppearance(dark: dark)
        controller.loadForTest(sampleList())
        controller.testClearNotices()
        controller.testPlaceWidget(right: true)
        controller.testShowNotices([review])
        let actions = "bubble-actions-\(suffix).png"
        save(actions, controller.renderBubbleScene((dir as NSString).appendingPathComponent(actions), dark: dark))
        controller.testClearNotices()
        controller.testShowNotices([waiting])
        _ = controller.testBubbleAction(.reply)
        controller.testBubbleType("Yes, publish 2.4.1 to staging")
        let reply = "bubble-reply-\(suffix).png"
        save(reply, controller.renderBubbleScene((dir as NSString).appendingPathComponent(reply), dark: dark))
        if !dark {
            controller.requestHook = { request, answer in
                guard request.url?.path.hasSuffix("/reply") == true else { return }
                answer(Data("{\"error\":\"TERMINAL_NOT_RUNNING\",\"message\":\"The agent's terminal is not running\"}".utf8), 409)
            }
            _ = controller.testBubbleKey(#selector(NSResponder.insertNewline(_:)))
            controller.requestHook = { _, _ in }
            save("bubble-reply-failed.png", controller.renderBubbleScene((dir as NSString).appendingPathComponent("bubble-reply-failed.png"),
                                                                          dark: dark))
        }
        controller.testClearNotices()
        controller.loadForTest(sampleList())
        if controller.testPressButton("local:12", .reply), let form = controller.testReplyForm {
            if let editor = form.field.currentEditor() as? NSTextView {
                editor.insertText("Use the 2.4.1 tag", replacementRange: NSRange(location: NSNotFound, length: 0))
            }
            form.field.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
            let file = "reply-form-\(suffix).png"
            save(file, controller.renderPanel((dir as NSString).appendingPathComponent(file), dark: dark))
            controller.testClose()
        }
    }
}

/// --self-test, Part B: sessions, the bubble's buttons and reply field, Open session and the panel's reply.
func runPartBSelfTest(_ check: (String, Bool) -> Void) {
    func session(_ engine: String = "local", _ task: String, live: Any = true, path: String? = nil) -> [String: Any] {
        ["engine": engine, "task_id": task, "terminal_id": "t1", "agent": "claude", "live": live,
         "open_path": path ?? "/?openTerminal=\(engine):\(task):t1"]
    }
    func item(_ key: String, _ status: String, order: Double = 0, link: String = "", session: [String: Any]? = nil) -> [String: Any] {
        var object: [String: Any] = ["key": key, "status": status, "title": "Task " + key, "sort_order": order, "link_url": link]
        if let session = session { object["session"] = session }
        return object
    }
    func decoded(_ objects: [[String: Any]]) -> ItemList {
        ItemList(items: objects.compactMap(decodeItem), engines: [EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0)],
                 failed: [])
    }
    func json(_ objects: [[String: Any]]) -> Data {
        let engines: [[String: Any]] = [["key": "local", "name": "MacBook", "local": true]]
        return try! JSONSerialization.data(withJSONObject: ["items": objects, "engines": engines, "failed": [String]()] as [String: Any])
    }
    let base = "http://127.0.0.1:3999"

    // The open path and the session field.
    check("session: an open path is accepted", sessionOpenPath("/?openTerminal=local:12:t3") == "/?openTerminal=local:12:t3"
          && sessionOpenPath(" /?openTerminal=remote:7:3:t1 ") == "/?openTerminal=remote:7:3:t1")
    check("session: anything else is no open path", ["", "/?openTerminal=", "/h5?openTerminal=local:1:t1", "//?openTerminal=local:1:t1",
          "/?openTerminal=local:1 t1", "/?openTerminal=local:1\\t1", "/?openterminal=local:1:t1",
          "http://evil.example.com/?openTerminal=local:1:t1", "?openTerminal=local:1:t1", "/?openTerminal=a\u{0007}b"].allSatisfy { sessionOpenPath($0) == nil })
    let full = decodeSession(session("local", "12"))
    check("session: every field is read", full == ItemSession(engine: "local", taskId: "12", terminalId: "t1", agent: "claude", live: true,
                                                               openPath: "/?openTerminal=local:12:t1"))
    check("session: null, missing or not an object is none", decodeSession(NSNull()) == nil && decodeSession(nil) == nil
          && decodeSession("local") == nil && decodeItem(["key": "local:1"])?.session == nil
          && decodeItem(["key": "local:1", "session": NSNull()])?.session == nil)
    check("session: decoded with the item", decodeItem(item("local:12", "waiting_user", session: session("local", "12")))?.session?.openPath
          == "/?openTerminal=local:12:t1")
    check("session: live is only a true or false", decodeSession(session("remote:7", "3", live: NSNull()))?.live == nil
          && decodeSession(session("local", "3", live: 1))?.live == nil && decodeSession(session("local", "3", live: false))?.live == false)
    check("session: a bad open path is kept out", decodeSession(session("local", "3", path: "javascript:alert(1)"))?.openPath == "")
    check("session: a reply needs a live terminal on this machine", full?.canReply == true
          && decodeSession(session("remote:7", "3", live: NSNull()))?.canReply == false
          && decodeSession(session("remote:7", "3", live: true))?.canReply == false
          && decodeSession(session("local", "3", live: false))?.canReply == false)

    // Which buttons a bubble and a row show.
    func notice(_ key: String, _ status: String = "", kind: String = "item", target: String = "") -> WidgetNotice {
        WidgetNotice(seq: 1, kind: kind, title: "N", status: status, key: key, target: target)
    }
    let live = decodeItem(item("local:1", "waiting_user", session: session("local", "1")))!
    let idle = decodeItem(item("local:1", "waiting_user", session: session("local", "1", live: false)))!
    let remote = decodeItem(item("remote:7:3", "waiting_user", session: session("remote:7", "3", live: NSNull())))!
    let bare = decodeItem(item("local:1", "waiting_user"))!
    let review = decodeItem(item("local:1", "review", session: session("local", "1")))!
    check("bubble buttons: review gets Confirm and Reject", bubbleActions(notice("local:1", "review"), item: review) == [.confirm, .reject])
    check("bubble buttons: waiting with a live local terminal gets Handled and Reply",
          bubbleActions(notice("local:1", "waiting_user"), item: live) == [.handled, .reply])
    check("bubble buttons: waiting without a live local terminal gets Handled only",
          bubbleActions(notice("local:1", "waiting_user"), item: idle) == [.handled]
          && bubbleActions(notice("remote:7:3", "waiting_user"), item: remote) == [.handled]
          && bubbleActions(notice("local:1", "waiting_user"), item: bare) == [.handled])
    check("bubble buttons: the list's status counts, not the notice's", bubbleActions(notice("local:1", "waiting_user"), item: review)
          == [.confirm, .reject] && bubbleActions(notice("local:1", "review"), item: decodeItem(item("local:1", "working"))!).isEmpty)
    check("bubble buttons: none for messages, unknown tasks or another key", bubbleActions(notice("local:1", kind: "direct"), item: live).isEmpty
          && bubbleActions(notice("local:1", kind: "test"), item: live).isEmpty && bubbleActions(notice("local:1"), item: nil).isEmpty
          && bubbleActions(notice("local:2", "waiting_user"), item: live).isEmpty && bubbleActions(notice(""), item: live).isEmpty)
    let rows = summarize(decoded([item("local:1", "waiting_user", order: 9, link: "https://example.com/pr", session: session("local", "1")),
                                  item("local:2", "review", order: 8, session: session("local", "2")),
                                  item("local:3", "working", session: session("local", "3")), item("local:4", "working", order: 1),
                                  item("local:5", "waiting_user", order: 1, session: session("local", "5", live: false))]))
    func buttons(_ key: String) -> [RowAction] { (rows.needs + rows.working).first { $0.key == key }.map(rowButtons) ?? [] }
    check("row buttons: link, session, the actions, then Reply", buttons("local:1") == [.link, .session, .handled, .reply])
    check("row buttons: Reply only beside Handled", buttons("local:2") == [.session, .confirm, .reject] && buttons("local:5") == [.session, .handled])
    check("row buttons: Open session in every section, nothing without a session", buttons("local:3") == [.session] && buttons("local:4").isEmpty)
    check("row buttons: a session change changes the row", summarize(decoded([item("local:1", "waiting_user", session: session("local", "1"))]))
          != summarize(decoded([item("local:1", "waiting_user", session: session("local", "1", live: false))])))
    check("row buttons: opening ones stay on while a request is out", RowAction.link.opensOnly && RowAction.session.opensOnly
          && !RowAction.reply.opensOnly && !RowAction.handled.opensOnly)

    // What a click on the bubble opens.
    let linked = decodeItem(item("local:1", "waiting_user", link: "https://example.com/pr", session: session("local", "1")))!
    let pageLinked = decodeItem(item("local:1", "waiting_user", link: "/h5?attention=1"))!
    func opens(_ notice: WidgetNotice, _ item: WidgetItem?) -> String { bubbleOpen(notice, item: item, base: base).url?.absoluteString ?? "-" }
    check("click target: the task's link first (the notice's target)", opens(notice("local:1", target: "https://example.com/pr"), linked)
          == "https://example.com/pr" && opens(notice("local:1"), pageLinked) == base + "/h5?attention=1")
    check("click target: else the session on this T-Agent", opens(notice("local:1", target: base + "/"), live) == base + "/?openTerminal=local:1:t1"
          && opens(notice("remote:7:3", target: base + "/"), remote) == base + "/?openTerminal=remote:7:3:t1"
          && bubbleOpen(notice("local:1"), item: live, base: base).tooltip == "Open session")
    check("click target: else the notice's target, else the page", opens(notice("local:1", target: "https://example.com/n"), bare)
          == "https://example.com/n" && opens(notice("local:9", target: "https://example.com/n"), live) == "https://example.com/n"
          && opens(notice("", kind: "direct"), nil) == base + "/" && bubbleOpen(notice("", kind: "direct"), item: nil, base: base).tooltip
          == "Open T-Agent")
    check("click target: a bad open path is never opened", opens(notice("local:1"),
          decodeItem(item("local:1", "waiting_user", session: session("local", "1", path: "//evil.example.com/?openTerminal=x")))) == base + "/")

    // The reply request.
    check("reply text: trimmed, not empty, at most 4000 UTF-16 units", replyText("  hi  ") == "hi" && replyText(" \n ") == nil
          && replyText(String(repeating: "a", count: 4000)) != nil && replyText(String(repeating: "a", count: 4001)) == nil
          && replyText(String(repeating: "\u{1F600}", count: 2001)) == nil)
    let api = WidgetAPI(base: base, token: "tok")
    let built = api.replyRequest(key: "local:12", text: "Ship \"it\"\nnow")
    check("request: reply", built.httpMethod == "POST" && built.url?.absoluteString == base + "/api/attention/widget/items/local%3A12/reply"
          && built.value(forHTTPHeaderField: "Authorization") == "Bearer tok"
          && built.value(forHTTPHeaderField: "Content-Type") == "application/json"
          && built.httpBody.flatMap { String(data: $0, encoding: .utf8) } == "{\"text\":\"Ship \\\"it\\\"\\nnow\"}")

    // The window, in-process and off screen.
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let board: [[String: Any]] = [
        item("local:1", "waiting_user", order: 9, session: session("local", "1")),
        item("local:2", "review", order: 8),
        item("remote:7:3", "waiting_user", order: 7, session: session("remote:7", "3", live: NSNull())),
        item("local:4", "working", order: 6, session: session("local", "4")),
        item("local:5", "working", order: 5, link: "https://example.com/pr", session: session("local", "5")),
        item("local:6", "waiting_user", order: 1, link: "https://example.com/pr", session: session("local", "6")),
    ]
    let window = WidgetController(api: WidgetAPI(base: base, token: "t"), parentPID: nil, options: options)
    var sent: [URLRequest] = []
    var waiting: [(Data?, Int) -> Void] = []
    var opened: [String] = []
    var listAnswer = json(board)
    window.requestHook = { request, answer in
        sent.append(request)
        if request.httpMethod == "GET" {
            if request.url?.path == "/api/attention/widget/items" { answer(listAnswer, 200) }
            return
        }
        waiting.append(answer)
    }
    window.openURL = { opened.append($0.absoluteString) }
    window.announce = { _ in }
    var browserRaised = 0
    window.activateBrowser = { browserRaised += 1 }
    func answer(_ body: String, _ code: Int) {
        guard !waiting.isEmpty else { return }
        waiting.removeFirst()(Data(body.utf8), code)
    }
    func posts() -> [String] {
        sent.filter { $0.httpMethod == "POST" }.map { ($0.url?.path ?? "") + " " + ($0.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? "") }
    }
    func listReads() -> Int { sent.filter { $0.url?.path == "/api/attention/widget/items" }.count }
    window.loadForTest(decoded(board))
    check("row: Open session and Reply on a live waiting row", window.testButtonTitles("local:1") == ["Open session", "Handled", "Reply"])
    check("row: a remote session can be opened but not replied to", window.testButtonTitles("remote:7:3") == ["Open session", "Handled"])
    check("row: no session, no session buttons", window.testButtonTitles("local:2") == ["Confirm", "Reject"])
    check("row: Open session in Working, after Open link", window.testButtonTitles("local:4") == ["Open session"]
          && window.testButtonTitles("local:5") == ["Open link", "Open session"])
    check("row: four buttons on a waiting row with a link", window.testButtonTitles("local:6") == ["Open link", "Open session", "Handled", "Reply"])
    check("row: the buttons fit their rows", ["local:1", "remote:7:3", "local:4", "local:5", "local:6"].allSatisfy { window.testButtonsInside($0) })
    check("row: Open session first asks T-Agent to switch an open page", window.testPressButton("local:4", .session)
          && posts() == ["/api/attention/widget/open-terminal {\"engine\":\"local\",\"task_id\":\"4\",\"terminal_id\":\"t1\"}"]
          && opened.isEmpty && !window.testHolding())
    answer("{\"error\":\"NOT_FOUND\",\"message\":\"Not found\"}", 404)
    check("row: an older server (404) opens the terminal's page as before", opened == [base + "/?openTerminal=local:4:t1"] && browserRaised == 0)
    check("row menu: Open session after Open link, the row's actions before Edit",
          window.testMenuTitles("local:5") == ["Open link", "Open session", "Edit", "Delete", "Quit"]
          && window.testMenuTitles("local:2") == ["Confirm", "Reject", "Edit", "Delete", "Quit"]
          && window.testMenuTitles("local:1") == ["Open session", "Handled", "Reply", "Edit", "Delete", "Quit"])
    sent = []
    _ = window.testOpenFromRowMenu("remote:7:3", "Open session")
    check("row menu: Open session asks for the remote terminal", posts()
          == ["/api/attention/widget/open-terminal {\"engine\":\"remote:7\",\"task_id\":\"3\",\"terminal_id\":\"t1\"}"])
    answer("{\"delivered\":0,\"focused\":false}", 200)
    check("row menu: no page took it, so the page path opens", opened.last == base + "/?openTerminal=remote:7:3:t1" && opened.count == 2)
    sent = []
    _ = window.testPressButton("local:1", .handled)
    check("row: Open session stays on while the row's action is out", window.testButtonsEnabled("local:1") == [true, false, false]
          && posts() == ["/api/attention/widget/items/local:1/handled {}"])
    answer("{\"error\":\"WRONG_STATUS\",\"message\":\"Not waiting\"}", 409)
    sent = []

    // The panel's reply.
    window.loadForTest(decoded(board))
    check("reply form: Reply opens it, with the keyboard", window.testPressButton("local:1", .reply) && window.testReplyForm?.key == "local:1"
          && window.testPanelCanBecomeKey && window.testHolding() && window.testReplyForm?.field.currentEditor() != nil)
    guard let form = window.testReplyForm, let editor = form.field.currentEditor() as? NSTextView else {
        check("reply form: has a field editor", false)
        return
    }
    func press(_ selector: Selector) -> Bool { form.field.control(form.field, textView: editor, doCommandBy: selector) }
    check("reply form: Send starts disabled, an empty Return sends nothing", !form.sendButton.isEnabled
          && press(#selector(NSResponder.insertNewline(_:))) && sent.isEmpty)
    editor.insertText("Use \u{7b2c}\u{4e8c}", replacementRange: NSRange(location: NSNotFound, length: 0))
    form.field.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
    editor.setMarkedText("ge", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    check("reply form: Return during a composition stays with the input method", !press(#selector(NSResponder.insertNewline(_:))) && sent.isEmpty)
    editor.insertText("\u{4e2a}", replacementRange: editor.markedRange())
    check("reply form: Return sends the text", form.sendButton.isEnabled && press(#selector(NSResponder.insertNewline(_:)))
          && posts() == ["/api/attention/widget/items/local:1/reply {\"text\":\"Use \u{7b2c}\u{4e8c}\u{4e2a}\"}"] && form.busy)
    check("reply form: a second Return while sending sends nothing", press(#selector(NSResponder.insertNewline(_:))) && posts().count == 1)
    let readsBefore = listReads()
    answer("{\"error\":\"TERMINAL_NOT_RUNNING\",\"message\":\"The agent's terminal is not running\"}", 409)
    check("reply form: a refusal keeps the form and its text and says why", window.testReplyForm === form && !form.busy
          && form.field.typed == "Use \u{7b2c}\u{4e8c}\u{4e2a}" && window.testToast == "Reply failed: The agent's terminal is not running")
    check("reply form: a 409 reads the list again", listReads() == readsBefore + 1)
    _ = press(#selector(NSResponder.insertNewline(_:)))
    answer("{\"ok\":true}", 200)
    check("reply form: success closes it and gives up the keyboard", window.testReplyForm == nil && window.testOverlay == nil
          && !window.testPanelCanBecomeKey && listReads() == readsBefore + 2)
    _ = window.testPressButton("local:1", .reply)
    check("reply form: Esc cancels", window.testReplyForm.map { $0.field.control($0.field, textView: NSTextView(),
          doCommandBy: #selector(NSResponder.cancelOperation(_:))) } == true && window.testOverlay == nil && !window.testPanelCanBecomeKey)
    check("reply form: none for a terminal that cannot take it", !window.testPressButton("remote:7:3", .reply) && window.testOverlay == nil)
    sent = []

    // The bubble's buttons.
    window.loadForTest(decoded(board))
    window.testShowNotices([WidgetNotice(seq: 1, kind: "item", title: "Check", status: "review", key: "local:2", target: base + "/")])
    check("bubble: review shows Confirm and Reject", window.testBubbleActions == ["Confirm", "Reject"])
    check("bubble: a button takes its own press", window.testBubbleButtonHit(.confirm) is ActionButton
          && window.testBubbleHit(NSPoint(x: 60, y: (window.testBubbleView?.bounds.height ?? 0) - 20)) is NoticeBubbleView)
    check("bubble: Confirm runs the row's action, closes the bubble and opens nothing", window.testBubbleAction(.confirm)
          && posts() == ["/api/attention/widget/items/local:2/confirm {}"] && window.testBubbleTitle == nil && opened.count == 2)
    answer("{\"error\":\"WRONG_STATUS\",\"message\":\"Not in review\"}", 409)
    check("bubble: a refused action shows the row's message", window.testToast == "Action failed: Not in review")
    sent = []
    window.testShowNotices([WidgetNotice(seq: 2, kind: "item", title: "Allow", status: "waiting_user", key: "local:1", target: base + "/")])
    check("bubble: waiting with a live terminal shows Handled and Reply", window.testBubbleActions == ["Handled", "Reply"])
    window.testLetActionPausePass()  // the Handled of the row above was less than actionDebounce ago
    check("bubble: Handled sends handled and closes", window.testBubbleAction(.handled)
          && posts() == ["/api/attention/widget/items/local:1/handled {}"] && window.testBubbleTitle == nil)
    answer("{}", 200)
    sent = []
    window.loadForTest(decoded(board))
    window.testShowNotices([WidgetNotice(seq: 3, kind: "item", title: "Plan", status: "waiting_user", key: "remote:7:3")])
    check("bubble: a remote terminal gets Handled only", window.testBubbleActions == ["Handled"])
    window.testClearNotices()
    window.testShowNotices([WidgetNotice(seq: 4, kind: "direct", title: "Build finished")])
    check("bubble: a message has no buttons", window.testBubbleView?.actionsView == nil && window.testBubbleActions.isEmpty)
    window.testClearNotices()
    window.testPlaceWidget(right: true)
    let early = board.filter { ($0["key"] as? String) != "local:1" } + [item("local:1", "working", order: 9, session: session("local", "1"))]
    window.loadForTest(decoded(early))
    window.testShowNotices([WidgetNotice(seq: 5, kind: "item", title: "Allow", status: "waiting_user", key: "local:1", seconds: 8)])
    let shortHeight = window.testBubbleFrame.height
    check("bubble: a notice newer than the list has no buttons yet", window.testBubbleActions.isEmpty)
    window.testApply(decoded(board))
    check("bubble: the next list brings them, the bubble grows and keeps its top", window.testBubbleActions == ["Handled", "Reply"]
          && window.testBubbleFrame.height > shortHeight + 15 && abs(window.testBubbleFrame.maxY - window.testWidgetFrame.maxY) < 0.5)

    // The bubble's reply field.
    check("bubble reply: the bubble takes no keyboard before", !window.testBubbleCanBecomeKey && window.testBubbleSeconds == 8)
    _ = window.testBubbleAction(.reply)
    check("bubble reply: Reply opens the field, which takes the keyboard", window.testBubbleReplying && window.testBubbleCanBecomeKey
          && window.testBubbleField?.currentEditor() != nil && window.testBubbleActions == ["Handled", "Reply"])
    check("bubble reply: the timer waits, also after the pointer leaves", window.testBubbleSeconds == nil && {
        window.testBubbleExit()
        return window.testBubbleSeconds == nil
    }())
    check("bubble reply: the field takes its own press", window.testBubbleField.map { field -> Bool in
        guard let view = window.testBubbleView else { return false }
        let point = field.convert(NSPoint(x: 20, y: field.bounds.midY), to: view)
        return window.testBubbleHit(point) === field
    } == true)
    window.testBubbleClick()
    check("bubble reply: a click on the bubble does not lose the reply", window.testBubbleTitle == "Allow" && opened.count == 2
          && window.testBubbleReplying)
    check("bubble reply: an empty Return sends nothing", !window.testBubbleSendEnabled
          && window.testBubbleKey(#selector(NSResponder.insertNewline(_:))) && sent.isEmpty)
    window.testBubbleType("Ship it")
    check("bubble reply: Return sends it", window.testBubbleSendEnabled && window.testBubbleKey(#selector(NSResponder.insertNewline(_:)))
          && posts() == ["/api/attention/widget/items/local:1/reply {\"text\":\"Ship it\"}"] && !window.testBubbleSendEnabled)
    window.testBubbleKey(#selector(NSResponder.insertNewline(_:)))
    window.testBubbleKey(#selector(NSResponder.cancelOperation(_:)))
    check("bubble reply: while it is out, Return and Esc do nothing", posts().count == 1 && window.testBubbleReplying)
    let readsAtReply = listReads()
    answer("{\"error\":\"TERMINAL_NOT_RUNNING\",\"message\":\"The agent's terminal is not running\"}", 409)
    check("bubble reply: a refusal stays in the bubble, in red, with the text", window.testBubbleTitle == "Allow" && window.testBubbleReplying
          && window.testBubbleError == "Reply failed: The agent's terminal is not running" && window.testBubbleField?.typed == "Ship it"
          && window.testBubbleSendEnabled)
    check("bubble reply: a 409 reads the list again", listReads() == readsAtReply + 1)
    window.testBubbleKey(#selector(NSResponder.cancelOperation(_:)))
    check("bubble reply: Esc goes back to the buttons and gives up the keyboard", !window.testBubbleReplying && !window.testBubbleCanBecomeKey
          && window.testBubbleError == "" && window.testBubbleSeconds == 8 && window.testBubbleTitle == "Allow")
    _ = window.testBubbleAction(.reply)
    window.testBubbleType("Ship it now")
    window.testBubbleKey(#selector(NSResponder.insertNewline(_:)))
    answer("{\"error\":\"NOT_FOUND\",\"message\":\"Task not found\"}", 404)
    check("bubble reply: a 404 says why and reads the list again", window.testBubbleError == "Reply failed: Task not found"
          && listReads() == readsAtReply + 2)
    window.testBubbleKey(#selector(NSResponder.insertNewline(_:)))
    answer("{\"ok\":true}", 200)
    check("bubble reply: success closes the bubble and gives up the keyboard", window.testBubbleTitle == nil && !window.testBubbleCanBecomeKey
          && listReads() == readsAtReply + 3 && opened.count == 2)
    window.testShowNotices([WidgetNotice(seq: 6, kind: "item", title: "Again", status: "waiting_user", key: "local:1")])
    _ = window.testBubbleAction(.reply)
    window.testBubbleClose()
    check("bubble reply: the x closes it and gives up the keyboard", window.testBubbleTitle == nil && !window.testBubbleCanBecomeKey)
    window.testShowNotices([WidgetNotice(seq: 7, kind: "item", title: "Late", status: "waiting_user", key: "local:1")])
    _ = window.testBubbleAction(.reply)
    window.testBubbleType("Too late")
    window.testBubbleKey(#selector(NSResponder.insertNewline(_:)))
    window.testBubbleClose()
    answer("{\"error\":\"TERMINAL_NOT_RUNNING\",\"message\":\"Gone\"}", 409)
    check("bubble reply: a refusal after the bubble closed shows in the panel", window.testToast == "Reply failed: Gone" && window.testBubbleTitle == nil)
    sent = []

    // A click on the bubble: the link, else the session.
    window.loadForTest(decoded(board))
    window.testShowNotices([WidgetNotice(seq: 8, kind: "item", title: "Run", status: "working", key: "local:4", target: base + "/")])
    check("bubble click: the tooltip names the session", window.testBubbleView?.toolTip == "Open session" && window.testBubbleActions.isEmpty)
    window.testBubblePress()
    check("bubble click: asks to switch an open page to the session", window.testBubbleTitle == nil
          && posts() == ["/api/attention/widget/open-terminal {\"engine\":\"local\",\"task_id\":\"4\",\"terminal_id\":\"t1\"}"])
    let openedBefore = opened.count
    answer("{\"delivered\":1,\"focused\":false}", 200)
    check("bubble click: a page took it, so the browser comes forward and nothing opens", opened.count == openedBefore && browserRaised == 1)
    sent = []
    window.testShowNotices([WidgetNotice(seq: 9, kind: "item", title: "PR", status: "working", key: "local:5", target: "https://example.com/pr")])
    window.testBubblePress()
    check("bubble click: the task's link comes first", opened.last == "https://example.com/pr" && sent.isEmpty)

    // Words from the table.
    stringTable = ["Open session": "OS", "Reply": "R", "Send": "S", "Reply to the agent": "RA"]
    window.testStringsChanged()
    window.testShowNotices([WidgetNotice(seq: 10, kind: "item", title: "Allow", status: "waiting_user", key: "local:1")])
    check("strings: the new words come from the table", window.testButtonTitles("local:1") == ["OS", "Handled", "R"]
          && window.testBubbleActions == ["Handled", "R"] && window.testBubbleField?.placeholderString == "RA"
          && window.testBubbleView?.actionsView?.sendButton.label == "S")
    stringTable = [:]
    window.testClearNotices()
    listAnswer = json(board)
    check("part B: no window was put on screen", !window.testOnScreen)
}
