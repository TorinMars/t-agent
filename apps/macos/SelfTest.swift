// T-Agent.app: the --self-test checks. Every outside effect is a fake: files, the environment, health checks, processes,
// timers, the clock, the browser and the pasteboard. No window is ordered on screen, nothing touches the network, no
// process runs, and neither the real ~/.tagent nor the app's defaults are read or written. See main.swift.
import AppKit
import WebKit

// MARK: - Fakes

final class FakeTimer: Cancellable {
    let fireAt: TimeInterval
    let block: () -> Void
    var cancelled = false
    init(_ fireAt: TimeInterval, _ block: @escaping () -> Void) { self.fireAt = fireAt; self.block = block }
    func cancel() { cancelled = true }
}

/// A clock and timers that move only when the test says so.
final class FakeTime {
    var now: TimeInterval = 1_000_000
    var timers: [FakeTimer] = []
    var date: Date { Date(timeIntervalSince1970: now) }

    var scheduler: Scheduler {
        return { [unowned self] delay, block in
            let timer = FakeTimer(self.now + delay, block)
            self.timers.append(timer)
            return timer
        }
    }

    var pendingDelays: [TimeInterval] { timers.filter { !$0.cancelled }.map { $0.fireAt - now } }

    /// Moves the clock forward, firing every due timer in order.
    func advance(_ seconds: TimeInterval) {
        let end = now + seconds
        while let next = timers.filter({ !$0.cancelled && $0.fireAt <= end }).min(by: { $0.fireAt < $1.fireAt }) {
            next.cancelled = true
            now = max(now, next.fireAt)
            next.block()
        }
        now = end
        timers.removeAll { $0.cancelled }
    }
}

/// Health answers given by the test; each request waits until the test answers it.
final class FakeHealth {
    var requests: [(URL, (HealthResult) -> Void)] = []
    var check: HealthCheck { return { [unowned self] base, done in self.requests.append((base, done)) } }
    func answer(_ result: HealthResult) {
        guard !requests.isEmpty else { return }
        let (_, done) = requests.removeFirst()
        done(result)
    }
}

final class FakeRunner {
    var calls: [(String, [String])] = []
    var completions: [(Int32, String) -> Void] = []
    var runner: ProcessRunner {
        return { [unowned self] executable, arguments, done in
            self.calls.append((executable, arguments))
            self.completions.append(done)
        }
    }
    func finish(_ status: Int32, _ output: String = "") {
        guard !completions.isEmpty else { return }
        completions.removeFirst()(status, output)
    }
}

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
    func json(_ text: String) -> Data { Data(text.utf8) }
    let base3000 = URL(string: "http://127.0.0.1:3000")!

    // Version.
    check("version: CFBundleShortVersionString", appVersion(["CFBundleShortVersionString": "2.133.1"]) == "2.133.1")
    check("version: dev outside a bundle", appVersion(nil) == "dev" && appVersion(["CFBundleShortVersionString": " "]) == "dev")

    // Data home.
    let home = "/Users/someone"
    check("data home: ~/.tagent by default", dataHome(environment: [:], defaultsValue: nil, home: home) == "/Users/someone/.tagent")
    check("data home: TAGENT_HOME wins", dataHome(environment: ["TAGENT_HOME": "/data/a", "T_AGENT_DATA_DIR": "/data/b"],
                                                  defaultsValue: "/data/c", home: home) == "/data/a")
    check("data home: T_AGENT_DATA_DIR is the old name", dataHome(environment: ["T_AGENT_DATA_DIR": "/data/b"], defaultsValue: "/data/c", home: home) == "/data/b")
    check("data home: the DataHome default comes after the variables", dataHome(environment: [:], defaultsValue: "/data/c", home: home) == "/data/c")
    check("data home: an empty variable is skipped", dataHome(environment: ["TAGENT_HOME": "  "], defaultsValue: nil, home: home) == "/Users/someone/.tagent")
    check("data home: ~ expands", dataHome(environment: ["TAGENT_HOME": "~/x"], defaultsValue: nil, home: home) == "/Users/someone/x"
          && dataHome(environment: ["TAGENT_HOME": "~"], defaultsValue: nil, home: home) == home)
    check("data home: a relative path is under the home folder", dataHome(environment: ["TAGENT_HOME": "td"], defaultsValue: nil, home: home) == "/Users/someone/td")
    check("data home: the path is standardized", dataHome(environment: ["TAGENT_HOME": "/data/a/../b/"], defaultsValue: nil, home: home) == "/data/b")
    var readPaths: [String] = []
    _ = loadAppConfig(environment: ["TAGENT_HOME": "/data/x"], defaultsValue: nil, home: home) { readPaths.append($0); return nil }
    check("app.json: read from the data home", readPaths == ["/data/x/app.json"])

    // app.json.
    let missing = parseAppConfig(nil)
    check("app.json: missing gives the defaults", missing.source == .missing && missing.url == base3000 && missing.supervisor == .none
          && missing.pm2Name == "t-agent" && missing.launchdLabel == "com.tagent.client" && missing.installDir == nil)
    check("app.json: missing has the one local address", missing.addresses == [WebAddress(kind: .local, label: "This Mac", url: "http://127.0.0.1:3000")])
    check("app.json: broken JSON gives the defaults", parseAppConfig(json("{nope")).source == .corrupt && parseAppConfig(json("{nope")).url == base3000)
    check("app.json: a JSON array is broken", parseAppConfig(json("[1,2]")).source == .corrupt)
    check("app.json: an empty file is broken", parseAppConfig(Data()).source == .corrupt)
    let full = parseAppConfig(json("""
    {"url":"http://127.0.0.1:3412","version":"2.133.1","pid":4242,"install_dir":"/Users/someone/t-agent","supervisor":"pm2",
     "pm2_name":"t-agent-dev","launchd_label":"com.example.ta","updated_at":"2026-11-18T00:00:00Z",
     "addresses":[{"kind":"remote","label":"Public page","url":"https://ta.example.com"},
                  {"kind":"local","label":"This Mac","url":"http://127.0.0.1:3412"},
                  {"kind":"lan","label":"Wi-Fi","url":"http://192.168.1.20:3412"}]}
    """))
    check("app.json: url", full.source == .file && full.url.absoluteString == "http://127.0.0.1:3412")
    check("app.json: version and pid", full.version == "2.133.1" && full.pid == 4242)
    check("app.json: install_dir, supervisor and names", full.installDir == "/Users/someone/t-agent" && full.supervisor == .pm2
          && full.pm2Name == "t-agent-dev" && full.launchdLabel == "com.example.ta")
    check("app.json: addresses sorted local, lan, remote", full.addresses.map { $0.kind } == [.local, .lan, .remote]
          && full.addresses.map { $0.label } == ["This Mac", "Wi-Fi", "Public page"])
    check("app.json: null supervisor is none", parseAppConfig(json("{\"supervisor\":null}")).supervisor == .none)
    check("app.json: an unknown supervisor is none", parseAppConfig(json("{\"supervisor\":\"forever\"}")).supervisor == .none)
    check("app.json: systemd and launchd", parseAppConfig(json("{\"supervisor\":\"systemd\"}")).supervisor == .systemd
          && parseAppConfig(json("{\"supervisor\":\"launchd\"}")).supervisor == .launchd)
    check("app.json: only pm2 and launchd are controllable", Supervisor.pm2.controllable && Supervisor.launchd.controllable
          && !Supervisor.systemd.controllable && !Supervisor.none.controllable)
    check("app.json: another scheme falls back", parseAppConfig(json("{\"url\":\"ftp://127.0.0.1:21\"}")).url == base3000)
    check("app.json: a URL with a user falls back", parseAppConfig(json("{\"url\":\"http://a:b@127.0.0.1:4000\"}")).url == base3000)
    check("app.json: a non-string url falls back", parseAppConfig(json("{\"url\":3000}")).url == base3000)
    check("app.json: path and trailing slash are dropped", parseAppConfig(json("{\"url\":\"HTTP://LocalHost:4000/x/\"}")).url.absoluteString == "http://localhost:4000")
    check("app.json: an IPv6 address", parseAppConfig(json("{\"url\":\"http://[::1]:4000\"}")).url.absoluteString == "http://[::1]:4000")
    check("app.json: a bad pid is nil", parseAppConfig(json("{\"pid\":-5}")).pid == nil && parseAppConfig(json("{\"pid\":\"12\"}")).pid == nil)
    check("app.json: a relative install_dir is nil", parseAppConfig(json("{\"install_dir\":\"t-agent\"}")).installDir == nil)
    check("app.json: a pm2 name with a line break falls back", parseAppConfig(json("{\"pm2_name\":\"a\\nb\"}")).pm2Name == "t-agent")
    check("app.json: a pm2 name with quotes is kept (it is shell-quoted)", parseAppConfig(json("{\"pm2_name\":\"it's \\\"x\\\"\"}")).pm2Name == "it's \"x\"")
    check("app.json: a launchd label with a space falls back", parseAppConfig(json("{\"launchd_label\":\"a b\"}")).launchdLabel == "com.tagent.client")
    check("app.json: a bad field leaves the others", parseAppConfig(json("{\"url\":\"nope\",\"supervisor\":\"pm2\"}")).supervisor == .pm2)

    // Web addresses.
    let addressInput: [Any] = [
        ["kind": "remote", "url": "https://r.example.com/path"],
        ["kind": "lan", "label": "", "url": "http://10.0.0.2:3000"],
        ["kind": "lan", "label": "Again", "url": "http://10.0.0.2:3000"],
        ["kind": "public", "label": "Odd kind", "url": "http://x.example.com"],
        ["kind": "local", "label": "JS", "url": "javascript:alert(1)"],
        ["kind": "local", "label": "File", "url": "file:///etc/passwd"],
        ["kind": "local", "label": "No host", "url": "http://"],
        ["kind": "local", "label": "User", "url": "http://u:p@127.0.0.1:3000"],
        ["kind": "local", "label": "Space", "url": "http://127.0.0.1:3000/a b"],
        ["kind": "local", "label": 7, "url": "http://127.0.0.1:3000"] as [String: Any],
        ["kind": "local", "label": String(repeating: "L", count: 80), "url": "http://localhost:3000"],
        "not an object", 5, ["kind": "local"],
    ]
    let addresses = parseAddresses(addressInput, base: base3000)
    check("addresses: only http(s) with a known kind", addresses.map { $0.url } == ["http://127.0.0.1:3000", "http://localhost:3000",
                                                                                    "http://10.0.0.2:3000", "https://r.example.com/path"])
    check("addresses: a missing or odd label is the kind's label", addresses[0].label == "This Mac" && addresses[2].label == "Local network"
          && addresses[3].label == "Remote")
    check("addresses: a long label is cut to 60", addresses[1].label.count == 60)
    check("addresses: a repeated URL is listed once", addresses.filter { $0.url == "http://10.0.0.2:3000" }.count == 1)
    check("addresses: not a list gives the base", parseAddresses("x", base: base3000) == [WebAddress(kind: .local, label: "This Mac", url: "http://127.0.0.1:3000")])
    let many = parseAddresses((1...20).map { ["kind": "lan", "url": "http://10.0.0.\($0):3000"] }, base: base3000)
    check("addresses: at most 12", many.count == 12 && many.first?.url == "http://10.0.0.1:3000")

    // Origins and navigation.
    check("origin: same scheme, host and port", sameOrigin(URL(string: "http://127.0.0.1:3000/tasks?x=1")!, base3000))
    check("origin: another port is another origin", !sameOrigin(URL(string: "http://127.0.0.1:3001/")!, base3000))
    check("origin: https is another origin", !sameOrigin(URL(string: "https://127.0.0.1:3000/")!, base3000))
    check("origin: localhost is not 127.0.0.1", !sameOrigin(URL(string: "http://localhost:3000/")!, base3000))
    check("origin: the default port equals an explicit one", sameOrigin(URL(string: "http://example.com:80/a")!, URL(string: "HTTP://Example.com")!))
    check("origin: non-http is never same origin", !sameOrigin(URL(string: "file:///tmp/x")!, URL(string: "file:///tmp/y")!))
    func nav(_ text: String, main: Bool = true, newWindow: Bool = false) -> NavigationDecision {
        navigationDecision(url: URL(string: text), server: base3000, mainFrame: main, newWindow: newWindow)
    }
    check("nav: same origin stays", nav("http://127.0.0.1:3000/tasks/4") == .allow)
    check("nav: another origin opens in the browser", nav("https://github.com/x") == .openExternally)
    check("nav: another port opens in the browser", nav("http://127.0.0.1:8080/") == .openExternally)
    check("nav: another origin in an iframe loads in place", nav("https://example.com/embed", main: false) == .allow)
    check("nav: target=_blank of the same origin opens in the browser", nav("http://127.0.0.1:3000/x", newWindow: true) == .openExternally)
    check("nav: about:blank loads in place", nav("about:blank") == .allow && nav("about:srcdoc", main: false) == .allow)
    check("nav: about:blank never opens a window", nav("about:blank", newWindow: true) == .cancel)
    check("nav: blob: loads in place", nav("blob:http://127.0.0.1:3000/uuid") == .allow)
    check("nav: data: only in an iframe", nav("data:text/html,x") == .cancel && nav("data:text/html,x", main: false) == .allow)
    check("nav: mailto: goes to its app", nav("mailto:a@example.com") == .openExternally && nav("mailto:a@example.com", main: false) == .cancel)
    check("nav: file:, javascript: and t-agent: are cancelled", nav("file:///etc/passwd") == .cancel && nav("javascript:alert(1)") == .cancel
          && nav("t-agent://show") == .cancel && nav("vnc://host") == .cancel)
    check("nav: no URL is cancelled", navigationDecision(url: nil, server: base3000, mainFrame: true, newWindow: false) == .cancel)

    // Links the page hands over (tagentOpen).
    func link(_ body: Any?, scheme: String = "http", host: String = "127.0.0.1", port: Int = 3000) -> URL? {
        linkToOpen(body: body, frameScheme: scheme, frameHost: host, framePort: port, server: base3000)
    }
    check("page link: http(s) from the server's page opens", link("https://github.com/x?y=1#z")?.absoluteString == "https://github.com/x?y=1#z"
          && link("http://example.com/")?.absoluteString == "http://example.com/")
    check("page link: only from the server's own origin", link("https://github.com/", port: 3001) == nil
          && link("https://github.com/", host: "evil.example") == nil && link("https://github.com/", scheme: "https") == nil)
    check("page link: other schemes are refused", link("file:///etc/passwd") == nil && link("javascript:alert(1)") == nil
          && link("t-agent://show") == nil && link("mailto:a@example.com") == nil)
    check("page link: not a string, empty, too long or with spaces is refused", link(42) == nil && link(nil) == nil && link("") == nil
          && link("https://example.com/" + String(repeating: "a", count: 4100)) == nil && link("https://exa mple.com/") == nil
          && link("https:///nohost") == nil)

    // Microphone.
    check("mic: granted for the server's origin", grantsMediaCapture(scheme: "http", host: "127.0.0.1", port: 3000, server: base3000))
    check("mic: denied for another port or host", !grantsMediaCapture(scheme: "http", host: "127.0.0.1", port: 3001, server: base3000)
          && !grantsMediaCapture(scheme: "http", host: "evil.example", port: 3000, server: base3000))
    check("mic: denied for another scheme", !grantsMediaCapture(scheme: "https", host: "127.0.0.1", port: 3000, server: base3000)
          && !grantsMediaCapture(scheme: "file", host: "", port: 0, server: base3000))
    check("mic: port 0 means the default port", grantsMediaCapture(scheme: "https", host: "ta.example.com", port: 0, server: URL(string: "https://ta.example.com")!))
    check("mic: an IPv6 host", grantsMediaCapture(scheme: "http", host: "::1", port: 4000, server: URL(string: "http://[::1]:4000")!))

    // Page URLs.
    check("page URL: a path and query", serverPageURL(base: base3000, path: "/tasks/4?s=2#t")?.absoluteString == "http://127.0.0.1:3000/tasks/4?s=2#t")
    check("page URL: non-ASCII is encoded", serverPageURL(base: base3000, path: "/f?n=\u{65E5}")?.absoluteString == "http://127.0.0.1:3000/f?n=%E6%97%A5")
    check("page URL: existing escapes are kept", serverPageURL(base: base3000, path: "/f?n=a%20b")?.absoluteString == "http://127.0.0.1:3000/f?n=a%20b")
    check("page URL: quotes and braces are encoded", serverPageURL(base: base3000, path: "/x\"{}")?.absoluteString == "http://127.0.0.1:3000/x%22%7B%7D")
    check("page URL: // and relative paths are refused", serverPageURL(base: base3000, path: "//evil.example") == nil
          && serverPageURL(base: base3000, path: "evil") == nil)
    check("page URL: a broken escape is refused", serverPageURL(base: base3000, path: "/x%ZZ") == nil)
    check("page path: of a server page", pagePath(of: URL(string: "http://127.0.0.1:3000/t/1?a=b#c"), server: base3000) == "/t/1?a=b#c")
    check("page path: the root", pagePath(of: URL(string: "http://127.0.0.1:3000"), server: base3000) == "/")
    check("page path: not of another origin", pagePath(of: URL(string: "http://127.0.0.1:9/"), server: base3000) == nil && pagePath(of: nil, server: base3000) == nil)

    // Download names.
    check("download: a plain name is kept", safeDownloadName("report.pdf") == "report.pdf")
    check("download: folders and colons are dropped", safeDownloadName("../../etc/pa:ss") == "pa_ss" && safeDownloadName("a\\b") == "a_b")
    check("download: leading dots and control characters", safeDownloadName("..hidden\u{0007}.txt") == "hidden_.txt")
    check("download: empty becomes download", safeDownloadName("") == "download" && safeDownloadName(nil) == "download" && safeDownloadName("...") == "download")
    let longName = safeDownloadName(String(repeating: "a", count: 300) + ".zip")
    check("download: a long name keeps its extension", longName.count == 200 && longName.hasSuffix(".zip"))
    let taken: Set<String> = ["/d/r.pdf", "/d/r (1).pdf", "/d/notes"]
    check("download: a free name is used", uniqueDownloadPath(folder: "/d", name: "x.pdf", exists: taken.contains) == "/d/x.pdf")
    check("download: a taken name is numbered", uniqueDownloadPath(folder: "/d", name: "r.pdf", exists: taken.contains) == "/d/r (2).pdf"
          && uniqueDownloadPath(folder: "/d", name: "notes", exists: taken.contains) == "/d/notes (1)")

    // Deep links.
    check("link: show", parseDeepLink("t-agent://show") == .show && parseDeepLink("T-Agent://SHOW/") == .show && parseDeepLink("t-agent://show?x=1") == .show)
    check("link: open an encoded path", parseDeepLink("t-agent://open?path=%2Ftasks%2F4%3Fs%3D2") == .open(path: "/tasks/4?s=2"))
    check("link: open a plain path", parseDeepLink("t-agent://open?path=/tasks/4") == .open(path: "/tasks/4"))
    check("link: open the root with a slash after the host", parseDeepLink("t-agent://open/?path=%2F") == .open(path: "/"))
    check("link: decoded once", parseDeepLink("t-agent://open?path=%2Ff%3Fn%3Da%2520b") == .open(path: "/f?n=a%20b"))
    check("link: a double-encoded slash is refused", parseDeepLink("t-agent://open?path=%252Ftasks") == nil)
    check("link: //host is refused", parseDeepLink("t-agent://open?path=%2F%2Fevil.example") == nil && parseDeepLink("t-agent://open?path=//evil.example") == nil)
    check("link: a backslash is refused", parseDeepLink("t-agent://open?path=%2F%5Cevil.example") == nil && parseDeepLink("t-agent://open?path=/\\evil") == nil)
    check("link: whitespace is refused", parseDeepLink("t-agent://open?path=%2Fa%20b") == nil && parseDeepLink("t-agent://open?path=%2Fa%09b") == nil
          && parseDeepLink("t-agent://open?path=/a b") == nil)
    check("link: control and format characters are refused", parseDeepLink("t-agent://open?path=%2Fa%00") == nil
          && parseDeepLink("t-agent://open?path=%2Fa%0A") == nil && parseDeepLink("t-agent://open?path=%2Fa%7F") == nil
          && parseDeepLink("t-agent://open?path=%2Fa%E2%80%AE") == nil && parseDeepLink("t-agent://open?path=%2Fa%E2%80%A8") == nil)
    check("link: a + stays a +", parseDeepLink("t-agent://open?path=%2Fa+b") == .open(path: "/a+b"))
    check("link: non-ASCII text is kept", parseDeepLink("t-agent://open?path=%2F%E6%97%A5") == .open(path: "/\u{65E5}"))
    check("link: a broken escape is refused", parseDeepLink("t-agent://open?path=%2Fa%ZZ") == nil && parseDeepLink("t-agent://open?path=%2Fa%2") == nil)
    check("link: bytes that are not UTF-8 are refused", parseDeepLink("t-agent://open?path=%2F%FF") == nil)
    check("link: a relative path is refused", parseDeepLink("t-agent://open?path=tasks") == nil && parseDeepLink("t-agent://open?path=") == nil)
    check("link: open without a path is refused", parseDeepLink("t-agent://open") == nil && parseDeepLink("t-agent://open?") == nil)
    check("link: two paths or other fields are refused", parseDeepLink("t-agent://open?path=/a&path=/b") == nil
          && parseDeepLink("t-agent://open?path=/a&x=1") == nil && parseDeepLink("t-agent://open?x=1") == nil)
    check("link: a fragment is refused", parseDeepLink("t-agent://open?path=/a#b") == nil)
    check("link: user, port or a path on the host are refused", parseDeepLink("t-agent://u@open?path=/a") == nil
          && parseDeepLink("t-agent://open:80?path=/a") == nil && parseDeepLink("t-agent://open/x?path=/a") == nil)
    check("link: another scheme or command is refused", parseDeepLink("http://open?path=/a") == nil && parseDeepLink("t-agent://run?path=/a") == nil
          && parseDeepLink("t-agent:open?path=/a") == nil && parseDeepLink("") == nil)
    check("link: a very long path is refused", parseDeepLink("t-agent://open?path=/" + String(repeating: "a", count: 5000)) == nil)
    check("link: the caller's encoding round-trips", parseDeepLink(deepLinkText(path: "/tasks/4?s=2&f=a%20b#x")) == .open(path: "/tasks/4?s=2&f=a%20b#x"))

    // Service commands.
    check("quote: a plain word", shellQuote("t-agent") == "'t-agent'")
    check("quote: a single quote", shellQuote("it's") == "'it'\\''s'")
    check("quote: $ and backticks stay literal", shellQuote("$(rm -rf ~)`x`") == "'$(rm -rf ~)`x`'")
    check("shell: $SHELL when it is zsh or bash", loginShell(["SHELL": "/opt/homebrew/bin/bash"]) == "/opt/homebrew/bin/bash"
          && loginShell(["SHELL": "/bin/zsh"]) == "/bin/zsh")
    check("shell: fish, a relative path or none gives zsh", loginShell(["SHELL": "/opt/homebrew/bin/fish"]) == "/bin/zsh"
          && loginShell(["SHELL": "bash"]) == "/bin/zsh" && loginShell([:]) == "/bin/zsh")
    var pm2Config = parseAppConfig(json("{\"supervisor\":\"pm2\",\"pm2_name\":\"t-agent\",\"install_dir\":\"/Users/someone/My Apps/t-agent\"}"))
    let env = ["SHELL": "/bin/zsh"]
    check("pm2: restart argv", serviceCommand(.restart, config: pm2Config, uid: 501, home: home, environment: env)
          == .run(executable: "/bin/zsh", arguments: ["-lc", pm2Prelude + "pm2 restart 't-agent'"]))
    check("pm2: stop argv", serviceCommand(.stop, config: pm2Config, uid: 501, home: home, environment: env)
          == .run(executable: "/bin/zsh", arguments: ["-lc", pm2Prelude + "pm2 stop 't-agent'"]))
    check("pm2: start argv registers the process again when PM2 lost it", serviceCommand(.start, config: pm2Config, uid: 501, home: home, environment: env)
          == .run(executable: "/bin/zsh", arguments: ["-lc", pm2Prelude
            + "if [ -n \"$(pm2 id 't-agent' 2>/dev/null | tr -dc '0-9')\" ]; then pm2 start 't-agent'; "
            + "else cd '/Users/someone/My Apps/t-agent' && pm2 start server.js --name 't-agent' --cwd '/Users/someone/My Apps/t-agent'; fi"]))
    pm2Config.installDir = nil
    pm2Config.pm2Name = "it's; rm -rf ~"
    check("pm2: start without the install folder, odd name quoted", serviceCommand(.start, config: pm2Config, uid: 501, home: home, environment: ["SHELL": "/bin/bash"])
          == .run(executable: "/bin/bash", arguments: ["-lc", pm2Prelude + "pm2 start 'it'\\''s; rm -rf ~'"]))
    check("pm2: the prelude finds pm2 of nvm, Homebrew and ~/.local", pm2Prelude.contains("$HOME/.local/bin") && pm2Prelude.contains("/opt/homebrew/bin")
          && pm2Prelude.contains(".nvm/nvm.sh") && pm2Prelude.contains("command -v pm2"))
    let launchdConfig = parseAppConfig(json("{\"supervisor\":\"launchd\",\"launchd_label\":\"com.tagent.client\"}"))
    check("launchd: restart argv", serviceCommand(.restart, config: launchdConfig, uid: 501, home: home, environment: env)
          == .run(executable: "/bin/launchctl", arguments: ["kickstart", "-k", "gui/501/com.tagent.client"]))
    check("launchd: stop argv", serviceCommand(.stop, config: launchdConfig, uid: 501, home: home, environment: env)
          == .run(executable: "/bin/launchctl", arguments: ["bootout", "gui/501/com.tagent.client"]))
    check("launchd: start argv loads the job when needed", serviceCommand(.start, config: launchdConfig, uid: 501, home: "/Users/some one", environment: env)
          == .run(executable: "/bin/sh", arguments: ["-c", "/bin/launchctl print 'gui/501/com.tagent.client' >/dev/null 2>&1 || "
            + "/bin/launchctl bootstrap 'gui/501' '/Users/some one/Library/LaunchAgents/com.tagent.client.plist'; "
            + "/bin/launchctl kickstart 'gui/501/com.tagent.client'"]))
    if case .manual(let text) = serviceCommand(.start, config: parseAppConfig(json("{\"install_dir\":\"/opt/t a\"}")), uid: 501, home: home, environment: env) {
        check("none: start explains the pm2 command with the folder", text.contains("cd '/opt/t a' && pm2 start server.js --name 't-agent' --cwd '/opt/t a'"))
    } else {
        check("none: start explains the pm2 command with the folder", false)
    }
    if case .manual(let text) = serviceCommand(.start, config: missing, uid: 501, home: home, environment: env) {
        check("none: without app.json the folder is a placeholder", text.contains("cd <the T-Agent folder> && pm2 start server.js"))
    } else {
        check("none: without app.json the folder is a placeholder", false)
    }
    if case .manual = serviceCommand(.stop, config: parseAppConfig(json("{\"supervisor\":\"systemd\"}")), uid: 501, home: home, environment: env) {
        check("systemd: never controlled", true)
    } else {
        check("systemd: never controlled", false)
    }
    check("output: the tail of long output", outputSummary(String(repeating: "x", count: 900) + "END", status: 1).hasSuffix("END")
          && outputSummary(String(repeating: "x", count: 900), status: 1).count == 801)
    check("output: empty output names the exit code", outputSummary("  \n", status: 3) == "The command ended with exit code 3.")
    check("health: the version of the answer", versionFromAnswer(json("{\"app_version\":\"2.1.0\"}")) == "2.1.0"
          && versionFromAnswer(json("{\"version\":\"1\"}")) == "1" && versionFromAnswer(json("{\"error\":\"UNAUTHORIZED\"}")) == nil
          && versionFromAnswer(nil) == nil)

    // State machine.
    let t0 = Date(timeIntervalSince1970: 1000)
    let controlled = MonitorContext(canControl: true, autoStart: true)
    var s = MonitorState()
    check("state: launch checks at once", stepMonitor(&s, .launched, now: t0, context: controlled) == [.check(after: 0)] && s.phase == .checking)
    check("state: no server at launch starts it once", stepMonitor(&s, .health(.down), now: t0, context: controlled) == [.run(.start)]
          && s.phase == .starting && s.autoStartTried && s.commandRunning && !s.userCommand)
    check("state: the automatic start is decided once", !shouldAutoStart(s, controlled))
    check("state: a finished start checks soon", stepMonitor(&s, .commandFinished(.start, ok: true, output: ""), now: t0, context: controlled)
          == [.check(after: 0.5)] && !s.commandRunning)
    check("state: starting retries every second", stepMonitor(&s, .health(.down), now: t0.addingTimeInterval(10), context: controlled) == [.check(after: 1)])
    check("state: an answer shows the page", stepMonitor(&s, .health(.up(version: "2.1.0")), now: t0.addingTimeInterval(11), context: controlled)
          == [.showPage, .check(after: 15)] && s.phase == .running && s.pageShown && s.version == "2.1.0")
    check("state: running checks every 15 s", stepMonitor(&s, .health(.up(version: nil)), now: t0, context: controlled) == [.check(after: 15)] && s.version == "2.1.0")
    check("state: one failure is checked again soon", stepMonitor(&s, .health(.down), now: t0, context: controlled) == [.check(after: 1)] && s.phase == .running)
    check("state: an answer resets the failures", stepMonitor(&s, .health(.up(version: nil)), now: t0, context: controlled) == [.check(after: 15)] && s.failuresInARow == 0)
    _ = stepMonitor(&s, .health(.down), now: t0, context: controlled)
    check("state: two failures show the placeholder", stepMonitor(&s, .health(.down), now: t0, context: controlled) == [.showPlaceholder, .check(after: 5)]
          && s.phase == .notRunning && !s.pageShown)
    check("state: not running retries every 5 s", stepMonitor(&s, .health(.down), now: t0, context: controlled) == [.check(after: 5)])
    check("state: no second automatic start", !shouldAutoStart(s, controlled))
    check("state: Try again checks now", stepMonitor(&s, .checkNow, now: t0, context: controlled) == [.check(after: 0)])
    check("state: back up shows the page again", stepMonitor(&s, .health(.up(version: nil)), now: t0, context: controlled) == [.showPage, .check(after: 15)])

    var off = MonitorState()
    _ = stepMonitor(&off, .launched, now: t0, context: controlled)
    check("state: the preference off means no automatic start", stepMonitor(&off, .health(.down), now: t0, context: MonitorContext(canControl: true, autoStart: false))
          == [.check(after: 5)] && off.phase == .notRunning && !off.autoStartTried)
    var none = MonitorState()
    _ = stepMonitor(&none, .launched, now: t0, context: controlled)
    let uncontrolled = MonitorContext(canControl: false, autoStart: true)
    check("state: no supervisor means no automatic start", stepMonitor(&none, .health(.down), now: t0, context: uncontrolled) == [.check(after: 5)]
          && none.phase == .notRunning)
    check("state: Start without a supervisor explains", stepMonitor(&none, .request(.start), now: t0, context: uncontrolled) == [.explain(.start)]
          && none.phase == .notRunning)
    var up = MonitorState()
    _ = stepMonitor(&up, .launched, now: t0, context: controlled)
    check("state: a server already running is never started", stepMonitor(&up, .health(.up(version: "1")), now: t0, context: controlled)
          == [.showPage, .check(after: 15)] && !up.autoStartTried)
    check("state: Start is ignored while running", stepMonitor(&up, .request(.start), now: t0, context: controlled) == [])
    check("state: Restart runs", stepMonitor(&up, .request(.restart), now: t0, context: controlled) == [.run(.restart)] && up.phase == .restarting && up.userCommand)
    check("state: no second command while one runs", stepMonitor(&up, .request(.stop), now: t0, context: controlled) == [] && up.phase == .restarting)
    check("state: answers during a restart wait", stepMonitor(&up, .health(.up(version: nil)), now: t0, context: controlled) == [.check(after: 1)]
          && up.phase == .restarting)
    check("state: a finished restart waits for the answer", stepMonitor(&up, .commandFinished(.restart, ok: true, output: ""), now: t0, context: controlled)
          == [.check(after: 0.5)] && up.phase == .starting && up.pageShown)
    check("state: back after the restart, the page stays", stepMonitor(&up, .health(.up(version: "2")), now: t0, context: controlled) == [.check(after: 15)]
          && up.phase == .running)
    check("state: Stop runs", stepMonitor(&up, .request(.stop), now: t0, context: controlled) == [.run(.stop)] && up.phase == .stopping)
    _ = stepMonitor(&up, .commandFinished(.stop, ok: true, output: ""), now: t0, context: controlled)
    check("state: still answering right after the stop waits", stepMonitor(&up, .health(.up(version: nil)), now: t0.addingTimeInterval(2), context: controlled)
          == [.check(after: 1)] && up.phase == .stopping)
    check("state: stopped shows the placeholder", stepMonitor(&up, .health(.down), now: t0.addingTimeInterval(3), context: controlled)
          == [.showPlaceholder, .check(after: 5)] && up.phase == .notRunning && up.lastError == nil)
    check("state: Start by the person", stepMonitor(&up, .request(.start), now: t0, context: controlled) == [.run(.start)] && up.phase == .starting && up.userCommand)
    check("state: a failed Start by the person shows an alert", stepMonitor(&up, .commandFinished(.start, ok: false, output: "pm2: command not found"), now: t0,
                                                                            context: controlled)
          == [.commandFailed(.start, "pm2: command not found"), .check(after: 0.5)] && up.phase == .notRunning && up.lastError == "pm2: command not found")
    var stuck = MonitorState()
    _ = stepMonitor(&stuck, .launched, now: t0, context: controlled)
    _ = stepMonitor(&stuck, .health(.down), now: t0, context: controlled)
    check("state: a failed automatic start shows no alert", stepMonitor(&stuck, .commandFinished(.start, ok: false, output: "boom"), now: t0, context: controlled)
          == [.check(after: 0.5)] && stuck.phase == .notRunning && stuck.lastError == "boom")
    var slow = MonitorState()
    _ = stepMonitor(&slow, .launched, now: t0, context: controlled)
    _ = stepMonitor(&slow, .health(.down), now: t0, context: controlled)
    _ = stepMonitor(&slow, .commandFinished(.start, ok: true, output: ""), now: t0, context: controlled)
    check("state: a start not answered within 60 s failed", stepMonitor(&slow, .health(.down), now: t0.addingTimeInterval(61), context: controlled)
          == [.check(after: 5)] && slow.phase == .notRunning && (slow.lastError ?? "").contains("60 seconds"))
    check("state: a stray command end is ignored", stepMonitor(&slow, .commandFinished(.stop, ok: true, output: ""), now: t0, context: controlled) == [])
    var failedStop = MonitorState()
    _ = stepMonitor(&failedStop, .launched, now: t0, context: controlled)
    _ = stepMonitor(&failedStop, .health(.up(version: nil)), now: t0, context: controlled)
    _ = stepMonitor(&failedStop, .request(.stop), now: t0, context: controlled)
    check("state: a failed stop checks again and alerts", stepMonitor(&failedStop, .commandFinished(.stop, ok: false, output: "no"), now: t0, context: controlled)
          == [.commandFailed(.stop, "no"), .check(after: 0.5)] && failedStop.phase == .running)
    check("state: Check now does nothing while busy", { var b = MonitorState(); b.phase = .starting; return stepMonitor(&b, .checkNow, now: t0, context: controlled) == [] }())

    // The monitor with fake timers, health checks and processes.
    let time = FakeTime()
    let health = FakeHealth()
    let runner = FakeRunner()
    var appJSON = "{\"url\":\"http://127.0.0.1:3500\",\"supervisor\":\"pm2\",\"pm2_name\":\"t-agent\"}"
    var reads = 0
    var opened: [URL] = []
    var copied: [String] = []
    let services = AppServices(environment: ["SHELL": "/bin/zsh", "TAGENT_HOME": "/fake/home"], home: home, uid: 501,
                               readFile: { path in reads += 1; return path == "/fake/home/app.json" ? Data(appJSON.utf8) : nil },
                               defaultsDataHome: { nil }, health: health.check, runner: runner.runner, schedule: time.scheduler,
                               now: { time.date }, openURL: { opened.append($0) }, copyText: { copied.append($0) })
    var autoStartPreference = true
    let monitor = ServiceMonitor(services: services, autoStart: { autoStartPreference })
    var effects: [MonitorEffect] = []
    var changes = 0
    monitor.onEffect = { effects.append($0) }
    monitor.onChange = { changes += 1 }
    monitor.start()
    check("monitor: nothing is asked before the timer fires", health.requests.isEmpty && monitor.checksSent == 0)
    time.advance(0)
    check("monitor: the first check asks the address of app.json", health.requests.map { $0.0.absoluteString } == ["http://127.0.0.1:3500"]
          && reads >= 2)
    health.answer(.down)
    check("monitor: the automatic start runs pm2 in the login shell", runner.calls.count == 1 && runner.calls[0].0 == "/bin/zsh"
          && runner.calls[0].1 == ["-lc", pm2Prelude + "pm2 start 't-agent'"] && monitor.state.phase == .starting)
    check("monitor: no check runs while the start command has not ended", time.pendingDelays.isEmpty && health.requests.isEmpty)
    runner.finish(0, "[PM2] Done")
    check("monitor: a check follows the command", time.pendingDelays == [0.5])
    time.advance(0.5)
    health.answer(.down)
    check("monitor: starting checks every second", time.pendingDelays == [1])
    time.advance(1)
    health.answer(.up(version: "2.133.1"))
    check("monitor: the page shows when the server answers", effects == [.showPage] && monitor.state.phase == .running && time.pendingDelays == [15])
    time.advance(15)
    check("monitor: running checks every 15 s", health.requests.count == 1)
    monitor.send(.checkNow)
    time.advance(0)
    check("monitor: an older check's answer is dropped", health.requests.count == 2)
    health.answer(.down)
    check("monitor: the dropped answer changed nothing", monitor.state.failuresInARow == 0 && monitor.state.phase == .running)
    appJSON = "{\"url\":\"http://127.0.0.1:3600\",\"supervisor\":\"pm2\"}"
    effects = []
    health.answer(.up(version: nil))
    time.advance(15)
    check("monitor: a new address in app.json loads the page there", effects == [.showPage] && monitor.config.url.absoluteString == "http://127.0.0.1:3600"
          && health.requests.last?.0.absoluteString == "http://127.0.0.1:3600")
    health.answer(.down)
    time.advance(1)
    health.answer(.down)
    check("monitor: the server gone shows the placeholder", effects == [.showPage, .showPlaceholder] && monitor.state.phase == .notRunning)
    time.advance(5)
    health.answer(.down)
    check("monitor: no second automatic start in the same run", runner.calls.count == 1 && time.pendingDelays == [5])
    monitor.send(.request(.restart))
    check("monitor: Restart is refused while not running", runner.calls.count == 1)
    autoStartPreference = false
    check("monitor: the preference is read at each step", monitor.context == MonitorContext(canControl: true, autoStart: false))
    check("monitor: every event reports a change", changes > 10)
    check("monitor: the fakes saw no opener or pasteboard use", opened.isEmpty && copied.isEmpty)

    // Placeholder text.
    let pm2Run = parseAppConfig(json("{\"supervisor\":\"pm2\"}"))
    var p = MonitorState()
    check("placeholder: connecting at launch", placeholderContent(p, config: pm2Run).title == "Connecting to T-Agent…" && placeholderContent(p, config: pm2Run).busy)
    p.phase = .starting
    check("placeholder: starting", placeholderContent(p, config: pm2Run).title == "Starting T-Agent…" && !placeholderContent(p, config: pm2Run).showButtons
          && placeholderContent(p, config: pm2Run).detail.contains("browsers"))
    p.phase = .notRunning
    let notRunning = placeholderContent(p, config: pm2Run)
    check("placeholder: not running with buttons", notRunning.title == "T-Agent is not running" && notRunning.showButtons && !notRunning.busy)
    check("placeholder: names the shared web service", notRunning.detail.contains("same service your browsers and phone use")
          && notRunning.detail.contains("http://127.0.0.1:3000"))
    check("placeholder: says it retries every 5 s", notRunning.detail.contains("every 5 seconds"))
    let manual = placeholderContent(p, config: parseAppConfig(json("{\"install_dir\":\"/opt/ta\"}")))
    check("placeholder: without a supervisor it shows the command", manual.detail.contains("cd '/opt/ta' && pm2 start server.js"))
    p.lastError = "pm2: command not found"
    check("placeholder: the last error", placeholderContent(p, config: pm2Run).detail.contains("pm2: command not found"))

    // Menu bar menu.
    var running = MonitorState()
    running.phase = .running
    running.version = "2.133.1"
    let menuConfig = parseAppConfig(json("""
    {"supervisor":"pm2","version":"2.0.0","addresses":[{"kind":"local","label":"This Mac","url":"http://127.0.0.1:3000"},
     {"kind":"remote","label":"Public","url":"https://ta.example.com"}]}
    """))
    let entries = statusMenuEntries(running, config: menuConfig, autoStart: true)
    func entry(_ title: String, in list: [MenuEntry]) -> MenuEntry? { list.first { $0.title == title } }
    check("menu: the status line with the version", entries.first?.title == "T-Agent is running (v2.133.1)" && entries.first?.enabled == false)
    check("menu: says browsers use the same service", entries[1].title == "The same web service your browsers use")
    check("menu: running enables Restart and Stop", entry("Restart", in: entries)?.enabled == true && entry("Stop", in: entries)?.enabled == true
          && entry("Start", in: entries)?.enabled == false && entry("Open in Browser", in: entries)?.enabled == true)
    check("menu: an address copies, Option opens it", entry("This Mac: http://127.0.0.1:3000", in: entries)?.command == .copyAddress("http://127.0.0.1:3000")
          && entry("Open Public in Browser: https://ta.example.com", in: entries)?.alternate == true
          && entry("Open Public in Browser: https://ta.example.com", in: entries)?.command == .openAddress("https://ta.example.com"))
    let addressIndex = entries.firstIndex { $0.command == .copyAddress("https://ta.example.com") } ?? 0
    check("menu: each alternate follows its address", entries[addressIndex + 1].alternate && !entries[addressIndex].alternate)
    check("menu: the addresses have a heading", entry("Web addresses", in: entries)?.enabled == false)
    check("menu: the launch preference is checked", entry("Start T-Agent when the app opens", in: entries)?.checked == true
          && entry("Start T-Agent when the app opens", in: statusMenuEntries(running, config: menuConfig, autoStart: false))?.checked == false)
    check("menu: Quit says it quits the app", entries.last?.title == "Quit T-Agent app" && entries.last?.command == .quit)
    var stopped = MonitorState()
    stopped.phase = .notRunning
    let stoppedEntries = statusMenuEntries(stopped, config: menuConfig, autoStart: true)
    check("menu: not running enables only Start", entry("Start", in: stoppedEntries)?.enabled == true && entry("Restart", in: stoppedEntries)?.enabled == false
          && entry("Stop", in: stoppedEntries)?.enabled == false && stoppedEntries.first?.title == "T-Agent is not running"
          && entry("Open in Browser", in: stoppedEntries)?.enabled == false)
    var busy = running
    busy.commandRunning = true
    check("menu: nothing while a command runs", [ServiceAction.start, .restart, .stop].allSatisfy { !serviceActionEnabled($0, busy, config: menuConfig) })
    check("menu: without a supervisor Restart and Stop are off, Start explains", !serviceActionEnabled(.restart, running, config: missing)
          && !serviceActionEnabled(.stop, running, config: missing) && serviceActionEnabled(.start, stopped, config: missing))
    var versionless = running
    versionless.version = nil
    check("menu: the status falls back to app.json's version", statusLine(versionless, config: menuConfig) == "T-Agent is running (v2.0.0)"
          && statusLine(versionless, config: missing) == "T-Agent is running")
    let items = buildMenuItems(entries, target: nil, action: #selector(NSObject.description))
    let alternateItem = items.first { $0.title == "Open Public in Browser: https://ta.example.com" }
    check("menu: the alternate item needs Option", alternateItem?.isAlternate == true && alternateItem?.keyEquivalentModifierMask == [.option])
    check("menu: separators and disabled lines", items.filter { $0.isSeparatorItem }.count == entries.filter { $0.separator }.count
          && items.first?.isEnabled == false && items.first?.action == nil)
    check("menu: items carry their command", (items.last?.representedObject as? MenuCommandBox)?.command == .quit)
    let icon = statusItemImage()
    check("menu: the icon is an 18 pt template", icon.isTemplate && icon.size == NSSize(width: 18, height: 18))

    // Main menu.
    final class MenuTarget: NSObject, MainMenuActions {
        func showAbout(_ sender: Any?) {}
        func showMainWindow(_ sender: Any?) {}
        func openInBrowser(_ sender: Any?) {}
        func toggleAutoStart(_ sender: Any?) {}
        func reloadPage(_ sender: Any?) {}
        func goBack(_ sender: Any?) {}
        func goForward(_ sender: Any?) {}
        func zoomIn(_ sender: Any?) {}
        func zoomOut(_ sender: Any?) {}
        func actualSize(_ sender: Any?) {}
    }
    let menuTarget = MenuTarget()
    let mainMenu = buildMainMenu(target: menuTarget)
    let allItems = mainMenu.items.flatMap { $0.submenu?.items ?? [] }
    func find(_ selector: String) -> NSMenuItem? { allItems.first { $0.action == NSSelectorFromString(selector) } }
    func key(_ selector: String, _ key: String, _ modifiers: NSEvent.ModifierFlags = [.command]) -> Bool {
        guard let item = find(selector) else { return false }
        return item.keyEquivalent == key && item.keyEquivalentModifierMask == modifiers
    }
    check("main menu: App, File, Edit, View, History, Window", mainMenu.items.map { $0.title } == ["T-Agent", "File", "Edit", "View", "History", "Window"])
    check("main menu: Edit has copy, paste, cut and select all", key("copy:", "c") && key("paste:", "v") && key("cut:", "x") && key("selectAll:", "a"))
    check("main menu: Edit has undo and redo", key("undo:", "z") && key("redo:", "z", [.command, .shift]))
    check("main menu: Edit items go to the first responder", ["copy:", "paste:", "cut:", "selectAll:", "undo:"].allSatisfy { find($0)?.target == nil })
    check("main menu: Cmd+R reloads, Cmd+[ and Cmd+] go back and forward", key("reloadPage:", "r") && key("goBack:", "[") && key("goForward:", "]")
          && find("reloadPage:")?.target === menuTarget)
    check("main menu: Cmd+W closes (hides) the window, Cmd+Q quits", key("performClose:", "w") && key("terminate:", "q"))
    check("main menu: zoom keys", key("zoomIn:", "=") && key("zoomOut:", "-") && key("actualSize:", "0"))
    check("main menu: no item takes Esc, Tab or the arrow keys", !allItems.contains { ["\u{1b}", "\t"].contains($0.keyEquivalent)
          || $0.keyEquivalent.unicodeScalars.contains { (0xF700...0xF703).contains($0.value) } })

    // The window, built offscreen with a website data store that is not persistent and no frame autosave.
    var externals: [URL] = []
    let window = MainWindowController(version: "9.9.9", dataStore: .nonPersistent(), autosave: false, inspectable: false,
                                      server: { base3000 }, openExternal: { externals.append($0) })
    check("window: swipe back and forward", window.webView.allowsBackForwardNavigationGestures)
    check("window: the user agent ends with T-AgentApp/<version>", window.webView.configuration.applicationNameForUserAgent == "T-AgentApp/9.9.9")
    if #available(macOS 13.3, *) {
        check("window: Web Inspector only when asked", !window.webView.isInspectable)
    } else {
        check("window: Web Inspector only when asked", true)
    }
    check("window: delegates are set", window.webView.navigationDelegate === window && window.webView.uiDelegate === window && window.window.delegate === window)
    check("window: never on screen in the self-test", !window.window.isVisible && window.window.frameAutosaveName.isEmpty)
    check("window: starts with the placeholder", !window.showingPage && window.webView.isHidden && window.placeholder.superview != nil)
    check("window: closing hides instead", window.windowShouldClose(window.window) == false && !window.window.isVisible)
    window.showPlaceholder(placeholderContent(stopped, config: missing))
    check("window: the placeholder shows its text and buttons", window.placeholder.titleLabel.stringValue == "T-Agent is not running"
          && !window.placeholder.startButton.isHidden && window.placeholder.startButton.title == "Start T-Agent"
          && window.placeholder.retryButton.title == "Try again")
    let view = window.placeholder
    let grid = [PlaceholderLayout.titleGap, PlaceholderLayout.sectionGap, PlaceholderLayout.buttonGap, PlaceholderLayout.margin, PlaceholderLayout.maxWidth]
    check("placeholder view: spacing on the 8 pt grid", grid.allSatisfy { $0.truncatingRemainder(dividingBy: 8) == 0 }
          && view.stack.spacing == 24 && view.stack.customSpacing(after: view.titleLabel) == 8)
    check("placeholder view: MD2 type hierarchy", view.titleLabel.font?.pointSize == 20 && view.detailLabel.font?.pointSize == 14
          && view.detailLabel.textColor == .secondaryLabelColor)
    check("placeholder view: one accent on the primary button", view.startButton.bezelColor == .controlAccentColor && view.retryButton.bezelColor == nil
          && view.startButton.keyEquivalent == "\r")
    check("placeholder view: not running shows the buttons, no spinner", view.spinner.isHidden && !view.startButton.isHidden)
    var startingState = MonitorState()
    startingState.phase = .starting
    window.updatePlaceholder(placeholderContent(startingState, config: missing))
    check("placeholder view: starting shows the spinner, no buttons", !view.spinner.isHidden && view.startButton.isHidden && view.retryButton.isHidden
          && view.titleLabel.stringValue == "Starting T-Agent…")
    check("window: Open in Browser uses the server without a page", window.currentPageURL == base3000 && externals.isEmpty)
    check("window: the tagentOpen handler is installed and holds the window weakly", window.openLinkMessages?.target === window)
    window.openLink(body: "https://example.com/pr/42", scheme: "http", host: "127.0.0.1", port: 3000)
    window.openLink(body: "https://example.com/other", scheme: "http", host: "evil.example", port: 3000)
    window.openLink(body: "file:///etc/passwd", scheme: "http", host: "127.0.0.1", port: 3000)
    check("window: a link from the page opens in the default browser, others do not",
          externals.map { $0.absoluteString } == ["https://example.com/pr/42"])

    print("\(passes) passed, \(failures) failed")
    exit(failures == 0 ? 0 : 1)
}
