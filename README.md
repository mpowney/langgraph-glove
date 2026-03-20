# langgraph-glove

A TypeScript pnpm monorepo that wraps the [LangGraph](https://github.com/langchain-ai/langgraphjs) library to deliver a structured, channel-based conversational agent — Loosely inspired by the [openclaw](https://github.com/open-claw/openclaw) architecture.

## Usage with Ollama
```
# Local Ollama with default model
LLM_PROVIDER=ollama node dist/examples/cli.js

# Remote Ollama instance with a specific model
LLM_PROVIDER=ollama OLLAMA_URL=http://192.168.1.50:11434 OLLAMA_MODEL=qwen2.5:7b node dist/examples/cli.js
```

## Packages

| Package | Description |
|---|---|
| `@langgraph-glove/core` | Agent, abstract Channel base class, RPC clients (Unix socket + HTTP), and `RemoteTool` |
| `@langgraph-glove/tool-server` | Abstract tool server + Unix socket and HTTP server implementations |
| `@langgraph-glove/tool-example` | A worked example of a remote tool (weather) runnable via either transport |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 GloveAgent (core)               │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │CliChannel│  │WebChannel│  │BlueBubbles   │  │
│  │(streaming)│  │(streaming)│  │Channel       │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │           LangGraph StateGraph           │   │
│  │  START → agent → [tools] → agent → END  │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │  RemoteTool  ←─── RpcClient (abstract)  │   │
│  │                    │           │          │   │
│  │         UnixSocket │    HTTP   │          │   │
│  └────────────────────┼───────────┼──────────┘   │
└───────────────────────┼───────────┼──────────────┘
                        │           │
               ┌────────▼──┐  ┌─────▼──────┐
               │Unix Socket│  │HTTP Server │
               │ToolServer │  │ToolServer  │
               └─────┬─────┘  └─────┬──────┘
                     │               │
               ┌─────▼───────────────▼──────┐
               │     tool-example / any     │
               │     pnpm tool package      │
               └────────────────────────────┘
```

### Channels

Channels are the way users interact with the agent. Each channel extends the abstract `Channel` base class.

| Channel | Transport | Streaming |
|---|---|---|
| `CliChannel` | stdin / stdout | ✅ |
| `WebChannel` | HTTP + WebSocket | ✅ |
| `BlueBubblesChannel` | BlueBubbles REST API + webhooks | ❌ |

### Remote Tools & RPC

Remote tools run in separate pnpm packages (with their own dependencies) and communicate with the agent via RPC. Two transports are implemented and are swappable at runtime:

- **Unix socket** — low-latency, same-machine IPC via NDJSON over a Unix domain socket
- **HTTP** — simple JSON-RPC over HTTP POST, suitable for tools on remote hosts

The transport is selected by passing the appropriate `RpcClient` implementation to `RemoteTool`.

---

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start the example weather tool server (HTTP mode)
cd packages/tool-example
RPC_MODE=http PORT=3001 node dist/main.js

# In another terminal, run the agent using the CLI channel
cd packages/core
OPENAI_API_KEY=sk-... node dist/examples/cli.js
```

### Switching RPC transport

```typescript
import { UnixSocketRpcClient, HttpRpcClient, RemoteTool } from "@langgraph-glove/core";
import { z } from "zod";

// Choose transport at runtime
const rpcClient =
  process.env.RPC_MODE === "unix"
    ? new UnixSocketRpcClient(process.env.SOCKET_PATH ?? "/tmp/weather.sock")
    : new HttpRpcClient(`http://localhost:${process.env.TOOL_PORT ?? 3001}`);

await rpcClient.connect();

const weatherTool = new RemoteTool(rpcClient, {
  name: "weather",
  description: "Get the current weather for a location",
  schema: z.object({
    location: z.string().describe("City name or coordinates"),
    unit: z.enum(["celsius", "fahrenheit"]).optional(),
  }),
});
```

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

### Adding a new remote tool package

```bash
mkdir packages/my-tool
cd packages/my-tool
pnpm init
pnpm add @langgraph-glove/tool-server
```

```typescript
// src/main.ts
import { HttpToolServer } from "@langgraph-glove/tool-server";

const server = new HttpToolServer(3002);

server.register(
  { name: "my_tool", description: "Does something useful", parameters: {} },
  async (params) => `Result for ${JSON.stringify(params)}`,
);

await server.start();
```

---

## Environment Variables

| Variable | Used by | Description |
|---|---|---|
| `LLM_PROVIDER` | all agent examples | `openai` or `ollama` (default: `openai`) |
| `OPENAI_API_KEY` | agent examples (OpenAI) | OpenAI API key |
| `OPENAI_MODEL` | agent examples (OpenAI) | Model name (default: `gpt-4o-mini`) |
| `OLLAMA_URL` | agent examples (Ollama) | Ollama server URL (default: `http://localhost:11434`) |
| `OLLAMA_MODEL` | agent examples (Ollama) | Ollama model name (default: `llama3.2`) |
| `RPC_MODE` | tool-example, agent | `unix` or `http` (default: `http`) |
| `SOCKET_PATH` | Unix socket transport | Path to Unix domain socket |
| `PORT` | tool-example | HTTP tool server port (default: `3001`) |
| `TOOL_SERVER_URL` | agent examples | URL of the HTTP tool server |
| `BLUEBUBBLES_URL` | BlueBubblesChannel | BlueBubbles server URL |
| `BLUEBUBBLES_PASSWORD` | BlueBubblesChannel | BlueBubbles server password |
| `BLUEBUBBLES_WEBHOOK_PORT` | BlueBubblesChannel | Local port to receive webhooks |
| `WEB_PORT` | WebChannel | Port for the web UI (default: `8080`) |
