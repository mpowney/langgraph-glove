import AppKit
import CoreGraphics

let takeScreenshotMetadata = ToolMetadata(
    name: "macos_take_screenshot",
    description: "Capture the screen and return a base64-encoded image payload. Defaults to bounded high-quality JPEG output. Requires Screen Recording permission.",
    supportsContentUpload: true,
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
            "maxWidth": [
                "type": "integer",
                "description": "Maximum output width in pixels. Defaults to 1600."
            ] as [String: Any],
            "maxHeight": [
                "type": "integer",
                "description": "Maximum output height in pixels. Defaults to 1600."
            ] as [String: Any],
            "format": [
                "type": "string",
                "enum": ["jpeg", "png"],
                "description": "Output image format. Defaults to jpeg for smaller payloads."
            ] as [String: Any],
            "quality": [
                "type": "integer",
                "description": "JPEG quality from 1 to 100. Used only for jpeg. Defaults to 88."
            ] as [String: Any],
            "returnMode": [
                "type": "string",
                "enum": ["inline", "metadata"],
                "description": "When metadata, omit inline base64 data and return only image metadata. Defaults to inline."
            ] as [String: Any],
        ] as [String: Any],
        "required": [] as [String]
    ]
)

func handleTakeScreenshot(_ params: [String: Any]) async throws -> Any {
    let maxWidth = readBoundedInt(params["maxWidth"], fallback: 1600, name: "maxWidth")
    let maxHeight = readBoundedInt(params["maxHeight"], fallback: 1600, name: "maxHeight")
    let format = readFormat(params["format"])
    let quality = readBoundedInt(params["quality"], fallback: 88, name: "quality", min: 1, max: 100)
    let returnMode = readReturnMode(params["returnMode"])

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

    let inputRep = NSBitmapImageRep(cgImage: cgImage)
    let outputRep = try resizedBitmapRep(inputRep, maxWidth: maxWidth, maxHeight: maxHeight)

    let imageData: Data
    switch format {
    case "png":
        guard let pngData = outputRep.representation(using: .png, properties: [:]) else {
            throw ToolError.failed("Failed to encode screenshot as PNG")
        }
        imageData = pngData
    case "jpeg":
        let compression = max(0.01, min(1.0, Double(quality) / 100.0))
        guard let jpegData = outputRep.representation(
            using: .jpeg,
            properties: [.compressionFactor: compression]
        ) else {
            throw ToolError.failed("Failed to encode screenshot as JPEG")
        }
        imageData = jpegData
    default:
        throw ToolError.failed("Unsupported screenshot format: \(format)")
    }

    var payload: [String: Any] = [
        "format": format,
        "encoding": "base64",
        "width": outputRep.pixelsWide,
        "height": outputRep.pixelsHigh,
        "bytes": imageData.count,
    ]

    if returnMode == "inline" {
        payload["data"] = imageData.base64EncodedString()
    }

    return payload
}

// MARK: - Helpers

private func readBoundedInt(
    _ value: Any?,
    fallback: Int,
    name: String,
    min: Int = 1,
    max: Int = 10_000
) -> Int {
    guard let value else { return fallback }
    if let number = value as? NSNumber {
        let intValue = number.intValue
        if intValue >= min && intValue <= max { return intValue }
    }
    return fallback
}

private func readFormat(_ value: Any?) -> String {
    guard let raw = value as? String else { return "jpeg" }
    let normalized = raw.lowercased()
    if normalized == "jpeg" || normalized == "png" { return normalized }
    return "jpeg"
}

private func readReturnMode(_ value: Any?) -> String {
    guard let raw = value as? String else { return "inline" }
    let normalized = raw.lowercased()
    if normalized == "metadata" || normalized == "inline" { return normalized }
    return "inline"
}

private func resizedBitmapRep(
    _ source: NSBitmapImageRep,
    maxWidth: Int,
    maxHeight: Int
) throws -> NSBitmapImageRep {
    let width = source.pixelsWide
    let height = source.pixelsHigh

    if width <= maxWidth && height <= maxHeight {
        return source
    }

    let widthScale = Double(maxWidth) / Double(width)
    let heightScale = Double(maxHeight) / Double(height)
    let scale = min(widthScale, heightScale)
    let targetWidth = max(1, Int(Double(width) * scale))
    let targetHeight = max(1, Int(Double(height) * scale))

    guard let target = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: targetWidth,
        pixelsHigh: targetHeight,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw ToolError.failed("Failed to allocate resized screenshot buffer")
    }

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }

    guard let context = NSGraphicsContext(bitmapImageRep: target) else {
        throw ToolError.failed("Failed to create graphics context for resized screenshot")
    }

    NSGraphicsContext.current = context
    context.imageInterpolation = .high

    guard let sourceCgImage = source.cgImage else {
        throw ToolError.failed("Failed to access screenshot image buffer")
    }

    let sourceImage = NSImage(cgImage: sourceCgImage, size: NSSize(width: width, height: height))
    sourceImage.draw(
        in: NSRect(x: 0, y: 0, width: targetWidth, height: targetHeight),
        from: NSRect(x: 0, y: 0, width: width, height: height),
        operation: .copy,
        fraction: 1.0
    )

    return target
}

private func connectedDisplays() -> [CGDirectDisplayID] {
    var displayCount: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &displayCount)
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
    CGGetActiveDisplayList(displayCount, &displays, &displayCount)
    return displays
}
