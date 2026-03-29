/**
 * Production entry point for the langgraph-glove gateway.
 *
 * Loads config from the paths set via environment variables (or sensible
 * defaults), creates the gateway, and starts it.
 *
 * Environment variables:
 *   GLOVE_CONFIG_DIR   — path to config directory  (default: ./config)
 *   GLOVE_SECRETS_DIR  — path to secrets directory  (default: ./secrets)
 *
 * Usage:
 *   node dist/main.js
 */

import path from "node:path";
import { Gateway } from "./Gateway.js";
import { LogService, ConsoleSubscriber, FileSubscriber, LogLevel, CliChannel } from "@langgraph-glove/core";

// ---------------------------------------------------------------------------
// Logging — set up before anything else
// ---------------------------------------------------------------------------

const logLevel = (process.env["LOG_LEVEL"] ?? "INFO").toUpperCase();
const level = LogLevel[logLevel as keyof typeof LogLevel] ?? LogLevel.INFO;

LogService.subscribe(new ConsoleSubscriber(level));

if (process.env["LOG_FILE"]) {
  LogService.subscribe(new FileSubscriber(LogLevel.DEBUG));
}

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

const configDir = path.resolve(process.env["GLOVE_CONFIG_DIR"] ?? "config");
const secretsDir = path.resolve(process.env["GLOVE_SECRETS_DIR"] ?? "secrets");

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

const gateway = new Gateway({
  configDir,
  secretsDir,
  channels: [new CliChannel()],
});

await gateway.start();
