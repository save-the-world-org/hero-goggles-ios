import AVFoundation
import CoreMotion
import Foundation
import NearbyInteraction
import Observation
import UIKit
import os
import simd

/// Seeking a UWB beacon: the phone and the beacon range over Ultra Wideband with Apple's Nearby Interaction, as an
/// accessory session. `BeaconLink` carries the messages over Bluetooth: the phone asks the beacon for its UWB settings
/// (initialize), runs a session with them, and sends the session's own settings back (configure and start); the beacon
/// starts ranging and the session reports distance, and with camera assistance direction.
///
/// An iPhone gives a third-party beacon's direction only with camera assistance (Apple's documentation of
/// `NINearbyObject.direction`): ARKit has to see the room while the phone moves. Without it there is distance, and
/// closer or farther. The way goes to the phone's screen (`SeekView`), the glasses (`glance`) and the ear (`Voice`).
@MainActor
@Observable
final class Seeker: NSObject {
    enum Phase: Equatable {
        case off
        /// Bluetooth: looking for the beacon, or connecting to it.
        case looking
        /// Connected, and the beacon and the phone agreeing their UWB settings.
        case starting
        case ranging
        /// Ranging stopped (out of range, or blocked): the phone asks the beacon to start again.
        case lost
        case unavailable(String)
    }

    /// Which way the beacon is from where the phone points.
    enum Turn: Equatable {
        case ahead, slightRight, slightLeft, right, left, behind
    }

    enum Trend: Equatable {
        case closer, farther, steady
    }

    /// Closer than this, the seeking is done.
    static let arrived: Float = 0.4

    /// Who the beacon finds while the Influence API targets nobody (`InfluenceLink`).
    static let defaultName = "Hero"
    /// Who the beacon finds, and the title on the glasses and the phone: the Influence API's target, else Hero.
    private(set) var name = Seeker.defaultName
    var title: String { "\(name) Finder" }

    /// A reading with a distance, as the seek takes it: what goes to the Influence API's live map (`InfluenceLink`).
    struct Reading {
        let distance: Float
        /// Radians right of where the phone points, as `azimuth`.
        let azimuth: Float?
        /// Radians above the phone's level, when there is a direction.
        let elevation: Float?
        let trend: Trend
        /// The ranged beacon's 8-hex ID; nil on the simulated walk.
        let beacon: String?
    }

    /// Each reading with a distance, as it comes (`InfluenceLink.send`).
    @ObservationIgnored var onReading: (@MainActor (Reading) -> Void)?

    private(set) var phase: Phase = .off
    /// Meters.
    private(set) var distance: Float?
    /// Radians from where the phone points, right positive: from `direction`, else `horizontalAngle`.
    private(set) var azimuth: Float?
    private(set) var trend: Trend = .steady
    private(set) var vertical: String?
    /// What to do with the phone while camera assistance has not yet worked out the direction.
    private(set) var coaching: String?
    private(set) var problem: String?
    /// Nearby Interaction's own readings, as it gave them.
    private(set) var rawHorizontalAngle: Float?
    private(set) var rawDirection: simd_float3?
    private(set) var updated: Date?
    private(set) var simulated = false
    /// Whether you are on the move (the phone's motion activity: walking, running, cycling), so a growing distance tells
    /// who moves: the hero, while you stand still, or you, walking the wrong way. Nil until the phone has said.
    private(set) var youAreMoving: Bool?
    /// The file this session's readings go to, in the app's Documents.
    private(set) var logName: String?
    /// Where the hero was when last heard, kept after the signal goes: "last seen" while they are lost.
    private(set) var lastSeen: LastSeen?
    /// The hero is past `alertBeyond`: the alert has gone off, and goes off again only once they have come back inside.
    private(set) var separated = false

    struct LastSeen: Equatable {
        let distance: Float
        /// Which way, in words, when there was a direction.
        let way: String?
        let at: Date
    }

    /// Direction through Apple's camera assistance (ARKit). Changing it starts the session again.
    var cameraAssistance = true {
        didSet { if oldValue != cameraAssistance { restart() } }
    }
    var speaks = true {
        didSet { if !speaks { voice.stop() } }
    }
    var showsOnGlasses = true
    /// Hot and cold beeps through the glasses (`Beeper`): faster closer, higher while coming closer.
    var beeps = true {
        didSet { beeps ? startBeeping() : stopBeeping() }
    }
    /// An alert on the lens, aloud and in the hand when the hero goes farther than `alertBeyond` meters.
    var separationAlert = true
    var alertBeyond: Float = 10

    let link = BeaconLink()

    @ObservationIgnored private var session: NISession?
    @ObservationIgnored private var history: [(at: Date, meters: Float)] = []
    @ObservationIgnored private var azimuthAt: Date?
    @ObservationIgnored private let voice = Voice()
    @ObservationIgnored private var simulation: Task<Void, Never>?
    @ObservationIgnored private let activity = CMMotionActivityManager()
    @ObservationIgnored private let readings = SeekLog()
    @ObservationIgnored private let beeper = Beeper()
    @ObservationIgnored private var beeping: Task<Void, Never>?

    private static let log = Logger(subsystem: "io.darkshift.rayban-spike", category: "seek")

    static var capabilities: any NIDeviceCapability { NISession.deviceCapabilities }

    var active: Bool { phase != .off }

    // MARK: - Starting and stopping

    func start() {
        if simulated { stop() }
        guard !active else { return }
        problem = nil
        guard Self.capabilities.supportsPreciseDistanceMeasurement else {
            phase = .unavailable("This iPhone can't range over UWB (or this is a simulator).")
            return
        }
        link.onReady = { [weak self] in self?.begin() }
        link.onMessage = { [weak self] id, data in self?.heard(id, data) }
        link.onLost = { [weak self] in self?.beaconLost() }
        // The voice and the beeps play to whatever the phone plays to: the glasses, when they are its headphones.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        phase = .looking
        link.start()
        watchActivity()
        logName = readings.open()
        startBeeping()
        UIApplication.shared.isIdleTimerDisabled = true
    }

    /// Whom to find, from the Influence API (`InfluenceLink`): every screen's title becomes "<Name> Finder", the voice
    /// says "Finding <Name>", and seeking starts if it was off. The beacon is the one whose 8-hex ID matches the
    /// target's `hardwareId`. Nobody goes back to Hero. Ranging, the alerts and the lens go on as they were.
    func find(_ who: String?, beacon: String? = nil) {
        let id = BeaconLink.beaconID(beacon)
        if id != link.preferred {
            // Another beacon: where the last one was is no use, and the link scans again for the new one.
            lastSeen = nil
            separated = false
            link.preferred = id
        }
        let next = who ?? Self.defaultName
        guard next != name else { return }
        name = next
        guard who != nil else {
            // Nobody targeted: no beacon to range, so back to the Hero Finder screen.
            if active, !simulated { stop() }
            return
        }
        if !active { start() }
        if speaks { voice.say(Voice.Line(key: "finding \(next)", words: "Finding \(next).", urgent: true)) }
    }

    private func startBeeping() {
        guard beeps, active, !simulated, beeping == nil else { return }
        beeping = Task { [weak self] in
            while !Task.isCancelled {
                guard let pause = self?.beepOnce() else { return }
                try? await Task.sleep(for: .milliseconds(pause))
            }
        }
    }

    private func stopBeeping() {
        beeping?.cancel()
        beeping = nil
        beeper.stop()
    }

    /// One beep for where the hero is now, and the milliseconds to the next: two seconds apart at 20 m, quicker as they
    /// come closer, eight a second once there. High while they come closer, low while they get farther.
    private func beepOnce() -> Int {
        guard phase == .ranging, let distance else { return 400 }
        let frequency = switch trend {
        case .closer: 1046.5
        case .farther: 523.3
        case .steady: 784.0
        }
        beeper.beep(frequency: frequency)
        if distance < Self.arrived { return 120 }
        return Int(min(2000, 150 + Double(distance) * 90))
    }

    /// The phone's motion activity, to tell who moves (`motion`).
    private func watchActivity() {
        guard CMMotionActivityManager.isActivityAvailable() else { return }
        activity.startActivityUpdates(to: .main) { [weak self] update in
            guard let update, update.confidence != .low else { return }
            let moving = update.walking || update.running || update.cycling
            let still = update.stationary
            MainActor.assumeIsolated {
                if moving {
                    self?.youAreMoving = true
                } else if still {
                    self?.youAreMoving = false
                }
            }
        }
    }

    func stop() {
        simulation?.cancel()
        simulation = nil
        simulated = false
        if session != nil { link.send(.stop) }
        session?.invalidate()
        session = nil
        link.stop()
        activity.stopActivityUpdates()
        youAreMoving = nil
        readings.close()
        stopBeeping()
        phase = .off
        clear()
        lastSeen = nil
        separated = false
        voice.stop()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    /// A fresh session, and the beacon asked for its UWB settings: the start, and every start again. While the hero is
    /// lost, the screens stay on where they were last seen until ranging comes back.
    private func begin() {
        guard active, !simulated else { return }
        makeSession()
        if phase != .lost { phase = .starting }
        link.send(.initialize)
    }

    /// The signal is gone: the screens say where the hero was last seen, and the voice says it once.
    private func lose() {
        guard active, phase != .lost else { return }
        guard let lastSeen else {
            phase = .looking
            return
        }
        phase = .lost
        let way = lastSeen.way.map { ", \($0)" } ?? ""
        voice.say(Voice.Line(key: "lost", words: "Lost \(name). Last seen \(Self.spokenDistance(lastSeen.distance))\(way).",
                             urgent: true))
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }

    private func makeSession() {
        session?.invalidate()
        let session = NISession()
        session.delegate = self
        session.delegateQueue = .main
        self.session = session
    }

    private func restart() {
        guard active, !simulated, case .connected = link.state else { return }
        link.send(.stop)
        clear()
        begin()
    }

    private func heard(_ id: BeaconLink.MessageID, _ data: Data) {
        switch id {
        case .accessoryConfigurationData:
            do {
                let configuration = try NINearbyAccessoryConfiguration(data: data)
                if cameraAssistance, Self.capabilities.supportsCameraAssistance {
                    configuration.isCameraAssistanceEnabled = true
                }
                if session == nil { makeSession() }
                session?.run(configuration)
                Self.log.info("session run, camera assistance \(configuration.isCameraAssistanceEnabled)")
            } catch {
                problem = "The beacon's UWB settings were refused: \(error.localizedDescription)."
            }
        case .accessoryUWBDidStart:
            phase = .ranging
        case .accessoryUWBDidStop:
            if phase == .ranging { lose() }
        case .initialize, .configureAndStart, .stop:
            break
        }
    }

    /// Bluetooth lost the beacon (out of range, or switched off): lost, if it had been found; the link looks again.
    private func beaconLost() {
        session?.invalidate()
        session = nil
        guard active else { return }
        clear()
        lose()
    }

    private func clear() {
        distance = nil
        azimuth = nil
        azimuthAt = nil
        trend = .steady
        vertical = nil
        coaching = nil
        rawDirection = nil
        rawHorizontalAngle = nil
        updated = nil
        history = []
    }

    // MARK: - Readings

    private func take(distance: Float?, direction: simd_float3?, horizontalAngle: Float?, vertical: String?) {
        let now = Date.now
        rawDirection = direction
        rawHorizontalAngle = horizontalAngle
        if let distance {
            self.distance = distance
            history.append((now, distance))
            history.removeAll { now.timeIntervalSince($0.at) > 3 }
            trend = Self.trend(history)
        }
        if let direction {
            azimuth = atan2(direction.x, -direction.z)
            azimuthAt = now
        } else if let horizontalAngle {
            azimuth = horizontalAngle
            azimuthAt = now
        } else if let at = azimuthAt, now.timeIntervalSince(at) > 2 {
            // A direction older than two seconds points nowhere useful.
            azimuth = nil
            azimuthAt = nil
        }
        if let distance {
            let way = azimuth.map { Self.words(Self.turn($0)).lowercased() }
            lastSeen = LastSeen(distance: distance, way: way, at: now)
            if separationAlert, !separated, distance > alertBeyond {
                separated = true
                let words = "\(name) is past \(Int(alertBeyond)) meters\(way.map { ", \($0)" } ?? "")."
                voice.say(Voice.Line(key: words, words: words, urgent: true))
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
            } else if separated, distance < alertBeyond - 1 {
                separated = false
            }
        }
        self.vertical = vertical
        updated = now
        readings.write(at: now, distance: distance, horizontalAngle: horizontalAngle, direction: direction,
                       azimuth: azimuth, trend: trend, youAreMoving: youAreMoving, coaching: coaching)
        if speaks { voice.say(spoken) }
        if let distance {
            let elevation = direction.map { atan2($0.y, ($0.x * $0.x + $0.z * $0.z).squareRoot()) }
            onReading?(Reading(distance: distance, azimuth: azimuth, elevation: elevation, trend: trend,
                               beacon: link.connectedID))
        }
    }

    /// Closer or farther: the last half second against what it was a second and a half before.
    private static func trend(_ history: [(at: Date, meters: Float)]) -> Trend {
        guard let last = history.last else { return .steady }
        let recent = history.filter { last.at.timeIntervalSince($0.at) < 0.6 }.map { $0.meters }
        let older = history.filter { last.at.timeIntervalSince($0.at) > 1.5 }.map { $0.meters }
        guard !recent.isEmpty, !older.isEmpty else { return .steady }
        let change = recent.reduce(0, +) / Float(recent.count) - older.reduce(0, +) / Float(older.count)
        if change < -0.15 { return .closer }
        if change > 0.15 { return .farther }
        return .steady
    }

    static func turn(_ azimuth: Float) -> Turn {
        let degrees = azimuth * 180 / .pi
        switch abs(degrees) {
        case ..<15: return .ahead
        case ..<50: return degrees > 0 ? .slightRight : .slightLeft
        case ..<135: return degrees > 0 ? .right : .left
        default: return .behind
        }
    }

    static func words(_ turn: Turn) -> String {
        switch turn {
        case .ahead: "Straight ahead"
        case .slightRight: "Slightly right"
        case .slightLeft: "Slightly left"
        case .right: "To your right"
        case .left: "To your left"
        case .behind: "Behind you"
        }
    }

    /// A distance as the screens show it: centimeters, in fives, under a meter; meters to a tenth above.
    static func meters(_ distance: Float) -> String {
        if distance < 1 { return "\(Int((distance * 20).rounded()) * 5) cm" }
        return String(format: "%.1f m", Double(distance))
    }

    /// A distance as the voice says it: whole meters from 5 m, tenths from 1 m, tens of centimeters under a meter.
    static func spokenDistance(_ distance: Float) -> String {
        if distance >= 5 { return "\(Int(distance.rounded())) meters" }
        if distance >= 1 {
            let tenths = (distance * 10).rounded() / 10
            return tenths == 1 ? "1 meter" : String(format: "%.1f meters", Double(tenths))
        }
        return "\(max(10, Int((distance * 10).rounded()) * 10)) centimeters"
    }

    /// The arrow for the glasses, in degrees right of ahead, in tens: a new drawing only when it turns that far.
    static func arrowDegrees(_ azimuth: Float) -> Int {
        Int((azimuth * 180 / .pi / 10).rounded()) * 10
    }

    // MARK: - Words for the screens and the ear

    /// The way in a few words.
    var guidance: String {
        switch phase {
        case .off: return "Not seeking"
        case .looking:
            if case .connecting = link.state { return "Connecting to the beacon…" }
            return link.preferred == nil ? "Waiting for a target…" : "Looking for the beacon…"
        case .starting: return "Starting UWB…"
        case .lost: return lastSeen.map { "Lost \(name). \(Self.lastSeenWords($0))" } ?? "Lost the signal"
        case .unavailable(let why): return why
        case .ranging:
            guard let distance else { return "Starting UWB…" }
            if distance < Self.arrived { return "You're there" }
            if let azimuth { return Self.words(Self.turn(azimuth)) }
            switch trend {
            case .closer: return "Getting closer"
            case .farther: return "Getting farther"
            case .steady: return "Walk, and watch the distance"
            }
        }
    }

    /// What helps next, under the way: camera assistance's coaching, or how to get a direction at all.
    var note: String? {
        guard phase == .ranging, !simulated else { return nil }
        if let coaching { return coaching }
        if azimuth == nil {
            return cameraAssistance
                ? "For an arrow: hold the phone up, camera forward, and sweep it slowly."
                : "Distance only: turn on Direction for an arrow."
        }
        return vertical
    }

    var phaseWords: String {
        switch phase {
        case .off: "Off"
        case .looking: "Waiting for Bluetooth"
        case .starting: "Agreeing UWB settings"
        case .ranging: simulated ? "Simulated" : "Ranging"
        case .lost: "Lost: starting again"
        case .unavailable(let why): why
        }
    }

    var linkWords: String {
        if simulated { return "Simulated" }
        switch link.state {
        case .off: return "Off, or not allowed"
        case .idle: return "Not looking"
        case .scanning: return link.preferred == nil ? "Waiting for a target" : "Looking for the beacon"
        case .connecting(let name): return "Connecting to \(name)"
        case .connected(let name): return "Connected to \(name)"
        }
    }

    /// The glasses' screen while not seeking: one button, which a pinch of the Neural Band presses to start.
    var invitation: Glance {
        Glance(place: title, status: "Find \(name)", line: "Pinch Find to start.",
               note: "Or tap \(title) at the top of the phone.",
               choices: [.init(press: .seek, label: "Find", icon: "triangleRight", primary: true)])
    }

    /// The glasses' screen while seeking: the title, the arrow when there is a direction, the distance, a few words.
    var glance: Glance {
        if phase == .lost, let lastSeen {
            return Glance(place: title, status: "Lost \(name)", line: Self.lastSeenWords(lastSeen), note: nil,
                          choices: [], way: true)
        }
        guard phase == .ranging, let distance else {
            return Glance(place: title, status: lensPhase, line: guidance, note: nil, choices: [], way: true)
        }
        if distance < Self.arrived {
            return Glance(place: title, status: "You're there",
                          line: "\(name) is within \(Self.meters(distance))", note: nil, choices: [], way: true)
        }
        return Glance(place: title, status: Self.meters(distance), line: lensLine, note: nil, choices: [],
                      arrow: azimuth.map(Self.arrowDegrees), way: true)
    }

    private var lensPhase: String {
        switch phase {
        case .off: "Off"
        case .looking: "Looking…"
        case .starting: "Connecting…"
        case .ranging: "Starting…"
        case .lost: "Lost the signal"
        case .unavailable: "Can't seek"
        }
    }

    /// Who moves, when the distance changes: the hero, while you stand still; you, walking the wrong way.
    var motion: String? {
        guard phase == .ranging, let youAreMoving else { return nil }
        switch (trend, youAreMoving) {
        case (.farther, false): return "\(name) is moving away"
        case (.closer, false): return "\(name) is coming closer"
        case (.farther, true): return azimuth == nil ? "Wrong way: turn around" : nil
        default: return nil
        }
    }

    /// "Last seen 8.2 m, slightly left, at 18:42": the clock time, which does not go stale on the lens.
    static func lastSeenWords(_ seen: LastSeen) -> String {
        "Last seen \(meters(seen.distance))\(seen.way.map { ", \($0)" } ?? ""), at "
            + seen.at.formatted(date: .omitted, time: .shortened)
    }

    /// The few words under the distance on the glasses: past the alert line, which way, and who moves.
    private var lensLine: String {
        let line = wayLine
        return separated ? "Past \(Int(alertBeyond)) m · \(line)" : line
    }

    private var wayLine: String {
        let way = azimuth.map { Self.words(Self.turn($0)) }
        switch (way, motion) {
        case let (way?, motion?): return "\(way) · \(motion)"
        case let (way?, nil): return way
        case let (nil, motion?): return motion
        case (nil, nil):
            switch trend {
            case .closer: return "Getting closer"
            case .farther: return "Getting farther"
            case .steady: return cameraAssistance ? "Hold the phone up for an arrow" : "Walk, and watch the distance"
            }
        }
    }

    /// The line said aloud: the distance in steps a person hears (whole meters far off, halves near), and the way.
    private var spoken: Voice.Line? {
        guard phase == .ranging, let distance else { return nil }
        if distance < Self.arrived { return Voice.Line(key: "there", words: "You're there.", urgent: true) }
        let far = Self.spokenDistance(distance)
        let words: String
        if let motion {
            words = "\(motion), \(far.lowercased())."
        } else if let azimuth {
            words = "\(far), \(Self.words(Self.turn(azimuth)).lowercased())."
        } else {
            switch trend {
            case .closer: words = "\(far), closer."
            case .farther: words = "\(far), farther."
            case .steady: words = "\(far)."
            }
        }
        return Voice.Line(key: words, words: words, urgent: false)
    }

    // MARK: - A simulated beacon

    /// Made-up readings, a walk toward a beacon that swings left and right, for the preview on a simulator. Silent: a
    /// simulator speaks through the Mac's speakers.
    func simulate() {
        stop()
        speaks = false
        beeps = false
        simulated = true
        phase = .ranging
        simulation = Task { [weak self] in
            var t = 0.0
            while !Task.isCancelled {
                t += 0.25
                let walked = t.truncatingRemainder(dividingBy: 30) / 30
                let distance = Float(0.3 + 5.7 * (1 - walked))
                let angle = Float(sin(t / 2.5) * 1.4)
                self?.take(distance: distance, direction: nil, horizontalAngle: angle, vertical: nil)
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }
}

extension Seeker: @preconcurrency NISessionDelegate {
    func session(_ session: NISession, didGenerateShareableConfigurationData shareableConfigurationData: Data,
                 for object: NINearbyObject) {
        guard session === self.session else { return }
        link.send(.configureAndStart, shareableConfigurationData)
    }

    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard session === self.session, let object = nearbyObjects.first else { return }
        if phase != .ranging { phase = .ranging }
        take(distance: object.distance, direction: object.direction, horizontalAngle: object.horizontalAngle,
             vertical: Self.words(object.verticalDirectionEstimate))
    }

    func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject],
                 reason: NINearbyObject.RemovalReason) {
        guard session === self.session else { return }
        lose()
        // Timed out (out of range, or blocked): the beacon starts over, with fresh settings.
        if reason == .timeout {
            link.send(.stop)
            begin()
        }
    }

    func sessionWasSuspended(_ session: NISession) {
        guard session === self.session else { return }
        link.send(.stop)
    }

    func sessionSuspensionEnded(_ session: NISession) {
        guard session === self.session else { return }
        begin()
    }

    func session(_ session: NISession, didInvalidateWith error: any Error) {
        guard session === self.session else { return }
        self.session = nil
        if let error = error as? NIError, error.code == .userDidNotAllow {
            phase = .unavailable("Nearby Interaction isn't allowed: Settings › Apps › Ray-Ban spike.")
            return
        }
        problem = "Nearby Interaction stopped: \(error.localizedDescription)."
        if case .connected = link.state { begin() }
    }

    func session(_ session: NISession, didUpdateAlgorithmConvergence convergence: NIAlgorithmConvergence,
                 for object: NINearbyObject?) {
        guard session === self.session else { return }
        switch convergence.status {
        case .notConverged(let reasons): coaching = Self.coaching(reasons)
        default: coaching = nil
        }
    }

    private static func coaching(_ reasons: [NIAlgorithmConvergenceStatus.Reason]) -> String {
        var asks: [String] = []
        for reason in reasons {
            switch reason {
            case .insufficientHorizontalSweep: asks.append("sweep the phone left and right")
            case .insufficientVerticalSweep: asks.append("tilt it up and down")
            case .insufficientMovement: asks.append("walk a few steps")
            case .insufficientLighting: asks.append("find more light")
            default: break
            }
        }
        guard !asks.isEmpty else { return "For an arrow: hold the phone up and move it slowly." }
        return "For an arrow: " + asks.joined(separator: ", ") + "."
    }

    private static func words(_ vertical: NINearbyObject.VerticalDirectionEstimate) -> String? {
        switch vertical {
        case .above: "It's above you"
        case .below: "It's below you"
        case .aboveOrBelow: "It's above or below you"
        default: nil
        }
    }
}

/// Says the way through whatever the phone plays to: the glasses, when they are its headphones. A new line waits for
/// the last to finish and for two and a half seconds to pass, except arriving, which is said at once.
@MainActor
final class Voice {
    struct Line: Equatable {
        let key: String
        let words: String
        let urgent: Bool
    }

    private let synthesizer = AVSpeechSynthesizer()
    private var last: String?
    private var at = Date.distantPast
    private var ready = false

    func say(_ line: Line?) {
        guard let line, line.key != last else { return }
        guard line.urgent || (Date.now.timeIntervalSince(at) > 2.5 && !synthesizer.isSpeaking) else { return }
        if !ready {
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            ready = true
        }
        if line.urgent { synthesizer.stopSpeaking(at: .immediate) }
        last = line.key
        at = .now
        synthesizer.speak(AVSpeechUtterance(string: line.words))
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        last = nil
    }
}
