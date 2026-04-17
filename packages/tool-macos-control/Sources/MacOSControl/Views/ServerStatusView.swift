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

                Divider()

                HStack {
                    Toggle("Enable Peekaboo MCP tools", isOn: $appState.peekabooEnabled)
                        .onChange(of: appState.peekabooEnabled) { _ in
                            appState.saveSettings()
                            if appState.serverRunning {
                                appState.restartServer()
                            }
                        }
                    Spacer()
                }

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
            TextField("Port", value: $appState.serverPort, format: .number.grouping(.never))
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

            Text(verbatim: "http://localhost:\(port)\(path)")
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

struct ServerStatusView_Previews: PreviewProvider {
    static var previews: some View {
        ServerStatusView()
            .environmentObject(AppState())
            .padding()
    }
}
