import SwiftUI
import simd

/// The phone's side of seeking a beacon: the distance in big letters and an arrow that turns with the direction, the
/// switches for the camera, the voice and the glasses, and what Bluetooth and Nearby Interaction say underneath.
struct SeekView: View {
    @Bindable var seeker: Seeker
    @Bindable var influence: InfluenceLink
    @Bindable var share: FrameShare

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    pointer.frame(height: 150)
                    Text(seeker.distance.map(Seeker.meters) ?? "–")
                        .font(.system(size: 60, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text(seeker.guidance)
                        .font(.title3.weight(.semibold))
                        .multilineTextAlignment(.center)
                    if let motion = seeker.motion {
                        Text(motion)
                            .font(.headline)
                            .foregroundStyle(.orange)
                    }
                    if let note = seeker.note {
                        Text(note)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    InfluenceLine(influence: influence)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            Section {
                if seeker.active {
                    Button("Stop seeking", role: .destructive) { seeker.stop() }
                } else {
                    Button("Start seeking") { seeker.start() }
                }
                Toggle("Direction, with the camera", isOn: $seeker.cameraAssistance)
                Toggle("Say the way", isOn: $seeker.speaks)
                Toggle("Hot and cold beeps", isOn: $seeker.beeps)
                Toggle("Show it on the glasses", isOn: $seeker.showsOnGlasses)
                Toggle("Send to Influence", isOn: $influence.enabled)
                LabeledContent("Seeker") {
                    TextField(influence.seekerID, text: $influence.seeker)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Toggle("Alert when \(seeker.name) goes too far", isOn: $seeker.separationAlert)
                if seeker.separationAlert {
                    Stepper("Farther than \(Int(seeker.alertBeyond)) m", value: $seeker.alertBeyond, in: 2...50, step: 1)
                }
            } footer: {
                Text("An iPhone gives a beacon's direction only with camera assistance: hold the phone upright, camera facing forward, and sweep it slowly. Distance works without it. The beeps quicken as you get closer, high while closing in, low while drifting apart.")
            }
            Section {
                Toggle("Share what I see", isOn: $share.enabled)
                ShareLine(share: share)
            } footer: {
                Text("Sends what your glasses' camera sees to Influence, about two small pictures a second, for the audience's screen. The capture light on the front of your glasses shows while it shares, so people near you know. It starts only when you turn it on, and stops when you turn it off, leave the app, or your glasses disconnect.")
            }
            Section("The beacon") {
                LabeledContent("Bluetooth", value: seeker.linkWords)
                LabeledContent("Ultra Wideband", value: seeker.phaseWords)
                if let service = seeker.link.serviceName {
                    LabeledContent("Speaks on", value: service)
                }
                if let rssi = seeker.link.rssi {
                    LabeledContent("Signal when found", value: "\(rssi) dBm")
                }
                if let problem = seeker.problem ?? seeker.link.problem {
                    Text(problem).foregroundStyle(.red)
                }
                if !seeker.link.servicesSeen.isEmpty {
                    LabeledContent("Services it offers") {
                        Text(seeker.link.servicesSeen.joined(separator: "\n")).font(.caption.monospaced())
                    }
                }
            }
            Section("This iPhone") {
                let capabilities = Seeker.capabilities
                LabeledContent("Precise distance", value: capabilities.supportsPreciseDistanceMeasurement ? "Yes" : "No")
                LabeledContent("Direction without the camera",
                               value: capabilities.supportsDirectionMeasurement ? "Yes" : "No")
                LabeledContent("Camera assistance", value: capabilities.supportsCameraAssistance ? "Yes" : "No")
            }
            Section("As Nearby Interaction gives it") {
                LabeledContent("Distance", value: seeker.distance.map { String(format: "%.2f m", Double($0)) } ?? "–")
                LabeledContent("Horizontal angle", value: seeker.rawHorizontalAngle.map(degrees) ?? "–")
                LabeledContent("Direction (x, y, z)", value: seeker.rawDirection.map(vector) ?? "–")
                LabeledContent("Arrow", value: seeker.azimuth.map(degrees) ?? "–")
                LabeledContent("You", value: seeker.youAreMoving.map { $0 ? "On the move" : "Standing still" } ?? "–")
                if let updated = seeker.updated {
                    LabeledContent("Updated", value: updated.formatted(date: .omitted, time: .standard))
                }
                if let logName = seeker.logName {
                    LabeledContent("Logged to", value: logName)
                }
            }
        }
        .navigationTitle(seeker.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder private var pointer: some View {
        if let azimuth = seeker.azimuth {
            Image(systemName: "location.north.fill")
                .font(.system(size: 110))
                .foregroundStyle(.tint)
                .rotationEffect(.radians(Double(azimuth)))
                .animation(.easeOut(duration: 0.25), value: azimuth)
        } else {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: 80))
                .foregroundStyle(.secondary)
        }
    }

    private func degrees(_ radians: Float) -> String {
        String(format: "%+.0f°", Double(radians) * 180 / .pi)
    }

    private func vector(_ value: simd_float3) -> String {
        String(format: "%.2f, %.2f, %.2f", Double(value.x), Double(value.y), Double(value.z))
    }
}

/// Sharing what the glasses see, in one small line ticking twice a second: "Sharing: 2 fps, last sent 0.4 s ago".
struct ShareLine: View {
    let share: FrameShare

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            Text(share.words(at: context.date))
                .font(.caption)
                .foregroundStyle(share.problem == nil ? Color.secondary : Color.red)
        }
    }
}

/// The Influence API's link in one small line, ticking each second: "Influence: Kunal · sent 3 s ago", or offline.
struct InfluenceLine: View {
    let influence: InfluenceLink

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(influence.words(at: context.date))
                .font(.caption)
                .foregroundStyle(influence.reachable == false ? Color.red : Color.secondary)
        }
    }
}
