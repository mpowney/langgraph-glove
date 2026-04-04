import Foundation

// MARK: - JSON-RPC types (mirrors the TypeScript RpcProtocol in tool-server)

/// An incoming JSON-RPC request.
struct RpcRequest {
    let id: String
    let method: String
    let params: [String: Any]

    init?(json: [String: Any]) {
        guard
            let id = json["id"] as? String,
            let method = json["method"] as? String
        else { return nil }
        self.id = id
        self.method = method
        self.params = json["params"] as? [String: Any] ?? [:]
    }
}

/// An outgoing JSON-RPC response.
struct RpcResponse {
    let id: String
    let result: Any?
    let error: String?

    func toJSON() -> [String: Any] {
        var dict: [String: Any] = ["id": id]
        if let error {
            dict["error"] = error
        } else {
            dict["result"] = result ?? NSNull()
        }
        return dict
    }
}

/// Metadata for a single tool (exposed via `__introspect__` and `GET /tools`).
struct ToolMetadata {
    let name: String
    let description: String
    /// JSON Schema object describing the `params` accepted by this tool.
    let parameters: [String: Any]

    func toJSON() -> [String: Any] {
        ["name": name, "description": description, "parameters": parameters]
    }
}

/// A handler closure for a tool invocation.
typealias ToolHandler = ([String: Any]) async throws -> Any
