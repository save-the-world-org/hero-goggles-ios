import MWDATDisplay

/// A glance drawn for Meta's Ray-Ban Display, in the toolkit's views (`MWDATDisplay`): the place and the status at the
/// top, the line on a card with its note under it, the buttons in a group whose primary takes the focus, so a pinch of the
/// Neural Band presses it and a swipe moves to the next. Each `send` replaces the whole screen and its buttons. This file
/// imports no SwiftUI: the toolkit's `Text`, `Button` and `Image` share SwiftUI's names.
enum GlassesCard {
    static func view(_ glance: Glance, perform: @escaping @Sendable (Press) -> Void) -> FlexBox {
        FlexBox(direction: .column, spacing: 12) {
            FlexBox(direction: .column, spacing: 2) {
                Text(glance.place, style: .meta, color: .secondary)
                Text(glance.status, style: .heading)
            }
            FlexBox(direction: .column, spacing: 8) {
                Text(glance.line, style: .body)
                if let note = glance.note {
                    Text(note, style: .meta, color: .secondary)
                }
            }
            .padding(20)
            .background(.card)
            if !glance.choices.isEmpty {
                FlexBox(direction: .row, alignment: .center, crossAlignment: .center) {
                    ButtonGroup {
                        for choice in glance.choices {
                            button(choice, perform: perform)
                        }
                    }
                }
            }
        }
        .padding(16)
    }

    private static func button(_ choice: Glance.Choice, perform: @escaping @Sendable (Press) -> Void) -> Button {
        let press = choice.press
        // The toolkit draws a secondary button with an icon as the icon alone (found in the preview): only the primary
        // carries its icon, so every other button reads as its word.
        let button = Button(label: choice.label, style: choice.primary ? .primary : .secondary,
                            iconName: choice.primary ? icon(choice.icon) : nil, onClick: { perform(press) })
        return choice.primary ? button.actionRole(.primary) : button
    }

    /// The toolkit's icon for a glance's name of one.
    static func icon(_ name: String?) -> IconName? {
        switch name {
        case "checkmark": .checkmark
        case "pencil": .pencil
        case "x": .x
        case "speechBubble": .speechBubble
        case "paperAirplane": .paperAirplane
        case "triangleRight": .triangleRight
        case "twoTrianglesRight": .twoTrianglesRight
        default: nil
        }
    }
}
