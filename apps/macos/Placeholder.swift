// T-Agent.app: the native view the window shows instead of the page while the web service does not answer (never a
// WebKit error page). The text per state is pure (covered by --self-test). See main.swift.
import AppKit

// MARK: - Placeholder content

struct PlaceholderContent: Equatable {
    var title: String
    var detail: String
    /// A spinner instead of the buttons.
    var busy: Bool
    var showButtons: Bool
}

func placeholderContent(_ state: MonitorState, config: AppConfig) -> PlaceholderContent {
    let address = config.url.absoluteString
    let shared = "This window shows the T-Agent web service at \(address), the same service your browsers and phone use."
    switch state.phase {
    case .checking:
        return PlaceholderContent(title: "Connecting to T-Agent…", detail: "Looking for the T-Agent web service at \(address).",
                                  busy: true, showButtons: false)
    case .starting:
        return PlaceholderContent(title: "Starting T-Agent…",
                                  detail: "Starting the T-Agent web service (the same one your browsers use). The page opens as soon as it answers.",
                                  busy: true, showButtons: false)
    case .restarting:
        return PlaceholderContent(title: "Restarting T-Agent…", detail: shared, busy: true, showButtons: false)
    case .stopping:
        return PlaceholderContent(title: "Stopping T-Agent…", detail: shared, busy: true, showButtons: false)
    case .running:
        return PlaceholderContent(title: "Opening T-Agent…", detail: shared, busy: true, showButtons: false)
    case .notRunning:
        var detail = shared + " "
        if let error = state.lastError {
            detail += "The last attempt failed:\n\n" + error + "\n\n"
        } else if config.supervisor.controllable {
            detail += "Start it here. "
        } else {
            detail += "It is not run by PM2 or launchd, so start it in Terminal:\n\n"
                + manualStartCommand(installDir: config.installDir, pm2Name: config.pm2Name) + "\n\n"
        }
        detail += "The app tries again every \(Int(MonitorTiming.notRunning)) seconds and opens the page as soon as it answers."
        return PlaceholderContent(title: "T-Agent is not running", detail: detail, busy: false, showButtons: true)
    }
}

// MARK: - Placeholder view

/// The layout of the placeholder on Material Design 2's 8 pt grid (AGENTS.md: native parts keep AppKit controls and the
/// platform's behaviour, custom views follow MD2 layout, type and color).
enum PlaceholderLayout {
    /// MD2 type scale: Headline 6 for the title, Body 2 for the explanation.
    static let titleSize: CGFloat = 20
    static let bodySize: CGFloat = 14
    /// 8 pt grid: 8 between the title and the text, 24 before the spinner or the buttons, 8 between the buttons, at least
    /// 32 from the window's edges, the text at most 480 wide (a readable line of Body 2).
    static let titleGap: CGFloat = 8
    static let sectionGap: CGFloat = 24
    static let buttonGap: CGFloat = 8
    static let margin: CGFloat = 32
    static let maxWidth: CGFloat = 480
}

/// Surface and on-surface colors from the system (so light and dark mode follow the Mac), one primary accent: the
/// "Start T-Agent" button carries the accent color; "Try again" is the secondary button.
final class PlaceholderView: NSView {
    let titleLabel = NSTextField(labelWithString: "")
    let detailLabel = NSTextField(wrappingLabelWithString: "")
    let startButton = NSButton(title: "Start T-Agent", target: nil, action: nil)
    let retryButton = NSButton(title: "Try again", target: nil, action: nil)
    let spinner = NSProgressIndicator()
    let stack = NSStackView()
    private(set) var content = PlaceholderContent(title: "", detail: "", busy: true, showButtons: false)

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        titleLabel.font = .systemFont(ofSize: PlaceholderLayout.titleSize, weight: .medium)
        titleLabel.textColor = .labelColor
        titleLabel.alignment = .center
        detailLabel.font = .systemFont(ofSize: PlaceholderLayout.bodySize)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.alignment = .center
        detailLabel.isSelectable = true
        detailLabel.preferredMaxLayoutWidth = PlaceholderLayout.maxWidth
        startButton.bezelStyle = .rounded
        startButton.keyEquivalent = "\r"
        startButton.bezelColor = .controlAccentColor
        retryButton.bezelStyle = .rounded
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isDisplayedWhenStopped = false
        let buttons = NSStackView(views: [retryButton, startButton])
        buttons.orientation = .horizontal
        buttons.spacing = PlaceholderLayout.buttonGap
        for view in [titleLabel, detailLabel, spinner, buttons] { stack.addArrangedSubview(view) }
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = PlaceholderLayout.sectionGap
        stack.setCustomSpacing(PlaceholderLayout.titleGap, after: titleLabel)
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: PlaceholderLayout.maxWidth),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: PlaceholderLayout.margin),
            stack.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: PlaceholderLayout.margin),
            detailLabel.widthAnchor.constraint(lessThanOrEqualToConstant: PlaceholderLayout.maxWidth),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    override var wantsUpdateLayer: Bool { true }

    func show(_ content: PlaceholderContent) {
        self.content = content
        titleLabel.stringValue = content.title
        detailLabel.stringValue = content.detail
        startButton.isHidden = !content.showButtons
        retryButton.isHidden = !content.showButtons
        startButton.superview?.isHidden = !content.showButtons
        spinner.isHidden = !content.busy
        if content.busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    }
}
