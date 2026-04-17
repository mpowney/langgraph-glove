import Foundation

struct PeekabooDiscoveredTool {
    let proxyName: String
    let upstreamName: String
    let description: String
    let parameters: [String: Any]
    let commandTokens: [String]
}

struct PeekabooToolMetadata {
    let name: String
    let description: String
    let parameters: [String: Any]
}

private enum PeekabooMcpError: LocalizedError {
    case processStartFailed(String)
    case timedOut(String)
    case invalidResponse(String)
    case serverError(String)
    case notRunning

    var errorDescription: String? {
        switch self {
        case .processStartFailed(let message):
            return "Failed to start Peekaboo MCP server: \(message)"
        case .timedOut(let operation):
            return "Peekaboo MCP timeout while waiting for \(operation)"
        case .invalidResponse(let message):
            return "Invalid Peekaboo MCP response: \(message)"
        case .serverError(let message):
            return "Peekaboo MCP error: \(message)"
        case .notRunning:
            return "Peekaboo MCP process is not running"
        }
    }
}

actor PeekabooMcpBridge {
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutBuffer = Data()
    private var pendingById: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var nextRequestId: Int = 1
    private var initialized = false
    private var runningBaseCommand: String?

    func stop() {
        failAllPending(with: PeekabooMcpError.notRunning)

        if let output = process?.standardOutput as? Pipe {
            output.fileHandleForReading.readabilityHandler = nil
        }
        if let error = process?.standardError as? Pipe {
            error.fileHandleForReading.readabilityHandler = nil
        }

        process?.terminate()
        process = nil
        stdinPipe = nil
        stdoutBuffer.removeAll(keepingCapacity: false)
        initialized = false
        runningBaseCommand = nil
    }

    func discoverTools(baseCommand: String) async throws -> [PeekabooDiscoveredTool] {
        try await ensureConnected(baseCommand: baseCommand)

        let response = try await sendRequest(
            method: "tools/list",
            params: [:],
            timeoutMs: 12_000
        )

        guard let result = response["result"] as? [String: Any],
              let tools = result["tools"] as? [[String: Any]] else {
            throw PeekabooMcpError.invalidResponse("tools/list missing result.tools")
        }

        return tools.compactMap { tool in
            guard let name = tool["name"] as? String,
                  !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return nil
            }

            let desc = tool["description"] as? String ?? ""
            let inputSchema = tool["inputSchema"] as? [String: Any]
                ?? tool["parameters"] as? [String: Any]
                ?? [
                    "type": "object",
                    "properties": [:],
                    "required": []
                ]

            return PeekabooDiscoveredTool(
                proxyName: "peekaboo_\(sanitizeToolName(name))",
                upstreamName: name,
                description: desc,
                parameters: inputSchema,
                commandTokens: commandTokens(for: name)
            )
        }
    }

    func getToolsForIntrospect(baseCommand: String) async throws -> [[String: Any]] {
        try await ensureConnected(baseCommand: baseCommand)

        let response = try await sendRequest(
            method: "tools/list",
            params: [:],
            timeoutMs: 12_000
        )

        guard let result = response["result"] as? [String: Any],
              let tools = result["tools"] as? [[String: Any]] else {
            throw PeekabooMcpError.invalidResponse("tools/list missing result.tools")
        }

        return tools.compactMap { tool in
            guard let name = tool["name"] as? String,
                  !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return nil
            }

            let desc = tool["description"] as? String ?? ""
            let inputSchema = tool["inputSchema"] as? [String: Any]
                ?? tool["parameters"] as? [String: Any]
                ?? [
                    "type": "object",
                    "properties": [:],
                    "required": []
                ]

            let proxyName = "peekaboo_\(sanitizeToolName(name))"
            return [
                "name": proxyName,
                "description": "Peekaboo MCP tool '\(name)': \(desc)",
                "parameters": inputSchema
            ]
        }
    }

    func callTool(toolName: String, arguments: [String: Any]) async throws -> Any {
        let response = try await sendRequest(
            method: "tools/call",
            params: [
                "name": toolName,
                "arguments": arguments
            ],
            timeoutMs: 30_000
        )

        guard response["error"] == nil else {
            let message = errorMessage(from: response["error"]) ?? "Unknown tools/call error"
            throw PeekabooMcpError.serverError(message)
        }

        return response["result"] ?? NSNull()
    }

    private func ensureConnected(baseCommand: String) async throws {

        if process?.isRunning == true,
           initialized,
           runningBaseCommand == baseCommand {
            return
        }

        stop()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Prepend nvm initialization so Node.js versions from nvm are available.
        let nvmSetup = "export NVM_DIR=\"$HOME/.nvm\" && [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && nvm use 22 >/dev/null 2>&1; "
        process.arguments = ["-lc", nvmSetup + "\(baseCommand) mcp serve"]

        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()

        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            Task { await self?.consumeStdout(data) }
        }

        // Drain stderr to avoid pipe backpressure stalling the MCP process.
        stderr.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }

        process.terminationHandler = { [weak self] _ in
            Task {
                await self?.handleTermination()
            }
        }

        do {
            try process.run()
        } catch {
            throw PeekabooMcpError.processStartFailed(error.localizedDescription)
        }

        self.process = process
        self.stdinPipe = stdin
        self.runningBaseCommand = baseCommand

        _ = try await sendRequest(
            method: "initialize",
            params: [
                "protocolVersion": "2024-11-05",
                "capabilities": [:],
                "clientInfo": [
                    "name": "langgraph-glove-macos-control",
                    "version": "1.0.0"
                ]
            ],
            timeoutMs: 12_000
        )

        try sendNotification(method: "notifications/initialized", params: [:])
        initialized = true
    }

    private func sendRequest(
        method: String,
        params: [String: Any],
        timeoutMs: UInt64
    ) async throws -> [String: Any] {
        guard process?.isRunning == true else {
            throw PeekabooMcpError.notRunning
        }

        let id = nextRequestId
        nextRequestId += 1

        var payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method
        ]
        payload["params"] = params

        try writeMessage(payload)

        return try await withCheckedThrowingContinuation { continuation in
            pendingById[id] = continuation

            Task {
                try? await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
                self.timeoutRequest(id: id, operation: method)
            }
        }
    }

    private func sendNotification(method: String, params: [String: Any]) throws {
        var payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": method
        ]
        payload["params"] = params
        try writeMessage(payload)
    }

    private func writeMessage(_ message: [String: Any]) throws {
        guard let stdin = stdinPipe else {
            throw PeekabooMcpError.notRunning
        }
        let body = try JSONSerialization.data(withJSONObject: message, options: [])
        let header = "Content-Length: \(body.count)\r\n\r\n"

        guard let headerData = header.data(using: .utf8) else {
            throw PeekabooMcpError.invalidResponse("Failed to encode MCP header")
        }

        stdin.fileHandleForWriting.write(headerData)
        stdin.fileHandleForWriting.write(body)
    }

    private func consumeStdout(_ data: Data) {
        stdoutBuffer.append(data)

        while true {
            guard let headerRange = stdoutBuffer.range(of: Data("\r\n\r\n".utf8)) else {
                return
            }

            let headerData = stdoutBuffer.subdata(in: 0..<headerRange.lowerBound)
            guard let headerString = String(data: headerData, encoding: .utf8) else {
                stdoutBuffer.removeAll(keepingCapacity: false)
                return
            }

            let lines = headerString.components(separatedBy: "\r\n")
            guard let lengthLine = lines.first(where: { $0.lowercased().hasPrefix("content-length:") }) else {
                stdoutBuffer.removeSubrange(0..<headerRange.upperBound)
                continue
            }

            let lengthValue = lengthLine
                .dropFirst("content-length:".count)
                .trimmingCharacters(in: .whitespaces)

            guard let contentLength = Int(lengthValue), contentLength >= 0 else {
                stdoutBuffer.removeSubrange(0..<headerRange.upperBound)
                continue
            }

            let bodyStart = headerRange.upperBound
            let bodyEnd = bodyStart + contentLength
            guard stdoutBuffer.count >= bodyEnd else {
                return
            }

            let bodyData = stdoutBuffer.subdata(in: bodyStart..<bodyEnd)
            stdoutBuffer.removeSubrange(0..<bodyEnd)

            guard let json = try? JSONSerialization.jsonObject(with: bodyData, options: []),
                  let object = json as? [String: Any] else {
                continue
            }

            if let idNumber = object["id"] as? NSNumber {
                let id = idNumber.intValue
                if let continuation = pendingById.removeValue(forKey: id) {
                    continuation.resume(returning: object)
                }
            }
        }
    }

    private func timeoutRequest(id: Int, operation: String) {
        guard let continuation = pendingById.removeValue(forKey: id) else {
            return
        }
        continuation.resume(throwing: PeekabooMcpError.timedOut(operation))
    }

    private func handleTermination() {
        failAllPending(with: PeekabooMcpError.notRunning)

        process = nil
        stdinPipe = nil
        initialized = false
        stdoutBuffer.removeAll(keepingCapacity: false)
    }

    private func failAllPending(with error: Error) {
        let continuations = pendingById.values
        pendingById.removeAll()
        for continuation in continuations {
            continuation.resume(throwing: error)
        }
    }

    private func errorMessage(from payload: Any?) -> String? {
        guard let errorObject = payload as? [String: Any] else {
            return nil
        }
        if let message = errorObject["message"] as? String {
            return message
        }
        if let data = try? JSONSerialization.data(withJSONObject: errorObject, options: []),
           let jsonString = String(data: data, encoding: .utf8) {
            return jsonString
        }
        return nil
    }

    private func sanitizeToolName(_ name: String) -> String {
        let lower = name.lowercased()
        let mapped = lower.unicodeScalars.map { scalar -> Character in
            let value = scalar.value
            let isLowerAlpha = value >= 97 && value <= 122
            let isDigit = value >= 48 && value <= 57
            return (isLowerAlpha || isDigit) ? Character(scalar) : "_"
        }
        return String(mapped).replacingOccurrences(of: "__", with: "_")
    }

    private func commandTokens(for toolName: String) -> [String] {
        let lowered = toolName.lowercased()
        let normalized = lowered.unicodeScalars.map { scalar -> Character in
            let value = scalar.value
            let isLowerAlpha = value >= 97 && value <= 122
            let isDigit = value >= 48 && value <= 57
            return (isLowerAlpha || isDigit) ? Character(scalar) : " "
        }
        var parts = String(normalized)
            .split(separator: " ")
            .map(String.init)

        if parts.first == "peekaboo" {
            parts.removeFirst()
        }

        if parts.isEmpty {
            return [sanitizeToolName(toolName)]
        }
        return parts
    }
}
