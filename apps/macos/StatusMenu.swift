// T-Agent.app: the menu bar item. The entries per state (status line, which actions are enabled, the web addresses) are
// pure and covered by --self-test; the NSMenu is rebuilt from them every time it opens. See main.swift.
import AppKit

// MARK: - Menu model

enum MenuCommand: Equatable {
    case none
    case openWindow
    case openInBrowser
    case copyAddress(String)
    case openAddress(String)
    case service(ServiceAction)
    case toggleAutoStart
    case quit
}

struct MenuEntry: Equatable {
    var title: String
    var command: MenuCommand = .none
    var enabled: Bool = true
    var checked: Bool = false
    /// Shown instead of the entry before it while Option is held.
    var alternate: Bool = false
    var indent: Int = 0
    var separator: Bool = false

    static let line = MenuEntry(title: "", enabled: false, separator: true)
}

func statusLine(_ state: MonitorState, config: AppConfig) -> String {
    switch state.phase {
    case .running:
        if let version = state.version ?? config.version { return "T-Agent is running (v\(version))" }
        return "T-Agent is running"
    case .notRunning: return "T-Agent is not running"
    case .checking: return "Checking T-Agent…"
    case .starting: return "Starting T-Agent…"
    case .restarting: return "Restarting T-Agent…"
    case .stopping: return "Stopping T-Agent…"
    }
}

/// Start only while it is not running; Restart and Stop only while it runs under PM2 or launchd; none while a command or a
/// start is under way. Start stays enabled without a supervisor: it explains how to start the service.
func serviceActionEnabled(_ action: ServiceAction, _ state: MonitorState, config: AppConfig) -> Bool {
    if state.commandRunning { return false }
    switch action {
    case .start: return state.phase == .notRunning
    case .restart, .stop: return state.phase == .running && config.supervisor.controllable
    }
}

/// The menu bar menu: the status (and that browsers use the same service), Open T-Agent, Open in Browser, the web
/// addresses (a click copies one, Option-click opens it in the browser), Start / Restart / Stop, the launch preference
/// and Quit.
func statusMenuEntries(_ state: MonitorState, config: AppConfig, autoStart: Bool) -> [MenuEntry] {
    var entries: [MenuEntry] = [
        MenuEntry(title: statusLine(state, config: config), enabled: false),
        MenuEntry(title: "The same web service your browsers use", enabled: false),
        .line,
        MenuEntry(title: "Open T-Agent", command: .openWindow),
        MenuEntry(title: "Open in Browser", command: .openInBrowser, enabled: state.phase == .running),
        .line,
        MenuEntry(title: "Web addresses", enabled: false),
    ]
    for address in config.addresses {
        entries.append(MenuEntry(title: "\(address.label): \(address.url)", command: .copyAddress(address.url), indent: 1))
        entries.append(MenuEntry(title: "Open \(address.label) in Browser: \(address.url)", command: .openAddress(address.url),
                                 alternate: true, indent: 1))
    }
    entries.append(MenuEntry(title: "Click an address to copy it; hold Option to open it.", enabled: false, indent: 1))
    entries.append(.line)
    for action in [ServiceAction.start, .restart, .stop] {
        entries.append(MenuEntry(title: action.title, command: .service(action), enabled: serviceActionEnabled(action, state, config: config)))
    }
    entries.append(.line)
    entries.append(MenuEntry(title: "Start T-Agent when the app opens", command: .toggleAutoStart, checked: autoStart))
    entries.append(.line)
    entries.append(MenuEntry(title: "Quit T-Agent app", command: .quit))
    return entries
}

// MARK: - NSMenu

/// Carries a MenuCommand on an NSMenuItem.
final class MenuCommandBox: NSObject {
    let command: MenuCommand
    init(_ command: MenuCommand) { self.command = command }
}

/// NSMenu items for the entries; every item with a command calls `action` on `target` with the item as the sender.
func buildMenuItems(_ entries: [MenuEntry], target: AnyObject?, action: Selector) -> [NSMenuItem] {
    entries.map { entry in
        if entry.separator { return NSMenuItem.separator() }
        let item = NSMenuItem(title: entry.title, action: entry.command == .none ? nil : action, keyEquivalent: "")
        item.target = entry.command == .none ? nil : target
        item.isEnabled = entry.enabled
        item.state = entry.checked ? .on : .off
        item.indentationLevel = entry.indent
        item.representedObject = MenuCommandBox(entry.command)
        if entry.alternate {
            item.isAlternate = true
            item.keyEquivalentModifierMask = [.option]
        }
        return item
    }
}

/// The menu bar icon, drawn in code as a template image: a rounded square with a T.
func statusItemImage() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        NSColor.black.setStroke()
        let frame = NSBezierPath(roundedRect: NSRect(x: 2.25, y: 2.25, width: 13.5, height: 13.5), xRadius: 3.5, yRadius: 3.5)
        frame.lineWidth = 1.5
        frame.stroke()
        let letter = NSBezierPath()
        letter.lineWidth = 1.5
        letter.lineCapStyle = .round
        letter.move(to: NSPoint(x: 6, y: 12))
        letter.line(to: NSPoint(x: 12, y: 12))
        letter.move(to: NSPoint(x: 9, y: 12))
        letter.line(to: NSPoint(x: 9, y: 5.5))
        letter.stroke()
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "T-Agent"
    return image
}

/// The NSStatusItem; its menu is rebuilt from `entries()` each time it opens.
final class StatusMenuController: NSObject, NSMenuDelegate {
    let item: NSStatusItem
    let menu = NSMenu()
    var entries: () -> [MenuEntry]
    var perform: (MenuCommand) -> Void

    init(entries: @escaping () -> [MenuEntry], perform: @escaping (MenuCommand) -> Void) {
        self.entries = entries
        self.perform = perform
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        item.button?.image = statusItemImage()
        item.button?.toolTip = "T-Agent"
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        for entry in buildMenuItems(entries(), target: self, action: #selector(choose(_:))) { menu.addItem(entry) }
    }

    func setToolTip(_ text: String) { item.button?.toolTip = text }

    @objc func choose(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? MenuCommandBox else { return }
        perform(box.command)
    }
}
