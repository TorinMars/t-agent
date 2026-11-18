// T-Agent.app: reading <data home>/app.json, the server's base address and the web addresses it lists. Pure functions
// (the file reader, the environment and the home folder are passed in), covered by --self-test. See main.swift.
import Foundation

// MARK: - Version

/// The version of this app: CFBundleShortVersionString of the bundle (scripts/build-mac-app.js writes the app_version of
/// VERSION.json there). A binary that is not inside a bundle (the self-test build) says "dev".
func appVersion(_ info: [String: Any]? = Bundle.main.infoDictionary) -> String {
    let value = (info?["CFBundleShortVersionString"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? "dev" : value
}

// MARK: - Configuration

/// What runs the server, from `supervisor` of app.json. Only PM2 and launchd can be controlled by the app.
enum Supervisor: String, Equatable {
    case pm2, launchd, systemd, none

    var controllable: Bool { self == .pm2 || self == .launchd }
}

/// One address of the web service, from `addresses` of app.json.
struct WebAddress: Equatable {
    enum Kind: String, CaseIterable { case local, lan, remote }
    var kind: Kind
    var label: String
    var url: String
}

/// Whether app.json was there and could be read.
enum ConfigSource: Equatable { case file, missing, corrupt }

struct AppConfig: Equatable {
    var url: URL
    var version: String?
    var pid: Int32?
    var installDir: String?
    var supervisor: Supervisor
    var pm2Name: String
    var launchdLabel: String
    var addresses: [WebAddress]
    var source: ConfigSource

    static let defaultURL = URL(string: "http://127.0.0.1:3000")!
    static let defaultPm2Name = "t-agent"
    /// The label scripts/migrate-to-git.sh used for its LaunchAgent; app.json may name another one (`launchd_label`).
    static let defaultLaunchdLabel = "com.tagent.client"

    static func defaults(_ source: ConfigSource) -> AppConfig {
        AppConfig(url: defaultURL, version: nil, pid: nil, installDir: nil, supervisor: .none, pm2Name: defaultPm2Name,
                  launchdLabel: defaultLaunchdLabel, addresses: [WebAddress(kind: .local, label: "This Mac", url: defaultURL.absoluteString)],
                  source: source)
    }
}

/// The data home, as the server resolves it (lib/data-home.js): TAGENT_HOME, then the old name T_AGENT_DATA_DIR, then the
/// hidden default `DataHome` of the app (an app opened from the Finder does not see the variables of a shell profile), else
/// ~/.tagent. A leading `~` is the home folder.
func dataHome(environment: [String: String], defaultsValue: String?, home: String) -> String {
    let candidates = [environment["TAGENT_HOME"], environment["T_AGENT_DATA_DIR"], defaultsValue]
    for candidate in candidates {
        let value = (candidate ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { continue }
        if value == "~" { return home }
        if value.hasPrefix("~/") { return (home as NSString).appendingPathComponent(String(value.dropFirst(2))) }
        if value.hasPrefix("/") { return (value as NSString).standardizingPath }
        return ((home as NSString).appendingPathComponent(value) as NSString).standardizingPath
    }
    return (home as NSString).appendingPathComponent(".tagent")
}

func appJSONPath(dataHome: String) -> String { (dataHome as NSString).appendingPathComponent("app.json") }

/// True when the text has a control character (including format characters such as bidi overrides) or a line break.
func hasControlCharacters(_ text: String) -> Bool {
    text.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) || CharacterSet.newlines.contains($0) }
}

/// `scheme://host[:port]` of an http(s) address, or nil for anything else (other schemes, no host, a user or password).
func serverBase(_ text: String) -> URL? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= 2048, !hasControlCharacters(trimmed),
          let parts = URLComponents(string: trimmed), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = parts.percentEncodedHost, !host.isEmpty, parts.user == nil, parts.password == nil else { return nil }
    var base = scheme + "://" + host.lowercased()
    if let port = parts.port {
        guard port > 0 && port < 65536 else { return nil }
        base += ":\(port)"
    }
    return URL(string: base)
}

/// An http(s) address for the menu: trimmed, with a host and no user or password; anything else is nil.
func webAddressURL(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= 2048, !hasControlCharacters(trimmed), !trimmed.contains(" "),
          let parts = URLComponents(string: trimmed), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil, URL(string: trimmed) != nil else { return nil }
    return trimmed
}

func defaultAddressLabel(_ kind: WebAddress.Kind) -> String {
    switch kind {
    case .local: return "This Mac"
    case .lan: return "Local network"
    case .remote: return "Remote"
    }
}

/// `addresses` of app.json, read defensively: only objects with a known kind and an http(s) URL; a missing or odd label
/// becomes the label of its kind. Sorted local, lan, remote (keeping the order inside a kind), without repeated URLs, at
/// most 12. When none is left, the server's own base address is the one local address.
func parseAddresses(_ value: Any?, base: URL) -> [WebAddress] {
    var found: [WebAddress] = []
    for entry in (value as? [Any]) ?? [] {
        guard let object = entry as? [String: Any], let kindText = object["kind"] as? String,
              let kind = WebAddress.Kind(rawValue: kindText), let urlText = object["url"] as? String,
              let url = webAddressURL(urlText) else { continue }
        var label = ((object["label"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if label.isEmpty || hasControlCharacters(label) { label = defaultAddressLabel(kind) }
        if label.count > 60 { label = String(label.prefix(60)) }
        if found.contains(where: { $0.url == url }) { continue }
        found.append(WebAddress(kind: kind, label: label, url: url))
    }
    let order = WebAddress.Kind.allCases
    let sorted = order.flatMap { kind in found.filter { $0.kind == kind } }
    if sorted.isEmpty { return [WebAddress(kind: .local, label: defaultAddressLabel(.local), url: base.absoluteString)] }
    return Array(sorted.prefix(12))
}

/// An absolute folder without control characters, or nil.
func cleanPath(_ value: Any?) -> String? {
    guard let text = value as? String, text.hasPrefix("/"), text.count <= 1024, !hasControlCharacters(text) else { return nil }
    return text
}

/// A PM2 process name: 1 to 128 characters, no control characters (it is shell-quoted, so other characters are fine).
func cleanPm2Name(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty, text.count <= 128, !hasControlCharacters(text),
          text.trimmingCharacters(in: .whitespaces) == text else { return nil }
    return text
}

/// A launchd label: letters, digits, dots, dashes and underscores.
func cleanLaunchdLabel(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty, text.count <= 128 else { return nil }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    return text.unicodeScalars.allSatisfy { allowed.contains($0) } ? text : nil
}

/// The contents of app.json, or the defaults when the file is missing (`data` nil) or broken. Every field is checked; a
/// bad field falls back to its default and leaves the others alone.
func parseAppConfig(_ data: Data?) -> AppConfig {
    guard let data = data else { return .defaults(.missing) }
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return .defaults(.corrupt) }
    var config = AppConfig.defaults(.file)
    if let text = object["url"] as? String, let base = serverBase(text) { config.url = base }
    if let version = object["version"] as? String, !version.isEmpty, version.count <= 64, !hasControlCharacters(version) {
        config.version = version
    }
    if let pid = object["pid"] as? NSNumber, pid.int64Value > 0, pid.int64Value <= Int64(Int32.max) { config.pid = pid.int32Value }
    config.installDir = cleanPath(object["install_dir"])
    if let text = object["supervisor"] as? String, let supervisor = Supervisor(rawValue: text), supervisor != .none {
        config.supervisor = supervisor
    }
    if let name = cleanPm2Name(object["pm2_name"]) { config.pm2Name = name }
    if let label = cleanLaunchdLabel(object["launchd_label"]) { config.launchdLabel = label }
    config.addresses = parseAddresses(object["addresses"], base: config.url)
    return config
}

/// Reads app.json from the data home through `readFile` (nil when it cannot be read).
func loadAppConfig(environment: [String: String], defaultsValue: String?, home: String, readFile: (String) -> Data?) -> AppConfig {
    parseAppConfig(readFile(appJSONPath(dataHome: dataHome(environment: environment, defaultsValue: defaultsValue, home: home))))
}
