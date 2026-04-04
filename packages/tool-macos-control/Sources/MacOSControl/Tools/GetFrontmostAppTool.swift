import AppKit

let getFrontmostAppMetadata = ToolMetadata(
    name: "macos_get_frontmost_app",
    description: "Get information about the currently frontmost (focused) macOS application.",
    parameters: [
        "type": "object",
        "properties": [:] as [String: Any],
        "required": [] as [String]
    ]
)

func handleGetFrontmostApp(_ params: [String: Any]) async throws -> Any {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        throw ToolError.notFound("No frontmost application")
    }
    return [
        "name":              app.localizedName ?? "",
        "bundleIdentifier":  app.bundleIdentifier ?? "",
        "pid":               app.processIdentifier,
        "isHidden":          app.isHidden,
        "isActive":          app.isActive,
        "activationPolicy":  app.activationPolicy.rawValue,
    ] as [String: Any]
}
