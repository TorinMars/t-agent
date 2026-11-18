// T-Attention desktop widget: the notice bubble view. See main.swift for the overview and the build.
import AppKit

final class BubbleCloseButton: NSButton {
    private var hovered = false { didSet { needsDisplay = true } }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 18, height: 18))
        title = ""
        isBordered = false
        refusesFirstResponder = true
        focusRingType = .none
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = L("Close")
        setAccessibilityLabel(L("Close"))
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func draw(_ dirtyRect: NSRect) {
        if hovered || isHighlighted {
            NSColor.labelColor.withAlphaComponent(isHighlighted ? 0.18 : 0.1).setFill()
            NSBezierPath(ovalIn: bounds).fill()
        }
        let inset: CGFloat = 5.5
        let path = NSBezierPath()
        path.move(to: NSPoint(x: inset, y: inset))
        path.line(to: NSPoint(x: bounds.width - inset, y: bounds.height - inset))
        path.move(to: NSPoint(x: inset, y: bounds.height - inset))
        path.line(to: NSPoint(x: bounds.width - inset, y: inset))
        path.lineWidth = 1.5
        path.lineCapStyle = .round
        NSColor.secondaryLabelColor.setStroke()
        path.stroke()
    }
}

/// The notice bubble: a dot in the colour of the status, the title (two lines at most), the text (three lines at most),
/// the sender and "+N more" small and muted, and a × at the top right. A click anywhere but the × opens the notice.
final class NoticeBubbleView: NSView {
    let notice: WidgetNotice
    let closeButton = BubbleCloseButton()
    let titleField = NSTextField(wrappingLabelWithString: "")
    let textField = NSTextField(wrappingLabelWithString: "")
    let fromField = NSTextField(labelWithString: "")
    let moreField = NSTextField(labelWithString: "")
    let dot = NSView()
    var preferredHeight: CGFloat = 60
    private(set) var contentStack = NSStackView()
    var actionsView: BubbleActionsView?  // the task's buttons and the reply field (Part B)
    var onClick: () -> Void = {}
    var onClose: () -> Void = {}
    var onEnter: () -> Void = {}
    var onExit: () -> Void = {}
    private var pressed = false
    private var cursorPushed = false

    static let padding: CGFloat = 12
    static let column: CGFloat = 26  // where the text starts, right of the dot

    init(notice: WidgetNotice, more: Int, tooltip: String) {
        self.notice = notice
        super.init(frame: NSRect(x: 0, y: 0, width: bubbleWidth, height: 60))
        let background = makeBackground(radius: 12)
        background.frame = bounds
        addSubview(background)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))

        let contentWidth = bubbleWidth - NoticeBubbleView.column - NoticeBubbleView.padding
        func setUp(_ field: NSTextField, _ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, lines: Int,
                   width: CGFloat) {
            field.stringValue = text
            field.font = .systemFont(ofSize: size, weight: weight)
            field.textColor = color
            field.maximumNumberOfLines = lines
            field.lineBreakMode = lines == 1 ? .byTruncatingTail : .byWordWrapping
            field.cell?.truncatesLastVisibleLine = true
            field.preferredMaxLayoutWidth = width
            field.translatesAutoresizingMaskIntoConstraints = false
            field.widthAnchor.constraint(equalToConstant: width).isActive = true
        }
        setUp(titleField, notice.title, size: 12, weight: .semibold, color: .labelColor, lines: 2, width: contentWidth - 18)
        setUp(textField, notice.text, size: 11, weight: .regular, color: .labelColor, lines: 3, width: contentWidth)
        setUp(fromField, notice.from, size: 10, weight: .regular, color: .secondaryLabelColor, lines: 1, width: contentWidth)
        setUp(moreField, more > 0 ? L("+{1} more", String(more)) : "", size: 10, weight: .medium, color: .secondaryLabelColor,
              lines: 1, width: contentWidth)

        var views: [NSView] = [titleField]
        if !notice.text.isEmpty { views.append(textField) }
        if !notice.from.isEmpty { views.append(fromField) }
        if more > 0 { views.append(moreField) }
        let stack = NSStackView(views: views)
        contentStack = stack
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.setCustomSpacing(3, after: titleField)
        if notice.text.isEmpty && !notice.from.isEmpty { stack.setCustomSpacing(4, after: titleField) }
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        dot.wantsLayer = true
        dot.layer?.backgroundColor = toneColor(noticeTone(notice)).cgColor
        dot.layer?.cornerRadius = 4
        dot.translatesAutoresizingMaskIntoConstraints = false
        addSubview(dot)

        closeButton.target = self
        closeButton.action = #selector(closePressed)
        addSubview(closeButton)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: NoticeBubbleView.column),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: NoticeBubbleView.padding),
            dot.topAnchor.constraint(equalTo: titleField.topAnchor, constant: 4),
            closeButton.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            closeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            closeButton.widthAnchor.constraint(equalToConstant: 18),
            closeButton.heightAnchor.constraint(equalToConstant: 18),
        ])
        stack.layoutSubtreeIfNeeded()
        preferredHeight = ceil(stack.fittingSize.height) + 10 + 11

        toolTip = tooltip
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(notice.text.isEmpty ? notice.title : notice.title + ". " + notice.text.oneLine)
        setAccessibilityHelp(tooltip)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // The labels must not take the click; the × and the task's buttons and reply field take their own.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard frame.contains(point) else { return nil }
        let local = convert(point, from: superview)
        if closeButton.frame.contains(local) { return closeButton }
        if let actions = actionsView, let control = actions.control(at: convert(local, to: actions)) { return control }
        return self
    }

    override func mouseEntered(with event: NSEvent) {
        if !cursorPushed {
            NSCursor.pointingHand.push()
            cursorPushed = true
        }
        onEnter()
    }

    override func mouseExited(with event: NSEvent) {
        if cursorPushed {
            NSCursor.pop()
            cursorPushed = false
        }
        onExit()
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow == nil && cursorPushed {
            NSCursor.pop()
            cursorPushed = false
        }
        super.viewWillMove(toWindow: newWindow)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func mouseDown(with event: NSEvent) { pressed = true }

    override func mouseUp(with event: NSEvent) {
        guard pressed else { return }
        pressed = false
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick() }
    }

    override func accessibilityPerformPress() -> Bool {
        onClick()
        return true
    }

    @objc private func closePressed() { onClose() }
}
