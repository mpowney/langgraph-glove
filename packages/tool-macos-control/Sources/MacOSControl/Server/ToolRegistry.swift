import Foundation

/// Registry that stores tool metadata and their handlers.
/// Mirrors the `ToolServer.register()` pattern from the TypeScript `tool-server` package.
final class ToolRegistry {
    private(set) var entries: [(metadata: ToolMetadata, handler: ToolHandler)] = []

    func register(metadata: ToolMetadata, handler: @escaping ToolHandler) {
        entries.append((metadata: metadata, handler: handler))
    }

    func handler(for name: String) -> ToolHandler? {
        entries.first(where: { $0.metadata.name == name })?.handler
    }

    func allMetadata() -> [[String: Any]] {
        entries.map { $0.metadata.toJSON() }
    }
}
