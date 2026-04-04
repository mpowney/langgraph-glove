import SwiftUI

/// Content of the menu-bar extra drop-down.
///
/// Rendered in `.menu` style so SwiftUI maps each `Button` to an
/// `NSMenuItem`, `Divider()` to a separator, and `Text`/`Label` with
/// `.disabled(true)` to non-interactive labels.
struct MenuBarView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        // ── Status ──────────────────────────────────────────────────────────
        Label {
            Text(statusText)
                .fontWeight(.medium)
        } icon: {
            Image(systemName: "circle.fill")
                .foregroundStyle(statusColor)
        }
        .disabled(true)

        Label {
            Text("Transport: \(appState.transport.displayName)")
        } icon: {
            Image(systemName: transportIcon)
        }
        .disabled(true)

        if appState.serverRunning {
            Label {
                Text(endpointText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } icon: {
                Image(systemName: "network")
            }
            .disabled(true)
        }

        Divider()

        // ── Actions ─────────────────────────────────────────────────────────
        Button("Configure…") {
            openWindow(id: "settings")
            // Bring the app forward so the settings window is visible.
            NSApp.activate(ignoringOtherApps: true)
        }

        Divider()

        Button("Quit macOS Control") {
            NSApplication.shared.terminate(nil)
        }
    }

    // MARK: - Helpers

    private var statusText: String {
        guard appState.serverRunning else { return "Server stopped" }
        if appState.coreConnected  { return "Connected to core" }
        return "Listening — awaiting core"
    }

    private var statusColor: Color {
        guard appState.serverRunning else { return .gray }
        return appState.coreConnected ? .green : .yellow
    }

    private var transportIcon: String {
        switch appState.transport {
        case .http:       return "globe"
        case .unixSocket: return "cable.connector"
        }
    }

    private var endpointText: String {
        switch appState.transport {
        case .http:
            return "http://localhost:\(appState.serverPort)/rpc"
        case .unixSocket:
            return appState.currentSocketPath
        }
    }
}
