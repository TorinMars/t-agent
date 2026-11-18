// T-Agent.app: the application delegate. It wires the monitor, the main window, the menu bar item, the main menu, the
// t-agent:// links and the preferences together. The logic it calls is in the other files and covered by --self-test;
// this file is checked by a person running the app (docs/design/mac-app.md "Self-test"). See main.swift.
import AppKit
import WebKit

// MARK: - Preferences

protocol AppPreferences: AnyObject {
    /// "Start T-Agent when the app opens" (default on).
    var startServiceOnLaunch: Bool { get set }
    /// Hidden: lets Safari's Web Inspector attach to the page (`defaults write local.t-agent.app WebInspector -bool true`).
    var webInspector: Bool { get }
    /// Hidden: the data home when the app cannot see TAGENT_HOME (`defaults write local.t-agent.app DataHome <path>`).
    var dataHome: String? { get }
}

final class UserDefaultsPreferences: AppPreferences {
    let defaults: UserDefaults

    init(_ defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: ["StartServiceOnLaunch": true, "WebInspector": false])
    }

    var startServiceOnLaunch: Bool {
        get { defaults.bool(forKey: "StartServiceOnLaunch") }
        set { defaults.set(newValue, forKey: "StartServiceOnLaunch") }
    }

    var webInspector: Bool {
        #if DEBUG
        return true
        #else
        return defaults.bool(forKey: "WebInspector")
        #endif
    }

    var dataHome: String? { defaults.string(forKey: "DataHome") }
}

final class MemoryPreferences: AppPreferences {
    var startServiceOnLaunch = true
    var webInspector = false
    var dataHome: String?
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate, MainMenuActions, NSMenuItemValidation {
    let services: AppServices
    let preferences: AppPreferences
    let monitor: ServiceMonitor
    private(set) var window: MainWindowController?
    private var statusMenu: StatusMenuController?
    /// A page path from a t-agent://open link, loaded when the page shows.
    private(set) var pendingPath: String?

    init(services: AppServices, preferences: AppPreferences) {
        self.services = services
        self.preferences = preferences
        monitor = ServiceMonitor(services: services, autoStart: { [weak preferences] in preferences?.startServiceOnLaunch ?? false })
        super.init()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Registered before launch finishes, so the link that launched the app is not lost.
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleGetURL(_:withReplyEvent:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
        let menu = buildMainMenu(target: self)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = menu.items.last?.submenu
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = MainWindowController(version: appVersion(), dataStore: .default(), autosave: true, inspectable: preferences.webInspector,
                                          server: { [weak self] in self?.monitor.config.url ?? AppConfig.defaultURL },
                                          openExternal: services.openURL)
        window.onLoadFailed = { [weak self] in self?.monitor.send(.checkNow) }
        window.placeholder.startButton.target = self
        window.placeholder.startButton.action = #selector(startFromPlaceholder(_:))
        window.placeholder.retryButton.target = self
        window.placeholder.retryButton.action = #selector(retryFromPlaceholder(_:))
        self.window = window
        statusMenu = StatusMenuController(entries: { [weak self] in
            guard let self = self else { return [] }
            return statusMenuEntries(self.monitor.state, config: self.monitor.config, autoStart: self.preferences.startServiceOnLaunch)
        }, perform: { [weak self] command in self?.perform(command) })
        monitor.onChange = { [weak self] in self?.stateChanged() }
        monitor.onEffect = { [weak self] effect in self?.handle(effect) }
        window.showPlaceholder(placeholderContent(monitor.state, config: monitor.config))
        monitor.start()
        window.showWindow()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.showWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: Monitor

    private func stateChanged() {
        window?.updatePlaceholder(placeholderContent(monitor.state, config: monitor.config))
        statusMenu?.setToolTip(statusLine(monitor.state, config: monitor.config))
    }

    private func handle(_ effect: MonitorEffect) {
        switch effect {
        case .showPage:
            let path = pendingPath ?? window?.lastPath
            pendingPath = nil
            window?.showPage(path: path)
        case .showPlaceholder:
            window?.showPlaceholder(placeholderContent(monitor.state, config: monitor.config))
        case .explain(let action):
            if case .manual(let message) = services.command(action, config: monitor.config) { explain(message) }
        case .commandFailed(let action, let output):
            showAlert("Could not \(action.rawValue) T-Agent", output)
        case .check, .run:
            break
        }
    }

    // MARK: Links

    @objc func handleGetURL(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else { return }
        guard let link = parseDeepLink(text) else {
            NSLog("T-Agent: ignored a link that is not a T-Agent page link")
            return
        }
        open(link)
    }

    func open(_ link: DeepLink) {
        if case .open(let path) = link {
            if let window = window, window.showingPage, monitor.state.phase == .running {
                window.load(path: path)
            } else {
                pendingPath = path
                monitor.send(.checkNow)
            }
        }
        window?.showWindow()
    }

    // MARK: Menu bar item

    private func perform(_ command: MenuCommand) {
        switch command {
        case .none: break
        case .openWindow: window?.showWindow()
        case .openInBrowser: openInBrowser(nil)
        case .copyAddress(let url): services.copyText(url)
        case .openAddress(let url): if let target = URL(string: url) { services.openURL(target) }
        case .service(let action): request(action)
        case .toggleAutoStart: toggleAutoStart(nil)
        case .quit: NSApp.terminate(nil)
        }
    }

    /// Stop and Restart ask first: browsers, phones and linked devices use the same service.
    private func request(_ action: ServiceAction) {
        if action != .start && monitor.config.supervisor.controllable {
            let alert = NSAlert()
            alert.messageText = action == .stop ? "Stop T-Agent?" : "Restart T-Agent?"
            alert.informativeText = action == .stop
                ? "This stops the T-Agent web service. Browsers, phones and linked devices that use it lose it until it is started again."
                : "This restarts the T-Agent web service. Open pages in the app and in browsers reconnect when it is back."
            alert.addButton(withTitle: action == .stop ? "Stop" : "Restart")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        monitor.send(.request(action))
    }

    private func explain(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Start T-Agent in Terminal"
        alert.informativeText = message
        alert.addButton(withTitle: "Copy Command")
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            services.copyText(manualStartCommand(installDir: monitor.config.installDir, pm2Name: monitor.config.pm2Name))
        }
    }

    private func showAlert(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc func startFromPlaceholder(_ sender: Any?) { request(.start) }

    @objc func retryFromPlaceholder(_ sender: Any?) { monitor.send(.checkNow) }

    // MARK: Main menu actions

    @objc func showAbout(_ sender: Any?) {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "T-Agent",
            .applicationVersion: appVersion(),
            .credits: NSAttributedString(string: "A window for the T-Agent web service. Quitting the app leaves the service running."),
        ])
    }

    @objc func showMainWindow(_ sender: Any?) { window?.showWindow() }

    @objc func openInBrowser(_ sender: Any?) {
        services.openURL(window?.currentPageURL ?? monitor.config.url)
    }

    @objc func toggleAutoStart(_ sender: Any?) { preferences.startServiceOnLaunch.toggle() }

    @objc func reloadPage(_ sender: Any?) { window?.reload() }

    @objc func goBack(_ sender: Any?) { window?.webView.goBack() }

    @objc func goForward(_ sender: Any?) { window?.webView.goForward() }

    @objc func zoomIn(_ sender: Any?) { window?.zoom(by: 1.1) }

    @objc func zoomOut(_ sender: Any?) { window?.zoom(by: 1 / 1.1) }

    @objc func actualSize(_ sender: Any?) { window?.zoom(by: nil) }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        let showing = window?.showingPage ?? false
        switch menuItem.action {
        case #selector(goBack(_:)): return showing && (window?.webView.canGoBack ?? false)
        case #selector(goForward(_:)): return showing && (window?.webView.canGoForward ?? false)
        case #selector(zoomIn(_:)), #selector(zoomOut(_:)), #selector(actualSize(_:)): return showing
        case #selector(toggleAutoStart(_:)):
            menuItem.state = preferences.startServiceOnLaunch ? .on : .off
            return true
        default: return true
        }
    }
}

// MARK: - Real services

/// The services of a running app: the real environment, files, network, processes, timers, browser and pasteboard.
func liveServices(preferences: AppPreferences) -> AppServices {
    AppServices(environment: ProcessInfo.processInfo.environment, home: NSHomeDirectory(), uid: getuid(),
                readFile: { FileManager.default.contents(atPath: $0) },
                defaultsDataHome: { [weak preferences] in preferences?.dataHome },
                health: urlSessionHealthCheck(), runner: foundationProcessRunner(), schedule: dispatchScheduler(), now: Date.init,
                openURL: { NSWorkspace.shared.open($0) },
                copyText: { text in
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                })
}
