import Foundation
import Observation

/// What the glasses show at one time, the shape of Infrared's own (localred's `PlanGlance`): where the demo is, what goes
/// on, one line on a card with a note under it, and the buttons, three at most, the primary taking the focus so that a
/// pinch of the Neural Band presses it.
struct Glance: Equatable, Sendable {
    var place: String
    var status: String
    var line: String
    var note: String?
    var choices: [Choice]
    /// An arrow above the status, in degrees right of straight ahead: the way to a beacon (`Seeker`).
    var arrow: Int? = nil
    /// Drawn as the way to a beacon: the title, the arrow when there is one, the distance big, one line under it.
    var way = false

    struct Choice: Equatable, Sendable {
        var press: Press
        var label: String
        var icon: String?
        var primary = false
    }
}

/// A button's meaning, as it comes back from the glasses or from the phone.
enum Press: String, Sendable {
    case start, talk, skip, send, cancel, keep, change, again
    /// Starts seeking a UWB beacon (`Seeker.invitation`).
    case seek
}

/// Where a press came from: the glasses (a pinch of the Neural Band on a button the toolkit drew), the phone's copy of the
/// buttons, or the check run's autoplay.
enum Source: String, Sendable {
    case glasses, phone, autoplay
}

/// The spike's little conversation, in the shape of Infrared's planning session: a question, the answer heard, the
/// answer read back to keep or change. The answers are made up, as nothing listens: the glasses' microphones are the
/// phone's Bluetooth headset and need no toolkit, so the spike leaves the voice out.
@MainActor
@Observable
final class Demo {
    enum Step: Equatable {
        case hello, question, listening, readBack, kept
    }

    struct Entry: Identifiable, Equatable {
        let id: Int
        let press: Press
        let source: Source
        let at: Date
    }

    private struct Question {
        let lead: String
        let asked: String
        let heard: String
        let readBack: String
    }

    private static let questions = [
        Question(lead: "Product owner", asked: "Who uses this first, and what do they do on day one?",
                 heard: "A shop owner, putting up this week's opening hours.",
                 readBack: "The first person is a shop owner, and day one is this week's opening hours."),
        Question(lead: "Architect", asked: "Where do bookings live: in our database, or in the calendar people already use?",
                 heard: "In ours, with a copy sent to their calendar.",
                 readBack: "Bookings live in our database, with a copy sent to each person's calendar."),
        Question(lead: "Designer", asked: "What does someone see when there is nothing to show yet?",
                 heard: "One line saying what comes next, and a button to start.",
                 readBack: "An empty screen says what comes next, with one button to start."),
    ]

    private(set) var step: Step = .hello
    private(set) var asking = 0
    private(set) var kept = 0
    /// The newest first, twenty at most.
    private(set) var presses: [Entry] = []
    private var count = 0

    /// Presses that came from the glasses: the proof that the Neural Band reaches the phone.
    var fromGlasses: Int { presses.filter { $0.source == .glasses }.count }

    var glance: Glance {
        let question = Self.questions[asking % Self.questions.count]
        let place = "Question \(asking % Self.questions.count + 1) of \(Self.questions.count) · \(question.lead)"
        switch step {
        case .hello:
            return Glance(place: "Ray-Ban spike", status: "Hello",
                          line: "This screen comes from your phone. Pinch to press the button in focus; swipe to move to the next.",
                          note: "Nothing listens: the answers are made up.",
                          choices: [.init(press: .start, label: "Start", icon: "triangleRight", primary: true)])
        case .question:
            return Glance(place: place, status: "Your turn", line: question.asked,
                          note: "Talk to answer, Skip for the next question.",
                          choices: [.init(press: .talk, label: "Talk", icon: "speechBubble", primary: true),
                                    .init(press: .skip, label: "Skip")])
        case .listening:
            return Glance(place: place, status: "Listening", line: "“\(question.heard)”",
                          note: "Send when you're done.",
                          choices: [.init(press: .send, label: "Send", icon: "paperAirplane", primary: true),
                                    .init(press: .cancel, label: "Cancel")])
        case .readBack:
            return Glance(place: place, status: "Keep it?", line: question.readBack,
                          note: "Keep it, or Change to answer again.",
                          choices: [.init(press: .keep, label: "Keep it", icon: "checkmark", primary: true),
                                    .init(press: .change, label: "Change")])
        case .kept:
            return Glance(place: place, status: "Kept",
                          line: "\(kept) answer\(kept == 1 ? "" : "s") kept, \(fromGlasses) press\(fromGlasses == 1 ? "" : "es") from the glasses.",
                          note: "Again asks the next question.",
                          choices: [.init(press: .again, label: "Again", icon: "triangleRight", primary: true)])
        }
    }

    /// A press, from wherever it came: the step it moves the demo to. A press the glance no longer offers (a late one,
    /// from a screen already replaced) is logged and does nothing.
    func press(_ press: Press, from source: Source) {
        count += 1
        presses.insert(Entry(id: count, press: press, source: source, at: .now), at: 0)
        if presses.count > 20 { presses.removeLast() }
        guard glance.choices.contains(where: { $0.press == press }) else { return }
        switch (step, press) {
        case (.hello, .start): step = .question
        case (.question, .talk): step = .listening
        case (.question, .skip): asking += 1
        case (.listening, .send): step = .readBack
        case (.listening, .cancel): step = .question
        case (.readBack, .keep):
            kept += 1
            step = .kept
        case (.readBack, .change): step = .listening
        case (.kept, .again):
            asking += 1
            step = .question
        default: break
        }
    }

    /// The button in focus, pressed: what a pinch does.
    func pressPrimary(from source: Source) {
        guard let choice = glance.choices.first(where: \.primary) else { return }
        press(choice.press, from: source)
    }
}
