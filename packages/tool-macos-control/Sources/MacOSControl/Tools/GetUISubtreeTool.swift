import AppKit
import ApplicationServices

let getUISubtreeMetadata = ToolMetadata(
    name: "macos_get_ui_subtree",
    description: "Expand and return a focused accessibility subtree from an app using a child-index path (for progressive retrieval).",
    parameters: [
        "type": "object",
        "properties": [
            "bundleId": [
                "type": "string",
                "description": "Bundle identifier of the target application. Defaults to the frontmost app."
            ] as [String: Any],
            "path": [
                "type": "array",
                "description": "Child-index path from the app root, e.g. [0,2,1]",
                "items": ["type": "integer", "minimum": 0] as [String: Any]
            ] as [String: Any],
            "maxDepth": [
                "type": "integer",
                "description": "Maximum subtree depth to traverse from the target node (default: 4, max: 10)."
            ] as [String: Any],
            "mode": [
                "type": "string",
                "description": "Output mode: 'full' (all standard attributes) or 'compact' (action-focused defaults).",
                "enum": ["full", "compact"]
            ] as [String: Any],
            "attributes": [
                "type": "array",
                "description": "Optional whitelist of node fields to return. Allowed: role, title, value, description, isEnabled, position, size.",
                "items": [
                    "type": "string",
                    "enum": ["role", "title", "value", "description", "isEnabled", "position", "size"]
                ] as [String: Any]
            ] as [String: Any],
            "interactiveOnly": [
                "type": "boolean",
                "description": "If true, prefer interactive controls and keep container branches only when needed for matched descendants."
            ] as [String: Any],
            "includeDisabled": [
                "type": "boolean",
                "description": "If false, disabled nodes are removed unless required to preserve matching descendants."
            ] as [String: Any],
            "roleFilter": [
                "type": "array",
                "description": "Optional role substrings to keep, e.g. ['AXButton','AXTextField'].",
                "items": ["type": "string"] as [String: Any]
            ] as [String: Any],
            "maxNodes": [
                "type": "integer",
                "description": "Optional hard cap on visited nodes. Useful to avoid very large payloads."
            ] as [String: Any],
        ] as [String: Any],
        "required": ["path"] as [String]
    ]
)

private let subtreeAllowedAttributes: Set<String> = [
    "role", "title", "value", "description", "isEnabled", "position", "size"
]

private let subtreeFullModeAttributes: Set<String> = subtreeAllowedAttributes
private let subtreeCompactModeAttributes: Set<String> = ["role", "title", "isEnabled", "position", "size"]

func handleGetUISubtree(_ params: [String: Any]) async throws -> Any {
    guard AXIsProcessTrusted() else {
        throw ToolError.permissionDenied("Accessibility permission is required. Grant access in System Settings → Privacy & Security → Accessibility.")
    }

    let bundleId = params["bundleId"] as? String
    let maxDepth = min(params["maxDepth"] as? Int ?? 4, 10)
    let mode = (params["mode"] as? String)?.lowercased() ?? "full"
    let interactiveOnly = params["interactiveOnly"] as? Bool ?? false
    let includeDisabled = params["includeDisabled"] as? Bool ?? true
    let roleFilter = params["roleFilter"] as? [String] ?? []
    let maxNodes = params["maxNodes"] as? Int

    guard let path = params["path"] as? [Int] else {
        throw ToolError.missingParameter("path")
    }

    let requestedAttributes = Set((params["attributes"] as? [String] ?? []).filter { subtreeAllowedAttributes.contains($0) })
    let effectiveAttributes: Set<String>
    if requestedAttributes.isEmpty {
        effectiveAttributes = mode == "compact" ? subtreeCompactModeAttributes : subtreeFullModeAttributes
    } else {
        effectiveAttributes = requestedAttributes
    }

    guard let appElement = AXHelper.appElement(bundleId: bundleId) else {
        throw ToolError.notFound("Could not obtain AXUIElement for the target application")
    }

    guard let target = AXHelper.element(atPath: path, from: appElement) else {
        throw ToolError.notFound("No node found at path \(path)")
    }

    let options = AXHelper.TreeOptions(
        attributes: effectiveAttributes,
        interactiveOnly: interactiveOnly,
        includeDisabled: includeDisabled,
        roleFilter: roleFilter
    )
    let budget = AXHelper.TraversalBudget(maxNodes: maxNodes)

    guard var result = AXHelper.elementDict(
        target,
        maxDepth: maxDepth,
        options: options,
        budget: budget
    ) else {
        throw ToolError.failed("UI subtree traversal was truncated before the target node could be captured")
    }

    var metadata: [String: Any] = [
        "mode": mode,
        "maxDepth": maxDepth,
        "path": path,
        "visitedNodes": budget.visitedNodes,
        "truncated": budget.truncated,
    ]
    if let maxNodes {
        metadata["maxNodes"] = maxNodes
    }
    if !roleFilter.isEmpty {
        metadata["roleFilter"] = roleFilter
    }
    metadata["interactiveOnly"] = interactiveOnly
    metadata["includeDisabled"] = includeDisabled
    metadata["attributes"] = Array(effectiveAttributes).sorted()

    result["_meta"] = metadata
    return result
}
