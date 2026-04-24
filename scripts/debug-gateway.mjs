#!/usr/bin/env node

import { spawnSync, spawn } from "node:child_process";

const DEBUG_PORT = 9229;
const CANDIDATE_APP_PORTS = [8080, 8081, 9090];
const PROJECT_MARKER = "langgraph-glove";
const forwardedArgs = process.argv.slice(2);

function runCommand(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listListeningPids(port) {
  const result = runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function readProcessCommand(pid) {
  const result = runCommand("ps", ["-o", "command=", "-p", String(pid)]);
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function processExists(pid) {
  const result = runCommand("kill", ["-0", String(pid)]);
  return result.status === 0;
}

function terminateProcess(pid) {
  const term = runCommand("kill", ["-TERM", String(pid)]);
  if (term.status !== 0 && processExists(pid)) {
    throw new Error(`failed to send SIGTERM to pid ${pid}`);
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
  }

  const kill = runCommand("kill", ["-KILL", String(pid)]);
  if (kill.status !== 0 && processExists(pid)) {
    throw new Error(`failed to SIGKILL pid ${pid}`);
  }
}

function shouldReap(pid, command) {
  if (!command) return false;
  if (!command.includes(PROJECT_MARKER)) return false;
  return command.includes("node") || command.includes("tsx");
}

function cleanPorts() {
  const ports = [DEBUG_PORT, ...CANDIDATE_APP_PORTS];

  for (const port of ports) {
    const pids = listListeningPids(port);
    if (pids.length === 0) continue;

    for (const pid of pids) {
      const command = readProcessCommand(pid);
      if (!shouldReap(pid, command)) {
        console.error(
          `[debug] port ${port} is in use by pid ${pid} (${command || "unknown"}). Stop it manually or change ports.`,
        );
        process.exit(1);
      }

      console.warn(`[debug] reclaiming stale listener on port ${port} from pid ${pid}`);
      terminateProcess(pid);
    }
  }
}

cleanPorts();

const child = spawn(
  process.execPath,
  [
    `--inspect=127.0.0.1:${DEBUG_PORT}`,
    "--import",
    "tsx",
    "packages/core/src/main.ts",
    ...forwardedArgs,
  ],
  {
    stdio: "inherit",
    env: process.env,
  },
);

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error("[debug] failed to start gateway:", err.message);
  process.exit(1);
});