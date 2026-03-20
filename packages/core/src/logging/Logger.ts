import { LogLevel } from "./LogLevel";
import { LogService } from "./LogService";

/**
 * Per-file logger that dispatches entries to the central {@link LogService}.
 *
 * Create one instance per source file with the file name as the `name` argument.
 * The name appears in every log line so you can easily filter output by origin.
 *
 * @example
 * ```ts
 * // At the top of any source file:
 * import { Logger } from "@langgraph-glove/core";
 *
 * const logger = new Logger("Agent.ts");
 *
 * // Then anywhere in the file:
 * logger.verbose("Graph compiled successfully");
 * logger.debug("Dispatching message to channel", { conversationId });
 * logger.info("Channel started: cli");
 * logger.warn("No subscribers configured — log output is suppressed");
 * logger.error("Unhandled error in handler", err);
 * ```
 *
 * Logging produces no output until at least one subscriber is registered with
 * {@link LogService.subscribe}.
 */
export class Logger {
  constructor(private readonly name: string) {}

  /**
   * Extremely detailed tracing — enabled only when you need to trace
   * individual code paths in development.
   */
  verbose(message: string): void {
    this.log(LogLevel.VERBOSE, message);
  }

  /** Detailed information useful during development and debugging. */
  debug(message: string): void {
    this.log(LogLevel.DEBUG, message);
  }

  /** General operational information about the running system. */
  info(message: string): void {
    this.log(LogLevel.INFO, message);
  }

  /** Something unexpected happened but the application can continue. */
  warn(message: string): void {
    this.log(LogLevel.WARN, message);
  }

  /**
   * A serious failure that likely requires attention.
   * If an `Error` object is passed as `cause`, its message and stack are
   * appended to the log line.
   */
  error(message: string, cause?: unknown): void {
    let text = message;
    if (cause instanceof Error) {
      text += ` — ${cause.message}`;
      if (cause.stack) {
        text += `\n${cause.stack}`;
      }
    } else if (cause !== undefined) {
      text += ` — ${String(cause)}`;
    }
    this.log(LogLevel.ERROR, text);
  }

  private log(level: LogLevel, message: string): void {
    LogService.dispatch({ timestamp: new Date(), level, name: this.name, message });
  }
}
