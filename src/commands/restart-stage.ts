import type { Command } from "commander";
import { writeControlFile } from "./write-control.js";

export function registerRestartStageCommand(program: Command): void {
  program
    .command("restart-stage")
    .description("Restart the current (or specified) stage for a task")
    .argument("<slug>", "Task slug")
    .option("--stage <stage>", "Stage to restart (defaults to current stage)")
    .action((slug: string, opts: { stage?: string }) => {
      const payload: Record<string, unknown> = { operation: "restart_stage" };
      if (opts.stage) {
        payload.stage = opts.stage;
      }
      const resolved = writeControlFile(slug, payload);
      const stageNote = opts.stage ? ` (stage: ${opts.stage})` : "";
      console.log(`Restart-stage queued for "${resolved}"${stageNote}.`);
    });
}
