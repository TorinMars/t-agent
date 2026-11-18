// T-Attention desktop widget: the overlays: the task form and the delete question. See main.swift for the overview and the build.
import AppKit

/// What covers the task list in the panel. It lives outside the list, so a refresh cannot rebuild it.
class OverlayView: NSView {
    var preferredHeight: CGFloat = 0
    var busy = false  // a request is out

    override func hitTest(_ point: NSPoint) -> NSView? {
        frame.contains(point) ? (super.hitTest(point) ?? self) : nil  // nothing reaches the rows underneath
    }
}

func makeCaption(_ text: String) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = .systemFont(ofSize: 11)
    field.textColor = .secondaryLabelColor
    return field
}

func makeButtonRow(_ buttons: [PanelButton], width: CGFloat) -> NSStackView {
    let spacer = NSView()
    spacer.setContentHuggingPriority(.init(1), for: .horizontal)
    let row = NSStackView(views: [spacer] + buttons)
    row.orientation = .horizontal
    row.spacing = 8
    row.translatesAutoresizingMaskIntoConstraints = false
    row.widthAnchor.constraint(equalToConstant: width).isActive = true
    return row
}

/// The create and edit form. A field editor's text is read directly so an input-method composition survives.
final class TaskFormView: OverlayView, NSTextFieldDelegate {
    enum Mode {
        case create
        case edit(key: String, original: TaskDraft)
    }

    let mode: Mode
    let showsNotes: Bool
    let nameField = NSTextField(string: "")
    let customField = NSTextField(string: "")
    let notesField = NSTextField(string: "")
    let statusPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let saveButton = PanelButton(label: L("Save"), tint: .controlAccentColor)
    let cancelButton = PanelButton(label: L("Cancel"))
    var onSubmit: () -> Void = {}
    var onCancel: () -> Void = {}

    override var busy: Bool { didSet { updateSaveButton() } }

    var isEdit: Bool {
        if case .edit = mode { return true }
        return false
    }

    init(mode: Mode, draft: TaskDraft, heading: String, showsNotes: Bool = true) {
        self.mode = mode
        self.showsNotes = showsNotes
        super.init(frame: NSRect(x: 0, y: 0, width: detailWidth, height: 120))
        let background = makeBackground(radius: 12)
        background.frame = bounds
        addSubview(background)

        let fieldWidth = detailWidth - detailPadding * 2
        let title = NSTextField(labelWithString: heading)
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        title.translatesAutoresizingMaskIntoConstraints = false
        title.widthAnchor.constraint(equalToConstant: fieldWidth).isActive = true

        var fields: [(NSTextField, String)] = [(nameField, draft.title)]
        if isEdit { fields.append((customField, draft.customStatus)) }
        if showsNotes { fields.append((notesField, draft.notes)) }
        for (field, value) in fields {
            field.stringValue = value
            field.font = .systemFont(ofSize: 12)
            field.delegate = self
            field.translatesAutoresizingMaskIntoConstraints = false
            field.widthAnchor.constraint(equalToConstant: fieldWidth).isActive = true
        }
        nameField.setAccessibilityLabel(L("Name"))
        customField.setAccessibilityLabel(L("Custom status"))
        notesField.setAccessibilityLabel(L("Notes"))
        notesField.usesSingleLineMode = false
        notesField.lineBreakMode = .byWordWrapping
        notesField.cell?.wraps = true
        notesField.cell?.isScrollable = false
        notesField.heightAnchor.constraint(equalToConstant: 48).isActive = true

        var statuses = statusOrder
        if !statuses.contains(draft.status) { statuses.append(draft.status) }  // an unknown status stays selectable
        for status in statuses {
            statusPopup.addItem(withTitle: statusLabel(status))
            statusPopup.lastItem?.representedObject = status
        }
        statusPopup.font = .systemFont(ofSize: 12)
        statusPopup.translatesAutoresizingMaskIntoConstraints = false
        statusPopup.widthAnchor.constraint(equalToConstant: fieldWidth).isActive = true
        statusPopup.setAccessibilityLabel(L("Status"))
        selectStatus(draft.status)

        let order: [NSView] = fields.map { $0.0 }
        for (view, next) in zip(order, order.dropFirst() + [order[0]]) { view.nextKeyView = next }

        let buttons = makeButtonRow([cancelButton, saveButton], width: fieldWidth)
        var views: [NSView] = [title, makeCaption(L("Name")), nameField, makeCaption(L("Status")), statusPopup]
        if isEdit { views += [makeCaption(L("Custom status")), customField] }
        if showsNotes { views += [makeCaption(L("Notes")), notesField] }
        views.append(buttons)
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: detailPadding, left: detailPadding, bottom: detailPadding, right: detailPadding)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.widthAnchor.constraint(equalToConstant: detailWidth),
        ])
        stack.layoutSubtreeIfNeeded()
        preferredHeight = ceil(stack.fittingSize.height) + 34  // room for the red message under the buttons

        saveButton.target = self
        saveButton.action = #selector(savePressed)
        cancelButton.target = self
        cancelButton.action = #selector(cancelPressed)
        updateSaveButton()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    var selectedStatus: String { (statusPopup.selectedItem?.representedObject as? String) ?? "todo" }

    func selectStatus(_ status: String) {
        if let index = statusPopup.itemArray.firstIndex(where: { ($0.representedObject as? String) == status }) {
            statusPopup.selectItem(at: index)
        }
    }

    var draft: TaskDraft {
        TaskDraft(title: text(of: nameField), status: selectedStatus, customStatus: text(of: customField), notes: text(of: notesField))
    }

    var nameIsValid: Bool { !text(of: nameField).trimmed.isEmpty }

    private func text(of field: NSTextField) -> String {
        (field.currentEditor() as? NSTextView)?.string ?? field.stringValue
    }

    /// Ends a composition still in progress, so a click on the save button sends the text the user sees.
    func commitComposition() {
        (window?.firstResponder as? NSTextView).map { if $0.hasMarkedText() { $0.unmarkText() } }
    }

    private func updateSaveButton() {
        saveButton.isEnabled = nameIsValid && !busy
    }

    func controlTextDidChange(_ notification: Notification) {
        updateSaveButton()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if textView.hasMarkedText() { return false }  // Return and Esc belong to the input method during composition
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            onSubmit()
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            onCancel()
            return true
        default:
            return false
        }
    }

    @objc private func savePressed() { onSubmit() }
    @objc private func cancelPressed() { onCancel() }
}

/// The in-panel question before a delete.
final class DeleteConfirmView: OverlayView {
    let key: String
    let message = NSTextField(wrappingLabelWithString: "")
    let deleteButton = PanelButton(label: L("Delete"), tint: .systemRed)
    let cancelButton = PanelButton(label: L("Cancel"))
    var onDelete: () -> Void = {}
    var onCancel: () -> Void = {}

    override var busy: Bool {
        didSet {
            deleteButton.isEnabled = !busy
            cancelButton.isEnabled = !busy
        }
    }

    init(key: String, title: String) {
        self.key = key
        super.init(frame: NSRect(x: 0, y: 0, width: detailWidth, height: 120))
        let background = makeBackground(radius: 12)
        background.frame = bounds
        addSubview(background)
        let fieldWidth = detailWidth - detailPadding * 2
        message.stringValue = L("Delete this task?") + "\n" + title.oneLine
        message.font = .systemFont(ofSize: 12)
        message.maximumNumberOfLines = 4
        message.preferredMaxLayoutWidth = fieldWidth
        message.translatesAutoresizingMaskIntoConstraints = false
        message.widthAnchor.constraint(equalToConstant: fieldWidth).isActive = true
        let buttons = makeButtonRow([cancelButton, deleteButton], width: fieldWidth)
        let stack = NSStackView(views: [message, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: detailPadding, left: detailPadding, bottom: detailPadding, right: detailPadding)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.widthAnchor.constraint(equalToConstant: detailWidth),
        ])
        stack.layoutSubtreeIfNeeded()
        preferredHeight = ceil(stack.fittingSize.height)
        deleteButton.target = self
        deleteButton.action = #selector(deletePressed)
        cancelButton.target = self
        cancelButton.action = #selector(cancelPressed)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func deletePressed() { onDelete() }
    @objc private func cancelPressed() { onCancel() }
}

/// The × of the bubble: two strokes, a faint circle under the pointer.
