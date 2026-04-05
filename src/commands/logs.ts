import type { Command } from "commander";
import { readFileSync, watchFile, unwatchFile, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

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

      const lineCount = parseInt(opts.lines, 10) || 50;
      const logFile = join(config.pipeline.runtimeDir, "logs", `${slug}.log`);

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

      // Follow mode: watch for new content using watchFile
      let lastSize = statSync(logFile).size;

      watchFile(logFile, { interval: 500 }, (curr) => {
        if (curr.size > lastSize) {
          // Read only the new bytes
          const content = readFileSync(logFile, "utf-8");
          const allLines = content.split(/\r?\n/);
          if (allLines[allLines.length - 1] === "") allLines.pop();

          // Determine how many lines were in the file before
          const prevContent = content.slice(0, lastSize);
          const prevLines = prevContent.split(/\r?\n/);
          if (prevLines[prevLines.length - 1] === "") prevLines.pop();

          const newLines = allLines.slice(prevLines.length);
          for (const line of newLines) {
            console.log(line);
          }

          lastSize = curr.size;
        }
      });

      // Handle SIGINT: stop watching and exit
      process.on("SIGINT", () => {
        unwatchFile(logFile);
        process.exit(0);
      });
    });
}
