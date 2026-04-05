import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { resolveSlugOrExit } from "./resolve-slug-or-exit.js";

export function registerModifyStagesCommand(program: Command): void {
  program
    .command("modify-stages")
    .description("Modify the remaining stages for a running task")
    .argument("<slug>", "Task slug")
    .requiredOption("--stages <stages>", "Comma-separated list of stages to run")
    .action((slug: string, opts: { stages: string }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const resolved = resolveSlugOrExit(slug, config.pipeline.runtimeDir);

      const stages = opts.stages.split(",").map((s) => s.trim()).filter(Boolean);
      if (stages.length === 0) {
        console.error("--stages must specify at least one stage.");
        process.exit(1);
      }

      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });

      const payload = { operation: "modify_stages", slug: resolved, stages };
      const controlFile = join(inboxDir, `${resolved}.control`);
      writeFileSync(controlFile, JSON.stringify(payload, null, 2), "utf-8");

      console.log(`Modify-stages queued for "${resolved}": [${stages.join(", ")}].`);
    });
}
