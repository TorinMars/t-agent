// T-Attention desktop widget: the --self-test checks. See main.swift for the overview and the build.
import AppKit

// MARK: - Self test

func runSelfTest() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    var failures = 0
    var passes = 0
    func check(_ name: String, _ ok: Bool) {
        print((ok ? "ok   " : "FAIL ") + name)
        if ok { passes += 1 } else { failures += 1 }
    }
    func it(_ key: String, _ status: String = "working", parent: String = "", order: Double = 0, title: String? = nil,
            custom: String = "", result: String = "", reason: String = "", pending: String = "", notes: String? = "",
            link: String = "", label: String = "") -> WidgetItem {
        let cut = key.range(of: ":", options: .backwards)!
        return WidgetItem(key: key, engine: String(key[..<cut.lowerBound]), id: String(key[cut.upperBound...]), parentKey: parent,
                          title: title ?? key, status: status, customStatus: custom, result: result, attentionReason: reason,
                          pending: pending, notes: notes, sortOrder: order, link: taskLink(link) ?? "", linkLabel: label)
    }
    let twoEngines = [EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0),
                      EngineInfo(key: "remote:7", name: "K01", local: false, colorIndex: 3)]
    func listOf(_ items: [WidgetItem], engines: [EngineInfo] = twoEngines, failed: [String] = []) -> ItemList {
        ItemList(items: items, engines: engines, failed: failed)
    }
    func keys(_ rows: [Row]) -> String { rows.map { $0.key }.joined(separator: " ") }
    func order(_ outcome: MoveOutcome, _ section: Section, engines: [EngineInfo] = twoEngines) -> String {
        switch outcome {
        case .moved(let items): return keys(summarize(listOf(items, engines: engines)).rows(section))
        case .noChange: return "noChange"
        case .invalid(let reason): return "invalid: " + reason
        }
    }

    // Strings: the table, the English fallback and the placeholders.
    stringTable = [:]
    check("strings: a missing key falls back to the English text", L("Needs you") == "Needs you")
    check("strings: placeholders are filled", L("+{1} more", "3") == "+3 more" && L("Could not load {1}", "K01") == "Could not load K01")
    let parsed = parseStrings(Data("{\"lang\":\"zh\",\"strings\":{\"Needs you\":\"NY\",\"+{1} more\":\"D {1}!\",\"Edit\":\"\",\"x\":3}}".utf8))
    check("strings: the answer is read", parsed?["Needs you"] == "NY" && parsed?["x"] == nil && parsed?.count == 3)
    stringTable = parsed ?? [:]
    check("strings: a translated key is used", L("Needs you") == "NY")
    check("strings: a translated placeholder is filled", L("+{1} more", "4") == "D 4!")
    check("strings: an empty translation falls back", L("Edit") == "Edit")
    check("strings: an unknown key falls back", L("Working") == "Working")
    check("strings: a broken answer is refused", parseStrings(Data("[1,2]".utf8)) == nil && parseStrings(Data("nope".utf8)) == nil)
    stringTable = [:]
    check("strings: status labels go through the table", statusLabel("waiting_user") == "Needs you" && statusLabel("odd") == "odd")

    // Decoding the answer of GET /items.
    let json = """
    {"items":[{"key":"local:12","engine":"local","id":12,"parent_key":null,"title":"A","status":"waiting_user","custom_status":"c",
    "result":"","attention_reason":"why","pending":{"kind":"question","text":"Which one?"},"priority":"high","due_date":null,"sort_order":7.5,
    "updated_at":"x","created_at":"y","notes":"n"},
    {"key":"remote:7:3","engine":"remote:7","id":"3","parent_key":"remote:7:2","title":"B","status":"review","sort_order":2},
    {"title":"no key"}, 5],
    "engines":[{"key":"local","name":"MacBook","local":true,"color_index":0},{"key":"remote:7","name":"K01","local":false,"color_index":3}],
    "failed":["K02"],"host":"mac","updated_at":"z"}
    """
    let decoded = decodeItemList(Data(json.utf8))
    check("decode: items without a key are left out", decoded?.items.count == 2)
    check("decode: a numeric id becomes text", decoded?.items.first?.id == "12")
    check("decode: pending is the text of the object", decoded?.items.first?.pending == "Which one?")
    check("decode: sort_order, notes and the reason", decoded?.items.first?.sortOrder == 7.5 && decoded?.items.first?.notes == "n"
          && decoded?.items.first?.attentionReason == "why" && decoded?.items.first?.parentKey == "")
    check("decode: an item without notes keeps nil", decoded?.items.last?.notes == nil && decoded?.items.last?.parentKey == "remote:7:2")
    check("decode: engines and failed names", decoded?.engines.map { $0.name } == ["MacBook", "K01"] && decoded?.engines.last?.colorIndex == 3
          && decoded?.failed == ["K02"])
    check("decode: a list without items is refused", decodeItemList(Data("{\"error\":\"UNAUTHORIZED\"}".utf8)) == nil)
    check("decode: plain pending text is kept", decodeItem(["key": "local:1", "pending": "Allow?"])?.pending == "Allow?")

    // Grouping, counts and order.
    let grouped = summarize(listOf([
        it("local:1", "waiting_user", order: 1), it("local:2", "review", order: 9), it("local:3", "working"), it("local:4", "todo"),
        it("local:5", "done"), it("local:6", "failed"), it("local:7", "cancelled"), it("local:8", "mystery"),
    ], engines: []))
    check("groups: waiting_user and review are Needs you, waiting_user first", keys(grouped.needs) == "local:1 local:2")
    check("groups: working", keys(grouped.working) == "local:3")
    check("groups: todo and an unknown status are To do", Set(grouped.todo.map { $0.key }) == ["local:4", "local:8"])
    check("groups: done, failed and cancelled are only counted", grouped.done == 3)
    check("groups: unfinished leaves out done, failed and cancelled", grouped.unfinished == 5)
    check("groups: one engine shows no tags", grouped.needs.allSatisfy { $0.tag == nil })

    let engines3 = [EngineInfo(key: "remote:7", name: "K01", local: false, colorIndex: 3),
                    EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0),
                    EngineInfo(key: "remote:9", name: "A very long studio name", local: false, colorIndex: -1)]
    let blocks = summarize(listOf([
        it("remote:9:1", order: 99), it("remote:7:1", order: 50), it("local:1", order: 10), it("local:2", order: 30),
        it("remote:7:2", order: 70), it("remote:5:1", order: 100), it("local:3", order: 30),
    ], engines: engines3))
    check("order: local first, then the order of engines, then unlisted engines", keys(blocks.working)
          == "local:3 local:2 local:1 remote:7:2 remote:7:1 remote:9:1 remote:5:1")
    check("order: equal sort_order goes by the id, highest first", blocks.working.prefix(2).map { $0.key } == ["local:3", "local:2"])
    check("tags: shown with more than one engine, named and coloured", blocks.working.first?.tag == EngineTag(name: "MacBook", colorIndex: 0)
          && blocks.working.first { $0.key == "remote:7:1" }?.tag?.colorIndex == 3)
    check("tags: a long name is shortened, an unknown engine is neutral",
          blocks.working.first { $0.key == "remote:9:1" }?.tag == EngineTag(name: "A very lo\u{2026}", colorIndex: -1)
          && blocks.working.last?.tag == EngineTag(name: "remote:5", colorIndex: -1))
    check("tags: the palette is the page's", tagColors.count == 8 && tagColors[0] == 0x90caf9 && tagColors[7] == 0x9fa8da)

    let needsMix = summarize(listOf([it("local:1", "review", order: 90), it("remote:7:1", "waiting_user", order: 99),
                                     it("local:2", "waiting_user", order: 10), it("remote:7:2", "review", order: 5)]))
    check("order: in Needs you each engine has waiting_user before review", keys(needsMix.needs) == "local:2 local:1 remote:7:1 remote:7:2")
    check("Needs you counts waiting_user and review", needsMix.needs.count == 4 && needsMix.unfinished == 4)

    let tree = summarize(listOf([
        it("local:1", order: 10), it("local:2", parent: "local:1", order: 50), it("local:3", parent: "local:2", order: 40),
        it("local:4", parent: "local:1", order: 60), it("local:5", order: 30), it("local:6", "todo", parent: "local:1", order: 1),
        it("local:7", parent: "local:99", order: 20), it("remote:7:5", parent: "local:1", order: 1),
    ]))
    check("tree: children under their parent, depth first, siblings by sort_order",
          keys(tree.working) == "local:5 local:7 local:1 local:4 local:2 local:3 remote:7:5")
    check("tree: depth and the child mark", tree.working.map { $0.depth } == [0, 0, 0, 1, 1, 2, 0]
          && tree.working.first { $0.key == "local:3" }?.isChild == true)
    check("tree: a child of another section is a top-level row", tree.todo.first?.isChild == false && tree.todo.first?.siblingKey == "")
    check("tree: an unknown parent is a top-level row", tree.working.first { $0.key == "local:7" }?.siblingKey == "")
    check("tree: ancestors up through the block", tree.working.first { $0.key == "local:3" }?.ancestors == ["local:1", "local:2"])
    let cycle = summarize(listOf([it("local:1", parent: "local:2", order: 2), it("local:2", parent: "local:1", order: 1)]))
    check("tree: a cycle in the data still shows every row once", Set(cycle.working.map { $0.key }) == ["local:1", "local:2"]
          && cycle.working.count == 2)

    let lines = summarize(listOf([
        it("local:1", "waiting_user", custom: "Blocked", result: "r", reason: "a", pending: "p\nq"),
        it("local:2", "waiting_user", result: "r", reason: "a"), it("local:3", "review", result: "done it"),
    ]))
    check("rows: pending comes first on the second line, on one line", lines.needs.first { $0.key == "local:1" }?.detail == "p q")
    check("rows: then the attention reason, then the result", lines.needs.first { $0.key == "local:2" }?.detail == "a"
          && lines.needs.first { $0.key == "local:3" }?.detail == "done it")
    check("rows: the custom status is kept for the suffix", lines.needs.first { $0.key == "local:1" }?.custom == "Blocked")

    // Buttons.
    check("buttons: review gets Confirm and Reject", rowActions(for: it("local:1", "review")).map { $0.label } == ["Confirm", "Reject"])
    check("buttons: waiting_user gets Handled", rowActions(for: it("local:1", "waiting_user")).map { $0.label } == ["Handled"])
    check("buttons: other statuses get none", ["working", "todo", "done", "failed"].allSatisfy { rowActions(for: it("local:1", $0)).isEmpty })
    check("buttons: only Confirm is primary", [RowAction.confirm, .reject, .handled].map { $0.isPrimary } == [true, false, false])
    check("buttons: only Needs you rows carry them", lines.needs.allSatisfy { !$0.actions.isEmpty }
          && summarize(listOf([it("local:1", "working")])).working.allSatisfy { $0.actions.isEmpty })
    check("buttons: a status change alone changes the row",
          summarize(listOf([it("local:1", "review")])) != summarize(listOf([it("local:1", "waiting_user")])))

    // Links: which ones the window opens, and where.
    for good in ["https://example.com/pr/1", "http://127.0.0.1:3000/h5", "HTTPS://Example.com", "https://example.com:8443/a?b=c#d",
                 "/h5?task=1", "/", "/docs/a%20b"] {
        check("links: accepts \(good)", taskLink(good) == good)
    }
    for bad in ["javascript:alert(1)", "JavaScript:alert(1)", "ftp://example.com/file", "file:///etc/passwd", "mailto:a@example.com",
                "data:text/html,x", "//evil.example.com", "/\\evil.example.com", "/a\\b", "https://user:pw@example.com/",
                "https://user@example.com/", "https:///nohost", "https:example.com", "https://exa mple.com", "/a b", "/a\nb",
                "h5", "example.com", ""] {
        check("links: refuses \(bad.debugDescription)", taskLink(bad) == nil)
    }
    check("links: trimmed", taskLink("  /h5  ") == "/h5" && taskLink(" https://example.com/x\n") == "https://example.com/x")
    let linkBase = WidgetAPI(base: "http://127.0.0.1:3999/", token: nil).base
    check("links: a page path opens on the window's T-Agent", linkTarget("/h5?task=1", base: linkBase)?.absoluteString
          == "http://127.0.0.1:3999/h5?task=1")
    check("links: the root path too", linkTarget("/", base: linkBase)?.absoluteString == "http://127.0.0.1:3999/")
    check("links: a path cannot leave T-Agent", linkTarget("/@evil.example.com", base: linkBase)?.host == "127.0.0.1"
          && linkTarget("//evil.example.com", base: linkBase) == nil)
    check("links: a web address opens as it is", linkTarget("https://example.com/pr/1?a=b#c", base: linkBase)?.absoluteString
          == "https://example.com/pr/1?a=b#c")
    check("links: a refused link opens nothing", linkTarget("javascript:alert(1)", base: linkBase) == nil
          && linkTarget("ftp://example.com", base: linkBase) == nil)
    let decodedLink = decodeItem(["key": "local:1", "link_url": " https://example.com/a ", "link_label": "The\nPR"])
    check("links: read from the answer, the label on one line", decodedLink?.link == "https://example.com/a" && decodedLink?.linkLabel == "The PR")
    check("links: a refused, missing, null or non-text link is no link",
          [["link_url": "javascript:alert(1)"], [:], ["link_url": NSNull()], ["link_url": 5], ["link_url": ["text": "/h5"]]].allSatisfy {
              decodeItem($0.merging(["key": "local:1"]) { a, _ in a })?.link == "" })
    let linked = summarize(listOf([it("local:1", "waiting_user", link: "/a", label: "A"), it("local:2", link: "https://example.com/b"),
                                   it("local:3", "todo", link: "/c"), it("local:4", "todo")]))
    check("links: rows in every section carry their link", linked.needs.first?.link == "/a" && linked.needs.first?.linkTitle == "A"
          && linked.working.first?.link == "https://example.com/b" && linked.working.first?.linkTitle == "https://example.com/b"
          && linked.todo.first { $0.key == "local:3" }?.link == "/c" && linked.todo.first { $0.key == "local:4" }?.link == "")
    check("links: the link is not a server action", rowActions(for: it("local:1", "waiting_user", link: "/a")) == [.handled]
          && linked.working.first?.actions.isEmpty == true)
    check("links: a changed link changes the row", summarize(listOf([it("local:1", link: "/a")])) != summarize(listOf([it("local:1", link: "/b")])))

    // applyMove: the optimistic order.
    let flat = [it("local:1", order: 40), it("local:2", order: 30), it("local:3", order: 20), it("local:4", order: 10)]
    check("move: before", order(applyMove(flat, key: "local:4", spec: .before("local:2")), .working) == "local:1 local:4 local:2 local:3")
    check("move: after", order(applyMove(flat, key: "local:1", spec: .after("local:3")), .working) == "local:2 local:3 local:1 local:4")
    check("move: top", order(applyMove(flat, key: "local:3", spec: .top), .working) == "local:3 local:1 local:2 local:4")
    check("move: bottom", order(applyMove(flat, key: "local:2", spec: .bottom), .working) == "local:1 local:3 local:4 local:2")
    check("move: after the row above is no change", order(applyMove(flat, key: "local:2", spec: .after("local:1")), .working) == "noChange")
    check("move: top of the top is no change", order(applyMove(flat, key: "local:1", spec: .top), .working) == "noChange")
    check("move: next to itself is refused", order(applyMove(flat, key: "local:2", spec: .before("local:2")), .working).hasPrefix("invalid"))
    check("move: an unknown target is refused", order(applyMove(flat, key: "local:2", spec: .before("local:9")), .working) == "invalid: Unknown target")
    check("move: an unknown task is refused", order(applyMove(flat, key: "local:9", spec: .top), .working) == "invalid: Unknown task")
    let mixedEngines = flat + [it("remote:7:1", order: 100)]
    check("move: a target on another machine is refused", order(applyMove(mixedEngines, key: "local:2", spec: .before("remote:7:1")), .working)
          == "invalid: Target is on another machine")
    check("move: top stays inside the engine block", order(applyMove(mixedEngines, key: "local:3", spec: .top), .working)
          == "local:3 local:1 local:2 local:4 remote:7:1")
    let twoGroups = [it("local:1", "waiting_user", order: 5), it("local:2", "review", order: 9)]
    check("move: a target in another server group is refused", order(applyMove(twoGroups, key: "local:1", spec: .before("local:2")), .needs)
          == "invalid: Target is in another group")
    let family = [it("local:1", order: 60), it("local:5", order: 50), it("local:6", parent: "local:5", order: 40),
                  it("local:7", parent: "local:5", order: 30), it("local:8", parent: "local:7", order: 20), it("local:2", order: 10)]
    check("move: a parent takes its children", order(applyMove(family, key: "local:5", spec: .top), .working)
          == "local:5 local:6 local:7 local:8 local:1 local:2")
    check("move: after a parent goes below its children", order(applyMove(family, key: "local:1", spec: .after("local:5")), .working)
          == "local:5 local:6 local:7 local:8 local:1 local:2")
    check("move: a child among its siblings", order(applyMove(family, key: "local:7", spec: .before("local:6")), .working)
          == "local:1 local:5 local:7 local:8 local:6 local:2")
    check("move: a child next to a row of another parent is refused",
          order(applyMove(family, key: "local:6", spec: .before("local:1")), .working) == "invalid: Tasks have different parents")
    let statusBoard = [it("local:1", order: 30), it("local:2", order: 20), it("local:3", "todo", order: 10), it("local:4", "todo", order: 5)]
    check("move: with a status the task lands in its new section", order(applyMove(statusBoard, key: "local:3", spec: .before("local:2"),
                                                                            status: "working"), .working) == "local:1 local:3 local:2")
    check("move: with a status a target in the old section is refused",
          order(applyMove(statusBoard, key: "local:3", spec: .before("local:4"), status: "working"), .working).hasPrefix("invalid"))
    check("move: a status change in place is still a change", order(applyMove(statusBoard, key: "local:1", spec: .top, status: "done"), .working)
          == "local:2")
    check("move: the same status in place is no change", order(applyMove(statusBoard, key: "local:1", spec: .top, status: "working"), .working)
          == "noChange")
    if case .moved(let after) = applyMove(family, key: "local:5", spec: .top, status: "todo") {
        let moved = summarize(listOf(after))
        check("move: a parent that changes section leaves its children as top-level rows",
              keys(moved.todo) == "local:5" && keys(moved.working) == "local:1 local:6 local:7 local:8 local:2"
              && moved.working.first { $0.key == "local:6" }?.siblingKey == "")
    } else {
        check("move: a parent that changes section leaves its children as top-level rows", false)
    }

    // Drop decisions on their own.
    let dropRows = summarize(listOf(family + [it("remote:7:1", order: 99)])).working
    check("drop: top half is before", dropDecision(rows: dropRows, source: "local:2", over: "local:1", lowerHalf: false) == .place(.before("local:1")))
    check("drop: bottom half is after", dropDecision(rows: dropRows, source: "local:1", over: "local:2", lowerHalf: true) == .place(.after("local:2")))
    check("drop: on itself is no change", dropDecision(rows: dropRows, source: "local:1", over: "local:1", lowerHalf: true) == .noChange)
    check("drop: in place is no change", dropDecision(rows: dropRows, source: "local:2", over: "local:8", lowerHalf: true) == .place(.after("local:5"))
          || dropDecision(rows: dropRows, source: "local:2", over: "local:8", lowerHalf: true) == .noChange)
    check("drop: on its own child is no change", dropDecision(rows: dropRows, source: "local:5", over: "local:7", lowerHalf: false) == .noChange)
    check("drop: a child on a top-level row is refused", dropDecision(rows: dropRows, source: "local:6", over: "local:1", lowerHalf: false)
          == .invalid(.level))
    check("drop: on a sibling's child lands after the sibling", dropDecision(rows: dropRows, source: "local:1", over: "local:8", lowerHalf: false)
          == .place(.after("local:5")))
    check("drop: on a row of another machine is refused", dropDecision(rows: dropRows, source: "local:1", over: "remote:7:1", lowerHalf: false)
          == .invalid(.engine))
    let needsRows = summarize(listOf(twoGroups)).needs
    check("drop: on a row of another server group is refused", dropDecision(rows: needsRows, source: "local:1", over: "local:2", lowerHalf: true)
          == .invalid(.group))
    check("drop: the title of its own section is the top of its block", titleDrop(rows: dropRows, source: "local:2") == .place(.top)
          && titleDrop(rows: dropRows, source: "local:1") == .noChange && titleDrop(rows: dropRows, source: "local:6") == .invalid(.level))
    check("drop: the line goes under the whole block", insertionAnchor(rows: dropRows, spec: .after("local:5"))?.key == "local:8")
    check("drop: a plain before line is above", insertionAnchor(rows: dropRows, spec: .before("local:5"))?.below == false)
    check("drop: the refusals have messages", Refusal.engine.message == "Only within the same machine"
          && Refusal.level.message == "Only among tasks at the same level" && Refusal.group.message == "Only among tasks with the same status")
    check("drop: each section title gives its status", statusForDrop(it("local:1", "todo"), into: .needs) == "waiting_user"
          && statusForDrop(it("local:1", "todo"), into: .working) == "working" && statusForDrop(it("local:1"), into: .todo) == "todo"
          && statusForDrop(it("local:1"), into: .done) == "done")
    check("drop: its own section gives no status", statusForDrop(it("local:1", "review"), into: .needs) == nil
          && statusForDrop(it("local:1", "mystery"), into: .todo) == nil)

    // Requests: method, address, headers and body.
    func describe(_ built: URLRequest) -> String {
        let body = built.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? "-"
        let headers = ["Accept", "Content-Type", "Authorization"].map { "\($0)=\(built.value(forHTTPHeaderField: $0) ?? "-")" }.joined(separator: " ")
        return "\(built.httpMethod ?? "") \(built.url?.absoluteString ?? "") \(headers) \(body)"
    }
    let api = WidgetAPI(base: "http://127.0.0.1:3999/", token: " tok123 ")
    let auth = "Accept=application/json Content-Type=application/json Authorization=Bearer tok123"
    let authGet = "Accept=application/json Content-Type=- Authorization=Bearer tok123"
    let base = "http://127.0.0.1:3999/api/attention/widget"
    check("request: list", describe(api.itemsRequest) == "GET \(base)/items \(authGet) -")
    check("request: strings", describe(api.stringsRequest) == "GET \(base)/strings \(authGet) -")
    check("request: no token, no Authorization", WidgetAPI(base: "http://h:1", token: "").itemsRequest.value(forHTTPHeaderField: "Authorization") == nil)
    check("request: a bad base falls back to the default", WidgetAPI(base: "not a url", token: nil).base == defaultBaseURL
          && WidgetAPI(base: nil, token: nil).base == defaultBaseURL && WidgetAPI(base: "ftp://x", token: nil).base == defaultBaseURL)
    check("request: the timeout is 3 s and the cache is skipped", api.itemsRequest.timeoutInterval == 3
          && api.itemsRequest.cachePolicy == .reloadIgnoringLocalCacheData)
    check("request: keys are percent-encoded", WidgetAPI.encodeKey("remote:7:5") == "remote%3A7%3A5" && WidgetAPI.encodeKey("local:12") == "local%3A12"
          && WidgetAPI.encodeKey("a b/\u{00e9}") == "a%20b%2F%C3%A9")
    check("request: create on this machine", describe(api.createRequest(TaskDraft(title: " Write it "))) ==
          "POST \(base)/items \(auth) {\"engine\":\"local\",\"status\":\"todo\",\"title\":\"Write it\"}")
    check("request: create with a status and notes", describe(api.createRequest(TaskDraft(title: "a", status: "working", notes: "n/1"))) ==
          "POST \(base)/items \(auth) {\"engine\":\"local\",\"notes\":\"n/1\",\"status\":\"working\",\"title\":\"a\"}")
    check("request: edit is a PATCH of the fields", describe(api.updateRequest(key: "remote:7:5", fields: ["notes": "", "status": "todo"])) ==
          "PATCH \(base)/items/remote%3A7%3A5 \(auth) {\"notes\":\"\",\"status\":\"todo\"}")
    check("request: delete has no body", describe(api.deleteRequest(key: "local:5")) == "DELETE \(base)/items/local%3A5 \(authGet) -")
    check("request: move before", describe(api.moveRequest(key: "local:5", spec: .before("local:2"), status: nil)) ==
          "POST \(base)/items/local%3A5/move \(auth) {\"before_key\":\"local:2\"}")
    check("request: move after", describe(api.moveRequest(key: "local:5", spec: .after("local:2"), status: nil)) ==
          "POST \(base)/items/local%3A5/move \(auth) {\"after_key\":\"local:2\"}")
    check("request: move to the top with a status", describe(api.moveRequest(key: "local:5", spec: .top, status: "working")) ==
          "POST \(base)/items/local%3A5/move \(auth) {\"position\":\"top\",\"status\":\"working\"}")
    check("request: move to the bottom", describe(api.moveRequest(key: "local:5", spec: .bottom, status: nil)) ==
          "POST \(base)/items/local%3A5/move \(auth) {\"position\":\"bottom\"}")
    check("request: confirm", describe(api.actionRequest(key: "remote:7:5", action: .confirm)) == "POST \(base)/items/remote%3A7%3A5/confirm \(auth) {}")
    check("request: reject", describe(api.actionRequest(key: "remote:7:5", action: .reject)) == "POST \(base)/items/remote%3A7%3A5/reject \(auth) {}")
    check("request: handled", describe(api.actionRequest(key: "local:5", action: .handled)) == "POST \(base)/items/local%3A5/handled \(auth) {}")
    check("errors: the message of the answer", failureText(Data("{\"error\":\"HAS_CHILDREN\",\"message\":\"Has subtasks\"}".utf8), nil) == "Has subtasks")
    check("errors: the code when there is no message", failureText(Data("{\"error\":\"WRONG_STATUS\"}".utf8), nil) == "WRONG_STATUS")
    check("errors: no answer at all", failureText(nil, URLError(.timedOut)) == "Could not reach T-Agent"
          && failureText(Data("<html>".utf8), nil) == "T-Agent refused this change")

    // Edit diffs.
    func fieldKeys(_ a: TaskDraft, _ b: TaskDraft, notes: Bool = true) -> [String] { changedFields(original: a, edited: b, includeNotes: notes).keys.sorted() }
    let original = TaskDraft(title: "n", status: "working", customStatus: "c", notes: "m")
    check("form: nothing changed sends nothing", fieldKeys(original, original).isEmpty)
    check("form: only the name", fieldKeys(original, TaskDraft(title: "x", status: "working", customStatus: "c", notes: "m")) == ["title"])
    check("form: only the status", fieldKeys(original, TaskDraft(title: "n", status: "todo", customStatus: "c", notes: "m")) == ["status"])
    check("form: only the custom status", fieldKeys(original, TaskDraft(title: "n", status: "working", customStatus: "d", notes: "m")) == ["custom_status"])
    check("form: only the notes", fieldKeys(original, TaskDraft(title: "n", status: "working", customStatus: "c", notes: "z")) == ["notes"])
    check("form: several fields", fieldKeys(original, TaskDraft(title: "x", status: "working", customStatus: "", notes: "z"))
          == ["custom_status", "notes", "title"])
    check("form: spaces alone are no change", fieldKeys(original, TaskDraft(title: " n ", status: "working", customStatus: "c ", notes: " m")).isEmpty)
    check("form: clearing is sent as empty", changedFields(original: original, edited: TaskDraft(title: "n", status: "working", notes: "m"))["custom_status"]
          as? String == "")
    check("form: notes the form did not show are never sent", fieldKeys(original, TaskDraft(title: "n", status: "working", customStatus: "c"), notes: false).isEmpty)

    // The panel, in-process and off screen: rows, buttons and hit tests.
    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let holder = NSView(frame: NSRect(x: 0, y: 0, width: 296, height: 60))
    let rowView = TaskRowView(frame: holder.bounds)
    let button = ActionButton(.confirm)
    button.translatesAutoresizingMaskIntoConstraints = true
    button.frame = NSRect(x: 240, y: 0, width: 50, height: 20)
    holder.addSubview(rowView)
    rowView.addSubview(button)
    rowView.actionButtons = [button]
    check("hit: a press on a button goes to the button", rowView.hitTest(NSPoint(x: 260, y: 10)) === button)
    check("hit: a press beside the button goes to the row", rowView.hitTest(NSPoint(x: 100, y: 10)) === rowView)
    check("hit: a press outside the row goes nowhere", rowView.hitTest(NSPoint(x: 100, y: 90)) == nil)
    rowView.setActionsEnabled(false)
    check("hit: a disabled button still takes its press", rowView.hitTest(NSPoint(x: 260, y: 10)) === button && !button.isEnabled)
    check("hit: the button takes the first click", button.acceptsFirstMouse(for: nil))

    let mouse = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:1", token: "t"), parentPID: nil, options: options)
    var network: [URLRequest] = []
    var pending: [(Data?, Int) -> Void] = []
    mouse.requestHook = { request, _ in network.append(request) }
    let board = listOf([
        it("local:1", "waiting_user", order: 50), it("local:2", "waiting_user", order: 40), it("local:3", "review", order: 30),
        it("remote:7:1", "waiting_user", order: 90),
        it("local:4", order: 50), it("local:5", parent: "local:4", order: 45), it("local:6", order: 40), it("local:7", order: 30),
        it("remote:7:2", order: 80), it("remote:7:3", order: 70),
        it("local:8", "todo", order: 50), it("local:9", "todo", order: 40), it("local:10", "todo", order: 30),
        it("local:11", "done"), it("local:12", "failed"), it("remote:7:4", "cancelled"),
    ], failed: ["K02"])
    mouse.loadForTest(board)
    check("panel: the order of the board", mouse.testOrder == "needs[local:1 local:2 local:3 remote:7:1] "
          + "working[local:4 local:5 local:6 local:7 remote:7:2 remote:7:3] todo[local:8 local:9 local:10] done 3")
    check("capsule: open, Needs you and running", mouse.testCount == "13" && mouse.testBadge == "4" && mouse.testRunning == "0")
    check("capsule: the tooltip and VoiceOver label read the three numbers",
          mouse.testTooltip == "13 open · 4 need you · 0 running" && mouse.widgetRoot?.accessibilityLabel() == mouse.testTooltip)
    runCapsuleChecks(check)
    check("panel: section titles, the Finished header and the failed engine", mouse.testLines.contains("Needs you")
          && mouse.testLines.contains("Working") && mouse.testLines.contains("To do")
          && mouse.testLines.contains("Finished") && mouse.testLines.contains("Could not load K02"))
    check("panel: rows carry an engine tag with two engines", mouse.testHasPill("local:4") && mouse.testHasPill("remote:7:2"))
    check("panel: nothing was sent while loading", network.isEmpty)

    var placed: (String, MoveSpec, String?)?
    mouse.moveHook = { placed = ($0, $1, $2) }
    func drag(_ source: String, _ over: String, _ place: String, scroll: CGFloat = 0, list: ItemList? = nil) -> (MouseDragResult, MoveOutcome?) {
        placed = nil
        mouse.loadForTest(list ?? board, scroll: scroll)
        let result = mouse.sendMouseDrag(DebugDrag(source: source, over: over, lowerHalf: place == "bottom", onHeader: place == "header"))
        let outcome = placed.map { applyMove((list ?? board).items, key: $0.0, spec: $0.1, status: $0.2) }
        return (result, outcome)
    }
    func sectionOrder(_ outcome: MoveOutcome?, _ section: Section, engines: [EngineInfo] = twoEngines) -> String {
        guard let outcome = outcome else { return "no move" }
        return order(outcome, section, engines: engines)
    }
    func expectDrag(_ name: String, _ source: String, _ over: String, _ place: String, order expected: String, section: Section,
                    scroll: CGFloat = 0, list: ItemList? = nil) {
        let (result, outcome) = drag(source, over, place, scroll: scroll, list: list)
        let got = sectionOrder(outcome, section)
        let ok = result.hit == source && result.toast.isEmpty && got == expected
        check("mouse: \(name)" + (ok ? "" : " (hit \(result.hit), \(result.decision), toast '\(result.toast)', order '\(got)')"), ok)
    }
    func expectRefused(_ name: String, _ source: String, _ over: String, _ place: String, _ refusal: Refusal) {
        let (result, _) = drag(source, over, place)
        let ok = result.hit == source && result.decision == .invalid(refusal) && placed == nil && result.toast == refusal.message
            && mouse.testOrder.hasPrefix("needs[local:1 local:2 local:3 remote:7:1]")
        check("mouse: \(name)" + (ok ? "" : " (hit \(result.hit), \(result.decision), toast '\(result.toast)')"), ok)
    }
    expectDrag("needs first row down", "local:1", "local:2", "bottom", order: "local:2 local:1 local:3 remote:7:1", section: .needs)
    expectDrag("needs later row up", "local:2", "local:1", "top", order: "local:2 local:1 local:3 remote:7:1", section: .needs)
    expectDrag("needs row dropped on the section title", "local:2", "local:1", "header", order: "local:2 local:1 local:3 remote:7:1", section: .needs)
    expectRefused("needs row onto a review row is refused", "local:1", "local:3", "top", .group)
    expectRefused("a row onto another machine's row is refused and rolled back", "local:2", "remote:7:1", "top", .engine)
    expectDrag("working parent down, its child in tow", "local:4", "local:7", "bottom",
               order: "local:6 local:7 local:4 local:5 remote:7:2 remote:7:3", section: .working)
    expectDrag("working later row to the top slot", "local:7", "local:4", "top",
               order: "local:7 local:4 local:5 local:6 remote:7:2 remote:7:3", section: .working)
    expectDrag("working row dropped on the section title", "local:6", "local:4", "header",
               order: "local:6 local:4 local:5 local:7 remote:7:2 remote:7:3", section: .working)
    expectDrag("another machine's row reorders inside its own block", "remote:7:3", "remote:7:2", "top",
               order: "local:4 local:5 local:6 local:7 remote:7:3 remote:7:2", section: .working)
    expectDrag("over a sibling's child lands after that sibling", "local:7", "local:5", "top",
               order: "local:4 local:5 local:7 local:6 remote:7:2 remote:7:3", section: .working)
    let (childAway, _) = drag("local:5", "local:6", "bottom")
    check("mouse: a child dropped among top-level rows is refused", childAway.decision == .invalid(.level) && placed == nil
          && childAway.toast == Refusal.level.message)
    expectDrag("todo later row up", "local:10", "local:8", "top", order: "local:10 local:8 local:9", section: .todo)
    let (noOp, noOpOutcome) = drag("local:8", "local:8", "top")
    check("mouse: dropping a row on itself does nothing", noOp.decision == .noChange && noOp.toast.isEmpty && noOpOutcome == nil)
    let (pressOnText, _) = drag("local:3", "local:3", "top")
    check("mouse: a row with buttons still takes a press on its text", pressOnText.hit == "local:3")
    let tall = listOf(board.items + (40...75).map { it("local:\($0)", "todo", order: Double(-$0)) })
    let tallTail = (40...75).map { "local:\($0)" }.joined(separator: " ")
    expectDrag("scrolled list: a todo row down", "local:8", "local:9", "bottom", order: "local:9 local:8 local:10 " + tallTail,
               section: .todo, scroll: 200, list: tall)
    expectDrag("scrolled list: a todo row to the top slot", "local:10", "local:8", "top", order: "local:10 local:8 local:9 " + tallTail,
               section: .todo, scroll: 200, list: tall)

    // Dragging into another section changes the status.
    func status(_ outcome: MoveOutcome?, _ key: String) -> String {
        guard case .moved(let items)? = outcome, let item = items.first(where: { $0.key == key }) else { return "no move" }
        return item.status
    }
    func expectCross(_ name: String, _ source: String, _ over: String, _ place: String, status expected: String, hint: String,
                     order expected2: String, section: Section, list: ItemList? = nil) {
        let (result, outcome) = drag(source, over, place, list: list)
        let got = sectionOrder(outcome, section)
        let sent = placed?.2 ?? "none"
        let ok = result.hit == source && result.toast.isEmpty && got == expected2 && status(outcome, source) == expected
            && result.highlight == hint && sent == expected
        check("mouse cross-section: \(name)" + (ok ? "" : " (hit \(result.hit), \(result.decision), sent \(sent), status '\(status(outcome, source))', "
            + "highlight '\(result.highlight)', toast '\(result.toast)', order '\(got)')"), ok)
    }
    expectCross("todo row onto the Working title", "local:8", "@working", "header", status: "working", hint: "\u{2192} Working",
                order: "local:8 local:4 local:5 local:6 local:7 remote:7:2 remote:7:3", section: .working)
    if let (row, _) = Optional(drag("local:8", "@working", "header")) {
        check("mouse cross-section: the title drop is position top with the status", placed.map { $0.1 == .top && $0.2 == "working" } == true
              && row.lineShown)
    }
    expectCross("todo row between working rows", "local:9", "local:6", "top", status: "working", hint: "\u{2192} Working",
                order: "local:4 local:5 local:9 local:6 local:7 remote:7:2 remote:7:3", section: .working)
    let (crossEngine, _) = drag("local:9", "remote:7:2", "top")
    check("mouse cross-section: onto another machine's row is refused with a message", crossEngine.decision == .invalid(.engine)
          && placed == nil && crossEngine.toast == Refusal.engine.message)
    expectCross("working row onto the Needs you title", "local:6", "@needs", "header", status: "waiting_user", hint: "\u{2192} Needs you",
                order: "local:6 local:1 local:2 local:3 remote:7:1", section: .needs)
    let (ontoReview, _) = drag("local:6", "local:3", "top")
    check("mouse cross-section: onto a review row is refused", ontoReview.decision == .invalid(.group) && placed == nil)
    expectCross("working parent onto the Done line", "local:4", "@done", "top", status: "done", hint: "\u{2192} Done",
                order: "local:5 local:6 local:7 remote:7:2 remote:7:3", section: .working)
    expectCross("needs row onto the To do title", "local:1", "@todo", "header", status: "todo", hint: "\u{2192} To do",
                order: "local:1 local:8 local:9 local:10", section: .todo)
    expectCross("another machine's row goes to the top of its own block", "remote:7:1", "@working", "header", status: "working",
                hint: "\u{2192} Working", order: "local:4 local:5 local:6 local:7 remote:7:1 remote:7:2 remote:7:3", section: .working)
    expectCross("review row onto the Working title", "local:3", "@working", "header", status: "working", hint: "\u{2192} Working",
                order: "local:3 local:4 local:5 local:6 local:7 remote:7:2 remote:7:3", section: .working)
    let (ownTitle, _) = drag("local:7", "@working", "header")
    check("mouse: the own section's title is a plain reorder", ownTitle.decision == .place(.top) && ownTitle.highlight.isEmpty)
    let noTodo = listOf(board.items.filter { $0.status != "todo" })
    expectCross("working row into an empty To do", "local:6", "@todo", "header", status: "todo", hint: "\u{2192} To do",
                order: "local:6", section: .todo, list: noTodo)
    let (emptyLine, _) = drag("local:6", "@todo", "header", list: noTodo)
    check("mouse cross-section: an empty section shows the line under its title", emptyLine.lineShown)
    let (childOut, childOutcome) = drag("local:5", "@todo", "header")
    check("mouse cross-section: a child leaves its parent's section as a top-level row",
          childOut.decision == .change("todo", .top) && sectionOrder(childOutcome, .todo) == "local:5 local:8 local:9 local:10")
    check("mouse: no drag reached the network", network.isEmpty)

    // A real move through the controller: the optimistic order, the request, and the rollback with its message.
    mouse.moveHook = nil
    var answers: [String: (Data?, Int)] = [:]
    mouse.requestHook = { request, answer in
        network.append(request)
        if let known = answers[(request.httpMethod ?? "") + " " + (request.url?.path ?? "")] {
            answer(known.0, known.1)
        } else {
            pending.append(answer)
        }
    }
    mouse.loadForTest(board)
    network = []
    answers["POST /api/attention/widget/items/local:7/move"] = (Data("{\"error\":\"VALIDATION_FAILED\",\"message\":\"Target is in another group\"}".utf8), 400)
    _ = mouse.sendMouseDrag(DebugDrag(source: "local:7", over: "local:4", lowerHalf: false))
    let deadline = Date().addingTimeInterval(1)  // the move starts on the main queue after mouseUp
    while network.isEmpty && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
    check("move: the request is sent with the key and the place", network.count == 1 && describe(network[0])
          == "POST http://127.0.0.1:1/api/attention/widget/items/local%3A7/move Accept=application/json Content-Type=application/json "
          + "Authorization=Bearer t {\"before_key\":\"local:4\"}")
    check("move: a refused move rolls back and says why", mouse.testOrder.contains("working[local:4 local:5 local:6 local:7 ")
          && mouse.testToast == "Move failed: Target is in another group")

    // Buttons: the request, the double-click guard, the failure message and the refresh after success.
    mouse.loadForTest(board)
    network = []
    answers = [:]
    check("action: Handled sends its request", mouse.testPressButton("local:1", .handled) && network.count == 1
          && network[0].url?.absoluteString == "http://127.0.0.1:1/api/attention/widget/items/local%3A1/handled")
    check("action: the row's buttons are off while it is out", mouse.testButtonsEnabled("local:1") == [false] && mouse.testHolding())
    _ = mouse.testPressButton("local:1", .handled)
    check("action: a second press sends nothing", network.count == 1)
    if let answer = pending.popLast() { answer(Data("{\"error\":\"WRONG_STATUS\",\"message\":\"Not waiting\"}".utf8), 409) }
    check("action: a late refusal gives the buttons back and its message holds the panel", mouse.testToast == "Action failed: Not waiting"
          && mouse.testButtonsEnabled("local:1") == [true] && mouse.testHolding())
    mouse.loadForTest(board)
    network = []
    answers["POST /api/attention/widget/items/local:3/confirm"] = (Data("{\"error\":\"WRONG_STATUS\",\"message\":\"Not in review\"}".utf8), 409)
    _ = mouse.testPressButton("local:3", .confirm)
    check("action: a refused action shows the message and gives the buttons back", mouse.testToast == "Action failed: Not in review"
          && mouse.testButtonsEnabled("local:3") == [true, true])
    mouse.loadForTest(board)
    network = []
    var afterConfirm = board
    afterConfirm.items.removeAll { $0.key == "local:3" }
    answers["POST /api/attention/widget/items/local:3/reject"] = (Data("{}".utf8), 200)
    let refreshedItems: [[String: Any]] = afterConfirm.items.map { item in
        ["key": item.key, "status": item.status, "title": item.title, "sort_order": item.sortOrder, "parent_key": item.parentKey]
    }
    let refreshedEngines: [[String: Any]] = [["key": "local", "name": "MacBook", "local": true, "color_index": 0],
                                             ["key": "remote:7", "name": "K01", "color_index": 3]]
    let refreshed: [String: Any] = ["items": refreshedItems, "engines": refreshedEngines, "failed": ["K02"]]
    answers["GET /api/attention/widget/items"] = (try? JSONSerialization.data(withJSONObject: refreshed), 200)
    answers["GET /api/attention/widget/strings"] = (Data("{\"lang\":\"en\",\"strings\":{}}".utf8), 200)
    _ = mouse.testPressButton("local:3", .reject)
    check("action: success refreshes the list at once", network.map { $0.url?.path ?? "" }.contains("/api/attention/widget/items")
          && !mouse.testOrder.contains("local:3") && mouse.testCount == "12" && mouse.testBadge == "3" && mouse.testRunning == "0")
    check("strings: loaded once with the token", network.filter { $0.url?.path == "/api/attention/widget/strings" }.count == 1
          && network.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer t" })

    // Unreachable, the token refused, and the language table.
    mouse.testApply(nil)
    check("unreachable: open and Needs you are dashes, the rows stay", mouse.testCount == "\u{2013}" && mouse.testBadge == "\u{2013}"
          && mouse.testRunning == "0" && mouse.testWidgetWidth == widgetWidth && mouse.testWidgetHeight == widgetHeight)
    check("unreachable: the tooltip says why", mouse.testTooltip == "Could not reach T-Agent")
    check("unreachable: the panel says so", mouse.testLines == ["Could not reach T-Agent"])
    answers["GET /api/attention/widget/items"] = (Data("{\"error\":\"UNAUTHORIZED\"}".utf8), 401)
    mouse.testRefresh()
    check("unreachable: a refused token says so", mouse.testLines == ["T-Agent did not accept the widget token"] && mouse.testCount == "\u{2013}")
    mouse.loadForTest(board)
    stringTable = ["Needs you": "NY", "Finished": "D", "{1} open · {2} need you · {3} running": "O{1} N{2} R{3}", "Quit": "Q"]
    mouse.testStringsChanged()
    check("strings: the panel uses the loaded table", mouse.testLines.contains("NY") && mouse.testLines.contains("D")
          && mouse.testTooltip == "O13 N4 R0" && mouse.testPanelMenuTitles() == ["Q"])
    stringTable = [:]
    mouse.testStringsChanged()
    check("strings: the English text comes back without a table", mouse.testLines.contains("Needs you") && mouse.testTooltip == "13 open · 4 need you · 0 running")
    let empty = WidgetController(api: WidgetAPI(base: nil, token: nil), parentPID: nil, options: options)
    empty.requestHook = { _, _ in }
    empty.loadForTest(listOf([it("local:1", "todo")], engines: [EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0)]))
    check("panel: an empty Needs you says so", empty.testLines.contains("Nothing needs you") && empty.testLines.contains("None"))
    check("panel: one engine shows no tag", !empty.testHasPill("local:1") && empty.testBadge == "0")

    // The Open link button: only on rows with a link, beside the text when it fits, and a click opens the browser only.
    let links = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:3999", token: "t"), parentPID: nil, options: options)
    var linkRequests: [URLRequest] = []
    var opened: [String] = []
    links.requestHook = { request, _ in linkRequests.append(request) }
    links.openURL = { opened.append($0.absoluteString) }
    let longTitle = "A long task title that takes the whole width of the panel"
    links.loadForTest(listOf([
        it("local:1", "waiting_user", order: 50, pending: "Allow it?", link: "https://example.com/pr/1", label: "The PR"),
        it("local:2", "review", order: 40, result: "ok", link: "/h5?task=2"),
        it("local:3", "waiting_user", order: 30, pending: "Allow it?"),
        it("local:4", order: 50, title: "Short", link: "https://example.com/logs"),
        it("remote:7:1", order: 40, title: "Short", link: "/x"),
        it("local:5", order: 30, title: "Short"),
        it("local:6", "todo", order: 20, title: longTitle, link: "https://example.com/long"),
        it("local:7", "todo", order: 10, title: "Bad", link: "javascript:alert(1)"),
    ]))
    let linkOrder = links.testOrder
    check("link button: on rows with a link, first", links.testButtonTitles("local:1") == ["Open link", "Handled"]
          && links.testButtonTitles("local:2") == ["Open link", "Confirm", "Reject"] && links.testButtonTitles("local:4") == ["Open link"]
          && links.testButtonTitles("local:6") == ["Open link"])
    check("link button: none without a link or with a refused one", links.testButtonTitles("local:3") == ["Handled"]
          && links.testButtonTitles("local:5").isEmpty && links.testButtonTitles("local:7").isEmpty)
    check("link button: the tooltip is the label, else the address", links.testButton("local:1", .link)?.toolTip == "The PR"
          && links.testButton("local:2", .link)?.toolTip == "/h5?task=2" && links.testButton("local:4", .link)?.toolTip == "https://example.com/logs")
    check("link button: the accessibility label names the link", links.testButton("local:1", .link)?.accessibilityLabel() == "Open link: The PR"
          && links.testButton("local:2", .link)?.accessibilityLabel() == "Open link: /h5?task=2")
    check("link button: inside its row, clear of the tag and the other buttons",
          ["local:1", "local:2", "local:4", "remote:7:1", "local:6"].allSatisfy { links.testButtonsInside($0) })
    check("link button: on the title line, whether the title is short or long", links.testRowHeight("local:4") == rowIconSize
          && links.testRowHeight("remote:7:1") == rowIconSize && links.testRowHeight("local:6") == rowIconSize)
    check("row: a long title stays on one line with an ellipsis, the full title in the tooltip", links.testTitleTruncated("local:6")
          && !links.testTitleTruncated("local:4") && links.testRowTooltip("local:6") == longTitle)
    check("link button: the panel gives its press to the button, not the row", links.testButtonTakesPress("local:4", .link)
          && links.testButtonTakesPress("remote:7:1", .link) && links.testButtonTakesPress("local:1", .link))
    check("link button: a click opens the address", links.testPressButton("local:1", .link) && opened == ["https://example.com/pr/1"])
    check("link button: a page path opens on this T-Agent", links.testPressButton("local:2", .link)
          && opened.last == "http://127.0.0.1:3999/h5?task=2")
    check("link button: a click sends nothing and leaves the row alone", linkRequests.isEmpty && !links.testHolding()
          && links.testOrder == linkOrder && links.testButtonTitles("local:1") == ["Open link", "Handled"])
    check("link menu: a row with a link offers Open link", links.testMenuTitles("local:4") == ["Open link", "Edit", "Delete", "Quit"]
          && links.testMenuTitles("local:5") == ["Edit", "Delete", "Quit"])
    _ = links.testOpenFromRowMenu("local:4", "Open link")
    check("link menu: Open link opens it", opened.last == "https://example.com/logs" && linkRequests.isEmpty)
    stringTable = ["Open link": "OL", "Open link: {1}": "OL: {1}"]
    links.testStringsChanged()
    check("link button: its words come from the table", links.testButtonTitles("local:4") == ["OL"]
          && links.testButton("local:4", .link)?.accessibilityLabel() == "OL: https://example.com/logs")
    stringTable = [:]
    links.testStringsChanged()
    _ = links.testPressButton("local:1", .handled)
    check("link button: stays on while the row's action is out", linkRequests.count == 1 && links.testButtonsEnabled("local:1") == [true, false])

    // Menus, the form and the delete question, off screen and without keyboard focus.
    let crud = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:1", token: "t"), parentPID: nil, options: options)
    var sent: [URLRequest] = []
    var crudAnswer: (Data?, Int)?
    crud.requestHook = { request, answer in
        sent.append(request)
        if request.httpMethod != "GET", let known = crudAnswer { answer(known.0, known.1) }
    }
    let crudBoard = listOf([it("local:1"), it("local:2", parent: "local:1"), it("local:3", "review"), it("local:4", "todo"),
                            it("local:5", "todo", title: "Name", custom: "Custom", notes: "Old notes"),
                            it("local:6", "todo", title: "No notes", notes: nil)])
    crud.loadForTest(crudBoard)
    check("menu: a row has Edit, Delete and Quit", crud.testMenuTitles("local:4") == ["Edit", "Delete", "Quit"])
    check("menu: an action button opens the row's menu", crud.testButtonMenuTitles("local:3") == ["Confirm", "Reject", "Edit", "Delete", "Quit"])
    check("menu: off a row only Quit", crud.testPanelMenuTitles() == ["Quit"])
    check("menu: the row takes the right click", crud.testHitAtRow("local:4") is TaskRowView)
    check("menu: the + button takes its click", crud.testPlusHit)
    check("the panel takes no keyboard without a form", !crud.testPanelCanBecomeKey)
    crud.testMenuOpen = true
    check("an open menu holds the panel", crud.testHolding())
    crud.testMenuOpen = false

    guard let create = crud.testOpenCreate() else {
        check("+ opens a form", false)
        exit(1)
    }
    check("form: + opens a form that holds the panel", crud.testHolding())
    check("form: its window can become key", crud.testPanelCanBecomeKey)
    check("form: create defaults to To do", create.selectedStatus == "todo" && create.statusPopup.titleOfSelectedItem == "To do")
    check("form: the status menu lists every status by its label", create.statusPopup.itemTitles
          == ["To do", "Working", "Needs you", "Review", "Done", "Failed", "Cancelled"])
    check("form: create has no custom status field", create.customField.superview == nil && create.notesField.superview != nil)
    check("form: the name field holds the focus", create.nameField.currentEditor() != nil)
    let noCommand = NSTextView()
    func press(_ form: TaskFormView, _ selector: Selector, in view: NSTextView? = nil) -> Bool {
        form.control(form.nameField, textView: view ?? noCommand, doCommandBy: selector)
    }
    check("form: Return with no name is refused", press(create, #selector(NSResponder.insertNewline(_:))) && sent.isEmpty && crud.testOverlay === create)
    check("form: save starts disabled", !create.saveButton.isEnabled)
    guard let editor = create.nameField.currentEditor() as? NSTextView else {
        check("form: the name field has an editor", false)
        exit(1)
    }
    let nowhere = NSRange(location: NSNotFound, length: 0)
    let typed = "\u{5468}\u{62a5}"
    editor.insertText(typed, replacementRange: nowhere)
    check("form: typing reaches the field", create.draft.title == typed && create.saveButton.isEnabled)
    editor.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0), replacementRange: nowhere)
    check("form: a composition is held by the field editor", editor.hasMarkedText() && editor.string == typed + "ni")
    check("form: Return during a composition stays with the input method",
          !press(create, #selector(NSResponder.insertNewline(_:)), in: editor) && sent.isEmpty)
    check("form: Esc during a composition stays with the input method",
          !press(create, #selector(NSResponder.cancelOperation(_:)), in: editor) && crud.testOverlay === create)
    crud.testApply(listOf(crudBoard.items + [it("local:9", "todo")]))
    check("form: a refresh leaves the composition alone", crud.testOverlay === create && editor.hasMarkedText() && editor.string == typed + "ni")
    editor.insertText("\u{4f60}", replacementRange: editor.markedRange())
    check("form: the composition commits into the field", !editor.hasMarkedText() && create.draft.title == typed + "\u{4f60}")
    create.selectStatus("working")
    check("form: Return submits a valid form", press(create, #selector(NSResponder.insertNewline(_:))) && sent.count == 1
          && describe(sent[0]) == "POST http://127.0.0.1:1/api/attention/widget/items Accept=application/json Content-Type=application/json "
          + "Authorization=Bearer t {\"engine\":\"local\",\"status\":\"working\",\"title\":\"\(typed)\u{4f60}\"}")
    check("form: a save in flight disables save", create.busy && !create.saveButton.isEnabled)
    check("form: a second Return while saving sends nothing", press(create, #selector(NSResponder.insertNewline(_:))) && sent.count == 1)
    check("form: Esc while saving keeps the form", press(create, #selector(NSResponder.cancelOperation(_:))) && crud.testOverlay === create)
    crud.requestFinished(create, failure: "boom")
    check("form: a failed save keeps the form and its text", crud.testOverlay === create && create.draft.title == typed + "\u{4f60}"
          && !create.busy && create.saveButton.isEnabled)
    check("form: a failed save shows the error", crud.testToast == "Save failed: boom")
    check("form: Esc cancels", press(create, #selector(NSResponder.cancelOperation(_:))) && crud.testOverlay == nil)
    check("form: closing gives up the keyboard", !crud.testPanelCanBecomeKey)
    sent = []

    crud.loadForTest(crudBoard)
    guard let edit = crud.testOpenFromRowMenu("local:5", "Edit") as? TaskFormView else {
        check("edit: opens a form", false)
        exit(1)
    }
    check("edit: the form is prefilled", edit.draft == TaskDraft(title: "Name", status: "todo", customStatus: "Custom", notes: "Old notes"))
    check("edit: the custom status field is shown", edit.customField.superview != nil)
    _ = press(edit, #selector(NSResponder.insertNewline(_:)))
    check("edit: an unchanged edit closes without a request", crud.testOverlay == nil && sent.isEmpty)
    guard let edit2 = crud.testOpenFromRowMenu("local:5", "Edit") as? TaskFormView else {
        check("edit: reopens", false)
        exit(1)
    }
    edit2.notesField.stringValue = "New notes"
    edit2.selectStatus("working")
    _ = press(edit2, #selector(NSResponder.insertNewline(_:)))
    check("edit: only the changed fields are sent", sent.count == 1 && describe(sent[0])
          == "PATCH http://127.0.0.1:1/api/attention/widget/items/local%3A5 Accept=application/json Content-Type=application/json "
          + "Authorization=Bearer t {\"notes\":\"New notes\",\"status\":\"working\"}")
    crud.requestFinished(edit2, failure: "bad")
    check("edit: a failed edit keeps the form", crud.testOverlay === edit2 && edit2.draft.notes == "New notes")
    crud.testClose()
    sent = []
    guard let edit3 = crud.testOpenFromRowMenu("local:6", "Edit") as? TaskFormView else {
        check("edit: a task without notes opens a form", false)
        exit(1)
    }
    check("edit: without notes in the answer the notes field is left out", edit3.notesField.superview == nil && !edit3.showsNotes)
    edit3.customField.stringValue = "Waiting"
    _ = press(edit3, #selector(NSResponder.insertNewline(_:)))
    check("edit: and notes are never sent", sent.count == 1 && String(data: sent[0].httpBody ?? Data(), encoding: .utf8) == "{\"custom_status\":\"Waiting\"}")
    crud.testClose()
    sent = []

    guard let confirm = crud.testOpenFromRowMenu("local:5", "Delete") as? DeleteConfirmView else {
        check("delete: opens a question", false)
        exit(1)
    }
    check("delete: the question names the task", confirm.message.stringValue == "Delete this task?\nName")
    check("delete: the question holds the panel but takes no keyboard", crud.testHolding() && !crud.testPanelCanBecomeKey)
    check("delete: nothing is sent before it is answered", sent.isEmpty)
    confirm.cancelButton.performClick(nil)
    check("delete: Cancel closes the question with no request", crud.testOverlay == nil && sent.isEmpty)
    guard let confirm2 = crud.testOpenFromRowMenu("local:1", "Delete") as? DeleteConfirmView else {
        check("delete: reopens", false)
        exit(1)
    }
    crudAnswer = (Data("{\"error\":\"HAS_CHILDREN\",\"message\":\"Task has subtasks\",\"children\":[2]}".utf8), 409)
    confirm2.deleteButton.performClick(nil)
    check("delete: Delete sends DELETE", sent.count == 1 && describe(sent[0])
          == "DELETE http://127.0.0.1:1/api/attention/widget/items/local%3A1 Accept=application/json Content-Type=- Authorization=Bearer t -")
    check("delete: a 409 closes the question and shows the reason", crud.testOverlay == nil && crud.testToast == "Delete failed: Task has subtasks")
    crudAnswer = (nil, 204)
    sent = []
    if let confirm3 = crud.testOpenFromRowMenu("local:4", "Delete") as? DeleteConfirmView {
        confirm3.deleteButton.performClick(nil)
        check("delete: a 204 closes the question and refreshes", crud.testOverlay == nil
              && sent.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }.contains("GET /api/attention/widget/items"))
    } else {
        check("delete: a 204 closes the question and refreshes", false)
    }

    // Notices: reading the answer, polling, the bubble's place, clicks, timing, the queue.
    let noticeJSON = """
    {"seq":14,"notices":[
    {"seq":12,"at":"2026-11-17T08:00:00.000Z","kind":"item","title":" Approve the deploy ","text":"Which environment?\\n\\n  (may be multi-line) ",
     "from":"T01 \u{00B7} SELF-TAGENT","status":"waiting_user","key":"local:12","target":"https://example.com/h5?attention=12","seconds":5},
    {"seq":13,"title":"Bare"},
    {"seq":"14","kind":"DIRECT","text":"Only a text\\nsecond line","from":null,"status":null,"key":null,"target":null,"seconds":0},
    {"seq":15,"title":"","text":"  "}, {"seq":16}, 7, "x"]}
    """
    let noticeAnswer = decodeNotices(Data(noticeJSON.utf8))
    let first = noticeAnswer?.notices.first
    check("notices: the answer is read, notices without words are left out", noticeAnswer?.seq == 14 && noticeAnswer?.notices.count == 3)
    check("notices: every field of a full notice", first == WidgetNotice(seq: 12, kind: "item", title: "Approve the deploy",
          text: "Which environment?\n(may be multi-line)", from: "T01 \u{00B7} SELF-TAGENT", status: "waiting_user", key: "local:12",
          target: "https://example.com/h5?attention=12", seconds: 5))
    check("notices: missing fields get their defaults", noticeAnswer?.notices[1] == WidgetNotice(seq: 13, title: "Bare"))
    check("notices: a text without a title becomes the title", noticeAnswer?.notices[2].title == "Only a text second line"
          && noticeAnswer?.notices[2].text == "" && noticeAnswer?.notices[2].kind == "direct" && noticeAnswer?.notices[2].seq == 14
          && noticeAnswer?.notices[2].seconds == 0 && noticeAnswer?.notices[2].target == "")
    check("notices: only http(s) targets with a host", ["javascript:alert(1)", "ftp://example.com/x", "/h5?attention=1", "file:///etc/hosts",
          "http://user:pw@example.com/", "https://", "http://exa mple.com"].allSatisfy { decodeNotice(["title": "t", "target": $0])?.target == "" }
          && decodeNotice(["title": "t", "target": "http://127.0.0.1:3000/"])?.target == "http://127.0.0.1:3000/"
          && decodeNotice(["title": "t", "target": 5])?.target == "")
    check("notices: seconds default to 8, 0 stays, the rest is capped", noticeSeconds(nil) == 8 && noticeSeconds("abc") == 8
          && noticeSeconds(-1) == 8 && noticeSeconds(Double.nan) == 8 && noticeSeconds(true) == 8 && noticeSeconds(0) == 0
          && noticeSeconds("12") == 12 && noticeSeconds(99999) == 3600)
    check("notices: a broken answer is refused", decodeNotices(Data("[1]".utf8)) == nil && decodeNotices(Data("{\"seq\":1}".utf8)) == nil
          && decodeNotices(Data("nope".utf8)) == nil)
    check("notices: the dot colour follows the status", [("waiting_user", "orange"), ("review", "blue"), ("done", "green"),
          ("failed", "red"), ("working", "teal"), ("", "neutral"), ("odd", "neutral")].allSatisfy { noticeTone(WidgetNotice(status: $0.0)) == $0.1 }
          && noticeTone(WidgetNotice(kind: "direct", title: "x")) == "neutral")
    check("request: notices, first without after, then after the last seq",
          describe(api.noticesRequest(after: nil)) == "GET \(base)/notices \(authGet) -"
          && describe(api.noticesRequest(after: 12)) == "GET \(base)/notices?after=12 \(authGet) -")

    let bubbles = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:3999", token: "t"), parentPID: nil, options: options)
    var noticeRequests: [String] = []
    var noticeAnswers: [(Data?, Int) -> Void] = []
    var bubbleOpened: [String] = []
    var announced: [String] = []
    var clock = Date(timeIntervalSince1970: 1_000_000)
    var motionReduced = false
    bubbles.requestHook = { request, answer in
        noticeRequests.append(request.url.map { $0.path + ($0.query.map { "?" + $0 } ?? "") } ?? "")
        noticeAnswers.append(answer)
    }
    bubbles.openURL = { bubbleOpened.append($0.absoluteString) }
    bubbles.announce = { announced.append($0) }
    bubbles.now = { clock }
    bubbles.reduceMotion = { motionReduced }
    bubbles.loadForTest(listOf([it("local:1", "waiting_user")]))
    func answerNotices(_ body: String, _ code: Int = 200) {
        guard !noticeAnswers.isEmpty else { return }
        noticeAnswers.removeFirst()(Data(body.utf8), code)
    }
    func noticeBody(_ seq: Int, _ notices: [[String: Any]]) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: ["seq": seq, "notices": notices] as [String: Any]), encoding: .utf8)!
    }
    bubbles.pollNotices()
    check("poll: the first call has no after", noticeRequests == ["/api/attention/widget/notices"])
    bubbles.pollNotices()
    check("poll: one request at a time", noticeRequests.count == 1)
    answerNotices(noticeBody(5, [["seq": 5, "title": "Approve", "text": "Which one?", "status": "waiting_user", "key": "local:5",
                                  "target": "https://example.com/t/5", "seconds": 8, "from": "T01"]]))
    check("poll: a notice shows the bubble", bubbles.testBubbleTitle == "Approve" && bubbles.testLastSeq == 5)
    check("bubble: announced to VoiceOver with its title and text", announced == ["Approve. Which one?"])
    check("bubble: the panel never takes the keyboard", !bubbles.testBubbleCanBecomeKey)
    check("bubble: the x has its label and tooltip", bubbles.testBubbleView?.closeButton.accessibilityLabel() == "Close"
          && bubbles.testBubbleView?.closeButton.toolTip == "Close")
    check("bubble: the tooltip is the target", bubbles.testBubbleView?.toolTip == "https://example.com/t/5")
    check("bubble: it slides in", bubbles.testBubbleSlides)
    bubbles.pollNotices()
    check("poll: later calls ask after the last seq", noticeRequests.last == "/api/attention/widget/notices?after=5")
    answerNotices("{}", 500)
    bubbles.pollNotices()
    check("poll: a failure keeps the seq and tries again on the next tick", noticeRequests.count == 3
          && noticeRequests.last == "/api/attention/widget/notices?after=5" && bubbles.testLastSeq == 5)
    answerNotices(noticeBody(5, [["seq": 4, "title": "Old"], ["seq": 5, "title": "Seen"]]))
    check("poll: notices already seen are not shown again", bubbles.testNoticesWaiting == 0 && bubbles.testBubbleTitle == "Approve")

    // The place: toward the middle of the screen, top level with the window, inside the visible frame.
    let screen = NSRect(x: 0, y: 0, width: 1440, height: 875)
    let bubbleSize = NSSize(width: bubbleWidth, height: 90)
    let rightPill = NSRect(x: 1386, y: 769, width: widgetWidth, height: widgetHeight)
    let leftPill = NSRect(x: 16, y: 769, width: widgetWidth, height: widgetHeight)
    let atRight = bubbleFrame(size: bubbleSize, pill: rightPill, anchor: rightPill, visible: screen)
    let atLeft = bubbleFrame(size: bubbleSize, pill: leftPill, anchor: leftPill, visible: screen)
    check("place: a window in the right half gets the bubble on its left", atRight.toLeft && atRight.frame.maxX == rightPill.minX - panelGap
          && atRight.frame.maxY == rightPill.maxY)
    check("place: a window in the left half gets it on its right", !atLeft.toLeft && atLeft.frame.minX == leftPill.maxX + panelGap
          && atLeft.frame.maxY == leftPill.maxY)
    let lowPill = NSRect(x: 16, y: 0, width: widgetWidth, height: widgetHeight)
    let low = bubbleFrame(size: bubbleSize, pill: lowPill, anchor: lowPill, visible: screen)
    let narrow = bubbleFrame(size: bubbleSize, pill: NSRect(x: 250, y: 500, width: widgetWidth, height: widgetHeight),
                             anchor: NSRect(x: 250, y: 500, width: widgetWidth, height: widgetHeight), visible: NSRect(x: 0, y: 0, width: 400, height: 875))
    check("place: kept inside the visible frame", low.frame.minY == screen.minY + screenMargin && narrow.toLeft
          && narrow.frame.minX == screenMargin)
    let withPanel = bubbleFrame(size: bubbleSize, pill: NSRect(x: 900, y: 769, width: widgetWidth, height: widgetHeight),
                                anchor: NSRect(x: 900, y: 600, width: 334, height: 259), visible: screen)
    check("place: beside the open panel, never over it", withPanel.toLeft && withPanel.frame.maxX == 900 - panelGap)
    let shown = NSRect(x: 100, y: 100, width: 280, height: 90)
    check("place: the slide starts toward the window", bubbleStartFrame(shown, toLeft: true, reduceMotion: false).minX == 100 + bubbleSlide
          && bubbleStartFrame(shown, toLeft: false, reduceMotion: false).minX == 100 - bubbleSlide)
    check("place: reduced motion has no slide", bubbleStartFrame(shown, toLeft: true, reduceMotion: true) == shown)
    bubbles.testPlaceWidget(right: true)
    check("place: the bubble sits left of a window at the right", bubbles.testBubbleFrame.maxX <= bubbles.testWidgetFrame.minX
          && abs(bubbles.testBubbleFrame.maxY - bubbles.testWidgetFrame.maxY) < 0.5)
    let leftOrigin = NSPoint(x: (NSScreen.main?.visibleFrame.minX ?? 0) + 40, y: bubbles.testWidgetFrame.minY - 100)
    bubbles.testDragWidget(to: leftOrigin)
    check("place: the bubble follows a drag to the other side", bubbles.testBubbleFrame.minX >= bubbles.testWidgetFrame.maxX
          && abs(bubbles.testBubbleFrame.maxY - bubbles.testWidgetFrame.maxY) < 0.5)

    // Clicks.
    check("hit: a press on the text goes to the bubble, the x takes its own", bubbles.testBubbleHit(NSPoint(x: 60, y: 20)) is NoticeBubbleView
          && bubbles.testBubbleHit(NSPoint(x: bubbleWidth - 17, y: (bubbles.testBubbleView?.bounds.height ?? 0) - 17)) is BubbleCloseButton
          && bubbles.testBubbleView?.acceptsFirstMouse(for: nil) == true)
    let requestsBeforeClick = noticeRequests.count
    bubbles.testBubblePress()
    check("click: opens the target and closes the bubble", bubbleOpened == ["https://example.com/t/5"] && bubbles.testBubbleTitle == nil
          && noticeRequests.count == requestsBeforeClick)
    bubbles.testShowNotices([WidgetNotice(seq: 6, kind: "test", title: "Test notice")])
    check("bubble: without a target the tooltip offers T-Agent", bubbles.testBubbleView?.toolTip == "Open T-Agent")
    bubbles.testBubbleClick()
    check("click: without a target opens the T-Agent page", bubbleOpened.last == "http://127.0.0.1:3999/" && bubbles.testBubbleTitle == nil)
    bubbles.testShowNotices([WidgetNotice(seq: 7, title: "Close me", target: "https://example.com/x")])
    bubbles.testBubbleClose()
    check("click: the x closes without opening anything", bubbles.testBubbleTitle == nil && bubbleOpened.count == 2)
    // With T-Agent.app installed the page root opens in the app; an external target still opens in the browser.
    bubbles.appInstalled = { true }
    bubbles.testShowNotices([WidgetNotice(seq: 10, kind: "test", title: "To the app")])
    bubbles.testBubbleClick()
    bubbles.testShowNotices([WidgetNotice(seq: 11, title: "External", target: "https://example.com/y")])
    bubbles.testBubbleClick()
    check("click: with the app, the T-Agent page opens in it and an external target in the browser",
          Array(bubbleOpened.suffix(2)) == ["t-agent://open?path=%2F", "https://example.com/y"])
    bubbles.appInstalled = { false }

    // Timing.
    bubbles.testShowNotices([WidgetNotice(seq: 8, title: "Timed", seconds: 8), WidgetNotice(seq: 9, title: "Sticky", seconds: 0)])
    check("timer: runs for the notice's seconds", bubbles.testBubbleTitle == "Timed" && bubbles.testBubbleSeconds == 8)
    bubbles.testBubbleEnter()
    check("timer: the pointer over the bubble pauses it", bubbles.testBubbleSeconds == nil)
    bubbles.testBubbleTimeout()
    check("timer: a paused bubble stays", bubbles.testBubbleTitle == "Timed")
    bubbles.testBubbleExit()
    check("timer: leaving starts the full time again", bubbles.testBubbleSeconds == 8)
    bubbles.testBubbleTimeout()
    check("timer: when it runs out the next notice comes", bubbles.testBubbleTitle == "Sticky")
    check("timer: 0 seconds stays until closed", bubbles.testBubbleSeconds == nil)
    bubbles.testBubbleClose()
    check("queue: closing the last notice hides the bubble", bubbles.testBubbleView == nil)

    // The queue.
    var queue = NoticeQueue()
    queue.add([WidgetNotice(seq: 1, title: "a", key: "local:1"), WidgetNotice(seq: 2, title: "b", key: "local:2"),
               WidgetNotice(seq: 3, title: "a2", key: "local:1")])
    check("queue: a newer notice of the same task replaces the waiting one", queue.waiting.map { $0.title } == ["b", "a2"])
    check("queue: oldest first, one at a time", queue.advance()?.title == "b" && queue.more == 0 && queue.advance()?.title == "a2"
          && queue.advance() == nil && queue.current == nil)
    queue.add((1...3).map { WidgetNotice(seq: $0, title: "n\($0)") })
    check("queue: up to three wait their turn", queue.advance()?.title == "n1" && queue.more == 0 && queue.waiting.count == 2)
    queue.clear()
    queue.add((1...4).map { WidgetNotice(seq: $0, title: "n\($0)") })
    check("queue: more than three collapse to the newest", queue.advance()?.title == "n4" && queue.more == 3 && queue.waiting.isEmpty)
    bubbles.pollNotices()
    answerNotices(noticeBody(25, (20...25).map { ["seq": $0, "title": "Notice \($0)"] }))
    check("queue: the bubble shows the newest with +N more", bubbles.testBubbleTitle == "Notice 25" && bubbles.testBubbleMore == "+5 more"
          && bubbles.testLastSeq == 25)
    bubbles.testBubbleClose()
    stringTable = ["+{1} more": "M{1}", "Close": "X"]
    bubbles.testShowNotices((30...34).map { WidgetNotice(seq: $0, title: "N\($0)") })
    check("strings: the bubble's words come from the table", bubbles.testBubbleMore == "M4"
          && bubbles.testBubbleView?.closeButton.accessibilityLabel() == "X")
    stringTable = [:]
    bubbles.testBubbleClose()

    // A restarted server, a 404 and reduced motion.
    bubbles.pollNotices()
    answerNotices(noticeBody(2, [["seq": 1, "title": "After restart"], ["seq": 2, "title": "After restart 2"]]))
    check("poll: a lower seq (server restarted) starts again from it", bubbles.testLastSeq == 2 && bubbles.testBubbleTitle == "After restart")
    bubbles.testClearNotices()
    bubbles.pollNotices()
    check("poll: then asks after the new seq", noticeRequests.last == "/api/attention/widget/notices?after=2")
    answerNotices("{\"error\":\"NOT_FOUND\"}", 404)
    let countAt404 = noticeRequests.count
    bubbles.pollNotices()
    clock = clock.addingTimeInterval(noticeRetryDelay - 1)
    bubbles.pollNotices()
    check("poll: a 404 stops polling quietly", noticeRequests.count == countAt404 && bubbles.testBubbleView == nil)
    clock = clock.addingTimeInterval(2)
    bubbles.pollNotices()
    check("poll: and tries again after a few minutes", noticeRequests.count == countAt404 + 1
          && noticeRequests.last == "/api/attention/widget/notices?after=2")
    motionReduced = true
    answerNotices(noticeBody(3, [["seq": 3, "title": "Calm"]]))
    check("bubble: with reduced motion it appears without sliding", bubbles.testBubbleTitle == "Calm" && !bubbles.testBubbleSlides)
    bubbles.testClearNotices()

    runActivitySelfTest(check)  // Part C
    runPartBSelfTest(check)

    partDSelfTest(check)
    runTickSelfTest(check)  // Part E
    runLookSelfTest(check)  // Part F
    runScheduleSelfTest(check)  // Part G
    check("no window was put on screen", !mouse.testOnScreen && !crud.testOnScreen && !empty.testOnScreen && !links.testOnScreen
          && !bubbles.testOnScreen)
    print("\(passes) passed, \(failures) failed")
    exit(failures == 0 ? 0 : 1)
}

/// The capsule: its fixed size, the three rows, the dim zero, "99+", the merged Needs you count, the running count, the
/// tooltip, the panel that keeps its place, and an old saved spot clamped with the new size.
func runCapsuleChecks(_ check: (String, Bool) -> Void) {
    func item(_ key: String, _ status: String, session: (String, String, String)? = nil) -> WidgetItem {
        let cut = key.range(of: ":", options: .backwards)!
        var out = WidgetItem(key: key, engine: String(key[..<cut.lowerBound]), id: String(key[cut.upperBound...]), title: key, status: status)
        if let (engine, task, terminal) = session { out.session = ItemSession(engine: engine, taskId: task, terminalId: terminal) }
        return out
    }
    func terminal(_ task: String, _ id: String, _ state: ActivityState) -> ActivityTerminal {
        ActivityTerminal(taskID: task, taskTitle: "Task " + task, terminalID: id, state: state, openPath: "/?openTerminal=local:\(task):\(id)")
    }

    // The merge of Needs you and the waiting terminals.
    let asking = item("local:1", "waiting_user", session: ("local", "5", "t1"))
    check("needs: an item and its own waiting terminal count once", needsYouCount([asking], terminals: [terminal("5", "t1", .waiting)]) == 1)
    check("needs: a waiting terminal without an item counts", needsYouCount([asking], terminals: [terminal("6", "t1", .waiting)]) == 2
          && needsYouCount([], terminals: [terminal("6", "t1", .waiting)]) == 1)
    check("needs: another terminal of the same task counts on its own", needsYouCount([asking], terminals: [terminal("5", "t2", .waiting)]) == 2)
    check("needs: review counts, running and done terminals do not", needsYouCount([asking, item("local:2", "review")],
          terminals: [terminal("7", "t1", .running), terminal("8", "t1", .done)]) == 2)
    check("needs: an item of a connected service never takes a local terminal",
          needsYouCount([item("remote:7:1", "waiting_user", session: ("remote:7", "5", "t1"))], terminals: [terminal("5", "t1", .waiting)]) == 2)
    check("needs: an item without a session takes none, a terminal listed twice counts once",
          needsYouCount([item("local:3", "waiting_user")], terminals: [terminal("9", "t1", .waiting), terminal("9", "t1", .waiting)]) == 2)

    // Text and sizes.
    check("capsule: 99+ above 99, a dash without a number", capsuleText(0) == "0" && capsuleText(99) == "99" && capsuleText(100) == "99+"
          && capsuleText(128) == "99+" && capsuleText(nil) == "\u{2013}")
    let room = widgetWidth - capsuleTextInset * 2
    check("capsule: two digits at 13 pt (12 pt at most less) and 99+ at 10 pt (or 9) fit with 3 pt each side",
          ["88", "99+", "\u{2013}", "0"].allSatisfy { capsuleTextWidth($0, size: capsuleFontSize($0)) <= room }
          && [13, 12].contains(capsuleFontSize("88")) && [10, 9].contains(capsuleFontSize("99+")))
    print("capsule fonts: 88 at \(capsuleFontSize("88")) pt (\(capsuleTextWidth("88", size: capsuleFontSize("88"))) pt wide), "
          + "99+ at \(capsuleFontSize("99+")) pt (\(capsuleTextWidth("99+", size: capsuleFontSize("99+"))) pt wide), room \(room) pt")

    var options = WidgetOptions()
    options.persistPosition = false
    options.offscreen = true
    let window = WidgetController(api: WidgetAPI(base: "http://127.0.0.1:1", token: "t"), parentPID: nil, options: options)
    window.requestHook = { _, _ in }
    window.announce = { _ in }
    /// A list with `open` unfinished tasks, `needs` of them waiting for the person, and `running` running terminals.
    func show(_ open: Int, _ needs: Int, _ running: Int) {
        let items = (0..<open).map { item("local:\($0 + 1)", $0 < needs ? "waiting_user" : "working") } + [item("local:999", "done")]
        window.loadForTest(ItemList(items: items, engines: [EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0)], failed: []))
        window.testSetActivity((0..<running).map { terminal(String(500 + $0), "t1", .running) })
    }
    let rows = window.testCapsule.rows
    func alpha(_ index: Int) -> CGFloat { rows[index].alphaValue }
    let chinese = "{1} \u{9879}\u{672A}\u{5B8C}\u{6210} \u{00B7} {2} \u{9879}\u{9700}\u{8981}\u{4F60} \u{00B7} {3} \u{4E2A}\u{8FD0}\u{884C}\u{4E2D}"
    var sizes: [Bool] = []
    for table in [[:], ["{1} open · {2} need you · {3} running": chinese]] {
        stringTable = table
        window.testStringsChanged()
        for (open, needs, running) in [(0, 0, 0), (9, 1, 0), (12, 6, 1), (128, 14, 3)] {
            show(open, needs, running)
            sizes.append(window.testWidgetWidth == widgetWidth && window.testWidgetHeight == widgetHeight
                         && window.testCapsule.frame.size == widgetSize && rows.allSatisfy { !$0.isHidden && $0.superview != nil })
        }
    }
    check("capsule: exactly 32 x 90 with all three rows for 0/0/0, 9/1/0, 12/6/1 and 128/14/3, in both languages",
          sizes.count == 8 && !sizes.contains(false) && widgetSize == NSSize(width: 32, height: 90))
    check("capsule: the tooltip in the loaded language, with the exact numbers", window.testTooltip == "128 \u{9879}\u{672A}\u{5B8C}\u{6210} \u{00B7} 14 "
          + "\u{9879}\u{9700}\u{8981}\u{4F60} \u{00B7} 3 \u{4E2A}\u{8FD0}\u{884C}\u{4E2D}")
    stringTable = [:]
    window.testStringsChanged()
    show(128, 14, 3)
    check("capsule: 99+ in a smaller size, the other rows at the full size", window.testCount == "99+" && window.testBadge == "14"
          && window.testRunning == "3" && (rows[0].font?.pointSize ?? 0) < 11 && rows[1].font?.pointSize == capsuleFontSize("14")
          && rows[1].font?.pointSize ?? 0 >= 12)
    check("capsule: rows top to bottom, inside the capsule, about 26 pt apart", rows[0].frame.minY > rows[1].frame.minY
          && rows[1].frame.minY > rows[2].frame.minY && abs((rows[0].frame.midY - rows[2].frame.midY) - capsuleRowHeight * 2) <= 1
          && rows.allSatisfy { $0.frame.minY >= 0 && $0.frame.maxY <= widgetHeight && $0.frame.width == widgetWidth })
    show(3, 0, 0)
    check("capsule: a zero stays as a dim 0", window.testBadge == "0" && window.testRunning == "0" && alpha(0) == 1
          && abs(alpha(1) - capsuleZeroAlpha) < 0.01 && abs(alpha(2) - capsuleZeroAlpha) < 0.01)
    check("capsule: the colours tell the rows apart: label, the badge red, the activity teal",
          CapsuleView.colors[0] == NSColor.labelColor && CapsuleView.colors[1] == NSColor.systemRed && CapsuleView.colors[2] === capsuleTeal
          && rows.indices.allSatisfy { rows[$0].textColor === CapsuleView.colors[$0] })
    show(12, 6, 1)
    check("capsule: the tooltip", window.testTooltip == "12 open · 6 need you · 1 running" && alpha(1) == 1 && alpha(2) == 1)

    // The merge in the window: the item's own waiting terminal once, another waiting terminal on top, review counted.
    let list = ItemList(items: [item("local:1", "waiting_user", session: ("local", "5", "t1")), item("local:2", "review"),
                                item("local:3", "working", session: ("local", "6", "t1"))],
                        engines: [EngineInfo(key: "local", name: "MacBook", local: true, colorIndex: 0)], failed: [])
    window.loadForTest(list)
    window.testSetActivity([terminal("5", "t1", .waiting), terminal("6", "t1", .waiting), terminal("7", "t1", .running)])
    check("capsule: Needs you merges the waiting terminals, each thing once", window.testCount == "3" && window.testBadge == "3"
          && window.testRunning == "1")
    window.showActivity = false
    check("capsule: with the activity off, no running count and no waiting terminals", window.testBadge == "2" && window.testRunning == "0")
    window.showActivity = true
    window.testSetActivity([])

    // The panel keeps its place while the numbers change.
    window.testPlaceWidget(right: true)
    show(9, 1, 0)
    let before = window.testDetailFrame
    let capsuleBefore = window.testWidgetFrame
    show(128, 14, 3)
    let after = window.testDetailFrame
    check("capsule: the panel's x stays when the numbers change, its top level with the capsule's",
          before.minX == after.minX && window.testWidgetFrame == capsuleBefore && after.maxX <= capsuleBefore.minX
          && abs(after.maxY - capsuleBefore.maxY) < 0.5 && abs(before.maxY - capsuleBefore.maxY) < 0.5)

    // A spot saved by the older pill (26 pt high) right under the top edge: clamped with the capsule's size.
    if let visible = NSScreen.main?.visibleFrame {
        let old = NSPoint(x: visible.maxX - 38, y: visible.maxY - 26 - 2)
        let kept = window.keptOnScreen(NSRect(origin: old, size: widgetSize))
        let fromSpot = NSRect(origin: absoluteOrigin(relativeSpot(old, size: NSSize(width: 38, height: 26), in: visible), size: widgetSize,
                                                     in: visible), size: widgetSize)
        check("position: an old saved spot is clamped on screen with the new size", visible.contains(kept) && visible.contains(fromSpot)
              && kept.maxY == visible.maxY && fromSpot.maxX == visible.maxX)
    } else {
        check("position: an old saved spot is clamped on screen with the new size (no screen, pure check)",
              absoluteOrigin(NSPoint(x: 1, y: 1), size: widgetSize, in: NSRect(x: 0, y: 0, width: 1440, height: 875))
              == NSPoint(x: 1440 - widgetWidth, y: 875 - widgetHeight))
    }
    check("capsule: no window was put on screen", !window.testOnScreen)
}
