import AppKit
import CoreGraphics

let scrollMetadata = ToolMetadata(
    name: "macos_scroll",
    description: "Simulate a scroll gesture at the given screen coordinates.",
    parameters: [
        "type": "object",
        "properties": [
            "x": [
                "type": "number",
                "description": "Horizontal screen coordinate (pixels)."
            ] as [String: Any],
            "y": [
                "type": "number",
                "description": "Vertical screen coordinate (pixels)."
            ] as [String: Any],
            "deltaY": [
                "type": "number",
                "description": "Vertical scroll amount in lines. Positive scrolls down, negative scrolls up (default: -3)."
            ] as [String: Any],
            "deltaX": [
                "type": "number",
                "description": "Horizontal scroll amount in lines (default: 0)."
            ] as [String: Any],
        ] as [String: Any],
        "required": ["x", "y"]
    ]
)

func handleScroll(_ params: [String: Any]) async throws -> Any {
    guard AXIsProcessTrusted() else {
        throw ToolError.permissionDenied("Accessibility permission is required for scroll simulation.")
    }
    guard let x = params["x"] as? Double,
          let y = params["y"] as? Double else {
        throw ToolError.missingParameter("x and y coordinates are required")
    }

    let deltaY = params["deltaY"] as? Double ?? -3.0
    let deltaX = params["deltaX"] as? Double ?? 0.0

    let point = CGPoint(x: x, y: y)

    // Move cursor to target position first.
    let src    = CGEventSource(stateID: .hidSystemState)
    let move   = CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
                         mouseCursorPosition: point, mouseButton: .left)
    move?.post(tap: .cghidEventTap)

    // Post a scroll wheel event.
    let scroll = CGEvent(
        scrollWheelEvent2Source: src,
        units: .line,
        wheelCount: 2,
        wheel1: Int32(deltaY),
        wheel2: Int32(deltaX),
        wheel3: 0
    )
    scroll?.location = point
    scroll?.post(tap: .cghidEventTap)

    return ["scrolled": true, "x": x, "y": y, "deltaY": deltaY, "deltaX": deltaX]
}
