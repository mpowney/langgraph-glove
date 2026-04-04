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
