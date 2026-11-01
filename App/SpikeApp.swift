import SwiftUI

/// The spike: Meta's Ray-Ban Display as a second screen for an iPhone app, through Meta's Wearables Device Access Toolkit
/// 1.0.1. The phone draws a glance on the glasses (`Glance`, drawn by `GlassesCard`), the person presses its buttons with
/// the Neural Band, and the press comes back to the phone, which answers with the next glance (`Demo`).
///
/// Check arguments, for a run with no hands: `-spike.preview YES` turns the preview on at launch (simulated glasses from
/// the toolkit's MockDeviceKit, drawn on the phone), and `-spike.autoplay YES` presses the button in focus every five
/// seconds, from the phone: the simulated glasses' own inputs do not press the display's buttons at 1.0.1
/// (docs/findings.md). Neither is kept.
@main
struct SpikeApp: App {
    @State private var glasses = Glasses()
    @State private var demo = Demo()

    var body: some Scene {
        WindowGroup {
            SpikeView(glasses: glasses, demo: demo)
                .onOpenURL { glasses.handle($0) }
                .onChange(of: demo.glance, initial: true) { _, glance in glasses.show(glance) }
                .task {
                    glasses.onPress = { [demo] press in demo.press(press, from: .glasses) }
                    glasses.begin()
                    let defaults = UserDefaults.standard
                    if defaults.bool(forKey: "spike.preview") { glasses.setPreview(true) }
                    guard defaults.bool(forKey: "spike.autoplay") else { return }
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(5))
                        demo.pressPrimary(from: .autoplay)
                    }
                }
        }
    }
}
