import type { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { listActiveSlugs } from "../core/slug-resolver.js";

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function readTimestamp(runStatePath: string, field: string): string | null {
  try {
    if (!existsSync(runStatePath)) return null;
    const raw = readFileSync(runStatePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed[field] === "string") return parsed[field];
    return null;
  } catch {
    return null;
  }
}

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
        console.log("Active:");
        for (const task of active) {
          const runStatePath = join(config.pipeline.runtimeDir, task.dir, task.slug, "run-state.json");
          const startedAt = readTimestamp(runStatePath, "startedAt");
          const duration = startedAt ? ` (${formatElapsed(startedAt)})` : "";
          console.log(`  ${task.slug.padEnd(40)}  → ${task.stage.padEnd(12)}${duration}`);
        }
      }

      if (held.length > 0) {
        if (active.length > 0) console.log("");
        console.log("Held (awaiting approval):");
        for (const task of held) {
          const runStatePath = join(config.pipeline.runtimeDir, "12-hold", task.slug, "run-state.json");
          // Use updatedAt for held tasks — it reflects when the task entered hold
          const heldSince = readTimestamp(runStatePath, "updatedAt");
          const duration = heldSince ? ` (held ${formatElapsed(heldSince)})` : "";
          const holdReason = readTimestamp(runStatePath, "holdReason");
          const holdDetail = readTimestamp(runStatePath, "holdDetail");
          const reasonTag = holdReason === "budget_exhausted" ? " [budget]"
            : holdReason === "user_paused" ? " [paused]"
            : "";
          console.log(`  ${task.slug.padEnd(40)}  → ${task.stage.padEnd(12)}${duration}${reasonTag}`);
          if (holdDetail) {
            console.log(`    ${holdDetail}`);
          }
        }
      }
    });
}
