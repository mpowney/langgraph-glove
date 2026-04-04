import AppKit
import ApplicationServices
import Foundation

/// Central observable state shared between the SwiftUI views and the RPC server.
@MainActor
final class AppState: ObservableObject {

    // MARK: - Published state

    @Published var accessibilityGranted: Bool = false
    @Published var screenRecordingGranted: Bool = false

    @Published var serverRunning: Bool = false
    /// Port as Int so SwiftUI TextField(value:format:.number) works without extra bridging.
    @Published var serverPort: Int = 3020
    @Published var serverError: String? = nil

    // MARK: - Private

    private var server: RpcServer?

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
        let s = RpcServer(port: UInt16(clamping: serverPort), registry: registry)
        do {
            try s.start()
            server = s
            serverRunning = true
            serverError = nil
        } catch {
            serverError = error.localizedDescription
        }
    }

    func stopServer() {
        server?.stop()
        server = nil
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
