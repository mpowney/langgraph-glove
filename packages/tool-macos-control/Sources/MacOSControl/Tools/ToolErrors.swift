import Foundation

/// Errors thrown by tool handlers.
enum ToolError: LocalizedError {
    case missingParameter(String)
    case notFound(String)
    case permissionDenied(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .missingParameter(let p): return "Missing required parameter: \(p)"
        case .notFound(let m):         return "Not found: \(m)"
        case .permissionDenied(let m): return "Permission denied: \(m)"
        case .failed(let m):           return m
        }
    }
}

func enrichPeekabooError(toolName: String, message: String) -> String {
    let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
        return message
    }

    let normalized = trimmed.lowercased()
    let isFocusFailure = normalized.contains("failed to focus window")
        || normalized.contains("responding to focus requests")

    guard isFocusFailure else {
        return trimmed
    }

    let hint: String
    switch toolName {
    case "peekaboo_paste":
        hint = "Bring the target app window onto the current Space and make sure it is not minimized, then retry paste. If needed, call peekaboo_list first to find an on-screen window ID to target."
    case "peekaboo_window":
        hint = "The requested window was not focusable by macOS. Bring that app window onto the current Space or unminimize it, then retry. If needed, call peekaboo_list first to find an on-screen window ID."
    default:
        hint = "The target window was not focusable by macOS. Bring the app window onto the current Space or unminimize it, then retry. If needed, call peekaboo_list first to find an on-screen window ID."
    }

    if normalized.contains(hint.lowercased()) {
        return trimmed
    }

    return "\(trimmed) Hint: \(hint)"
}
