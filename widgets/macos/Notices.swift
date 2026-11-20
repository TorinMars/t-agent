// T-Attention desktop widget: notices, the bubble placement, sections, order and rows. See main.swift for the overview and the build.
import AppKit

// MARK: - Notices

let noticeDefaultSeconds: Double = 8
let noticeMaxSeconds: Double = 3600
let noticeRetryDelay: TimeInterval = 300  // after a 404 (an older server), the next try
let noticeMaxWaiting = 3  // more waiting than this: only the newest is shown, with "+N more"
let noticeTextLimit = 600

/// One notice of GET /api/attention/widget/notices, shown in the bubble beside the window.
struct WidgetNotice: Equatable {
    var seq: Int = 0  // 0 when the answer has none
    var kind: String = "item"  // item, direct or test
    var title: String = ""  // one line
    var text: String = ""  // line breaks kept, blank lines dropped
    var from: String = ""
    var status: String = ""
    var key: String = ""
    var target: String = ""  // an http(s) address noticeTarget accepts, else empty
    var seconds: Double = noticeDefaultSeconds  // 0: until it is closed
}

/// The address a notice may open: an absolute http(s) address with a host and without a user name or password
/// (taskLink), never a page path or another scheme. Nil for anything else.
func noticeTarget(_ value: String) -> String? {
    guard let link = taskLink(value), !link.hasPrefix("/") else { return nil }
    return link
}

/// How long a notice stays: `seconds` when it is a number from 0 (until closed) up to noticeMaxSeconds, the default
/// for anything else.
func noticeSeconds(_ value: Any?) -> Double {
    guard let number = looseNumber(value), number.isFinite, number >= 0 else { return noticeDefaultSeconds }
    return min(number, noticeMaxSeconds)
}

/// A notice of the answer; nil when it has neither a title nor a text. A text without a title becomes the title.
func decodeNotice(_ object: [String: Any]) -> WidgetNotice? {
    var title = (looseText(object["title"]) ?? "").oneLine
    var text = (looseText(object["text"]) ?? "").components(separatedBy: .newlines).map { $0.trimmed }.filter { !$0.isEmpty }
        .joined(separator: "\n")
    if title.isEmpty {
        title = text.oneLine
        text = ""
    }
    guard !title.isEmpty else { return nil }
    let seq = looseNumber(object["seq"]).flatMap { $0.isFinite && $0 >= 0 && $0 < 1e15 ? Int($0) : nil } ?? 0
    let kind = (looseText(object["kind"]) ?? "").trimmed.lowercased()
    return WidgetNotice(seq: seq, kind: kind.isEmpty ? "item" : kind,
                        title: String(title.prefix(noticeTextLimit)), text: String(text.prefix(noticeTextLimit)),
                        from: (looseText(object["from"]) ?? "").oneLine,
                        status: (looseText(object["status"]) ?? "").trimmed,
                        key: (looseText(object["key"]) ?? "").trimmed,
                        target: (object["target"] as? String).flatMap(noticeTarget) ?? "",
                        seconds: noticeSeconds(object["seconds"]))
}

/// The answer of GET /notices: the latest seq of the server and its notices, oldest first; nil when it is not one.
func decodeNotices(_ data: Data) -> (seq: Int?, notices: [WidgetNotice])? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let notices = object["notices"] as? [Any] else { return nil }
    let seq = looseNumber(object["seq"]).flatMap { $0.isFinite && $0 >= 0 && $0 < 1e15 ? Int($0) : nil }
    return (seq, notices.compactMap { ($0 as? [String: Any]).flatMap(decodeNotice) })
}

/// The colour of a notice's dot by its status; a direct or test message without a status is neutral. The notices the
/// window makes of a scheduled task's firing (Part G) by their kind.
func noticeTone(_ notice: WidgetNotice) -> String {
    switch notice.kind {
    case "scheduled", "prompt_sent": return "blue"
    case "prompt_failed": return "orange"
    case "script_failed": return "red"
    default: break
    }
    switch notice.status {
    case "waiting_user": return "orange"
    case "review": return "blue"
    case "done": return "green"
    case "failed": return "red"
    case "working": return "teal"
    default: return "neutral"
    }
}

func toneColor(_ tone: String) -> NSColor {
    switch tone {
    case "orange": return .systemOrange
    case "blue": return .systemBlue
    case "green": return .systemGreen
    case "red": return .systemRed
    case "teal": return .systemTeal
    default: return .systemGray
    }
}

/// The polling of GET /notices: the first call has no `after` (the server answers the last 60 s), every later one asks
/// for what came after the last seq seen. One request at a time; a 404 (an older server) pauses it for
/// noticeRetryDelay; any other failure is tried again on the next tick.
struct NoticePoll {
    var lastSeq: Int?
    var pausedUntil: Date?
    var inFlight = false

    func due(_ now: Date) -> Bool { !inFlight && (pausedUntil.map { now >= $0 } ?? true) }

    /// The notices of an answer that are new; updates the last seq. A seq lower than the last one means the server
    /// started again (it then answers as for a first call): its notices are all new and polling goes on from its seq.
    mutating func finished(code: Int, data: Data?, now: Date) -> [WidgetNotice] {
        inFlight = false
        if code == 404 {
            pausedUntil = now.addingTimeInterval(noticeRetryDelay)
            return []
        }
        guard (200..<300).contains(code), let data = data, let answer = decodeNotices(data) else { return [] }
        pausedUntil = nil
        if let last = lastSeq, let seq = answer.seq, seq < last {
            lastSeq = seq
            return answer.notices.filter { $0.seq <= seq }
        }
        let fresh = answer.notices.filter { notice in lastSeq.map { notice.seq == 0 || notice.seq > $0 } ?? true }
        let highest = ([answer.seq ?? 0, lastSeq ?? 0] + fresh.map { $0.seq }).max() ?? 0
        lastSeq = highest
        return fresh
    }
}

/// The notices of the bubble: one shown at a time, the others wait, oldest first. A new notice of a task that is
/// already waiting replaces it. When more than noticeMaxWaiting wait as the next one is taken, only the newest is
/// shown and the others are counted on it ("+N more").
struct NoticeQueue {
    private(set) var current: WidgetNotice?
    private(set) var more = 0
    private(set) var waiting: [WidgetNotice] = []

    mutating func add(_ notices: [WidgetNotice]) {
        for notice in notices {
            if !notice.key.isEmpty { waiting.removeAll { $0.key == notice.key } }
            waiting.append(notice)
        }
    }

    /// Closes the current notice and takes the next one; nil when none is waiting.
    @discardableResult
    mutating func advance() -> WidgetNotice? {
        current = nil
        more = 0
        guard !waiting.isEmpty else { return nil }
        if waiting.count > noticeMaxWaiting {
            more = waiting.count - 1
            current = waiting.removeLast()
            waiting = []
        } else {
            current = waiting.removeFirst()
        }
        return current
    }

    mutating func clear() {
        current = nil
        more = 0
        waiting = []
    }
}

let bubbleWidth: CGFloat = 280
let bubbleSlide: CGFloat = 16  // how far the bubble slides out, toward the middle of the screen
let bubbleAnimation: TimeInterval = 0.2

/// Where the bubble goes: beside `anchor` (the window, or the window and its open panel), on the side toward the
/// middle of the screen (left of a window in the right half, else right), its top level with the window's top, and
/// inside `visible` with screenMargin to spare.
func bubbleFrame(size: NSSize, pill: NSRect, anchor: NSRect, visible: NSRect) -> (frame: NSRect, toLeft: Bool) {
    let toLeft = pill.midX > visible.midX
    var x = toLeft ? anchor.minX - panelGap - size.width : anchor.maxX + panelGap
    x = max(visible.minX + screenMargin, min(x, visible.maxX - screenMargin - size.width))
    var y = pill.maxY - size.height
    y = max(visible.minY + screenMargin, min(y, visible.maxY - screenMargin - size.height))
    return (NSRect(x: x, y: y, width: size.width, height: size.height), toLeft)
}

/// Where the slide starts: bubbleSlide back toward the window; with reduced motion the bubble just appears in place.
func bubbleStartFrame(_ frame: NSRect, toLeft: Bool, reduceMotion: Bool) -> NSRect {
    reduceMotion ? frame : frame.offsetBy(dx: toLeft ? bubbleSlide : -bubbleSlide, dy: 0)
}

/// The sections of the panel, top to bottom; done is only a count line. Scheduled and Recurring (Part G) hold the tasks
/// that wait for their time; nothing is dropped there.
enum Section: Int, CaseIterable {
    case needs, working, todo, scheduled, recurring, done

    var timed: Bool { self == .scheduled || self == .recurring }
}

/// The section a task is listed in: Scheduled or Recurring while it waits for its time, else the section of its status.
func sectionOf(_ item: WidgetItem) -> Section {
    if item.timing.waiting { return item.timing.schedule?.kind == "repeat" ? .recurring : .scheduled }
    return sectionOf(item.status)
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
    if section.timed { return timedOrder(items, section, engines: engines) }
    for item in items where sectionOf(item) == section {
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
/// `link` opens the task's link in the browser and sends no request; rowActions never lists it. So are `session` (opens
/// the agent's terminal) and `reply` (opens the reply field), see Part B.
/// `sendNow` (a prompt the busy session did not take) and `runAgain` (a script that failed) post run-now (Part G);
/// `terminal` is Open session named "Open terminal" for a script's terminal; `open` and `done` are bubble buttons.
enum RowAction: String {
    case confirm, reject, handled, link, session, reply, sendNow, runAgain, terminal, open, done

    var label: String {
        switch self {
        case .confirm: return L("Confirm")
        case .reject: return L("Reject")
        case .handled: return L("Handled")
        case .link: return L("Open link")
        case .session: return L("Open session")
        case .reply: return L("Reply")
        case .sendNow: return L("Send now")
        case .runAgain: return L("Run again")
        case .terminal: return L("Open terminal")
        case .open: return L("Open")
        case .done: return L("Done")
        }
    }

    var isPrimary: Bool { self == .confirm || self == .sendNow || self == .runAgain || self == .done }

    /// The SF Symbol of its icon button in a row.
    var symbolName: String {
        switch self {
        case .confirm: return "checkmark.circle.fill"
        case .reject: return "xmark.circle"
        case .handled: return "checkmark.circle"
        case .link: return "link"
        case .session: return "terminal"
        case .reply: return "arrowshape.turn.up.left"
        case .sendNow: return "paperplane"
        case .runAgain: return "arrow.clockwise"
        case .terminal: return "terminal"
        case .open: return "arrow.up.right.square"
        case .done: return "checkmark"
        }
    }
}

/// The side of a row's icon buttons, and the height of a row's title line when it has any.
let rowIconSize: CGFloat = 18

/// Review rows are confirmed or rejected; a row waiting for the user is marked handled.
/// A prompt the busy session did not take adds Send now, a failed script Run again (Part G).
func rowActions(for item: WidgetItem) -> [RowAction] {
    switch item.status {
    case "review": return [.confirm, .reject]
    case "waiting_user":
        if item.timing.due && item.timing.then.kind == "prompt" { return [.sendNow, .handled] }
        if item.timing.due && item.timing.then.kind == "script" { return [.runAgain, .handled] }
        return [.handled]
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
    var link: String = ""  // the task's link (taskLink), shown as an Open link button in every section
    var linkLabel: String = ""
    var openPath: String = ""  // the session's page path (sessionOpenPath), shown as an Open session button
    var canReply = false  // the agent's terminal is live on this machine: a waiting_user row gets Reply
    var mark: RowMark = .none  // the symbol before the title of a scheduled task (Part G)
    var schedule = ""  // the schedule line (Part G): the rule, the next time, the last done, where the prompt or script goes
    var script = false  // the action is a script: its Open session is "Open terminal"

    var isChild: Bool { depth > 0 }
    /// The tooltip of the link button: the label, else the address.
    var linkTitle: String { linkLabel.isEmpty ? link : linkLabel }
}

struct Summary: Equatable {
    let unfinished: Int
    let needs: [Row]
    let working: [Row]
    let todo: [Row]
    let done: Int
    let failed: [String]
    var finished: [Row] = []  // done, failed and cancelled rows, for the Finished group (Part D)
    var scheduled: [Row] = []  // once tasks waiting for their time (Part G)
    var recurring: [Row] = []  // repeating tasks waiting for their next time (Part G)

    func rows(_ section: Section) -> [Row] {
        switch section {
        case .needs: return needs
        case .working: return working
        case .todo: return todo
        case .scheduled: return scheduled
        case .recurring: return recurring
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
                       tag: showTags ? EngineTag(name: shortName(engine?.name ?? item.engine), colorIndex: engine?.colorIndex ?? -1) : nil,
                       link: item.link, linkLabel: item.linkLabel, openPath: item.openPath,
                       canReply: item.session?.canReply ?? false, mark: rowMark(item),
                       schedule: scheduleLine(item, now: scheduleClock()), script: item.timing.then.kind == "script")
        }
    }
    // A task waiting for its time is not counted (the capsule and the heading stay as they were without schedules).
    return Summary(unfinished: items.filter { !finishedStatuses.contains($0.status) && !$0.timing.waiting }.count,
                   needs: rows(.needs), working: rows(.working), todo: rows(.todo),
                   done: items.filter { sectionOf($0.status) == .done }.count, failed: list.failed, finished: rows(.done),
                   scheduled: rows(.scheduled), recurring: rows(.recurring))
}
