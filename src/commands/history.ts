import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { findConfigPath, loadConfig } from "../config/loader.js";

export interface HistoryEntry {
  slug: string;
  status: "complete" | "failed";
  startedAt: string;
  updatedAt: string;
  finalStage: string;
  error?: string;
}

export function listCompletedTasks(
  completeDirPath: string,
  failedDirPath: string,
  count?: number,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  for (const [dirPath, defaultStatus] of [
    [completeDirPath, "complete"],
    [failedDirPath, "failed"],
  ] as const) {
    if (!existsSync(dirPath)) continue;

    for (const slug of readdirSync(dirPath)) {
      const statePath = join(dirPath, slug, "run-state.json");
      if (!existsSync(statePath)) continue;

      try {
        const raw = JSON.parse(readFileSync(statePath, "utf8"));
        entries.push({
          slug: raw.slug ?? slug,
          status: raw.status ?? defaultStatus,
          startedAt: raw.startedAt ?? "",
          updatedAt: raw.updatedAt ?? "",
          finalStage: raw.currentStage ?? "",
          error: raw.error,
        });
      } catch {
        // Skip corrupt run-state files
      }
    }
  }

  entries.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));

  return count !== undefined ? entries.slice(0, count) : entries;
}

function formatElapsed(startedAt: string, updatedAt: string): string {
  const ms = new Date(updatedAt).getTime() - new Date(startedAt).getTime();
  if (isNaN(ms) || ms < 0) return "—";
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function registerHistoryCommand(program: Command): void {
  program
    .command("history")
    .description("Show recent completed tasks")
    .option("--count <count>", "Number of tasks to show", "10")
    .action((opts: { count: string }) => {
      const count = parseInt(opts.count, 10);
      if (!Number.isFinite(count) || count <= 0) {
        console.error("Invalid --count value. Expected a positive integer.");
        process.exit(1);
      }

      const configPath = findConfigPath();
      const config = loadConfig(configPath);
      const entries = listCompletedTasks(config.paths.terminals.complete, config.paths.terminals.failed, count);

      if (entries.length === 0) {
        console.log("No completed tasks found.");
        return;
      }

      for (const entry of entries) {
        const elapsed = formatElapsed(entry.startedAt, entry.updatedAt);
        const status = entry.status === "complete" ? "DONE" : "FAIL";
        const errorSuffix = entry.error ? ` — ${entry.error}` : "";
        console.log(
          `[${status}] ${entry.slug}  stage=${entry.finalStage}  elapsed=${elapsed}${errorSuffix}`,
        );
      }
    });
}
