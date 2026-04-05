import AppKit
import CoreGraphics

let typeTextMetadata = ToolMetadata(
    name: "macos_type_text",
    description: "Simulate typing arbitrary text into the currently focused input field. The text is delivered character-by-character via keyboard events.",
    parameters: [
        "type": "object",
        "properties": [
            "text": [
                "type": "string",
                "description": "The text string to type."
            ] as [String: Any],
            "delayMs": [
                "type": "integer",
                "description": "Delay in milliseconds between each character (default: 10). Increase for slower, more reliable input."
            ] as [String: Any],
        ] as [String: Any],
        "required": ["text"]
    ]
)

func handleTypeText(_ params: [String: Any]) async throws -> Any {
    guard AXIsProcessTrusted() else {
        throw ToolError.permissionDenied("Accessibility permission is required for keyboard simulation.")
    }
    guard let text = params["text"] as? String else {
        throw ToolError.missingParameter("text")
    }

    let delayMs = params["delayMs"] as? Int ?? 10

    let src = CGEventSource(stateID: .hidSystemState)

    for scalar in text.unicodeScalars {
        var uniChar = UniChar(scalar.value & 0xFFFF)
        let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
        let up   = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &uniChar)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &uniChar)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        if delayMs > 0 {
            try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
        }
    }

    return ["typed": text.count]
}
