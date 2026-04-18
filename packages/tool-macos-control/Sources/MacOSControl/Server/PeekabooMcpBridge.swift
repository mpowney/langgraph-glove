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

struct PeekabooCommandProbeResult {
    let commandDescription: String
    let stayedRunning: Bool
    let exitCode: Int32?
    let stdout: String
    let stderr: String
}

private final class PeekabooProbeState: @unchecked Sendable {
    private let lock = NSLock()
    private var stdoutData = Data()
    private var stderrData = Data()
    private var resumed = false

    func appendStdout(_ data: Data) {
        lock.lock()
        stdoutData.append(data)
        lock.unlock()
    }

    func appendStderr(_ data: Data) {
        lock.lock()
        stderrData.append(data)
        lock.unlock()
    }

    func markResumedIfNeeded() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !resumed else { return false }
        resumed = true
        return true
    }

    func isResumed() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return resumed
    }

    func outputStrings() -> (stdout: String, stderr: String) {
        lock.lock()
        let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
        let stderr = String(data: stderrData, encoding: .utf8) ?? ""
        lock.unlock()
        return (stdout, stderr)
    }
}

private enum PeekabooMcpError: LocalizedError {
    case processStartFailed(String)
    case timedOut(String)
    case invalidResponse(String)
    case serverError(String)
    case invalidCommand(String)
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
        case .invalidCommand(let message):
            return "Invalid Peekaboo base command: \(message)"
        case .notRunning:
            return "Peekaboo MCP process is not running"
        }
    }
}

actor PeekabooMcpBridge {
    private enum StdioTransportMode {
        case contentLength
        case jsonLines
    }

    // Peekaboo MCP currently uses newline-delimited JSON-RPC on stdio.
    private let stdioTransportMode: StdioTransportMode = .jsonLines

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

    func probeBaseCommand(baseCommand: String) async throws -> PeekabooCommandProbeResult {
        let invocation = try processInvocation(for: baseCommand, additionalArguments: ["mcp"])
        let probeWindowNs: UInt64 = 1_500_000_000

        return try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: invocation.executable)
            process.arguments = invocation.arguments

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            let state = PeekabooProbeState()

            stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty { return }
                state.appendStdout(chunk)
            }

            stderrPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty { return }
                state.appendStderr(chunk)
            }

            process.terminationHandler = { proc in
                guard state.markResumedIfNeeded() else { return }
                stdoutPipe.fileHandleForReading.readabilityHandler = nil
                stderrPipe.fileHandleForReading.readabilityHandler = nil
                state.appendStdout(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
                state.appendStderr(stderrPipe.fileHandleForReading.readDataToEndOfFile())
                let output = state.outputStrings()
                continuation.resume(returning: PeekabooCommandProbeResult(
                    commandDescription: invocation.commandDescription,
                    stayedRunning: false,
                    exitCode: proc.terminationStatus,
                    stdout: output.stdout,
                    stderr: output.stderr
                ))
            }

            do {
                try process.run()
                Task {
                    try? await Task.sleep(nanoseconds: probeWindowNs)
                    guard !state.isResumed() else { return }
                    if process.isRunning {
                        process.terminate()
                        stdoutPipe.fileHandleForReading.readabilityHandler = nil
                        stderrPipe.fileHandleForReading.readabilityHandler = nil
                        state.appendStdout(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
                        state.appendStderr(stderrPipe.fileHandleForReading.readDataToEndOfFile())
                        guard state.markResumedIfNeeded() else { return }
                        let output = state.outputStrings()
                        continuation.resume(returning: PeekabooCommandProbeResult(
                            commandDescription: invocation.commandDescription,
                            stayedRunning: true,
                            exitCode: nil,
                            stdout: output.stdout,
                            stderr: output.stderr
                        ))
                    }
                }
            } catch {
                stdoutPipe.fileHandleForReading.readabilityHandler = nil
                stderrPipe.fileHandleForReading.readabilityHandler = nil
                guard state.markResumedIfNeeded() else { return }
                continuation.resume(throwing: PeekabooMcpError.processStartFailed(error.localizedDescription))
            }
        }
    }

    private func ensureConnected(baseCommand: String) async throws {

        if process?.isRunning == true,
           initialized,
           runningBaseCommand == baseCommand {
            return
        }

        stop()

        let invocation = try processInvocation(for: baseCommand, additionalArguments: ["mcp"])
        let process = Process()
        process.executableURL = URL(fileURLWithPath: invocation.executable)
        process.arguments = invocation.arguments

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

        try await performInitializeHandshake()

        try sendNotification(method: "notifications/initialized", params: [:])
        initialized = true
    }

    private func performInitializeHandshake() async throws {
        // Try Claude Code's newer protocol version first, then fall back to the
        // widely used 2024-11-05 version for older servers.
        let protocolVersions = ["2025-03-26", "2024-11-05"]
        var lastError: String?

        for version in protocolVersions {
            let response = try await sendRequest(
                method: "initialize",
                params: [
                    "protocolVersion": version,
                    "capabilities": [:],
                    "clientInfo": [
                        "name": "claude-code",
                        "version": "1.0.0"
                    ]
                ],
                timeoutMs: 12_000
            )

            if response["error"] == nil {
                return
            }

            lastError = errorMessage(from: response["error"]) ?? "initialize failed"
        }

        throw PeekabooMcpError.serverError(lastError ?? "initialize failed for all protocol versions")
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

        switch stdioTransportMode {
        case .jsonLines:
            stdin.fileHandleForWriting.write(body)
            stdin.fileHandleForWriting.write(Data("\n".utf8))
        case .contentLength:
            let header = "Content-Length: \(body.count)\r\n\r\n"
            guard let headerData = header.data(using: .utf8) else {
                throw PeekabooMcpError.invalidResponse("Failed to encode MCP header")
            }

            stdin.fileHandleForWriting.write(headerData)
            stdin.fileHandleForWriting.write(body)
        }
    }

    private func consumeStdout(_ data: Data) {
        stdoutBuffer.append(data)

        switch stdioTransportMode {
        case .jsonLines:
            consumeJsonLinesStdoutBuffer()
        case .contentLength:
            consumeContentLengthStdoutBuffer()
        }
    }

    private func consumeJsonLinesStdoutBuffer() {
        while let newlineIndex = stdoutBuffer.firstIndex(of: 0x0A) {
            var lineData = stdoutBuffer.subdata(in: 0..<newlineIndex)
            stdoutBuffer.removeSubrange(0...newlineIndex)

            if let last = lineData.last, last == 0x0D {
                lineData.removeLast()
            }

            if lineData.isEmpty {
                continue
            }

            guard let json = try? JSONSerialization.jsonObject(with: lineData, options: []),
                  let object = json as? [String: Any] else {
                continue
            }

            if let idNumber = object["id"] as? NSNumber {
                let id = idNumber.intValue
                if let continuation = pendingById.removeValue(forKey: id) {
                    continuation.resume(returning: object)
                }
            } else if let idString = object["id"] as? String,
                      let id = Int(idString),
                      let continuation = pendingById.removeValue(forKey: id) {
                continuation.resume(returning: object)
            }
        }
    }

    private func consumeContentLengthStdoutBuffer() {

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
            } else if let idString = object["id"] as? String,
                      let id = Int(idString),
                      let continuation = pendingById.removeValue(forKey: id) {
                continuation.resume(returning: object)
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

    private func processInvocation(
        for baseCommand: String,
        additionalArguments: [String]
    ) throws -> (executable: String, arguments: [String], commandDescription: String) {
        let command = baseCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        if command.isEmpty {
            throw PeekabooMcpError.invalidCommand("base command is empty")
        }

        let tokens = try parseCommandLine(command)
        guard let executable = tokens.first else {
            throw PeekabooMcpError.invalidCommand("base command has no executable")
        }

        let baseArgs = Array(tokens.dropFirst())
        let args = mergedArguments(baseArgs: baseArgs, additionalArguments: additionalArguments)

        // Claude-style stdio integrations launch a command directly with args
        // rather than through a shell string.
        if executable.contains("/") {
            let commandDescription = ([executable] + args)
                .map(shellEscape)
                .joined(separator: " ")
            return (executable, args, commandDescription)
        }

        if let resolvedExecutable = resolveExecutableOnPath(named: executable) {
            let commandDescription = ([resolvedExecutable] + args)
                .map(shellEscape)
                .joined(separator: " ")
            return (resolvedExecutable, args, commandDescription)
        }

        // App bundles often start without user shell bootstrap (nvm, asdf, etc.).
        // Fall back to a login shell so commands like `npx` remain discoverable.
        let shellCommand = ([executable] + args)
            .map(shellEscape)
            .joined(separator: " ")
        let shellExecutable = "/bin/zsh"
        let shellArgs = ["-lc", shellCommand]
        let commandDescription = ([shellExecutable] + shellArgs)
            .map(shellEscape)
            .joined(separator: " ")
        return (shellExecutable, shellArgs, commandDescription)
    }

    private func resolveExecutableOnPath(named executable: String) -> String? {
        let envPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let searchPaths = envPath
            .split(separator: ":")
            .map(String.init)
            .filter { !$0.isEmpty }

        for directory in searchPaths {
            let candidate = (directory as NSString).appendingPathComponent(executable)
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }

        return nil
    }

    private func mergedArguments(baseArgs: [String], additionalArguments: [String]) -> [String] {
        guard !additionalArguments.isEmpty else {
            return baseArgs
        }

        let normalizedBase = baseArgs.map { $0.lowercased() }
        if additionalArguments.count == 1,
           additionalArguments[0].lowercased() == "mcp",
           normalizedBase.contains("mcp") {
            return baseArgs
        }

        return baseArgs + additionalArguments
    }

    private func parseCommandLine(_ command: String) throws -> [String] {
        enum QuoteState {
            case none
            case single
            case double
        }

        var tokens: [String] = []
        var current = ""
        var state: QuoteState = .none
        var escapeNext = false

        for scalar in command.unicodeScalars {
            let char = Character(scalar)

            if escapeNext {
                current.append(char)
                escapeNext = false
                continue
            }

            switch state {
            case .single:
                if char == "'" {
                    state = .none
                } else {
                    current.append(char)
                }
            case .double:
                if char == "\"" {
                    state = .none
                } else if char == "\\" {
                    escapeNext = true
                } else {
                    current.append(char)
                }
            case .none:
                if char == "'" {
                    state = .single
                } else if char == "\"" {
                    state = .double
                } else if char == "\\" {
                    escapeNext = true
                } else if char.isWhitespace {
                    if !current.isEmpty {
                        tokens.append(current)
                        current.removeAll(keepingCapacity: true)
                    }
                } else {
                    current.append(char)
                }
            }
        }

        if escapeNext {
            throw PeekabooMcpError.invalidCommand("trailing escape in command")
        }
        if state != .none {
            throw PeekabooMcpError.invalidCommand("unterminated quoted string")
        }
        if !current.isEmpty {
            tokens.append(current)
        }

        return tokens
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

    private func shellEscape(_ value: String) -> String {
        if value.isEmpty {
            return "''"
        }
        let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }
}
