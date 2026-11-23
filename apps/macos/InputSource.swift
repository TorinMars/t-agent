// T-Agent.app: the keyboard input source while the person spells a word on the Learn page ("English input while spelling" in
// docs/design/mac-app.md). The page asks for English when a spelling field gets the focus and for the person's own input
// source back when it loses it; the app switches to an English ASCII-capable layout and back. The decision about a message
// and the remember / switch / restore state are pure or near-pure (the input source calls are injected); the real calls
// are Carbon's Text Input Source Services (TIS). See main.swift.
import Carbon
import Foundation

// MARK: - Messages from the page

/// What the page asks with `window.webkit.messageHandlers.tagentInputSource.postMessage(body)`.
enum InputSourceRequest: Equatable {
    /// A spelling field got the focus: English input.
    case english
    /// It lost the focus or Learn closed: the person's own input source back.
    case restore
}

/// The request of a `tagentInputSource` message: only from a frame of the server's own origin (the same check as
/// `linkToOpen`), only the exact bodies "english" and "restore"; anything else is nil and nothing changes.
func inputSourceRequest(body: Any?, frameScheme: String, frameHost: String, framePort: Int, server: URL) -> InputSourceRequest? {
    guard sameOrigin(scheme: frameScheme, host: frameHost, port: framePort, server: server), let text = body as? String else { return nil }
    switch text {
    case "english": return .english
    case "restore": return .restore
    default: return nil
    }
}

// MARK: - Input sources (injected)

/// One keyboard input source: its id (for example com.apple.keylayout.ABC) and, for the real ones, the TIS object.
struct InputSourceToken {
    let id: String
    let source: TISInputSource?
}

/// The current keyboard input source and whether it is already a plain ASCII-capable keyboard layout (ABC, U.S., British
/// and the like; an input method such as Pinyin is not).
struct InputSourceInfo {
    let token: InputSourceToken
    let isEnglishLayout: Bool
}

/// The input source calls: the real ones (`InputSources.system`) or the self-test's fakes, which never touch the real input source.
struct InputSources {
    /// The current keyboard input source, nil when it cannot be read.
    var current: () -> InputSourceInfo?
    /// Selects a source; true when it worked.
    var select: (InputSourceToken) -> Bool
    /// The English ASCII-capable layout to select, nil when none is enabled.
    var english: () -> InputSourceToken?
}

private func tisProperty(_ source: TISInputSource, _ key: CFString) -> AnyObject? {
    guard let raw = TISGetInputSourceProperty(source, key) else { return nil }
    return Unmanaged<AnyObject>.fromOpaque(raw).takeUnretainedValue()
}

private func tisToken(_ source: TISInputSource) -> InputSourceToken {
    InputSourceToken(id: (tisProperty(source, kTISPropertyInputSourceID) as? String) ?? "", source: source)
}

/// The first enabled source with this id, or nil.
private func tisEnabledSource(id: String) -> TISInputSource? {
    let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
    guard let list = TISCreateInputSourceList(filter, false)?.takeRetainedValue(), CFArrayGetCount(list) > 0,
          let first = CFArrayGetValueAtIndex(list, 0) else { return nil }
    return Unmanaged<TISInputSource>.fromOpaque(first).takeUnretainedValue()
}

extension InputSources {
    /// Text Input Source Services; called on the main thread only (the message handler, the window delegate, notifications on .main).
    static let system = InputSources(
        current: {
            guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else { return nil }
            let type = tisProperty(source, kTISPropertyInputSourceType) as? String
            let ascii = (tisProperty(source, kTISPropertyInputSourceIsASCIICapable) as? NSNumber)?.boolValue ?? false
            return InputSourceInfo(token: tisToken(source), isEnglishLayout: ascii && type == (kTISTypeKeyboardLayout as String))
        },
        select: { token in
            guard let source = token.source else { return false }
            return TISSelectInputSource(source) == noErr
        },
        english: {
            // The ASCII-capable layout the person used last (ABC for most people with Pinyin), else ABC, else U.S.
            if let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() { return tisToken(source) }
            for id in ["com.apple.keylayout.ABC", "com.apple.keylayout.US"] {
                if let source = tisEnabledSource(id: id) { return tisToken(source) }
            }
            return nil
        })
}

// MARK: - Remember, switch, restore

/// Remembers the person's input source while English is selected for spelling, and gives it back exactly once.
final class InputSourceSwitcher {
    let sources: InputSources
    /// The source the person had before the app selected English; nil while the app has switched nothing.
    private(set) var remembered: InputSourceToken?

    init(sources: InputSources) { self.sources = sources }

    /// An ASCII-capable keyboard layout already: nothing (and nothing remembered). Otherwise the current source is
    /// remembered, unless one is already (a second "english" keeps the first original), and the English layout is selected.
    /// When no English layout can be selected, nothing stays remembered that was not before.
    func english() {
        guard let current = sources.current(), !current.isEnglishLayout else { return }
        let first = remembered == nil
        if first { remembered = current.token }
        if let target = sources.english(), sources.select(target) { return }
        if first { remembered = nil }
    }

    /// Selects the remembered source again and forgets it; nothing when nothing is remembered.
    func restore() {
        guard let original = remembered else { return }
        remembered = nil
        _ = sources.select(original)
    }
}
