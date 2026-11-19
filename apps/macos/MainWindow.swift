// T-Agent.app: the main window. A WKWebView on the server (default persistent website data store, so the login cookie
// survives restarts) or the native placeholder while the server does not answer. The decisions it makes (navigation,
// microphone, download names) are the pure functions of URLPolicy.swift. See main.swift.
import AppKit
import WebKit

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

final class MainWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    static let autosaveName = "T-Agent Main Window"
    /// The script message the page sends a link to open in the default browser (linkToOpen, docs/design/open-links.md).
    static let openLinkMessage = "tagentOpen"

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
    private var titleObservation: NSKeyValueObservation?
    /// Where each running download goes.
    private var downloadPaths: [ObjectIdentifier: String] = [:]
    private(set) var openLinkMessages: OpenLinkMessages?

    /// `autosave` false (the self-test) neither restores nor saves the frame. `inspectable` lets Safari's Web Inspector
    /// attach (macOS 13.3 and newer).
    init(version: String, dataStore: WKWebsiteDataStore, autosave: Bool, inspectable: Bool, server: @escaping () -> URL,
         openExternal: @escaping (URL) -> Void) {
        self.server = server
        self.openExternal = openExternal
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: true)
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820),
                            configuration: makeWebViewConfiguration(version: version, dataStore: dataStore))
        super.init()
        window.title = "T-Agent"
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

        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let self = self, self.showingPage else { return }
            let title = (view.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self.window.title = title.isEmpty ? "T-Agent" : title
        }
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
        if showingPage, let path = pagePath(of: webView.url, server: server()) { lastPath = path }
        showingPage = false
        placeholder.show(content)
        if placeholder.superview == nil, let container = window.contentView {
            placeholder.frame = container.bounds
            container.addSubview(placeholder)
        }
        webView.isHidden = true
        window.title = "T-Agent"
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
        window.orderOut(nil)
        return false
    }

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
