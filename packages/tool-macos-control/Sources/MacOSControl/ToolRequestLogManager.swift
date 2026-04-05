import Foundation

enum ToolLogKind: String, Sendable {
    case toolCall = "tool-call"
    case toolResult = "tool-result"
    case error = "error"

    var displayTitle: String {
        switch self {
        case .toolCall: return "Tool call"
        case .toolResult: return "Tool result"
        case .error: return "Error"
        }
    }
}

struct ToolLogEvent: Sendable {
    let timestamp: Date
    let kind: ToolLogKind
    let toolName: String
    let detail: String
}

struct ToolLogEntry: Identifiable {
    let id = UUID()
    let timestamp: Date
    let kind: ToolLogKind
    let toolName: String
    let detail: String

    init(from event: ToolLogEvent) {
        timestamp = event.timestamp
        kind = event.kind
        toolName = event.toolName
        detail = event.detail
    }

    var headerText: String {
        "\(kind.displayTitle): \(toolName)"
    }
}

actor ToolRequestLogManager {
    private let fileURL: URL
    private var sink: (@Sendable (ToolLogEvent) -> Void)?
    private let dateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    init() {
        fileURL = Self.makeLogFileURL()
        Self.ensureLogFileExists(at: fileURL)
    }

    func setEventSink(_ sink: @escaping @Sendable (ToolLogEvent) -> Void) {
        self.sink = sink
    }

    func logFilePath() -> String {
        fileURL.path
    }

    func logToolCall(toolName: String, payload: [String: Any]) {
        let detail = prettyJSONString(payload)
        let event = ToolLogEvent(timestamp: Date(), kind: .toolCall, toolName: toolName, detail: detail)
        emit(event)
    }

    func logToolResult(toolName: String, response: Any) {
        let detail = prettyJSONString(response)
        let event = ToolLogEvent(timestamp: Date(), kind: .toolResult, toolName: toolName, detail: detail)
        emit(event)
    }

    func logToolError(toolName: String, error: Error) {
        let detail = String(describing: error)
        let event = ToolLogEvent(timestamp: Date(), kind: .error, toolName: toolName, detail: detail)
        emit(event)
    }

    private func emit(_ event: ToolLogEvent) {
        sink?(event)
        let timestamp = dateFormatter.string(from: event.timestamp)
        let line = "[\(timestamp)] \(event.kind.displayTitle): \(event.toolName)\n\(event.detail)\n\n"
        appendToFile(line)
    }

    private func appendToFile(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        do {
            let handle = try FileHandle(forWritingTo: fileURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            // Best-effort logging; avoid surfacing file write errors to tool handlers.
        }
    }

    private static func ensureLogFileExists(at fileURL: URL) {
        let folder = fileURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: fileURL.path) {
                FileManager.default.createFile(atPath: fileURL.path, contents: Data(), attributes: nil)
            }
        } catch {
            // Best-effort setup; runtime logging will continue in-memory if file setup fails.
        }
    }

    private static func makeLogFileURL() -> URL {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library", isDirectory: true)
        return library
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent("langgraph-glove", isDirectory: true)
            .appendingPathComponent("tool-macos-control.log", isDirectory: false)
    }

    private func prettyJSONString(_ value: Any) -> String {
        if let text = value as? String {
            return text
        }

        if let dict = value as? [String: Any],
           let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            return text
        }

        if let array = value as? [Any],
           let data = try? JSONSerialization.data(withJSONObject: array, options: [.prettyPrinted, .sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            return text
        }

        return String(describing: value)
    }
}
