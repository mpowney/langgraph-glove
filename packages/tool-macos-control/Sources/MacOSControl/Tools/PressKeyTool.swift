import AppKit
import CoreGraphics

/// Virtual key-code lookup table for common named keys.
/// Values match the `kVK_*` constants in Carbon's `Events.h`.
private let keyCodeMap: [String: CGKeyCode] = [
    // Control / editing
    "return":    36,
    "enter":     36,
    "tab":       48,
    "space":     49,
    "delete":    51,
    "backspace": 51,
    "escape":    53,
    "esc":       53,
    "capslock":  57,
    "fn":        63,
    "help":      114,
    "home":      115,
    "pageup":    116,
    "forwarddelete": 117,
    "end":       119,
    "pagedown":  121,

    // Arrow keys
    "left":      123,
    "right":     124,
    "down":      125,
    "up":        126,

    // F-keys
    "f1":  122, "f2":  120, "f3":   99, "f4":  118,
    "f5":   96, "f6":   97, "f7":   98, "f8":  100,
    "f9":  101, "f10": 109, "f11": 103, "f12": 111,

    // ANSI letter keys
    "a": 0,  "s": 1,  "d": 2,  "f": 3,  "h": 4,
    "g": 5,  "z": 6,  "x": 7,  "c": 8,  "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20,
    "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30,
    "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
    ".": 47, "`": 50,
]

let pressKeyMetadata = ToolMetadata(
    name: "macos_press_key",
    description: "Simulate pressing a keyboard key or shortcut. Modifiers: 'command', 'shift', 'option', 'control'. Example key names: 'return', 'escape', 'tab', 'space', 'left', 'right', 'up', 'down', 'f1'…'f12', or any single letter/digit.",
    parameters: [
        "type": "object",
        "properties": [
            "key": [
                "type": "string",
                "description": "Key name (case-insensitive) or a single character."
            ] as [String: Any],
            "modifiers": [
                "type": "array",
                "items": ["type": "string"],
                "description": "Modifier keys to hold: 'command', 'shift', 'option', 'control'."
            ] as [String: Any],
        ] as [String: Any],
        "required": ["key"]
    ]
)

func handlePressKey(_ params: [String: Any]) async throws -> Any {
    guard AXIsProcessTrusted() else {
        throw ToolError.permissionDenied("Accessibility permission is required for keyboard simulation.")
    }
    guard let key = params["key"] as? String else {
        throw ToolError.missingParameter("key")
    }

    let keyLower = key.lowercased()
    guard let keyCode = keyCodeMap[keyLower] else {
        throw ToolError.failed("Unknown key '\(key)'. Use a key name like 'return', 'escape', or a letter/digit.")
    }

    let modifiers  = params["modifiers"] as? [String] ?? []
    var flags: CGEventFlags = []
    for mod in modifiers {
        switch mod.lowercased() {
        case "command", "cmd":   flags.insert(.maskCommand)
        case "shift":            flags.insert(.maskShift)
        case "option", "alt":    flags.insert(.maskAlternate)
        case "control", "ctrl":  flags.insert(.maskControl)
        default: break
        }
    }

    let src  = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true)
    let up   = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false)
    down?.flags = flags
    up?.flags   = flags
    down?.post(tap: .cghidEventTap)
    try await Task.sleep(nanoseconds: 50_000_000)
    up?.post(tap: .cghidEventTap)

    return ["pressed": key, "modifiers": modifiers]
}
