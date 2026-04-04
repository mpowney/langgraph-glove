import AppKit

let launchAppMetadata = ToolMetadata(
    name: "macos_launch_app",
    description: "Launch a macOS application by its bundle identifier or display name, and optionally activate it.",
    parameters: [
        "type": "object",
        "properties": [
            "bundleId": [
                "type": "string",
                "description": "Bundle identifier of the application (e.g. 'com.apple.Safari')."
            ] as [String: Any],
            "name": [
                "type": "string",
                "description": "Display name of the application (e.g. 'Safari'). Used only when bundleId is not provided."
            ] as [String: Any],
            "activate": [
                "type": "boolean",
                "description": "Bring the application to the foreground after launching (default: true)."
            ] as [String: Any],
        ] as [String: Any],
        "required": [] as [String]
    ]
)

func handleLaunchApp(_ params: [String: Any]) async throws -> Any {
    let activate = params["activate"] as? Bool ?? true

    if let bundleId = params["bundleId"] as? String {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            throw ToolError.notFound("Application with bundle ID '\(bundleId)' not found")
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = activate
        try await NSWorkspace.shared.openApplication(at: url, configuration: config)
        return ["launched": true, "bundleId": bundleId]
    }

    if let name = params["name"] as? String {
        // Search /Applications and ~/Applications by display name.
        let searchDirs = [
            URL(fileURLWithPath: "/Applications"),
            URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Applications"),
        ]
        for dir in searchDirs {
            if let contents = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil
            ) {
                for appURL in contents where appURL.pathExtension == "app" {
                    let appName = appURL.deletingPathExtension().lastPathComponent
                    if appName.localizedCaseInsensitiveCompare(name) == .orderedSame {
                        let config = NSWorkspace.OpenConfiguration()
                        config.activates = activate
                        try await NSWorkspace.shared.openApplication(at: appURL, configuration: config)
                        return ["launched": true, "path": appURL.path]
                    }
                }
            }
        }
        throw ToolError.notFound("Application named '\(name)' not found in /Applications")
    }

    throw ToolError.missingParameter("bundleId or name")
}
