import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerRetryCommand(program: Command): void {
  program
    .command("retry")
    .description("Retry a failed task with feedback")
    .argument("<slug>", "Task slug to retry")
    .requiredOption("--feedback <feedback>", "Feedback for the retry")
    .action((slug: string, opts: { feedback: string }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });

      const payload = { operation: "retry", slug, feedback: opts.feedback };
      const controlFile = join(inboxDir, `${slug}.control`);
      writeFileSync(controlFile, JSON.stringify(payload, null, 2), "utf-8");

      console.log(`Retry queued for "${slug}" with feedback: "${opts.feedback}".`);
    });
}
