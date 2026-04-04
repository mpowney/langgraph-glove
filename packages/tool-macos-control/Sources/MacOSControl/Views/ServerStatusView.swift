import SwiftUI

struct ServerStatusView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        GroupBox("Tool Server") {
            VStack(spacing: 12) {
                // ── Transport selector ───────────────────────────────────
                HStack {
                    Text("Transport")
                        .foregroundStyle(.secondary)
                    Picker("", selection: $appState.transport) {
                        ForEach(RpcTransport.allCases) { t in
                            Text(t.displayName).tag(t)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(appState.serverRunning)
                    .frame(maxWidth: 200)
                    Spacer()
                }

                Divider()

                // ── Transport-specific config ────────────────────────────
                switch appState.transport {
                case .http:
                    httpConfigRow
                case .unixSocket:
                    unixSocketConfigRow
                }

                // ── Status + start/stop ──────────────────────────────────
                HStack {
                    Circle()
                        .fill(appState.serverRunning ? Color.green : Color.gray)
                        .frame(width: 8, height: 8)

                    Text(statusLabel)
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

                // ── HTTP endpoint list (only in HTTP mode when running) ──
                if appState.serverRunning, appState.transport == .http {
                    VStack(alignment: .leading, spacing: 4) {
                        EndpointRow(method: "POST", path: "/rpc",    description: "JSON-RPC tool calls", port: appState.serverPort)
                        EndpointRow(method: "GET",  path: "/tools",  description: "Tool introspection",  port: appState.serverPort)
                        EndpointRow(method: "GET",  path: "/health", description: "Health check",        port: appState.serverPort)
                    }
                    .padding(8)
                    .background(Color(.textBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
            .padding(8)
        }
    }

    // MARK: - Sub-views

    private var httpConfigRow: some View {
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
    }

    private var unixSocketConfigRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Socket name")
                    .foregroundStyle(.secondary)
                TextField("Socket name", text: $appState.socketName)
                    .textFieldStyle(.roundedBorder)
                    .disabled(appState.serverRunning)
                if appState.serverRunning {
                    Button("Restart") { appState.restartServer() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
            Text(appState.currentSocketPath)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private var statusLabel: String {
        guard appState.serverRunning else { return "Stopped" }
        switch appState.transport {
        case .http:
            return "Running on port \(appState.serverPort)"
        case .unixSocket:
            return "Running on Unix socket"
        }
    }
}

// MARK: - Single HTTP endpoint row

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
