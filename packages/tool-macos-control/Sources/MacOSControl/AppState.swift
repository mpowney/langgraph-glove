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

    // MARK: - Private

    private var httpServer: RpcServer?
    private var unixServer: UnixSocketRpcServer?

    /// Derived socket path — always in sync with `socketName`.
    var currentSocketPath: String { socketPathForTool(socketName) }

    // MARK: - Lifecycle

    init() {
        checkPermissions()
        // Auto-start the server so the gateway can connect immediately.
        startServer()
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
                try s.start()
                httpServer = s

            case .unixSocket:
                let s = UnixSocketRpcServer(name: socketName, registry: registry)
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
    }

    func restartServer() {
        stopServer()
        startServer()
    }

    // MARK: - Tool registration

    private func registerAllTools(in registry: ToolRegistry) {
        registry.register(metadata: getFrontmostAppMetadata, handler: handleGetFrontmostApp)
        registry.register(metadata: listRunningAppsMetadata, handler: handleListRunningApps)
        registry.register(metadata: launchAppMetadata, handler: handleLaunchApp)
        registry.register(metadata: getUITreeMetadata, handler: handleGetUITree)
        registry.register(metadata: findElementMetadata, handler: handleFindElement)
        registry.register(metadata: getFocusedElementMetadata, handler: handleGetFocusedElement)
        registry.register(metadata: clickMetadata, handler: handleClick)
        registry.register(metadata: typeTextMetadata, handler: handleTypeText)
        registry.register(metadata: pressKeyMetadata, handler: handlePressKey)
        registry.register(metadata: scrollMetadata, handler: handleScroll)
        registry.register(metadata: takeScreenshotMetadata, handler: handleTakeScreenshot)
    }
}
