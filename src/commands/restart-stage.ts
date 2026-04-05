import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { resolveSlugOrExit } from "./resolve-slug-or-exit.js";

export function registerRestartStageCommand(program: Command): void {
  program
    .command("restart-stage")
    .description("Restart the current (or specified) stage for a task")
    .argument("<slug>", "Task slug")
    .option("--stage <stage>", "Stage to restart (defaults to current stage)")
    .action((slug: string, opts: { stage?: string }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const resolved = resolveSlugOrExit(slug, config.pipeline.runtimeDir);

      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });

      const payload: Record<string, unknown> = { operation: "restart_stage", slug: resolved };
      if (opts.stage) {
        payload.stage = opts.stage;
      }

      const controlFile = join(inboxDir, `${resolved}.control`);
      writeFileSync(controlFile, JSON.stringify(payload, null, 2), "utf-8");

      const stageNote = opts.stage ? ` (stage: ${opts.stage})` : "";
      console.log(`Restart-stage queued for "${resolved}"${stageNote}.`);
    });
}
