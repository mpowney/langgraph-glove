import { LogLevel } from "./LogLevel";
import type { LogEntry } from "./LogEntry";

/**
 * Abstract base class for log subscribers.
 *
 * A subscriber receives every {@link LogEntry} that is at or above its
 * configured `minLevel` and writes it to some output (console, file, etc.).
 *
 * Register a subscriber with {@link LogService.subscribe}.
 *
 * @example
 * ```ts
 * LogService.subscribe(new ConsoleSubscriber(LogLevel.INFO));
 * LogService.subscribe(new FileSubscriber(LogLevel.DEBUG));
 * ```
 */
export abstract class LogSubscriber {
  constructor(readonly minLevel: LogLevel = LogLevel.INFO) {}

  /**
   * Called by {@link LogService} for every entry whose level ≥ `minLevel`.
   * Implementations must not throw — errors in subscribers are silently swallowed.
   */
  abstract receive(entry: LogEntry): void;

  /**
   * Optional cleanup hook called when the subscriber is removed or the
   * process exits (e.g. to flush and close a file stream).
   */
  close(): void {}
}
