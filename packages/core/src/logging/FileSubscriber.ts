import fs from "node:fs";
import path from "node:path";
import { LogLevel } from "./LogLevel";
import { LOG_LEVEL_LABEL } from "./LogLevel";
import { LogSubscriber } from "./LogSubscriber";
import type { LogEntry } from "./LogEntry";

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 23);
}

/**
 * Appends plain-text log entries to a file, one line per entry.
 *
 * The log file path is resolved in the following order:
 * 1. The `filePath` constructor argument (if provided).
 * 2. The `LOG_FILE` environment variable.
 * 3. `./langgraph-glove.log` in the current working directory.
 *
 * The destination directory is created automatically if it does not exist.
 * The file is opened in append mode so restarts do not overwrite previous logs.
 *
 * @example
 * ```ts
 * import { LogService, FileSubscriber, LogLevel } from "@langgraph-glove/core";
 *
 * // Uses LOG_FILE env var or defaults to ./langgraph-glove.log
 * LogService.subscribe(new FileSubscriber(LogLevel.DEBUG));
 *
 * // Explicit path
 * LogService.subscribe(new FileSubscriber(LogLevel.VERBOSE, "/var/log/glove.log"));
 * ```
 */
export class FileSubscriber extends LogSubscriber {
  private readonly stream: fs.WriteStream;
  readonly filePath: string;

  constructor(minLevel: LogLevel = LogLevel.DEBUG, filePath?: string) {
    super(minLevel);

    this.filePath =
      filePath ??
      process.env["LOG_FILE"] ??
      path.join(process.cwd(), "langgraph-glove.log");

    // Ensure the parent directory exists
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    this.stream = fs.createWriteStream(this.filePath, { flags: "a", encoding: "utf8" });

    this.stream.on("error", (err) => {
      // Write errors must not crash the process — log to stderr as a last resort
      process.stderr.write(`[FileSubscriber] Write error: ${err.message}\n`);
    });
  }

  receive(entry: LogEntry): void {
    const ts = formatTimestamp(entry.timestamp);
    const label = LOG_LEVEL_LABEL[entry.level];
    const line = `${ts} ${label} [${entry.name}] ${entry.message}\n`;
    this.stream.write(line);
  }

  /** Flushes and closes the underlying write stream. */
  override close(): void {
    this.stream.end();
  }
}
