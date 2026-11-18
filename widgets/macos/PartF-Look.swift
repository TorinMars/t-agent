// T-Attention desktop widget: Part F, the panel's look and Open session on the open page. See main.swift for the overview and the build.
import AppKit

// MARK: - Part F: the panel's look and Open session on the open page
//
// - Rows: the title on one line (an ellipsis when it does not fit; the full text in the tooltip), the custom status and
//   what is pending (or the reason, or the result) as a muted second line of at most two lines. The row's actions are
//   icon buttons (SF Symbols, macOS 11 or later; text buttons otherwise) at the right end of the title line, before the
//   engine tag: always shown in Needs you, under the pointer elsewhere, and always while VoiceOver runs. Every action is
//   also in the row's context menu and its accessibility custom actions.
// - Section headers: a colour dot, the name and a muted count. The search is a magnifier in the top row ("Tasks" and the
//   count beside it) that opens the field; Cmd+F and Ctrl+Option+T open it too.
// - The background: the menu material's blur under a veil of the window background colour at backgroundVeil.
// - Open session, a "Working now" row and a bubble that opens a session first POST /api/attention/widget/open-terminal:
//   the most recently used T-Agent page of this machine switches to the terminal in place (routes/attention-widget.js).
//   { delivered >= 1 } -> nothing opens; unless `focused` (the browser extension brought that tab forward), the default
//   browser is activated without an address. delivered 0, a 404 (an older T-Agent) or any failure -> the page path opens
//   in the browser as before.

/// --render-sample: the panel over terminal-like text (the veil keeps it readable), light and dark, and the hover state.
func renderLookSamples(_ controller: WidgetController, dir: String, save: (String, Bool) -> Void) {
    for dark in [false, true] {
        let suffix = dark ? "dark" : "light"
        controller.setAppearance(dark: dark)
        controller.loadForTest(sampleList())
        let name = "panel-over-text-\(suffix).png"
        save(name, controller.renderPanelOverText((dir as NSString).appendingPathComponent(name), dark: dark))
        controller.testRowView("local:20")?.setHovered(true)
        let hover = "panel-hover-\(suffix).png"
        save(hover, controller.renderPanel((dir as NSString).appendingPathComponent(hover), dark: dark))
        controller.testRowView("local:20")?.setHovered(false)
        controller.testSearchButton()
        let search = "panel-search-open-\(suffix).png"
        save(search, controller.renderPanel((dir as NSString).appendingPathComponent(search), dark: dark))
        controller.unpinPanel()
    }
    controller.setAppearance(dark: false)
    controller.loadForTest(sampleList())
    for key in ["local:12", "local:14", "local:9", "remote:7:3", "local:20", "local:21", "local:22", "local:23", "remote:7:8", "local:30", "remote:9:2"] {
        print("row height \(key): \(controller.testRowHeight(key))")
    }
}

extension WidgetController {
    /// The panel on a background of terminal-like text, offscreen: the blur draws nothing offscreen, so this shows what
    /// the veil alone leaves of the text behind.
    func renderPanelOverText(_ path: String, dark: Bool) -> Bool {
        guard let view = detail.contentView else { return false }
        view.layoutSubtreeIfNeeded()
        let margin: CGFloat = 24
        let size = NSSize(width: view.bounds.width + margin * 2, height: view.bounds.height + margin * 2)
        let scale: CGFloat = 2
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds),
              let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: out) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let transform = NSAffineTransform()
        transform.scale(by: scale)
        transform.concat()
        (dark ? NSColor(white: 0.08, alpha: 1) : NSColor(white: 0.97, alpha: 1)).setFill()
        NSRect(origin: .zero, size: size).fill()
        let words = ["$ npm test", "ok 412 - attention widget tick", "PASS test/routes.test.js", "\u{2713} renders the panel",
                     "warning: unused variable", "> node scripts/build.js", "Compiling TAttentionWidget.swift", "done in 4.2s"]
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: dark ? NSColor(white: 0.85, alpha: 1) : NSColor(white: 0.15, alpha: 1),
        ]
        var y = size.height - 16
        var index = 0
        while y > 0 {
            NSAttributedString(string: words[index % words.count] + "   " + words[(index + 3) % words.count], attributes: attributes)
                .draw(at: NSPoint(x: 6, y: y))
            y -= 15
            index += 1
        }
        rep.draw(in: NSRect(x: margin, y: margin, width: view.bounds.width, height: view.bounds.height), from: .zero,
                 operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
        guard let png = out.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: URL(fileURLWithPath: path))) != nil
    }
}

/// --self-test, Part F.
func runLookSelfTest(_ check: (String, Bool) -> Void) {
    // The open-terminal request and its answer.
    check("open terminal: the page path names the terminal", openTerminalTarget("/?openTerminal=local:12:t3").map { [$0.engine, $0.taskId, $0.terminalId] }
          == ["local", "12", "t3"] && openTerminalTarget("/?openTerminal=remote:7:3:t-1_a").map { [$0.engine, $0.taskId, $0.terminalId] }
          == ["remote:7", "3", "t-1_a"])
    check("open terminal: anything else names none", ["", "/?openTerminal=", "/?openTerminal=local:0:t1", "/?openTerminal=other:1:t1",
          "/?openTerminal=local:1:t 1", "/h5?openTerminal=local:1:t1", "/?openTerminal=local:1:" + String(repeating: "a", count: 65)]
          .allSatisfy { openTerminalTarget($0) == nil })
    let api = WidgetAPI(base: "http://127.0.0.1:3999", token: "tok")
    let built = api.openTerminalRequest(engine: "remote:7", taskId: "3", terminalId: "t1")
    check("request: open-terminal", built.httpMethod == "POST" && built.url?.absoluteString == "http://127.0.0.1:3999/api/attention/widget/open-terminal"
          && built.value(forHTTPHeaderField: "Authorization") == "Bearer tok" && built.value(forHTTPHeaderField: "Content-Type") == "application/json"
          && built.httpBody.flatMap { String(data: $0, encoding: .utf8) } == "{\"engine\":\"remote:7\",\"task_id\":\"3\",\"terminal_id\":\"t1\"}")
    func outcome(_ body: String, _ code: Int = 200) -> OpenTerminalOutcome { openTerminalOutcome(code: code, data: Data(body.utf8)) }
    check("open terminal: a page took it", outcome("{\"delivered\":1,\"focused\":true}") == .switched(focused: true)
          && outcome("{\"delivered\":1,\"focused\":false}") == .switched(focused: false) && outcome("{\"delivered\":2}") == .switched(focused: false))
    check("open terminal: no page, an older server or a failure opens the address", outcome("{\"delivered\":0,\"focused\":false}") == .openURL
          && outcome("{\"error\":\"NOT_FOUND\"}", 404) == .openURL && outcome("", 0) == .openURL && outcome("{}", 500) == .openURL
          && outcome("[1]") == .openURL && outcome("{\"delivered\":\"x\"}") == .openURL && outcome("{\"delivered\":1}", 401) == .openURL)

    // The panel.
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let window = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:3999", token: "t"), parentPID: nil, options: options)
    var sent: [URLRequest] = []
    var answers: [(Data?, Int) -> Void] = []
    var opened: [String] = []
    var raised = 0
    var voiceOver = false
    window.requestHook = { request, answer in
        sent.append(request)
        answers.append(answer)
    }
    window.openURL = { opened.append($0.absoluteString) }
    window.activateBrowser = { raised += 1 }
    window.announce = { _ in }
    window.alwaysShowRowActions = { voiceOver }
    func posts() -> [String] {
        sent.filter { $0.httpMethod == "POST" }.map { ($0.url?.path ?? "") + " " + ($0.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? "") }
    }
    func answer(_ body: String, _ code: Int = 200) {
        guard !answers.isEmpty else { return }
        answers.removeLast()(Data(body.utf8), code)
    }
    window.loadForTest(sampleList())
    func shown(_ key: String) -> [RowAction] {
        window.testRowView(key)?.actionButtons.filter { !$0.isHidden }.map { $0.rowAction } ?? []
    }
    func all(_ key: String) -> [RowAction] { window.testRowView(key)?.actionButtons.map { $0.rowAction } ?? [] }
    check("icons: a waiting row with a link and a live terminal", all("local:12") == [.link, .session, .handled, .reply])
    check("icons: a review row confirms and rejects", all("local:9") == [.link, .confirm, .reject] && all("local:14") == [.link, .confirm, .reject])
    check("icons: a remote waiting row opens its session and is handled", all("remote:7:3") == [.session, .handled])
    check("icons: rows outside Needs you only open things", all("local:20") == [.session] && all("local:23") == [.link]
          && all("local:21").isEmpty && all("local:30") == [.link])
    check("icons: drawn as symbols, the words as tooltip and accessibility label", window.testRowView("local:12")?.actionButtons.allSatisfy {
        $0.isIcon && $0.toolTip == ($0.rowAction == .link ? "CI run" : $0.label) && $0.accessibilityLabel() == ($0.rowAction == .link ? "Open link: CI run" : $0.label)
    } == true && window.testButton("local:12", .handled)?.label == "Handled")
    check("icons: each action has its own symbol", Set([RowAction.confirm, .reject, .handled, .link, .session, .reply].map { $0.symbolName }).count == 6
          && [RowAction.confirm, .reject, .handled, .link, .session, .reply].allSatisfy { symbolImage($0.symbolName) != nil })
    check("icons: on the title line, before the engine tag", ["local:12", "local:9", "remote:7:3"].allSatisfy { key in
        guard let row = window.testRowView(key), let pill = window.testPill(key), let title = window.testTitleField(key) else { return false }
        let pillFrame = pill.convert(pill.bounds, to: row)
        let titleFrame = title.convert(title.bounds, to: row)
        return row.actionButtons.allSatisfy { button in
            let frame = button.convert(button.bounds, to: row)
            return frame.maxX <= pillFrame.minX && frame.minX >= titleFrame.maxX && abs(frame.midY - titleFrame.midY) < 2
        }
    })
    check("hover: Needs you shows its icons all the time", shown("local:12") == [.link, .session, .handled, .reply] && shown("local:9") == [.link, .confirm, .reject])
    check("hover: other sections hide them until the pointer is over the row", shown("local:20").isEmpty && shown("local:23").isEmpty
          && shown("local:30").isEmpty)
    window.testRowView("local:20")?.setHovered(true)
    check("hover: the pointer over a Working row shows them", shown("local:20") == [.session] && window.testButtonTakesPress("local:20", .session))
    window.testRowView("local:20")?.setHovered(false)
    check("hover: and leaving hides them again; a hidden icon never takes a press", shown("local:20").isEmpty && {
        guard let row = window.testRowView("local:20"), let button = row.actionButtons.first else { return false }
        return row.hitTest(button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: row.superview)) === row
    }())
    voiceOver = true
    window.loadForTest(sampleList())
    check("hover: with VoiceOver every row shows its icons", shown("local:20") == [.session] && shown("local:30") == [.link])
    voiceOver = false
    window.loadForTest(sampleList())
    check("keyboard: a Working row's actions are in its menu", window.testMenuTitles("local:20") == ["Open session", "Edit", "Delete", "Quit"])
    check("keyboard: a review row's menu confirms and rejects", window.testMenuTitles("local:9") == ["Open link", "Confirm", "Reject", "Edit", "Delete", "Quit"])
    let custom = window.testRowView("local:12")?.accessibilityCustomActions()?.map { $0.name } ?? []
    check("VoiceOver: the row is one element with its actions", window.testRowView("local:12")?.isAccessibilityElement() == true
          && custom == ["Open link: CI run", "Open session", "Handled", "Reply"]
          && window.testRowView("local:12")?.accessibilityLabel() == "Deploy the staging build. Allow running npm publish?")
    check("VoiceOver: a hidden row's actions are still there", window.testRowView("local:20")?.accessibilityCustomActions()?.map { $0.name } == ["Open session"])
    _ = window.testRowView("local:20")?.accessibilityCustomActions()?.first?.handler?()
    check("VoiceOver: its Open session asks to switch an open page", posts()
          == ["/api/attention/widget/open-terminal {\"engine\":\"local\",\"task_id\":\"20\",\"terminal_id\":\"t1\"}"] && opened.isEmpty)
    answer("{\"delivered\":1,\"focused\":true}")
    check("open session: a page took it and the extension focused the tab: nothing else happens", opened.isEmpty && raised == 0)
    sent = []
    _ = window.testOpenFromRowMenu("local:9", "Confirm")
    check("keyboard: Confirm from the menu runs the row's action", posts() == ["/api/attention/widget/items/local:9/confirm {}"])
    answer("{\"error\":\"WRONG_STATUS\",\"message\":\"No\"}", 409)
    sent = []
    window.loadForTest(sampleList())
    check("open session: pressed", window.testPressButton("local:12", .session) && posts().count == 1 && opened.isEmpty)
    answer("{\"delivered\":1,\"focused\":false}")
    check("open session: without the extension the default browser comes forward, no address opens", opened.isEmpty && raised == 1)
    _ = window.testPressButton("local:12", .session)
    answer("{\"delivered\":0,\"focused\":false}")
    check("open session: no page open, so the address opens as before", opened == ["http://127.0.0.1:3999/?openTerminal=local:12:t1"] && raised == 1)
    _ = window.testPressButton("local:12", .session)
    answer("{\"error\":\"NOT_FOUND\",\"message\":\"Not found\"}", 404)
    check("open session: an older T-Agent (404) opens the address as before", opened.count == 2 && raised == 1)
    _ = window.testPressButton("local:12", .session)
    answer("", 0)
    check("open session: T-Agent unreachable opens the address", opened.count == 3)

    // The text of the rows.
    check("rows: the title alone on its line", window.testTitleField("local:20")?.stringValue == "Build the widget API"
          && window.testTitleField("local:22")?.stringValue == "   \u{2514} Fix the flaky stream test")
    check("rows: the custom status and the detail are the muted second line", window.testSecondLine("local:20")?.stringValue == "Blocked"
          && window.testSecondLine("local:12")?.stringValue == "Allow running npm publish?"
          && window.testSecondLine("remote:7:8")?.stringValue == "Step 3 of 5" && window.testSecondLine("local:21") == nil
          && window.testSecondLine("local:12")?.textColor == .secondaryLabelColor)
    check("rows: a sub-task's second line starts under its title", {
        guard let row = window.testRowView("local:22"), let second = window.testSecondLine("local:22") else { return false }
        return second.frame.minX > 20 && row.frame.height < 40
    }())
    var long = sampleList()
    long.items[0].pending = String(repeating: "A very long question that goes on and on. ", count: 8)
    long.items[0].customStatus = "Waiting"
    window.loadForTest(long)
    check("rows: the second line is at most two lines", window.testSecondLine("local:12")?.maximumNumberOfLines == 2
          && window.testRowHeight("local:12") <= rowIconSize + 30 && window.testSecondLine("local:12")?.stringValue.hasPrefix("Waiting \u{00B7} A very") == true)
    window.loadForTest(sampleList())
    check("rows: shorter than before (73 / 51 / 37 pt)", window.testRowHeight("local:12") <= 36 && window.testRowHeight("local:9") <= 36
          && window.testRowHeight("local:20") <= 36 && window.testRowHeight("remote:7:3") <= 36)

    // Headers, the background and the search.
    let lines = window.testLines
    check("headers: no emoji, the name first", lines.contains("Needs you") && lines.contains("Working") && lines.contains("To do")
          && !lines.contains { $0.unicodeScalars.contains { $0.value >= 0x1F300 } })
    let needs = window.testSectionHeader(.needs)
    check("headers: a red dot and the count", needs?.dot.color == NSColor.systemRed && needs?.countField.stringValue == "4"
          && window.testSectionHeader(.working)?.countField.stringValue == "5" && window.testSectionHeader(.todo)?.dot.color == NSColor.systemYellow)
    check("background: the blur has the veil", window.testBackgroundVeiled)
    check("search: the magnifier and + are icons", window.testSearchButtonIsIcon && window.testPlusIsIcon)
    symbolsAvailable = false
    let fallback = ActionButton(.confirm, icon: true)
    check("icons: without symbols the buttons are text again", !fallback.isIcon && fallback.intrinsicContentSize.width > 30)
    symbolsAvailable = true
    check("part F: no window was put on screen", !window.testOnScreen)
}
