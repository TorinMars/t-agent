// T-Agent.app: the t-agent:// links (the floating window and other apps open them). Parsing is pure and covered by
// --self-test; the app delegate receives the links as kAEGetURL Apple Events. See main.swift.
import Foundation

// MARK: - Deep links

/// t-agent://show shows the window; t-agent://open?path=<encoded page path> shows it and loads that path of the server.
enum DeepLink: Equatable {
    case show
    case open(path: String)
}

/// Decodes %XX escapes exactly once. Nil for a broken escape (a % without two hex digits) or bytes that are not UTF-8.
/// A + stays a +.
func percentDecodeOnce(_ text: String) -> String? {
    var bytes: [UInt8] = []
    let utf8 = Array(text.utf8)
    var index = 0
    func hex(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48...57: return byte - 48
        case 65...70: return byte - 55
        case 97...102: return byte - 87
        default: return nil
        }
    }
    while index < utf8.count {
        let byte = utf8[index]
        if byte == 37 {
            guard index + 2 < utf8.count, let high = hex(utf8[index + 1]), let low = hex(utf8[index + 2]) else { return nil }
            bytes.append(high << 4 | low)
            index += 3
        } else {
            bytes.append(byte)
            index += 1
        }
    }
    return String(bytes: bytes, encoding: .utf8)
}

/// A page path the app may load: starts with one "/" (never "//", which a browser reads as another host), at most 4096
/// characters, no backslash, no whitespace and no control or format characters.
func isAcceptablePagePath(_ path: String) -> Bool {
    guard path.hasPrefix("/"), !path.hasPrefix("//"), path.count <= 4096, !path.contains("\\") else { return false }
    return !path.unicodeScalars.contains { scalar in
        CharacterSet.whitespacesAndNewlines.contains(scalar) || CharacterSet.controlCharacters.contains(scalar)
            || CharacterSet.illegalCharacters.contains(scalar)
    }
}

/// Parses a t-agent:// link. Only `t-agent://show` (a query is ignored) and `t-agent://open?path=<value>` with exactly one
/// `path` and nothing else; the host is the command (any case), with no user, password, port, fragment or path beyond "/".
/// The value is percent-decoded once and must then be an acceptable page path. Anything else is nil.
func parseDeepLink(_ text: String) -> DeepLink? {
    guard text.count <= 8192, !hasControlCharacters(text), !text.contains(" "), !text.contains("\\") else { return nil }
    guard let parts = URLComponents(string: text), parts.scheme?.lowercased() == "t-agent", let host = parts.host?.lowercased(),
          parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
          parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/" else { return nil }
    // The query is read from the text itself: URLComponents re-encodes a broken escape instead of refusing it.
    let afterScheme = text.dropFirst("t-agent://".count)
    let query: Substring? = afterScheme.firstIndex(of: "?").map { afterScheme[afterScheme.index(after: $0)...] }
    switch host {
    case "show":
        return .show
    case "open":
        guard let query = query, !query.isEmpty else { return nil }
        let pairs = query.split(separator: "&", omittingEmptySubsequences: false)
        guard pairs.count == 1, let pair = pairs.first, pair.hasPrefix("path=") else { return nil }
        guard let path = percentDecodeOnce(String(pair.dropFirst("path=".count))), isAcceptablePagePath(path) else { return nil }
        return .open(path: path)
    default:
        return nil
    }
}

/// The link a caller (the floating window) builds for a page path: the path encoded as a query value.
func deepLinkText(path: String) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    return "t-agent://open?path=" + (path.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
}
