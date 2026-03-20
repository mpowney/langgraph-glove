import type { LogEntry } from "./LogEntry";
import type { LogSubscriber } from "./LogSubscriber";

/**
 * Central singleton that receives log entries from all {@link Logger} instances
 * and dispatches them to registered {@link LogSubscriber}s.
 *
 * **No output is produced until at least one subscriber is added.**  This lets
 * library code freely create `Logger` instances without incurring any I/O
 * overhead when the consumer has not configured logging.
 *
 * @example Configure once at application startup
 * ```ts
 * import { LogService, ConsoleSubscriber, FileSubscriber, LogLevel } from "@langgraph-glove/core";
 *
 * LogService.subscribe(new ConsoleSubscriber(LogLevel.INFO));
 * LogService.subscribe(new FileSubscriber(LogLevel.DEBUG));
 * ```
 */
export class LogService {
  private static readonly subscribers: LogSubscriber[] = [];

  private constructor() {}

  /**
   * Register a new subscriber.  Immediately begins receiving entries whose
   * level meets the subscriber's `minLevel`.
   *
   * @returns A disposal function — call it to remove the subscriber.
   */
  static subscribe(subscriber: LogSubscriber): () => void {
    LogService.subscribers.push(subscriber);
    return () => LogService.unsubscribe(subscriber);
  }

  /**
   * Remove a previously added subscriber and call its {@link LogSubscriber.close} hook.
   */
  static unsubscribe(subscriber: LogSubscriber): void {
    const idx = LogService.subscribers.indexOf(subscriber);
    if (idx !== -1) {
      LogService.subscribers.splice(idx, 1);
      subscriber.close();
    }
  }

  /** Remove all subscribers and close each one. */
  static clear(): void {
    for (const sub of LogService.subscribers) {
      sub.close();
    }
    LogService.subscribers.length = 0;
  }

  /**
   * Dispatch a log entry to every subscriber whose `minLevel` is satisfied.
   * Called internally by {@link Logger} — not intended for direct use.
   * @internal
   */
  static dispatch(entry: LogEntry): void {
    for (const subscriber of LogService.subscribers) {
      if (entry.level >= subscriber.minLevel) {
        try {
          subscriber.receive(entry);
        } catch {
          // Subscriber errors must never crash the calling code
        }
      }
    }
  }
}
