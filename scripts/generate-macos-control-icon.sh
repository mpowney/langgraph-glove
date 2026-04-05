#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/packages/tool-macos-control/Resources"
ICONSET_DIR="$OUT_DIR/AppIcon.iconset"
BASE_PNG="$OUT_DIR/AppIcon-1024.png"
LIGHT_PNG="$OUT_DIR/AppIcon-Light.png"
DARK_PNG="$OUT_DIR/AppIcon-Dark.png"
MENU_LIGHT_PNG="$OUT_DIR/MenuBarIcon-Light.png"
MENU_DARK_PNG="$OUT_DIR/MenuBarIcon-Dark.png"
ICNS_PATH="$OUT_DIR/AppIcon.icns"

mkdir -p "$OUT_DIR"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

cat > "$OUT_DIR/.gen_macos_control_icon.swift" <<'SWIFT'
import AppKit

let outputPath = CommandLine.arguments[1]
let mode = CommandLine.arguments[2].lowercased()
let isMenuVariant = CommandLine.arguments.count > 3 && CommandLine.arguments[3].lowercased() == "menu"
let size = NSSize(width: 1024, height: 1024)
let darkModeVariant = mode == "dark"

let image = NSImage(size: size)
image.lockFocus()

let rect = NSRect(origin: .zero, size: size)

// Neutral base with subtle depth.
let outerInset: CGFloat = isMenuVariant ? 88 : 56
let outerRadius: CGFloat = isMenuVariant ? 180 : 220
let rounded = NSBezierPath(roundedRect: rect.insetBy(dx: outerInset, dy: outerInset), xRadius: outerRadius, yRadius: outerRadius)
let gradient = NSGradient(
    starting: darkModeVariant
        ? NSColor(calibratedRed: 0.14, green: 0.17, blue: 0.22, alpha: 1.0)
        : NSColor(calibratedRed: 0.92, green: 0.95, blue: 0.98, alpha: 1.0),
    ending: darkModeVariant
        ? NSColor(calibratedRed: 0.09, green: 0.11, blue: 0.16, alpha: 1.0)
        : NSColor(calibratedRed: 0.78, green: 0.84, blue: 0.91, alpha: 1.0)
)!
gradient.draw(in: rounded, angle: -90)

NSColor(calibratedWhite: 1.0, alpha: darkModeVariant ? 0.14 : 0.32).setStroke()
rounded.lineWidth = isMenuVariant ? 8 : 10
rounded.stroke()

let surroundColor = darkModeVariant
    ? NSColor(calibratedWhite: 0.10, alpha: 0.94)
    : NSColor(calibratedWhite: 0.96, alpha: 0.96)
let screenColor = darkModeVariant
    ? NSColor(calibratedWhite: 0.95, alpha: 0.98)
    : NSColor(calibratedWhite: 0.16, alpha: 0.95)
let borderColor = darkModeVariant
    ? NSColor(calibratedWhite: 1.0, alpha: 0.18)
    : NSColor(calibratedWhite: 0.0, alpha: 0.18)

let windowRect = isMenuVariant
    ? NSRect(x: 210, y: 270, width: 604, height: 430)
    : NSRect(x: 190, y: 250, width: 644, height: 470)
let framePath = NSBezierPath(
    roundedRect: windowRect,
    xRadius: isMenuVariant ? 64 : 74,
    yRadius: isMenuVariant ? 64 : 74
)
surroundColor.setFill()
framePath.fill()
borderColor.setStroke()
framePath.lineWidth = 8
framePath.stroke()

let screenRect = windowRect.insetBy(dx: 44, dy: 52)
let screenOuter = NSBezierPath(
    roundedRect: screenRect,
    xRadius: isMenuVariant ? 34 : 42,
    yRadius: isMenuVariant ? 34 : 42
)

let stripThickness: CGFloat = isMenuVariant ? 18 : 22
let innerRect = screenRect.insetBy(dx: stripThickness, dy: stripThickness)
let screenInner = NSBezierPath(
    roundedRect: innerRect,
    xRadius: isMenuVariant ? 22 : 28,
    yRadius: isMenuVariant ? 22 : 28
)

let stripColors: [NSColor] = [
    NSColor(calibratedRed: 0.37, green: 0.78, blue: 1.00, alpha: 1.0),
    NSColor(calibratedRed: 0.34, green: 0.53, blue: 1.00, alpha: 1.0),
    NSColor(calibratedRed: 0.53, green: 0.40, blue: 0.98, alpha: 1.0),
    NSColor(calibratedRed: 0.95, green: 0.32, blue: 0.80, alpha: 1.0),
    NSColor(calibratedRed: 1.00, green: 0.49, blue: 0.46, alpha: 1.0),
    NSColor(calibratedRed: 1.00, green: 0.73, blue: 0.37, alpha: 1.0),
    NSColor(calibratedRed: 0.57, green: 0.88, blue: 0.49, alpha: 1.0),
    NSColor(calibratedRed: 0.35, green: 0.85, blue: 0.72, alpha: 1.0)
]

let stripPath = NSBezierPath()
stripPath.append(screenOuter)
stripPath.append(screenInner)
stripPath.windingRule = .evenOdd
stripPath.addClip()

let stripeWidth = screenRect.width / CGFloat(stripColors.count)
for (index, color) in stripColors.enumerated() {
    color.setFill()
    let stripeX = screenRect.minX + CGFloat(index) * stripeWidth - 40
    let stripeRect = NSRect(x: stripeX, y: screenRect.minY - 12, width: stripeWidth + 80, height: screenRect.height + 24)
    NSBezierPath(rect: stripeRect).fill()
}

let innerScreenPath = NSBezierPath(
    roundedRect: innerRect,
    xRadius: isMenuVariant ? 22 : 28,
    yRadius: isMenuVariant ? 22 : 28
)
screenColor.setFill()
innerScreenPath.fill()

image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let rep = NSBitmapImageRep(data: tiff),
    let png = rep.representation(using: .png, properties: [:])
else {
    fputs("Failed to render icon PNG.\n", stderr)
    exit(1)
}

try png.write(to: URL(fileURLWithPath: outputPath))
SWIFT

swift "$OUT_DIR/.gen_macos_control_icon.swift" "$LIGHT_PNG" light
swift "$OUT_DIR/.gen_macos_control_icon.swift" "$DARK_PNG" dark
swift "$OUT_DIR/.gen_macos_control_icon.swift" "$MENU_LIGHT_PNG" light menu
swift "$OUT_DIR/.gen_macos_control_icon.swift" "$MENU_DARK_PNG" dark menu

# Use light variant as the static bundle icon baseline.
cp "$LIGHT_PNG" "$BASE_PNG"
rm -f "$OUT_DIR/.gen_macos_control_icon.swift"

# Required iconset members.
sips -z 16 16 "$BASE_PNG" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$BASE_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$BASE_PNG" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$BASE_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$BASE_PNG" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$BASE_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$BASE_PNG" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$BASE_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$BASE_PNG" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
cp "$BASE_PNG" "$ICONSET_DIR/icon_512x512@2x.png"

iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"

echo "Generated: $ICNS_PATH"
