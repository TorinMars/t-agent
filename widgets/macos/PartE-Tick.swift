// T-Attention desktop widget: Part E, one request per tick. See main.swift for the overview and the build.
import AppKit

// MARK: - Part E: one request per tick
//
// GET {TA_WIDGET_URL}/api/attention/widget/tick?after=<notice seq>&items=<etag>[&activity=0] every 5 s answers
// { etag, list, notices, activity, prefs }: `list` is the answer of GET /items, or null when the window's etag (of the list
// it shows) is still the server's; `notices`, `activity` (null with activity=0, sent while show_activity is off) and
// `prefs` are the answers of GET /notices?after, /activity and /prefs. A refresh after the window's own change asks
// without the etag, so the list always comes. A list that comes while a row is pressed or an action is out is dropped
// and the etag kept, so the next tick sends it again. A 404 (an older T-Agent): the four endpoints at once and on every
// tick, /tick again after tickRetryDelay. Any other failure is shown like a failed GET /items, with no activity.

let tickRetryDelay: TimeInterval = 300

/// A GET /tick answer: each part as the Data its own decoder reads. `list` nil: unchanged.
struct TickAnswer {
    var etag: String
    var list: ItemList?
    var notices: Data?
    var activity: Data?
    var prefs: Data?
}

/// Nil when it is not a tick answer (no `list` field, or a list that is not one).
func decodeTick(_ data: Data) -> TickAnswer? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["list"] != nil else { return nil }
    func part(_ key: String) -> Data? {
        (object[key] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
    }
    var list: ItemList?
    if !(object["list"] is NSNull) {
        guard let data = part("list"), let decoded = decodeItemList(data) else { return nil }
        list = decoded
    }
    let etag = (object["etag"] as? String).flatMap { $0.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil ? $0 : nil }
    return TickAnswer(etag: etag ?? "", list: list, notices: part("notices"), activity: part("activity"), prefs: part("prefs"))
}

/// When GET /tick is used: not for tickRetryDelay after a 404. `etag`: of the list the window shows, nil when it shows
/// none or a list of its own (a move or a change not read back yet).
struct TickPoll {
    var etag: String?
    var unsupportedUntil: Date?
    var inFlight = 0

    func usable(_ now: Date) -> Bool { unsupportedUntil.map { now >= $0 } ?? true }

    mutating func notFound(_ now: Date) {
        unsupportedUntil = now.addingTimeInterval(tickRetryDelay)
        etag = nil
    }
}

/// The state of Part E on the controller. `enabled`: set when the app starts (--self-test sets it itself).
final class TickState {
    var enabled = false
    var poll = TickPoll()
}

extension WidgetAPI {
    func tickRequest(after: Int?, etag: String?, activity: Bool) -> URLRequest {
        var query: [String] = []
        if let after = after { query.append("after=\(after)") }
        if let etag = etag, !etag.isEmpty { query.append("items=" + WidgetAPI.encodeKey(etag)) }
        if !activity { query.append("activity=0") }
        return request("GET", "/api/attention/widget/tick" + (query.isEmpty ? "" : "?" + query.joined(separator: "&")))
    }
}

extension WidgetController {
    /// GET /tick is used (the app runs, and no 404 within tickRetryDelay).
    var tickMode: Bool { ticks.enabled && ticks.poll.usable(now()) }

    /// The 5 s timer: one tick; for an older T-Agent, the list, the notices, the activity and the preferences.
    func poll() {
        guard tickMode else {
            refresh()
            pollNotices()
            pollActivity()
            pollPrefs()
            return
        }
        loadStrings()
        pollActivity()  // only moves the shown times on and rebuilds a panel that waited (the tick brings the activity)
        guard ticks.poll.inFlight == 0 else { return }  // one timer tick at a time; a refresh may still go out beside it
        sendTick(wantList: false)
    }

    /// One GET /tick. wantList: without the etag, so the list comes (a refresh).
    func sendTick(wantList: Bool, then done: (() -> Void)? = nil) {
        let generation = refreshGeneration
        let etag = wantList ? nil : ticks.poll.etag
        ticks.poll.inFlight += 1
        perform(api.tickRequest(after: noticePoll.lastSeq, etag: etag, activity: showActivity)) { [weak self] data, code, _ in
            guard let self = self else { return }
            self.ticks.poll.inFlight -= 1
            if code == 404 {
                self.ticks.poll.notFound(self.now())
                self.refresh(then: done)
                self.pollNotices()
                self.pollActivity()
                self.pollPrefs()
                return
            }
            guard (200..<300).contains(code), let data = data, let answer = decodeTick(data) else {
                self.ticks.poll.etag = nil
                if self.showActivity { self.setActivity([]) }  // a stale "running" would mislead
                if generation == self.refreshGeneration, !self.refreshPaused {
                    self.apply(nil, problem: code == 401 || code == 403 ? L("T-Agent did not accept the widget token") : L("Could not reach T-Agent"))
                }
                done?()
                return
            }
            let fresh = self.noticePoll.finished(code: 200, data: answer.notices, now: self.now())
            if !fresh.isEmpty { self.enqueue(fresh) }
            if let prefs = answer.prefs.flatMap(decodeWindowPrefs) { self.applyPrefs(prefs) }
            if self.showActivity, let activity = answer.activity { self.setActivity(decodeActivity(activity) ?? []) }
            if generation == self.refreshGeneration, !self.refreshPaused {
                if let list = answer.list {
                    self.ticks.poll.etag = answer.etag.isEmpty ? nil : answer.etag
                    self.apply(list, problem: nil)
                } else if answer.etag != etag {
                    self.ticks.poll.etag = nil  // not the list it has: the next tick asks for it whole
                }
            }
            done?()
        }
    }

    // For --self-test.
    func testStartTicking() { ticks.enabled = true }
    var testTickEtag: String? { ticks.poll.etag }
    var testActivityCount: Int { live.terminals.count }
}

/// --self-test, Part E: one request per tick, the etag, the refresh after an action, the fallback on a 404.
func runTickSelfTest(_ check: (String, Bool) -> Void) {
    let api = WidgetAPI(base: "http://127.0.0.1:3999", token: "t")
    func describe(_ request: URLRequest) -> String { (request.httpMethod ?? "") + " " + (request.url?.absoluteString ?? "") }
    check("tick request: after, the etag and the activity switch", describe(api.tickRequest(after: 4, etag: "abc_-9", activity: true))
          == "GET http://127.0.0.1:3999/api/attention/widget/tick?after=4&items=abc_-9"
          && describe(api.tickRequest(after: nil, etag: nil, activity: false)) == "GET http://127.0.0.1:3999/api/attention/widget/tick?activity=0"
          && api.tickRequest(after: nil, etag: nil, activity: true).value(forHTTPHeaderField: "Authorization") == "Bearer t")

    func item(_ key: String, _ status: String, order: Double) -> [String: Any] {
        ["key": key, "status": status, "title": "Task " + key, "sort_order": order]
    }
    func tickBody(etag: String, items: [[String: Any]]?, seq: Int = 0, notices: [[String: Any]] = [], activity: [[String: Any]]? = [],
                  hotkeys: Bool = true, showActivity: Bool = true) -> Data {
        let list: Any = items.map { ["items": $0, "engines": [["key": "local", "name": "MacBook", "local": true] as [String: Any]], "failed": [String]()] as [String: Any] }
            ?? NSNull()
        let terminals: Any = activity.map { ["terminals": $0] as [String: Any] } ?? NSNull()
        return try! JSONSerialization.data(withJSONObject: [
            "etag": etag, "list": list, "notices": ["seq": seq, "notices": notices] as [String: Any], "activity": terminals,
            "prefs": ["hotkeys": hotkeys, "dim_when_idle": true, "show_activity": showActivity], "updated_at": "2026-11-18T10:00:00.000Z",
        ] as [String: Any])
    }
    let three = [item("local:1", "waiting_user", order: 3), item("local:2", "review", order: 2), item("local:3", "working", order: 1)]
    let decoded = decodeTick(tickBody(etag: "e1", items: three, seq: 2))
    check("tick answer: every part is read", decoded?.etag == "e1" && decoded?.list?.items.count == 3 && decoded?.notices != nil
          && decoded?.prefs.flatMap(decodeWindowPrefs) == WindowPrefs() && decoded?.activity.flatMap(decodeActivity) == [])
    let unchanged = decodeTick(tickBody(etag: "e1", items: nil, activity: nil))
    check("tick answer: list null is the same list", unchanged != nil && unchanged?.list == nil && unchanged?.activity == nil)
    check("tick answer: anything else is refused", decodeTick(Data("{}".utf8)) == nil && decodeTick(Data("[]".utf8)) == nil
          && decodeTick(Data("{\"list\":{\"items\":7}}".utf8)) == nil && decodeTick(Data("nope".utf8)) == nil)
    var tickPoll = TickPoll(etag: "e1")
    let start = Date(timeIntervalSince1970: 2_000_000)
    tickPoll.notFound(start)
    check("tick poll: a 404 drops the etag and waits five minutes", tickPoll.etag == nil && !tickPoll.usable(start.addingTimeInterval(tickRetryDelay - 1))
          && tickPoll.usable(start.addingTimeInterval(tickRetryDelay)))

    // The window, offscreen.
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let window = WidgetController(api: api, parentPID: nil, options: options)
    var sent: [URLRequest] = []
    var waiting: [(Data?, Int) -> Void] = []
    var clock = start
    window.requestHook = { request, answer in
        sent.append(request)
        waiting.append(answer)
    }
    window.openURL = { _ in }
    window.announce = { _ in }
    window.now = { clock }
    func answer(_ body: Data?, _ code: Int = 200) {
        guard !waiting.isEmpty else { return }
        waiting.removeFirst()(body, code)
    }
    func paths() -> [String] { sent.map { ($0.url?.path ?? "") + ($0.url?.query.map { "?" + $0 } ?? "") } }
    window.testStartTicking()
    window.startPreferences()
    check("tick: no separate prefs request at start", sent.isEmpty)
    window.poll()
    check("tick: one request on a tick, without an etag at first", paths() == ["/api/attention/widget/tick"] || paths() == ["/api/attention/widget/strings", "/api/attention/widget/tick"])
    // The strings request goes out with the first tick; answer it so only ticks are left.
    if let index = sent.firstIndex(where: { $0.url?.path == "/api/attention/widget/strings" }) {
        sent.remove(at: index)
        waiting.remove(at: index)(Data("{\"lang\":\"en\",\"strings\":{}}".utf8), 200)
    }
    let notice: [String: Any] = ["seq": 2, "kind": "item", "title": "Approve it", "status": "waiting_user", "key": "local:1"]
    let running: [String: Any] = ["task_id": "12", "terminal_id": "t1", "state": "running", "since": "2026-11-18T10:00:00.000Z"]
    answer(tickBody(etag: "e1", items: three, seq: 2, notices: [notice], activity: [running], hotkeys: false))
    check("tick: the list, the notice, the activity and the prefs of one answer", window.testCount == "3" && window.testTickEtag == "e1"
          && window.testBubbleTitle == "Approve it" && window.testActivityCount == 1 && !window.testHotKeysWanted)
    sent = []
    window.poll()
    window.poll()
    check("tick: the next tick sends the etag and the last notice seq, one at a time", paths() == ["/api/attention/widget/tick?after=2&items=e1"])
    answer(tickBody(etag: "e1", items: nil, seq: 2, activity: []))
    check("tick: list null keeps the list", window.testCount == "3" && window.testTickEtag == "e1" && window.testActivityCount == 0)
    sent = []
    window.poll()
    answer(tickBody(etag: "e2", items: [item("local:1", "waiting_user", order: 3)], seq: 2))
    check("tick: a changed list comes with its etag", window.testCount == "1" && window.testTickEtag == "e2")

    // An action: the refresh after it is one tick without the etag, so the list always comes.
    window.loadForTest(decodeTick(tickBody(etag: "e3", items: three))!.list!)
    sent = []
    _ = window.testPressButton("local:1", .handled)
    check("tick: the action itself", paths() == ["/api/attention/widget/items/local:1/handled"])
    answer(Data("{}".utf8))
    check("tick: refreshed at once with a tick that asks for the list", paths().last == "/api/attention/widget/tick?after=2"
          && sent.filter { $0.url?.path == "/api/attention/widget/items" }.isEmpty)
    answer(tickBody(etag: "e4", items: [item("local:2", "review", order: 2)], seq: 2))
    check("tick: and the answer is shown", window.testCount == "1" && window.testTickEtag == "e4")

    // Prefs: show_activity off -> activity=0.
    sent = []
    window.poll()
    answer(tickBody(etag: "e4", items: nil, seq: 2, activity: [running], showActivity: false))
    check("tick: prefs applied, no activity while it is off", !window.showActivity && window.testActivityCount == 0)
    window.poll()
    check("tick: activity=0 while it is off", paths().last == "/api/attention/widget/tick?after=2&items=e4&activity=0")
    answer(tickBody(etag: "e4", items: nil, seq: 2, activity: nil, showActivity: true))
    check("tick: turning it on asks a tick at once", window.showActivity && paths().last == "/api/attention/widget/tick?after=2&items=e4")
    answer(tickBody(etag: "e4", items: nil, seq: 2, activity: [running]))
    check("tick: and shows the activity", window.testActivityCount == 1)

    // A failure: shown like a failed list, no activity, and the next tick asks for the list.
    window.poll()
    answer(Data("{\"error\":\"INTERNAL_ERROR\"}".utf8), 500)
    check("tick: a failure says so and drops the etag", window.testCount == "\u{2013}" && window.testTickEtag == nil && window.testActivityCount == 0)
    window.poll()
    check("tick: the next one asks for the list", paths().last == "/api/attention/widget/tick?after=2")
    answer(tickBody(etag: "e5", items: three, seq: 2))

    // An older T-Agent: a 404, then the four endpoints at once and on every tick, /tick again after five minutes.
    sent = []
    window.poll()
    answer(Data("{\"error\":\"NOT_FOUND\"}".utf8), 404)
    let legacy = ["/api/attention/widget/items", "/api/attention/widget/notices", "/api/attention/widget/activity", "/api/attention/widget/prefs"]
    check("fallback: a 404 asks the four endpoints at once", Array(sent.dropFirst().map { $0.url?.path ?? "" }) == legacy)
    answer(try? JSONSerialization.data(withJSONObject: ["items": [item("local:9", "waiting_user", order: 1)], "engines": [[String: Any]](),
                                                        "failed": [String]()] as [String: Any]))
    check("fallback: the list of GET /items is shown", window.testCount == "1")
    while !waiting.isEmpty { answer(Data("{}".utf8)) }
    sent = []
    clock = clock.addingTimeInterval(5)
    window.poll()
    check("fallback: every tick asks them, not /tick", sent.map { $0.url?.path ?? "" } == legacy)
    while !waiting.isEmpty { answer(Data("{}".utf8)) }
    sent = []
    clock = clock.addingTimeInterval(tickRetryDelay)
    window.poll()
    check("fallback: /tick is tried again after five minutes", paths() == ["/api/attention/widget/tick?after=2"])
    answer(tickBody(etag: "e6", items: three, seq: 2))
    check("fallback: and used again when it answers", window.testTickEtag == "e6" && window.testCount == "3")
    check("tick: no window was put on screen", !window.testOnScreen)
}
