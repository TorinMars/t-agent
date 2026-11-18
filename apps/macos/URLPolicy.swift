// T-Agent.app: which addresses stay in the window, which open in the default browser, the microphone rule, page URLs
// built from a path and download file names. Pure functions, covered by --self-test. See main.swift.
import Foundation

// MARK: - Origins

/// Scheme, host and port of an http(s) address; the port is the effective one (80 or 443 when none is written).
struct Origin: Equatable {
    var scheme: String
    var host: String
    var port: Int
}

func origin(of url: URL) -> Origin? {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let scheme = parts.scheme?.lowercased(),
          scheme == "http" || scheme == "https", let host = parts.percentEncodedHost, !host.isEmpty else { return nil }
    return Origin(scheme: scheme, host: host.lowercased(), port: parts.port ?? (scheme == "https" ? 443 : 80))
}

func sameOrigin(_ url: URL, _ server: URL) -> Bool {
    guard let a = origin(of: url), let b = origin(of: server) else { return false }
    return a == b
}

/// The origin of a WKSecurityOrigin-like triple (protocol, host, port 0 meaning the default) against the server.
func sameOrigin(scheme: String, host: String, port: Int, server: URL) -> Bool {
    let lower = scheme.lowercased()
    guard lower == "http" || lower == "https", let target = origin(of: server) else { return false }
    let effective = port == 0 ? (lower == "https" ? 443 : 80) : port
    var normalizedHost = host.lowercased()
    if normalizedHost.contains(":") && !normalizedHost.hasPrefix("[") { normalizedHost = "[" + normalizedHost + "]" }
    return Origin(scheme: lower, host: normalizedHost, port: effective) == target
}

// MARK: - Navigation

enum NavigationDecision: Equatable {
    /// Load it in this web view.
    case allow
    /// Cancel it here and hand the address to the default browser (or the mail app for mailto:).
    case openExternally
    /// Cancel it.
    case cancel
}

/// What to do with a navigation of the web view. `mainFrame` is false for an iframe; `newWindow` is true for target=_blank
/// and window.open (the app never opens a second web view).
/// - about:blank and about:srcdoc load in place (frames use them); never as a new window.
/// - http(s) of the server's own origin (scheme, host and port) loads in place; a new window opens in the default browser.
/// - http(s) of another origin opens in the default browser from the main frame or a new window; an iframe loads it in place.
/// - blob: loads in place (the page's own downloads and previews), data: only in an iframe.
/// - mailto: and tel: go to their app from a user's click (main frame or new window); everything else is cancelled
///   (file:, javascript:, t-agent: and unknown schemes).
func navigationDecision(url: URL?, server: URL, mainFrame: Bool, newWindow: Bool) -> NavigationDecision {
    guard let url = url, let scheme = url.scheme?.lowercased() else { return .cancel }
    switch scheme {
    case "about":
        return newWindow ? .cancel : .allow
    case "http", "https":
        if newWindow { return .openExternally }
        if sameOrigin(url, server) { return .allow }
        return mainFrame ? .openExternally : .allow
    case "blob":
        return newWindow ? .cancel : .allow
    case "data":
        return (newWindow || mainFrame) ? .cancel : .allow
    case "mailto", "tel":
        return (mainFrame || newWindow) ? .openExternally : .cancel
    default:
        return .cancel
    }
}

/// The microphone (and camera) prompt of a page: granted only for the server's own origin.
func grantsMediaCapture(scheme: String, host: String, port: Int, server: URL) -> Bool {
    sameOrigin(scheme: scheme, host: host, port: port, server: server)
}

// MARK: - Page addresses

/// The server's page at `path` (a checked path from a deep link or the last page): ASCII characters a URL allows are kept,
/// anything else (non-ASCII text, quotes, angle brackets, braces) is percent-encoded as UTF-8. The result must be a valid
/// URL of the server's origin; otherwise nil.
func serverPageURL(base: URL, path: String) -> URL? {
    guard path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
    let keep = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$&'()*+,;=:@/?#%[]")
    var encoded = ""
    for scalar in path.unicodeScalars {
        if keep.contains(scalar) {
            encoded.unicodeScalars.append(scalar)
        } else {
            for byte in String(scalar).utf8 { encoded += String(format: "%%%02X", byte) }
        }
    }
    var root = base.absoluteString
    while root.hasSuffix("/") { root.removeLast() }
    guard let url = URL(string: root + encoded), sameOrigin(url, base) else { return nil }
    return url
}

/// The path, query and fragment of an address of the server (to load the same page at a new base), or nil.
func pagePath(of url: URL?, server: URL) -> String? {
    guard let url = url, sameOrigin(url, server), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    var path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
    if let query = parts.percentEncodedQuery { path += "?" + query }
    if let fragment = parts.percentEncodedFragment { path += "#" + fragment }
    return path
}

// MARK: - Downloads

/// A file name for a download: the last part of the suggested name, without control characters, colons or a leading dot,
/// at most 200 characters; "download" when nothing is left.
func safeDownloadName(_ suggested: String?) -> String {
    var name = (suggested ?? "").components(separatedBy: "/").last ?? ""
    name = String(String.UnicodeScalarView(name.unicodeScalars.map { scalar in
        (CharacterSet.controlCharacters.contains(scalar) || CharacterSet.newlines.contains(scalar) || scalar == ":" || scalar == "\\")
            ? "_" : scalar
    }))
    name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    while name.hasPrefix(".") { name.removeFirst() }
    name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if name.count > 200 {
        let ext = (name as NSString).pathExtension
        let keep = ext.isEmpty || ext.count > 16 ? 200 : 199 - ext.count
        name = String(name.prefix(keep)) + (ext.isEmpty || ext.count > 16 ? "" : "." + ext)
    }
    return name.isEmpty ? "download" : name
}

/// The first free path for `name` in `folder`: name.ext, then "name (1).ext", "name (2).ext" and so on.
func uniqueDownloadPath(folder: String, name: String, exists: (String) -> Bool) -> String {
    let first = (folder as NSString).appendingPathComponent(name)
    if !exists(first) { return first }
    let ext = (name as NSString).pathExtension
    let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
    for index in 1...9999 {
        let candidate = (folder as NSString).appendingPathComponent(stem + " (\(index))" + (ext.isEmpty ? "" : "." + ext))
        if !exists(candidate) { return candidate }
    }
    return (folder as NSString).appendingPathComponent(stem + " (\(UUID().uuidString))" + (ext.isEmpty ? "" : "." + ext))
}
