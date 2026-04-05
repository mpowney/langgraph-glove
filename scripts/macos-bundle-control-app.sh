#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$ROOT_DIR/packages/tool-macos-control"
APP_NAME="MacOSControl"
APP_BUNDLE="$PKG_DIR/dist/${APP_NAME}.app"
ICON_PATH="$PKG_DIR/Resources/AppIcon.icns"
ICON_LIGHT_PATH="$PKG_DIR/Resources/AppIcon-Light.png"
ICON_DARK_PATH="$PKG_DIR/Resources/AppIcon-Dark.png"
MENU_ICON_LIGHT_PATH="$PKG_DIR/Resources/MenuBarIcon-Light.png"
MENU_ICON_DARK_PATH="$PKG_DIR/Resources/MenuBarIcon-Dark.png"
OPEN_AFTER_BUILD="${1:-}"

cd "$PKG_DIR"

swift build -c release

mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cp "./.build/release/$APP_NAME" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
chmod +x "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

if [[ -f "$ICON_PATH" ]]; then
  cp "$ICON_PATH" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
fi
if [[ -f "$ICON_LIGHT_PATH" ]]; then
  cp "$ICON_LIGHT_PATH" "$APP_BUNDLE/Contents/Resources/AppIcon-Light.png"
fi
if [[ -f "$ICON_DARK_PATH" ]]; then
  cp "$ICON_DARK_PATH" "$APP_BUNDLE/Contents/Resources/AppIcon-Dark.png"
fi
if [[ -f "$MENU_ICON_LIGHT_PATH" ]]; then
  cp "$MENU_ICON_LIGHT_PATH" "$APP_BUNDLE/Contents/Resources/MenuBarIcon-Light.png"
fi
if [[ -f "$MENU_ICON_DARK_PATH" ]]; then
  cp "$MENU_ICON_DARK_PATH" "$APP_BUNDLE/Contents/Resources/MenuBarIcon-Dark.png"
fi

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
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP_BUNDLE"

echo "Bundled app created at: $APP_BUNDLE"

if [[ "$OPEN_AFTER_BUILD" == "--open" ]]; then
  open "$APP_BUNDLE"
fi
