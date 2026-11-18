// T-Attention desktop widget: the requests to T-Agent. See main.swift for the overview and the build.
import AppKit

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

    func itemPath(_ key: String) -> String { "/api/attention/widget/items/" + WidgetAPI.encodeKey(key) }

    var itemsRequest: URLRequest { request("GET", "/api/attention/widget/items") }
    var stringsRequest: URLRequest { request("GET", "/api/attention/widget/strings") }

    /// The notices after `after`; without it (the first call) those of the last 60 s.
    func noticesRequest(after: Int?) -> URLRequest {
        request("GET", "/api/attention/widget/notices" + (after.map { "?after=\($0)" } ?? ""))
    }

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
