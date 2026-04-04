#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$ROOT_DIR/packages/tool-macos-control"
APP_NAME="MacOSControl"
APP_BUNDLE="$PKG_DIR/dist/${APP_NAME}.app"
OPEN_AFTER_BUILD="${1:-}"

cd "$PKG_DIR"

swift build -c release

mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cp "./.build/release/$APP_NAME" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
chmod +x "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

cat > "$APP_BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MacOSControl</string>
  <key>CFBundleDisplayName</key><string>MacOS Control</string>
  <key>CFBundleIdentifier</key><string>dev.langgraph.glove.macoscontrol</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>MacOSControl</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP_BUNDLE"

echo "Bundled app created at: $APP_BUNDLE"

if [[ "$OPEN_AFTER_BUILD" == "--open" ]]; then
  open "$APP_BUNDLE"
fi
