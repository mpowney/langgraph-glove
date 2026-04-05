import AppKit
import ApplicationServices
import Foundation

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
        guard !serverRunning else { return }
        let registry = ToolRegistry()
        registerAllTools(in: registry)

        do {
            switch transport {
            case .http:
                let s = RpcServer(port: UInt16(clamping: serverPort), registry: registry)
                s.onRequestHandled = { [weak self] in
                    Task { @MainActor [weak self] in self?.lastRequestDate = Date() }
                }
                try s.start()
                httpServer = s

            case .unixSocket:
                let s = UnixSocketRpcServer(name: socketName, registry: registry)
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
        activeConnections = 0
        lastRequestDate = nil
    }

    func restartServer() {
        stopServer()
        startServer()
    }

    // MARK: - Tool registration

    private func registerAllTools(in registry: ToolRegistry) {
        registerLoggedTool(in: registry, metadata: getFrontmostAppMetadata, handler: handleGetFrontmostApp)
        registerLoggedTool(in: registry, metadata: listRunningAppsMetadata, handler: handleListRunningApps)
        registerLoggedTool(in: registry, metadata: launchAppMetadata, handler: handleLaunchApp)
        registerLoggedTool(in: registry, metadata: getUITreeMetadata, handler: handleGetUITree)
        registerLoggedTool(in: registry, metadata: findElementMetadata, handler: handleFindElement)
        registerLoggedTool(in: registry, metadata: getFocusedElementMetadata, handler: handleGetFocusedElement)
        registerLoggedTool(in: registry, metadata: clickMetadata, handler: handleClick)
        registerLoggedTool(in: registry, metadata: typeTextMetadata, handler: handleTypeText)
        registerLoggedTool(in: registry, metadata: pressKeyMetadata, handler: handlePressKey)
        registerLoggedTool(in: registry, metadata: scrollMetadata, handler: handleScroll)
        registerLoggedTool(in: registry, metadata: takeScreenshotMetadata, handler: handleTakeScreenshot)
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
}
