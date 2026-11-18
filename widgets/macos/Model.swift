// T-Attention desktop widget: the item list and its decoding. See main.swift for the overview and the build.
import AppKit

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
    var link: String = ""  // link_url when taskLink accepts it, else empty
    var linkLabel: String = ""  // link_label on one line
    var session: ItemSession?  // the agent's terminal (Part B); nil from an older server or a task without one
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
                      sortOrder: looseNumber(object["sort_order"]) ?? 0,
                      link: (object["link_url"] as? String).flatMap(taskLink) ?? "",
                      linkLabel: ((object["link_label"] as? String) ?? "").oneLine,
                      session: decodeSession(object["session"]))
}

/// The link of a task when the window may open it, trimmed: an http(s) address with a host and without a user name or
/// password, or a page path of T-Agent ('/...', not '//host', no backslash), as services/attention.js linkUrl stores it
/// and safeLink in scripts/h5-shell/attention-model.mjs opens it. Nil for anything else (javascript:, file:, ftp:, ...).
func taskLink(_ value: String) -> String? {
    let text = value.trimmed
    guard !text.isEmpty, text.count <= 2000, !text.unicodeScalars.contains(where: {
        CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) || $0 == "\\"
    }) else { return nil }
    if text.hasPrefix("/") { return text.hasPrefix("//") ? nil : text }
    let lower = text.lowercased()
    guard lower.hasPrefix("http://") || lower.hasPrefix("https://"), let url = URL(string: text),
          let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
    return text
}

/// The address a link opens: an http(s) address as it is, a page path on the T-Agent of the window (`base`, an http(s)
/// origin without a trailing slash, WidgetAPI.base). Nil when it is not a link taskLink accepts.
func linkTarget(_ link: String, base: String) -> URL? {
    guard let text = taskLink(link) else { return nil }
    guard text.hasPrefix("/") else { return URL(string: text) }
    guard let origin = URL(string: base), let host = origin.host, let url = URL(string: base + text),
          url.host == host, url.scheme == origin.scheme else { return nil }
    return url
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
