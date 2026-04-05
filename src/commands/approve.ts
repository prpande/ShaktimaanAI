import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { findHeldTask } from "../core/approval-handler.js";

export function registerApproveCommand(program: Command): void {
  program
    .command("approve")
    .description("Approve a task waiting in review")
    .argument("<slug>", "Task slug to approve")
    .option("--feedback <feedback>", "Optional feedback message")
    .action((slug: string, opts: { feedback?: string }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      const taskPath = findHeldTask(config.pipeline.runtimeDir, slug);
      if (taskPath === null) {
        console.error(`Task "${slug}" not found in hold (12-hold). Is it waiting for review?`);
        process.exit(1);
      }

      // Approval is queued via a control file; the running watcher picks it up.
      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });

      const controlPayload: Record<string, unknown> = {
        operation: "approve",
        slug,
      };
      if (opts.feedback) {
        controlPayload.feedback = opts.feedback;
      }

      const controlFile = join(inboxDir, `${slug}.control`);
      writeFileSync(controlFile, JSON.stringify(controlPayload, null, 2), "utf-8");

      const feedbackNote = opts.feedback ? ` with feedback: "${opts.feedback}"` : "";
      console.log(`Approval queued for "${slug}"${feedbackNote}. The pipeline watcher will resume it.`);
    });
}
