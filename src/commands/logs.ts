import type { Command } from "commander";
import { readFileSync, watchFile, unwatchFile, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { findConfigPath, loadConfig } from "../config/loader.js";
import { resolveSlugOrExit } from "./resolve-slug-or-exit.js";

/**
 * Parses the --lines option string into a number.
 * Returns `defaultValue` only when the input is not a valid integer (NaN).
 * Explicitly passing 0 is honoured (returns 0, not the default).
 */
export function parseLineCount(raw: string, defaultValue = 50): number {
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Returns the last N lines from a string.
 * Handles files that end with a trailing newline by ignoring the final empty element.
 */
export function lastNLines(content: string, n: number): string[] {
  if (n <= 0) return [];
  const lines = content.split(/\r?\n/);
  // Remove trailing empty line if file ends with newline
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Tail logs for a specific task")
    .argument("<slug>", "Task slug to tail logs for")
    .option("-f, --follow", "Follow log output (watch for new content)")
    .option("--lines <n>", "Number of lines to show", "50")
    .action((slug: string, opts: { follow?: boolean; lines: string }) => {
      const configPath = findConfigPath();
      const config = loadConfig(configPath);
      const resolved = resolveSlugOrExit(slug, config.paths.runtimeDir);

      const lineCount = parseLineCount(opts.lines);
      const logFile = join(config.paths.logsDir, `${resolved}.log`);

      if (!existsSync(logFile)) {
        console.error(`Log file not found: ${logFile}`);
        process.exit(1);
      }

      // Print last N lines
      const initial = readFileSync(logFile, "utf-8");
      const initialLines = lastNLines(initial, lineCount);
      for (const line of initialLines) {
        console.log(line);
      }

      if (!opts.follow) {
        return;
      }

      // Follow mode: use file descriptor + offset reads for O(1) updates
      let lastSize = statSync(logFile).size;
      const fd = openSync(logFile, "r");

      watchFile(logFile, { interval: 500 }, () => {
        try {
          const newSize = statSync(logFile).size;
          if (newSize < lastSize) {
            // Log rotation detected: file was truncated or replaced — reset offset
            lastSize = 0;
          }
          if (newSize > lastSize) {
            const buf = Buffer.alloc(newSize - lastSize);
            readSync(fd, buf, 0, buf.length, lastSize);
            process.stdout.write(buf.toString("utf-8"));
            lastSize = newSize;
          }
        } catch { /* file may have rotated */ }
      });

      // Handle SIGINT: stop watching and exit
      process.on("SIGINT", () => {
        closeSync(fd);
        unwatchFile(logFile);
        process.exit(0);
      });
    });
}
