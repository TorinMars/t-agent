// T-Attention desktop widget: the panels, buttons, rows and the background. See main.swift for the overview and the build.
import AppKit

// MARK: - Views

/// Never key, except while a form that needs typing is open: a non-activating panel can then take the keyboard while
/// another app stays frontmost.
final class FloatingPanel: NSPanel {
    var acceptsKey = false
    var onCancel: (() -> Void)?  // Esc when no text field has the focus
    var onReturn: (() -> Void)?

    override var canBecomeKey: Bool { acceptsKey }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()  // NSPanel's own handling would close the panel
    }

    override func keyDown(with event: NSEvent) {
        if let onReturn = onReturn, event.keyCode == 36 || event.keyCode == 76 {
            onReturn()
        } else {
            super.keyDown(with: event)
        }
    }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

class HoverView: NSView {
    var onEnter: () -> Void = {}
    var onExit: () -> Void = {}

    override init(frame: NSRect) {
        super.init(frame: frame)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseEntered(with event: NSEvent) { onEnter() }
    override func mouseExited(with event: NSEvent) { onExit() }
}

/// The collapsed window: a press and a move drags the window.
final class DragView: HoverView {
    var onDragBegin: () -> Void = {}
    var onDragMove: () -> Void = {}
    var onDragEnd: () -> Void = {}
    private var startMouse: NSPoint?
    private var startOrigin = NSPoint.zero
    private var moved = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // Labels must not swallow the clicks that drag the window or open its menu.
    override func hitTest(_ point: NSPoint) -> NSView? {
        frame.contains(point) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        startMouse = NSEvent.mouseLocation
        startOrigin = window?.frame.origin ?? .zero
        moved = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = startMouse else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - start.x
        let dy = now.y - start.y
        if !moved {
            if hypot(dx, dy) < 3 { return }
            moved = true
            onDragBegin()
        }
        window?.setFrameOrigin(NSPoint(x: startOrigin.x + dx, y: startOrigin.y + dy))
        onDragMove()
    }

    override func mouseUp(with event: NSEvent) {
        startMouse = nil
        if moved {
            moved = false
            onDragEnd()
        }
    }
}

/// A template SF Symbol at the size of the panel's icons; nil before macOS 11 or when the system lacks the symbol (the
/// button then shows its text instead).
func symbolImage(_ name: String, pointSize: CGFloat = 12) -> NSImage? {
    guard symbolsAvailable else { return nil }
    if #available(macOS 11.0, *) {
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
        let sized = image.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)) ?? image
        sized.isTemplate = true
        return sized
    }
    return nil
}

/// --self-test turns this off to check the text fallback of the icon buttons.
var symbolsAvailable = true

/// `image` drawn in `color` (a template image keeps only its shape), at draw time so the colour follows the appearance.
func tintedImage(_ image: NSImage, _ color: NSColor) -> NSImage {
    NSImage(size: image.size, flipped: false) { rect in
        image.draw(in: rect)
        color.set()
        rect.fill(using: .sourceAtop)
        return true
    }
}

/// A small button in the panel. It draws itself because the panel is rarely key, and a system default button is
/// drawn without its colour in a window that is not key. With a symbol (and macOS 11 or later) it is an icon button:
/// the symbol only, in `tint` or the secondary label colour, a faint rounded square under the pointer, and `label` as
/// its tooltip and accessibility label. Without one it is a text button: `label` on a grey or `tint` filled pill.
class PanelButton: NSButton {
    var label: String {
        didSet {
            invalidateIntrinsicContentSize()
            needsDisplay = true
            if icon != nil { toolTip = label }
            setAccessibilityLabel(label)
        }
    }
    private let tint: NSColor?
    private let fontSize: CGFloat
    /// The symbol of an icon button; nil for a text button.
    let icon: NSImage?
    var iconSize = NSSize(width: 20, height: 20)
    private var hovered = false { didSet { needsDisplay = true } }

    init(label: String, tint: NSColor? = nil, fontSize: CGFloat = 11, symbol: String? = nil, symbolSize: CGFloat = 12) {
        self.label = label
        self.tint = tint
        self.fontSize = fontSize
        self.icon = symbol.flatMap { symbolImage($0, pointSize: symbolSize) }
        super.init(frame: .zero)
        title = label
        isBordered = false
        refusesFirstResponder = true
        focusRingType = .none
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel(label)
        if icon != nil {
            toolTip = label
            addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                           owner: self, userInfo: nil))
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    var isIcon: Bool { icon != nil }

    override var isEnabled: Bool { didSet { needsDisplay = true } }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseEntered(with event: NSEvent) { if isIcon { hovered = true } }
    override func mouseExited(with event: NSEvent) { if isIcon { hovered = false } }
    override func viewDidHide() {
        hovered = false
        super.viewDidHide()
    }

    private func labelText(alpha: CGFloat) -> NSAttributedString {
        let color: NSColor = tint == nil ? .labelColor : .white
        return NSAttributedString(string: label, attributes: [
            .font: NSFont.systemFont(ofSize: fontSize, weight: .medium),
            .foregroundColor: color.withAlphaComponent(alpha),
        ])
    }

    override var intrinsicContentSize: NSSize {
        if isIcon { return iconSize }
        return NSSize(width: ceil(labelText(alpha: 1).size().width) + 18, height: 20)
    }

    override func draw(_ dirtyRect: NSRect) {
        if let icon = icon {
            if isEnabled && (hovered || isHighlighted) {
                NSColor.labelColor.withAlphaComponent(isHighlighted ? 0.16 : 0.09).setFill()
                NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
            }
            let color = (tint ?? NSColor.secondaryLabelColor).withAlphaComponent(isEnabled ? 1 : 0.35)
            let size = icon.size
            let rect = NSRect(x: ((bounds.width - size.width) / 2).rounded(), y: ((bounds.height - size.height) / 2).rounded(),
                              width: size.width, height: size.height)
            tintedImage(icon, color).draw(in: rect)
            return
        }
        let strength: CGFloat = isEnabled ? (isHighlighted ? 0.7 : 1) : 0.4
        let fill = tint?.withAlphaComponent(strength) ?? NSColor.labelColor.withAlphaComponent(0.12 * strength)
        fill.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
        let text = labelText(alpha: isEnabled ? 1 : 0.5)
        let size = text.size()
        text.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }
}

/// A button in a task row: an icon at the right end of the row's title line (`icon` true), or a text button (the
/// bubble's buttons, and the rows when the system has no symbols).
final class ActionButton: PanelButton {
    let rowAction: RowAction
    var onPress: () -> Void = {}
    var onRelease: () -> Void = {}
    var contextMenu: () -> NSMenu? = { nil }  // the row's menu, so a right click on a button still opens it

    init(_ rowAction: RowAction, icon: Bool = false) {
        self.rowAction = rowAction
        super.init(label: rowAction.label, tint: rowAction.isPrimary ? .controlAccentColor : nil,
                   symbol: icon ? rowAction.symbolName : nil)
        iconSize = NSSize(width: rowIconSize, height: rowIconSize)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var intrinsicContentSize: NSSize {
        if isIcon { return super.intrinsicContentSize }
        return NSSize(width: super.intrinsicContentSize.width - 4, height: 18)
    }

    override func menu(for event: NSEvent) -> NSMenu? { contextMenu() }

    // super.mouseDown tracks the press until the mouse goes up and sends the action from inside.
    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }  // swallowed: a press on a disabled button must not start a row drag
        onPress()
        super.mouseDown(with: event)
        onRelease()
    }
}

/// The colours of the device tags of the page: TAG_COLORS and TAG_NEUTRAL in scripts/h5-shell/task-order.mjs.
let tagColors: [UInt32] = [0x90caf9, 0xa5d6a7, 0xffcc80, 0xce93d8, 0x80cbc4, 0xf48fb1, 0xfff59d, 0x9fa8da]
let tagNeutral: UInt32 = 0xe0e0e0

func tagColor(_ index: Int) -> NSColor {
    let value = index >= 0 && index < tagColors.count ? tagColors[index] : tagNeutral
    return NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                   blue: CGFloat(value & 0xff) / 255, alpha: 1)
}

/// The engine name on a row. Dark: the colour on its own 16% tint, as on the page; light: dark text on the colour.
final class EnginePill: NSView {
    let engineTag: EngineTag

    init(_ engineTag: EngineTag) {
        self.engineTag = engineTag
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = engineTag.name
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var isDark: Bool { effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }

    private func text(dark: Bool) -> NSAttributedString {
        NSAttributedString(string: engineTag.name, attributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .medium),
            .foregroundColor: dark ? tagColor(engineTag.colorIndex) : NSColor.black.withAlphaComponent(0.78),
        ])
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: ceil(text(dark: false).size().width) + 12, height: 16)
    }

    override func draw(_ dirtyRect: NSRect) {
        let dark = isDark
        let color = tagColor(engineTag.colorIndex)
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 7.5, yRadius: 7.5)
        (dark ? color.withAlphaComponent(engineTag.colorIndex < 0 ? 0.08 : 0.16) : color.withAlphaComponent(0.9)).setFill()
        path.fill()
        if dark {
            color.withAlphaComponent(0.45).setStroke()
            path.lineWidth = 1
            path.stroke()
        }
        let label = text(dark: dark)
        let size = label.size()
        label.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }
}

/// A small round dot drawn in a colour (the section headers).
final class DotView: NSView {
    let color: NSColor

    init(color: NSColor, side: CGFloat = 7) {
        self.color = color
        super.init(frame: NSRect(x: 0, y: 0, width: side, height: side))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: side).isActive = true
        heightAnchor.constraint(equalToConstant: side).isActive = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        color.setFill()
        NSBezierPath(ovalIn: bounds).fill()
    }
}

/// The colour of each section's dot: the colours of the emoji the headers had (red, green, yellow, white), and teal
/// for "Working now" as its rows' running dots.
func sectionColor(_ section: Section) -> NSColor {
    switch section {
    case .needs: return .systemRed
    case .working: return .systemGreen
    case .todo: return .systemYellow
    case .done: return .systemGray
    }
}

/// A section header: a colour dot, the name and a muted count ("Needs you  4"). The name is the first text field, which
/// the offscreen checks read as the line's text.
final class SectionHeaderView: NSView {
    let titleField: NSTextField
    let countField: NSTextField
    let dot: DotView

    init(title: String, count: Int?, color: NSColor, width: CGFloat, muted: Bool = false) {
        titleField = NSTextField(labelWithString: title)
        countField = NSTextField(labelWithString: count.map { String($0) } ?? "")
        dot = DotView(color: color)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        titleField.font = .systemFont(ofSize: 12, weight: .semibold)
        titleField.textColor = muted ? .secondaryLabelColor : .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        countField.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        countField.textColor = .tertiaryLabelColor
        for field in [titleField, countField] {
            field.translatesAutoresizingMaskIntoConstraints = false
            field.setAccessibilityElement(false)
        }
        addSubview(titleField)  // first: what the offscreen checks read as the line's text
        addSubview(dot)
        addSubview(countField)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: width),
            heightAnchor.constraint(equalToConstant: 18),
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 1),
            dot.centerYAnchor.constraint(equalTo: titleField.centerYAnchor),
            titleField.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 7),
            titleField.centerYAnchor.constraint(equalTo: centerYAnchor),
            countField.leadingAnchor.constraint(equalTo: titleField.trailingAnchor, constant: 5),
            countField.firstBaselineAnchor.constraint(equalTo: titleField.firstBaselineAnchor),
            countField.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(count.map { title + ", " + String($0) } ?? title)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

let dragThreshold: CGFloat = 4

/// One task row in the detail panel: a press followed by movement drags it, a plain click does nothing. Its icon
/// buttons show all the time when `actionsAlwaysShown` (the Needs you section, or VoiceOver running), else only while
/// the pointer is over the row. Hidden or not, every action stays in the row's context menu and in its accessibility
/// custom actions, so it is reachable without a mouse.
final class TaskRowView: NSView {
    var actionButtons: [ActionButton] = []
    var onPress: () -> Void = {}
    var onDragBegin: () -> Void = {}
    var onDragMove: (NSEvent) -> Void = { _ in }
    var onDragEnd: () -> Void = {}
    var onRelease: () -> Void = {}
    var contextMenu: () -> NSMenu? = { nil }
    var actionsAlwaysShown = true { didSet { updateActionVisibility() } }
    private(set) var hovered = false
    private var startPoint: NSPoint?
    private var active = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseEntered(with event: NSEvent) { setHovered(true) }
    override func mouseExited(with event: NSEvent) { setHovered(false) }

    func setHovered(_ on: Bool) {
        guard on != hovered else { return }
        hovered = on
        updateActionVisibility()
    }

    func updateActionVisibility() {
        let shown = actionsAlwaysShown || hovered
        actionButtons.forEach { $0.isHidden = !shown }
    }

    // The label and the engine tag must not take the press, or the panel would not pass it through without
    // activation. A shown button takes its own press even when disabled, so a press on it never starts a drag.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard frame.contains(point) else { return nil }
        let local = convert(point, from: superview)
        return actionButtons.first { !$0.isHidden && $0.convert($0.bounds, to: self).contains(local) } ?? self
    }

    /// The link and session buttons stay on: opening them does not touch the task.
    func setActionsEnabled(_ enabled: Bool) {
        actionButtons.filter { !$0.rowAction.opensOnly }.forEach { $0.isEnabled = enabled }
    }

    override func menu(for event: NSEvent) -> NSMenu? { contextMenu() }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control) {  // control-click is a right click; not a drag
            if let menu = contextMenu() { NSMenu.popUpContextMenu(menu, with: event, for: self) }
            return
        }
        startPoint = event.locationInWindow
        active = false
        onPress()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = startPoint else { return }
        if !active {
            if hypot(event.locationInWindow.x - start.x, event.locationInWindow.y - start.y) < dragThreshold { return }
            active = true
            onDragBegin()
        }
        onDragMove(event)
    }

    override func mouseUp(with event: NSEvent) {
        startPoint = nil
        if active {
            active = false
            onDragEnd()
        } else {
            onRelease()
        }
    }
}

func makePanel(size: NSSize) -> FloatingPanel {
    let panel = FloatingPanel(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.animationBehavior = .none
    return panel
}

func roundedMask(radius: CGFloat) -> NSImage {
    let side = radius * 2 + 1
    let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
        NSColor.black.setFill()
        NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
}

/// How much of the window background colour lies over the blur: what is behind the window (a terminal full of text)
/// shows only as a faint tint and never competes with the panel's own text.
let backgroundVeil: CGFloat = 0.86

/// The veil over the blur: the window background colour of the current appearance at backgroundVeil, in the same
/// rounded shape (resolved at draw time, so it follows light and dark).
final class BackgroundVeilView: NSView {
    let radius: CGFloat

    init(radius: CGFloat) {
        self.radius = radius
        super.init(frame: .zero)
        autoresizingMask = [.width, .height]
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.withAlphaComponent(backgroundVeil).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
    }
}

/// The background of the capsule, the panel, its forms and the bubble: the blur of the menu material with the veil on it.
func makeBackground(radius: CGFloat) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .menu
    view.blendingMode = .behindWindow
    view.state = .active
    view.maskImage = roundedMask(radius: radius)
    view.autoresizingMask = [.width, .height]
    let veil = BackgroundVeilView(radius: radius)
    veil.frame = view.bounds
    view.addSubview(veil)
    return view
}

/// Renders a view offscreen into a PNG on a solid background (the blurred material draws nothing offscreen). No window
/// is ordered on screen for this.
@discardableResult
func renderView(_ view: NSView, to path: String, background: NSColor) -> Bool {
    view.layoutSubtreeIfNeeded()
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
    view.cacheDisplay(in: view.bounds, to: rep)
    guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: rep.pixelsWide, pixelsHigh: rep.pixelsHigh,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: out) else { return false }
    let rect = NSRect(x: 0, y: 0, width: rep.pixelsWide, height: rep.pixelsHigh)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    background.setFill()
    rect.fill()
    rep.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = out.representation(using: .png, properties: [:]) else { return false }
    return (try? png.write(to: URL(fileURLWithPath: path))) != nil
}
