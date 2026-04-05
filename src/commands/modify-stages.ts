import type { Command } from "commander";
import { writeControlFile } from "./write-control.js";

export function registerModifyStagesCommand(program: Command): void {
  program
    .command("modify-stages")
    .description("Modify the remaining stages for a running task")
    .argument("<slug>", "Task slug")
    .requiredOption("--stages <stages>", "Comma-separated list of stages to run")
    .action((slug: string, opts: { stages: string }) => {
      const stages = opts.stages.split(",").map((s) => s.trim()).filter(Boolean);
      if (stages.length === 0) {
        console.error("--stages must specify at least one stage.");
        process.exit(1);
      }
      const resolved = writeControlFile(slug, { operation: "modify_stages", stages });
      console.log(`Modify-stages queued for "${resolved}": [${stages.join(", ")}].`);
    });
}
