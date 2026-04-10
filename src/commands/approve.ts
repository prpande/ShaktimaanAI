import type { Command } from "commander";
import { findConfigPath, loadConfig } from "../config/loader.js";
import { findHeldTask } from "../core/approval-handler.js";
import { resolveSlugOrExit } from "./resolve-slug-or-exit.js";
import { writeControlFile } from "./write-control.js";

export function registerApproveCommand(program: Command): void {
  program
    .command("approve")
    .description("Approve a task waiting in review")
    .argument("<slug>", "Task slug to approve")
    .option("--feedback <feedback>", "Optional feedback message")
    .action((slug: string, opts: { feedback?: string }) => {
      const config = loadConfig(findConfigPath());
      const resolved = resolveSlugOrExit(slug, config.pipeline.runtimeDir);

      const taskPath = findHeldTask(config.pipeline.runtimeDir, resolved);
      if (taskPath === null) {
        console.error(`Task "${resolved}" not found in hold (12-hold). Is it waiting for review?`);
        process.exit(1);
      }

      const payload: Record<string, unknown> = { operation: "approve" };
      if (opts.feedback) {
        payload.feedback = opts.feedback;
      }

      // writeControlFile will re-resolve slug; pass the already-resolved slug
      writeControlFile(resolved, payload);

      const feedbackNote = opts.feedback ? ` with feedback: "${opts.feedback}"` : "";
      console.log(`Approval queued for "${resolved}"${feedbackNote}. The pipeline watcher will resume it.`);
    });
}
