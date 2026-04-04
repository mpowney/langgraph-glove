import SwiftUI

import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // When launched from a terminal, the terminal retains key focus.
        // Activate explicitly so keyboard input goes to our windows.
        NSApp.activate(ignoringOtherApps: true)
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
        WindowGroup("macOS Control — langgraph-glove") {
            ContentView()
                .environmentObject(appState)
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .defaultSize(width: 540, height: 480)

        // ── Settings / Configure window (opened from menu-bar extra) ─────
        Window("Configure macOS Control", id: "settings") {
            SettingsView()
                .environmentObject(appState)
        }
        .windowResizability(.contentSize)
        .defaultSize(width: 440, height: 360)

        // ── Menu-bar extra ───────────────────────────────────────────────
        MenuBarExtra {
            MenuBarView()
                .environmentObject(appState)
        } label: {
            Image(systemName: "macwindow.and.cursorarrow")
        }
        .menuBarExtraStyle(.menu)
    }
}
