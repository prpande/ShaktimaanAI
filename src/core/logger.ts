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

export function createTaskLogger(logDir: string, slug: string, context?: LogContext): TaskLogger {
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${slug}.log`);

  const logger = pino(
    { base: context ?? undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.destination({ dest: logFile, append: true, sync: true }),
  );

  return {
    info: (msg: string) => logger.info(msg),
    warn: (msg: string) => logger.warn(msg),
    error: (msg: string) => logger.error(msg),
  };
}

export function createSystemLogger(logDir: string): TaskLogger {
  return createTaskLogger(logDir, "heimdall", { module: "system" });
}
