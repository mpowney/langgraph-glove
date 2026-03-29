// Agent
export { GloveAgent } from "./agent/index";
export type { AgentConfig } from "./agent/index";

// Persistence
export { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// LLM factory
export { createModel } from "./llm/createModel";
export type { CreateModelOptions, LlmProvider } from "./llm/createModel";

// Logging
export { Logger } from "./logging/Logger";
export { LogService } from "./logging/LogService";
export { LogLevel } from "./logging/LogLevel";
export { ConsoleSubscriber } from "./logging/ConsoleSubscriber";
export { FileSubscriber } from "./logging/FileSubscriber";
export { LogSubscriber } from "./logging/LogSubscriber";
export type { LogEntry } from "./logging/LogEntry";

// Channels
export { Channel } from "./channels/Channel";
export type { IncomingMessage, OutgoingMessage, MessageHandler } from "./channels/Channel";
export { CliChannel } from "./channels/CliChannel";
export { WebChannel } from "./channels/WebChannel";
export type { WebChannelConfig } from "./channels/WebChannel";
export { BlueBubblesChannel } from "./channels/BlueBubblesChannel";
export type { BlueBubblesChannelConfig } from "./channels/BlueBubblesChannel";

// RPC
export { RpcClient } from "./rpc/RpcClient";
export { UnixSocketRpcClient } from "./rpc/UnixSocketRpcClient";
export { HttpRpcClient } from "./rpc/HttpRpcClient";
export type { RpcRequest, RpcResponse, ToolMetadata } from "./rpc/RpcProtocol";

// Tools
export { RemoteTool } from "./tools/RemoteTool";
export type { RemoteToolConfig } from "./tools/RemoteTool";
