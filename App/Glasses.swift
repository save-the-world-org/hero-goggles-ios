import Foundation
import MWDATCore
import MWDATDisplay
import MWDATMockDevice
import Observation
import OSLog
import UIKit

/// Meta's Ray-Ban Display as a second screen for the phone, through Meta's Wearables Device Access Toolkit 1.0.1
/// (github.com/facebook/meta-wearables-dat-ios): the toolkit started once, the app registered with Meta AI, the glasses
/// Meta AI knows followed as they come and go, a device session opened on a pair with a display, then its display, and
/// the newest glance drawn on it (`GlassesCard`), its buttons pressed with the Neural Band (`onPress`).
///
/// Meta AI's Developer Mode on the glasses stands in for an app registered in Meta's Wearables Developer Center:
/// `MWDAT` > `MetaAppID` is left unset (Config/Info.plist).
///
/// The preview on this phone pairs simulated glasses (the toolkit's MockDeviceKit) and draws their display in the app,
/// the same glance and the same buttons: on a simulator it is the only display there is.
///
/// Adapted from Infrared's own, localred's `app/Mobile/Glasses/Glasses.swift`, which draws a planning session instead.
@MainActor
@Observable
final class Glasses {
    /// Where drawing on the glasses stands.
    enum Stage: Equatable {
        /// Not drawing: nothing to draw on yet.
        case idle
        case connecting
        case showing
        /// The glasses took the display back for a moment (another experience, a system gesture): it comes back by itself.
        case paused
    }

    /// A pair of glasses Meta AI knows.
    struct Device: Identifiable, Equatable {
        let id: String
        let name: String
        let connected: Bool
        let link: String
        let battery: Int?
        let hasDisplay: Bool
        let needsUpdate: Bool
        let isPreview: Bool
    }

    private(set) var registered = false
    private(set) var registering = false
    /// Meta AI's word on this app's registration.
    private(set) var registration = "Not connected to Meta AI"
    private(set) var devices: [Device] = []
    private(set) var stage: Stage = .idle
    private(set) var problem: String?
    private(set) var needsGlassesAppUpdate = false
    private(set) var needsFirmwareUpdate = false
    /// The preview on this phone: simulated glasses, their display drawn by the toolkit.
    private(set) var previewing = false
    private(set) var previewView: UIView?
    /// The glance last drawn on the glasses, and how long the toolkit took to draw it.
    private(set) var shown: Glance?
    private(set) var lastDraw: Duration?

    /// A button pressed on the glasses.
    @ObservationIgnored var onPress: (@MainActor (Press) -> Void)?
    /// The session on the glasses as it starts, nil as it ends: the camera's to share (`FrameShare`).
    @ObservationIgnored var onSession: (@MainActor (DeviceSession?) -> Void)?

    @ObservationIgnored private var wearables: (any WearablesInterface)?
    @ObservationIgnored private var selector: AutoDeviceSelector?
    @ObservationIgnored private var session: DeviceSession?
    @ObservationIgnored private var display: Display?
    @ObservationIgnored private var displayToken: (any AnyListenerToken)?
    @ObservationIgnored private var ids: [DeviceIdentifier] = []
    @ObservationIgnored private var linkTokens: [DeviceIdentifier: any AnyListenerToken] = [:]
    @ObservationIgnored private var watching: [Task<Void, Never>] = []
    @ObservationIgnored private var sessionTasks: [Task<Void, Never>] = []
    @ObservationIgnored private var readiness: Task<Void, Never>?
    @ObservationIgnored private var retry: Task<Void, Never>?
    @ObservationIgnored private var mock: (any MockGlasses)?
    /// The newest glance, sent once the display is ready; one send at a time, the newest winning.
    @ObservationIgnored private var latest: Glance?
    @ObservationIgnored private var sending = false
    /// Failures in a row since the glasses last connected: at three it waits for Try again.
    @ObservationIgnored private var failures = 0

    private static let log = Logger(subsystem: "io.darkshift.hero-goggles-ios", category: "glasses")

    /// An error in words: the toolkit's own (`DatError`), or the system's.
    private static func words(_ error: any Error) -> String {
        (error as? any DatError)?.description ?? error.localizedDescription
    }
    private static var configured = false

    /// Starts Meta's toolkit, once. The app calls it as its screen appears, not from `init`: SwiftUI may make a view's
    /// state more than once and keep only the first.
    func begin() {
        guard wearables == nil else { return }
        start()
    }

    // MARK: - Meta AI

    /// The toolkit, once, and what it says of this app's registration and of the glasses.
    private func start() {
        if !Self.configured {
            do {
                try Wearables.configure()
                Self.configured = true
            } catch {
                problem = "Meta's toolkit didn't start: \(Self.words(error))"
                Self.log.error("configure failed: \(Self.words(error), privacy: .public)")
                return
            }
        }
        let wearables = Wearables.shared
        self.wearables = wearables
        selector = AutoDeviceSelector(wearables: wearables, filter: { $0.supportsDisplay() })
        note(wearables.registrationState)
        watching.append(Task { [weak self] in
            for await state in wearables.registrationStateStream() {
                guard let self else { return }
                self.note(state)
            }
        })
        watching.append(Task { [weak self] in
            for await ids in wearables.devicesStream() {
                guard let self else { return }
                self.ids = ids
                self.list()
            }
        })
    }

    private func note(_ state: RegistrationState) {
        let was = registered
        registered = state == .registered
        registering = state == .registering
        registration = switch state {
        case .registered: "Connected to Meta AI"
        case .registering: "Connecting to Meta AI…"
        case .available: "Not connected to Meta AI"
        case .unavailable: "Meta AI isn't available: install it, and pair your glasses there"
        }
        Self.log.info("registration: \(state.description, privacy: .public)")
        if was && !registered && !previewing {
            detach()
            if let wearables { selector = AutoDeviceSelector(wearables: wearables, filter: { $0.supportsDisplay() }) }
        }
        if registered && !was { tryAgain() }
    }

    /// Connect with Meta AI: it opens, the person allows the app, and it calls back (`handle`).
    func connect() {
        guard let wearables, !registering else { return }
        problem = nil
        Task {
            do {
                try await wearables.startRegistration()
            } catch {
                problem = Self.words(error)
            }
        }
    }

    func disconnect() {
        guard let wearables else { return }
        detach()
        Task {
            do {
                try await wearables.startUnregistration()
            } catch {
                problem = Self.words(error)
            }
        }
    }

    /// A link Meta AI opened the app with, after a registration or a permission: the toolkit's. Others are not its.
    func handle(_ url: URL) {
        guard let wearables,
              URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true
        else { return }
        Task {
            do {
                _ = try await wearables.handleUrl(url)
            } catch {
                problem = Self.words(error)
            }
        }
    }

    func updateGlassesApp() {
        guard let wearables else { return }
        Task {
            do { try await wearables.openDATGlassesAppUpdate() } catch { problem = Self.words(error) }
        }
    }

    func updateFirmware() {
        guard let wearables else { return }
        Task {
            do { try await wearables.openFirmwareUpdate() } catch { problem = Self.words(error) }
        }
    }

    // MARK: - The glasses

    /// The glasses Meta AI knows, each followed as it connects and goes.
    private func list() {
        guard let wearables else { return }
        let previewID = mock?.deviceIdentifier
        devices = ids.compactMap { id in
            guard let device = wearables.deviceForIdentifier(id) else { return nil }
            let link = switch device.linkState {
            case .connected: "Connected"
            case .connecting: "Connecting"
            case .disconnected: "Not connected"
            }
            return Device(id: id, name: id == previewID ? "Preview on this phone" : device.nameOrId(),
                          connected: device.linkState == .connected, link: link, battery: device.batteryLevel,
                          hasDisplay: device.supportsDisplay(), needsUpdate: device.compatibility() == .deviceUpdateRequired,
                          isPreview: id == previewID)
        }
        needsFirmwareUpdate = devices.contains { $0.needsUpdate && !$0.isPreview }
        for id in ids where linkTokens[id] == nil {
            guard let device = wearables.deviceForIdentifier(id) else { continue }
            linkTokens[id] = device.addLinkStateListener { [weak self] state in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    let wasReady = self.readyDevice != nil
                    self.list()
                    // Back in range, unfolded, put on: from a clean slate.
                    if state == .connected && !wasReady { self.tryAgain() }
                }
            }
        }
        for gone in linkTokens.keys where !ids.contains(gone) {
            let token = linkTokens.removeValue(forKey: gone)
            Task { await token?.cancel() }
        }
        reconcile()
    }

    /// A pair with a display, connected and up to date: the preview's while it runs.
    private var readyDevice: Device? {
        let ready = devices.filter { $0.hasDisplay && $0.connected && !$0.needsUpdate }
        return previewing ? ready.first { $0.isPreview } : ready.first { !$0.isPreview }
    }

    /// Try again: the person's, or the glasses' coming back.
    func tryAgain() {
        problem = nil
        failures = 0
        reconcile()
    }

    /// Attaches to the display when there is something to draw on and nothing holds it.
    private func reconcile() {
        guard session == nil, failures < 3, registered || previewing, let device = readyDevice else { return }
        attach(device.isPreview ? device.id : nil)
    }

    /// A session on the glasses (the preview's, by its id), then its display; the newest glance is drawn once it starts.
    private func attach(_ id: DeviceIdentifier?) {
        guard let wearables, session == nil else { return }
        let picked: (any DeviceSelector)?
        if let id { picked = SpecificDeviceSelector(device: id) } else { picked = selector }
        guard let picked else { return }
        stage = .connecting
        let session: DeviceSession
        do {
            session = try wearables.createSession(deviceSelector: picked)
        } catch DeviceSessionError.sessionAlreadyExists {
            // The last one still stopping: once more in a second.
            stage = .idle
            retry?.cancel()
            retry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                self?.reconcile()
            }
            return
        } catch {
            failed(Self.words(error))
            return
        }
        self.session = session
        let states = session.stateStream()
        let errors = session.errorStream()
        sessionTasks.append(Task { [weak self] in
            for await state in states {
                guard let self, self.session === session else { return }
                Self.log.info("session: \(state.description, privacy: .public)")
                switch state {
                case .started:
                    self.addDisplay(to: session)
                    self.onSession?(session)
                case .paused: self.stage = .paused
                case .stopped:
                    self.clear()
                    return
                default: break
                }
            }
        })
        sessionTasks.append(Task { [weak self] in
            for await error in errors {
                guard let self, self.session === session else { return }
                if error == .datAppOnTheGlassesUpdateRequired { self.needsGlassesAppUpdate = true }
                self.problem = error.description
                Self.log.error("session error: \(error.description, privacy: .public)")
            }
        })
        readiness = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self, self.session === session, self.stage != .showing else { return }
            self.failed("Your glasses didn't open the display in time.")
        }
        do {
            try session.start()
        } catch DeviceSessionError.datAppOnTheGlassesUpdateRequired {
            needsGlassesAppUpdate = true
            failed(DeviceSessionError.datAppOnTheGlassesUpdateRequired.description)
        } catch {
            failed(Self.words(error))
        }
    }

    private func addDisplay(to session: DeviceSession) {
        if let display {
            // Back from a pause: the same display, drawn again.
            if display.state == .started { ready() }
            return
        }
        do {
            let display = try session.addDisplay()
            self.display = display
            displayToken = display.statePublisher.listen { [weak self] state in
                Task { @MainActor [weak self] in
                    guard let self, self.display === display else { return }
                    switch state {
                    case .started: self.ready()
                    case .stopped: self.session?.stop()
                    default: break
                    }
                }
            }
            display.start()
        } catch {
            failed(Self.words(error))
        }
    }

    private func ready() {
        readiness?.cancel()
        stage = .showing
        failures = 0
        needsGlassesAppUpdate = false
        problem = nil
        shown = nil
        pump()
    }

    private func failed(_ why: String) {
        Self.log.error("glasses: \(why, privacy: .public)")
        problem = why
        failures += 1
        detach()
    }

    /// Stops the display, then its session.
    func detach() {
        display?.stop()
        session?.stop()
        clear()
    }

    private func clear() {
        readiness?.cancel()
        sessionTasks.forEach { $0.cancel() }
        sessionTasks = []
        let token = displayToken
        displayToken = nil
        Task { await token?.cancel() }
        display = nil
        session = nil
        sending = false
        stage = .idle
        onSession?(nil)
    }

    // MARK: - The glance

    /// Shows a glance on the glasses: at once when the display is ready, else once it is.
    func show(_ glance: Glance) {
        latest = glance
        if session == nil { reconcile() }
        pump()
    }

    /// Sends the newest glance, one send at a time, a fifth of a second apart at most.
    private func pump() {
        guard !sending, stage == .showing, let display, let glance = latest, glance != shown else { return }
        sending = true
        let perform: @Sendable (Press) -> Void = { [weak self] press in
            Task { @MainActor [weak self] in
                Self.log.info("pressed: \(press.rawValue, privacy: .public)")
                self?.onPress?(press)
            }
        }
        Task { [weak self] in
            let clock = ContinuousClock()
            let began = clock.now
            do {
                try await display.send(GlassesCard.view(glance, perform: perform))
                self?.shown = glance
                self?.lastDraw = clock.now - began
            } catch {
                self?.problem = (error as? DisplayError)?.description ?? error.localizedDescription
            }
            try? await Task.sleep(for: .milliseconds(200))
            guard let self, self.display === display else { return }
            self.sending = false
            self.pump()
        }
    }

    // MARK: - The preview on this phone

    /// The preview on: simulated Ray-Ban Display glasses, powered on and worn, their display drawn in the app. Off: the
    /// real glasses again.
    func setPreview(_ on: Bool) {
        // Without the toolkit started, MockDeviceKit stops the app ("Call `configure()` before attempting to access
        // Wearables!").
        guard on != previewing, wearables != nil else { return }
        detach()
        if on {
            MockDeviceKit.shared.enable()
            do {
                let glasses = try MockDeviceKit.shared.pairGlasses(model: .metaRayBanDisplay)
                glasses.powerOn()
                glasses.don()
                mock = glasses
                previewView = glasses.services.display.createPreviewView()
                previewing = true
                failures = 0
                problem = nil
                list()
            } catch {
                MockDeviceKit.shared.disable()
                problem = "The preview didn't start: \(String(describing: error))"
            }
        } else {
            if let mock { MockDeviceKit.shared.unpairDevice(mock) }
            MockDeviceKit.shared.disable()
            mock = nil
            previewView = nil
            previewing = false
            failures = 0
            list()
        }
    }
}
