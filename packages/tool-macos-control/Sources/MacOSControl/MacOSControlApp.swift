import SwiftUI

import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    private var appearanceObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // When launched from a terminal, the terminal retains key focus.
        // Activate explicitly so keyboard input goes to our windows.
        NSApp.activate(ignoringOtherApps: true)
        updateApplicationIconForAppearance()

        appearanceObserver = DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("AppleInterfaceThemeChangedNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.updateApplicationIconForAppearance()
        }
    }

    deinit {
        if let observer = appearanceObserver {
            DistributedNotificationCenter.default().removeObserver(observer)
        }
    }

    private func updateApplicationIconForAppearance() {
        let isDarkMode = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let iconName = isDarkMode ? "AppIcon-Dark" : "AppIcon-Light"
        guard
            let iconURL = Bundle.main.url(forResource: iconName, withExtension: "png"),
            let iconImage = NSImage(contentsOf: iconURL)
        else {
            return
        }
        NSApplication.shared.applicationIconImage = iconImage
    }
}

/// Entry point for the macOS Control tool — a langgraph-glove tool server
/// that exposes macOS accessibility and UI-control capabilities over HTTP JSON-RPC.
///
/// Launch the app; use the control panel to grant the required permissions and
/// start the HTTP server.  The gateway can then call tools such as
/// `macos_click`, `macos_type_text`, `macos_get_ui_tree`, etc. via the
/// standard JSON-RPC protocol on `http://localhost:<port>/rpc`.
///
/// A menu-bar extra provides at-a-glance status and quick access to settings.
@main
struct MacOSControlApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var appState = AppState()

    var body: some Scene {
        // ── Main control panel ───────────────────────────────────────────
        Window("macOS Control — langgraph-glove", id: "main") {
            ContentView()
                .environmentObject(appState)
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .defaultSize(width: 540, height: 720)

        // ── Settings / Configure window (opened from menu-bar extra) ─────
        Window("Configure macOS Control", id: "settings") {
            SettingsView()
                .environmentObject(appState)
        }
        .windowResizability(.contentSize)
        .defaultSize(width: 440, height: 900)

        // ── Tool request log window ──────────────────────────────────────
        Window("Tool Request Log", id: "tool-log") {
            ToolLogView()
                .environmentObject(appState)
        }
        .defaultSize(width: 760, height: 520)

        // ── Menu-bar extra ───────────────────────────────────────────────
        MenuBarExtra {
            MenuBarView()
                .environmentObject(appState)
        } label: {
            MenuBarIconLabel()
        }
        .menuBarExtraStyle(.menu)
    }
}
