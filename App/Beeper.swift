import AVFoundation

/// Hot and cold: a short, soft beep through whatever the phone plays to (the glasses, when they are its headphones).
/// `Seeker` sets the pace and the pitch: faster as the beacon comes closer, higher while it is coming closer, lower while
/// it is getting farther.
@MainActor
final class Beeper {
    private static let rate = 44_100.0
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)
    private var tones: [Int: AVAudioPCMBuffer] = [:]
    private var attached = false

    func beep(frequency: Double) {
        guard let format, let tone = tone(frequency: frequency, format: format) else { return }
        if !attached {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            attached = true
        }
        // A new route (the glasses coming or going) stops the engine: start it again on the next beep.
        if !engine.isRunning {
            do { try engine.start() } catch { return }
        }
        if !player.isPlaying { player.play() }
        player.scheduleBuffer(tone, at: nil, options: [], completionHandler: nil)
    }

    func stop() {
        player.stop()
        engine.stop()
    }

    /// 70 ms of sine with a soft start and end, so it does not click.
    private func tone(frequency: Double, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let key = Int(frequency)
        if let tone = tones[key] { return tone }
        let frames = AVAudioFrameCount(Self.rate * 0.07)
        guard let tone = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
              let samples = tone.floatChannelData?[0] else { return nil }
        tone.frameLength = frames
        let count = Int(frames)
        for index in 0..<count {
            let envelope = min(1, Double(index) / 220) * min(1, Double(count - index) / 660)
            samples[index] = Float(sin(2 * .pi * frequency * Double(index) / Self.rate) * 0.4 * envelope)
        }
        tones[key] = tone
        return tone
    }
}
