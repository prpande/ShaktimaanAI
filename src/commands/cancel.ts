import type { Command } from "commander";
import { writeControlFile } from "./write-control.js";

export function registerCancelCommand(program: Command): void {
  program
    .command("cancel")
    .description("Cancel a running task")
    .argument("<slug>", "Task slug to cancel")
    .action((slug: string) => {
      const resolved = writeControlFile(slug, { operation: "cancel" });
      console.log(`Cancel queued for "${resolved}".`);
    });
}
