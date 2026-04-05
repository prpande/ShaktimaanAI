import type { Command } from "commander";
import { readFileSync, watchFile, unwatchFile, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { resolveSlugOrExit } from "./resolve-slug-or-exit.js";

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Tail logs for a specific task")
    .argument("<slug>", "Task slug to tail logs for")
    .option("-f, --follow", "Follow log output (watch for new content)")
    .option("--lines <n>", "Number of lines to show", "50")
    .action((slug: string, opts: { follow?: boolean; lines: string }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const resolved = resolveSlugOrExit(slug, config.pipeline.runtimeDir);

      const lineCount = parseInt(opts.lines, 10) || 50;
      const logFile = join(config.pipeline.runtimeDir, "logs", `${resolved}.log`);

      if (!existsSync(logFile)) {
        console.error(`Log file not found: ${logFile}`);
        process.exit(1);
      }

      /**
       * Returns the last N lines from a string.
       */
      function lastNLines(content: string, n: number): string[] {
        const lines = content.split(/\r?\n/);
        // Remove trailing empty line if file ends with newline
        if (lines[lines.length - 1] === "") lines.pop();
        return lines.slice(-n);
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
