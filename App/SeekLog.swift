import Foundation
import simd

/// Every reading of a seeking session, written to a CSV file in the app's Documents (`seek-<date>-<time>.csv`), to look
/// at a test afterwards: how often Nearby Interaction gave a distance and in what steps, and how the direction came and
/// went. Copy them off the phone with `xcrun devicectl device copy from --device <id> --domain-type appDataContainer
/// --domain-identifier io.darkshift.hero-goggles-ios --source Documents --destination <folder>`.
@MainActor
final class SeekLog {
    private var handle: FileHandle?

    /// Starts a new file, and says its name.
    func open() -> String? {
        close()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let name = "seek-\(formatter.string(from: .now)).csv"
        guard let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return nil
        }
        let url = folder.appendingPathComponent(name)
        let header = "time,distance_m,horizontal_angle_deg,direction_x,direction_y,direction_z,arrow_deg,trend,"
            + "you_moving,coaching\n"
        guard FileManager.default.createFile(atPath: url.path, contents: Data(header.utf8)),
              let handle = try? FileHandle(forWritingTo: url) else { return nil }
        _ = try? handle.seekToEnd()
        self.handle = handle
        return name
    }

    func write(at time: Date, distance: Float?, horizontalAngle: Float?, direction: simd_float3?, azimuth: Float?,
               trend: Seeker.Trend, youAreMoving: Bool?, coaching: String?) {
        guard let handle else { return }
        func number(_ value: Float?, _ format: String) -> String {
            value.map { String(format: format, Double($0)) } ?? ""
        }
        func degrees(_ radians: Float?) -> String {
            number(radians.map { $0 * 180 / .pi }, "%.1f")
        }
        let fields = [
            String(format: "%.3f", time.timeIntervalSince1970),
            number(distance, "%.3f"),
            degrees(horizontalAngle),
            number(direction?.x, "%.3f"),
            number(direction?.y, "%.3f"),
            number(direction?.z, "%.3f"),
            degrees(azimuth),
            "\(trend)",
            youAreMoving.map { $0 ? "yes" : "no" } ?? "",
            (coaching ?? "").replacingOccurrences(of: ",", with: ";"),
        ]
        try? handle.write(contentsOf: Data((fields.joined(separator: ",") + "\n").utf8))
    }

    func close() {
        try? handle?.close()
        handle = nil
    }
}
