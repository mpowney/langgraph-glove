# langgraph-glove

A TypeScript pnpm monorepo that wraps [LangGraph](https://github.com/langchain-ai/langgraphjs) to deliver a config-driven, multi-agent conversational system with channel-based I/O — loosely inspired by the [OpenClaw](https://github.com/open-claw/openclaw) architecture.

Requires **Node.js 22+** (pinned via `.nvmrc`).

---

## Packages

| Package | Description |
|---|---|
| `@langgraph-glove/core` | Agent runtime, graph builders, channel base class, RPC clients, `RemoteTool` |
| `@langgraph-glove/config` | Config loading, secret management, Zod schemas, `ModelRegistry` |
| `@langgraph-glove/gateway` | Lifecycle management — config → tools → agent → channels → health → shutdown |
| `@langgraph-glove/channel-telegram` | Telegram channel (grammY, long polling) |
| `@langgraph-glove/tool-server` | Abstract tool server + Unix socket / HTTP implementations |
| `@langgraph-glove/tool-weather-au` | Mock Australian weather tools (HTTP or Unix socket) |
| `@langgraph-glove/tool-weather-eu` | Mock European weather tools (HTTP or Unix socket) |
| `@langgraph-glove/tool-weather-us` | Mock US weather tools (HTTP or Unix socket) |

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
# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Running via the Gateway (recommended)

The gateway handles the full lifecycle: config loading, tool discovery, agent creation, and graceful shutdown.

```bash
# Start tool servers first (each in its own terminal)
cd packages/tool-weather-au && RPC_MODE=http PORT=3001 node dist/main.js
cd packages/tool-weather-eu && RPC_MODE=http PORT=3002 node dist/main.js
cd packages/tool-weather-us && node dist/main.js   # Unix socket mode

# Start the gateway
node packages/gateway/dist/main.js
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

# Terminal 1 — Australian weather tool (HTTP on port 3001)
cd packages/tool-weather-au
RPC_MODE=http PORT=3001 node dist/main.js

# Terminal 2 — European weather tool (HTTP on port 3002)
cd packages/tool-weather-eu
RPC_MODE=http PORT=3002 node dist/main.js

# Terminal 3 — US weather tool (Unix socket)
cd packages/tool-weather-us
node dist/main.js
# Listens on /tmp/langgraph-glove-weather_us.sock
```

You can test tool servers directly with curl:

```bash
# List available tools
curl -s http://localhost:3001 -d '{"method":"listTools","params":{}}'

# Call a specific tool
curl -s http://localhost:3001 -d '{"method":"callTool","params":{"name":"weather_au","input":{"location":"Sydney"}}}'
```

### Running the examples

The `core` package includes standalone examples that wire up tools and agent manually (useful for development without the full gateway):

```bash
# CLI only — interactive terminal chat
cd packages/core
node dist/examples/cli.js

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

```typescript
// src/main.ts
import { HttpToolServer } from "@langgraph-glove/tool-server";

const server = new HttpToolServer(3003);

server.register(
  { name: "my_tool", description: "Does something useful", parameters: {} },
  async (params) => `Result for ${JSON.stringify(params)}`,
);

await server.start();
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

And optionally scope it to a specific agent in `config/agents.json`:

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
| `RPC_MODE` | tool servers | `http` or `unix` (default: `http`) |
| `PORT` | tool servers | HTTP tool server port |
