import AppKit
import CoreGraphics

let clickMetadata = ToolMetadata(
    name: "macos_click",
    description: "Simulate a mouse click at the given screen coordinates. Supports left-click, right-click, and double-click.",
    parameters: [
        "type": "object",
        "properties": [
            "x": [
                "type": "number",
                "description": "Horizontal screen coordinate (pixels, origin at top-left of primary display)."
            ] as [String: Any],
            "y": [
                "type": "number",
                "description": "Vertical screen coordinate (pixels, origin at top-left of primary display)."
            ] as [String: Any],
            "button": [
                "type": "string",
                "enum": ["left", "right", "double"],
                "description": "Mouse button to click (default: 'left')."
            ] as [String: Any],
        ] as [String: Any],
        "required": ["x", "y"]
    ]
)

func handleClick(_ params: [String: Any]) async throws -> Any {
    guard AXIsProcessTrusted() else {
        throw ToolError.permissionDenied("Accessibility permission is required for mouse simulation.")
    }
    guard let x = params["x"] as? Double,
          let y = params["y"] as? Double else {
        throw ToolError.missingParameter("x and y coordinates are required")
    }

    let button = params["button"] as? String ?? "left"
    let point  = CGPoint(x: x, y: y)

    switch button {
    case "right":
        postMouseEvent(.rightMouseDown, up: .rightMouseUp, button: .right, at: point)
    case "double":
        postMouseEvent(.leftMouseDown, up: .leftMouseUp, button: .left, at: point)
        Thread.sleep(forTimeInterval: 0.08)
        postDoubleClick(at: point)
    default:
        postMouseEvent(.leftMouseDown, up: .leftMouseUp, button: .left, at: point)
    }

    return ["clicked": true, "x": x, "y": y, "button": button]
}

// MARK: - Helpers

private func postMouseEvent(
    _ downType: CGEventType,
    up upType: CGEventType,
    button: CGMouseButton,
    at point: CGPoint,
    clickState: Int64 = 1
) {
    let src = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(mouseEventSource: src, mouseType: downType,
                       mouseCursorPosition: point, mouseButton: button)
    let up   = CGEvent(mouseEventSource: src, mouseType: upType,
                       mouseCursorPosition: point, mouseButton: button)
    down?.setIntegerValueField(.mouseEventClickState, value: clickState)
    up?.setIntegerValueField(.mouseEventClickState, value: clickState)
    down?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.05)
    up?.post(tap: .cghidEventTap)
}

private func postDoubleClick(at point: CGPoint) {
    let src = CGEventSource(stateID: .hidSystemState)
    for clickState: Int64 in [1, 2] {
        let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                           mouseCursorPosition: point, mouseButton: .left)
        let up   = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
                           mouseCursorPosition: point, mouseButton: .left)
        down?.setIntegerValueField(.mouseEventClickState, value: clickState)
        up?.setIntegerValueField(.mouseEventClickState, value: clickState)
        down?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.05)
        up?.post(tap: .cghidEventTap)
        if clickState == 1 { Thread.sleep(forTimeInterval: 0.08) }
    }
}
