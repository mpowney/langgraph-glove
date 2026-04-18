import AppKit
import ApplicationServices
import Foundation

struct DiscoveredToolInfo: Identifiable {
    let id: String
    let name: String
    let description: String
}

struct PeekabooDiagnosticLine: Identifiable {
    let id: String
    let text: String
}

// MARK: - Transport type

/// The transport protocol the tool server listens on.
enum RpcTransport: String, CaseIterable, Identifiable {
    /// HTTP/1.1 JSON-RPC on a TCP port — same as `HttpToolServer` in TypeScript.
    case http = "http"
    /// NDJSON over a Unix domain socket — same as `UnixSocketToolServer` in TypeScript.
    case unixSocket = "unix-socket"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .http: return "HTTP"
        case .unixSocket: return "Unix Socket"
        }
    }
}

// MARK: - App state

/// Central observable state shared between the SwiftUI views and the RPC server.
@MainActor
final class AppState: ObservableObject {

    // MARK: - Published state

    @Published var accessibilityGranted: Bool = false
    @Published var screenRecordingGranted: Bool = false

    /// Active transport.  Defaults to Unix socket to match all other tools in the monorepo.
    @Published var transport: RpcTransport = .unixSocket

    /// TCP port used when transport is `.http`.
    /// Stored as Int so SwiftUI TextField(value:format:.number) works without bridging.
    @Published var serverPort: Int = 3020

    /// Socket name used when transport is `.unixSocket`.
    /// The actual path will be `/tmp/langgraph-glove-{socketName}.sock`.
    @Published var socketName: String = "macos-control"

    /// Enable forwarding of dynamically discovered Peekaboo MCP tools.
    @Published var peekabooEnabled: Bool = false

    /// Enable built-in tools whose names begin with `macos_`.
    @Published var macosToolsEnabled: Bool = true

    /// Base command used to execute Peekaboo operations.
    /// The MCP server is started by appending `mcp`.
    @Published var peekabooBaseCommand: String = "npx -y @steipete/peekaboo"

    @Published var serverRunning: Bool = false
    @Published var serverError: String? = nil

    /// Number of currently-open Unix socket client connections.
    @Published var activeConnections: Int = 0
    /// Time of the most recent JSON-RPC request (any transport).
    @Published var lastRequestDate: Date? = nil
    /// In-memory tool activity log for the Tool Request Log window.
    @Published var toolLogEntries: [ToolLogEntry] = []
    /// Absolute path to the persistent log file.
    @Published var toolLogFilePath: String = ""
    /// Tools discovered from Peekaboo MCP and exposed via this server.
    @Published var peekabooDiscoveredTools: [DiscoveredToolInfo] = []
    /// Last discovery/diagnostic error for Peekaboo MCP integration.
    @Published var peekabooLastError: String? = nil
    /// Human-readable diagnostics shown in the main window.
    @Published var peekabooDiagnosticLines: [PeekabooDiagnosticLine] = []
    /// True while a manual diagnostic run is in progress.
    @Published var peekabooDiagnosing: Bool = false

    /// True when the gateway appears to be connected / recently active.
    /// - Unix socket: at least one open connection.
    /// - HTTP: a request was received within the last 30 seconds.
    var coreConnected: Bool {
        guard serverRunning else { return false }
        switch transport {
        case .unixSocket:
            return activeConnections > 0
        case .http:
            guard let last = lastRequestDate else { return false }
            return Date().timeIntervalSince(last) < 30
        }
    }

    // MARK: - Private

    private var httpServer: RpcServer?
    private var unixServer: UnixSocketRpcServer?
    private let toolLogManager = ToolRequestLogManager()
    private let peekabooMcpBridge = PeekabooMcpBridge()
    private var serverStarting: Bool = false

    /// Derived socket path — always in sync with `socketName`.
    var currentSocketPath: String { socketPathForTool(socketName) }

    // MARK: - Lifecycle

    init() {
        // Restore persisted settings.
        if let saved = UserDefaults.standard.string(forKey: "rpc.transport"),
           let t = RpcTransport(rawValue: saved) { transport = t }
        let savedPort = UserDefaults.standard.integer(forKey: "rpc.port")
        if savedPort > 0 { serverPort = savedPort }
        if let name = UserDefaults.standard.string(forKey: "rpc.socketName"), !name.isEmpty {
            socketName = name
        }
        if UserDefaults.standard.object(forKey: "macos.tools.enabled") != nil {
            macosToolsEnabled = UserDefaults.standard.bool(forKey: "macos.tools.enabled")
        } else if UserDefaults.standard.object(forKey: "macos.tools.disabled") != nil {
            // Backward compatibility for earlier inverted setting.
            macosToolsEnabled = !UserDefaults.standard.bool(forKey: "macos.tools.disabled")
        } else {
            macosToolsEnabled = true
        }
        peekabooEnabled = UserDefaults.standard.bool(forKey: "peekaboo.enabled")
        if let baseCommand = UserDefaults.standard.string(forKey: "peekaboo.baseCommand"),
           !baseCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            peekabooBaseCommand = baseCommand
        }
        checkPermissions()
        Task { [weak self] in
            guard let self else { return }
            await toolLogManager.setEventSink { event in
                Task { @MainActor [weak self] in
                    self?.appendToolLogEvent(event)
                }
            }
            let path = await toolLogManager.logFilePath()
            await MainActor.run { [weak self] in
                self?.toolLogFilePath = path
            }
        }
        // Auto-start the server so the gateway can connect immediately.
        startServer()
    }

    /// Persist the current transport/port/socketName to UserDefaults.
    func saveSettings() {
        UserDefaults.standard.set(transport.rawValue, forKey: "rpc.transport")
        UserDefaults.standard.set(serverPort, forKey: "rpc.port")
        UserDefaults.standard.set(socketName, forKey: "rpc.socketName")
        UserDefaults.standard.set(macosToolsEnabled, forKey: "macos.tools.enabled")
        UserDefaults.standard.set(peekabooEnabled, forKey: "peekaboo.enabled")
        UserDefaults.standard.set(peekabooBaseCommand, forKey: "peekaboo.baseCommand")
    }

    // MARK: - Permission management

    /// Refresh permission status from the system.
    func checkPermissions() {
        accessibilityGranted = AXIsProcessTrusted()
        if #available(macOS 10.15, *) {
            screenRecordingGranted = CGPreflightScreenCaptureAccess()
        } else {
            screenRecordingGranted = true
        }
    }

    /// Show the macOS Accessibility permission prompt (opens System Settings if needed).
    func requestAccessibilityPermission() {
        let options: NSDictionary = [
            kAXTrustedCheckOptionPrompt.takeRetainedValue() as String: true
        ]
        AXIsProcessTrustedWithOptions(options as CFDictionary)
        // Re-check after the user has had a chance to respond.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.checkPermissions()
        }
    }

    /// Request Screen Recording permission (macOS 10.15+).
    func requestScreenRecordingPermission() {
        if #available(macOS 10.15, *) {
            CGRequestScreenCaptureAccess()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.checkPermissions()
            }
        }
    }

    func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    func openScreenRecordingSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Server lifecycle

    func startServer() {
        guard !serverRunning, !serverStarting else { return }
        serverStarting = true
        Task { @MainActor [weak self] in
            await self?.startServerInternal()
        }
    }

    private func startServerInternal() async {
        defer { serverStarting = false }

        let registry = ToolRegistry()
        await registerAllTools(in: registry)

        let baseCommand = peekabooEnabled ? peekabooBaseCommand.trimmingCharacters(in: .whitespacesAndNewlines) : nil

        do {
            switch transport {
            case .http:
                let s = RpcServer(
                    port: UInt16(clamping: serverPort),
                    registry: registry,
                    peekabooMcpBridge: peekabooEnabled ? peekabooMcpBridge : nil,
                    peekabooBaseCommand: baseCommand
                )
                s.onRequestHandled = { [weak self] in
                    Task { @MainActor [weak self] in self?.lastRequestDate = Date() }
                }
                try s.start()
                httpServer = s

            case .unixSocket:
                let s = UnixSocketRpcServer(
                    name: socketName,
                    registry: registry,
                    peekabooMcpBridge: peekabooEnabled ? peekabooMcpBridge : nil,
                    peekabooBaseCommand: baseCommand
                )
                s.onConnectionOpened = { [weak self] in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.activeConnections += 1
                        self.lastRequestDate = Date()
                    }
                }
                s.onConnectionClosed = { [weak self] in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.activeConnections = max(0, self.activeConnections - 1)
                    }
                }
                s.onRequestHandled = { [weak self] in
                    Task { @MainActor [weak self] in self?.lastRequestDate = Date() }
                }
                try s.start()
                unixServer = s
            }
            serverRunning = true
            serverError = nil

            if peekabooEnabled {
                let command = peekabooBaseCommand.trimmingCharacters(in: .whitespacesAndNewlines)
                if command.isEmpty {
                    peekabooDiscoveredTools = []
                } else {
                    Task { @MainActor [weak self] in
                        await self?.refreshPeekabooDiscoveredTools(baseCommand: command)
                    }
                }
            } else {
                peekabooDiscoveredTools = []
            }
        } catch {
            serverError = error.localizedDescription
        }
    }

    func stopServer() {
        httpServer?.stop()
        httpServer = nil
        unixServer?.stop()
        unixServer = nil
        serverRunning = false
        serverStarting = false
        activeConnections = 0
        lastRequestDate = nil
        Task {
            await peekabooMcpBridge.stop()
        }
    }

    func runPeekabooDiagnostics() {
        guard !peekabooDiagnosing else { return }
        peekabooDiagnosing = true
        peekabooDiagnosticLines = []
        peekabooLastError = nil
        let baseCommand = peekabooBaseCommand.trimmingCharacters(in: .whitespacesAndNewlines)

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.peekabooDiagnosing = false }

            var lines: [PeekabooDiagnosticLine] = []
            lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Base command: \(baseCommand.isEmpty ? "<empty>" : baseCommand)"))
            lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Peekaboo enabled: \(peekabooEnabled ? "yes" : "no")"))
            lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Environment: command is launched directly via PATH (no shell profile/nvm bootstrap)"))

            if baseCommand.isEmpty {
                let message = "Base command is empty. Set it to something like 'npx -y @steipete/peekaboo'."
                self.peekabooLastError = message
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: message))
                self.peekabooDiagnosticLines = lines
                return
            }

            do {
                let probe = try await peekabooMcpBridge.probeBaseCommand(baseCommand: baseCommand)
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Command probe: \(probe.commandDescription)"))
                if probe.stayedRunning {
                    lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Command process state: running (expected for MCP stdio)"))
                } else {
                    let exitCodeText = probe.exitCode.map(String.init) ?? "unknown"
                    lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Command exited early with code: \(exitCodeText)"))
                }

                let stdout = probe.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                if !stdout.isEmpty {
                    for line in summarizeDiagnosticText(stdout, prefix: "stdout") {
                        lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: line))
                    }
                }

                let stderr = probe.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                if !stderr.isEmpty {
                    for line in summarizeDiagnosticText(stderr, prefix: "stderr") {
                        lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: line))
                    }
                }
            } catch {
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Command probe failed: \(error.localizedDescription)"))
            }

            do {
                let discovered = try await peekabooMcpBridge.discoverTools(baseCommand: baseCommand)
                self.setPeekabooDiscoveredTools(discovered)
                self.peekabooLastError = nil
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "MCP handshake: successful"))
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Tools discovered: \(discovered.count)"))

                if discovered.isEmpty {
                    lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Peekaboo MCP returned zero tools."))
                    lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Try restarting the server, then run diagnostics again."))
                    lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Also verify the command works in Terminal: \(baseCommand) mcp"))
                } else {
                    for tool in discovered.prefix(10) {
                        lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "- \(tool.proxyName)"))
                    }
                    if discovered.count > 10 {
                        lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "…and \(discovered.count - 10) more"))
                    }
                }
            } catch {
                let message = error.localizedDescription
                self.peekabooDiscoveredTools = []
                self.peekabooLastError = message
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "MCP handshake: failed"))
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Error: \(message)"))
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Verify the executable is discoverable from app PATH (or use an absolute executable path in Base Command)."))
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Also verify \"\(baseCommand) mcp\" works in Terminal."))
                lines.append(PeekabooDiagnosticLine(id: UUID().uuidString, text: "Or set Base Command to an absolute path to the peekaboo binary."))
            }

            self.peekabooDiagnosticLines = lines
        }
    }

    func restartServer() {
        stopServer()
        startServer()
    }

    // MARK: - Tool registration

    private func registerAllTools(in registry: ToolRegistry) async {
        if macosToolsEnabled {
            registerLoggedTool(in: registry, metadata: getFrontmostAppMetadata, handler: handleGetFrontmostApp)
            registerLoggedTool(in: registry, metadata: listRunningAppsMetadata, handler: handleListRunningApps)
            registerLoggedTool(in: registry, metadata: launchAppMetadata, handler: handleLaunchApp)
            registerLoggedTool(in: registry, metadata: getUITreeMetadata, handler: handleGetUITree)
            registerLoggedTool(in: registry, metadata: getUISubtreeMetadata, handler: handleGetUISubtree)
            registerLoggedTool(in: registry, metadata: findElementMetadata, handler: handleFindElement)
            registerLoggedTool(in: registry, metadata: getFocusedElementMetadata, handler: handleGetFocusedElement)
            registerLoggedTool(in: registry, metadata: clickMetadata, handler: handleClick)
            registerLoggedTool(in: registry, metadata: typeTextMetadata, handler: handleTypeText)
            registerLoggedTool(in: registry, metadata: pressKeyMetadata, handler: handlePressKey)
            registerLoggedTool(in: registry, metadata: scrollMetadata, handler: handleScroll)
            registerLoggedTool(in: registry, metadata: takeScreenshotMetadata, handler: handleTakeScreenshot)
        }
        
        // Peekaboo tools are now discovered dynamically via RPC dispatch interception.
        // No pre-registration needed in v3 model.
        if !peekabooEnabled {
            peekabooDiscoveredTools = []
            peekabooLastError = nil
        }
    }

    private func registerLoggedTool(
        in registry: ToolRegistry,
        metadata: ToolMetadata,
        handler: @escaping ToolHandler
    ) {
        let logger = toolLogManager
        registry.register(metadata: metadata) { params in
            await logger.logToolCall(toolName: metadata.name, payload: params)
            do {
                let result = try await handler(params)
                await logger.logToolResult(toolName: metadata.name, response: result)
                return result
            } catch {
                await logger.logToolError(toolName: metadata.name, error: error)
                throw error
            }
        }
    }

    private func appendToolLogEvent(_ event: ToolLogEvent) {
        toolLogEntries.append(ToolLogEntry(from: event))
        // Keep the in-memory list bounded so the UI remains responsive.
        let maxInMemoryEntries = 2_000
        if toolLogEntries.count > maxInMemoryEntries {
            toolLogEntries.removeFirst(toolLogEntries.count - maxInMemoryEntries)
        }
    }

    func revealToolLogFileInFinder() {
        guard !toolLogFilePath.isEmpty else { return }
        NSWorkspace.shared.selectFile(toolLogFilePath, inFileViewerRootedAtPath: "")
    }

    private func summarizeDiagnosticText(_ text: String, prefix: String) -> [String] {
        let allLines = text
            .split(whereSeparator: { $0.isNewline })
            .map { String($0) }
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

        let limit = 6
        if allLines.isEmpty {
            return []
        }

        var output = allLines.prefix(limit).map { "\(prefix): \($0)" }
        if allLines.count > limit {
            output.append("\(prefix): …and \(allLines.count - limit) more lines")
        }
        return output
    }

    private func setPeekabooDiscoveredTools(_ discovered: [PeekabooDiscoveredTool]) {
        peekabooDiscoveredTools = discovered.map {
            DiscoveredToolInfo(
                id: $0.proxyName,
                name: $0.proxyName,
                description: $0.description
            )
        }
    }

    private func refreshPeekabooDiscoveredTools(baseCommand: String) async {
        do {
            let discovered = try await peekabooMcpBridge.discoverTools(baseCommand: baseCommand)
            setPeekabooDiscoveredTools(discovered)
            peekabooLastError = nil
        } catch {
            peekabooDiscoveredTools = []
            peekabooLastError = error.localizedDescription
        }
    }
}
