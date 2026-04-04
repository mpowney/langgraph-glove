import SwiftUI

struct ServerStatusView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        GroupBox("Tool Server") {
            VStack(spacing: 12) {
                // ── Status + start/stop ──────────────────────────────────
                HStack {
                    Circle()
                        .fill(appState.serverRunning ? Color.green : Color.gray)
                        .frame(width: 8, height: 8)

                    Text(appState.serverRunning
                         ? "Running on port \(appState.serverPort)"
                         : "Stopped")
                        .fontWeight(.medium)

                    Spacer()

                    if appState.serverRunning {
                        Button("Stop") { appState.stopServer() }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    } else {
                        Button("Start") { appState.startServer() }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                }

                // ── Port selector (only editable when stopped) ───────────
                HStack {
                    Text("Port")
                        .foregroundStyle(.secondary)
                    TextField("Port", value: $appState.serverPort, format: .number)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 70)
                        .disabled(appState.serverRunning)
                    if appState.serverRunning {
                        Button("Restart") { appState.restartServer() }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    Spacer()
                }

                // ── Error message ────────────────────────────────────────
                if let error = appState.serverError {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                // ── Endpoint list (only when running) ────────────────────
                if appState.serverRunning {
                    VStack(alignment: .leading, spacing: 4) {
                        EndpointRow(method: "POST", path: "/rpc",    description: "JSON-RPC tool calls",    port: appState.serverPort)
                        EndpointRow(method: "GET",  path: "/tools",  description: "Tool introspection",    port: appState.serverPort)
                        EndpointRow(method: "GET",  path: "/health", description: "Health check",          port: appState.serverPort)
                    }
                    .padding(8)
                    .background(Color(.textBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
            .padding(8)
        }
    }
}

// MARK: - Single endpoint row

private struct EndpointRow: View {
    let method: String
    let path: String
    let description: String
    let port: Int

    private var methodColor: Color {
        method == "POST" ? .blue : .green
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(method)
                .font(.system(.caption2, design: .monospaced))
                .fontWeight(.semibold)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(methodColor.opacity(0.15))
                .foregroundStyle(methodColor)
                .clipShape(RoundedRectangle(cornerRadius: 3))

            Text("http://localhost:\(port)\(path)")
                .font(.system(.caption, design: .monospaced))

            Text("—")
                .foregroundStyle(.secondary)
                .font(.caption)

            Text(description)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

#Preview {
    ServerStatusView()
        .environmentObject(AppState())
        .padding()
}
