// T-Agent.app: starting, restarting and stopping the T-Agent service through the process manager that runs it, and the
// health check. Building the commands is pure (covered by --self-test); the process runner, the health check and the
// timers are injected so the self-test runs no process and opens no connection. See main.swift.
import Foundation

// MARK: - Commands

enum ServiceAction: String, Equatable {
    case start, restart, stop

    var title: String {
        switch self {
        case .start: return "Start"
        case .restart: return "Restart"
        case .stop: return "Stop"
        }
    }
}

enum ServiceCommand: Equatable {
    /// Run this program with these arguments.
    case run(executable: String, arguments: [String])
    /// The app cannot do it; show these instructions instead.
    case manual(message: String)
}

/// Single-quotes a word for sh, bash and zsh: 'it'\''s'.
func shellQuote(_ word: String) -> String {
    "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

/// The person's login shell from $SHELL when it is sh, bash, zsh or ksh at an absolute path (the scripts below use their
/// syntax; fish and others get zsh), else /bin/zsh.
func loginShell(_ environment: [String: String]) -> String {
    let shell = environment["SHELL"] ?? ""
    let known = ["sh", "bash", "zsh", "ksh"]
    if shell.hasPrefix("/"), !hasControlCharacters(shell), !shell.contains(" "), known.contains((shell as NSString).lastPathComponent) {
        return shell
    }
    return "/bin/zsh"
}

/// Run before a pm2 command in the login shell: the folders where install-claude-code.sh, Homebrew and npm put node and
/// pm2, and nvm (which a profile often loads only for interactive shells) when pm2 is still not found.
let pm2Prelude = "PATH=\"$PATH:$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin\"; export PATH; "
    + "command -v pm2 >/dev/null 2>&1 || { [ -s \"$HOME/.nvm/nvm.sh\" ] && . \"$HOME/.nvm/nvm.sh\"; }; "

/// The command that starts the service in a Terminal by hand (README "Service management"), for the instructions.
func manualStartCommand(installDir: String?, pm2Name: String) -> String {
    if let dir = installDir {
        return "cd \(shellQuote(dir)) && pm2 start server.js --name \(shellQuote(pm2Name)) --cwd \(shellQuote(dir))"
    }
    return "cd <the T-Agent folder> && pm2 start server.js --name \(shellQuote(pm2Name))"
}

/// The exact command for an action, by the supervisor of app.json.
/// - pm2: `pm2 start|restart|stop <name>` through the login shell (`<shell> -lc`, so the PATH of nvm or Homebrew works).
///   Start registers the process again (`pm2 start server.js --name <name> --cwd <dir>`) when PM2 no longer knows the name
///   and the install folder is known.
/// - launchd: `launchctl kickstart -k gui/<uid>/<label>` to restart, `launchctl bootout gui/<uid>/<label>` to stop, and to
///   start `launchctl bootstrap` of ~/Library/LaunchAgents/<label>.plist when the job is not loaded, then `kickstart`.
/// - systemd, none or no app.json: instructions instead (the app never starts an unmanaged background process).
func serviceCommand(_ action: ServiceAction, config: AppConfig, uid: uid_t, home: String, environment: [String: String]) -> ServiceCommand {
    switch config.supervisor {
    case .pm2:
        let name = shellQuote(config.pm2Name)
        var script = pm2Prelude
        switch action {
        case .start:
            if let dir = config.installDir {
                script += "if [ -n \"$(pm2 id \(name) 2>/dev/null | tr -dc '0-9')\" ]; then pm2 start \(name); "
                    + "else cd \(shellQuote(dir)) && pm2 start server.js --name \(name) --cwd \(shellQuote(dir)); fi"
            } else {
                script += "pm2 start \(name)"
            }
        case .restart: script += "pm2 restart \(name)"
        case .stop: script += "pm2 stop \(name)"
        }
        return .run(executable: loginShell(environment), arguments: ["-lc", script])
    case .launchd:
        let target = "gui/\(uid)/\(config.launchdLabel)"
        switch action {
        case .start:
            let plist = (home as NSString).appendingPathComponent("Library/LaunchAgents/\(config.launchdLabel).plist")
            let script = "/bin/launchctl print \(shellQuote(target)) >/dev/null 2>&1 || /bin/launchctl bootstrap \(shellQuote("gui/\(uid)")) "
                + "\(shellQuote(plist)); /bin/launchctl kickstart \(shellQuote(target))"
            return .run(executable: "/bin/sh", arguments: ["-c", script])
        case .restart: return .run(executable: "/bin/launchctl", arguments: ["kickstart", "-k", target])
        case .stop: return .run(executable: "/bin/launchctl", arguments: ["bootout", target])
        }
    case .systemd:
        return .manual(message: "T-Agent is run by systemd, which this app does not control. Use systemctl on that machine.")
    case .none:
        if action != .start {
            return .manual(message: "T-Agent is not run by PM2 or launchd, so this app cannot \(action.rawValue) it.")
        }
        return .manual(message: "T-Agent is not run by PM2 or launchd, so this app cannot start it. "
                       + "Start the web service in Terminal (the app and your browsers then use it):\n\n"
                       + manualStartCommand(installDir: config.installDir, pm2Name: config.pm2Name))
    }
}

/// The last lines of a command's output for an alert: at most 800 characters, never empty.
func outputSummary(_ output: String, status: Int32) -> String {
    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
    let tail = trimmed.count > 800 ? "…" + String(trimmed.suffix(800)) : trimmed
    return tail.isEmpty ? "The command ended with exit code \(status)." : tail
}

// MARK: - Injected services

/// Runs a program; the completion gets the exit status and the output (stdout and stderr), on the main queue.
typealias ProcessRunner = (_ executable: String, _ arguments: [String], _ completion: @escaping (Int32, String) -> Void) -> Void

enum HealthResult: Equatable {
    /// The server answered (any HTTP status: /api/system/version needs a login, so a 401 also means it runs).
    case up(version: String?)
    case down
}

/// Asks the server; the completion runs on the main queue.
typealias HealthCheck = (_ base: URL, _ completion: @escaping (HealthResult) -> Void) -> Void

protocol Cancellable: AnyObject { func cancel() }

/// Runs `block` on the main queue after `delay` seconds unless cancelled.
typealias Scheduler = (_ delay: TimeInterval, _ block: @escaping () -> Void) -> Cancellable

final class DispatchCancellable: Cancellable {
    let item: DispatchWorkItem
    init(_ item: DispatchWorkItem) { self.item = item }
    func cancel() { item.cancel() }
}

func dispatchScheduler() -> Scheduler {
    return { delay, block in
        let item = DispatchWorkItem(block: block)
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, delay), execute: item)
        return DispatchCancellable(item)
    }
}

/// The version in the answer of GET /api/system/version (`app_version`, or `version`).
func versionFromAnswer(_ data: Data?) -> String? {
    guard let data = data, let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    for key in ["app_version", "version"] {
        if let text = object[key] as? String, !text.isEmpty, text.count <= 64, !hasControlCharacters(text) { return text }
    }
    return nil
}

/// GET <base>/api/system/version with a 2 s timeout, no proxy (http_proxy must never catch 127.0.0.1), no cache, no cookies.
func urlSessionHealthCheck() -> HealthCheck {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.connectionProxyDictionary = [:]
    configuration.timeoutIntervalForRequest = 2
    configuration.timeoutIntervalForResource = 2
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.httpShouldSetCookies = false
    let session = URLSession(configuration: configuration)
    return { base, completion in
        var request = URLRequest(url: base.appendingPathComponent("api/system/version"))
        request.timeoutInterval = 2
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        session.dataTask(with: request) { data, response, _ in
            let result: HealthResult
            if let http = response as? HTTPURLResponse {
                result = .up(version: http.statusCode == 200 ? versionFromAnswer(data) : nil)
            } else {
                result = .down
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }
}

/// Runs the program with no input, collects stdout and stderr, ends it after 90 s. The output is collected as it arrives
/// and taken when the program exits, so a daemon it leaves behind holding the pipe (the PM2 daemon) never blocks it.
func foundationProcessRunner() -> ProcessRunner {
    return { executable, arguments, completion in
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.standardInput = FileHandle.nullDevice
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            let lock = NSLock()
            var collected = Data()
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                lock.lock()
                if collected.count < 1_000_000 { collected.append(chunk) }
                lock.unlock()
            }
            do {
                try process.run()
            } catch {
                pipe.fileHandleForReading.readabilityHandler = nil
                DispatchQueue.main.async { completion(-1, error.localizedDescription) }
                return
            }
            let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 90, execute: deadline)
            process.waitUntilExit()
            deadline.cancel()
            Thread.sleep(forTimeInterval: 0.1)
            pipe.fileHandleForReading.readabilityHandler = nil
            lock.lock()
            let output = String(decoding: collected, as: UTF8.self)
            lock.unlock()
            let status = process.terminationStatus
            DispatchQueue.main.async { completion(status, output) }
        }
    }
}
