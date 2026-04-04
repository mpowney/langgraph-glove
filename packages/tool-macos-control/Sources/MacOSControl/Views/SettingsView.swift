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
        .frame(width: 440)
        .onAppear { syncFromAppState() }
    }

    // MARK: - Helpers

    private var settingsUnchanged: Bool {
        let parsedPort = Int(editPortString.filter { $0.isNumber })
        return editTransport == appState.transport
            && parsedPort    == appState.serverPort
            && editSocketName == appState.socketName
    }

    private func syncFromAppState() {
        editTransport  = appState.transport
        editPort       = appState.serverPort
        editPortString = String(appState.serverPort)
        editSocketName = appState.socketName
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
        appState.saveSettings()
        appState.restartServer()
        // Brief visual feedback before re-enabling the button.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            applyPending = false
        }
    }
}

#Preview {
    SettingsView()
        .environmentObject(AppState())
}
