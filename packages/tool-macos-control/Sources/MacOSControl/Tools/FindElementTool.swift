import AppKit
import ApplicationServices

let findElementMetadata = ToolMetadata(
    name: "macos_find_element",
    description: "Search the accessibility tree for UI elements matching the given criteria (role, title, value, or description). Returns up to `limit` matching elements with their positions.",
    parameters: [
        "type": "object",
        "properties": [
            "bundleId": [
                "type": "string",
                "description": "Bundle identifier of the target application. Defaults to the frontmost app."
            ] as [String: Any],
            "role": [
                "type": "string",
                "description": "AX role to filter by, e.g. 'AXButton', 'AXTextField', 'AXStaticText'."
            ] as [String: Any],
            "title": [
                "type": "string",
                "description": "Substring match on the element title (case-insensitive)."
            ] as [String: Any],
            "value": [
                "type": "string",
                "description": "Substring match on the element value (case-insensitive)."
            ] as [String: Any],
            "description": [
                "type": "string",
                "description": "Substring match on the element description / help text (case-insensitive)."
            ] as [String: Any],
            "limit": [
                "type": "integer",
                "description": "Maximum number of results to return (default: 10)."
            ] as [String: Any],
        ] as [String: Any],
        "required": [] as [String]
    ]
)

func handleFindElement(_ params: [String: Any]) async throws -> Any {
    guard AXIsProcessTrusted() else {
        throw ToolError.permissionDenied("Accessibility permission is required.")
    }

    let bundleId      = params["bundleId"]    as? String
    let roleFilter    = params["role"]        as? String
    let titleFilter   = params["title"]       as? String
    let valueFilter   = params["value"]       as? String
    let descFilter    = params["description"] as? String
    let limit         = params["limit"]       as? Int ?? 10

    guard let root = AXHelper.appElement(bundleId: bundleId) else {
        throw ToolError.notFound("Could not obtain AXUIElement for the target application")
    }

    let matches = AXHelper.findElements(in: root) { element in
        if let r = roleFilter {
            guard AXHelper.string(element, kAXRoleAttribute as String)
                .localizedCaseInsensitiveContains(r) else { return false }
        }
        if let t = titleFilter {
            guard AXHelper.string(element, kAXTitleAttribute as String)
                .localizedCaseInsensitiveContains(t) else { return false }
        }
        if let v = valueFilter {
            guard AXHelper.string(element, kAXValueAttribute as String)
                .localizedCaseInsensitiveContains(v) else { return false }
        }
        if let d = descFilter {
            guard AXHelper.string(element, kAXDescriptionAttribute as String)
                .localizedCaseInsensitiveContains(d) else { return false }
        }
        return true
    }

    let results = matches.prefix(limit).map { el -> [String: Any] in
        var info: [String: Any] = [
            "role":        AXHelper.string(el, kAXRoleAttribute as String),
            "title":       AXHelper.string(el, kAXTitleAttribute as String),
            "value":       AXHelper.string(el, kAXValueAttribute as String),
            "description": AXHelper.string(el, kAXDescriptionAttribute as String),
            "isEnabled":   AXHelper.bool(el, kAXEnabledAttribute as String),
        ]
        if let pt = AXHelper.position(el) {
            info["position"] = ["x": pt.x, "y": pt.y]
        }
        if let sz = AXHelper.size(el) {
            info["size"] = ["width": sz.width, "height": sz.height]
        }
        return info
    }

    return ["count": results.count, "elements": Array(results)]
}
