import SwiftUI

/// The spike: Meta's Ray-Ban Display as a second screen for an iPhone app, through Meta's Wearables Device Access Toolkit
/// 1.0.1. The phone draws a glance on the glasses (`Glance`, drawn by `GlassesCard`), the person presses its buttons with
/// the Neural Band, and the press comes back to the phone, which answers with the next glance (`Demo`).
///
/// Check arguments, for a run with no hands: `-spike.preview YES` turns the preview on at launch (simulated glasses from
/// the toolkit's MockDeviceKit, drawn on the phone), and `-spike.autoplay YES` presses the button in focus every five
/// seconds, from the phone: the simulated glasses' own inputs do not press the display's buttons at 1.0.1
/// (docs/findings.md). `-seek.start YES` starts seeking a UWB beacon at launch, and `-seek.simulate YES` seeks a made-up
/// one, for the preview on a simulator. None is kept.
///
/// The glasses show the beacon (`Lens`): its invitation, then the way to it; the demo only with "Show it on the glasses"
/// off. The Influence API (`InfluenceLink`) names whom the beacon finds and takes every reading for its live map.
@main
struct HeroGogglesApp: App {
    @State private var glasses = Glasses()
    @State private var demo = Demo()
    @State private var seeker = Seeker()
    @State private var influence = InfluenceLink()
    @State private var share = FrameShare()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            HeroGogglesView(glasses: glasses, demo: demo, seeker: seeker, influence: influence, share: share)
                .onOpenURL { glasses.handle($0) }
                .onChange(of: influence.target, initial: true) { _, target in
                    seeker.find(target?.name, beacon: target?.hardwareID)
                }
                .onChange(of: scenePhase, initial: true) { _, phase in
                    // Inactive (a permission prompt, Control Centre) is still in front: only the background stops it.
                    influence.setForeground(phase != .background)
                    share.setForeground(phase != .background)
                }
                .onChange(of: Lens.glance(seeker: seeker, demo: demo), initial: true) { _, glance in
                    glasses.show(glance)
                }
                .task {
                    seeker.onReading = { [influence] reading in influence.send(reading) }
                    share.influence = influence
                    glasses.onSession = { [share] session in share.use(session) }
                    glasses.onPress = { [demo, seeker] press in
                        Lens.press(press, from: .glasses, seeker: seeker, demo: demo)
                    }
                    glasses.begin()
                    let defaults = UserDefaults.standard
                    if defaults.bool(forKey: "spike.preview") { glasses.setPreview(true) }
                    if defaults.bool(forKey: "seek.simulate") {
                        seeker.simulate()
                    } else if defaults.bool(forKey: "seek.start") {
                        seeker.start()
                    }
                    guard defaults.bool(forKey: "spike.autoplay") else { return }
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(5))
                        demo.pressPrimary(from: .autoplay)
                    }
                }
        }
    }
}

/// What the glasses show, and where a press of their buttons goes: the beacon's invitation, then the way to it while
/// seeking; the demo only when "Show it on the glasses" is off.
@MainActor
enum Lens {
    static func glance(seeker: Seeker, demo: Demo) -> Glance {
        guard seeker.showsOnGlasses else { return demo.glance }
        return seeker.active ? seeker.glance : seeker.invitation
    }

    static func press(_ press: Press, from source: Source, seeker: Seeker, demo: Demo) {
        if press == .seek {
            seeker.start()
        } else if !seeker.showsOnGlasses {
            demo.press(press, from: source)
        }
    }
}
