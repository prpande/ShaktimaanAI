import type { Command } from "commander";
import { writeControlFile } from "./write-control.js";

export function registerPauseCommand(program: Command): void {
  program
    .command("pause")
    .description("Pause a running task")
    .argument("<slug>", "Task slug to pause")
    .action((slug: string) => {
      const resolved = writeControlFile(slug, { operation: "pause" });
      console.log(`Pause queued for "${resolved}".`);
    });
}
