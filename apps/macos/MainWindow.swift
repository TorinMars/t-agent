// T-Agent.app: the main window. A WKWebView on the server (default persistent website data store, so the login cookie
// survives restarts) or the native placeholder while the server does not answer. The decisions it makes (navigation,
// microphone, download names) are the pure functions of URLPolicy.swift. See main.swift.
import AppKit
import WebKit

// MARK: - Title bar

/// The colour of the page's top bars (the rail and the session header: the dark theme's 1dp surface, `theme-color` in
/// public/h5.html), used until the page reports its own `theme-color`.
let pageTitleBarFallback = NSColor(srgbRed: 0x1e / 255.0, green: 0x1e / 255.0, blue: 0x1e / 255.0, alpha: 1)

/// Paints the title bar in the page's colour ("Title bar" in docs/design/mac-app.md): the title bar is transparent over the
/// window background, which takes `color` (the page's theme colour, or the fallback), and the window's appearance is dark
/// or light by that colour, so the title and the window buttons stay readable. The title stays shown.
func applyPageTitleBar(_ window: NSWindow, color: NSColor?) {
    let fill = (color ?? pageTitleBarFallback).usingColorSpace(.sRGB) ?? pageTitleBarFallback
    // Relative luminance (sRGB weights on the gamma-encoded values are close enough to pick dark or light).
    let luminance = 0.2126 * fill.redComponent + 0.7152 * fill.greenComponent + 0.0722 * fill.blueComponent
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .visible
    window.backgroundColor = fill
    window.appearance = NSAppearance(named: luminance < 0.5 ? .darkAqua : .aqua)
}

// MARK: - Main window

/// The configuration of the web view: the website data store and the user agent, which is WebKit's default with
/// " T-AgentApp/<version>" appended (applicationNameForUserAgent appends to the default, so the page and the server can
/// tell the app from a browser).
func makeWebViewConfiguration(version: String, dataStore: WKWebsiteDataStore) -> WKWebViewConfiguration {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = dataStore
    configuration.applicationNameForUserAgent = "T-AgentApp/\(version)"
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    if #available(macOS 12.3, *) { configuration.preferences.isElementFullscreenEnabled = true }
    return configuration
}

/// The `tagentOpen` script message handler. WKUserContentController keeps its handlers strongly, so the window is held weakly here.
final class OpenLinkMessages: NSObject, WKScriptMessageHandler {
    weak var target: MainWindowController?
    init(_ target: MainWindowController) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        target?.openLink(body: message.body, scheme: origin.protocol, host: origin.host, port: origin.port)
    }
}

/// The `tagentInputSource` script message handler ("English input while spelling" in docs/design/mac-app.md); the window is
/// held weakly, as in OpenLinkMessages.
final class InputSourceMessages: NSObject, WKScriptMessageHandler {
    weak var target: MainWindowController?
    init(_ target: MainWindowController) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        target?.inputSourceMessage(body: message.body, scheme: origin.protocol, host: origin.host, port: origin.port)
    }
}

final class MainWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    static let autosaveName = "T-Agent Main Window"
    /// The script message the page sends a link to open in the default browser (linkToOpen, docs/design/open-links.md).
    static let openLinkMessage = "tagentOpen"
    /// The script message the page sends while the person spells a word ("English input while spelling" in docs/design/mac-app.md).
    static let inputSourceMessage = "tagentInputSource"

    let window: NSWindow
    let webView: WKWebView
    let placeholder = PlaceholderView(frame: .zero)
    /// The server's base address now (app.json can change it).
    var server: () -> URL
    var openExternal: (URL) -> Void
    /// A main-frame load failed (the server went away): the monitor checks at once.
    var onLoadFailed: (() -> Void)?
    var downloadsFolder: () -> String = { FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first?.path
        ?? (NSHomeDirectory() as NSString).appendingPathComponent("Downloads") }
    /// The page that was open when the server went away, to load again when it is back.
    var lastPath: String?
    private(set) var showingPage = false
    /// One line after the page's title (Failover.swift: which linked engine is shown and the way back), or nil.
    var titleNote: String? { didSet { refreshTitle() } }
    private var titleObservation: NSKeyValueObservation?
    private var themeColorObservation: NSKeyValueObservation?
    /// Where each running download goes.
    private var downloadPaths: [ObjectIdentifier: String] = [:]
    private(set) var openLinkMessages: OpenLinkMessages?
    private(set) var inputSourceMessages: InputSourceMessages?
    /// English input while spelling: remembers the person's input source and gives it back.
    let inputSource: InputSourceSwitcher
    /// English is selected only while this window is the key window of the active app, so another app's input never changes.
    var canSwitchInputSource: () -> Bool = { false }
    private var appObservers: [NSObjectProtocol] = []

    /// `autosave` false (the self-test) neither restores nor saves the frame. `inspectable` lets Safari's Web Inspector
    /// attach (macOS 13.3 and newer). `inputSources` are the real input source calls (`.system`) or the self-test's fakes.
    init(version: String, dataStore: WKWebsiteDataStore, autosave: Bool, inspectable: Bool, inputSources: InputSources,
         server: @escaping () -> URL, openExternal: @escaping (URL) -> Void) {
        self.server = server
        self.openExternal = openExternal
        inputSource = InputSourceSwitcher(sources: inputSources)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: true)
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820),
                            configuration: makeWebViewConfiguration(version: version, dataStore: dataStore))
        super.init()
        window.title = "T-Agent"
        applyPageTitleBar(window, color: nil)
        window.minSize = NSSize(width: 480, height: 360)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.delegate = self
        window.center()
        if autosave { window.setFrameAutosaveName(MainWindowController.autosaveName) }

        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        let messages = OpenLinkMessages(self)
        webView.configuration.userContentController.add(messages, name: MainWindowController.openLinkMessage)
        openLinkMessages = messages
        let inputMessages = InputSourceMessages(self)
        webView.configuration.userContentController.add(inputMessages, name: MainWindowController.inputSourceMessage)
        inputSourceMessages = inputMessages
        canSwitchInputSource = { [weak self] in NSApp.isActive && self?.window.isKeyWindow == true }
        // Never left switched: the app going to the background or quitting gives the person's input source back.
        for name in [NSApplication.didResignActiveNotification, NSApplication.willTerminateNotification] {
            appObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.restoreInputSource()
            })
        }
        if #available(macOS 13.3, *) { webView.isInspectable = inspectable }
        webView.autoresizingMask = [.width, .height]
        placeholder.autoresizingMask = [.width, .height]

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820))
        container.autoresizingMask = [.width, .height]
        webView.frame = container.bounds
        placeholder.frame = container.bounds
        container.addSubview(webView)
        container.addSubview(placeholder)
        webView.isHidden = true
        window.contentView = container
        window.initialFirstResponder = webView

        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            self?.refreshTitle()
        }
        // The page's theme-color (macOS 12 and newer) paints the title bar; without one it keeps the fallback.
        if #available(macOS 12.0, *) {
            themeColorObservation = webView.observe(\.themeColor, options: [.new]) { [weak self] view, _ in
                guard let self = self else { return }
                applyPageTitleBar(self.window, color: self.showingPage ? view.themeColor : nil)
            }
        }
    }

    deinit {
        for observer in appObservers { NotificationCenter.default.removeObserver(observer) }
    }

    /// The page's title (or T-Agent), then the note when there is one.
    func refreshTitle() {
        let page = showingPage ? (webView.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines) : ""
        let base = page.isEmpty ? "T-Agent" : page
        window.title = titleNote.map { "\(base) — \($0)" } ?? base
    }

    // MARK: Showing

    func showWindow() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if showingPage { window.makeFirstResponder(webView) }
    }

    /// Shows the web view and loads `path` of the server (the root when it is nil or not a page of the server).
    func showPage(path: String?) {
        let base = server()
        let target = path.flatMap { serverPageURL(base: base, path: $0) } ?? base
        showingPage = true
        if #available(macOS 12.0, *) { applyPageTitleBar(window, color: webView.themeColor) }
        placeholder.removeFromSuperview()
        webView.isHidden = false
        webView.load(URLRequest(url: target))
        if window.isVisible { window.makeFirstResponder(webView) }
    }

    /// Loads a path in the page that is shown (a deep link while the server runs).
    func load(path: String) {
        guard let target = serverPageURL(base: server(), path: path) else { return }
        webView.load(URLRequest(url: target))
    }

    /// Shows the placeholder and remembers the page that was open.
    func showPlaceholder(_ content: PlaceholderContent) {
        restoreInputSource()
        if showingPage, let path = pagePath(of: webView.url, server: server()) { lastPath = path }
        showingPage = false
        applyPageTitleBar(window, color: nil) // the placeholder has no theme colour: back to the page's usual one
        placeholder.show(content)
        if placeholder.superview == nil, let container = window.contentView {
            placeholder.frame = container.bounds
            container.addSubview(placeholder)
        }
        webView.isHidden = true
        refreshTitle()
    }

    func updatePlaceholder(_ content: PlaceholderContent) {
        if placeholder.content != content { placeholder.show(content) }
    }

    /// The page's address when it is a page of the server, else the server itself.
    var currentPageURL: URL {
        let base = server()
        if showingPage, let url = webView.url, sameOrigin(url, base) { return url }
        return base
    }

    // MARK: Window

    /// Closing the window only hides it: the app keeps running in the menu bar.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        restoreInputSource()
        window.orderOut(nil)
        return false
    }

    /// Another window or app takes the keyboard: the person's input source back. Becoming key again switches nothing by
    /// itself; the page asks for English again on the next focus of a spelling field.
    func windowDidResignKey(_ notification: Notification) { restoreInputSource() }

    func windowDidResignMain(_ notification: Notification) { restoreInputSource() }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        let url = navigationAction.request.url
        let decision = navigationDecision(url: url, server: server(), mainFrame: navigationAction.targetFrame?.isMainFrame ?? true,
                                          newWindow: navigationAction.targetFrame == nil)
        switch decision {
        case .allow:
            decisionHandler(.allow)
        case .openExternally:
            decisionHandler(.cancel)
            if let url = url { openExternal(url) }
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if !navigationResponse.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// A main-frame load or reload starts: the spelling field is gone, so the person's input source comes back.
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        restoreInputSource()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    private func handleLoadError(_ error: Error) {
        let nsError = error as NSError
        // A cancelled load, or one that became a download (WebKitErrorFrameLoadInterruptedByPolicyChange), is no failure.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        onLoadFailed?()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        restoreInputSource()
        if showingPage { webView.reload() }
    }

    // MARK: Downloads (to ~/Downloads)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let folder = downloadsFolder()
        let path = uniqueDownloadPath(folder: folder, name: safeDownloadName(suggestedFilename),
                                      exists: { FileManager.default.fileExists(atPath: $0) })
        downloadPaths[ObjectIdentifier(download)] = path
        completionHandler(URL(fileURLWithPath: path))
    }

    func downloadDidFinish(_ download: WKDownload) {
        // Makes the Downloads stack in the Dock bounce, as a browser download does.
        guard let path = downloadPaths.removeValue(forKey: ObjectIdentifier(download)) else { return }
        DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"), object: path)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadPaths.removeValue(forKey: ObjectIdentifier(download))
        NSLog("T-Agent: a download failed: %@", error.localizedDescription)
    }

    // MARK: Links from the page

    /// A link the page hands over (a program in a terminal opened it): http(s) from the server's own origin opens in the default browser.
    func openLink(body: Any?, scheme: String, host: String, port: Int) {
        if let url = linkToOpen(body: body, frameScheme: scheme, frameHost: host, framePort: port, server: server()) { openExternal(url) }
    }

    // MARK: English input while spelling

    /// A `tagentInputSource` message ("English input while spelling" in docs/design/mac-app.md): "english" from the server's
    /// own origin selects English while the window is key in the active app, "restore" gives the person's source back.
    func inputSourceMessage(body: Any?, scheme: String, host: String, port: Int) {
        switch inputSourceRequest(body: body, frameScheme: scheme, frameHost: host, framePort: port, server: server()) {
        case .english?: if canSwitchInputSource() { inputSource.english() }
        case .restore?: inputSource.restore()
        case nil: break
        }
    }

    func restoreInputSource() { inputSource.restore() }

    // MARK: UI delegate

    /// target=_blank and window.open: never a second web view; http(s) and mailto: open in their app.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        let url = navigationAction.request.url
        if navigationDecision(url: url, server: server(), mainFrame: true, newWindow: true) == .openExternally, let url = url {
            openExternal(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(grantsMediaCapture(scheme: origin.protocol, host: origin.host, port: origin.port, server: server()) ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "T-Agent"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "T-Agent"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "T-Agent"
        alert.informativeText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    // MARK: Menu actions

    func reload() {
        if showingPage { webView.reload() } else { onLoadFailed?() }
    }

    func zoom(by factor: CGFloat?) {
        guard let factor = factor else { webView.pageZoom = 1; return }
        webView.pageZoom = min(3, max(0.5, (webView.pageZoom * factor * 100).rounded() / 100))
    }
}
