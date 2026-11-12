// T-Attention desktop widget for macOS: a small always-on-top counter of the unfinished T-Attention tasks, with a
// detail panel on hover to act on them. T-Agent builds and starts it (see widgets/macos/README.md). One file,
// AppKit only, no dependencies.
//
//   swiftc -O -swift-version 5 -framework AppKit TAttentionWidget.swift -o taw
//   TA_WIDGET_URL=http://127.0.0.1:3000 TA_WIDGET_TOKEN=<token> ./taw [--parent-pid PID] [--no-persist]
//
// --parent-pid PID     exit when PID is no longer this process's parent (checked every second)
// --no-persist         neither read nor write the saved window position
// --self-test          run the logic, request, drag and form checks without putting a window on screen and without the
//                      network; print ok / FAIL lines and exit 0 only when every check passed
// --render-sample DIR  build the widget and the panel with built-in sample data, render them offscreen into DIR/*.png
//                      and exit; no window is ever ordered on screen
//
// Data: GET {TA_WIDGET_URL}/api/attention/widget/items with `Authorization: Bearer {TA_WIDGET_TOKEN}`. The token is
// never printed or logged.
//
// Text: every visible string is English in this file and goes through L(), which looks it up in the table loaded from
// GET /api/attention/widget/strings (the English text itself when it is missing). S() only marks a string that is
// translated later with L(). widgets/macos/strings.json lists every such string; test/attention-widget-swift.test.js
// checks that the list and this file agree.
import AppKit
import Foundation

// MARK: - Strings

/// The interface strings of the current language, keyed by the English text.
var stringTable: [String: String] = [:]

/// The text of `key` in the current language, with {1}, {2} ... replaced by `values`.
func L(_ key: String, _ values: String...) -> String {
    var text = key
    if let translated = stringTable[key], !translated.trimmed.isEmpty { text = translated }
    for (index, value) in values.enumerated() {
        text = text.replacingOccurrences(of: "{\(index + 1)}", with: value)
    }
    return text
}

/// Marks an English interface string that is translated later with L().
func S(_ key: String) -> String { key }

/// The `strings` map of a GET /api/attention/widget/strings answer ({ lang, strings }); nil when it cannot be read.
func parseStrings(_ data: Data) -> [String: String]? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let strings = object["strings"] as? [String: Any] else { return nil }
    var out: [String: String] = [:]
    for (key, value) in strings {
        if let text = value as? String { out[key] = text }
    }
    return out
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Line breaks and runs of blank lines become single spaces.
    var oneLine: String {
        components(separatedBy: .newlines).map { $0.trimmed }.filter { !$0.isEmpty }.joined(separator: " ")
    }
}

/// A JSON value as text: a string, a number (whole numbers without a fraction), or the `text` of an object.
func looseText(_ value: Any?) -> String? {
    switch value {
    case let text as String:
        return text
    case let number as NSNumber:
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
        let double = number.doubleValue
        if double.rounded() == double, abs(double) < 1e15 { return String(Int64(double)) }
        return number.stringValue
    case let object as [String: Any]:
        return looseText(object["text"])
    default:
        return nil
    }
}

func looseNumber(_ value: Any?) -> Double? {
    switch value {
    case let number as NSNumber:
        return CFGetTypeID(number) == CFBooleanGetTypeID() ? nil : number.doubleValue
    case let text as String:
        return Double(text.trimmed)
    default:
        return nil
    }
}

// MARK: - Model

let statusOrder = ["todo", "working", "waiting_user", "review", "done", "failed", "cancelled"]
let finishedStatuses: Set<String> = ["done", "failed", "cancelled"]
let statusLabels: [String: String] = [
    "todo": S("To do"), "working": S("Working"), "waiting_user": S("Needs you"), "review": S("Review"),
    "done": S("Done"), "failed": S("Failed"), "cancelled": S("Cancelled"),
]

func statusLabel(_ status: String) -> String {
    statusLabels[status].map { L($0) } ?? status
}

/// One item of GET /api/attention/widget/items.
struct WidgetItem: Equatable {
    var key: String  // "<engine>:<id>", unique across engines
    var engine: String
    var id: String
    var parentKey: String = ""
    var title: String = ""
    var status: String = "todo"
    var customStatus: String = ""
    var result: String = ""
    var attentionReason: String = ""
    var pending: String = ""  // the text of `pending` (an object { kind, text } or plain text)
    var notes: String?  // nil when the answer has no notes: the edit form then leaves them alone
    var sortOrder: Double = 0
}

struct EngineInfo: Equatable {
    let key: String
    let name: String
    let local: Bool
    let colorIndex: Int  // into tagColors; -1 is the neutral colour
}

struct ItemList: Equatable {
    var items: [WidgetItem]
    var engines: [EngineInfo]
    var failed: [String]  // names of the engines that could not be read
}

func decodeItem(_ object: [String: Any]) -> WidgetItem? {
    guard let key = looseText(object["key"])?.trimmed, !key.isEmpty else { return nil }
    let cut = key.range(of: ":", options: .backwards)
    let engine = looseText(object["engine"]).flatMap { $0.isEmpty ? nil : $0 } ?? cut.map { String(key[..<$0.lowerBound]) } ?? "local"
    let id = looseText(object["id"]) ?? cut.map { String(key[$0.upperBound...]) } ?? key
    return WidgetItem(key: key, engine: engine, id: id,
                      parentKey: looseText(object["parent_key"])?.trimmed ?? "",
                      title: looseText(object["title"]) ?? "",
                      status: looseText(object["status"])?.trimmed ?? "todo",
                      customStatus: (looseText(object["custom_status"]) ?? "").trimmed,
                      result: (looseText(object["result"]) ?? "").trimmed,
                      attentionReason: (looseText(object["attention_reason"]) ?? "").trimmed,
                      pending: (looseText(object["pending"]) ?? "").trimmed,
                      notes: object.keys.contains("notes") ? (looseText(object["notes"]) ?? "") : nil,
                      sortOrder: looseNumber(object["sort_order"]) ?? 0)
}

func decodeEngine(_ object: [String: Any]) -> EngineInfo? {
    guard let key = looseText(object["key"])?.trimmed, !key.isEmpty else { return nil }
    let name = looseText(object["name"])?.trimmed ?? ""
    let local = (object["local"] as? Bool) ?? (key == "local")
    let index = looseNumber(object["color_index"]).map { Int($0) } ?? -1
    return EngineInfo(key: key, name: name.isEmpty ? key : name, local: local, colorIndex: index)
}

/// The answer of GET /api/attention/widget/items; nil when it is not one. An item that cannot be read is left out.
func decodeItemList(_ data: Data) -> ItemList? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let items = object["items"] as? [Any] else { return nil }
    let engines = (object["engines"] as? [Any] ?? []).compactMap { ($0 as? [String: Any]).flatMap(decodeEngine) }
    let failed: [String] = (object["failed"] as? [Any] ?? []).compactMap { entry in
        if let named = entry as? [String: Any] { return looseText(named["name"]) ?? looseText(named["key"]) }
        return looseText(entry)
    }
    return ItemList(items: items.compactMap { ($0 as? [String: Any]).flatMap(decodeItem) }, engines: engines, failed: failed)
}

/// The sections of the panel, top to bottom; done is only a count line.
enum Section: Int, CaseIterable {
    case needs, working, todo, done
}

func sectionOf(_ status: String) -> Section {
    switch status {
    case "waiting_user", "review": return .needs
    case "working": return .working
    case "done", "failed", "cancelled": return .done
    default: return .todo  // also a status this file does not know
    }
}

/// The group the server orders and moves an item in (services/attention.js GROUPS): Needs you holds two of them.
func moveGroupOf(_ status: String) -> String {
    if finishedStatuses.contains(status) { return "finished" }
    return ["waiting_user", "review", "working", "todo"].contains(status) ? status : "todo"
}

/// Rows of one engine and one server group: the only rows a row can be reordered among.
func blockOf(_ item: WidgetItem) -> String { item.engine + "|" + moveGroupOf(item.status) }

/// Engine blocks come in the order of `engines`, local ones first; an engine that is not listed comes after them.
func engineRanks(_ engines: [EngineInfo]) -> [String: Int] {
    var out: [String: Int] = [:]
    for engine in engines.filter({ $0.local }) + engines.filter({ !$0.local }) where out[engine.key] == nil {
        out[engine.key] = out.count
    }
    if out.isEmpty { out["local"] = 0 }
    return out
}

/// The order of the T-Attention page inside a group: sort_order highest first, then the id highest first.
func comesBefore(_ a: WidgetItem, _ b: WidgetItem) -> Bool {
    if a.sortOrder != b.sortOrder { return a.sortOrder > b.sortOrder }
    let idA = Double(a.id) ?? 0
    let idB = Double(b.id) ?? 0
    if idA != idB { return idA > idB }
    return a.key < b.key
}

func indexByKey(_ items: [WidgetItem]) -> [String: Int] {
    var out: [String: Int] = [:]
    for (index, item) in items.enumerated() where out[item.key] == nil {
        out[item.key] = index
    }
    return out
}

/// The parent's key when the parent is in the same block (same engine, same server group), else "": the row is then
/// an ordinary top-level row of its block.
func siblingKey(_ item: WidgetItem, _ items: [WidgetItem], _ byKey: [String: Int]) -> String {
    guard !item.parentKey.isEmpty, let parent = byKey[item.parentKey], items[parent].key != item.key,
          blockOf(items[parent]) == blockOf(item) else { return "" }
    return items[parent].key
}

/// The keys of the rows an item moves with, up through its own block. Never loops.
func ancestorKeys(_ item: WidgetItem, _ items: [WidgetItem], _ byKey: [String: Int]) -> Set<String> {
    var out = Set<String>()
    var seen: Set<String> = [item.key]
    var node = item
    while !node.parentKey.isEmpty, let parent = byKey[node.parentKey], seen.insert(items[parent].key).inserted,
          blockOf(items[parent]) == blockOf(node) {
        out.insert(items[parent].key)
        node = items[parent]
    }
    return out
}

/// The items of one section top to bottom with their depth: engine blocks (local first, then the order of `engines`),
/// in Needs you the waiting_user rows of an engine before its review rows, each block by sort_order with every child
/// directly under its parent (depth first).
func displayOrder(_ items: [WidgetItem], _ section: Section, engines: [EngineInfo]) -> [(item: WidgetItem, depth: Int)] {
    let ranks = engineRanks(engines)
    let byKey = indexByKey(items)
    var blocks: [String: [WidgetItem]] = [:]
    for item in items where sectionOf(item.status) == section {
        blocks[blockOf(item), default: []].append(item)
    }
    let blockKeys = blocks.keys.sorted { a, b in
        let first = blocks[a]![0]
        let second = blocks[b]![0]
        let rankA = ranks[first.engine] ?? ranks.count
        let rankB = ranks[second.engine] ?? ranks.count
        if rankA != rankB { return rankA < rankB }
        if first.engine != second.engine { return first.engine < second.engine }
        let groupA = moveGroupOf(first.status) == "review" ? 1 : 0
        let groupB = moveGroupOf(second.status) == "review" ? 1 : 0
        return groupA != groupB ? groupA < groupB : a < b
    }
    var out: [(item: WidgetItem, depth: Int)] = []
    for blockKey in blockKeys {
        let block = blocks[blockKey]!.sorted(by: comesBefore)
        var children: [String: [WidgetItem]] = [:]
        var roots: [WidgetItem] = []
        for item in block {
            let parent = siblingKey(item, items, byKey)
            if parent.isEmpty { roots.append(item) } else { children[parent, default: []].append(item) }
        }
        var seen = Set<String>()
        func walk(_ item: WidgetItem, _ depth: Int) {
            guard seen.insert(item.key).inserted else { return }
            out.append((item, depth))
            for child in children[item.key] ?? [] { walk(child, depth + 1) }
        }
        for root in roots { walk(root, 0) }
        for item in block where !seen.contains(item.key) { walk(item, 0) }  // a cycle in the data: top-level rows
    }
    return out
}

/// A button on a row of the Needs you section. The raw value is the last part of its request path.
enum RowAction: String {
    case confirm, reject, handled

    var label: String {
        switch self {
        case .confirm: return L("Confirm")
        case .reject: return L("Reject")
        case .handled: return L("Handled")
        }
    }

    var isPrimary: Bool { self == .confirm }
}

/// Review rows are confirmed or rejected; a row waiting for the user is marked handled.
func rowActions(for item: WidgetItem) -> [RowAction] {
    switch item.status {
    case "review": return [.confirm, .reject]
    case "waiting_user": return [.handled]
    default: return []
    }
}

struct EngineTag: Equatable {
    let name: String
    let colorIndex: Int
}

struct Row: Equatable {
    let key: String
    let engine: String
    let title: String
    let custom: String  // custom_status, shown as a muted suffix
    let detail: String  // the second line
    let depth: Int
    let siblingKey: String  // who it is reordered among: the parent's key, or "" at the top level of its block
    let ancestors: Set<String>
    let block: String
    let actions: [RowAction]  // part of the comparison, so a status change alone rebuilds the buttons
    let tag: EngineTag?  // shown when the answer lists more than one engine

    var isChild: Bool { depth > 0 }
}

struct Summary: Equatable {
    let unfinished: Int
    let needs: [Row]
    let working: [Row]
    let todo: [Row]
    let done: Int
    let failed: [String]

    func rows(_ section: Section) -> [Row] {
        switch section {
        case .needs: return needs
        case .working: return working
        case .todo: return todo
        case .done: return []
        }
    }
}

/// The second line of a row: what is pending, else why it needs the user, else its result.
func detailText(_ item: WidgetItem) -> String {
    [item.pending, item.attentionReason, item.result].map { $0.oneLine }.first { !$0.isEmpty } ?? ""
}

/// At most `max` characters, else `max - 1` and an ellipsis (shortName in scripts/h5-shell/task-order.mjs).
func shortName(_ name: String, max: Int = 10) -> String {
    let chars = Array(name.trimmed)
    return chars.count > max ? String(chars.prefix(max - 1)) + "\u{2026}" : String(chars)
}

func summarize(_ list: ItemList) -> Summary {
    let items = list.items
    let byKey = indexByKey(items)
    var engines: [String: EngineInfo] = [:]
    for engine in list.engines where engines[engine.key] == nil { engines[engine.key] = engine }
    let showTags = engines.count > 1
    func rows(_ section: Section) -> [Row] {
        displayOrder(items, section, engines: list.engines).map { entry in
            let item = entry.item
            let engine = engines[item.engine]
            return Row(key: item.key, engine: item.engine, title: item.title.oneLine, custom: item.customStatus.oneLine,
                       detail: detailText(item), depth: entry.depth, siblingKey: siblingKey(item, items, byKey),
                       ancestors: ancestorKeys(item, items, byKey), block: blockOf(item),
                       actions: section == .needs ? rowActions(for: item) : [],
                       tag: showTags ? EngineTag(name: shortName(engine?.name ?? item.engine), colorIndex: engine?.colorIndex ?? -1) : nil)
        }
    }
    return Summary(unfinished: items.filter { !finishedStatuses.contains($0.status) }.count,
                   needs: rows(.needs), working: rows(.working), todo: rows(.todo),
                   done: items.filter { sectionOf($0.status) == .done }.count, failed: list.failed)
}

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
    if sectionOf(item.status) == target { return nil }
    switch target {
    case .needs: return "waiting_user"
    case .working: return "working"
    case .todo: return "todo"
    case .done: return "done"
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

// MARK: - Requests

let defaultBaseURL = "http://127.0.0.1:3000"
let requestTimeout: TimeInterval = 3
let keyAllowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

/// What the task form holds; every value is trimmed the way the server stores it.
struct TaskDraft: Equatable {
    var title: String
    var status: String
    var customStatus: String
    var notes: String

    init(title: String = "", status: String = "todo", customStatus: String = "", notes: String = "") {
        self.title = title.trimmed
        self.status = status
        self.customStatus = customStatus.trimmed
        self.notes = notes.trimmed
    }

    init(_ item: WidgetItem) {
        self.init(title: item.title, status: item.status, customStatus: item.customStatus, notes: item.notes ?? "")
    }
}

/// The body of the PATCH for an edit; empty when nothing changed. Notes count only when the form showed them.
func changedFields(original: TaskDraft, edited: TaskDraft, includeNotes: Bool = true) -> [String: Any] {
    var fields: [String: Any] = [:]
    if edited.title != original.title { fields["title"] = edited.title }
    if edited.status != original.status { fields["status"] = edited.status }
    if edited.customStatus != original.customStatus { fields["custom_status"] = edited.customStatus }
    if includeNotes && edited.notes != original.notes { fields["notes"] = edited.notes }
    return fields
}

/// The requests of T-Agent's widget API. The token goes only into the Authorization header.
struct WidgetAPI {
    let base: String
    let token: String

    init(base: String?, token: String?) {
        var text = (base ?? "").trimmed
        while text.hasSuffix("/") { text.removeLast() }
        if let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host != nil {
            self.base = text
        } else {
            self.base = defaultBaseURL
        }
        self.token = (token ?? "").trimmed
    }

    /// Keys contain ':' (and an engine key may hold more), so everything but the unreserved characters is encoded.
    static func encodeKey(_ key: String) -> String {
        key.addingPercentEncoding(withAllowedCharacters: keyAllowed) ?? key
    }

    func request(_ method: String, _ path: String, body: [String: Any]? = nil) -> URLRequest {
        var request = URLRequest(url: URL(string: base + path) ?? URL(string: defaultBaseURL + path)!)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = requestTimeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body = body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        }
        return request
    }

    private func itemPath(_ key: String) -> String { "/api/attention/widget/items/" + WidgetAPI.encodeKey(key) }

    var itemsRequest: URLRequest { request("GET", "/api/attention/widget/items") }
    var stringsRequest: URLRequest { request("GET", "/api/attention/widget/strings") }

    /// A new task is always made on this machine.
    func createRequest(_ draft: TaskDraft) -> URLRequest {
        var body: [String: Any] = ["engine": "local", "title": draft.title, "status": draft.status]
        if !draft.notes.isEmpty { body["notes"] = draft.notes }
        return request("POST", "/api/attention/widget/items", body: body)
    }

    func updateRequest(key: String, fields: [String: Any]) -> URLRequest {
        request("PATCH", itemPath(key), body: fields)
    }

    func deleteRequest(key: String) -> URLRequest {
        request("DELETE", itemPath(key))
    }

    func moveRequest(key: String, spec: MoveSpec, status: String?) -> URLRequest {
        var body: [String: Any] = [:]
        switch spec {
        case .before(let other): body["before_key"] = other
        case .after(let other): body["after_key"] = other
        case .top: body["position"] = "top"
        case .bottom: body["position"] = "bottom"
        }
        if let status = status { body["status"] = status }
        return request("POST", itemPath(key) + "/move", body: body)
    }

    func actionRequest(key: String, action: RowAction) -> URLRequest {
        request("POST", itemPath(key) + "/" + action.rawValue, body: [:])
    }
}

/// The message of an error answer ({ error, message }), or what went wrong without one.
func failureText(_ data: Data?, _ error: Error?) -> String {
    if let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        if let message = looseText(json["message"])?.trimmed, !message.isEmpty { return message }
        if let code = looseText(json["error"])?.trimmed, !code.isEmpty { return code }
    }
    return error == nil ? L("T-Agent refused this change") : L("Could not reach T-Agent")
}

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
    }

    override func mouseUp(with event: NSEvent) {
        startMouse = nil
        if moved {
            moved = false
            onDragEnd()
        }
    }
}

/// A small button in the panel. It draws itself because the panel is rarely key, and a system default button is
/// drawn without its colour in a window that is not key.
class PanelButton: NSButton {
    var label: String { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    private let tint: NSColor?
    private let fontSize: CGFloat

    init(label: String, tint: NSColor? = nil, fontSize: CGFloat = 11) {
        self.label = label
        self.tint = tint
        self.fontSize = fontSize
        super.init(frame: .zero)
        title = label
        isBordered = false
        refusesFirstResponder = true
        focusRingType = .none
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel(label)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var isEnabled: Bool { didSet { needsDisplay = true } }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func labelText(alpha: CGFloat) -> NSAttributedString {
        let color: NSColor = tint == nil ? .labelColor : .white
        return NSAttributedString(string: label, attributes: [
            .font: NSFont.systemFont(ofSize: fontSize, weight: .medium),
            .foregroundColor: color.withAlphaComponent(alpha),
        ])
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: ceil(labelText(alpha: 1).size().width) + 18, height: 20)
    }

    override func draw(_ dirtyRect: NSRect) {
        let strength: CGFloat = isEnabled ? (isHighlighted ? 0.7 : 1) : 0.4
        let fill = tint?.withAlphaComponent(strength) ?? NSColor.labelColor.withAlphaComponent(0.12 * strength)
        fill.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
        let text = labelText(alpha: isEnabled ? 1 : 0.5)
        let size = text.size()
        text.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }
}

/// A button in a task row.
final class ActionButton: PanelButton {
    let rowAction: RowAction
    var onPress: () -> Void = {}
    var onRelease: () -> Void = {}
    var contextMenu: () -> NSMenu? = { nil }  // the row's menu, so a right click on a button still opens it

    init(_ rowAction: RowAction) {
        self.rowAction = rowAction
        super.init(label: rowAction.label, tint: rowAction.isPrimary ? .controlAccentColor : nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

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

let dragThreshold: CGFloat = 4

/// One task row in the detail panel: a press followed by movement drags it, a plain click does nothing.
final class TaskRowView: NSView {
    var actionButtons: [ActionButton] = []
    var onPress: () -> Void = {}
    var onDragBegin: () -> Void = {}
    var onDragMove: (NSEvent) -> Void = { _ in }
    var onDragEnd: () -> Void = {}
    var onRelease: () -> Void = {}
    var contextMenu: () -> NSMenu? = { nil }
    private var startPoint: NSPoint?
    private var active = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // The label and the engine tag must not take the press, or the panel would not pass it through without
    // activation. A button takes its own press even when disabled, so a press on it never starts a drag.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard frame.contains(point) else { return nil }
        let local = convert(point, from: superview)
        return actionButtons.first { $0.convert($0.bounds, to: self).contains(local) } ?? self
    }

    func setActionsEnabled(_ enabled: Bool) {
        actionButtons.forEach { $0.isEnabled = enabled }
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

func makeBackground(radius: CGFloat) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .popover
    view.blendingMode = .behindWindow
    view.state = .active
    view.maskImage = roundedMask(radius: radius)
    view.autoresizingMask = [.width, .height]
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

// MARK: - Controller

let widgetSize = NSSize(width: 76, height: 72)
let detailWidth: CGFloat = 320
let detailPadding: CGFloat = 12
let detailMaxHeight: CGFloat = 520
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
    private let parentPID: pid_t?
    private let options: WidgetOptions
    private let api: WidgetAPI
    private let session: URLSession
    private lazy var defaults: UserDefaults = UserDefaults(suiteName: defaultsSuite) ?? .standard

    private let widget = makePanel(size: widgetSize)
    private let detail = makePanel(size: NSSize(width: detailWidth, height: 120))
    private var widgetRoot: DragView?
    private var detailRoot: HoverView?
    private let countLabel = NSTextField(labelWithString: "\u{2013}")
    private let caption = NSTextField(labelWithString: "")
    private let badge = NSView()
    private let badgeLabel = NSTextField(labelWithString: "")
    private let scrollView = NSScrollView()
    private let documentView = FlippedView()
    private let stack = NSStackView()

    private let insertionLine = NSView()
    private let toast = NSView()
    private let toastLabel = NSTextField(labelWithString: "")
    private let plusButton = PanelButton(label: "+", fontSize: 15)

    private var overlay: OverlayView?  // the open form or confirmation; holds the panel
    private var menuOpen = false  // holds the panel while a context menu is showing
    private var previousApp: NSRunningApplication?  // who to give the focus back to if this app ever became active
    private var summary: Summary?
    private var list: ItemList?
    private var problem: String?  // why there is no list
    private var hasResult = false
    private var contentHeight: CGFloat = 120
    private var hideTimer: Timer?
    private var dragging = false
    private var rowViews: [String: TaskRowView] = [:]
    private var sectionTitles: [String: NSView] = [:]  // keyed by the key of the section's first row
    private var sectionHeaders: [Section: NSView] = [:]  // each section's title, and the Done line
    private let dropHighlight = NSView()  // behind the title of the section a drop would change the status to
    private let dropHint = NSTextField(labelWithString: "")
    private var pressedRow: String?  // set from mouse down to mouse up; holds the panel and the refresh
    private var rowDragActive = false
    private var drop: DropDecision = .noChange
    private var moveInFlight = false { didSet { syncActionButtons() } }
    private var buttonHeld = false  // set while an action button is pressed; holds the panel and the refresh
    private var actionRows = Set<String>()  // rows whose request is out or whose success is not refreshed yet
    private var actionsRunning = 0
    private var actionNeedsRefresh = false
    private var refreshGeneration = 0
    private var toastTimer: Timer?
    private var stringsLoaded = false
    private var stringsLoading = false
    var moveHook: ((String, MoveSpec, String?) -> Void)?  // for --self-test: takes a drop instead of the server
    /// For --self-test and --render-sample: takes every request instead of the network, with the function that
    /// answers it (body, status), now or later.
    var requestHook: ((URLRequest, @escaping (Data?, Int) -> Void) -> Void)?

    init(api: WidgetAPI, parentPID: pid_t?, options: WidgetOptions) {
        self.api = api
        self.parentPID = parentPID
        self.options = options
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]  // localhost must never go through http_proxy
        config.timeoutIntervalForRequest = requestTimeout
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
        addTimer(refreshInterval) { [weak self] in self?.refresh() }
        addTimer(tickInterval) { [weak self] in self?.tick() }
        loadStrings()
        refresh()
    }

    func applicationDidChangeScreenParameters(_ notification: Notification) {
        widget.setFrame(keptOnScreen(widget.frame), display: true)
        if detail.isVisible { positionDetail() }
    }

    private func addTimer(_ interval: TimeInterval, _ body: @escaping () -> Void) {
        let timer = Timer(timeInterval: interval, repeats: true) { _ in body() }
        RunLoop.main.add(timer, forMode: .common)  // keeps firing while a menu is open
    }

    /// The only place a panel is put on screen; --self-test and --render-sample never get here.
    private func orderFront(_ panel: NSPanel) {
        guard !options.offscreen else { return }
        panel.orderFrontRegardless()
    }

    private func perform(_ request: URLRequest, _ done: @escaping (Data?, Int, Error?) -> Void) {
        if let hook = requestHook {
            hook(request) { data, code in done(data, code, nil) }
            return
        }
        session.dataTask(with: request) { data, response, error in
            done(data, (response as? HTTPURLResponse)?.statusCode ?? 0, error)
        }.resume()
    }

    // MARK: Collapsed window

    private func buildWidget() {
        let root = DragView(frame: NSRect(origin: .zero, size: widgetSize))
        root.onEnter = { [weak self] in self?.pointerEntered() }
        root.onExit = { [weak self] in self?.pointerExited() }
        root.onDragBegin = { [weak self] in self?.dragBegan() }
        root.onDragEnd = { [weak self] in self?.dragEnded() }
        root.menu = makeMenu([])
        widgetRoot = root

        let background = makeBackground(radius: 14)
        background.frame = root.bounds
        root.addSubview(background)

        countLabel.alignment = .center
        countLabel.textColor = .labelColor
        countLabel.translatesAutoresizingMaskIntoConstraints = false
        caption.stringValue = L("Tasks")
        caption.font = .systemFont(ofSize: 11)
        caption.textColor = .secondaryLabelColor
        caption.translatesAutoresizingMaskIntoConstraints = false

        badge.wantsLayer = true
        badge.layer?.backgroundColor = NSColor.systemRed.cgColor
        badge.layer?.cornerRadius = 9
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.isHidden = true
        badgeLabel.font = .systemFont(ofSize: 11, weight: .bold)
        badgeLabel.textColor = .white
        badgeLabel.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(badgeLabel)

        root.addSubview(countLabel)
        root.addSubview(caption)
        root.addSubview(badge)
        NSLayoutConstraint.activate([
            countLabel.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            countLabel.centerYAnchor.constraint(equalTo: root.centerYAnchor, constant: -8),
            caption.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            caption.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -7),
            badge.topAnchor.constraint(equalTo: root.topAnchor, constant: 4),
            badge.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -4),
            badge.heightAnchor.constraint(equalToConstant: 18),
            badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 18),
            badgeLabel.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
            badgeLabel.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
            badgeLabel.leadingAnchor.constraint(greaterThanOrEqualTo: badge.leadingAnchor, constant: 5),
            badgeLabel.trailingAnchor.constraint(lessThanOrEqualTo: badge.trailingAnchor, constant: -5),
        ])
        widget.contentView = root
        updateCollapsed()
    }

    private func updateCollapsed() {
        let text = summary.map { String($0.unfinished) } ?? "\u{2013}"
        let size: CGFloat = text.count <= 2 ? 30 : (text.count == 3 ? 24 : 18)
        countLabel.font = .monospacedDigitSystemFont(ofSize: size, weight: .semibold)
        countLabel.stringValue = text
        let needs = summary?.needs.count ?? 0
        badge.isHidden = needs == 0
        badgeLabel.stringValue = String(needs)
    }

    private func initialOrigin() -> NSPoint {
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
        if !options.persistPosition {
            return NSPoint(x: visible.minX + 16, y: visible.minY + 16)
        }
        if defaults.object(forKey: "x") != nil, defaults.object(forKey: "y") != nil {
            let saved = NSRect(x: defaults.double(forKey: "x"), y: defaults.double(forKey: "y"),
                               width: widgetSize.width, height: widgetSize.height)
            return keptOnScreen(saved).origin
        }
        return NSPoint(x: visible.maxX - widgetSize.width - 16, y: visible.maxY - widgetSize.height - 16)
    }

    /// Moves rect fully inside the screen it overlaps most, or the main screen if it overlaps none.
    private func keptOnScreen(_ rect: NSRect) -> NSRect {
        func overlap(_ screen: NSScreen) -> CGFloat {
            let common = rect.intersection(screen.visibleFrame)
            return common.isNull ? 0 : common.width * common.height
        }
        let best = NSScreen.screens.filter { overlap($0) > 0 }.max { overlap($0) < overlap($1) }
        guard let visible = (best ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else { return rect }
        var out = rect
        out.origin.x = min(max(out.origin.x, visible.minX), visible.maxX - out.width)
        out.origin.y = min(max(out.origin.y, visible.minY), visible.maxY - out.height)
        return out
    }

    private func dragBegan() {
        dragging = true
        cancelHide()
        if overlay == nil { detail.orderOut(nil) }  // a form stays up, with whatever has been typed
    }

    private func dragEnded() {
        dragging = false
        widget.setFrame(keptOnScreen(widget.frame), display: true)
        if options.persistPosition {
            defaults.set(Double(widget.frame.origin.x), forKey: "x")
            defaults.set(Double(widget.frame.origin.y), forKey: "y")
        }
        if overlay != nil || widget.frame.contains(NSEvent.mouseLocation) { showDetail() }
    }

    // MARK: Detail panel

    private func buildDetail() {
        let root = HoverView(frame: NSRect(x: 0, y: 0, width: detailWidth, height: 120))
        root.onEnter = { [weak self] in self?.pointerEntered() }
        root.onExit = { [weak self] in self?.pointerExited() }
        detailRoot = root

        let background = makeBackground(radius: 12)
        background.frame = root.bounds
        root.addSubview(background)

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        stack.edgeInsets = NSEdgeInsets(top: detailPadding, left: detailPadding, bottom: detailPadding, right: detailPadding)
        stack.translatesAutoresizingMaskIntoConstraints = false
        documentView.frame = NSRect(x: 0, y: 0, width: detailWidth, height: 120)
        documentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: documentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: documentView.leadingAnchor),
            stack.widthAnchor.constraint(equalToConstant: detailWidth),
        ])

        scrollView.frame = root.bounds
        scrollView.autoresizingMask = [.width, .height]
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.documentView = documentView
        root.addSubview(scrollView)
        root.menu = makeMenu([])  // the row menu takes over on a row

        plusButton.target = self
        plusButton.action = #selector(plusClicked)
        plusButton.toolTip = L("New task")
        plusButton.setAccessibilityLabel(L("New task"))
        root.addSubview(plusButton)
        NSLayoutConstraint.activate([
            plusButton.topAnchor.constraint(equalTo: root.topAnchor, constant: 6),
            plusButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -8),
            plusButton.widthAnchor.constraint(equalToConstant: 22),
            plusButton.heightAnchor.constraint(equalToConstant: 22),
        ])

        insertionLine.wantsLayer = true
        insertionLine.layer?.backgroundColor = NSColor.controlAccentColor.cgColor
        insertionLine.layer?.cornerRadius = 1
        insertionLine.isHidden = true
        documentView.addSubview(insertionLine)

        dropHighlight.wantsLayer = true
        dropHighlight.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.18).cgColor
        dropHighlight.layer?.borderColor = NSColor.controlAccentColor.cgColor
        dropHighlight.layer?.borderWidth = 1
        dropHighlight.layer?.cornerRadius = 5
        dropHighlight.isHidden = true
        dropHint.font = .systemFont(ofSize: 10, weight: .semibold)
        dropHint.textColor = .controlAccentColor
        dropHint.alignment = .right
        dropHint.lineBreakMode = .byTruncatingHead
        dropHighlight.addSubview(dropHint)
        documentView.addSubview(dropHighlight, positioned: .below, relativeTo: stack)
        documentView.addSubview(insertionLine, positioned: .above, relativeTo: nil)  // over the highlight and the rows

        toast.wantsLayer = true
        toast.layer?.backgroundColor = NSColor.systemRed.withAlphaComponent(0.92).cgColor
        toast.layer?.cornerRadius = 6
        toast.isHidden = true
        toast.translatesAutoresizingMaskIntoConstraints = false
        toastLabel.font = .systemFont(ofSize: 11, weight: .medium)
        toastLabel.textColor = .white
        toastLabel.lineBreakMode = .byTruncatingTail
        toastLabel.translatesAutoresizingMaskIntoConstraints = false
        toast.addSubview(toastLabel)
        root.addSubview(toast)
        NSLayoutConstraint.activate([
            toast.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 8),
            toast.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -8),
            toast.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -8),
            toast.heightAnchor.constraint(equalToConstant: 24),
            toastLabel.leadingAnchor.constraint(equalTo: toast.leadingAnchor, constant: 8),
            toastLabel.trailingAnchor.constraint(equalTo: toast.trailingAnchor, constant: -8),
            toastLabel.centerYAnchor.constraint(equalTo: toast.centerYAnchor),
        ])
        detail.contentView = root
        rebuildDetail()
    }

    private func makeField(_ text: NSAttributedString, width: CGFloat = detailWidth - detailPadding * 2) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: "")
        field.attributedStringValue = text
        field.maximumNumberOfLines = 4
        field.cell?.truncatesLastVisibleLine = true
        field.preferredMaxLayoutWidth = width
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: width).isActive = true
        return field
    }

    @discardableResult
    private func addLine(_ text: NSAttributedString, after spacing: CGFloat = 5) -> NSView {
        let field = makeField(text)
        stack.addArrangedSubview(field)
        stack.setCustomSpacing(spacing, after: field)
        return field
    }

    private func addRow(_ row: Row, after spacing: CGFloat) {
        let fullWidth = detailWidth - detailPadding * 2
        let view = TaskRowView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: fullWidth).isActive = true
        var fieldWidth = fullWidth
        var pill: EnginePill?
        if let tag = row.tag {
            let made = EnginePill(tag)
            fieldWidth -= made.intrinsicContentSize.width + 6
            pill = made
        }
        let field = makeField(rowText(row), width: fieldWidth)
        view.addSubview(field)
        let key = row.key
        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: view.topAnchor),
            field.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        ])
        if let pill = pill {
            view.addSubview(pill)
            NSLayoutConstraint.activate([
                pill.topAnchor.constraint(equalTo: view.topAnchor, constant: 0),
                pill.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                view.bottomAnchor.constraint(greaterThanOrEqualTo: pill.bottomAnchor),
            ])
        }
        if row.actions.isEmpty {
            field.bottomAnchor.constraint(equalTo: view.bottomAnchor).isActive = true
        } else {
            view.actionButtons = row.actions.map { makeActionButton($0, key) }
            let buttons = NSStackView(views: view.actionButtons)
            buttons.orientation = .horizontal
            buttons.spacing = 6
            buttons.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(buttons)
            NSLayoutConstraint.activate([
                buttons.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 4),
                buttons.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                buttons.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
        }
        view.onPress = { [weak self] in self?.rowPressed(key) }
        view.onDragBegin = { [weak self] in self?.rowDragBegan(key) }
        view.onDragMove = { [weak self] event in self?.rowDragMoved(event) }
        view.onDragEnd = { [weak self] in self?.rowDragEnded() }
        view.onRelease = { [weak self] in self?.rowReleased() }
        view.contextMenu = { [weak self] in self?.rowMenu(key) }
        view.actionButtons.forEach { $0.contextMenu = view.contextMenu }
        stack.addArrangedSubview(view)
        stack.setCustomSpacing(spacing, after: view)
        rowViews[key] = view
    }

    private func makeActionButton(_ action: RowAction, _ key: String) -> ActionButton {
        let button = ActionButton(action)
        button.target = self
        button.action = #selector(actionButtonClicked(_:))
        button.identifier = NSUserInterfaceItemIdentifier(key)
        button.onPress = { [weak self] in self?.actionButtonPressed() }
        button.onRelease = { [weak self] in self?.actionButtonReleased() }
        return button
    }

    private func plain(_ text: String, size: CGFloat = 12, weight: NSFont.Weight = .regular,
                       color: NSColor = .labelColor) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: color,
        ])
    }

    private func rowText(_ row: Row) -> NSAttributedString {
        let out = NSMutableAttributedString()
        var indent: CGFloat = 0
        if row.isChild {
            let prefix = plain(String(repeating: "   ", count: min(row.depth, 3) - 1) + "\u{2514} ", color: .secondaryLabelColor)
            indent = ceil(prefix.size().width)
            out.append(prefix)
        }
        out.append(plain(row.title.isEmpty ? "\u{2013}" : row.title))
        if !row.custom.isEmpty {
            out.append(plain("  " + row.custom, size: 11, color: .secondaryLabelColor))
        }
        let titleEnd = out.length
        if !row.detail.isEmpty {
            out.append(plain("\n" + row.detail, size: 11, color: .secondaryLabelColor))
        }
        if indent > 0 {  // wrapped title lines and the second line start under the title, not under the mark
            let title = NSMutableParagraphStyle()
            title.headIndent = indent
            out.addAttribute(.paragraphStyle, value: title, range: NSRange(location: 0, length: titleEnd))
            let detail = NSMutableParagraphStyle()
            detail.firstLineHeadIndent = indent
            detail.headIndent = indent
            out.addAttribute(.paragraphStyle, value: detail, range: NSRange(location: titleEnd, length: out.length - titleEnd))
        }
        return out
    }

    private func addSection(_ title: String, _ rows: [Row], _ section: Section, empty: String) {
        let header = addLine(plain(title, weight: .semibold))
        sectionHeaders[section] = header
        if rows.isEmpty {
            addLine(plain(empty, color: .tertiaryLabelColor), after: 12)
            return
        }
        sectionTitles[rows[0].key] = header
        for (index, row) in rows.enumerated() {
            addRow(row, after: index == rows.count - 1 ? 12 : 5)
        }
    }

    private func rebuildDetail() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        rowViews = [:]
        sectionTitles = [:]
        sectionHeaders = [:]
        if let summary = summary {
            addSection("\u{1F534} " + L("Needs you"), summary.needs, .needs, empty: L("Nothing needs you"))
            addSection("\u{1F7E2} " + L("Working"), summary.working, .working, empty: L("None"))
            addSection("\u{1F7E1} " + L("To do"), summary.todo, .todo, empty: L("None"))
            let doneLine = addLine(plain("\u{26AA} " + L("Done: {1}", String(summary.done)), color: .secondaryLabelColor),
                                   after: summary.failed.isEmpty ? 5 : 8)
            sectionHeaders[.done] = doneLine
            for name in summary.failed {
                addLine(plain(L("Could not load {1}", name), size: 11, color: .tertiaryLabelColor), after: 3)
            }
        } else {
            addLine(plain(problem ?? L("Could not reach T-Agent"), color: .secondaryLabelColor))
        }
        syncActionButtons()
        stack.layoutSubtreeIfNeeded()
        contentHeight = ceil(stack.fittingSize.height)
        documentView.setFrameSize(NSSize(width: detailWidth, height: contentHeight))
    }

    private func positionDetail() {
        let visible = (widget.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let height = min(max(contentHeight, overlay?.preferredHeight ?? 0), detailMaxHeight, visible.height - screenMargin * 2)
        let anchor = widget.frame
        var x = anchor.maxX + panelGap
        if x + detailWidth > visible.maxX - screenMargin {
            x = anchor.minX - panelGap - detailWidth
        }
        x = max(visible.minX + screenMargin, min(x, visible.maxX - screenMargin - detailWidth))
        var y = anchor.maxY - height
        y = max(visible.minY + screenMargin, min(y, visible.maxY - screenMargin - height))
        detail.setFrame(NSRect(x: x, y: y, width: detailWidth, height: height), display: !options.offscreen)
        if !options.offscreen { detail.invalidateShadow() }
    }

    private func showDetail() {
        cancelHide()
        let wasVisible = detail.isVisible
        positionDetail()
        if !wasVisible {
            scrollView.contentView.scroll(to: .zero)
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }
        orderFront(detail)
    }

    private func pointerEntered() {
        cancelHide()
        if !dragging { showDetail() }
    }

    private func pointerExited() {
        guard !holdsPanel else { return }
        cancelHide()
        let timer = Timer(timeInterval: hideDelay, repeats: false) { [weak self] _ in
            self?.hideTimer = nil
            self?.detail.orderOut(nil)
        }
        RunLoop.main.add(timer, forMode: .common)
        hideTimer = timer
    }

    private func cancelHide() {
        hideTimer?.invalidate()
        hideTimer = nil
    }

    // A toast counts so that a failure message is not closed away with the panel while it shows.
    private var holdsPanel: Bool {
        dragging || pressedRow != nil || buttonHeld || !actionRows.isEmpty || toastTimer != nil || overlay != nil || menuOpen
    }

    private func hideIfPointerOutside() {
        guard !options.offscreen else { return }
        let mouse = NSEvent.mouseLocation
        if !widget.frame.contains(mouse) && !detail.frame.contains(mouse) { pointerExited() }
    }

    // MARK: Reordering

    private var items: [WidgetItem] { list?.items ?? [] }

    private var rowsInDragSection: [Row] {
        guard let summary = summary, let source = pressedRow else { return [] }
        return [summary.needs, summary.working, summary.todo].first { $0.contains { $0.key == source } } ?? []
    }

    private func frameInDocument(_ key: String) -> NSRect? {
        rowViews[key].map { $0.convert($0.bounds, to: documentView) }
    }

    private func rowPressed(_ key: String) {
        // While an action is out the list is about to change, so a drop computed on it could be wrong.
        guard !moveInFlight, actionRows.isEmpty else { return }
        cancelHide()
        pressedRow = key
        refreshGeneration += 1  // a response already on its way must not rebuild the row under the pointer
    }

    private func rowReleased() {
        pressedRow = nil
        hideIfPointerOutside()
    }

    private func rowDragBegan(_ key: String) {
        guard pressedRow == key else { return }
        rowDragActive = true
        dragging = true
        cancelHide()
        drop = .noChange
        for row in rowsInDragSection where row.key == key || row.ancestors.contains(key) {
            rowViews[row.key]?.alphaValue = 0.45
        }
        NSCursor.closedHand.set()
    }

    private func rowDragMoved(_ event: NSEvent) {
        guard rowDragActive else { return }
        documentView.autoscroll(with: event)
        updateDrop(documentY: documentView.convert(event.locationInWindow, from: nil).y)
    }

    /// Works out the drop for a pointer at this height in the (flipped) list and shows it.
    private func updateDrop(documentY y: CGFloat) {
        let target = sectionAt(documentY: y)
        drop = decideDrop(documentY: y)
        var line: (anchor: (key: String, below: Bool)?, underTitle: Bool) = (nil, false)
        switch drop {
        case .place(let spec):
            line.anchor = insertionAnchor(rows: rowsInDragSection, spec: spec)
            if spec == .top, let source = pressedRow {
                let rows = rowsInDragSection
                let block = rows.first { $0.key == source }?.block
                if let first = rows.first(where: { $0.block == block }) { line.anchor = (first.key, false) }
            }
        case .change(let status, let spec):
            line = crossLine(target, status, spec)
        case .noChange, .invalid:
            break
        }
        if case .change(let status, _) = drop, let target = target {
            showDropHighlight(target, status)
        } else {
            dropHighlight.isHidden = true
        }
        // Rows under the dragged one stay where they are when it changes section.
        if let source = pressedRow {
            var crossing = false
            if case .change = drop { crossing = true }
            for row in rowsInDragSection where row.ancestors.contains(source) {
                rowViews[row.key]?.alphaValue = crossing ? 1 : 0.45
            }
        }
        var lineY: CGFloat?
        if let anchor = line.anchor, let frame = frameInDocument(anchor.key) {
            lineY = anchor.below ? frame.maxY + 1.5 : frame.minY - 3.5
        } else if line.underTitle, let target = target, let title = sectionHeaders[target] {
            lineY = title.convert(title.bounds, to: documentView).maxY + 1.5
        }
        if let lineY = lineY {
            insertionLine.frame = NSRect(x: detailPadding, y: lineY, width: detailWidth - detailPadding * 2, height: 2)
            insertionLine.isHidden = false
            NSCursor.closedHand.set()
        } else {
            insertionLine.isHidden = true
            if case .invalid = drop { NSCursor.operationNotAllowed.set() } else { NSCursor.closedHand.set() }
        }
    }

    private func rows(in section: Section) -> [Row] {
        summary?.rows(section) ?? []
    }

    /// The section a pointer at this height is in: from just above its title down to the next title.
    private func sectionAt(documentY y: CGFloat) -> Section? {
        var found: Section?
        for section in Section.allCases {
            guard let title = sectionHeaders[section] else { continue }
            if found == nil || y >= title.convert(title.bounds, to: documentView).minY - 3 { found = section }
        }
        return found
    }

    /// Where the line goes for a drop into another section: above the row that will follow the dragged one there, else
    /// below the row before it, else under the title of an empty section. The Done line shows none.
    private func crossLine(_ target: Section?, _ status: String, _ spec: MoveSpec) -> (anchor: (key: String, below: Bool)?, underTitle: Bool) {
        guard let target = target, target != .done, let current = list, let source = pressedRow,
              case .moved(let moved) = applyMove(current.items, key: source, spec: spec, status: status) else { return (nil, false) }
        let shown = rows(in: target)
        var next = current
        next.items = moved
        let after = summarize(next).rows(target)
        guard let at = after.firstIndex(where: { $0.key == source }) else { return (nil, false) }
        var end = at + 1
        while end < after.count && after[end].ancestors.contains(source) { end += 1 }
        if end < after.count, shown.contains(where: { $0.key == after[end].key }) { return ((after[end].key, false), false) }
        if at > 0, shown.contains(where: { $0.key == after[at - 1].key }) { return ((after[at - 1].key, true), false) }
        return (nil, shown.isEmpty)
    }

    private func showDropHighlight(_ section: Section, _ status: String) {
        guard let title = sectionHeaders[section] else {
            dropHighlight.isHidden = true
            return
        }
        let frame = title.convert(title.bounds, to: documentView)
        dropHighlight.frame = NSRect(x: detailPadding - 5, y: frame.minY - 2, width: detailWidth - detailPadding * 2 + 10,
                                     height: frame.height + 4)
        dropHint.stringValue = "\u{2192} " + statusLabel(status)
        dropHint.frame = NSRect(x: 4, y: (dropHighlight.bounds.height - 14) / 2, width: dropHighlight.bounds.width - 10, height: 14)
        dropHighlight.isHidden = false
    }

    private func decideDrop(documentY y: CGFloat) -> DropDecision {
        guard y >= 0, y <= documentView.bounds.height else { return .noChange }  // outside the list: cancels quietly
        guard let source = pressedRow, let current = list, let item = current.items.first(where: { $0.key == source }),
              let target = sectionAt(documentY: y) else { return .invalid(.level) }
        func rowUnder(_ rows: [Row]) -> (Row, Bool)? {
            guard let last = rows.last else { return nil }
            var over = last
            for row in rows {
                if let frame = frameInDocument(row.key), y <= frame.maxY + 2.5 {
                    over = row
                    break
                }
            }
            guard let frame = frameInDocument(over.key) else { return nil }
            return (over, y > frame.midY)
        }
        if target != sectionOf(item.status) {  // another section: a status change, placed where the pointer is
            let shown = rows(in: target)
            guard let first = shown.first, let top = frameInDocument(first.key), y >= top.minY - 2,
                  let (over, lowerHalf) = rowUnder(shown) else {
                return crossSectionDrop(current, source: source, into: target, over: nil, lowerHalf: false)
            }
            return crossSectionDrop(current, source: source, into: target, over: over.key, lowerHalf: lowerHalf)
        }
        let rows = rowsInDragSection
        guard let first = rows.first, let top = frameInDocument(first.key) else { return .invalid(.level) }
        if y < top.minY - 2 { return titleDrop(rows: rows, source: source) }  // the section's own title
        guard let (over, lowerHalf) = rowUnder(rows) else { return .invalid(.level) }
        return dropDecision(rows: rows, source: source, over: over.key, lowerHalf: lowerHalf)
    }

    private func rowDragEnded() {
        guard rowDragActive, let source = pressedRow else { return }
        let decision = drop
        cancelRowDrag()
        switch decision {
        case .place(let spec), .change(_, let spec):
            var status: String?
            if case .change(let next, _) = decision { status = next }
            if let hook = moveHook {
                hook(source, spec, status)
                return
            }
            moveInFlight = true
            // Not done inside mouseUp: the optimistic rebuild removes the view that is handling the event.
            DispatchQueue.main.async { [weak self] in self?.performMove(source, spec, status: status) }
        case .invalid(let refusal):
            showToast(refusal.message)  // the rows are already back where they were
        case .noChange:
            break
        }
    }

    /// Ends the press and the drag and clears the feedback; the caller decides whether anything moves.
    private func cancelRowDrag() {
        for row in rowsInDragSection { rowViews[row.key]?.alphaValue = 1 }
        insertionLine.isHidden = true
        dropHighlight.isHidden = true
        pressedRow = nil
        rowDragActive = false
        dragging = false
        drop = .noChange
        NSCursor.arrow.set()
        hideIfPointerOutside()
    }

    private func applyLocal(_ newList: ItemList) {
        list = newList
        summary = summarize(newList)
        hasResult = true
        problem = nil
        updateCollapsed()
        rebuildDetail()
        if detail.isVisible { positionDetail() }
    }

    private func performMove(_ key: String, _ spec: MoveSpec, status: String? = nil) {
        guard let current = list else {
            moveInFlight = false
            return
        }
        switch applyMove(current.items, key: key, spec: spec, status: status) {
        case .moved(let moved):
            var next = current
            next.items = moved
            applyLocal(next)
        case .noChange:
            moveInFlight = false
            return
        case .invalid(let reason):
            moveInFlight = false
            showToast(L("Move failed: {1}", reason))
            return
        }
        perform(api.moveRequest(key: key, spec: spec, status: status)) { [weak self] data, code, error in
            guard let self = self else { return }
            self.moveInFlight = false
            self.refreshGeneration += 1  // drop a list that was fetched before this move finished
            if (200..<300).contains(code) {
                self.refresh()
            } else {
                self.applyLocal(current)  // the rollback
                self.showDetail()
                self.showToast(L("Move failed: {1}", failureText(data, error)))
            }
        }
    }

    // MARK: Menus

    /// A context menu with these items above the quit item.
    private func makeMenu(_ items: [NSMenuItem]) -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        items.forEach { menu.addItem($0) }
        if !items.isEmpty { menu.addItem(.separator()) }
        let quit = NSMenuItem(title: L("Quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        quit.target = NSApp
        menu.addItem(quit)
        return menu
    }

    private func rowMenu(_ key: String) -> NSMenu {
        func item(_ title: String, _ action: Selector) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            item.representedObject = key
            return item
        }
        return makeMenu([item(L("Edit"), #selector(editItemClicked(_:))), item(L("Delete"), #selector(deleteItemClicked(_:)))])
    }

    func menuWillOpen(_ menu: NSMenu) {
        menuOpen = true
        cancelHide()
    }

    func menuDidClose(_ menu: NSMenu) {
        menuOpen = false
        // Later, because a chosen item's action runs after this and may open a form.
        DispatchQueue.main.async { [weak self] in
            if self?.detail.isVisible == true { self?.hideIfPointerOutside() }
        }
    }

    // MARK: Form and confirmation

    @objc private func plusClicked() {
        openForm(TaskFormView(mode: .create, draft: TaskDraft(), heading: L("New task")))
    }

    @objc private func editItemClicked(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        guard let item = items.first(where: { $0.key == key }) else {
            showToast(L("Task not found"))
            return
        }
        let draft = TaskDraft(item)
        openForm(TaskFormView(mode: .edit(key: key, original: draft), draft: draft, heading: L("Edit task"),
                              showsNotes: item.notes != nil))
    }

    @objc private func deleteItemClicked(_ sender: NSMenuItem) {
        guard overlay == nil, let key = sender.representedObject as? String else { return }
        guard let item = items.first(where: { $0.key == key }) else {
            showToast(L("Task not found"))
            return
        }
        let view = DeleteConfirmView(key: key, title: item.title)
        view.onDelete = { [weak self, weak view] in view.map { self?.confirmDelete($0) } }
        view.onCancel = { [weak self] in self?.closeOverlay() }
        showOverlay(view)
    }

    private func showOverlay(_ view: OverlayView) {
        guard let root = detail.contentView else { return }
        overlay = view
        cancelHide()
        view.frame = root.bounds
        view.autoresizingMask = [.width, .height]
        root.addSubview(view, positioned: .below, relativeTo: toast)  // the red message stays on top
        showDetail()
    }

    private func openForm(_ form: TaskFormView) {
        guard overlay == nil else { return }
        form.onSubmit = { [weak self] in self?.submitForm() }
        form.onCancel = { [weak self] in self?.cancelForm() }
        detail.onCancel = form.onCancel
        detail.onReturn = form.onSubmit
        if !options.offscreen { previousApp = NSWorkspace.shared.frontmostApplication }
        showOverlay(form)
        detail.acceptsKey = true
        if !options.offscreen { detail.makeKey() }  // does not activate this app: the other app stays frontmost
        detail.makeFirstResponder(form.nameField)
    }

    private func cancelForm() {
        guard overlay?.busy != true else { return }  // settles within the request timeout
        closeOverlay()
    }

    private func closeOverlay() {
        guard let view = overlay else { return }
        overlay = nil
        let wasKey = detail.isKeyWindow
        detail.makeFirstResponder(nil)
        detail.acceptsKey = false
        detail.onCancel = nil
        detail.onReturn = nil
        view.removeFromSuperview()
        if wasKey && !options.offscreen {
            detail.orderOut(nil)  // the keyboard goes back to the frontmost app only when the panel gives up being key
            orderFront(detail)
        }
        if detail.isVisible { positionDetail() }
        if NSApp.isActive, let previous = previousApp, previous != NSRunningApplication.current {
            previous.activate(options: [])
        }
        previousApp = nil
        hideIfPointerOutside()
    }

    private func submitForm() {
        guard let form = overlay as? TaskFormView, !form.busy else { return }
        form.commitComposition()
        guard form.nameIsValid else { return }
        let draft = form.draft
        let request: URLRequest
        switch form.mode {
        case .create:
            request = api.createRequest(draft)
        case .edit(let key, let original):
            let fields = changedFields(original: original, edited: draft, includeNotes: form.showsNotes)
            if fields.isEmpty {
                closeOverlay()
                return
            }
            request = api.updateRequest(key: key, fields: fields)
        }
        send(request, from: form)
    }

    private func confirmDelete(_ view: DeleteConfirmView) {
        guard !view.busy else { return }
        send(api.deleteRequest(key: view.key), from: view)
    }

    private func send(_ request: URLRequest, from view: OverlayView) {
        view.busy = true
        perform(request) { [weak self] data, code, error in
            self?.requestFinished(view, failure: (200..<300).contains(code) ? nil : failureText(data, error))
        }
    }

    /// A failed save keeps the form and its text; a refused delete closes the question and says why.
    func requestFinished(_ view: OverlayView, failure: String?) {
        view.busy = false
        refreshGeneration += 1  // drop a list that was fetched before this finished
        if let failure = failure {
            if view is TaskFormView {
                showDetail()
                showToast(L("Save failed: {1}", failure))
            } else {
                closeOverlay()
                showDetail()
                showToast(L("Delete failed: {1}", failure))
            }
            return
        }
        closeOverlay()
        refresh()
    }

    // MARK: Row actions

    private func syncActionButtons() {
        for (key, view) in rowViews {
            view.setActionsEnabled(!moveInFlight && !actionRows.contains(key))
        }
    }

    private func actionButtonPressed() {
        cancelHide()
        buttonHeld = true
        refreshGeneration += 1  // a response already on its way must not rebuild the row under the pointer
    }

    private func actionButtonReleased() {
        buttonHeld = false
        hideIfPointerOutside()
    }

    @objc private func actionButtonClicked(_ sender: ActionButton) {
        guard let key = sender.identifier?.rawValue else { return }
        runAction(key, sender.rowAction)
    }

    private func runAction(_ key: String, _ action: RowAction) {
        // The last check is for a button pressed just as a refresh changed the task under it.
        guard !actionRows.contains(key), !moveInFlight, pressedRow == nil,
              let item = items.first(where: { $0.key == key }), rowActions(for: item).contains(action) else { return }
        cancelHide()
        actionRows.insert(key)
        actionsRunning += 1
        refreshGeneration += 1  // drop a list that was fetched before this action
        syncActionButtons()
        perform(api.actionRequest(key: key, action: action)) { [weak self] data, code, error in
            self?.actionFinished(key, failure: (200..<300).contains(code) ? nil : failureText(data, error))
        }
    }

    private func actionFinished(_ key: String, failure: String?) {
        actionsRunning -= 1
        refreshGeneration += 1  // drop a list that was fetched before this action finished
        if let failure = failure {
            actionRows.remove(key)
            syncActionButtons()
            showDetail()
            showToast(L("Action failed: {1}", failure))
        } else {
            actionNeedsRefresh = true  // the row stays disabled until the refresh has replaced it
        }
        guard actionsRunning == 0, actionNeedsRefresh else { return }
        actionNeedsRefresh = false
        refresh { [weak self] in
            guard let self = self, self.actionsRunning == 0 else { return }
            self.actionRows.removeAll()
            self.syncActionButtons()
            self.hideIfPointerOutside()
        }
    }

    private func showToast(_ message: String) {
        toastLabel.stringValue = message
        toast.isHidden = false
        toastTimer?.invalidate()
        let timer = Timer(timeInterval: toastDuration, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.toast.isHidden = true
            self.toastTimer = nil
            if self.detail.isVisible { self.hideIfPointerOutside() }
        }
        RunLoop.main.add(timer, forMode: .common)
        toastTimer = timer
    }

    // MARK: Timers and data

    private func tick() {
        if let parent = parentPID, getppid() != parent {
            exit(0)
        }
        // Safety net for a mouse up that never arrived, so the refresh cannot stay paused.
        if pressedRow != nil, NSEvent.pressedMouseButtons & 1 == 0 { cancelRowDrag() }
        // Safety net for a missed mouseExited, for example after a Space switch.
        if detail.isVisible, !holdsPanel, hideTimer == nil {
            let mouse = NSEvent.mouseLocation
            if !widget.frame.contains(mouse) && !detail.frame.contains(mouse) {
                detail.orderOut(nil)
            }
        }
    }

    private func loadStrings() {
        guard !stringsLoading, !stringsLoaded else { return }
        stringsLoading = true
        perform(api.stringsRequest) { [weak self] data, code, _ in
            guard let self = self else { return }
            self.stringsLoading = false
            guard (200..<300).contains(code), let data = data, let table = parseStrings(data) else { return }
            self.stringsLoaded = true
            if table != stringTable {
                stringTable = table
                self.stringsChanged()
            }
        }
    }

    /// Puts the loaded language on what is already built; forms and menus are built when they open.
    private func stringsChanged() {
        caption.stringValue = L("Tasks")
        plusButton.toolTip = L("New task")
        plusButton.setAccessibilityLabel(L("New task"))
        widgetRoot?.menu = makeMenu([])
        detailRoot?.menu = makeMenu([])
        if !refreshPaused && !rowDragActive {
            rebuildDetail()
            if detail.isVisible { positionDetail() }
        }
    }

    private func refresh(then done: (() -> Void)? = nil) {
        loadStrings()
        if refreshPaused {  // during a drag or a button press, and while a move or an action is in flight
            done?()
            return
        }
        let generation = refreshGeneration
        perform(api.itemsRequest) { [weak self] data, code, _ in
            guard let self = self else { return }
            guard generation == self.refreshGeneration, !self.refreshPaused else {
                done?()
                return
            }
            if (200..<300).contains(code), let data = data, let decoded = decodeItemList(data) {
                self.apply(decoded, problem: nil)
            } else if code == 401 || code == 403 {
                self.apply(nil, problem: L("T-Agent did not accept the widget token"))
            } else {
                self.apply(nil, problem: L("Could not reach T-Agent"))
            }
            done?()
        }
    }

    private var refreshPaused: Bool { pressedRow != nil || moveInFlight || buttonHeld || actionsRunning > 0 }

    private func apply(_ newList: ItemList?, problem newProblem: String?) {
        let result = newList.map(summarize)
        let same = hasResult && result == summary && newProblem == problem
        list = newList  // always: a new sort_order alone changes no row but matters to the next move
        problem = newProblem
        if same { return }
        hasResult = true
        summary = result
        updateCollapsed()
        rebuildDetail()
        if detail.isVisible { positionDetail() }
    }

    // MARK: Offscreen checks and renders

    /// Lays the panel out for this list without showing it or using the network.
    func loadForTest(_ newList: ItemList?, problem: String? = nil, scroll: CGFloat = 0) {
        toast.isHidden = true
        toastTimer?.invalidate()
        toastTimer = nil
        if let newList = newList { applyLocal(newList) } else { apply(nil, problem: problem ?? L("Could not reach T-Agent")) }
        positionDetail()
        detail.contentView?.layoutSubtreeIfNeeded()
        scrollList(to: scroll)
    }

    private func scrollList(to y: CGFloat) {
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    /// Where a drag's pointer ends, in the list's (flipped) coordinates.
    private func debugDocumentY(_ step: DebugDrag) -> CGFloat? {
        let named: [String: Section] = ["@needs": .needs, "@working": .working, "@todo": .todo, "@done": .done]
        if let section = named[step.over.lowercased()] {
            guard let title = sectionHeaders[section] else { return nil }
            return title.convert(title.bounds, to: documentView).midY
        }
        guard let frame = frameInDocument(step.over) else { return nil }
        if step.onHeader {
            guard let title = sectionTitles[step.over] else { return nil }
            return title.convert(title.bounds, to: documentView).midY
        }
        return step.lowerHalf ? frame.maxY - frame.height * 0.25 : frame.minY + frame.height * 0.25
    }

    private func mouseEvent(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: detail.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                           pressure: type == .leftMouseUp ? 0 : 1)!
    }

    /// One whole drag as NSEvents, delivered in-process (the real pointer never moves): the press is hit-tested
    /// through the panel as AppKit would, then the view that took it gets mouseDown, mouseDragged and mouseUp.
    @discardableResult
    func sendMouseDrag(_ step: DebugDrag, stopBeforeRelease: Bool = false) -> MouseDragResult {
        func nothing(_ hit: String) -> MouseDragResult {
            MouseDragResult(hit: hit, decision: .noChange, lineShown: false, toast: "", highlight: "")
        }
        guard let source = rowViews[step.source], let y = debugDocumentY(step), let root = detail.contentView else {
            return nothing("missing")
        }
        let end = documentView.convert(NSPoint(x: 40, y: y), to: nil)
        let start = source.convert(NSPoint(x: 40, y: source.bounds.midY), to: nil)
        let taken = root.hitTest(root.superview?.convert(start, from: nil) ?? start)
        guard let row = taken as? TaskRowView else { return nothing(taken.map { String(describing: type(of: $0)) } ?? "nothing") }
        let hit = rowViews.first { $0.value === row }?.key ?? "unknown row"
        row.mouseDown(with: mouseEvent(.leftMouseDown, start))
        let steps = 8
        for index in 1...steps {
            let t = CGFloat(index) / CGFloat(steps)
            row.mouseDragged(with: mouseEvent(.leftMouseDragged, NSPoint(x: start.x + (end.x - start.x) * t,
                                                                          y: start.y + (end.y - start.y) * t)))
        }
        let decision = drop
        let lineShown = !insertionLine.isHidden
        let highlighted = dropHighlight.isHidden ? "" : dropHint.stringValue
        if stopBeforeRelease {
            return MouseDragResult(hit: hit, decision: decision, lineShown: lineShown, toast: "", highlight: highlighted)
        }
        row.mouseUp(with: mouseEvent(.leftMouseUp, end))
        return MouseDragResult(hit: hit, decision: decision, lineShown: lineShown, toast: toast.isHidden ? "" : toastLabel.stringValue,
                               highlight: highlighted)
    }

    func testOpenCreate() -> TaskFormView? {
        plusButton.performClick(nil)
        return overlay as? TaskFormView
    }

    func testOpenFromRowMenu(_ key: String, _ title: String) -> OverlayView? {
        guard let menu = rowViews[key]?.menu(for: mouseEvent(.rightMouseDown, .zero)) else { return nil }
        let index = menu.indexOfItem(withTitle: title)
        guard index >= 0 else { return nil }
        menu.performActionForItem(at: index)
        return overlay
    }

    func testMenuTitles(_ key: String) -> [String] {
        rowViews[key]?.menu(for: mouseEvent(.rightMouseDown, .zero))?.items.filter { !$0.isSeparatorItem }.map { $0.title } ?? []
    }

    func testPanelMenuTitles() -> [String] {
        detail.contentView?.menu(for: mouseEvent(.rightMouseDown, .zero))?.items.map { $0.title } ?? []
    }

    func testButtonMenuTitles(_ key: String) -> [String] {
        rowViews[key]?.actionButtons.first?.menu(for: mouseEvent(.rightMouseDown, .zero))?.items
            .filter { !$0.isSeparatorItem }.map { $0.title } ?? []
    }

    func testHitAtRow(_ key: String) -> NSView? {
        guard let row = rowViews[key], let root = detail.contentView else { return nil }
        let point = row.convert(NSPoint(x: 40, y: row.bounds.midY), to: nil)
        return root.hitTest(root.superview?.convert(point, from: nil) ?? point)
    }

    func testPressButton(_ key: String, _ action: RowAction) -> Bool {
        guard let button = rowViews[key]?.actionButtons.first(where: { $0.rowAction == action }) else { return false }
        button.performClick(nil)
        return true
    }

    func testButtonsEnabled(_ key: String) -> [Bool] { rowViews[key]?.actionButtons.map { $0.isEnabled } ?? [] }
    func testHasPill(_ key: String) -> Bool { rowViews[key]?.subviews.contains { $0 is EnginePill } ?? false }
    func testHolding() -> Bool { holdsPanel }
    func testApply(_ newList: ItemList?) { apply(newList, problem: newList == nil ? L("Could not reach T-Agent") : nil) }
    func testClose() { closeOverlay() }
    func testStringsChanged() { stringsChanged() }
    func testRefresh() { refresh() }
    var testPanelCanBecomeKey: Bool { detail.canBecomeKey }
    var testToast: String { toast.isHidden ? "" : toastLabel.stringValue }
    var testOverlay: OverlayView? { overlay }
    var testCount: String { countLabel.stringValue }
    var testBadge: String { badge.isHidden ? "" : badgeLabel.stringValue }
    var testCaption: String { caption.stringValue }
    var testOnScreen: Bool { widget.isVisible || detail.isVisible }
    var testLines: [String] {
        stack.arrangedSubviews.compactMap { view in
            if let field = view as? NSTextField { return field.stringValue }
            return (view.subviews.first { $0 is NSTextField } as? NSTextField)?.stringValue
        }
    }
    var testOrder: String {
        guard let summary = summary else { return "(no data)" }
        func keys(_ rows: [Row]) -> String { rows.map { $0.key }.joined(separator: " ") }
        return "needs[\(keys(summary.needs))] working[\(keys(summary.working))] todo[\(keys(summary.todo))] done \(summary.done)"
    }
    var testPlusHit: Bool {
        guard let root = detail.contentView else { return false }
        let point = plusButton.convert(NSPoint(x: 5, y: 5), to: nil)
        return root.hitTest(root.superview?.convert(point, from: nil) ?? point) === plusButton
    }
    var testMenuOpen: Bool {
        get { menuOpen }
        set { if newValue { menuWillOpen(NSMenu()) } else { menuOpen = false } }
    }

    /// Writes the panel (and the collapsed window) offscreen.
    func renderPanel(_ path: String, dark: Bool) -> Bool {
        guard let view = detail.contentView else { return false }
        return renderView(view, to: path, background: dark ? NSColor(white: 0.17, alpha: 1) : NSColor(white: 0.94, alpha: 1))
    }

    func renderWidget(_ path: String, dark: Bool) -> Bool {
        guard let view = widget.contentView else { return false }
        return renderView(view, to: path, background: dark ? NSColor(white: 0.17, alpha: 1) : NSColor(white: 0.94, alpha: 1))
    }

    func setAppearance(dark: Bool) {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        widget.appearance = appearance
        detail.appearance = appearance
    }

    func testDragBegin(_ key: String, over step: DebugDrag) {
        _ = sendMouseDrag(DebugDrag(source: key, over: step.over, lowerHalf: step.lowerHalf, onHeader: step.onHeader),
                          stopBeforeRelease: true)
    }

    func testDragCancel() { cancelRowDrag() }
}

// MARK: - Sample data

func sampleList() -> ItemList {
    func item(_ key: String, _ status: String, _ title: String, order: Double, parent: String = "", custom: String = "",
              result: String = "", reason: String = "", pending: String = "") -> WidgetItem {
        decodeItem(["key": key, "status": status, "title": title, "sort_order": order, "parent_key": parent,
                    "custom_status": custom, "result": result, "attention_reason": reason, "pending": ["kind": "question", "text": pending],
                    "notes": ""])!
    }
    return ItemList(items: [
        item("local:12", "waiting_user", "Deploy the staging build", order: 50, pending: "Allow running npm publish?"),
        item("local:9", "review", "Refactor the login flow", order: 40, result: "Tests pass; ready to merge"),
        item("remote:7:3", "waiting_user", "Plan the database migration", order: 90, reason: "Pick a date for the cut-over"),
        item("local:20", "working", "Build the widget API", order: 60, custom: "Blocked"),
        item("local:21", "working", "Write the route tests", order: 59, parent: "local:20"),
        item("local:22", "working", "Fix the flaky stream test", order: 58, parent: "local:21", result: "Seen twice in CI"),
        item("local:23", "working", "Translate the strings", order: 57),
        item("remote:7:8", "working", "Index the server logs", order: 80, custom: "Step 3 of 5"),
        item("local:30", "todo", "Update the release notes", order: 10),
        item("remote:9:2", "todo", "Back up the studio disk", order: 20),
        item("local:1", "done", "Old task", order: 1), item("local:2", "failed", "Broken task", order: 2),
        item("remote:7:1", "cancelled", "Dropped task", order: 3),
    ], engines: [
        EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0),
        EngineInfo(key: "remote:7", name: "K01", local: false, colorIndex: 3),
        EngineInfo(key: "remote:9", name: "Studio", local: false, colorIndex: 5),
    ], failed: ["K02"])
}

/// --render-sample DIR: renders the widget and the panel in several states offscreen and exits.
func renderSample(_ dir: String) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let controller = WidgetController(api: WidgetAPI(base: nil, token: nil), parentPID: nil, options: options)
    controller.requestHook = { _, _ in }  // never the network
    controller.moveHook = { _, _, _ in }
    var written: [String] = []
    func save(_ name: String, _ ok: Bool) {
        let path = (dir as NSString).appendingPathComponent(name)
        print((ok ? "wrote " : "FAILED ") + path)
        if ok { written.append(path) }
    }
    for dark in [false, true] {
        let suffix = dark ? "dark" : "light"
        controller.setAppearance(dark: dark)
        controller.loadForTest(sampleList())
        save("widget-\(suffix).png", controller.renderWidget((dir as NSString).appendingPathComponent("widget-\(suffix).png"), dark: dark))
        save("panel-\(suffix).png", controller.renderPanel((dir as NSString).appendingPathComponent("panel-\(suffix).png"), dark: dark))
    }
    let dark = false
    controller.setAppearance(dark: dark)
    controller.loadForTest(sampleList())
    controller.testDragBegin("local:30", over: DebugDrag(source: "local:30", over: "@working", lowerHalf: false, onHeader: true))
    save("drag-to-working.png", controller.renderPanel((dir as NSString).appendingPathComponent("drag-to-working.png"), dark: dark))
    controller.testDragCancel()
    controller.loadForTest(sampleList())
    controller.testDragBegin("local:23", over: DebugDrag(source: "local:23", over: "local:20", lowerHalf: false))
    save("drag-reorder.png", controller.renderPanel((dir as NSString).appendingPathComponent("drag-reorder.png"), dark: dark))
    controller.testDragCancel()
    controller.loadForTest(sampleList())
    _ = controller.sendMouseDrag(DebugDrag(source: "local:23", over: "remote:7:8", lowerHalf: false))
    save("drag-refused.png", controller.renderPanel((dir as NSString).appendingPathComponent("drag-refused.png"), dark: dark))
    controller.loadForTest(sampleList())
    if let form = controller.testOpenCreate() {
        form.nameField.stringValue = "Review the widget"
        form.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        save("form-create.png", controller.renderPanel((dir as NSString).appendingPathComponent("form-create.png"), dark: dark))
        controller.testClose()
    }
    if controller.testOpenFromRowMenu("local:20", L("Edit")) != nil {
        save("form-edit.png", controller.renderPanel((dir as NSString).appendingPathComponent("form-edit.png"), dark: dark))
        controller.testClose()
    }
    if controller.testOpenFromRowMenu("local:23", L("Delete")) != nil {
        save("delete-confirm.png", controller.renderPanel((dir as NSString).appendingPathComponent("delete-confirm.png"), dark: dark))
        controller.testClose()
    }
    controller.loadForTest(nil)
    save("unreachable-panel.png", controller.renderPanel((dir as NSString).appendingPathComponent("unreachable-panel.png"), dark: dark))
    save("unreachable-widget.png", controller.renderWidget((dir as NSString).appendingPathComponent("unreachable-widget.png"), dark: dark))
    exit(controller.testOnScreen || written.isEmpty ? 1 : 0)
}

// MARK: - Self test

func runSelfTest() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    var failures = 0
    var passes = 0
    func check(_ name: String, _ ok: Bool) {
        print((ok ? "ok   " : "FAIL ") + name)
        if ok { passes += 1 } else { failures += 1 }
    }
    func it(_ key: String, _ status: String = "working", parent: String = "", order: Double = 0, title: String? = nil,
            custom: String = "", result: String = "", reason: String = "", pending: String = "", notes: String? = "") -> WidgetItem {
        let cut = key.range(of: ":", options: .backwards)!
        return WidgetItem(key: key, engine: String(key[..<cut.lowerBound]), id: String(key[cut.upperBound...]), parentKey: parent,
                          title: title ?? key, status: status, customStatus: custom, result: result, attentionReason: reason,
                          pending: pending, notes: notes, sortOrder: order)
    }
    let twoEngines = [EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0),
                      EngineInfo(key: "remote:7", name: "K01", local: false, colorIndex: 3)]
    func listOf(_ items: [WidgetItem], engines: [EngineInfo] = twoEngines, failed: [String] = []) -> ItemList {
        ItemList(items: items, engines: engines, failed: failed)
    }
    func keys(_ rows: [Row]) -> String { rows.map { $0.key }.joined(separator: " ") }
    func order(_ outcome: MoveOutcome, _ section: Section, engines: [EngineInfo] = twoEngines) -> String {
        switch outcome {
        case .moved(let items): return keys(summarize(listOf(items, engines: engines)).rows(section))
        case .noChange: return "noChange"
        case .invalid(let reason): return "invalid: " + reason
        }
    }

    // Strings: the table, the English fallback and the placeholders.
    stringTable = [:]
    check("strings: a missing key falls back to the English text", L("Needs you") == "Needs you")
    check("strings: placeholders are filled", L("Done: {1}", "3") == "Done: 3" && L("Could not load {1}", "K01") == "Could not load K01")
    let parsed = parseStrings(Data("{\"lang\":\"zh\",\"strings\":{\"Needs you\":\"NY\",\"Done: {1}\":\"D {1}!\",\"Edit\":\"\",\"x\":3}}".utf8))
    check("strings: the answer is read", parsed?["Needs you"] == "NY" && parsed?["x"] == nil && parsed?.count == 3)
    stringTable = parsed ?? [:]
    check("strings: a translated key is used", L("Needs you") == "NY")
    check("strings: a translated placeholder is filled", L("Done: {1}", "4") == "D 4!")
    check("strings: an empty translation falls back", L("Edit") == "Edit")
    check("strings: an unknown key falls back", L("Working") == "Working")
    check("strings: a broken answer is refused", parseStrings(Data("[1,2]".utf8)) == nil && parseStrings(Data("nope".utf8)) == nil)
    stringTable = [:]
    check("strings: status labels go through the table", statusLabel("waiting_user") == "Needs you" && statusLabel("odd") == "odd")

    // Decoding the answer of GET /items.
    let json = """
    {"items":[{"key":"local:12","engine":"local","id":12,"parent_key":null,"title":"A","status":"waiting_user","custom_status":"c",
    "result":"","attention_reason":"why","pending":{"kind":"question","text":"Which one?"},"priority":"high","due_date":null,"sort_order":7.5,
    "updated_at":"x","created_at":"y","notes":"n"},
    {"key":"remote:7:3","engine":"remote:7","id":"3","parent_key":"remote:7:2","title":"B","status":"review","sort_order":2},
    {"title":"no key"}, 5],
    "engines":[{"key":"local","name":"MacBook","local":true,"color_index":0},{"key":"remote:7","name":"K01","local":false,"color_index":3}],
    "failed":["K02"],"host":"mac","updated_at":"z"}
    """
    let decoded = decodeItemList(Data(json.utf8))
    check("decode: items without a key are left out", decoded?.items.count == 2)
    check("decode: a numeric id becomes text", decoded?.items.first?.id == "12")
    check("decode: pending is the text of the object", decoded?.items.first?.pending == "Which one?")
    check("decode: sort_order, notes and the reason", decoded?.items.first?.sortOrder == 7.5 && decoded?.items.first?.notes == "n"
          && decoded?.items.first?.attentionReason == "why" && decoded?.items.first?.parentKey == "")
    check("decode: an item without notes keeps nil", decoded?.items.last?.notes == nil && decoded?.items.last?.parentKey == "remote:7:2")
    check("decode: engines and failed names", decoded?.engines.map { $0.name } == ["MacBook", "K01"] && decoded?.engines.last?.colorIndex == 3
          && decoded?.failed == ["K02"])
    check("decode: a list without items is refused", decodeItemList(Data("{\"error\":\"UNAUTHORIZED\"}".utf8)) == nil)
    check("decode: plain pending text is kept", decodeItem(["key": "local:1", "pending": "Allow?"])?.pending == "Allow?")

    // Grouping, counts and order.
    let grouped = summarize(listOf([
        it("local:1", "waiting_user", order: 1), it("local:2", "review", order: 9), it("local:3", "working"), it("local:4", "todo"),
        it("local:5", "done"), it("local:6", "failed"), it("local:7", "cancelled"), it("local:8", "mystery"),
    ], engines: []))
    check("groups: waiting_user and review are Needs you, waiting_user first", keys(grouped.needs) == "local:1 local:2")
    check("groups: working", keys(grouped.working) == "local:3")
    check("groups: todo and an unknown status are To do", Set(grouped.todo.map { $0.key }) == ["local:4", "local:8"])
    check("groups: done, failed and cancelled are only counted", grouped.done == 3)
    check("groups: unfinished leaves out done, failed and cancelled", grouped.unfinished == 5)
    check("groups: one engine shows no tags", grouped.needs.allSatisfy { $0.tag == nil })

    let engines3 = [EngineInfo(key: "remote:7", name: "K01", local: false, colorIndex: 3),
                    EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0),
                    EngineInfo(key: "remote:9", name: "A very long studio name", local: false, colorIndex: -1)]
    let blocks = summarize(listOf([
        it("remote:9:1", order: 99), it("remote:7:1", order: 50), it("local:1", order: 10), it("local:2", order: 30),
        it("remote:7:2", order: 70), it("remote:5:1", order: 100), it("local:3", order: 30),
    ], engines: engines3))
    check("order: local first, then the order of engines, then unlisted engines", keys(blocks.working)
          == "local:3 local:2 local:1 remote:7:2 remote:7:1 remote:9:1 remote:5:1")
    check("order: equal sort_order goes by the id, highest first", blocks.working.prefix(2).map { $0.key } == ["local:3", "local:2"])
    check("tags: shown with more than one engine, named and coloured", blocks.working.first?.tag == EngineTag(name: "MacBook", colorIndex: 0)
          && blocks.working.first { $0.key == "remote:7:1" }?.tag?.colorIndex == 3)
    check("tags: a long name is shortened, an unknown engine is neutral",
          blocks.working.first { $0.key == "remote:9:1" }?.tag == EngineTag(name: "A very lo\u{2026}", colorIndex: -1)
          && blocks.working.last?.tag == EngineTag(name: "remote:5", colorIndex: -1))
    check("tags: the palette is the page's", tagColors.count == 8 && tagColors[0] == 0x90caf9 && tagColors[7] == 0x9fa8da)

    let needsMix = summarize(listOf([it("local:1", "review", order: 90), it("remote:7:1", "waiting_user", order: 99),
                                     it("local:2", "waiting_user", order: 10), it("remote:7:2", "review", order: 5)]))
    check("order: in Needs you each engine has waiting_user before review", keys(needsMix.needs) == "local:2 local:1 remote:7:1 remote:7:2")
    check("badge counts Needs you", needsMix.needs.count == 4 && needsMix.unfinished == 4)

    let tree = summarize(listOf([
        it("local:1", order: 10), it("local:2", parent: "local:1", order: 50), it("local:3", parent: "local:2", order: 40),
        it("local:4", parent: "local:1", order: 60), it("local:5", order: 30), it("local:6", "todo", parent: "local:1", order: 1),
        it("local:7", parent: "local:99", order: 20), it("remote:7:5", parent: "local:1", order: 1),
    ]))
    check("tree: children under their parent, depth first, siblings by sort_order",
          keys(tree.working) == "local:5 local:7 local:1 local:4 local:2 local:3 remote:7:5")
    check("tree: depth and the child mark", tree.working.map { $0.depth } == [0, 0, 0, 1, 1, 2, 0]
          && tree.working.first { $0.key == "local:3" }?.isChild == true)
    check("tree: a child of another section is a top-level row", tree.todo.first?.isChild == false && tree.todo.first?.siblingKey == "")
    check("tree: an unknown parent is a top-level row", tree.working.first { $0.key == "local:7" }?.siblingKey == "")
    check("tree: ancestors up through the block", tree.working.first { $0.key == "local:3" }?.ancestors == ["local:1", "local:2"])
    let cycle = summarize(listOf([it("local:1", parent: "local:2", order: 2), it("local:2", parent: "local:1", order: 1)]))
    check("tree: a cycle in the data still shows every row once", Set(cycle.working.map { $0.key }) == ["local:1", "local:2"]
          && cycle.working.count == 2)

    let lines = summarize(listOf([
        it("local:1", "waiting_user", custom: "Blocked", result: "r", reason: "a", pending: "p\nq"),
        it("local:2", "waiting_user", result: "r", reason: "a"), it("local:3", "review", result: "done it"),
    ]))
    check("rows: pending comes first on the second line, on one line", lines.needs.first { $0.key == "local:1" }?.detail == "p q")
    check("rows: then the attention reason, then the result", lines.needs.first { $0.key == "local:2" }?.detail == "a"
          && lines.needs.first { $0.key == "local:3" }?.detail == "done it")
    check("rows: the custom status is kept for the suffix", lines.needs.first { $0.key == "local:1" }?.custom == "Blocked")

    // Buttons.
    check("buttons: review gets Confirm and Reject", rowActions(for: it("local:1", "review")).map { $0.label } == ["Confirm", "Reject"])
    check("buttons: waiting_user gets Handled", rowActions(for: it("local:1", "waiting_user")).map { $0.label } == ["Handled"])
    check("buttons: other statuses get none", ["working", "todo", "done", "failed"].allSatisfy { rowActions(for: it("local:1", $0)).isEmpty })
    check("buttons: only Confirm is primary", [RowAction.confirm, .reject, .handled].map { $0.isPrimary } == [true, false, false])
    check("buttons: only Needs you rows carry them", lines.needs.allSatisfy { !$0.actions.isEmpty }
          && summarize(listOf([it("local:1", "working")])).working.allSatisfy { $0.actions.isEmpty })
    check("buttons: a status change alone changes the row",
          summarize(listOf([it("local:1", "review")])) != summarize(listOf([it("local:1", "waiting_user")])))

    // applyMove: the optimistic order.
    let flat = [it("local:1", order: 40), it("local:2", order: 30), it("local:3", order: 20), it("local:4", order: 10)]
    check("move: before", order(applyMove(flat, key: "local:4", spec: .before("local:2")), .working) == "local:1 local:4 local:2 local:3")
    check("move: after", order(applyMove(flat, key: "local:1", spec: .after("local:3")), .working) == "local:2 local:3 local:1 local:4")
    check("move: top", order(applyMove(flat, key: "local:3", spec: .top), .working) == "local:3 local:1 local:2 local:4")
    check("move: bottom", order(applyMove(flat, key: "local:2", spec: .bottom), .working) == "local:1 local:3 local:4 local:2")
    check("move: after the row above is no change", order(applyMove(flat, key: "local:2", spec: .after("local:1")), .working) == "noChange")
    check("move: top of the top is no change", order(applyMove(flat, key: "local:1", spec: .top), .working) == "noChange")
    check("move: next to itself is refused", order(applyMove(flat, key: "local:2", spec: .before("local:2")), .working).hasPrefix("invalid"))
    check("move: an unknown target is refused", order(applyMove(flat, key: "local:2", spec: .before("local:9")), .working) == "invalid: Unknown target")
    check("move: an unknown task is refused", order(applyMove(flat, key: "local:9", spec: .top), .working) == "invalid: Unknown task")
    let mixedEngines = flat + [it("remote:7:1", order: 100)]
    check("move: a target on another machine is refused", order(applyMove(mixedEngines, key: "local:2", spec: .before("remote:7:1")), .working)
          == "invalid: Target is on another machine")
    check("move: top stays inside the engine block", order(applyMove(mixedEngines, key: "local:3", spec: .top), .working)
          == "local:3 local:1 local:2 local:4 remote:7:1")
    let twoGroups = [it("local:1", "waiting_user", order: 5), it("local:2", "review", order: 9)]
    check("move: a target in another server group is refused", order(applyMove(twoGroups, key: "local:1", spec: .before("local:2")), .needs)
          == "invalid: Target is in another group")
    let family = [it("local:1", order: 60), it("local:5", order: 50), it("local:6", parent: "local:5", order: 40),
                  it("local:7", parent: "local:5", order: 30), it("local:8", parent: "local:7", order: 20), it("local:2", order: 10)]
    check("move: a parent takes its children", order(applyMove(family, key: "local:5", spec: .top), .working)
          == "local:5 local:6 local:7 local:8 local:1 local:2")
    check("move: after a parent goes below its children", order(applyMove(family, key: "local:1", spec: .after("local:5")), .working)
          == "local:5 local:6 local:7 local:8 local:1 local:2")
    check("move: a child among its siblings", order(applyMove(family, key: "local:7", spec: .before("local:6")), .working)
          == "local:1 local:5 local:7 local:8 local:6 local:2")
    check("move: a child next to a row of another parent is refused",
          order(applyMove(family, key: "local:6", spec: .before("local:1")), .working) == "invalid: Tasks have different parents")
    let statusBoard = [it("local:1", order: 30), it("local:2", order: 20), it("local:3", "todo", order: 10), it("local:4", "todo", order: 5)]
    check("move: with a status the task lands in its new section", order(applyMove(statusBoard, key: "local:3", spec: .before("local:2"),
                                                                            status: "working"), .working) == "local:1 local:3 local:2")
    check("move: with a status a target in the old section is refused",
          order(applyMove(statusBoard, key: "local:3", spec: .before("local:4"), status: "working"), .working).hasPrefix("invalid"))
    check("move: a status change in place is still a change", order(applyMove(statusBoard, key: "local:1", spec: .top, status: "done"), .working)
          == "local:2")
    check("move: the same status in place is no change", order(applyMove(statusBoard, key: "local:1", spec: .top, status: "working"), .working)
          == "noChange")
    if case .moved(let after) = applyMove(family, key: "local:5", spec: .top, status: "todo") {
        let moved = summarize(listOf(after))
        check("move: a parent that changes section leaves its children as top-level rows",
              keys(moved.todo) == "local:5" && keys(moved.working) == "local:1 local:6 local:7 local:8 local:2"
              && moved.working.first { $0.key == "local:6" }?.siblingKey == "")
    } else {
        check("move: a parent that changes section leaves its children as top-level rows", false)
    }

    // Drop decisions on their own.
    let dropRows = summarize(listOf(family + [it("remote:7:1", order: 99)])).working
    check("drop: top half is before", dropDecision(rows: dropRows, source: "local:2", over: "local:1", lowerHalf: false) == .place(.before("local:1")))
    check("drop: bottom half is after", dropDecision(rows: dropRows, source: "local:1", over: "local:2", lowerHalf: true) == .place(.after("local:2")))
    check("drop: on itself is no change", dropDecision(rows: dropRows, source: "local:1", over: "local:1", lowerHalf: true) == .noChange)
    check("drop: in place is no change", dropDecision(rows: dropRows, source: "local:2", over: "local:8", lowerHalf: true) == .place(.after("local:5"))
          || dropDecision(rows: dropRows, source: "local:2", over: "local:8", lowerHalf: true) == .noChange)
    check("drop: on its own child is no change", dropDecision(rows: dropRows, source: "local:5", over: "local:7", lowerHalf: false) == .noChange)
    check("drop: a child on a top-level row is refused", dropDecision(rows: dropRows, source: "local:6", over: "local:1", lowerHalf: false)
          == .invalid(.level))
    check("drop: on a sibling's child lands after the sibling", dropDecision(rows: dropRows, source: "local:1", over: "local:8", lowerHalf: false)
          == .place(.after("local:5")))
    check("drop: on a row of another machine is refused", dropDecision(rows: dropRows, source: "local:1", over: "remote:7:1", lowerHalf: false)
          == .invalid(.engine))
    let needsRows = summarize(listOf(twoGroups)).needs
    check("drop: on a row of another server group is refused", dropDecision(rows: needsRows, source: "local:1", over: "local:2", lowerHalf: true)
          == .invalid(.group))
    check("drop: the title of its own section is the top of its block", titleDrop(rows: dropRows, source: "local:2") == .place(.top)
          && titleDrop(rows: dropRows, source: "local:1") == .noChange && titleDrop(rows: dropRows, source: "local:6") == .invalid(.level))
    check("drop: the line goes under the whole block", insertionAnchor(rows: dropRows, spec: .after("local:5"))?.key == "local:8")
    check("drop: a plain before line is above", insertionAnchor(rows: dropRows, spec: .before("local:5"))?.below == false)
    check("drop: the refusals have messages", Refusal.engine.message == "Only within the same machine"
          && Refusal.level.message == "Only among tasks at the same level" && Refusal.group.message == "Only among tasks with the same status")
    check("drop: each section title gives its status", statusForDrop(it("local:1", "todo"), into: .needs) == "waiting_user"
          && statusForDrop(it("local:1", "todo"), into: .working) == "working" && statusForDrop(it("local:1"), into: .todo) == "todo"
          && statusForDrop(it("local:1"), into: .done) == "done")
    check("drop: its own section gives no status", statusForDrop(it("local:1", "review"), into: .needs) == nil
          && statusForDrop(it("local:1", "mystery"), into: .todo) == nil)

    // Requests: method, address, headers and body.
    func describe(_ built: URLRequest) -> String {
        let body = built.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? "-"
        let headers = ["Accept", "Content-Type", "Authorization"].map { "\($0)=\(built.value(forHTTPHeaderField: $0) ?? "-")" }.joined(separator: " ")
        return "\(built.httpMethod ?? "") \(built.url?.absoluteString ?? "") \(headers) \(body)"
    }
    let api = WidgetAPI(base: "http://127.0.0.1:3999/", token: " tok123 ")
    let auth = "Accept=application/json Content-Type=application/json Authorization=Bearer tok123"
    let authGet = "Accept=application/json Content-Type=- Authorization=Bearer tok123"
    let base = "http://127.0.0.1:3999/api/attention/widget"
    check("request: list", describe(api.itemsRequest) == "GET \(base)/items \(authGet) -")
    check("request: strings", describe(api.stringsRequest) == "GET \(base)/strings \(authGet) -")
    check("request: no token, no Authorization", WidgetAPI(base: "http://h:1", token: "").itemsRequest.value(forHTTPHeaderField: "Authorization") == nil)
    check("request: a bad base falls back to the default", WidgetAPI(base: "not a url", token: nil).base == defaultBaseURL
          && WidgetAPI(base: nil, token: nil).base == defaultBaseURL && WidgetAPI(base: "ftp://x", token: nil).base == defaultBaseURL)
    check("request: the timeout is 3 s and the cache is skipped", api.itemsRequest.timeoutInterval == 3
          && api.itemsRequest.cachePolicy == .reloadIgnoringLocalCacheData)
    check("request: keys are percent-encoded", WidgetAPI.encodeKey("remote:7:5") == "remote%3A7%3A5" && WidgetAPI.encodeKey("local:12") == "local%3A12"
          && WidgetAPI.encodeKey("a b/\u{00e9}") == "a%20b%2F%C3%A9")
    check("request: create on this machine", describe(api.createRequest(TaskDraft(title: " Write it "))) ==
          "POST \(base)/items \(auth) {\"engine\":\"local\",\"status\":\"todo\",\"title\":\"Write it\"}")
    check("request: create with a status and notes", describe(api.createRequest(TaskDraft(title: "a", status: "working", notes: "n/1"))) ==
          "POST \(base)/items \(auth) {\"engine\":\"local\",\"notes\":\"n/1\",\"status\":\"working\",\"title\":\"a\"}")
    check("request: edit is a PATCH of the fields", describe(api.updateRequest(key: "remote:7:5", fields: ["notes": "", "status": "todo"])) ==
          "PATCH \(base)/items/remote%3A7%3A5 \(auth) {\"notes\":\"\",\"status\":\"todo\"}")
    check("request: delete has no body", describe(api.deleteRequest(key: "local:5")) == "DELETE \(base)/items/local%3A5 \(authGet) -")
    check("request: move before", describe(api.moveRequest(key: "local:5", spec: .before("local:2"), status: nil)) ==
          "POST \(base)/items/local%3A5/move \(auth) {\"before_key\":\"local:2\"}")
    check("request: move after", describe(api.moveRequest(key: "local:5", spec: .after("local:2"), status: nil)) ==
          "POST \(base)/items/local%3A5/move \(auth) {\"after_key\":\"local:2\"}")
    check("request: move to the top with a status", describe(api.moveRequest(key: "local:5", spec: .top, status: "working")) ==
          "POST \(base)/items/local%3A5/move \(auth) {\"position\":\"top\",\"status\":\"working\"}")
    check("request: move to the bottom", describe(api.moveRequest(key: "local:5", spec: .bottom, status: nil)) ==
          "POST \(base)/items/local%3A5/move \(auth) {\"position\":\"bottom\"}")
    check("request: confirm", describe(api.actionRequest(key: "remote:7:5", action: .confirm)) == "POST \(base)/items/remote%3A7%3A5/confirm \(auth) {}")
    check("request: reject", describe(api.actionRequest(key: "remote:7:5", action: .reject)) == "POST \(base)/items/remote%3A7%3A5/reject \(auth) {}")
    check("request: handled", describe(api.actionRequest(key: "local:5", action: .handled)) == "POST \(base)/items/local%3A5/handled \(auth) {}")
    check("errors: the message of the answer", failureText(Data("{\"error\":\"HAS_CHILDREN\",\"message\":\"Has subtasks\"}".utf8), nil) == "Has subtasks")
    check("errors: the code when there is no message", failureText(Data("{\"error\":\"WRONG_STATUS\"}".utf8), nil) == "WRONG_STATUS")
    check("errors: no answer at all", failureText(nil, URLError(.timedOut)) == "Could not reach T-Agent"
          && failureText(Data("<html>".utf8), nil) == "T-Agent refused this change")

    // Edit diffs.
    func fieldKeys(_ a: TaskDraft, _ b: TaskDraft, notes: Bool = true) -> [String] { changedFields(original: a, edited: b, includeNotes: notes).keys.sorted() }
    let original = TaskDraft(title: "n", status: "working", customStatus: "c", notes: "m")
    check("form: nothing changed sends nothing", fieldKeys(original, original).isEmpty)
    check("form: only the name", fieldKeys(original, TaskDraft(title: "x", status: "working", customStatus: "c", notes: "m")) == ["title"])
    check("form: only the status", fieldKeys(original, TaskDraft(title: "n", status: "todo", customStatus: "c", notes: "m")) == ["status"])
    check("form: only the custom status", fieldKeys(original, TaskDraft(title: "n", status: "working", customStatus: "d", notes: "m")) == ["custom_status"])
    check("form: only the notes", fieldKeys(original, TaskDraft(title: "n", status: "working", customStatus: "c", notes: "z")) == ["notes"])
    check("form: several fields", fieldKeys(original, TaskDraft(title: "x", status: "working", customStatus: "", notes: "z"))
          == ["custom_status", "notes", "title"])
    check("form: spaces alone are no change", fieldKeys(original, TaskDraft(title: " n ", status: "working", customStatus: "c ", notes: " m")).isEmpty)
    check("form: clearing is sent as empty", changedFields(original: original, edited: TaskDraft(title: "n", status: "working", notes: "m"))["custom_status"]
          as? String == "")
    check("form: notes the form did not show are never sent", fieldKeys(original, TaskDraft(title: "n", status: "working", customStatus: "c"), notes: false).isEmpty)

    // The panel, in-process and off screen: rows, buttons and hit tests.
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let holder = NSView(frame: NSRect(x: 0, y: 0, width: 296, height: 60))
    let rowView = TaskRowView(frame: holder.bounds)
    let button = ActionButton(.confirm)
    button.translatesAutoresizingMaskIntoConstraints = true
    button.frame = NSRect(x: 240, y: 0, width: 50, height: 20)
    holder.addSubview(rowView)
    rowView.addSubview(button)
    rowView.actionButtons = [button]
    check("hit: a press on a button goes to the button", rowView.hitTest(NSPoint(x: 260, y: 10)) === button)
    check("hit: a press beside the button goes to the row", rowView.hitTest(NSPoint(x: 100, y: 10)) === rowView)
    check("hit: a press outside the row goes nowhere", rowView.hitTest(NSPoint(x: 100, y: 90)) == nil)
    rowView.setActionsEnabled(false)
    check("hit: a disabled button still takes its press", rowView.hitTest(NSPoint(x: 260, y: 10)) === button && !button.isEnabled)
    check("hit: the button takes the first click", button.acceptsFirstMouse(for: nil))

    let mouse = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:1", token: "t"), parentPID: nil, options: options)
    var network: [URLRequest] = []
    var pending: [(Data?, Int) -> Void] = []
    mouse.requestHook = { request, _ in network.append(request) }
    let board = listOf([
        it("local:1", "waiting_user", order: 50), it("local:2", "waiting_user", order: 40), it("local:3", "review", order: 30),
        it("remote:7:1", "waiting_user", order: 90),
        it("local:4", order: 50), it("local:5", parent: "local:4", order: 45), it("local:6", order: 40), it("local:7", order: 30),
        it("remote:7:2", order: 80), it("remote:7:3", order: 70),
        it("local:8", "todo", order: 50), it("local:9", "todo", order: 40), it("local:10", "todo", order: 30),
        it("local:11", "done"), it("local:12", "failed"), it("remote:7:4", "cancelled"),
    ], failed: ["K02"])
    mouse.loadForTest(board)
    check("panel: the order of the board", mouse.testOrder == "needs[local:1 local:2 local:3 remote:7:1] "
          + "working[local:4 local:5 local:6 local:7 remote:7:2 remote:7:3] todo[local:8 local:9 local:10] done 3")
    check("panel: count and badge", mouse.testCount == "13" && mouse.testBadge == "4")
    check("panel: section titles, the Done line and the failed engine", mouse.testLines.contains("\u{1F534} Needs you")
          && mouse.testLines.contains("\u{1F7E2} Working") && mouse.testLines.contains("\u{1F7E1} To do")
          && mouse.testLines.contains("\u{26AA} Done: 3") && mouse.testLines.contains("Could not load K02"))
    check("panel: rows carry an engine tag with two engines", mouse.testHasPill("local:4") && mouse.testHasPill("remote:7:2"))
    check("panel: the caption", mouse.testCaption == "Tasks")
    check("panel: nothing was sent while loading", network.isEmpty)

    var placed: (String, MoveSpec, String?)?
    mouse.moveHook = { placed = ($0, $1, $2) }
    func drag(_ source: String, _ over: String, _ place: String, scroll: CGFloat = 0, list: ItemList? = nil) -> (MouseDragResult, MoveOutcome?) {
        placed = nil
        mouse.loadForTest(list ?? board, scroll: scroll)
        let result = mouse.sendMouseDrag(DebugDrag(source: source, over: over, lowerHalf: place == "bottom", onHeader: place == "header"))
        let outcome = placed.map { applyMove((list ?? board).items, key: $0.0, spec: $0.1, status: $0.2) }
        return (result, outcome)
    }
    func sectionOrder(_ outcome: MoveOutcome?, _ section: Section, engines: [EngineInfo] = twoEngines) -> String {
        guard let outcome = outcome else { return "no move" }
        return order(outcome, section, engines: engines)
    }
    func expectDrag(_ name: String, _ source: String, _ over: String, _ place: String, order expected: String, section: Section,
                    scroll: CGFloat = 0, list: ItemList? = nil) {
        let (result, outcome) = drag(source, over, place, scroll: scroll, list: list)
        let got = sectionOrder(outcome, section)
        let ok = result.hit == source && result.toast.isEmpty && got == expected
        check("mouse: \(name)" + (ok ? "" : " (hit \(result.hit), \(result.decision), toast '\(result.toast)', order '\(got)')"), ok)
    }
    func expectRefused(_ name: String, _ source: String, _ over: String, _ place: String, _ refusal: Refusal) {
        let (result, _) = drag(source, over, place)
        let ok = result.hit == source && result.decision == .invalid(refusal) && placed == nil && result.toast == refusal.message
            && mouse.testOrder.hasPrefix("needs[local:1 local:2 local:3 remote:7:1]")
        check("mouse: \(name)" + (ok ? "" : " (hit \(result.hit), \(result.decision), toast '\(result.toast)')"), ok)
    }
    expectDrag("needs first row down", "local:1", "local:2", "bottom", order: "local:2 local:1 local:3 remote:7:1", section: .needs)
    expectDrag("needs later row up", "local:2", "local:1", "top", order: "local:2 local:1 local:3 remote:7:1", section: .needs)
    expectDrag("needs row dropped on the section title", "local:2", "local:1", "header", order: "local:2 local:1 local:3 remote:7:1", section: .needs)
    expectRefused("needs row onto a review row is refused", "local:1", "local:3", "top", .group)
    expectRefused("a row onto another machine's row is refused and rolled back", "local:2", "remote:7:1", "top", .engine)
    expectDrag("working parent down, its child in tow", "local:4", "local:7", "bottom",
               order: "local:6 local:7 local:4 local:5 remote:7:2 remote:7:3", section: .working)
    expectDrag("working later row to the top slot", "local:7", "local:4", "top",
               order: "local:7 local:4 local:5 local:6 remote:7:2 remote:7:3", section: .working)
    expectDrag("working row dropped on the section title", "local:6", "local:4", "header",
               order: "local:6 local:4 local:5 local:7 remote:7:2 remote:7:3", section: .working)
    expectDrag("another machine's row reorders inside its own block", "remote:7:3", "remote:7:2", "top",
               order: "local:4 local:5 local:6 local:7 remote:7:3 remote:7:2", section: .working)
    expectDrag("over a sibling's child lands after that sibling", "local:7", "local:5", "top",
               order: "local:4 local:5 local:7 local:6 remote:7:2 remote:7:3", section: .working)
    let (childAway, _) = drag("local:5", "local:6", "bottom")
    check("mouse: a child dropped among top-level rows is refused", childAway.decision == .invalid(.level) && placed == nil
          && childAway.toast == Refusal.level.message)
    expectDrag("todo later row up", "local:10", "local:8", "top", order: "local:10 local:8 local:9", section: .todo)
    let (noOp, noOpOutcome) = drag("local:8", "local:8", "top")
    check("mouse: dropping a row on itself does nothing", noOp.decision == .noChange && noOp.toast.isEmpty && noOpOutcome == nil)
    let (pressOnText, _) = drag("local:3", "local:3", "top")
    check("mouse: a row with buttons still takes a press on its text", pressOnText.hit == "local:3")
    let tall = listOf(board.items + (40...75).map { it("local:\($0)", "todo", order: Double(-$0)) })
    let tallTail = (40...75).map { "local:\($0)" }.joined(separator: " ")
    expectDrag("scrolled list: a todo row down", "local:8", "local:9", "bottom", order: "local:9 local:8 local:10 " + tallTail,
               section: .todo, scroll: 200, list: tall)
    expectDrag("scrolled list: a todo row to the top slot", "local:10", "local:8", "top", order: "local:10 local:8 local:9 " + tallTail,
               section: .todo, scroll: 200, list: tall)

    // Dragging into another section changes the status.
    func status(_ outcome: MoveOutcome?, _ key: String) -> String {
        guard case .moved(let items)? = outcome, let item = items.first(where: { $0.key == key }) else { return "no move" }
        return item.status
    }
    func expectCross(_ name: String, _ source: String, _ over: String, _ place: String, status expected: String, hint: String,
                     order expected2: String, section: Section, list: ItemList? = nil) {
        let (result, outcome) = drag(source, over, place, list: list)
        let got = sectionOrder(outcome, section)
        let sent = placed?.2 ?? "none"
        let ok = result.hit == source && result.toast.isEmpty && got == expected2 && status(outcome, source) == expected
            && result.highlight == hint && sent == expected
        check("mouse cross-section: \(name)" + (ok ? "" : " (hit \(result.hit), \(result.decision), sent \(sent), status '\(status(outcome, source))', "
            + "highlight '\(result.highlight)', toast '\(result.toast)', order '\(got)')"), ok)
    }
    expectCross("todo row onto the Working title", "local:8", "@working", "header", status: "working", hint: "\u{2192} Working",
                order: "local:8 local:4 local:5 local:6 local:7 remote:7:2 remote:7:3", section: .working)
    if let (row, _) = Optional(drag("local:8", "@working", "header")) {
        check("mouse cross-section: the title drop is position top with the status", placed.map { $0.1 == .top && $0.2 == "working" } == true
              && row.lineShown)
    }
    expectCross("todo row between working rows", "local:9", "local:6", "top", status: "working", hint: "\u{2192} Working",
                order: "local:4 local:5 local:9 local:6 local:7 remote:7:2 remote:7:3", section: .working)
    let (crossEngine, _) = drag("local:9", "remote:7:2", "top")
    check("mouse cross-section: onto another machine's row is refused with a message", crossEngine.decision == .invalid(.engine)
          && placed == nil && crossEngine.toast == Refusal.engine.message)
    expectCross("working row onto the Needs you title", "local:6", "@needs", "header", status: "waiting_user", hint: "\u{2192} Needs you",
                order: "local:6 local:1 local:2 local:3 remote:7:1", section: .needs)
    let (ontoReview, _) = drag("local:6", "local:3", "top")
    check("mouse cross-section: onto a review row is refused", ontoReview.decision == .invalid(.group) && placed == nil)
    expectCross("working parent onto the Done line", "local:4", "@done", "top", status: "done", hint: "\u{2192} Done",
                order: "local:5 local:6 local:7 remote:7:2 remote:7:3", section: .working)
    expectCross("needs row onto the To do title", "local:1", "@todo", "header", status: "todo", hint: "\u{2192} To do",
                order: "local:1 local:8 local:9 local:10", section: .todo)
    expectCross("another machine's row goes to the top of its own block", "remote:7:1", "@working", "header", status: "working",
                hint: "\u{2192} Working", order: "local:4 local:5 local:6 local:7 remote:7:1 remote:7:2 remote:7:3", section: .working)
    expectCross("review row onto the Working title", "local:3", "@working", "header", status: "working", hint: "\u{2192} Working",
                order: "local:3 local:4 local:5 local:6 local:7 remote:7:2 remote:7:3", section: .working)
    let (ownTitle, _) = drag("local:7", "@working", "header")
    check("mouse: the own section's title is a plain reorder", ownTitle.decision == .place(.top) && ownTitle.highlight.isEmpty)
    let noTodo = listOf(board.items.filter { $0.status != "todo" })
    expectCross("working row into an empty To do", "local:6", "@todo", "header", status: "todo", hint: "\u{2192} To do",
                order: "local:6", section: .todo, list: noTodo)
    let (emptyLine, _) = drag("local:6", "@todo", "header", list: noTodo)
    check("mouse cross-section: an empty section shows the line under its title", emptyLine.lineShown)
    let (childOut, childOutcome) = drag("local:5", "@todo", "header")
    check("mouse cross-section: a child leaves its parent's section as a top-level row",
          childOut.decision == .change("todo", .top) && sectionOrder(childOutcome, .todo) == "local:5 local:8 local:9 local:10")
    check("mouse: no drag reached the network", network.isEmpty)

    // A real move through the controller: the optimistic order, the request, and the rollback with its message.
    mouse.moveHook = nil
    var answers: [String: (Data?, Int)] = [:]
    mouse.requestHook = { request, answer in
        network.append(request)
        if let known = answers[(request.httpMethod ?? "") + " " + (request.url?.path ?? "")] {
            answer(known.0, known.1)
        } else {
            pending.append(answer)
        }
    }
    mouse.loadForTest(board)
    network = []
    answers["POST /api/attention/widget/items/local:7/move"] = (Data("{\"error\":\"VALIDATION_FAILED\",\"message\":\"Target is in another group\"}".utf8), 400)
    _ = mouse.sendMouseDrag(DebugDrag(source: "local:7", over: "local:4", lowerHalf: false))
    let deadline = Date().addingTimeInterval(1)  // the move starts on the main queue after mouseUp
    while network.isEmpty && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
    check("move: the request is sent with the key and the place", network.count == 1 && describe(network[0])
          == "POST http://127.0.0.1:1/api/attention/widget/items/local%3A7/move Accept=application/json Content-Type=application/json "
          + "Authorization=Bearer t {\"before_key\":\"local:4\"}")
    check("move: a refused move rolls back and says why", mouse.testOrder.contains("working[local:4 local:5 local:6 local:7 ")
          && mouse.testToast == "Move failed: Target is in another group")

    // Buttons: the request, the double-click guard, the failure message and the refresh after success.
    mouse.loadForTest(board)
    network = []
    answers = [:]
    check("action: Handled sends its request", mouse.testPressButton("local:1", .handled) && network.count == 1
          && network[0].url?.absoluteString == "http://127.0.0.1:1/api/attention/widget/items/local%3A1/handled")
    check("action: the row's buttons are off while it is out", mouse.testButtonsEnabled("local:1") == [false] && mouse.testHolding())
    _ = mouse.testPressButton("local:1", .handled)
    check("action: a second press sends nothing", network.count == 1)
    if let answer = pending.popLast() { answer(Data("{\"error\":\"WRONG_STATUS\",\"message\":\"Not waiting\"}".utf8), 409) }
    check("action: a late refusal gives the buttons back and its message holds the panel", mouse.testToast == "Action failed: Not waiting"
          && mouse.testButtonsEnabled("local:1") == [true] && mouse.testHolding())
    mouse.loadForTest(board)
    network = []
    answers["POST /api/attention/widget/items/local:3/confirm"] = (Data("{\"error\":\"WRONG_STATUS\",\"message\":\"Not in review\"}".utf8), 409)
    _ = mouse.testPressButton("local:3", .confirm)
    check("action: a refused action shows the message and gives the buttons back", mouse.testToast == "Action failed: Not in review"
          && mouse.testButtonsEnabled("local:3") == [true, true])
    mouse.loadForTest(board)
    network = []
    var afterConfirm = board
    afterConfirm.items.removeAll { $0.key == "local:3" }
    answers["POST /api/attention/widget/items/local:3/reject"] = (Data("{}".utf8), 200)
    let refreshedItems: [[String: Any]] = afterConfirm.items.map { item in
        ["key": item.key, "status": item.status, "title": item.title, "sort_order": item.sortOrder, "parent_key": item.parentKey]
    }
    let refreshedEngines: [[String: Any]] = [["key": "local", "name": "MacBook", "local": true, "color_index": 0],
                                             ["key": "remote:7", "name": "K01", "color_index": 3]]
    let refreshed: [String: Any] = ["items": refreshedItems, "engines": refreshedEngines, "failed": ["K02"]]
    answers["GET /api/attention/widget/items"] = (try? JSONSerialization.data(withJSONObject: refreshed), 200)
    answers["GET /api/attention/widget/strings"] = (Data("{\"lang\":\"en\",\"strings\":{}}".utf8), 200)
    _ = mouse.testPressButton("local:3", .reject)
    check("action: success refreshes the list at once", network.map { $0.url?.path ?? "" }.contains("/api/attention/widget/items")
          && !mouse.testOrder.contains("local:3") && mouse.testCount == "12" && mouse.testBadge == "3")
    check("strings: loaded once with the token", network.filter { $0.url?.path == "/api/attention/widget/strings" }.count == 1
          && network.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer t" })

    // Unreachable, the token refused, and the language table.
    mouse.testApply(nil)
    check("unreachable: the count is a dash", mouse.testCount == "\u{2013}" && mouse.testBadge == "")
    check("unreachable: the panel says so", mouse.testLines == ["Could not reach T-Agent"])
    answers["GET /api/attention/widget/items"] = (Data("{\"error\":\"UNAUTHORIZED\"}".utf8), 401)
    mouse.testRefresh()
    check("unreachable: a refused token says so", mouse.testLines == ["T-Agent did not accept the widget token"] && mouse.testCount == "\u{2013}")
    mouse.loadForTest(board)
    stringTable = ["Needs you": "NY", "Done: {1}": "D{1}", "Tasks": "TK", "Quit": "Q"]
    mouse.testStringsChanged()
    check("strings: the panel uses the loaded table", mouse.testLines.contains("\u{1F534} NY") && mouse.testLines.contains("\u{26AA} D3")
          && mouse.testCaption == "TK" && mouse.testPanelMenuTitles() == ["Q"])
    stringTable = [:]
    mouse.testStringsChanged()
    check("strings: the English text comes back without a table", mouse.testLines.contains("\u{1F534} Needs you") && mouse.testCaption == "Tasks")
    let empty = WidgetController(api: WidgetAPI(base: nil, token: nil), parentPID: nil, options: options)
    empty.requestHook = { _, _ in }
    empty.loadForTest(listOf([it("local:1", "todo")], engines: [EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0)]))
    check("panel: an empty Needs you says so", empty.testLines.contains("Nothing needs you") && empty.testLines.contains("None"))
    check("panel: one engine shows no tag", !empty.testHasPill("local:1") && empty.testBadge == "")

    // Menus, the form and the delete question, off screen and without keyboard focus.
    let crud = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:1", token: "t"), parentPID: nil, options: options)
    var sent: [URLRequest] = []
    var crudAnswer: (Data?, Int)?
    crud.requestHook = { request, answer in
        sent.append(request)
        if request.httpMethod != "GET", let known = crudAnswer { answer(known.0, known.1) }
    }
    let crudBoard = listOf([it("local:1"), it("local:2", parent: "local:1"), it("local:3", "review"), it("local:4", "todo"),
                            it("local:5", "todo", title: "Name", custom: "Custom", notes: "Old notes"),
                            it("local:6", "todo", title: "No notes", notes: nil)])
    crud.loadForTest(crudBoard)
    check("menu: a row has Edit, Delete and Quit", crud.testMenuTitles("local:4") == ["Edit", "Delete", "Quit"])
    check("menu: an action button opens the row's menu", crud.testButtonMenuTitles("local:3") == ["Edit", "Delete", "Quit"])
    check("menu: off a row only Quit", crud.testPanelMenuTitles() == ["Quit"])
    check("menu: the row takes the right click", crud.testHitAtRow("local:4") is TaskRowView)
    check("menu: the + button takes its click", crud.testPlusHit)
    check("the panel takes no keyboard without a form", !crud.testPanelCanBecomeKey)
    crud.testMenuOpen = true
    check("an open menu holds the panel", crud.testHolding())
    crud.testMenuOpen = false

    guard let create = crud.testOpenCreate() else {
        check("+ opens a form", false)
        exit(1)
    }
    check("form: + opens a form that holds the panel", crud.testHolding())
    check("form: its window can become key", crud.testPanelCanBecomeKey)
    check("form: create defaults to To do", create.selectedStatus == "todo" && create.statusPopup.titleOfSelectedItem == "To do")
    check("form: the status menu lists every status by its label", create.statusPopup.itemTitles
          == ["To do", "Working", "Needs you", "Review", "Done", "Failed", "Cancelled"])
    check("form: create has no custom status field", create.customField.superview == nil && create.notesField.superview != nil)
    check("form: the name field holds the focus", create.nameField.currentEditor() != nil)
    let noCommand = NSTextView()
    func press(_ form: TaskFormView, _ selector: Selector, in view: NSTextView? = nil) -> Bool {
        form.control(form.nameField, textView: view ?? noCommand, doCommandBy: selector)
    }
    check("form: Return with no name is refused", press(create, #selector(NSResponder.insertNewline(_:))) && sent.isEmpty && crud.testOverlay === create)
    check("form: save starts disabled", !create.saveButton.isEnabled)
    guard let editor = create.nameField.currentEditor() as? NSTextView else {
        check("form: the name field has an editor", false)
        exit(1)
    }
    let nowhere = NSRange(location: NSNotFound, length: 0)
    let typed = "\u{5468}\u{62a5}"
    editor.insertText(typed, replacementRange: nowhere)
    check("form: typing reaches the field", create.draft.title == typed && create.saveButton.isEnabled)
    editor.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0), replacementRange: nowhere)
    check("form: a composition is held by the field editor", editor.hasMarkedText() && editor.string == typed + "ni")
    check("form: Return during a composition stays with the input method",
          !press(create, #selector(NSResponder.insertNewline(_:)), in: editor) && sent.isEmpty)
    check("form: Esc during a composition stays with the input method",
          !press(create, #selector(NSResponder.cancelOperation(_:)), in: editor) && crud.testOverlay === create)
    crud.testApply(listOf(crudBoard.items + [it("local:9", "todo")]))
    check("form: a refresh leaves the composition alone", crud.testOverlay === create && editor.hasMarkedText() && editor.string == typed + "ni")
    editor.insertText("\u{4f60}", replacementRange: editor.markedRange())
    check("form: the composition commits into the field", !editor.hasMarkedText() && create.draft.title == typed + "\u{4f60}")
    create.selectStatus("working")
    check("form: Return submits a valid form", press(create, #selector(NSResponder.insertNewline(_:))) && sent.count == 1
          && describe(sent[0]) == "POST http://127.0.0.1:1/api/attention/widget/items Accept=application/json Content-Type=application/json "
          + "Authorization=Bearer t {\"engine\":\"local\",\"status\":\"working\",\"title\":\"\(typed)\u{4f60}\"}")
    check("form: a save in flight disables save", create.busy && !create.saveButton.isEnabled)
    check("form: a second Return while saving sends nothing", press(create, #selector(NSResponder.insertNewline(_:))) && sent.count == 1)
    check("form: Esc while saving keeps the form", press(create, #selector(NSResponder.cancelOperation(_:))) && crud.testOverlay === create)
    crud.requestFinished(create, failure: "boom")
    check("form: a failed save keeps the form and its text", crud.testOverlay === create && create.draft.title == typed + "\u{4f60}"
          && !create.busy && create.saveButton.isEnabled)
    check("form: a failed save shows the error", crud.testToast == "Save failed: boom")
    check("form: Esc cancels", press(create, #selector(NSResponder.cancelOperation(_:))) && crud.testOverlay == nil)
    check("form: closing gives up the keyboard", !crud.testPanelCanBecomeKey)
    sent = []

    crud.loadForTest(crudBoard)
    guard let edit = crud.testOpenFromRowMenu("local:5", "Edit") as? TaskFormView else {
        check("edit: opens a form", false)
        exit(1)
    }
    check("edit: the form is prefilled", edit.draft == TaskDraft(title: "Name", status: "todo", customStatus: "Custom", notes: "Old notes"))
    check("edit: the custom status field is shown", edit.customField.superview != nil)
    _ = press(edit, #selector(NSResponder.insertNewline(_:)))
    check("edit: an unchanged edit closes without a request", crud.testOverlay == nil && sent.isEmpty)
    guard let edit2 = crud.testOpenFromRowMenu("local:5", "Edit") as? TaskFormView else {
        check("edit: reopens", false)
        exit(1)
    }
    edit2.notesField.stringValue = "New notes"
    edit2.selectStatus("working")
    _ = press(edit2, #selector(NSResponder.insertNewline(_:)))
    check("edit: only the changed fields are sent", sent.count == 1 && describe(sent[0])
          == "PATCH http://127.0.0.1:1/api/attention/widget/items/local%3A5 Accept=application/json Content-Type=application/json "
          + "Authorization=Bearer t {\"notes\":\"New notes\",\"status\":\"working\"}")
    crud.requestFinished(edit2, failure: "bad")
    check("edit: a failed edit keeps the form", crud.testOverlay === edit2 && edit2.draft.notes == "New notes")
    crud.testClose()
    sent = []
    guard let edit3 = crud.testOpenFromRowMenu("local:6", "Edit") as? TaskFormView else {
        check("edit: a task without notes opens a form", false)
        exit(1)
    }
    check("edit: without notes in the answer the notes field is left out", edit3.notesField.superview == nil && !edit3.showsNotes)
    edit3.customField.stringValue = "Waiting"
    _ = press(edit3, #selector(NSResponder.insertNewline(_:)))
    check("edit: and notes are never sent", sent.count == 1 && String(data: sent[0].httpBody ?? Data(), encoding: .utf8) == "{\"custom_status\":\"Waiting\"}")
    crud.testClose()
    sent = []

    guard let confirm = crud.testOpenFromRowMenu("local:5", "Delete") as? DeleteConfirmView else {
        check("delete: opens a question", false)
        exit(1)
    }
    check("delete: the question names the task", confirm.message.stringValue == "Delete this task?\nName")
    check("delete: the question holds the panel but takes no keyboard", crud.testHolding() && !crud.testPanelCanBecomeKey)
    check("delete: nothing is sent before it is answered", sent.isEmpty)
    confirm.cancelButton.performClick(nil)
    check("delete: Cancel closes the question with no request", crud.testOverlay == nil && sent.isEmpty)
    guard let confirm2 = crud.testOpenFromRowMenu("local:1", "Delete") as? DeleteConfirmView else {
        check("delete: reopens", false)
        exit(1)
    }
    crudAnswer = (Data("{\"error\":\"HAS_CHILDREN\",\"message\":\"Task has subtasks\",\"children\":[2]}".utf8), 409)
    confirm2.deleteButton.performClick(nil)
    check("delete: Delete sends DELETE", sent.count == 1 && describe(sent[0])
          == "DELETE http://127.0.0.1:1/api/attention/widget/items/local%3A1 Accept=application/json Content-Type=- Authorization=Bearer t -")
    check("delete: a 409 closes the question and shows the reason", crud.testOverlay == nil && crud.testToast == "Delete failed: Task has subtasks")
    crudAnswer = (nil, 204)
    sent = []
    if let confirm3 = crud.testOpenFromRowMenu("local:4", "Delete") as? DeleteConfirmView {
        confirm3.deleteButton.performClick(nil)
        check("delete: a 204 closes the question and refreshes", crud.testOverlay == nil
              && sent.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }.contains("GET /api/attention/widget/items"))
    } else {
        check("delete: a 204 closes the question and refreshes", false)
    }

    check("no window was put on screen", !mouse.testOnScreen && !crud.testOnScreen && !empty.testOnScreen)
    print("\(passes) passed, \(failures) failed")
    exit(failures == 0 ? 0 : 1)
}

// MARK: - Entry point

func argumentValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

if CommandLine.arguments.contains("--self-test") {
    runSelfTest()
}
if let dir = argumentValue("--render-sample") {
    renderSample(dir)
}

let environment = ProcessInfo.processInfo.environment
var options = WidgetOptions()
options.persistPosition = !CommandLine.arguments.contains("--no-persist")

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = WidgetController(api: WidgetAPI(base: environment["TA_WIDGET_URL"], token: environment["TA_WIDGET_TOKEN"]),
                                  parentPID: argumentValue("--parent-pid").flatMap { pid_t($0) }, options: options)
app.delegate = controller
app.run()
