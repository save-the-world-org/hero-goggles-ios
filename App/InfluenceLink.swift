import CoreLocation
import Foundation
import Observation
import os

/// The seek's link to the Influence API (`https://influence-api.darkshift.cloud`, KubeCon NA 2026's hackathon): who the
/// phone is to find, and every reading on its way to the live map.
///
/// While the app is in front it asks every two seconds whom this person's seeker targets
/// (`GET /api/target?seeker=<id>`). The seek takes the name ("Kunal Finder" on every screen, "Finding Kunal" aloud) and
/// the target's beacon (`hardwareId`). Each reading with a distance goes to `POST /api/readings`, two a second at most,
/// one at a time, dropped when it cannot go: the seek never waits on the network. The phone's position and compass
/// heading go with it when Core Location has them, and the position to `POST /api/seekers/<id>`.
///
/// The seeker id is per person, a setting with no sign-up: the seek screen's Seeker field, or `-influence.seeker <id>`
/// at launch. A phone that was never given one makes its own, `seeker-` and six random characters, and keeps it.
///
/// On by default. Check arguments: `-influence.enabled NO` turns it off (as does the seek screen's switch, which is
/// kept), and `-influence.api <url>` points it at another server.
@MainActor
@Observable
final class InfluenceLink: NSObject {
    /// Whom this person's seeker targets: the influencer's name, and their beacon's ID when the registry has one.
    struct Target: Equatable {
        let name: String
        let hardwareID: String?
    }

    static let defaultServer = URL(string: "https://influence-api.darkshift.cloud")!
    /// Who seeks with this phone, as typed: the seek screen's Seeker field. Kept in the app's settings.
    var seeker: String {
        didSet { UserDefaults.standard.set(seeker, forKey: "influence.seeker") }
    }
    /// `seeker` as the API keeps it (influence-api's `slug`); the phone's own id while the field is empty.
    var seekerID: String { Self.slug(seeker) ?? ownSeeker }
    @ObservationIgnored private let ownSeeker: String
    /// Two posts a second at most.
    private static let spacing: TimeInterval = 0.5

    /// Off: nothing polled or sent, and the seek goes back to its own name.
    var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            UserDefaults.standard.set(enabled, forKey: "influence.enabled")
            if enabled {
                resume()
            } else {
                pause()
                target = nil
                reachable = nil
            }
        }
    }

    let server: URL
    private(set) var target: Target?
    /// Whether the last request reached the API; nil before the first answer.
    private(set) var reachable: Bool?
    /// When the last reading landed.
    private(set) var lastSent: Date?

    @ObservationIgnored private var foreground = false
    @ObservationIgnored private var polling: Task<Void, Never>?
    @ObservationIgnored private var posting = false
    @ObservationIgnored private var lastPost = Date.distantPast
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let location = CLLocationManager()
    @ObservationIgnored private var position: CLLocation?
    @ObservationIgnored private var heading: Double?

    private static let log = Logger(subsystem: "io.darkshift.rayban-spike", category: "influence")

    override init() {
        let defaults = UserDefaults.standard
        defaults.register(defaults: ["influence.enabled": true])
        enabled = defaults.bool(forKey: "influence.enabled")
        let own = defaults.string(forKey: "influence.ownSeeker") ?? "seeker-" + UUID().uuidString.prefix(6).lowercased()
        defaults.set(own, forKey: "influence.ownSeeker")
        ownSeeker = own
        seeker = defaults.string(forKey: "influence.seeker") ?? own
        let given = defaults.string(forKey: "influence.api").flatMap { URL(string: $0) }
        server = given.flatMap { $0.scheme != nil && $0.host != nil ? $0 : nil } ?? Self.defaultServer
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        location.distanceFilter = 1
        location.headingFilter = 2
    }

    /// The app came to the front or went behind: the target is asked for only while it is in front.
    func setForeground(_ inFront: Bool) {
        foreground = inFront
        inFront ? resume() : pause()
    }

    private func resume() {
        guard enabled, foreground, polling == nil else { return }
        Self.log.info("polling \(self.server.absoluteString, privacy: .public)")
        if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
        location.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { location.startUpdatingHeading() }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                guard let link = self else { return }
                await link.poll()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func pause() {
        polling?.cancel()
        polling = nil
        location.stopUpdatingLocation()
        location.stopUpdatingHeading()
    }

    /// `{name, hardwareId, ...}` when someone is targeted, `{target: null}` when nobody is. An answer that is not JSON
    /// keeps the last target, so a hiccup does not flip the title.
    private func poll() async {
        let url = server.appending(path: "api/target")
            .appending(queryItems: [URLQueryItem(name: "seeker", value: seekerID)])
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, response) = try await session.data(for: request)
            guard enabled else { return }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                reachable = false
                return
            }
            reachable = true
            let fields = object["target"] as? [String: Any] ?? object
            let name = (fields["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let hardware = (fields["hardwareId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let next = name.flatMap { $0.isEmpty ? nil : Target(name: $0, hardwareID: hardware) }
            if next != target {
                Self.log.info("target \(next?.name ?? "nobody", privacy: .public)")
                target = next
            }
            sendPosition()
        } catch {
            // A poll cancelled by going to the background is not the API being offline.
            if enabled, !Task.isCancelled { reachable = false }
        }
    }

    /// A reading from the seek, for the live map: two a second at most, one at a time, dropped when it cannot go. Filed
    /// by the API under the current target's beacon.
    func send(_ reading: Seeker.Reading) {
        guard enabled, !posting, Date.now.timeIntervalSince(lastPost) >= Self.spacing else { return }
        var body: [String: Any] = [
            "seekerId": seekerID,
            "distance": Self.round(Double(reading.distance), 3),
            "trend": Self.words(reading.trend),
        ]
        if let azimuth = reading.azimuth { body["azimuthDeg"] = Self.round(Double(azimuth) * 180 / .pi, 1) }
        if let elevation = reading.elevation { body["elevationDeg"] = Self.round(Double(elevation) * 180 / .pi, 1) }
        if let heading { body["heading"] = Self.round(heading, 1) }
        if let fix = freshPosition {
            body["lat"] = fix.coordinate.latitude
            body["lon"] = fix.coordinate.longitude
        }
        guard let request = post("api/readings", body) else { return }
        lastPost = .now
        posting = true
        Task { [weak self] in
            let answer = try? await self?.session.data(for: request)
            guard let self else { return }
            self.posting = false
            guard self.enabled else { return }
            let landed = (answer?.1 as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            self.reachable = landed
            if landed { self.lastSent = .now }
        }
    }

    /// The phone's position, with each poll while there is a fresh one: the live map's dot for the phone.
    private func sendPosition() {
        guard let fix = freshPosition else { return }
        var body: [String: Any] = [
            "lat": fix.coordinate.latitude,
            "lon": fix.coordinate.longitude,
            "accuracy": Self.round(fix.horizontalAccuracy, 1),
        ]
        if let heading { body["heading"] = Self.round(heading, 1) }
        guard let request = post("api/seekers/\(seekerID)", body) else { return }
        Task { [session] in _ = try? await session.data(for: request) }
    }

    private var freshPosition: CLLocation? {
        guard let position, position.horizontalAccuracy >= 0, position.timestamp.timeIntervalSinceNow > -30 else {
            return nil
        }
        return position
    }

    private func post(_ path: String, _ body: [String: Any]) -> URLRequest? {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        var request = URLRequest(url: server.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        return request
    }

    /// One line for the phone: "Influence (jo): Kunal · sent 3 s ago", or "Influence (jo): offline".
    func words(at now: Date) -> String {
        guard enabled else { return "Influence: off" }
        let head = "Influence (\(seekerID))"
        if reachable == false { return "\(head): offline" }
        let who = target?.name ?? (reachable == nil ? "connecting…" : "nobody targeted")
        guard let lastSent else { return "\(head): \(who)" }
        return "\(head): \(who) · sent \(max(0, Int(now.timeIntervalSince(lastSent)))) s ago"
    }

    /// As influence-api's `slug`: lower case, each run of anything but a letter or digit one hyphen, 40 at most.
    static func slug(_ text: String) -> String? {
        let words = text.lowercased().split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }
        let id = String(words.joined(separator: "-").prefix(40))
        return id.isEmpty ? nil : id
    }

    private static func words(_ trend: Seeker.Trend) -> String {
        switch trend {
        case .closer: "closer"
        case .farther: "away"
        case .steady: "steady"
        }
    }

    private static func round(_ value: Double, _ places: Int) -> Double {
        let scale = pow(10, Double(places))
        return (value * scale).rounded() / scale
    }
}

extension InfluenceLink: @preconcurrency CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let last = locations.last { position = last }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard newHeading.headingAccuracy >= 0 else { return }
        heading = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        Self.log.info("location: \(error.localizedDescription, privacy: .public)")
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if polling != nil { manager.startUpdatingLocation() }
    }
}
