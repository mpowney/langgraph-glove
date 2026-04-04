import AppKit

let listRunningAppsMetadata = ToolMetadata(
    name: "macos_list_running_apps",
    description: "List all currently running macOS applications with their names, bundle IDs and PIDs.",
    parameters: [
        "type": "object",
        "properties": [
            "regularOnly": [
                "type": "boolean",
                "description": "When true (default), only return regular GUI apps and exclude background agents."
            ] as [String: Any]
        ] as [String: Any],
        "required": [] as [String]
    ]
)

func handleListRunningApps(_ params: [String: Any]) async throws -> Any {
    let regularOnly = params["regularOnly"] as? Bool ?? true

    let apps = NSWorkspace.shared.runningApplications
        .filter { app in
            !regularOnly || app.activationPolicy == .regular
        }
        .map { app -> [String: Any] in
            [
                "name":             app.localizedName ?? "",
                "bundleIdentifier": app.bundleIdentifier ?? "",
                "pid":              app.processIdentifier,
                "isHidden":         app.isHidden,
                "isActive":         app.isActive,
            ]
        }

    return apps
}
