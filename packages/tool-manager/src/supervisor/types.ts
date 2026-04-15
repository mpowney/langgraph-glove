import type { ChildProcess } from "node:child_process";

export type ToolStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface ToolDescriptor {
  key: string;
  packageDir: string;
  packageName: string;
  command: string;
  logPath: string;
}

export interface ToolRuntimeState {
  tool: ToolDescriptor;
  status: ToolStatus;
  pid?: number;
  child?: ChildProcess;
  startedAt?: number;
  stoppedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  lastLine?: string;
  logs: string[];
}

export type ToolStatusListener = (state: ToolRuntimeState) => void;
export type ToolLogListener = (toolKey: string, line: string, stream: "stdout" | "stderr") => void;

export interface RuntimeFileEntry {
  toolKey: string;
  pid: number;
  logPath: string;
}
