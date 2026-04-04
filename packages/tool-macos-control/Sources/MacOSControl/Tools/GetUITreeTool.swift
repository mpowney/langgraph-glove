import AppKit
import ApplicationServices

let getUITreeMetadata = ToolMetadata(
    name: "macos_get_ui_tree",
    description: "Return the accessibility element tree of the frontmost application (or a specified app). Useful for understanding the structure of a UI before clicking or typing.",
    parameters: [
        "type": "object",
        "properties": [
            "bundleId": [
                "type": "string",
                "description": "Bundle identifier of the target application. Defaults to the frontmost app."
            ] as [String: Any],
            "maxDepth": [
                "type": "integer",
                "description": "Maximum tree depth to traverse (default: 4, max: 10)."
            ] as [String: Any],
        ] as [String: Any],
        "required": [] as [String]
    ]
)

func handleGetUITree(_ params: [String: Any]) async throws -> Any {
    guard AXIsProcessTrusted() else {
        throw ToolError.permissionDenied("Accessibility permission is required. Grant access in System Settings → Privacy & Security → Accessibility.")
    }

    let bundleId = params["bundleId"] as? String
    let maxDepth = min(params["maxDepth"] as? Int ?? 4, 10)

    guard let appElement = AXHelper.appElement(bundleId: bundleId) else {
        throw ToolError.notFound("Could not obtain AXUIElement for the target application")
    }

    return AXHelper.elementDict(appElement, maxDepth: maxDepth)
}
