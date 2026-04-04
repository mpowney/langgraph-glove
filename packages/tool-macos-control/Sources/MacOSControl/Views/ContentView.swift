import SwiftUI

struct ContentView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            // ── Header ──────────────────────────────────────────────────────
            HStack(spacing: 10) {
                Image(systemName: "macwindow.and.cursorarrow")
                    .font(.title2)
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 1) {
                    Text("macOS Control")
                        .font(.headline)
                    Text("langgraph-glove tool server")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    appState.checkPermissions()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh permission status")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.bar)

            Divider()

            // ── Scrollable content ──────────────────────────────────────────
            ScrollView {
                VStack(spacing: 16) {
                    PermissionsView()
                    ServerStatusView()
                    ToolListView()
                }
                .padding(16)
            }
        }
        .frame(minWidth: 500, minHeight: 420)
    }
}

// MARK: - Tool list summary

private struct ToolListView: View {
    private let tools = [
        ("macos_get_frontmost_app", "Get the frontmost application"),
        ("macos_list_running_apps", "List all running applications"),
        ("macos_launch_app",        "Launch an application by name or bundle ID"),
        ("macos_get_ui_tree",       "Get the accessibility tree of an app"),
        ("macos_find_element",      "Find a UI element by role / title / value"),
        ("macos_get_focused_element", "Get details of the currently focused element"),
        ("macos_click",             "Click at screen coordinates"),
        ("macos_type_text",         "Type text via keyboard simulation"),
        ("macos_press_key",         "Press a key or keyboard shortcut"),
        ("macos_scroll",            "Scroll at screen coordinates"),
        ("macos_take_screenshot",   "Capture the screen as a base64 PNG"),
    ]

    var body: some View {
        GroupBox("Available Tools") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(tools, id: \.0) { name, description in
                    HStack(alignment: .top, spacing: 8) {
                        Text(name)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 230, alignment: .leading)
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(8)
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}
