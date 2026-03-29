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
 * ## Secret redaction
 * Register secret values via {@link LogService.addRedactions} and every log
 * message will have those values replaced with `[REDACTED]` before any
 * subscriber sees the entry.
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
  private static readonly redactions: Set<string> = new Set();
  private static redactionPattern: RegExp | null = null;

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

  // ---------------------------------------------------------------------------
  // Secret redaction
  // ---------------------------------------------------------------------------

  /**
   * Register secret values that must be redacted from all log output.
   * Call once at startup after loading secrets.
   */
  static addRedactions(values: Iterable<string>): void {
    for (const v of values) {
      if (v.length > 0) LogService.redactions.add(v);
    }
    LogService.rebuildRedactionPattern();
  }

  /** Clear all registered redaction values. */
  static clearRedactions(): void {
    LogService.redactions.clear();
    LogService.redactionPattern = null;
  }

  private static rebuildRedactionPattern(): void {
    if (LogService.redactions.size === 0) {
      LogService.redactionPattern = null;
      return;
    }
    // Sort longest-first so longer secrets are matched before shorter substrings
    const escaped = [...LogService.redactions]
      .sort((a, b) => b.length - a.length)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    LogService.redactionPattern = new RegExp(escaped.join("|"), "g");
  }

  private static redact(message: string): string {
    if (!LogService.redactionPattern) return message;
    return message.replace(LogService.redactionPattern, "[REDACTED]");
  }

  /**
   * Dispatch a log entry to every subscriber whose `minLevel` is satisfied.
   * Called internally by {@link Logger} — not intended for direct use.
   * @internal
   */
  static dispatch(entry: LogEntry): void {
    const redacted: LogEntry = LogService.redactionPattern
      ? { ...entry, message: LogService.redact(entry.message) }
      : entry;

    for (const subscriber of LogService.subscribers) {
      if (redacted.level >= subscriber.minLevel) {
        try {
          subscriber.receive(redacted);
        } catch {
          // Subscriber errors must never crash the calling code
        }
      }
    }
  }
}
