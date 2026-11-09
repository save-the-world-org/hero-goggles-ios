import Foundation
import MWDATCamera
import MWDATCore
import Observation
import os
import UIKit

/// "Share what I see": the glasses' camera, a frame about every half second, to the Influence API
/// (`POST /api/seekers/<seeker id>/frame`, `image/jpeg`), so a page can show the audience what the wearer sees.
///
/// Off by default, and only the person's switch on the seek screen turns it on (kept in the app's settings,
/// `share.enabled`). While on, and the app in front, and a session on the glasses open (`Glasses.onSession`), it asks
/// Meta AI for the camera, then streams it at the toolkit's lowest resolution. Each tick takes the newest frame, scales
/// it to 640 px on its long side at most, and posts it as a JPEG at quality 0.5: one post at a time, a frame dropped
/// when one is in flight or the post fails, never queued. The stream stops when the switch goes off, the app goes to
/// the background, or the glasses' session ends.
@MainActor
@Observable
final class FrameShare {
    enum Outcome: Sendable {
        case sent
        case noImage
        case status(Int)
        case offline
    }

    var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            UserDefaults.standard.set(enabled, forKey: "share.enabled")
            if enabled {
                begin()
            } else {
                stopCamera()
                problem = nil
                lastSent = nil
                sends = []
            }
        }
    }

    /// Why frames are not going out, when something says so: the toolkit's error, or the API's answer.
    private(set) var problem: String?
    private(set) var lastSent: Date?

    /// The Influence API's link: its server and the seeker id the frames are filed under.
    @ObservationIgnored weak var influence: InfluenceLink?
    @ObservationIgnored private var session: DeviceSession?
    @ObservationIgnored private var camera: Camera?
    @ObservationIgnored private var streamState: StreamState?
    @ObservationIgnored private var tokens: [any AnyListenerToken] = []
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var starting = false
    @ObservationIgnored private var posting = false
    @ObservationIgnored private var foreground = false
    @ObservationIgnored private var sends: [Date] = []
    /// The newest frame from the glasses, replaced by each new one: never a queue.
    @ObservationIgnored private let latest = OSAllocatedUnfairLock<VideoFrame?>(initialState: nil)
    @ObservationIgnored private let http: URLSession

    private static let every: Duration = .milliseconds(500)
    nonisolated private static let longSide: CGFloat = 640
    nonisolated private static let quality: CGFloat = 0.5
    private static let log = Logger(subsystem: "io.darkshift.hero-goggles-ios", category: "share")

    init() {
        let defaults = UserDefaults.standard
        defaults.register(defaults: ["share.enabled": false])
        enabled = defaults.bool(forKey: "share.enabled")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        configuration.waitsForConnectivity = false
        http = URLSession(configuration: configuration)
    }

    /// The glasses' session as it opens, nil as it ends (`Glasses.onSession`).
    func use(_ session: DeviceSession?) {
        guard session !== self.session else { return }
        stopCamera()
        self.session = session
        begin()
    }

    /// The app came to the front or went behind: the camera streams only while it is in front.
    func setForeground(_ inFront: Bool) {
        guard inFront != foreground else { return }
        foreground = inFront
        if inFront { begin() } else { stopCamera() }
    }

    /// Asks Meta AI for the camera, then starts it: only with the switch on, the app in front and the glasses' session open.
    private func begin() {
        guard enabled, foreground, let session, camera == nil, !starting else { return }
        starting = true
        problem = nil
        Task { [weak self] in
            var granted = false
            var failure: String?
            do {
                let wearables = Wearables.shared
                var status = try await wearables.checkPermissionStatus(.camera)
                if status != .granted { status = try await wearables.requestPermission(.camera) }
                granted = status == .granted
            } catch {
                failure = String(describing: error)
            }
            guard let self else { return }
            self.starting = false
            guard self.enabled, self.foreground, self.session === session, self.camera == nil else { return }
            if let failure {
                self.problem = "Meta AI didn't give the camera: \(failure)"
            } else if !granted {
                self.problem = "allow the camera for Hero Goggles in Meta AI"
            } else {
                self.startCamera(on: session)
            }
        }
    }

    private func startCamera(on session: DeviceSession) {
        let added: Camera?
        do {
            added = try session.addCamera(config: StreamConfiguration(videoCodec: .raw, resolution: .low, frameRate: 15))
        } catch {
            problem = "the camera didn't start: \(String(describing: error))"
            return
        }
        guard let camera = added else {
            problem = "these glasses have no camera to share"
            return
        }
        self.camera = camera
        let stream = camera.stream
        let latest = self.latest
        tokens = [
            stream.videoFramePublisher.listen { frame in latest.withLock { $0 = frame } },
            stream.statePublisher.listen { [weak self] state in
                Task { @MainActor [weak self] in
                    guard let self, self.camera === camera else { return }
                    self.streamState = state
                }
            },
            stream.errorPublisher.listen { [weak self] error in
                Task { @MainActor [weak self] in
                    guard let self, self.camera === camera else { return }
                    self.problem = error.description
                }
            },
        ]
        stream.start()
        Self.log.info("camera streaming, low resolution")
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.every)
                self?.tick()
            }
        }
    }

    private func stopCamera() {
        ticker?.cancel()
        ticker = nil
        let old = tokens
        tokens = []
        Task { for token in old { await token.cancel() } }
        if camera != nil { Self.log.info("camera stopped") }
        camera?.stop()
        camera = nil
        streamState = nil
        latest.withLock { $0 = nil }
    }

    /// The newest frame, out to the API: one post at a time, dropped while one is in flight.
    private func tick() {
        guard !posting, camera != nil, let influence else { return }
        guard let frame = latest.withLock({ state -> VideoFrame? in
            let frame = state
            state = nil
            return frame
        }) else { return }
        let url = influence.server.appending(path: "api/seekers/\(influence.seekerID)/frame")
        let http = self.http
        posting = true
        Task { [weak self] in
            let outcome = await Self.post(frame, to: url, with: http)
            guard let self else { return }
            self.posting = false
            guard self.enabled else { return }
            switch outcome {
            case .sent:
                let now = Date.now
                self.lastSent = now
                self.sends = self.sends.filter { now.timeIntervalSince($0) < 5 } + [now]
                self.problem = nil
            case .noImage:
                break
            case .status(404):
                self.problem = "Influence has no frame endpoint yet (404)"
            case .status(let code):
                self.problem = "Influence answered \(code)"
            case .offline:
                self.problem = "offline"
            }
        }
    }

    /// Scales and encodes a frame, then posts it, off the main actor.
    @concurrent
    nonisolated private static func post(_ frame: VideoFrame, to url: URL, with http: URLSession) async -> Outcome {
        guard let jpeg = jpeg(frame) else { return .noImage }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        do {
            let (_, response) = try await http.upload(for: request, from: jpeg)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            return (200..<300).contains(code) ? .sent : .status(code)
        } catch {
            return .offline
        }
    }

    /// The frame at 640 px on its long side at most, as a JPEG at quality 0.5.
    nonisolated private static func jpeg(_ frame: VideoFrame) -> Data? {
        guard let image = frame.makeUIImage() else { return nil }
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let long = max(pixels.width, pixels.height)
        guard long > 0 else { return nil }
        let factor = min(1, longSide / long)
        let size = CGSize(width: (pixels.width * factor).rounded(), height: (pixels.height * factor).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return scaled.jpegData(compressionQuality: quality)
    }

    /// One line for the seek screen: "Sharing: 2 fps, last sent 0.4 s ago", or why it isn't.
    func words(at now: Date) -> String {
        guard enabled else { return "Sharing: off" }
        guard foreground else { return "Not sharing: the app is in the background" }
        guard session != nil else { return "Not sharing: waiting for your glasses" }
        if let problem { return "Not sharing: \(problem)" }
        guard camera != nil else { return "Not sharing: asking Meta AI for the camera" }
        switch streamState {
        case .waitingForDevice: return "Not sharing: waiting for the glasses' camera"
        case .paused: return "Not sharing: the glasses paused the camera"
        case .stopping, .stopped: return "Not sharing: the camera stopped; switch it off and on"
        case .streaming: break
        case .starting, nil: return "Not sharing: starting the camera"
        }
        guard let lastSent else { return "Sharing: waiting for the first frame" }
        let recent = sends.filter { now.timeIntervalSince($0) < 5 }.count
        let fps = (Double(recent) / 5).formatted(.number.precision(.fractionLength(0...1)))
        return "Sharing: \(fps) fps, last sent \(String(format: "%.1f", max(0, now.timeIntervalSince(lastSent)))) s ago"
    }
}
