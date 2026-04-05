import type { Command } from "commander";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { listActiveSlugs } from "../core/slug-resolver.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show active pipeline runs and their current stages")
    .action(() => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      const tasks = listActiveSlugs(config.pipeline.runtimeDir);

      if (tasks.length === 0) {
        console.log("No active tasks.");
        return;
      }

      const active = tasks.filter((t) => t.status === "active");
      const held = tasks.filter((t) => t.status === "held");

      if (active.length > 0) {
        console.log("ACTIVE");
        for (const task of active) {
          const slug = task.slug.padEnd(60);
          console.log(`  ${slug}  ${task.stage.padEnd(12)}  ${task.dir}`);
        }
      }

      if (held.length > 0) {
        if (active.length > 0) console.log("");
        console.log("HELD (awaiting approval)");
        for (const task of held) {
          const slug = task.slug.padEnd(60);
          console.log(`  ${slug}  ${task.stage.padEnd(12)}  ${task.dir}`);
        }
      }
    });
}
