import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

export interface TaskLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function formatLogLine(level: string, message: string): string {
  return JSON.stringify({
    level,
    msg: message,
    time: new Date().toISOString(),
  });
}

export interface LogContext {
  slug?: string;
  module?: string;
  stage?: string;
}

const NOOP_LOGGER: TaskLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function createTaskLogger(logDir: string, slug: string, context?: LogContext): TaskLogger {
  try {
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `${slug}.log`);

    const logger = pino(
      { base: context ?? undefined, timestamp: pino.stdTimeFunctions.isoTime },
      pino.destination({ dest: logFile, append: true, sync: true }),
    );

    return {
      info: (msg: string) => { try { logger.info(msg); } catch { /* never crash */ } },
      warn: (msg: string) => { try { logger.warn(msg); } catch { /* never crash */ } },
      error: (msg: string) => { try { logger.error(msg); } catch { /* never crash */ } },
    };
  } catch {
    // Logging should never crash the pipeline — fall back to no-op logger
    return NOOP_LOGGER;
  }
}

export function createSystemLogger(logDir: string): TaskLogger {
  return createTaskLogger(logDir, "heimdall", { module: "system" });
}
