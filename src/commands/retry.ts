import type { Command } from "commander";
import { writeControlFile } from "./write-control.js";

export function registerRetryCommand(program: Command): void {
  program
    .command("retry")
    .description("Retry a failed task with feedback")
    .argument("<slug>", "Task slug to retry")
    .requiredOption("--feedback <feedback>", "Feedback for the retry")
    .action((slug: string, opts: { feedback: string }) => {
      const resolved = writeControlFile(slug, { operation: "retry", feedback: opts.feedback });
      console.log(`Retry queued for "${resolved}" with feedback: "${opts.feedback}".`);
    });
}
