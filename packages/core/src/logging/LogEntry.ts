import type { LogLevel } from "./LogLevel";

/** A single log event dispatched to all registered subscribers. */
export interface LogEntry {
  /** Wall-clock time when the entry was created. */
  timestamp: Date;
  /** Severity of the message. */
  level: LogLevel;
  /** Name passed to the {@link Logger} constructor — typically the source file name. */
  name: string;
  /** The log message text. */
  message: string;
}
