import Foundation
import Network

/// Minimal HTTP/1.1 JSON-RPC server that mirrors the endpoints provided by
/// the TypeScript `HttpToolServer` in the `tool-server` package:
///
///   POST /rpc     — Dispatch a JSON-RPC call
///   GET  /tools   — Return all registered tool metadata
///   GET  /health  — Return `{"status":"ok"}`
final class RpcServer {
    private let port: UInt16
    private let registry: ToolRegistry
    private var listener: NWListener?
    private let requestTimeoutMs: UInt64

    /// Called on the server's internal queue each time a JSON-RPC request is handled.
    var onRequestHandled: (() -> Void)?

    init(port: UInt16, registry: ToolRegistry) {
        self.port = port
        self.registry = registry
        let rawTimeout = ProcessInfo.processInfo.environment["MACOS_CONTROL_RPC_TIMEOUT_MS"]
        let parsedTimeout = rawTimeout.flatMap(UInt64.init) ?? 30_000
        self.requestTimeoutMs = max(1_000, parsedTimeout)
    }

    // MARK: - Lifecycle

    func start() throws {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(
                domain: "RpcServer",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid port \(port)"]
            )
        }

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true

        let listener = try NWListener(using: params, on: nwPort)
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            Task { await self.handleConnection(connection) }
        }
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state {
                print("[RpcServer] listener failed: \(error)")
            }
        }
        listener.start(queue: .global(qos: .userInteractive))
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - Connection handling

    private func handleConnection(_ connection: NWConnection) async {
        connection.start(queue: .global(qos: .userInteractive))

        guard let (method, path, body) = await readRequest(from: connection) else {
            connection.cancel()
            return
        }

        let responseString = await buildResponse(method: method, path: path, body: body)

        guard let responseData = responseString.data(using: .utf8) else {
            connection.cancel()
            return
        }

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            connection.send(content: responseData, completion: .contentProcessed { _ in
                continuation.resume()
            })
        }

        connection.cancel()
    }

    /// Read the full HTTP request (headers + body) in one or more NW receive calls.
    private func readRequest(
        from connection: NWConnection
    ) async -> (method: String, path: String, body: Data)? {
        var accumulated = Data()
        let separator = Data("\r\n\r\n".utf8)

        // Keep receiving until we have the complete headers.
        while accumulated.range(of: separator) == nil {
            guard let chunk = await receiveChunk(from: connection), !chunk.isEmpty else {
                return nil
            }
            accumulated.append(chunk)
        }

        guard let sepRange = accumulated.range(of: separator) else { return nil }

        let headerBytes = accumulated[..<sepRange.lowerBound]
        let headerStr = String(data: headerBytes, encoding: .utf8) ?? ""

        // Parse Content-Length so we know how many body bytes to expect.
        var contentLength = 0
        for line in headerStr.components(separatedBy: "\r\n").dropFirst() {
            let lower = line.lowercased()
            if lower.hasPrefix("content-length:") {
                let value = line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)
                contentLength = Int(value) ?? 0
                break
            }
        }

        // Receive remaining body bytes if not yet buffered.
        let bodyStart = sepRange.upperBound
        while accumulated.count < bodyStart + contentLength {
            guard let chunk = await receiveChunk(from: connection), !chunk.isEmpty else { break }
            accumulated.append(chunk)
        }

        let body = accumulated.count >= bodyStart + contentLength
            ? Data(accumulated[bodyStart..<(bodyStart + contentLength)])
            : Data(accumulated[bodyStart...])

        // Parse method and path from the request line.
        let requestLine = headerStr.components(separatedBy: "\r\n").first ?? ""
        let parts = requestLine.components(separatedBy: " ")
        let method = parts.first ?? "GET"
        let path = parts.count > 1 ? parts[1] : "/"

        return (method: method, path: path, body: body)
    }

    private func receiveChunk(from connection: NWConnection) async -> Data? {
        await withCheckedContinuation { continuation in
            connection.receive(
                minimumIncompleteLength: 1,
                maximumLength: 1 << 20
            ) { data, _, _, error in
                if error != nil {
                    continuation.resume(returning: nil)
                } else {
                    continuation.resume(returning: data)
                }
            }
        }
    }

    // MARK: - Request routing

    private func buildResponse(method: String, path: String, body: Data) async -> String {
        switch (method, path) {
        case ("GET", "/health"):
            return httpResponse(
                status: 200,
                body: #"{"status":"ok"}"#,
                contentType: "application/json"
            )

        case ("GET", "/tools"):
            let metadata = registry.allMetadata()
            guard
                let json = try? JSONSerialization.data(withJSONObject: metadata),
                let jsonStr = String(data: json, encoding: .utf8)
            else {
                return httpResponse(status: 500, body: "Serialization error")
            }
            return httpResponse(status: 200, body: jsonStr, contentType: "application/json")

        case ("POST", "/rpc"):
            return await dispatchRpc(body: body)

        case ("OPTIONS", _):
            return httpResponse(
                status: 204,
                body: "",
                extraHeaders: [
                    "Access-Control-Allow-Methods: GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers: Content-Type"
                ]
            )

        default:
            return httpResponse(status: 404, body: "Not Found")
        }
    }

    // MARK: - JSON-RPC dispatch

    private func dispatchRpc(body: Data) async -> String {
        guard !body.isEmpty else {
            let rpcResp = RpcResponse(id: "unknown", result: nil, error: "Invalid JSON-RPC request: empty body")
            return jsonRpcHttpResponse(rpcResp)
        }

        guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
            let rpcResp = RpcResponse(id: "unknown", result: nil, error: "Invalid JSON-RPC request: body is not a JSON object")
            return jsonRpcHttpResponse(rpcResp)
        }

        guard let req = RpcRequest(json: json) else {
            let requestId = json["id"] as? String ?? "unknown"
            let rpcResp = RpcResponse(id: requestId, result: nil, error: "Invalid JSON-RPC request: missing required fields")
            return jsonRpcHttpResponse(rpcResp)
        }

        let rpcResp: RpcResponse

        if req.method == "__introspect__" {
            rpcResp = RpcResponse(id: req.id, result: registry.allMetadata(), error: nil)
        } else if let handler = registry.handler(for: req.method) {
            do {
                let result = try await runWithTimeout(
                    milliseconds: requestTimeoutMs,
                    operation: { try await handler(req.params) }
                )
                rpcResp = RpcResponse(id: req.id, result: result, error: nil)
            } catch {
                rpcResp = RpcResponse(id: req.id, result: nil, error: error.localizedDescription)
            }
        } else {
            rpcResp = RpcResponse(id: req.id, result: nil, error: "Unknown method: \(req.method)")
        }

        return jsonRpcHttpResponse(rpcResp)
    }

    private func jsonRpcHttpResponse(_ rpcResp: RpcResponse) -> String {
        guard
            let jsonData = try? JSONSerialization.data(withJSONObject: rpcResp.toJSON()),
            let jsonStr = String(data: jsonData, encoding: .utf8)
        else {
            return httpResponse(status: 500, body: "Serialization error")
        }
        return httpResponse(status: 200, body: jsonStr, contentType: "application/json")
    }

    // MARK: - HTTP response helpers

    private func httpResponse(
        status: Int,
        body: String,
        contentType: String = "text/plain; charset=utf-8",
        extraHeaders: [String] = []
    ) -> String {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 204: statusText = "No Content"
        case 400: statusText = "Bad Request"
        case 404: statusText = "Not Found"
        case 500: statusText = "Internal Server Error"
        default:  statusText = "Unknown"
        }

        var lines = [
            "HTTP/1.1 \(status) \(statusText)",
            "Content-Type: \(contentType)",
            "Content-Length: \(body.utf8.count)",
            "Access-Control-Allow-Origin: *",
            "Connection: close",
        ]
        lines.append(contentsOf: extraHeaders)
        lines.append("")
        lines.append(body)
        return lines.joined(separator: "\r\n")
    }
}

private enum RpcTimeoutError: LocalizedError {
    case timedOut(ms: UInt64)

    var errorDescription: String? {
        switch self {
        case .timedOut(let ms):
            return "Tool request timed out after \(ms)ms"
        }
    }
}

private func runWithTimeout<T>(
    milliseconds: UInt64,
    operation: @escaping () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask {
            try await operation()
        }
        group.addTask {
            try await Task.sleep(nanoseconds: milliseconds * 1_000_000)
            throw RpcTimeoutError.timedOut(ms: milliseconds)
        }

        guard let first = try await group.next() else {
            throw RpcTimeoutError.timedOut(ms: milliseconds)
        }
        group.cancelAll()
        return first
    }
}
