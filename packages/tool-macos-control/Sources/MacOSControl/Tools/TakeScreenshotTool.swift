import AppKit
import CoreGraphics

let takeScreenshotMetadata = ToolMetadata(
    name: "macos_take_screenshot",
    description: "Capture the screen and return the image as a base64-encoded PNG string. Requires Screen Recording permission.",
    parameters: [
        "type": "object",
        "properties": [
            "display": [
                "type": "integer",
                "description": "Display index to capture (0 = main/primary display, default: 0)."
            ] as [String: Any],
            "region": [
                "type": "object",
                "description": "Optional region to capture instead of the full display.",
                "properties": [
                    "x":      ["type": "number"],
                    "y":      ["type": "number"],
                    "width":  ["type": "number"],
                    "height": ["type": "number"],
                ] as [String: Any],
            ] as [String: Any],
        ] as [String: Any],
        "required": [] as [String]
    ]
)

func handleTakeScreenshot(_ params: [String: Any]) async throws -> Any {
    // Determine capture rect.
    var captureRect: CGRect

    if let regionDict = params["region"] as? [String: Any],
       let rx = (regionDict["x"] as? NSNumber)?.doubleValue,
       let ry = (regionDict["y"] as? NSNumber)?.doubleValue,
       let rw = (regionDict["width"] as? NSNumber)?.doubleValue,
       let rh = (regionDict["height"] as? NSNumber)?.doubleValue {
        captureRect = CGRect(x: rx, y: ry, width: rw, height: rh)
    } else {
        let displays = connectedDisplays()
        let displayIndex = params["display"] as? Int ?? 0
        guard displayIndex < displays.count else {
            throw ToolError.failed("Display index \(displayIndex) is out of range (\(displays.count) display(s) connected)")
        }
        captureRect = CGDisplayBounds(displays[displayIndex])
    }

    guard let cgImage = CGWindowListCreateImage(
        captureRect,
        .optionOnScreenOnly,
        kCGNullWindowID,
        [.bestResolution, .boundsIgnoreFraming]
    ) else {
        throw ToolError.failed("Failed to capture screen. Ensure Screen Recording permission is granted in System Settings → Privacy & Security → Screen Recording.")
    }

    let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
    guard let pngData = bitmapRep.representation(using: .png, properties: [:]) else {
        throw ToolError.failed("Failed to encode screenshot as PNG")
    }

    return [
        "format": "png",
        "encoding": "base64",
        "width":  cgImage.width,
        "height": cgImage.height,
        "data":   pngData.base64EncodedString(),
    ] as [String: Any]
}

// MARK: - Helpers

private func connectedDisplays() -> [CGDirectDisplayID] {
    var displayCount: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &displayCount)
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
    CGGetActiveDisplayList(displayCount, &displays, &displayCount)
    return displays
}
