// T-Agent.app: the main menu. A program built without a nib has no menu, and without an Edit menu with the standard
// selectors Cmd+C, Cmd+V, Cmd+X, Cmd+A and Cmd+Z do nothing in the web view. Checked by --self-test. See main.swift.
import AppKit

// MARK: - Main menu

/// The actions of the app's own menu items, sent to the app delegate.
@objc protocol MainMenuActions {
    func showAbout(_ sender: Any?)
    func showMainWindow(_ sender: Any?)
    func openInBrowser(_ sender: Any?)
    func toggleAutoStart(_ sender: Any?)
    func reloadPage(_ sender: Any?)
    func goBack(_ sender: Any?)
    func goForward(_ sender: Any?)
    func zoomIn(_ sender: Any?)
    func zoomOut(_ sender: Any?)
    func actualSize(_ sender: Any?)
}

private func menuItem(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command],
                      target: AnyObject? = nil) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = modifiers
    item.target = target
    return item
}

private func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
    let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    let menu = NSMenu(title: title)
    for item in items { menu.addItem(item) }
    holder.submenu = menu
    return holder
}

/// App, File, Edit, View, History, Window. Edit uses the standard first-responder selectors (nil target), so the web view
/// (or a text field of an alert) handles them; the app's own items go to `target`.
func buildMainMenu(target: MainMenuActions) -> NSMenu {
    let main = NSMenu(title: "Main Menu")
    let app = submenu("T-Agent", [
        menuItem("About T-Agent", #selector(MainMenuActions.showAbout(_:)), "", [], target: target),
        .separator(),
        menuItem("Start T-Agent when the app opens", #selector(MainMenuActions.toggleAutoStart(_:)), "", [], target: target),
        .separator(),
        menuItem("Hide T-Agent", #selector(NSApplication.hide(_:)), "h"),
        menuItem("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
        menuItem("Show All", #selector(NSApplication.unhideAllApplications(_:)), "", []),
        .separator(),
        menuItem("Quit T-Agent", #selector(NSApplication.terminate(_:)), "q"),
    ])
    let file = submenu("File", [
        menuItem("Open in Browser", #selector(MainMenuActions.openInBrowser(_:)), "o", [.command, .shift], target: target),
        .separator(),
        menuItem("Close Window", #selector(NSWindow.performClose(_:)), "w"),
    ])
    let edit = submenu("Edit", [
        menuItem("Undo", Selector(("undo:")), "z"),
        menuItem("Redo", Selector(("redo:")), "z", [.command, .shift]),
        .separator(),
        menuItem("Cut", #selector(NSText.cut(_:)), "x"),
        menuItem("Copy", #selector(NSText.copy(_:)), "c"),
        menuItem("Paste", #selector(NSText.paste(_:)), "v"),
        menuItem("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
        menuItem("Delete", #selector(NSText.delete(_:)), "", []),
        menuItem("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    let view = submenu("View", [
        menuItem("Reload Page", #selector(MainMenuActions.reloadPage(_:)), "r", target: target),
        .separator(),
        menuItem("Actual Size", #selector(MainMenuActions.actualSize(_:)), "0", target: target),
        menuItem("Zoom In", #selector(MainMenuActions.zoomIn(_:)), "=", target: target),
        menuItem("Zoom Out", #selector(MainMenuActions.zoomOut(_:)), "-", target: target),
        .separator(),
        menuItem("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    let history = submenu("History", [
        menuItem("Back", #selector(MainMenuActions.goBack(_:)), "[", target: target),
        menuItem("Forward", #selector(MainMenuActions.goForward(_:)), "]", target: target),
    ])
    let windowMenu = submenu("Window", [
        menuItem("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
        menuItem("Zoom", #selector(NSWindow.performZoom(_:)), "", []),
        .separator(),
        menuItem("T-Agent", #selector(MainMenuActions.showMainWindow(_:)), "", [], target: target),
        .separator(),
        menuItem("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), "", []),
    ])
    for item in [app, file, edit, view, history, windowMenu] { main.addItem(item) }
    return main
}
