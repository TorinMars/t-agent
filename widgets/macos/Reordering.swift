// T-Attention desktop widget: drag to reorder and to change status. See main.swift for the overview and the build.
import AppKit

// MARK: - Reordering

enum MoveSpec: Equatable {
    case before(String), after(String), top, bottom
}

enum MoveOutcome {
    case moved([WidgetItem]), noChange, invalid(String)
}

/// Why a drop is refused; the toast says it.
enum Refusal: Equatable {
    case level, group, engine

    var message: String {
        switch self {
        case .level: return L("Only among tasks at the same level")
        case .group: return L("Only among tasks with the same status")
        case .engine: return L("Only within the same machine")
        }
    }
}

enum DropDecision: Equatable {
    case place(MoveSpec)  // a reorder inside the row's own block
    case change(String, MoveSpec)  // into another section: this status, placed there
    case noChange, invalid(Refusal)
}

/// The status a drop into `target` gives, or nil when that is the item's own section (a plain reorder).
func statusForDrop(_ item: WidgetItem, into target: Section) -> String? {
    if sectionOf(item) == target { return nil }
    switch target {
    case .needs: return "waiting_user"
    case .working: return "working"
    case .todo: return "todo"
    case .done: return "done"
    case .scheduled, .recurring: return nil  // nothing is dropped there (Part G)
    }
}

/// The list as the server will leave it after POST …/move, for the optimistic update (moveLocal in
/// scripts/h5-shell/attention-model.mjs): only the moved item changes, its sort_order goes between its new
/// neighbours among its siblings (or above / below all of them) and, with a status, it takes that status first.
/// Its children need no change: they are drawn under it.
func applyMove(_ items: [WidgetItem], key: String, spec: MoveSpec, status: String? = nil) -> MoveOutcome {
    guard let index = items.firstIndex(where: { $0.key == key }) else { return .invalid(L("Unknown task")) }
    let original = items[index]
    var next = original
    if let status = status { next.status = status }
    var list = items
    list[index] = next
    let byKey = indexByKey(list)
    var targetKey: String?
    switch spec {
    case .before(let other), .after(let other): targetKey = other
    case .top, .bottom: targetKey = nil
    }
    let parent = siblingKey(next, list, byKey)
    if let targetKey = targetKey {
        guard let target = byKey[targetKey] else { return .invalid(L("Unknown target")) }
        if targetKey == key { return .invalid(L("A task cannot be moved next to itself")) }
        if list[target].engine != next.engine { return .invalid(L("Target is on another machine")) }
        if moveGroupOf(list[target].status) != moveGroupOf(next.status) { return .invalid(L("Target is in another group")) }
        if siblingKey(list[target], list, byKey) != parent { return .invalid(L("Tasks have different parents")) }
    }
    let peers = list.filter { $0.key != key && blockOf($0) == blockOf(next) && siblingKey($0, list, byKey) == parent }
        .sorted(by: comesBefore)
    var value = next.sortOrder
    switch spec {
    case .before(let other):
        guard let at = peers.firstIndex(where: { $0.key == other }) else { return .invalid(L("Unknown target")) }
        value = at > 0 ? (peers[at - 1].sortOrder + peers[at].sortOrder) / 2 : peers[at].sortOrder + 1
    case .after(let other):
        guard let at = peers.firstIndex(where: { $0.key == other }) else { return .invalid(L("Unknown target")) }
        value = at < peers.count - 1 ? (peers[at].sortOrder + peers[at + 1].sortOrder) / 2 : peers[at].sortOrder - 1
    case .top:
        if let highest = peers.map({ $0.sortOrder }).max() { value = highest + 1 }
    case .bottom:
        if let lowest = peers.map({ $0.sortOrder }).min() { value = lowest - 1 }
    }
    let orderBefore = (peers + [next]).sorted(by: comesBefore).map { $0.key }
    next.sortOrder = value
    let orderAfter = (peers + [next]).sorted(by: comesBefore).map { $0.key }
    if next.status == original.status && orderBefore == orderAfter { return .noChange }
    list[index] = next
    return .moved(list)
}

/// What dropping `source` with the pointer over one half of row `over` does; `rows` is one section as shown.
func dropDecision(rows: [Row], source: String, over: String, lowerHalf: Bool) -> DropDecision {
    guard let dragged = rows.first(where: { $0.key == source }),
          let hovered = rows.first(where: { $0.key == over }) else { return .invalid(.level) }
    if over == source || hovered.ancestors.contains(source) { return .noChange }
    if hovered.engine != dragged.engine { return .invalid(.engine) }
    if hovered.block != dragged.block { return .invalid(.group) }
    let scope = rows.filter { $0.block == dragged.block && $0.siblingKey == dragged.siblingKey }
    let spec: MoveSpec
    if hovered.siblingKey == dragged.siblingKey {
        spec = lowerHalf ? .after(hovered.key) : .before(hovered.key)
    } else if let sibling = scope.first(where: { $0.key != source && hovered.ancestors.contains($0.key) }) {
        spec = .after(sibling.key)  // over a sibling's child: the only place nearby is below that sibling's children
    } else {
        return .invalid(.level)
    }
    let keys = scope.map { $0.key }
    var others = keys.filter { $0 != source }
    switch spec {
    case .before(let key): others.insert(source, at: others.firstIndex(of: key)!)
    case .after(let key): others.insert(source, at: others.firstIndex(of: key)! + 1)
    case .top, .bottom: break
    }
    return others == keys ? .noChange : .place(spec)
}

/// A drop on the title of the row's own section: the top of its block, for a top-level row only.
func titleDrop(rows: [Row], source: String) -> DropDecision {
    guard let dragged = rows.first(where: { $0.key == source }) else { return .invalid(.level) }
    guard dragged.siblingKey.isEmpty else { return .invalid(.level) }
    let scope = rows.filter { $0.block == dragged.block && $0.siblingKey.isEmpty }
    return scope.first?.key == source ? .noChange : .place(.top)
}

/// What dropping `source` into another section does. `over` is the row under the pointer there, or nil for the
/// section's title, an empty section or the Done line. The item goes alone: rows it would gather as children there are
/// not valid places, and the rows of another engine or another server group refuse it.
func crossSectionDrop(_ list: ItemList, source: String, into target: Section, over: String?, lowerHalf: Bool) -> DropDecision {
    guard let index = list.items.firstIndex(where: { $0.key == source }),
          let status = statusForDrop(list.items[index], into: target) else { return .invalid(.level) }
    if target == .done { return .change(status, .top) }  // a count line
    var after = list
    after.items[index].status = status
    let rows = summarize(after).rows(target)
    guard let dragged = rows.first(where: { $0.key == source }) else { return .invalid(.level) }
    guard let over = over else { return .change(status, .top) }
    guard let hovered = rows.first(where: { $0.key == over }), hovered.key != source,
          !hovered.ancestors.contains(source) else { return .invalid(.level) }
    if hovered.engine != dragged.engine { return .invalid(.engine) }
    if hovered.block != dragged.block { return .invalid(.group) }
    if hovered.siblingKey == dragged.siblingKey {
        return .change(status, lowerHalf ? .after(hovered.key) : .before(hovered.key))
    }
    if hovered.key == dragged.siblingKey { return .change(status, .top) }  // its parent there: the first child
    if let sibling = rows.first(where: { $0.block == dragged.block && $0.siblingKey == dragged.siblingKey && $0.key != source
                                         && hovered.ancestors.contains($0.key) }) {
        return .change(status, .after(sibling.key))
    }
    return .invalid(.level)
}

/// Where the insertion line belongs for a reorder: the edge of a row, after the whole block for `.after`.
func insertionAnchor(rows: [Row], spec: MoveSpec) -> (key: String, below: Bool)? {
    switch spec {
    case .before(let key):
        return (key, false)
    case .after(let key):
        guard let start = rows.firstIndex(where: { $0.key == key }) else { return nil }
        var last = start
        while last + 1 < rows.count && rows[last + 1].ancestors.contains(key) { last += 1 }
        return (rows[last].key, true)
    case .top, .bottom:
        return nil
    }
}
