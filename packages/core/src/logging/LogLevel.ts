/**
 * Log severity levels in ascending order of importance.
 * Subscribers filter entries by their configured minimum level.
 */
export enum LogLevel {
  VERBOSE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
}

/** Human-readable label for each {@link LogLevel}. */
export const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  [LogLevel.VERBOSE]: "VERBOSE",
  [LogLevel.DEBUG]: "DEBUG  ",
  [LogLevel.INFO]: "INFO   ",
  [LogLevel.WARN]: "WARN   ",
  [LogLevel.ERROR]: "ERROR  ",
};
