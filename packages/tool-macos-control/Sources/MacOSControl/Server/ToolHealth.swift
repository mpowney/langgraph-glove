import Foundation

struct ToolHealthDependency {
    let name: String
    let ok: Bool
    let detail: String?
    let severity: String?

    func toJSON() -> [String: Any] {
        var json: [String: Any] = [
            "name": name,
            "ok": ok,
        ]
        if let detail {
            json["detail"] = detail
        }
        if let severity {
            json["severity"] = severity
        }
        return json
    }
}


struct ToolHealthResult {
    let ok: Bool
    let summary: String
    let dependencies: [ToolHealthDependency]
    let latencyMs: Int

    func toJSON() -> [String: Any] {
        [
            "ok": ok,
            "summary": summary,
            "dependencies": dependencies.map { $0.toJSON() },
            "latencyMs": latencyMs,
        ]
    }
}

func runToolHealthCheck(
    peekabooMcpBridge: PeekabooMcpBridge?,
    peekabooBaseCommand: String?
) async -> ToolHealthResult {
    let startedAt = Date()
    let baseCommand = peekabooBaseCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    guard let bridge = peekabooMcpBridge, !baseCommand.isEmpty else {
      return ToolHealthResult(
        ok: true,
        summary: "ok",
        dependencies: [],
        latencyMs: Int(Date().timeIntervalSince(startedAt) * 1000)
      )
    }

    do {
        let probe = try await bridge.probeBaseCommand(baseCommand: baseCommand)
        let detail = probe.stayedRunning
            ? probe.commandDescription
            : "Exited early with code \(probe.exitCode.map(String.init) ?? "unknown")"
        let dependency = ToolHealthDependency(
            name: "peekaboo",
            ok: probe.stayedRunning,
            detail: detail,
            severity: nil
        )
        return ToolHealthResult(
            ok: probe.stayedRunning,
            summary: probe.stayedRunning ? "Peekaboo command is available" : "Peekaboo command exited early",
            dependencies: [dependency],
            latencyMs: Int(Date().timeIntervalSince(startedAt) * 1000)
        )
    } catch {
        return ToolHealthResult(
            ok: false,
            summary: "Peekaboo command is not available",
            dependencies: [
                ToolHealthDependency(
                    name: "peekaboo",
                    ok: false,
                    detail: error.localizedDescription,
                    severity: nil
                )
            ],
            latencyMs: Int(Date().timeIntervalSince(startedAt) * 1000)
        )
    }
}