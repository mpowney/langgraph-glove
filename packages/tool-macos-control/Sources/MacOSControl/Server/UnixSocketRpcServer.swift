import Darwin
import Foundation

// MARK: - Socket path helper

/// Convert a tool name to its canonical Unix socket path.
/// Mirrors the TypeScript `socketPathForTool()` in `tool-server/src/UnixSocketToolServer.ts`.
///
/// - Non-alphanumeric characters (except `-` and `_`) are replaced with `-`
/// - Result: `/tmp/langgraph-glove-{safe-name}.sock`
func socketPathForTool(_ name: String) -> String {
    let safe = name.lowercased().unicodeScalars.map { scalar -> String in
        let v = scalar.value
        let isAlpha = (v >= 97 && v <= 122)
        let isDigit = (v >= 48 && v <= 57)
        let isAllowed = v == 95 || v == 45  // '_' or '-'
        return (isAlpha || isDigit || isAllowed) ? String(scalar) : "-"
    }.joined()
    return "/tmp/langgraph-glove-\(safe).sock"
}

// MARK: - Unix socket server

/// A tool server that communicates via newline-delimited JSON (NDJSON) over a
/// Unix domain socket.
///
/// Mirrors the TypeScript `UnixSocketToolServer` from `tool-server`, using the
/// identical socket path convention and NDJSON framing so the langgraph-glove
/// gateway's `UnixSocketRpcClient` can connect directly.
///
/// Wire protocol:
///   - Each request/response is a single JSON object followed by `\n`
///   - Request fields:  `id` (string), `method` (string), `params` (object)
///   - Response fields: `id` (string), `result?` (any), `error?` (string)
final class UnixSocketRpcServer {
    let socketPath: String
    private let registry: ToolRegistry
    private let toolLogManager: ToolRequestLogManager?
    private var serverFd: Int32 = -1
    private let requestTimeoutMs: UInt64
    private let acceptQueue = DispatchQueue(
        label: "com.langgraph-glove.macos-control.unix-accept",
        qos: .userInteractive
    )
    /// Active client Tasks — cancelled when the server stops.
    private var clientTasks: [Task<Void, Never>] = []
    private let taskLock = NSLock()
    private var peekabooMcpBridge: PeekabooMcpBridge?
    private var peekabooBaseCommand: String?

    /// Called on a background Task when a client connects.
    var onConnectionOpened: (() -> Void)?
    /// Called on a background Task when a client disconnects.
    var onConnectionClosed: (() -> Void)?
    /// Called on a background Task each time a JSON-RPC request is handled.
    var onRequestHandled: (() -> Void)?

    init(
        name: String,
        registry: ToolRegistry,
        peekabooMcpBridge: PeekabooMcpBridge? = nil,
        peekabooBaseCommand: String? = nil,
        toolLogManager: ToolRequestLogManager? = nil
    ) {
        self.socketPath = socketPathForTool(name)
        self.registry = registry
        self.toolLogManager = toolLogManager
        self.peekabooMcpBridge = peekabooMcpBridge
        self.peekabooBaseCommand = peekabooBaseCommand
        let rawTimeout = ProcessInfo.processInfo.environment["MACOS_CONTROL_RPC_TIMEOUT_MS"]
        let parsedTimeout = rawTimeout.flatMap(UInt64.init) ?? 30_000
        self.requestTimeoutMs = max(1_000, parsedTimeout)
    }

    // MARK: - Lifecycle

    func start() throws {
        // Remove any stale socket file so bind() doesn't fail with EADDRINUSE.
        try? FileManager.default.removeItem(atPath: socketPath)

        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw NSError(
                domain: "UnixSocketRpcServer",
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: String(cString: Darwin.strerror(errno))]
            )
        }

        // Validate path length: sockaddr_un.sun_path is typically 104 bytes on macOS.
        let cap = MemoryLayout<sockaddr_un>.size
            - MemoryLayout<sa_family_t>.size
            - 1  // null terminator
        guard socketPath.utf8.count <= cap else {
            Darwin.close(fd)
            throw NSError(
                domain: "UnixSocketRpcServer",
                code: Int(ENAMETOOLONG),
                userInfo: [NSLocalizedDescriptionKey:
                    "Socket path is too long (\(socketPath.utf8.count) bytes, max \(cap)): \(socketPath)"]
            )
        }

        // Bind to the socket path.
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutablePointer(to: &addr.sun_path) { dest in
            socketPath.withCString { src in
                let len = Int(Darwin.strlen(src)) + 1  // includes null terminator
                Darwin.memcpy(UnsafeMutableRawPointer(dest), src, len)
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.bind(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            Darwin.close(fd)
            throw NSError(
                domain: "UnixSocketRpcServer",
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "bind() failed: \(String(cString: Darwin.strerror(errno)))"]
            )
        }

        guard Darwin.listen(fd, 10) == 0 else {
            Darwin.close(fd)
            throw NSError(
                domain: "UnixSocketRpcServer",
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "listen() failed: \(String(cString: Darwin.strerror(errno)))"]
            )
        }

        serverFd = fd

        // Accept loop runs on a dedicated background dispatch queue.
        acceptQueue.async { [weak self] in
            self?.acceptLoop()
        }
    }

    func stop() {
        // Cancel all in-flight client tasks first.
        taskLock.lock()
        let tasks = clientTasks
        clientTasks.removeAll()
        taskLock.unlock()
        for task in tasks { task.cancel() }

        let fd = serverFd
        serverFd = -1
        if fd >= 0 { Darwin.close(fd) }
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    // MARK: - Accept loop

    private func acceptLoop() {
        while serverFd >= 0 {
            let clientFd = Darwin.accept(serverFd, nil, nil)
            // A negative fd can mean the server was stopped (fd closed → EBADF/EINVAL).
            guard clientFd >= 0 else { return }

            let task = Task { await self.handleClient(fd: clientFd) }
            taskLock.lock()
            clientTasks.append(task)
            taskLock.unlock()
        }
    }

    // MARK: - Per-connection handler

    /// Reads NDJSON lines from `fd`, dispatches each to the `ToolRegistry`,
    /// and writes the response back as a JSON line.
    private func handleClient(fd: Int32) async {
        onConnectionOpened?()
        defer {
            Darwin.close(fd)
            onConnectionClosed?()
        }

        var lineBuffer = ""
        let chunkSize = 65_536
        var rawBuf = [UInt8](repeating: 0, count: chunkSize)

        while !Task.isCancelled {
            let n = Darwin.read(fd, &rawBuf, chunkSize)
            guard n > 0 else { break }
            guard let chunk = String(bytes: rawBuf[0..<n], encoding: .utf8) else { break }
            lineBuffer += chunk

            // Process all complete lines ('\n'-terminated) in the buffer.
            while let nlIndex = lineBuffer.firstIndex(of: "\n") {
                let line = String(lineBuffer[lineBuffer.startIndex..<nlIndex])
                lineBuffer = String(lineBuffer[lineBuffer.index(after: nlIndex)...])

                // Fast path: skip empty lines without the allocation from trimmingCharacters.
                guard !line.isEmpty, line.contains(where: { !$0.isWhitespace }) else { continue }

                guard let data = line.data(using: .utf8) else {
                    writeResponse(
                        RpcResponse(id: "unknown", result: nil, error: "Invalid JSON-RPC request: invalid UTF-8"),
                        to: fd
                    )
                    continue
                }

                guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    writeResponse(
                        RpcResponse(id: "unknown", result: nil, error: "Invalid JSON-RPC request: line is not a JSON object"),
                        to: fd
                    )
                    continue
                }

                guard let req = RpcRequest(json: json) else {
                    let requestId = json["id"] as? String ?? "unknown"
                    writeResponse(
                        RpcResponse(id: requestId, result: nil, error: "Invalid JSON-RPC request: missing required fields"),
                        to: fd
                    )
                    continue
                }

                let rpcResp = await dispatch(req)
                writeResponse(rpcResp, to: fd)
            }
        }
    }

    private func dispatch(_ req: RpcRequest) async -> RpcResponse {
        onRequestHandled?()
        
        // Merge native and Peekaboo tools for introspection
        if req.method == "__introspect__" {
            var allMetadata = registry.allMetadata()
            if let bridge = peekabooMcpBridge, let baseCmd = peekabooBaseCommand {
                do {
                    let peekabooTools = try await bridge.getToolsForIntrospect(baseCommand: baseCmd)
                    allMetadata.append(contentsOf: peekabooTools)
                } catch {
                    // Log error but continue with native tools only
                    print("Error fetching Peekaboo tools for introspection: \(error)")
                }
            }
            return RpcResponse(id: req.id, result: allMetadata, error: nil)
        }
        
        // Forward Peekaboo tool calls to the MCP bridge
        if req.method.hasPrefix("peekaboo_"), let bridge = peekabooMcpBridge {
            let upstreamName = String(req.method.dropFirst(9)) // Remove "peekaboo_" prefix
            await toolLogManager?.logToolCall(toolName: req.method, payload: req.params)
            do {
                let result = try await runWithTimeout(
                    milliseconds: requestTimeoutMs,
                    operation: { try await bridge.callTool(toolName: upstreamName, arguments: req.params) }
                )
                await toolLogManager?.logToolResult(toolName: req.method, response: result)
                return RpcResponse(id: req.id, result: result, error: nil)
            } catch {
                let enrichedMessage = enrichPeekabooError(toolName: req.method, message: error.localizedDescription)
                await toolLogManager?.logToolError(toolName: req.method, error: ToolError.failed(enrichedMessage))
                return RpcResponse(id: req.id, result: nil, error: enrichedMessage)
            }
        }
        
        // Dispatch native tools via registry
        guard let handler = registry.handler(for: req.method) else {
            return RpcResponse(id: req.id, result: nil, error: "Unknown method: \(req.method)")
        }
        do {
            let result = try await runWithTimeout(
                milliseconds: requestTimeoutMs,
                operation: { try await handler(req.params) }
            )
            return RpcResponse(id: req.id, result: result, error: nil)
        } catch {
            return RpcResponse(id: req.id, result: nil, error: error.localizedDescription)
        }
    }

    private func writeResponse(_ response: RpcResponse, to fd: Int32) {
        guard
            let jsonData = try? JSONSerialization.data(withJSONObject: response.toJSON()),
            let jsonStr = String(data: jsonData, encoding: .utf8)
        else { return }
        let line = jsonStr + "\n"
        line.withCString { ptr in
            _ = Darwin.write(fd, ptr, Darwin.strlen(ptr))
        }
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
