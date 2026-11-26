// T-Attention desktop widget: the controller class, its stored state and its start. See main.swift for the overview and the build.
import AppKit

// MARK: - Controller

/// The collapsed window is a vertical capsule of a fixed size with three numbers (CapsuleView): open tasks, Needs you
/// and agents running now. It never changes size, so the panel and the bubble beside it never move.
let widgetWidth: CGFloat = 32
let widgetHeight: CGFloat = 90
let widgetSize = NSSize(width: widgetWidth, height: widgetHeight)
let detailWidth: CGFloat = 312
let detailPadding: CGFloat = 10
let detailMaxHeight: CGFloat = 440
let screenMargin: CGFloat = 8
let panelGap: CGFloat = 8
let hideDelay: TimeInterval = 0.3
let refreshInterval: TimeInterval = 5
let tickInterval: TimeInterval = 1
let toastDuration: TimeInterval = 3
let defaultsSuite = "local.t-agent.attention-widget"

/// A drag for the in-process mouse checks: OVER is a row key, or @needs, @working, @todo or @done for a section's
/// title or the Done line.
struct DebugDrag {
    let source: String
    let over: String
    let lowerHalf: Bool
    var onHeader = false  // the pointer ends on the section title above `over`
}

/// What one in-process mouse drag did.
struct MouseDragResult {
    let hit: String  // the row key the press landed on, or the class of whatever took it instead
    let decision: DropDecision  // just before the mouse went up
    let lineShown: Bool
    let toast: String
    let highlight: String  // the hint on the highlighted section title, "" when none is highlighted
}

struct WidgetOptions {
    var persistPosition = true
    var offscreen = false  // --self-test and --render-sample: nothing is ordered on screen and nothing takes the keyboard
}

final class WidgetController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let parentPID: pid_t?
    let options: WidgetOptions
    let api: WidgetAPI
    private let session: URLSession
    lazy var defaults: UserDefaults = UserDefaults(suiteName: defaultsSuite) ?? .standard

    let widget = makePanel(size: widgetSize)
    let detail = makePanel(size: NSSize(width: detailWidth, height: 120))
    var widgetRoot: DragView?
    var detailRoot: HoverView?
    let capsule = CapsuleView(frame: NSRect(origin: .zero, size: widgetSize))
    let scrollView = NSScrollView()
    let documentView = FlippedView()
    let stack = NSStackView()

    let insertionLine = NSView()
    let toast = NSView()
    let toastLabel = NSTextField(labelWithString: "")
    let plusButton = PanelButton(label: "+", fontSize: 15, symbol: "plus", symbolSize: 13)

    var overlay: OverlayView?  // the open form or confirmation; holds the panel
    var menuOpen = false  // holds the panel while a context menu is showing
    var previousApp: NSRunningApplication?  // who to give the focus back to if this app ever became active
    var summary: Summary?
    var list: ItemList?
    var problem: String?  // why there is no list
    var hasResult = false
    var contentHeight: CGFloat = 120
    var hideTimer: Timer?
    var dragging = false
    var rowViews: [String: TaskRowView] = [:]
    var sectionTitles: [String: NSView] = [:]  // keyed by the key of the section's first row
    var sectionHeaders: [Section: NSView] = [:]  // each section's title, and the Finished header
    let dropHighlight = NSView()  // behind the title of the section a drop would change the status to
    let dropHint = NSTextField(labelWithString: "")
    var pressedRow: String?  // set from mouse down to mouse up; holds the panel and the refresh
    var clickedRow: String?  // the row a plain press went to, while no form is open: its release opens the task's details
    var rowDragActive = false
    var drop: DropDecision = .noChange
    var moveInFlight = false { didSet { syncActionButtons() } }
    var buttonHeld = false  // set while an action button is pressed; holds the panel and the refresh
    var actionRows = Set<String>()  // rows whose request is out (dimmed, with a spinner) or whose success is not refreshed yet
    var lastActionAt: [String: Date] = [:]  // RowAction raw value -> when it was last accepted (actionDebounce)
    var actionsRunning = 0
    var actionNeedsRefresh = false
    var refreshGeneration = 0
    var toastTimer: Timer?
    var stringsLoaded = false
    var stringsLoading = false
    let partD = PartDState()  // shortcuts, idle fade, search, Finished group, per-display position (Part D)
    let ticks = TickState()  // one request per tick (Part E)
    let partG = PartGState()  // scheduled tasks: the firings seen, the form's preview and pop-ups (Part G)
    var moveHook: ((String, MoveSpec, String?) -> Void)?  // for --self-test: takes a drop instead of the server
    /// For --self-test and --render-sample: takes every request instead of the network, with the function that
    /// answers it (body, status), now or later. The status NSURLErrorTimedOut (-1001) answers as a timed-out request.
    var requestHook: ((URLRequest, @escaping (Data?, Int) -> Void) -> Void)?
    /// Opens a task's link in the default browser; --self-test and --render-sample replace it so nothing is opened.
    var openURL: (URL) -> Void = { url in _ = NSWorkspace.shared.open(url) }
    /// Whether every row shows its icon buttons without the pointer over it: while VoiceOver runs. --self-test sets it.
    var alwaysShowRowActions: () -> Bool = { NSWorkspace.shared.isVoiceOverEnabled }
    /// Brings the default browser to the front without opening anything (Open session switched a page there, and the
    /// browser extension could not focus its tab). --self-test and --render-sample replace it.
    var activateBrowser: () -> Void = { activateDefaultBrowser() }
    /// T-Agent.app (tAgentAppBundleID): installed, running, and bringing it forward. Never the real ones offscreen
    /// (--self-test and --render-sample), which replace them to check both cases.
    lazy var appInstalled: () -> Bool = { [weak self] in self?.options.offscreen == false && tAgentAppInstalled() }
    lazy var appRunning: () -> Bool = { [weak self] in self?.options.offscreen == false && tAgentAppRunning() }
    lazy var activateApp: () -> Void = { [weak self] in if self?.options.offscreen == false { activateTAgentApp() } }

    // The notice bubble beside the window.
    let bubble = makePanel(size: NSSize(width: bubbleWidth, height: 80))
    var bubbleView: NoticeBubbleView?  // set while a notice is shown
    var noticePoll = NoticePoll()
    var noticeQueue = NoticeQueue()
    var bubbleTimer: Timer?
    var bubbleSeconds: TimeInterval?  // the length of the running hide timer; nil when none runs
    var bubbleHovered = false
    var bubbleSlides = false  // whether the last bubble was shown with the slide
    var bubbleReply = BubbleReplyState()  // the reply field of the bubble (Part B)
    /// The clock of the notice polling; --self-test moves it.
    var now: () -> Date = { Date() }
    var reduceMotion: () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    /// Tells VoiceOver about a new notice; --self-test and --render-sample replace it.
    var announce: (String) -> Void = { text in
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }

    // Part C: the live agent activity (GET /activity) in the capsule's numbers and at the top of the panel.
    let live = LiveActivity()
    /// Whether the live activity is shown and polled (`show_activity` of GET /prefs; the prefs code sets it).
    var showActivity = true { didSet { if showActivity != oldValue { showActivityChanged() } } }

    init(api: WidgetAPI, parentPID: pid_t?, options: WidgetOptions) {
        self.api = api
        self.parentPID = parentPID
        self.options = options
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]  // localhost must never go through http_proxy
        config.timeoutIntervalForRequest = actionTimeout  // each request sets its own: requestTimeout or actionTimeout (WidgetAPI.request)
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        self.session = URLSession(configuration: config, delegate: nil, delegateQueue: .main)
        super.init()
        buildWidget()
        buildDetail()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        widget.setFrameOrigin(initialOrigin())
        orderFront(widget)
        rebuildDetail()
        ticks.enabled = true  // Part E: GET /tick, the four endpoints only for an older T-Agent
        addTimer(refreshInterval) { [weak self] in self?.poll() }
        addTimer(tickInterval) { [weak self] in self?.tick() }
        loadStrings()
        poll()
        startPreferences()  // Part D
    }

    func applicationDidChangeScreenParameters(_ notification: Notification) {
        widget.setFrame(placedForDisplays() ?? keptOnScreen(widget.frame), display: true)  // Part D: each display's own spot
        if detail.isVisible { positionDetail() }
        positionBubble()
    }

    func applicationWillTerminate(_ notification: Notification) {
        hideBubble()
    }

    func addTimer(_ interval: TimeInterval, _ body: @escaping () -> Void) {
        let timer = Timer(timeInterval: interval, repeats: true) { _ in body() }
        RunLoop.main.add(timer, forMode: .common)  // keeps firing while a menu is open
    }

    /// The only place a panel is put on screen; --self-test and --render-sample never get here.
    func orderFront(_ panel: NSPanel) {
        guard !options.offscreen else { return }
        panel.orderFrontRegardless()
    }

    func perform(_ request: URLRequest, _ done: @escaping (Data?, Int, Error?) -> Void) {
        if let hook = requestHook {
            hook(request) { data, code in
                code == NSURLErrorTimedOut ? done(nil, 0, URLError(.timedOut)) : done(data, code, nil)
            }
            return
        }
        session.dataTask(with: request) { data, response, error in
            done(data, (response as? HTTPURLResponse)?.statusCode ?? 0, error)
        }.resume()
    }
}
