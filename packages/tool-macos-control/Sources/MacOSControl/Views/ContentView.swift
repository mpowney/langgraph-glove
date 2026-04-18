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

// MARK: - Expandable description view

private struct ExpandableDescriptionView: View {
    let description: String
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(isExpanded ? nil : 3)

            // Check if description would exceed 3 lines by comparing against a 3-line measurement
            if shouldShowExpandButton {
                Button(action: { isExpanded.toggle() }) {
                    HStack(spacing: 4) {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                        Text(isExpanded ? "Collapse" : "Expand")
                            .font(.caption2)
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.blue)
                .frame(height: 16)
            }
        }
    }

    private var shouldShowExpandButton: Bool {
        // Measure if text exceeds 3 lines
        // A simple heuristic: if description is very long, probably needs more than 3 lines
        let estimatedLineCount = description.split(separator: "\n", omittingEmptySubsequences: false).count
            + (description.count / 50) // rough estimate of wrapped lines
        return estimatedLineCount > 3 || description.count > 150
    }
}

// MARK: - Tool list summary

private struct ToolListView: View {
    @EnvironmentObject var appState: AppState

    private let tools = [
        ("macos_get_frontmost_app", "Get the frontmost application"),
        ("macos_list_running_apps", "List all running applications"),
        ("macos_launch_app",        "Launch an application by name or bundle ID"),
        ("macos_get_ui_tree",       "Get the accessibility tree of an app"),
        ("macos_get_ui_subtree",    "Expand a focused accessibility subtree by node path"),
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
            VStack(alignment: .leading, spacing: 0) {
                if appState.macosToolsEnabled {
                    ForEach(0..<tools.count, id: \.self) { index in
                        let (name, description) = tools[index]
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .top, spacing: 8) {
                                Text(name)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(Color.accentColor)
                                    .frame(width: 230, alignment: .leading)
                                ExpandableDescriptionView(description: description)
                            }
                            if index < tools.count - 1 || appState.peekabooEnabled {
                                Divider()
                                    .padding(.vertical, 6)
                            }
                        }
                    }
                }
                if appState.peekabooEnabled {
                    if appState.peekabooDiscoveredTools.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .top, spacing: 8) {
                                Text("peekaboo")
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(Color.accentColor)
                                    .frame(width: 230, alignment: .leading)
                                Text("No tools discovered yet from Peekaboo MCP")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } else {
                        ForEach(0..<appState.peekabooDiscoveredTools.count, id: \.self) { index in
                            let tool = appState.peekabooDiscoveredTools[index]
                            VStack(alignment: .leading, spacing: 6) {
                                HStack(alignment: .top, spacing: 8) {
                                    Text(tool.name)
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(Color.accentColor)
                                        .frame(width: 230, alignment: .leading)
                                    ExpandableDescriptionView(description: tool.description)
                                }
                                if index < appState.peekabooDiscoveredTools.count - 1 {
                                    Divider()
                                        .padding(.vertical, 6)
                                }
                            }
                        }
                    }
                }
                if !appState.macosToolsEnabled && !appState.peekabooEnabled {
                    Text("No tools enabled")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
        }
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
            .environmentObject(AppState())
    }
}
