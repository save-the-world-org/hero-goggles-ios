import MWDATDisplay
import UIKit

/// A glance drawn for Meta's Ray-Ban Display, in the toolkit's views (`MWDATDisplay`): the place and the status at the
/// top, the line on a card with its note under it, the buttons in a group whose primary takes the focus, so a pinch of the
/// Neural Band presses it and a swipe moves to the next. Each `send` replaces the whole screen and its buttons. This file
/// imports no SwiftUI: the toolkit's `Text`, `Button` and `Image` share SwiftUI's names.
enum GlassesCard {
    static func view(_ glance: Glance, perform: @escaping @Sendable (Press) -> Void) -> FlexBox {
        if glance.way { return way(glance) }
        return FlexBox(direction: .column, spacing: 12) {
            heading(glance)
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

    /// The way to a beacon: the title, the arrow as big as the display allows when there is a direction, the distance
    /// under it, then the way in a few words. Nothing else: the coaching stays on the phone.
    private static func way(_ glance: Glance) -> FlexBox {
        FlexBox(direction: .column, spacing: 8, crossAlignment: .center) {
            Text(glance.place, style: .meta, color: .secondary)
            if let arrow = glance.arrow {
                Image(image: arrowImage(degrees: arrow), sizePreset: .fill)
            }
            Text(glance.status, style: .heading)
            Text(glance.line, style: .body)
        }
        .padding(16)
    }

    private static func heading(_ glance: Glance) -> FlexBox {
        FlexBox(direction: .column, spacing: 2) {
            Text(glance.place, style: .meta, color: .secondary)
            Text(glance.status, style: .heading)
        }
    }

    /// An arrow pointing `degrees` right of straight up, white on clear: the display draws light, and clear is the world.
    /// The canvas is wide and the arrow in its middle: drawn at `.fill`, the toolkit stretches the image across the
    /// display, so its shape sets the arrow's height and leaves room for the distance and the words under it. 640 pixels
    /// wide is more than the display's, so it is drawn down, never up.
    static func arrowImage(degrees: Int) -> UIImage {
        let size = CGSize(width: 640, height: 280)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let canvas = context.cgContext
            canvas.translateBy(x: size.width / 2, y: size.height / 2)
            canvas.rotate(by: CGFloat(degrees) * .pi / 180)
            let arrow = UIBezierPath()
            arrow.move(to: CGPoint(x: 0, y: -124))
            arrow.addLine(to: CGPoint(x: 88, y: -8))
            arrow.addLine(to: CGPoint(x: 32, y: -8))
            arrow.addLine(to: CGPoint(x: 32, y: 120))
            arrow.addLine(to: CGPoint(x: -32, y: 120))
            arrow.addLine(to: CGPoint(x: -32, y: -8))
            arrow.addLine(to: CGPoint(x: -88, y: -8))
            arrow.close()
            UIColor.white.setFill()
            arrow.fill()
        }
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
