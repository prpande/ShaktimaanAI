import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";

export interface TaskLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function formatLogLine(level: string, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
}

export function createTaskLogger(logDir: string, slug: string): TaskLogger {
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${slug}.log`);

  function write(level: string, msg: string): void {
    try {
      appendFileSync(logFile, formatLogLine(level, msg), "utf8");
    } catch {
      // Logging should never crash the pipeline — silently swallow write errors
    }
  }

  return {
    info: (msg: string) => write("info", msg),
    warn: (msg: string) => write("warn", msg),
    error: (msg: string) => write("error", msg),
  };
}

export function createSystemLogger(logDir: string): TaskLogger {
  return createTaskLogger(logDir, "heimdall");
}
