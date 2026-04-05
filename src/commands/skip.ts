import type { Command } from "commander";
import { writeControlFile } from "./write-control.js";

export function registerSkipCommand(program: Command): void {
  program
    .command("skip")
    .description("Skip the current (or specified) stage for a task")
    .argument("<slug>", "Task slug")
    .option("--stage <stage>", "Stage to skip (defaults to current stage)")
    .action((slug: string, opts: { stage?: string }) => {
      const payload: Record<string, unknown> = { operation: "skip" };
      if (opts.stage) {
        payload.stage = opts.stage;
      }
      const resolved = writeControlFile(slug, payload);
      const stageNote = opts.stage ? ` (stage: ${opts.stage})` : "";
      console.log(`Skip queued for "${resolved}"${stageNote}.`);
    });
}
