// T-Agent.app: whether the T-Agent web service runs, when to ask again, the one automatic start at launch and the
// service actions. `stepMonitor` is a pure state machine (covered by --self-test); `ServiceMonitor` runs it with the
// injected health check, process runner, clock and timers. See main.swift.
import Foundation

// MARK: - State machine

enum ServicePhase: Equatable {
    /// The first check after launch has not answered yet.
    case checking
    case running
    case notRunning
    /// A start was sent (automatically at launch or by the person); waiting for the server to answer.
    case starting
    case restarting
    case stopping
}

/// The intervals of the checks, in seconds.
enum MonitorTiming {
    /// While the server does not answer: try again every 5 s.
    static let notRunning: TimeInterval = 5
    /// While it runs: a cheap check every 15 s keeps the menu bar status right.
    static let running: TimeInterval = 15
    /// While a start, restart or stop is under way.
    static let busy: TimeInterval = 1
    /// A second check soon after one failure of a running server.
    static let recheck: TimeInterval = 1
    /// Right after a command ended.
    static let afterCommand: TimeInterval = 0.5
    /// A start that is not answered within this time has failed.
    static let startTimeout: TimeInterval = 60
    /// A stop after which the server still answers this long has failed.
    static let stopTimeout: TimeInterval = 20
    /// Failed checks in a row before a running server counts as gone (one failure can be a restart in progress).
    static let failuresBeforeDown = 2
}

struct MonitorState: Equatable {
    var phase: ServicePhase = .checking
    /// The version the server reported (nil until it answered with one).
    var version: String?
    var failuresInARow = 0
    /// The automatic start at launch happens at most once per app run (also when any other command already ran).
    var autoStartTried = false
    var busySince: Date?
    var commandRunning = false
    /// The running command was asked for by the person (a failure shows an alert); false for the automatic start.
    var userCommand = false
    /// Why the last start or stop failed, shown in the not-running view.
    var lastError: String?
    /// The web view shows the page (false: the placeholder).
    var pageShown = false
}

struct MonitorContext: Equatable {
    /// The supervisor can be controlled (PM2 or launchd).
    var canControl: Bool
    /// The preference "Start T-Agent when the app opens".
    var autoStart: Bool
}

enum MonitorEvent: Equatable {
    case launched
    case health(HealthResult)
    /// The person asked for an action (Stop and Restart were confirmed already).
    case request(ServiceAction)
    case commandFinished(ServiceAction, ok: Bool, output: String)
    /// "Try again", a failed page load or a deep link: check now.
    case checkNow
}

enum MonitorEffect: Equatable {
    case check(after: TimeInterval)
    case run(ServiceAction)
    case showPage
    case showPlaceholder
    /// The app cannot do this action (no supervisor it controls): explain how.
    case explain(ServiceAction)
    /// A command the person asked for failed: show its output.
    case commandFailed(ServiceAction, String)
}

/// Whether the launch check that found no server starts it: once, when the preference is on and PM2 or launchd runs it.
func shouldAutoStart(_ state: MonitorState, _ context: MonitorContext) -> Bool {
    state.phase == .checking && context.autoStart && context.canControl && !state.autoStartTried && !state.commandRunning
}

private func becomeRunning(_ state: inout MonitorState) -> [MonitorEffect] {
    state.phase = .running
    state.busySince = nil
    state.lastError = nil
    state.failuresInARow = 0
    var effects: [MonitorEffect] = []
    if !state.pageShown {
        state.pageShown = true
        effects.append(.showPage)
    }
    effects.append(.check(after: MonitorTiming.running))
    return effects
}

private func becomeNotRunning(_ state: inout MonitorState, error: String? = nil) -> [MonitorEffect] {
    state.phase = .notRunning
    state.busySince = nil
    if let error = error { state.lastError = error }
    var effects: [MonitorEffect] = []
    if state.pageShown {
        state.pageShown = false
        effects.append(.showPlaceholder)
    }
    effects.append(.check(after: MonitorTiming.notRunning))
    return effects
}

private func elapsed(_ state: MonitorState, _ now: Date) -> TimeInterval {
    state.busySince.map { now.timeIntervalSince($0) } ?? 0
}

/// One step of the state machine: changes `state` and returns what to do.
func stepMonitor(_ state: inout MonitorState, _ event: MonitorEvent, now: Date, context: MonitorContext) -> [MonitorEffect] {
    switch event {
    case .launched:
        state = MonitorState()
        return [.check(after: 0)]

    case .health(.up(let version)):
        if let version = version { state.version = version }
        state.failuresInARow = 0
        switch state.phase {
        case .restarting:
            return [.check(after: MonitorTiming.busy)]
        case .stopping:
            if state.commandRunning || elapsed(state, now) <= MonitorTiming.stopTimeout { return [.check(after: MonitorTiming.busy)] }
            let effects = becomeRunning(&state)
            state.lastError = "T-Agent still answers after the stop command."
            return effects
        default:
            return becomeRunning(&state)
        }

    case .health(.down):
        switch state.phase {
        case .running:
            state.failuresInARow += 1
            if state.failuresInARow >= MonitorTiming.failuresBeforeDown { return becomeNotRunning(&state) }
            return [.check(after: MonitorTiming.recheck)]
        case .checking:
            if shouldAutoStart(state, context) {
                state.autoStartTried = true
                state.phase = .starting
                state.busySince = now
                state.commandRunning = true
                state.userCommand = false
                state.lastError = nil
                return [.run(.start)]
            }
            return becomeNotRunning(&state)
        case .notRunning:
            return [.check(after: MonitorTiming.notRunning)]
        case .starting:
            if !state.commandRunning && elapsed(state, now) > MonitorTiming.startTimeout {
                return becomeNotRunning(&state, error: "T-Agent did not answer within \(Int(MonitorTiming.startTimeout)) seconds after the start.")
            }
            return [.check(after: MonitorTiming.busy)]
        case .restarting:
            return [.check(after: MonitorTiming.busy)]
        case .stopping:
            if state.commandRunning { return [.check(after: MonitorTiming.busy)] }
            state.lastError = nil
            return becomeNotRunning(&state)
        }

    case .request(let action):
        if state.commandRunning { return [] }
        switch action {
        case .start:
            guard state.phase == .notRunning || state.phase == .checking else { return [] }
            guard context.canControl else { return [.explain(.start)] }
            state.phase = .starting
        case .restart, .stop:
            guard state.phase == .running else { return [] }
            guard context.canControl else { return [.explain(action)] }
            state.phase = action == .restart ? .restarting : .stopping
        }
        state.autoStartTried = true
        state.busySince = now
        state.commandRunning = true
        state.userCommand = true
        state.lastError = nil
        return [.run(action)]

    case .commandFinished(let action, let ok, let output):
        guard state.commandRunning else { return [] }
        state.commandRunning = false
        let byPerson = state.userCommand
        state.userCommand = false
        if ok {
            switch action {
            case .start:
                if state.phase == .starting { state.busySince = now }
            case .restart:
                state.phase = .starting
                state.busySince = now
            case .stop:
                state.busySince = now
            }
            return state.phase == .running ? [] : [.check(after: MonitorTiming.afterCommand)]
        }
        if state.phase != .running { state.lastError = output }
        var effects: [MonitorEffect] = byPerson ? [.commandFailed(action, output)] : []
        switch action {
        case .start:
            if state.phase == .starting {
                state.phase = .notRunning
                state.busySince = nil
            }
        case .restart, .stop:
            // The server may still run, or may be gone: the next check tells (two failures make it "not running").
            state.phase = .running
            state.busySince = nil
        }
        effects.append(.check(after: MonitorTiming.afterCommand))
        return effects

    case .checkNow:
        switch state.phase {
        case .running, .notRunning: return [.check(after: 0)]
        default: return []
        }
    }
}

// MARK: - Injected environment

/// Everything the app reads from or does to the outside, passed in so the self-test replaces each one.
struct AppServices {
    var environment: [String: String]
    var home: String
    var uid: uid_t
    var readFile: (String) -> Data?
    var defaultsDataHome: () -> String?
    var health: HealthCheck
    var runner: ProcessRunner
    var schedule: Scheduler
    var now: () -> Date
    var openURL: (URL) -> Void
    var copyText: (String) -> Void

    func loadConfig() -> AppConfig {
        loadAppConfig(environment: environment, defaultsValue: defaultsDataHome(), home: home, readFile: readFile)
    }

    func command(_ action: ServiceAction, config: AppConfig) -> ServiceCommand {
        serviceCommand(action, config: config, uid: uid, home: home, environment: environment)
    }
}

// MARK: - Monitor

/// Runs the state machine: schedules the checks (one pending at a time; an answer to an older check is dropped), reads
/// app.json before every check, runs the commands and hands the effects for the window to `onEffect`.
final class ServiceMonitor {
    private(set) var state = MonitorState()
    private(set) var config: AppConfig
    let services: AppServices
    var autoStart: () -> Bool
    /// After every event (the placeholder text and the menu follow the state).
    var onChange: (() -> Void)?
    /// showPage, showPlaceholder, explain and commandFailed.
    var onEffect: ((MonitorEffect) -> Void)?
    private var pending: Cancellable?
    private var generation = 0
    /// How many health checks were sent (the self-test counts them).
    private(set) var checksSent = 0

    init(services: AppServices, autoStart: @escaping () -> Bool) {
        self.services = services
        self.autoStart = autoStart
        self.config = services.loadConfig()
    }

    var context: MonitorContext { MonitorContext(canControl: config.supervisor.controllable, autoStart: autoStart()) }

    func start() { send(.launched) }

    func send(_ event: MonitorEvent) {
        let effects = stepMonitor(&state, event, now: services.now(), context: context)
        onChange?()
        for effect in effects { perform(effect) }
    }

    func reloadConfig() {
        let fresh = services.loadConfig()
        let moved = fresh.url != config.url
        config = fresh
        if moved && state.pageShown && state.phase == .running { onEffect?(.showPage) }
    }

    private func perform(_ effect: MonitorEffect) {
        switch effect {
        case .check(let delay): scheduleCheck(delay)
        case .run(let action): run(action)
        default: onEffect?(effect)
        }
    }

    private func scheduleCheck(_ delay: TimeInterval) {
        pending?.cancel()
        generation += 1
        let current = generation
        pending = services.schedule(delay) { [weak self] in self?.check(current) }
    }

    private func check(_ current: Int) {
        guard current == generation else { return }
        reloadConfig()
        checksSent += 1
        services.health(config.url) { [weak self] result in
            guard let self = self, current == self.generation else { return }
            self.send(.health(result))
        }
    }

    private func run(_ action: ServiceAction) {
        switch services.command(action, config: config) {
        case .manual(let message):
            send(.commandFinished(action, ok: false, output: message))
        case .run(let executable, let arguments):
            services.runner(executable, arguments) { [weak self] status, output in
                self?.send(.commandFinished(action, ok: status == 0, output: outputSummary(output, status: status)))
            }
        }
    }
}
