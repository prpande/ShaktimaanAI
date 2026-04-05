import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { resolveSlugOrExit } from "./resolve-slug-or-exit.js";

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume a paused task")
    .argument("<slug>", "Task slug to resume")
    .action((slug: string) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const resolved = resolveSlugOrExit(slug, config.pipeline.runtimeDir);

      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });

      const payload = { operation: "resume", slug: resolved };
      const controlFile = join(inboxDir, `${resolved}.control`);
      writeFileSync(controlFile, JSON.stringify(payload, null, 2), "utf-8");

      console.log(`Resume queued for "${resolved}".`);
    });
}
