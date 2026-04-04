# tool-macos-control

A Swift / SwiftUI macOS tool server for the **langgraph-glove** monorepo.  
It exposes macOS accessibility and UI-control capabilities using the same JSON-RPC protocol and transport options (Unix socket **and** HTTP) as all other tool packages in this repo.

---

## Requirements

| Requirement | Version |
|---|---|
| macOS | 13 (Ventura) or later |
| Swift | 5.9 or later (included with Xcode 15+) |
| Swift Package Manager | bundled with Swift |

> This package is **macOS-only** and is intentionally excluded from the cross-platform Node/TypeScript build pipeline.

---

## Building

### Command-line (Swift Package Manager)

```bash
cd packages/tool-macos-control
swift build -c release
```

The compiled binary is written to `.build/release/MacOSControl`.

### Xcode

1. **Prerequisites** — Xcode 15 or later (ships with Swift 5.9+). Install from the [Mac App Store](https://apps.apple.com/app/xcode/id497799835) or via `xcode-select --install` for command-line tools only.

2. **Open the package in Xcode** — from the repository root:
   ```bash
   xed packages/tool-macos-control
   ```
   Alternatively, launch Xcode and choose **File → Open…**, then select `packages/tool-macos-control/Package.swift`.

3. **Wait for dependency resolution** — Xcode resolves the Swift Package Manager manifest automatically on first open (this package has no external dependencies, so it's instant).

4. **Select scheme and destination** — in the toolbar, choose the **MacOSControl** scheme and **My Mac** as the destination.

5. **Build** — press **⌘B** (or **Product → Build**).

6. **Run** — press **⌘R** (or **Product → Run**) to build and launch the control panel in one step.

7. **Release archive** — use **Product → Archive** to produce a signed `.app` bundle for distribution.

> **Tip:** You can also build from the command line using Xcode's toolchain:
> ```bash
> xcodebuild -scheme MacOSControl -configuration Release build
> ```

---

## Running

```bash
swift run
```

or run the pre-built binary:

```bash
.build/release/MacOSControl
```

The app opens a **control panel** window where you can:

1. **Grant permissions** — Accessibility (required for all UI interaction tools) and Screen Recording (required for `macos_take_screenshot`).
2. **Choose transport** — Unix socket (default, matches the other tools) or HTTP.
3. **Configure** — socket name or TCP port depending on the transport.
4. **Start / stop the server** — The server starts automatically on launch.

---

## Permissions

macOS requires explicit user consent before an application can:

| Permission | Required by |
|---|---|
| **Accessibility** | `macos_get_ui_tree`, `macos_find_element`, `macos_get_focused_element`, `macos_click`, `macos_type_text`, `macos_press_key`, `macos_scroll` |
| **Screen Recording** | `macos_take_screenshot` |

After launching, open **System Settings → Privacy & Security** and enable the app in both **Accessibility** and **Screen Recording**.  
The control panel shows the current status and has buttons to open the relevant Settings pane.

---

## Transports

### Unix socket (default)

Communicates via **newline-delimited JSON (NDJSON)** over a Unix domain socket — identical to every other local tool in the monorepo.

- Socket path: `/tmp/langgraph-glove-{socketName}.sock`  (default: `/tmp/langgraph-glove-macos-control.sock`)
- Protocol matches `UnixSocketToolServer` / `UnixSocketRpcClient` in TypeScript

### HTTP

Provides an HTTP/1.1 JSON-RPC server on a configurable TCP port (default `3020`).

| Method | Path | Description |
|---|---|---|
| `POST` | `/rpc` | Invoke a tool via JSON-RPC 2.0 |
| `GET` | `/tools` | List all registered tools and their JSON Schemas |
| `GET` | `/health` | Health check (`{"status":"ok"}`) |

### Wire protocol (both transports)

```json
// Request
{ "id": "unique-request-id", "method": "macos_click", "params": { "x": 640, "y": 400 } }

// Response
{ "id": "unique-request-id", "result": { "clicked": true, "x": 640, "y": 400, "button": "left" } }
```

---

## Available Tools

| Tool | Description |
|---|---|
| `macos_get_frontmost_app` | Name, bundle ID and PID of the current frontmost app |
| `macos_list_running_apps` | All running applications |
| `macos_launch_app` | Launch an app by bundle ID or display name |
| `macos_get_ui_tree` | Full accessibility element tree of the frontmost (or specified) app |
| `macos_find_element` | Search the accessibility tree by role / title / value / description |
| `macos_get_focused_element` | Details of the currently keyboard-focused element |
| `macos_click` | Left-click, right-click or double-click at screen coordinates |
| `macos_type_text` | Type a text string via keyboard simulation |
| `macos_press_key` | Press a key or keyboard shortcut (e.g. `⌘C`, `Escape`, `Return`) |
| `macos_scroll` | Scroll at screen coordinates |
| `macos_take_screenshot` | Capture the screen as a base64 PNG |

---

## Connecting to the gateway

The entry is already present in `config/tools.json` (disabled by default since this is macOS-only):

```json
"macos-control": {
  "transport": "unix-socket",
  "socketName": "macos-control",
  "enabled": false
}
```

To activate, set `"enabled": true`.  To use HTTP instead:

```json
"macos-control": {
  "transport": "http",
  "url": "http://localhost:3020",
  "enabled": true
}
```

The sample `macos` agent in `config/agents.json` is already configured with all 11 tools.

---

## Architecture

```
MacOSControlApp (@main, SwiftUI)
│
├── AppState (ObservableObject)
│   ├── Permission management (AXIsProcessTrusted, CGPreflightScreenCaptureAccess)
│   ├── RpcTransport enum (.http | .unixSocket)
│   └── RpcServer / UnixSocketRpcServer lifecycle
│
├── SwiftUI Views
│   ├── ContentView          — top-level layout
│   ├── PermissionsView      — permission status rows + request buttons
│   └── ServerStatusView     — transport picker, config, start/stop
│
├── RpcServer  (Network.framework NWListener — HTTP/1.1)
│   ├── POST /rpc   — JSON-RPC dispatch via ToolRegistry
│   ├── GET /tools  — metadata introspection
│   └── GET /health — health check
│
├── UnixSocketRpcServer  (POSIX socket — NDJSON)
│   └── Mirrors TypeScript UnixSocketToolServer
│       Socket path: /tmp/langgraph-glove-{name}.sock
│
├── ToolRegistry — metadata + handler store (mirrors TypeScript tool-server)
│
└── Tools
    ├── GetFrontmostAppTool   macos_get_frontmost_app
    ├── ListRunningAppsTool   macos_list_running_apps
    ├── LaunchAppTool         macos_launch_app
    ├── GetUITreeTool         macos_get_ui_tree
    ├── FindElementTool       macos_find_element
    ├── GetFocusedElementTool macos_get_focused_element
    ├── ClickTool             macos_click
    ├── TypeTextTool          macos_type_text
    ├── PressKeyTool          macos_press_key
    ├── ScrollTool            macos_scroll
    └── TakeScreenshotTool    macos_take_screenshot
```
