import SwiftUI

/// Settings / Configure window – opened from the menu-bar extra.
///
/// Changes are staged locally; the server is only restarted when the user
/// clicks "Apply & Restart".
struct SettingsView: View {
    @EnvironmentObject var appState: AppState

    // Local editing copies
    @State private var editTransport: RpcTransport = .unixSocket
    @State private var editPort: Int             = 3020
    @State private var editPortString: String    = "3020"
    @State private var editSocketName: String    = "macos-control"
    @State private var editPeekabooEnabled: Bool = false
    @State private var editPeekabooBaseCommand: String = "npx -y @steipete/peekaboo"
    @State private var applyPending: Bool        = false

    var body: some View {
        Form {
            // ── Connection ───────────────────────────────────────────────
            Section {
                Picker("Method", selection: $editTransport) {
                    ForEach(RpcTransport.allCases) { t in
                        Text(t.displayName).tag(t)
                    }
                }
                .pickerStyle(.segmented)

                if editTransport == .http {
                    HStack {
                        Text("Port")
                        Spacer()
                        TextField("Port", text: $editPortString)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 80)
                    }
                } else {
                    HStack {
                        Text("Socket Name")
                        Spacer()
                        TextField("Socket name", text: $editSocketName)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 180)
                    }

                    HStack {
                        Text("Path")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("/tmp/langgraph-glove-\(editSocketName).sock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }

                HStack {
                    if appState.serverRunning {
                        Label("Server running", systemImage: "circle.fill")
                            .foregroundStyle(.green)
                            .font(.caption)
                    } else {
                        Label("Server stopped", systemImage: "circle.fill")
                            .foregroundStyle(.gray)
                            .font(.caption)
                    }
                    Spacer()
                    Button(applyPending ? "Applying…" : "Apply & Restart") {
                        apply()
                    }
                    .disabled(settingsUnchanged || applyPending)
                }
            } header: {
                Text("Connection Method")
            }

            // ── Peekaboo MCP bridge ─────────────────────────────────────
            Section {
                Toggle("Enable Peekaboo MCP tools", isOn: $editPeekabooEnabled)

                HStack {
                    Text("Base Command")
                    Spacer()
                    TextField("", text: $editPeekabooBaseCommand)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 260)
                }

                Text("When enabled, tool-macos-control starts '\(editPeekabooBaseCommand) mcp', discovers available MCP tools, and forwards calls with a peekaboo_ prefix.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Divider()

                // ── Diagnose Peekaboo ───────────────────────────────────
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .center, spacing: 8) {
                        Image(systemName: peekabooStatusIcon)
                            .foregroundStyle(peekabooStatusColor)
                        Text(peekabooStatusText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button(appState.peekabooDiagnosing ? "Diagnosing…" : "Diagnose Peekaboo") {
                            appState.runPeekabooDiagnostics()
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(appState.peekabooDiagnosing)
                    }

                    if let lastError = appState.peekabooLastError, appState.peekabooEnabled {
                        Text(lastError)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }

                    if !appState.peekabooDiagnosticLines.isEmpty, appState.peekabooEnabled {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(appState.peekabooDiagnosticLines) { line in
                                Text(line.text)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background(Color(.textBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
            } header: {
                Text("Peekaboo")
            }

            // ── Accessibility ────────────────────────────────────────────
            Section {
                HStack(spacing: 10) {
                    Image(systemName: appState.accessibilityGranted
                          ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(appState.accessibilityGranted ? .green : .red)
                        .font(.title3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(appState.accessibilityGranted
                             ? "Accessibility access granted"
                             : "Accessibility access not granted")
                            .fontWeight(.medium)
                        Text("Required to click, type, and read UI elements.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)

                HStack(spacing: 8) {
                    Button("Check / Request Access") {
                        appState.requestAccessibilityPermission()
                    }
                    Button("Open System Settings…") {
                        appState.openAccessibilitySettings()
                    }
                    .buttonStyle(.bordered)
                }
            } header: {
                Text("Accessibility")
            }
        }
        .formStyle(.grouped)
        .frame(width: 440, height: 600)
        .onAppear { syncFromAppState() }
    }

    // MARK: - Helpers

    private var settingsUnchanged: Bool {
        let parsedPort = Int(editPortString.filter { $0.isNumber })
        return editTransport == appState.transport
            && parsedPort    == appState.serverPort
            && editSocketName == appState.socketName
            && editPeekabooEnabled == appState.peekabooEnabled
            && editPeekabooBaseCommand == appState.peekabooBaseCommand
    }

    private var peekabooStatusText: String {
        if !appState.peekabooEnabled {
            return "Peekaboo MCP tools are disabled"
        }
        if appState.peekabooDiagnosing {
            return "Running Peekaboo diagnostics..."
        }
        if !appState.peekabooDiscoveredTools.isEmpty {
            return "Peekaboo discovered \(appState.peekabooDiscoveredTools.count) tools"
        }
        if appState.peekabooLastError != nil {
            return "Peekaboo discovery failed"
        }
        return "No tools discovered from Peekaboo MCP yet"
    }

    private var peekabooStatusIcon: String {
        if !appState.peekabooEnabled { return "power" }
        if appState.peekabooDiagnosing { return "arrow.triangle.2.circlepath" }
        if !appState.peekabooDiscoveredTools.isEmpty { return "checkmark.circle.fill" }
        if appState.peekabooLastError != nil { return "exclamationmark.triangle.fill" }
        return "questionmark.circle"
    }

    private var peekabooStatusColor: Color {
        if !appState.peekabooEnabled { return .secondary }
        if appState.peekabooDiagnosing { return .blue }
        if !appState.peekabooDiscoveredTools.isEmpty { return .green }
        if appState.peekabooLastError != nil { return .orange }
        return .secondary
    }

    private func syncFromAppState() {
        editTransport  = appState.transport
        editPort       = appState.serverPort
        editPortString = String(appState.serverPort)
        editSocketName = appState.socketName
        editPeekabooEnabled = appState.peekabooEnabled
        editPeekabooBaseCommand = appState.peekabooBaseCommand
    }

    private func apply() {
        applyPending = true
        appState.transport  = editTransport
        if let p = Int(editPortString.filter { $0.isNumber }), p > 0 {
            appState.serverPort = p
            editPort = p
            editPortString = String(p)
        }
        appState.socketName = editSocketName
        appState.peekabooEnabled = editPeekabooEnabled
        appState.peekabooBaseCommand = editPeekabooBaseCommand
        appState.saveSettings()
        appState.restartServer()
        // Brief visual feedback before re-enabling the button.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            applyPending = false
        }
    }
}

struct SettingsView_Previews: PreviewProvider {
    static var previews: some View {
        SettingsView()
            .environmentObject(AppState())
    }
}
