import type { Command } from "commander";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { createTask } from "../core/task-creator.js";

export function registerTaskCommand(program: Command): void {
  program
    .command("task")
    .description("Create a new pipeline task")
    .argument("<description>", "Description of the task")
    .option("--repo <repo>", "Target repository")
    .option("--ado <ado>", "Azure DevOps work item reference")
    .option("--stages <stages>", "Comma-separated list of stages to run")
    .option("--hints <hints...>", 'Stage hints in "stage:hint" format (repeatable)')
    .option("--quick", "Quick task mode (no review)")
    .option("--full", "Full task mode (all stages)")
    .action((description: string, opts: {
      repo?: string;
      ado?: string;
      stages?: string;
      hints?: string[];
      quick?: boolean;
      full?: boolean;
    }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      // Parse stages
      const stages = opts.quick
        ? ["quick"]
        : opts.stages?.split(",").map((s) => s.trim()).filter(Boolean);

      // Parse hints from "stage:hint" format into Record<string, string>
      const stageHints: Record<string, string> = {};
      if (opts.hints && opts.hints.length > 0) {
        for (const hint of opts.hints) {
          const colonIdx = hint.indexOf(":");
          if (colonIdx === -1) {
            console.error(`Invalid hint format "${hint}" — expected "stage:hint"`);
            process.exit(1);
          }
          const stage = hint.slice(0, colonIdx).trim();
          const text = hint.slice(colonIdx + 1).trim();
          if (stage) {
            stageHints[stage] = text;
          }
        }
      }

      const slug = createTask(
        {
          source: "cli",
          content: description,
          repo: opts.repo,
          adoItem: opts.ado,
          stages,
          stageHints: Object.keys(stageHints).length > 0 ? stageHints : undefined,
        },
        config.pipeline.runtimeDir,
        config,
      );

      console.log(`Task created: ${slug}`);
    });
}
