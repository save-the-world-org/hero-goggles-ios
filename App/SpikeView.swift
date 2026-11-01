import SwiftUI
import UIKit

/// The phone's side of the spike: the preview, Meta AI and the glasses, what the glasses show now with the same buttons,
/// and every press with where it came from.
struct SpikeView: View {
    let glasses: Glasses
    let demo: Demo
    @State private var preview = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle("Simulated Ray-Ban Display", isOn: $preview)
                    if let view = glasses.previewView {
                        GlassesPreview(view: view)
                            .aspectRatio(1, contentMode: .fit)
                            .listRowInsets(EdgeInsets())
                            .background(.black)
                    }
                } header: {
                    Text("Preview on this phone")
                } footer: {
                    Text("Meta's simulated glasses, drawn by the toolkit: the same screen and buttons as a real pair.")
                }
                Section("Meta AI") {
                    LabeledContent("This app", value: glasses.registration)
                    if glasses.registered {
                        Button("Disconnect from Meta AI", role: .destructive) { glasses.disconnect() }
                    } else {
                        Button(glasses.registering ? "Connecting…" : "Connect with Meta AI") { glasses.connect() }
                            .disabled(glasses.registering)
                    }
                }
                Section {
                    ForEach(glasses.devices) { device in
                        LabeledContent(device.name, value: about(device))
                    }
                    LabeledContent("Display", value: stage)
                    if let lastDraw = glasses.lastDraw {
                        LabeledContent("Last drawn in", value: "\(milliseconds(lastDraw)) ms")
                    }
                    if let problem = glasses.problem {
                        Text(problem).foregroundStyle(.red)
                        Button("Try again") { glasses.tryAgain() }
                    }
                    if glasses.needsGlassesAppUpdate {
                        Button("Update the app on the glasses") { glasses.updateGlassesApp() }
                    }
                    if glasses.needsFirmwareUpdate {
                        Button("Update the glasses") { glasses.updateFirmware() }
                    }
                } header: {
                    Text("Your glasses")
                } footer: {
                    Text("On, unfolded and near this phone, with Developer Mode on in Meta AI.")
                }
                Section("On the glasses now") {
                    GlanceCard(glance: demo.glance) { demo.press($0, from: .phone) }
                }
                Section {
                    if demo.presses.isEmpty {
                        Text("None yet.").foregroundStyle(.secondary)
                    }
                    ForEach(demo.presses) { entry in
                        HStack {
                            Text(entry.press.rawValue.capitalized)
                            Spacer()
                            Text(entry.source.rawValue)
                                .foregroundStyle(entry.source == .glasses ? Color.green : Color.secondary)
                            Text(entry.at, format: .dateTime.hour().minute().second())
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Presses")
                } footer: {
                    Text("A pinch on the Neural Band shows here as glasses.")
                }
            }
            .navigationTitle("Ray-Ban spike")
        }
        .onChange(of: preview) { _, on in glasses.setPreview(on) }
        .onChange(of: glasses.previewing, initial: true) { _, on in preview = on }
    }

    private var stage: String {
        switch glasses.stage {
        case .showing: glasses.previewing ? "Drawing in the preview" : "Drawing on your glasses"
        case .connecting: "Opening the display…"
        case .paused: "Paused by the glasses: it comes back by itself"
        case .idle where !glasses.registered && !glasses.previewing: "Connect with Meta AI first"
        case .idle: "Waiting for your glasses"
        }
    }

    private func about(_ device: Glasses.Device) -> String {
        [device.link, device.battery.map { "\($0)%" }, device.hasDisplay ? nil : "no display"]
            .compactMap(\.self)
            .joined(separator: " · ")
    }

    private func milliseconds(_ duration: Duration) -> Int {
        Int(duration.components.seconds * 1000 + duration.components.attoseconds / 1_000_000_000_000_000)
    }
}

/// A glance as the glasses draw it, on the phone, its buttons pressing as the glasses' do.
struct GlanceCard: View {
    let glance: Glance
    let press: @MainActor (Press) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(glance.place).font(.caption).foregroundStyle(.secondary)
                Text(glance.status).font(.headline)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(glance.line)
                if let note = glance.note {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: .rect(cornerRadius: 12))
            HStack {
                ForEach(glance.choices, id: \.label) { choice in
                    if choice.primary {
                        Button(choice.label) { press(choice.press) }.buttonStyle(.borderedProminent)
                    } else {
                        Button(choice.label) { press(choice.press) }.buttonStyle(.bordered)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// The toolkit's drawing of the simulated glasses' display.
struct GlassesPreview: UIViewRepresentable {
    let view: UIView

    func makeUIView(context: Context) -> UIView { view }
    func updateUIView(_ view: UIView, context: Context) {}
}
