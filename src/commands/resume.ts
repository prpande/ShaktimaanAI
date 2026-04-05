import type { Command } from "commander";
import { writeControlFile } from "./write-control.js";

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume a paused task")
    .argument("<slug>", "Task slug to resume")
    .action((slug: string) => {
      const resolved = writeControlFile(slug, { operation: "resume" });
      console.log(`Resume queued for "${resolved}".`);
    });
}
