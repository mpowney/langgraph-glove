import Foundation

func runPeekabooCommand(
    baseCommand: String,
    commandTokens: [String],
    params: [String: Any]
) async throws -> Any {
    var argv: [String] = []

    if let positional = params["_args"] as? [Any] {
        argv.append(contentsOf: positional.compactMap(stringifyPrimitive))
    }

    for key in params.keys.sorted() {
        if key == "_args" { continue }
        let flag = key.count == 1 ? "-\(key)" : "--\(toKebabCase(key))"
        let value = params[key]

        switch value {
        case let boolValue as Bool:
            if boolValue { argv.append(flag) }
        case let stringValue as String:
            argv.append(flag)
            argv.append(stringValue)
        case let intValue as Int:
            argv.append(flag)
            argv.append(String(intValue))
        case let doubleValue as Double:
            argv.append(flag)
            argv.append(String(doubleValue))
        case let number as NSNumber:
            argv.append(flag)
            argv.append(number.stringValue)
        case let arrayValue as [Any]:
            for item in arrayValue {
                if let primitive = stringifyPrimitive(item) {
                    argv.append(flag)
                    argv.append(primitive)
                } else if let encoded = encodeJson(item) {
                    argv.append(flag)
                    argv.append(encoded)
                }
            }
        case let dictValue as [String: Any]:
            if let encoded = encodeJson(dictValue) {
                argv.append(flag)
                argv.append(encoded)
            }
        case _ as NSNull:
            break
        case nil:
            break
        default:
            if let encoded = encodeJson(value as Any) {
                argv.append(flag)
                argv.append(encoded)
            }
        }
    }

    let invocation = try processInvocation(for: baseCommand)
    var processArgs: [String] = invocation.arguments
    processArgs.append(contentsOf: commandTokens)
    processArgs.append("--json")
    processArgs.append(contentsOf: argv)

    let output = try await runProcessCommand(
        executable: invocation.executable,
        arguments: processArgs
    )

    if output.exitCode != 0 {
        let stderr = output.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let stdout = output.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let details = !stderr.isEmpty ? stderr : stdout
        throw ToolError.failed("Peekaboo command failed (\(output.exitCode)): \(details)")
    }

    let trimmedStdout = output.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedStdout.isEmpty,
       let data = trimmedStdout.data(using: .utf8),
       let parsed = try? JSONSerialization.jsonObject(with: data, options: []) {
        return parsed
    }

    let commandDescription = ([invocation.displayName] + processArgs)
        .map(shellEscape)
        .joined(separator: " ")

    return [
        "ok": true,
        "command": commandDescription,
        "stdout": output.stdout,
        "stderr": output.stderr,
        "exitCode": output.exitCode,
    ]
}

private struct ShellCommandOutput {
    let stdout: String
    let stderr: String
    let exitCode: Int32
}

private func runProcessCommand(executable: String, arguments: [String]) async throws -> ShellCommandOutput {
    try await withCheckedThrowingContinuation { continuation in
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        process.terminationHandler = { proc in
            let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()

            let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
            let stderr = String(data: stderrData, encoding: .utf8) ?? ""

            continuation.resume(returning: ShellCommandOutput(
                stdout: stdout,
                stderr: stderr,
                exitCode: proc.terminationStatus
            ))
        }

        do {
            try process.run()
        } catch {
            continuation.resume(throwing: ToolError.failed("Failed to start Peekaboo command: \(error.localizedDescription)"))
        }
    }
}

private func processInvocation(for baseCommand: String) throws -> (executable: String, arguments: [String], displayName: String) {
    let command = baseCommand.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !command.isEmpty else {
        throw ToolError.failed("Peekaboo base command is empty")
    }

    let tokens = try parseCommandLine(command)
    guard let executable = tokens.first else {
        throw ToolError.failed("Peekaboo base command has no executable")
    }

    let args = Array(tokens.dropFirst())

    if executable.contains("/") {
        return (executable, args, executable)
    }

    return ("/usr/bin/env", [executable] + args, executable)
}

private func parseCommandLine(_ command: String) throws -> [String] {
    enum QuoteState {
        case none
        case single
        case double
    }

    var tokens: [String] = []
    var current = ""
    var state: QuoteState = .none
    var escapeNext = false

    for scalar in command.unicodeScalars {
        let char = Character(scalar)

        if escapeNext {
            current.append(char)
            escapeNext = false
            continue
        }

        switch state {
        case .single:
            if char == "'" {
                state = .none
            } else {
                current.append(char)
            }
        case .double:
            if char == "\"" {
                state = .none
            } else if char == "\\" {
                escapeNext = true
            } else {
                current.append(char)
            }
        case .none:
            if char == "'" {
                state = .single
            } else if char == "\"" {
                state = .double
            } else if char == "\\" {
                escapeNext = true
            } else if char.isWhitespace {
                if !current.isEmpty {
                    tokens.append(current)
                    current.removeAll(keepingCapacity: true)
                }
            } else {
                current.append(char)
            }
        }
    }

    if escapeNext {
        throw ToolError.failed("Peekaboo base command has a trailing escape")
    }
    if state != .none {
        throw ToolError.failed("Peekaboo base command has an unterminated quote")
    }
    if !current.isEmpty {
        tokens.append(current)
    }

    return tokens
}

private func stringifyPrimitive(_ value: Any) -> String? {
    switch value {
    case let s as String: return s
    case let b as Bool: return b ? "true" : "false"
    case let i as Int: return String(i)
    case let d as Double: return String(d)
    case let n as NSNumber: return n.stringValue
    default: return nil
    }
}

private func encodeJson(_ value: Any) -> String? {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: []),
          let text = String(data: data, encoding: .utf8) else {
        return nil
    }
    return text
}

private func toKebabCase(_ key: String) -> String {
    var output = ""
    for scalar in key.unicodeScalars {
        let value = scalar.value
        let isUpper = value >= 65 && value <= 90
        let isLower = value >= 97 && value <= 122
        let isDigit = value >= 48 && value <= 57

        if isUpper {
            if !output.isEmpty { output.append("-") }
            output.append(Character(UnicodeScalar(value + 32)!))
        } else if isLower || isDigit {
            output.append(Character(scalar))
        } else {
            output.append("-")
        }
    }
    while output.contains("--") {
        output = output.replacingOccurrences(of: "--", with: "-")
    }
    return output.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
}

private func shellEscape(_ value: String) -> String {
    if value.isEmpty {
        return "''"
    }
    let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
    return "'\(escaped)'"
}
