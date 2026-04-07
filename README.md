# langgraph-glove

A TypeScript pnpm monorepo that wraps [LangGraph](https://github.com/langchain-ai/langgraphjs) to deliver a config-driven, multi-agent conversational system with channel-based I/O — loosely inspired by the [OpenClaw](https://github.com/open-claw/openclaw) architecture.

Requires **Node.js 22+** (pinned via `.nvmrc`).

---

## Packages

| Package | Description |
|---|---|
| `@langgraph-glove/core` | Agent runtime, gateway lifecycle, graph builders, channels, RPC clients, `RemoteTool` |
| `@langgraph-glove/config` | Config loading, secret management, Zod schemas, `ModelRegistry` |
| `@langgraph-glove/ui-web` | React + Fluent UI v9 chat SPA served by `WebChannel` |
| `@langgraph-glove/channel-telegram` | Telegram channel (grammY, long polling) |
| `@langgraph-glove/tool-server` | Abstract tool server + Unix socket / HTTP implementations |
| `@langgraph-glove/tool-weather-au` | Mock Australian weather tools (HTTP or Unix socket) |
| `@langgraph-glove/tool-weather-eu` | Mock European weather tools (HTTP or Unix socket) |
| `@langgraph-glove/tool-weather-us` | Mock US weather tools (HTTP or Unix socket) |
| `tool-macos-control` *(Swift, macOS only)* | macOS UI-control tool server — accessibility, click, type, screenshot |

---

## Architecture

### Single-Agent Mode

When `agents.json` contains only a `"default"` entry, the gateway creates a standard ReAct loop:

```
START → agent → [tools] → agent → END
```

### Multi-Agent Orchestrator Mode

When `agents.json` contains additional entries beyond `"default"`, the gateway automatically builds an orchestrator graph. The `"default"` entry becomes the orchestrator; all other entries become sub-agents:

```
                          ┌─────────────────┐
                          │   orchestrator   │
                     ┌────┤ (default agent)  ├────┐
                     │    └──┬──────────┬────┘    │
                     │       │          │         │
              ┌──────▼──┐ ┌──▼───────┐ ┌▼────────▼──┐
              │weather-au│ │weather-eu│ │ weather-us  │
              │(subgraph)│ │(subgraph)│ │ (subgraph)  │
              └──────┬───┘ └──┬───────┘ └─────┬───────┘
                     │        │               │
                     └────────┴───────┬───────┘
                                      │
                              back to orchestrator
```

The orchestrator receives auto-generated `transfer_to_<name>` handoff tools for each sub-agent. It decides when to delegate based on the sub-agent's `description` field. Sub-agents execute their own ReAct loops with scoped tools and return control to the orchestrator.

### Full System

```
┌──────────────────────────────────────────────────┐
│                   Gateway                        │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │CliChannel│  │WebChannel│  │  Telegram     │   │
│  │(streaming)│ │(streaming)│  │  Channel      │   │
│  └──────────┘  └──────────┘  └──────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │      GloveAgent (runtime wrapper)        │    │
│  │                                          │    │
│  │  ┌──────────────────────────────────┐    │    │
│  │  │  LangGraph StateGraph            │    │    │
│  │  │  (single-agent or orchestrator)  │    │    │
│  │  └──────────────────────────────────┘    │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  RemoteTool  ←─── RpcClient (abstract)   │    │
│  │                    │           │          │    │
│  │         UnixSocket │    HTTP   │          │    │
│  └────────────────────┼───────────┼──────────┘    │
│                       │           │               │
│  SQLite persistence   │   Health /health :9090    │
└───────────────────────┼───────────┼───────────────┘
                        │           │
               ┌────────▼──┐  ┌─────▼──────┐
               │Unix Socket│  │HTTP Server │
               │ToolServer │  │ToolServer  │
               └─────┬─────┘  └─────┬──────┘
                     │               │
               ┌─────▼───────────────▼──────┐
               │  tool-weather-au / eu / us │
               │  (or any tool package)     │
               └────────────────────────────┘
```

---

## Configuration

All configuration lives in the `config/` directory as JSON files. Secrets are stored separately in `secrets/` and referenced via `{SECRET:name}` placeholders.

### secrets/secrets.json 

Defines the secrets used in other config files.  Note - all files in the secrets folder are parsed for secret key values.

```json
{
    "ollama-host": "http://localhost:11434",
    "anthropic-key": "sk-xxx",
    "openai-key": "sk-xxx"
}
```


### `config/models.json` (required)

Defines LLM provider profiles. Must contain a `"default"` key. Additional keys are named profiles that other agents can reference via `modelKey`.

```json
{
  "default": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKey": "{SECRET:openai-key}",
    "temperature": 0
  },
  "powerful": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "apiKey": "{SECRET:anthropic-key}"
  },
  "local": {
    "provider": "ollama",
    "model": "qwen2.5:7b",
    "baseUrl": "http://localhost:11434"
  }
}
```

Supported providers: `openai`, `anthropic`, `google`, `ollama`, `openai-compatible`.

### `config/agents.json` (optional)

Defines agents. If only `"default"` is present, the system runs in single-agent mode. Additional entries create sub-agents with an orchestrator.

Each non-default entry inherits from `"default"` (deep-merged), so you only need to specify overrides.

```json
{
  "default": {
    "modelKey": "default",
    "systemPrompt": "You are a helpful assistant that coordinates between specialised sub-agents.",
    "description": "Orchestrator that routes requests to specialised agents"
  },
  "weather-au": {
    "description": "Australian weather forecasts and conditions",
    "systemPrompt": "You are an Australian weather specialist.",
    "tools": ["weather_au", "rain_forecast_au"]
  },
  "weather-eu": {
    "description": "European weather forecasts and conditions",
    "tools": ["weather_eu"]
  }
}
```

| Field | Description |
|---|---|
| `modelKey` | Key from `models.json` (defaults to `"default"`) |
| `systemPrompt` | System message prepended to each model call |
| `description` | Used by the orchestrator to decide when to delegate (required for sub-agents) |
| `tools` | Tool name allow-list. Empty/missing = all discovered tools |
| `recursionLimit` | Max ReAct loop steps (default: 25) |

### `config/channels.json` (optional)

Declares channel runtime settings. Secrets in channel settings are resolved via `{SECRET:name}` like all other config files.

```json
{
  "cli": {
    "enabled": true,
    "settings": {
      "receiveAll": false
    }
  },
  "web": {
    "enabled": true,
    "settings": {
      "host": "0.0.0.0",
      "port": 8080,
      "receiveAll": true
    }
  },
  "bluebubbles": {
    "enabled": false,
    "settings": {
      "serverUrl": "{SECRET:bluebubbles-server-url}",
      "password": "{SECRET:bluebubbles-password}",
      "webhookHost": "0.0.0.0",
      "webhookPort": 5001
    }
  }
}
```

`--web` starts the `web` entry, and `--bluebubbles` starts the `bluebubbles` entry.

### `config/tools.json` (optional)

Declares remote tool servers to connect to at startup.

```json
{
  "weather-au": {
    "transport": "http",
    "url": "http://localhost:3001"
  },
  "weather-us": {
    "transport": "unix-socket",
    "socketName": "weather_us"
  }
}
```

Transports: `http` (JSON-RPC over HTTP POST) or `unix-socket` (NDJSON over Unix domain socket at `/tmp/langgraph-glove-<socketName>.sock`).

Set `"enabled": false` on any entry to skip it.

### `config/gateway.json` (optional)

```json
{
  "healthPort": 9090,
  "healthHost": "0.0.0.0",
  "dbPath": "data/checkpoints.sqlite"
}
```

### `secrets/` directory

Place JSON files containing secrets here. All keys from all files are merged into a flat namespace.

```json
// secrets/api-keys.json
{
  "openai-key": "sk-...",
  "anthropic-key": "sk-ant-..."
}
```

Secret values are automatically redacted from all log output.

---

## Quick Start

```bash
npm i -g pnpm

# Install dependencies
pnpm install

# First-time setup for the browser tools
cd packages/tool-browse-session
npx playwright install
cd ../..

cd packages/tool-browse
npx playwright install
cd ../..

# Build all packages
pnpm build
```

### macOS Control Tool (Swift, optional)

`tool-macos-control` is a native Swift/SwiftUI app and is built separately from the Node.js packages above. It runs on **macOS 13 (Ventura) or later** and requires **Swift 5.9+**.

**Prerequisites:**
- **Command-line only:** Install Xcode Command Line Tools — `xcode-select --install` — which includes the Swift compiler and Swift Package Manager. No full Xcode install required.
- **Full Xcode:** Install [Xcode 15+](https://apps.apple.com/app/xcode/id497799835) from the Mac App Store (includes command-line tools).

#### Build, bundle, and run from the command line

```bash
cd packages/tool-macos-control

# Build and launch the control panel (debug):
swift run

# Release build only:
swift build -c release

# Run the pre-built binary:
.build/release/MacOSControl
```

#### Bundle as a macOS app (.app)

Create a standalone macOS application bundle with proper Info.plist and code signing:

```bash
# From the workspace root, bundle the app:
pnpm macos:bundle

# Bundle and open in Finder:
pnpm macos:bundle:open

# Or manually from packages/tool-macos-control:
bash ../../scripts/macos-bundle-control-app.sh --open
```

The bundled app is created at `packages/tool-macos-control/dist/MacOSControl.app` and can be launched via:
- **Finder:** Double-click the .app bundle
- **Terminal:** `open packages/tool-macos-control/dist/MacOSControl.app`
- **Direct invocation:** `packages/tool-macos-control/dist/MacOSControl.app/Contents/MacOS/MacOSControl`

#### Build and run with Xcode (alternative)

```bash
# Open the Swift package in Xcode from the repository root:
xed packages/tool-macos-control
```

In Xcode, select the **MacOSControl** scheme and **My Mac** destination, then press **⌘R** to build and launch.

After launching, grant **Accessibility** and **Screen Recording** permissions when prompted, then set `"enabled": true` on the `macos-control` entry in `config/tools.json`.

> See [`packages/tool-macos-control/README.md`](packages/tool-macos-control/README.md) for the full reference, including transport options (Unix socket / HTTP), available tools, and gateway config.



### Running via the Gateway (recommended)

The gateway handles the full lifecycle: config loading, tool discovery, agent creation, and graceful shutdown.

> **Important:** All gateway commands must be run from the **workspace root** (`/path/to/langgraph-glove`). The gateway resolves `config/`, `secrets/`, and `data/` relative to the current working directory. Running from a subdirectory will cause it to look in the wrong place.

```bash
# Start tool servers first (each in its own terminal)
# Transport and port are read from config/tools.json
node packages/tool-weather-au/dist/main.js
node packages/tool-weather-eu/dist/main.js
node packages/tool-weather-us/dist/main.js

# Start the gateway (CLI only)
pnpm start

# Start the gateway with the web UI on http://localhost:8080
pnpm start:web

# Start the gateway with the web UI only (no CLI input)
pnpm start:web-only

# Or invoke node directly (equivalent to pnpm start:web)
node packages/core/dist/main.js --web

# Start web + BlueBubbles (requires channels.json bluebubbles entry)
node packages/core/dist/main.js --web --bluebubbles
```

To override the config or data directories:

```bash
GLOVE_CONFIG_DIR=/custom/config GLOVE_SECRETS_DIR=/custom/secrets node packages/core/dist/main.js --web
```

Environment variables for the gateway:

| Variable | Description | Default |
|---|---|---|
| `GLOVE_CONFIG_DIR` | Path to config directory | `./config` |
| `GLOVE_SECRETS_DIR` | Path to secrets directory | `./secrets` |
| `LOG_LEVEL` | `DEBUG`, `INFO`, `WARN`, `ERROR` | `INFO` |
| `LOG_FILE` | Path to log file (enables file logging) | — |

### Running via Docker

```bash
# Make sure config/ and secrets/ directories are populated
docker compose up --build
```

The Docker image exposes port 9090 for the health endpoint and mounts `config/`, `secrets/`, and a `data/` volume for SQLite persistence.

---

## Development & Debugging

### Debug environment for tools

Start tool servers individually to test and debug them in isolation:

```bash
# Build everything first
pnpm build

# Each tool server reads its transport and address from config/tools.json
# Terminal 1 — Australian weather tool
node packages/tool-weather-au/dist/main.js

# Terminal 2 — European weather tool
node packages/tool-weather-eu/dist/main.js

# Terminal 3 — US weather tool
node packages/tool-weather-us/dist/main.js
```


Or start them all as background tasks

```bash
node packages/tool-weather-au/dist/main.js &
node packages/tool-weather-eu/dist/main.js &
node packages/tool-weather-us/dist/main.js & 
node packages/tool-search/dist/main.js &   
node packages/tool-browse/dist/main.js &
node packages/tool-browse-session/dist/main.js &

```

You can test tool servers directly with curl:

```bash
# List available tools
curl -s http://localhost:3001/rpc -H 'Content-Type: application/json' \
  -d '{"id":"1","method":"__introspect__","params":{}}'

# Call a specific tool
curl -s http://localhost:3001/rpc -H 'Content-Type: application/json' \
  -d '{"id":"2","method":"weather_au","params":{"location":"Sydney"}}'
```

### Debugging the gateway (TypeScript source)

The `debug:*` scripts run the gateway directly from TypeScript source using `tsx` — no build step required. They must be run from the **workspace root** so that `config/`, `secrets/`, and `data/` resolve correctly.

```bash
# From the workspace root:

# CLI only — debugger listens on ws://127.0.0.1:9229
pnpm debug

# CLI + Web UI on http://localhost:8080
LOG_FILE=logs/output.log LOG_LEVEL=VERBOSE pnpm debug:web

# Web UI only (no CLI) — useful for browser-only testing
pnpm debug:web-only
```

To override config or data paths:

```bash
GLOVE_CONFIG_DIR=/custom/config pnpm debug:web
```

To attach VS Code, add a launch configuration in `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "attach",
  "name": "Attach to gateway",
  "port": 9229,
  "skipFiles": ["<node_internals>/**"]
}
```

Then run one of the `debug:*` scripts and use **Run → Attach to Node Process** (or the launch config above) to connect. Breakpoints set in any `.ts` source file — including `Gateway.ts`, `main.ts`, and all `@langgraph-glove/*` packages — will be hit directly.

> **Note:** `tsx` is a `devDependency` of `@langgraph-glove/core` and is resolved through the pnpm workspace — no global install required.

---

### Web UI (ui-web)

The `WebChannel` serves a compiled React/Fluent UI v9 SPA from `packages/ui-web/dist/app/`. The package must be built before the web channel can start:

```bash
# One-off: build everything (ui-web is built first due to the workspace dep)
pnpm build
```

Open `http://localhost:8080` (or whichever port `WebChannel` is configured to use) once the gateway or an example is running.

#### Configuring app metadata in the header

Pass `appInfo` to `WebChannel` to show the app name and agent description:

```typescript
new WebChannel({
  port: 8080,
  appInfo: {
    name: "My Assistant",
    agentDescription: "Orchestrator that routes requests to specialised agents",
  },
})
```

#### Developing the UI with Vite hot-reload

Run the backend (gateway or example) and the Vite dev server in separate terminals:

```bash
# Terminal 1 — backend with WebChannel on port 8080
node packages/core/dist/main.js

# Terminal 2 — Vite dev server (hot-reload) on port 5173
VITE_WS_URL=ws://localhost:8080 pnpm --filter @langgraph-glove/ui-web dev
```

Then open `http://localhost:5173`. `VITE_WS_URL` tells the SPA where to connect its WebSocket; in production the SPA uses `ws://${location.host}` automatically.

---

### Running the examples

The `core` package includes standalone examples that wire up tools and agent manually (useful for development without the full gateway):

```bash
# CLI only — interactive terminal chat
node packages/core/dist/examples/cli.js

# CLI + Web UI — terminal chat + browser at http://localhost:8080
cd packages/core
WEB_PORT=8080 node dist/examples/cli-and-web.js
```

These examples load config from `config/` and secrets from `secrets/` relative to the project root. Tool server URLs can be overridden:

```bash
WEATHER_AU_URL=http://192.168.1.50:3001 node dist/examples/cli.js
```

> **Note:** The examples use `buildSingleAgentGraph` directly with the `"default"` agent entry. To use the multi-agent orchestrator, run via the gateway instead.

### Using Ollama (local models)

Add a `"local"` profile to `config/models.json`:

```json
{
  "local": {
    "provider": "ollama",
    "model": "qwen2.5:7b",
    "baseUrl": "http://localhost:11434"
  }
}
```

Then set `"modelKey": "local"` on any agent in `agents.json`, or set it on the `"default"` entry to use it everywhere.

---

## Channels

| Channel | Transport | Streaming | Package |
|---|---|---|---|
| `CliChannel` | stdin / stdout | ✅ | `@langgraph-glove/core` |
| `WebChannel` | HTTP + WebSocket | ✅ | `@langgraph-glove/core` |
| `BlueBubblesChannel` | REST API + webhooks | ❌ | `@langgraph-glove/core` |
| `TelegramChannel` | grammY (long polling) | ❌ | `@langgraph-glove/channel-telegram` |

### Adding a new Channel

```typescript
import { Channel, IncomingMessage, OutgoingMessage, MessageHandler } from "@langgraph-glove/core";

export class MyChannel extends Channel {
  readonly name = "my-channel";
  readonly supportsStreaming = false;

  private handler?: MessageHandler;

  async start(): Promise<void> { /* set up listener */ }
  async stop(): Promise<void>  { /* tear down */ }
  onMessage(handler: MessageHandler): void { this.handler = handler; }

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    // deliver msg.text to the user identified by msg.conversationId
  }
}
```

---

## Adding a Remote Tool Package

```bash
mkdir packages/my-tool && cd packages/my-tool
pnpm init
pnpm add @langgraph-glove/tool-server
```

Then add it to `config/tools.json`:

```json
{
  "my-tool": {
    "transport": "http",
    "url": "http://localhost:3003"
  }
}
```

Create the entry point using the config-driven launcher:

```typescript
// src/main.ts
import { launchToolServer } from "@langgraph-glove/tool-server";

await launchToolServer({
  toolKey: "my-tool",
  register(server) {
    server.register(
      { name: "my_tool", description: "Does something useful", parameters: {} },
      async (params) => `Result for ${JSON.stringify(params)}`,
    );
  },
});
```

The launcher reads transport, port, and host from `tools.json` automatically. Optionally scope the tool to a specific agent in `config/agents.json`:

```json
{
  "my-agent": {
    "tools": ["my_tool"],
    "description": "Handles my-tool requests"
  }
}
```

---

## Environment Variables

| Variable | Used by | Description |
|---|---|---|
| `GLOVE_CONFIG_DIR` | gateway | Path to config directory (default: `./config`) |
| `GLOVE_SECRETS_DIR` | gateway | Path to secrets directory (default: `./secrets`) |
| `LOG_LEVEL` | gateway | `DEBUG` / `INFO` / `WARN` / `ERROR` (default: `INFO`) |
| `LOG_FILE` | gateway, examples | Path to log file (enables file logging) |
| `WEATHER_AU_URL` | examples | Override AU tool server URL |
| `WEATHER_EU_URL` | examples | Override EU tool server URL |
| `WEB_PORT` | cli-and-web example | Web UI port (default: `8080`) |
| `WEB_HOST` | cli-and-web example | Web UI bind host (default: `0.0.0.0`) |
| `VITE_WS_URL` | ui-web dev server | WebSocket URL for the Vite dev server (e.g. `ws://localhost:8080`). Omit in production — the SPA defaults to `ws://${location.host}` |

