// T-Attention desktop widget: the interface strings and loose JSON values. See main.swift for the overview and the build.
import AppKit

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
