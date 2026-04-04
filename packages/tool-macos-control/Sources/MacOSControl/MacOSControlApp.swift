import SwiftUI

/// Entry point for the macOS Control tool — a langgraph-glove tool server
/// that exposes macOS accessibility and UI-control capabilities over HTTP JSON-RPC.
///
/// Launch the app; use the control panel to grant the required permissions and
/// start the HTTP server.  The gateway can then call tools such as
/// `macos_click`, `macos_type_text`, `macos_get_ui_tree`, etc. via the
/// standard JSON-RPC protocol on `http://localhost:<port>/rpc`.
@main
struct MacOSControlApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup("macOS Control — langgraph-glove") {
            ContentView()
                .environmentObject(appState)
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .defaultSize(width: 540, height: 480)
    }
}
