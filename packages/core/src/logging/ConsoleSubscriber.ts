import { LogLevel } from "./LogLevel";
import { LOG_LEVEL_LABEL } from "./LogLevel";
import { LogSubscriber } from "./LogSubscriber";
import type { LogEntry } from "./LogEntry";

/** ANSI colour codes used by {@link ConsoleSubscriber}. */
const ANSI = {
  reset: "\x1b[0m",
  grey: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
} as const;

const LEVEL_COLOUR: Record<LogLevel, string> = {
  [LogLevel.VERBOSE]: ANSI.grey,
  [LogLevel.DEBUG]: ANSI.cyan,
  [LogLevel.INFO]: ANSI.green,
  [LogLevel.WARN]: ANSI.yellow,
  [LogLevel.ERROR]: ANSI.red + ANSI.bold,
};

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 23);
}

/**
 * Writes formatted, colourised log entries to `stdout` (VERBOSE..INFO) and
 * `stderr` (WARN..ERROR).
 *
 * Colour output is automatically suppressed when stdout/stderr is not a TTY
 * (e.g. when piped to a file or in CI environments).
 *
 * @example
 * ```ts
 * import { LogService, ConsoleSubscriber, LogLevel } from "@langgraph-glove/core";
 *
 * LogService.subscribe(new ConsoleSubscriber(LogLevel.INFO));
 * ```
 */
export class ConsoleSubscriber extends LogSubscriber {
  private readonly useColour: boolean;

  constructor(minLevel: LogLevel = LogLevel.INFO) {
    super(minLevel);
    this.useColour = process.stdout.isTTY === true;
  }

  receive(entry: LogEntry): void {
    const ts = formatTimestamp(entry.timestamp);
    const label = LOG_LEVEL_LABEL[entry.level];
    const colour = this.useColour ? LEVEL_COLOUR[entry.level] : "";
    const reset = this.useColour ? ANSI.reset : "";
    const namePart = this.useColour
      ? `${ANSI.grey}[${entry.name}]${ANSI.reset}`
      : `[${entry.name}]`;

    const line = `${ts} ${colour}${label}${reset} ${namePart} ${entry.message}`;

    if (entry.level >= LogLevel.WARN) {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}
