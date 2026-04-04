import AppKit
import ApplicationServices

let getFocusedElementMetadata = ToolMetadata(
    name: "macos_get_focused_element",
    description: "Get details about the currently keyboard-focused UI element (role, title, value, position).",
    parameters: [
        "type": "object",
        "properties": [:] as [String: Any],
        "required": [] as [String]
    ]
)

func handleGetFocusedElement(_ params: [String: Any]) async throws -> Any {
    guard AXIsProcessTrusted() else {
        throw ToolError.permissionDenied("Accessibility permission is required.")
    }

    guard let element = AXHelper.focusedElement() else {
        throw ToolError.notFound("No element is currently focused")
    }

    var info: [String: Any] = [
        "role":        AXHelper.string(element, kAXRoleAttribute as String),
        "title":       AXHelper.string(element, kAXTitleAttribute as String),
        "value":       AXHelper.string(element, kAXValueAttribute as String),
        "description": AXHelper.string(element, kAXDescriptionAttribute as String),
        "isEnabled":   AXHelper.bool(element, kAXEnabledAttribute as String),
    ]
    if let pt = AXHelper.position(element) {
        info["position"] = ["x": pt.x, "y": pt.y]
    }
    if let sz = AXHelper.size(element) {
        info["size"] = ["width": sz.width, "height": sz.height]
    }
    return info
}
