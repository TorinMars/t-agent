// T-Agent.app: another linked engine while this Mac's server does not answer ("Another engine while this one is down" in docs/design/mac-app.md).
// app.json lists the web addresses of the engines linked to this one (`linked`, remembered by the server while they were online). When this
// Mac's server stops answering (and the person did not stop it), the app tries those addresses in order and shows the first that answers, and
// says so in the title. When this Mac's server is back, the app stays where the person is working and offers View → Return to This Mac; it never
// switches back by itself. The decisions are pure (covered by --self-test); AppDelegate.swift runs them. See main.swift.
import Foundation

// MARK: - app.json

/// One linked engine of app.json: its name and its web addresses (scheme://host[:port] only).
struct LinkedEngine: Equatable {
    var name: String
    var urls: [URL]
}

/// `linked` of app.json, read defensively: objects with a name and at least one http(s) address, at most 8 engines of at most 8 addresses each.
func parseLinked(_ value: Any?) -> [LinkedEngine] {
    var found: [LinkedEngine] = []
    for entry in (value as? [Any]) ?? [] {
        guard let object = entry as? [String: Any] else { continue }
        var name = ((object["name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || hasControlCharacters(name) { name = "Linked engine" }
        if name.count > 60 { name = String(name.prefix(60)) }
        var urls: [URL] = []
        for text in (object["urls"] as? [Any]) ?? [] {
            guard let text = text as? String, let url = serverBase(text), !urls.contains(url) else { continue }
            urls.append(url)
            if urls.count == 8 { break }
        }
        if !urls.isEmpty { found.append(LinkedEngine(name: name, urls: urls)) }
        if found.count == 8 { break }
    }
    return found
}

/// The addresses to try, in order: each engine's addresses in the order app.json gives them.
func failoverCandidates(_ linked: [LinkedEngine]) -> [FailoverTarget] {
    linked.flatMap { engine in engine.urls.map { FailoverTarget(name: engine.name, url: $0) } }
}

// MARK: - State machine

struct FailoverTarget: Equatable {
    var name: String
    var url: URL
}

struct FailoverState: Equatable {
    /// The linked engine the window shows instead of this Mac's server (nil: this Mac's page or the placeholder).
    var shown: FailoverTarget?
    /// The addresses are being tried.
    var probing = false
    /// When they were last tried, so a server that stays down is not asked about every check.
    var lastProbe: Date?
    /// This Mac's server answers again while a linked engine is shown.
    var homeBack = false
    /// This Mac's server answers (an answer of the linked addresses that comes after it is not used).
    var homeAnswers = false
}

enum FailoverEvent: Equatable {
    /// This Mac's server does not answer (the window would show the placeholder). `byPerson`: the person stopped it.
    case homeDown(byPerson: Bool, now: Date)
    /// The result of trying the linked addresses: the first that answered, or nil.
    case probed(FailoverTarget?)
    /// This Mac's server answers again (the window would show its page).
    case homeUp
    /// View → Return to This Mac.
    case returnHome
}

enum FailoverEffect: Equatable {
    /// Try the linked addresses.
    case probe
    /// Show this linked engine's page.
    case showLinked(FailoverTarget)
    /// Show this Mac's page (the monitor's usual way).
    case showHome
    /// Show the not-running placeholder (back from a linked engine while this Mac's server is still down).
    case showPlaceholder
    /// Stay on the linked engine; the title offers the way back.
    case stay
}

enum FailoverTiming {
    /// How often a server that stays down makes the app try the linked addresses again.
    static let retry: TimeInterval = 15
}

/// One step. `hasLinked`: app.json lists at least one linked address.
func stepFailover(_ state: inout FailoverState, _ event: FailoverEvent, hasLinked: Bool) -> [FailoverEffect] {
    switch event {
    case .homeDown(let byPerson, let now):
        state.homeBack = false
        state.homeAnswers = false
        if state.shown != nil || state.probing || byPerson || !hasLinked { return [] }
        if let last = state.lastProbe, now.timeIntervalSince(last) < FailoverTiming.retry { return [] }
        state.probing = true
        state.lastProbe = now
        return [.probe]
    case .probed(let target):
        state.probing = false
        guard state.shown == nil, !state.homeAnswers, let target = target else { return [] }
        state.shown = target
        return [.showLinked(target)]
    case .homeUp:
        state.probing = false
        state.homeAnswers = true
        if state.shown != nil {
            state.homeBack = true
            return [.stay]
        }
        return [.showHome]
    case .returnHome:
        guard state.shown != nil else { return [] }
        state.shown = nil
        let back = state.homeBack
        state.homeBack = false
        return [back ? .showHome : .showPlaceholder]
    }
}

/// The one line the title adds while a linked engine is shown (nil otherwise).
func failoverTitleNote(_ state: FailoverState) -> String? {
    guard let shown = state.shown else { return nil }
    if state.homeBack { return "On \(shown.name) · This Mac's T-Agent is back: View → Return to This Mac" }
    return "On \(shown.name) while this Mac's T-Agent is not running"
}
